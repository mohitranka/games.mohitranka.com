// input/detector.js — owns the detector worker (architecture §6.1). Owner: PD.
// One frame in flight; GPU-setup timer (a slow GPU is skipped for CPU); delegate / fps / inferMs / pipelineMs stats.
// No main-thread fallback and no stuck-worker watchdog (D6): if the worker can't start, init() rejects.

const INIT_TIMEOUT_MS = 90000;

/**
 * @param {{prefer?:'GPU'|'CPU', gpuSetupMs?:number, onResult:(r:object) => void, onDelegate?:(d:string) => void}} opts
 *   onResult gets {ts (capture perf ms), arrival (perf ms), ms, w, h, hands, failed?}
 */
export function createDetector({ prefer = 'GPU', gpuSetupMs = 8000, gpuSlowInferMs = 100, gpuPaceFrames = 5, face = false, faceSlowMs = 8, confidences = {}, onResult, onDelegate = () => {} }) {
  let worker = null;
  let inFlight = false;
  let stopped = false;
  const stats = {
    delegate: null, fps: 0, inferMs: 0, pipelineMs: 0, stage: 'idle', results: 0, failed: 0,
    // D13 spike: face detector
    face: face ? { ok: null, error: null, ms: 0, every: 1, runs: 0, found: 0 } : null,
  };
  let countT = performance.now();
  let count = 0;

  function spawn(pref) {
    return new Promise((resolve, reject) => {
      let w;
      try {
        w = new Worker(new URL('./detector-worker.js', import.meta.url)); // classic: see detector-worker.js header
      } catch (err) {
        reject(err);
        return;
      }
      let gpuTimer = 0;
      const timer = setTimeout(() => fail(new Error('hand tracking took too long to start')), INIT_TIMEOUT_MS);
      const settle = () => {
        clearTimeout(timer);
        clearTimeout(gpuTimer);
      };
      const fail = (err) => {
        settle();
        w.terminate();
        reject(err);
      };
      w.onerror = (e) => fail(new Error(e.message || 'detector worker failed to load'));
      w.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'stage') {
          stats.stage = m.stage;
          if (m.stage === 'gpu') {
            gpuTimer = setTimeout(() => {
              // a GPU that is slow to set up (busy, or software-rendered) is skipped for the CPU
              settle();
              w.terminate();
              if (stopped) return reject(new Error('stopped'));
              console.warn(`[detector] GPU setup exceeded ${gpuSetupMs} ms; switching to CPU`);
              spawn('CPU').then(resolve, reject);
            }, gpuSetupMs);
          }
        } else if (m.type === 'face') {
          if (stats.face) Object.assign(stats.face, { ok: m.ok, error: m.error ?? null });
          if (!m.ok) console.warn('[detector] face detector unavailable:', m.error);
        } else if (m.type === 'ready') {
          settle();
          if (stopped) {
            // stop() arrived while the worker was starting: don't keep it
            w.terminate();
            reject(new Error('stopped'));
            return;
          }
          stats.delegate = m.delegate;
          stats.stage = 'ready';
          w.onmessage = (ev) => onMessage(ev.data);
          w.onerror = (ev) => console.error('[detector] worker error:', ev.message);
          worker = w;
          resolve();
        } else if (m.type === 'error') {
          if (m.retryCpu && pref !== 'CPU' && !stopped) {
            settle();
            w.terminate();
            console.warn('[detector] GPU delegate failed; restarting hand tracking on CPU:', m.message);
            spawn('CPU').then(resolve, reject);
            return;
          }
          fail(new Error(m.message));
        }
      };
      w.postMessage({ type: 'init', prefer: pref, gpuSlowInferMs, gpuPaceFrames, face, faceSlowMs, ...confidences });
    });
  }

  function onMessage(m) {
    if (m.type === 'result') {
      inFlight = false;
      const arrival = performance.now();
      stats.results += 1;
      if (m.failed) stats.failed += 1;
      // EMAs start from the first sample of each delegate (reset on a switch), so they describe the current one
      stats.inferMs = stats.inferMs ? stats.inferMs + 0.1 * (m.ms - stats.inferMs) : m.ms;
      const pipe = arrival - m.ts;
      stats.pipelineMs = stats.pipelineMs ? stats.pipelineMs + 0.1 * (pipe - stats.pipelineMs) : pipe;
      count += 1;
      if (arrival - countT >= 1000) {
        stats.fps = (count * 1000) / (arrival - countT);
        count = 0;
        countT = arrival;
      }
      if (stats.face && m.faceRan) {
        stats.face.runs += 1;
        if (m.face) stats.face.found += 1;
        stats.face.ms = stats.face.ms ? stats.face.ms + 0.1 * (m.faceMs - stats.face.ms) : m.faceMs;
      }
      if (stats.face && m.faceEvery) stats.face.every = m.faceEvery;
      onResult({ ...m, arrival });
    } else if (m.type === 'switch') {
      // the worker can't change delegate in place: replace it with a CPU worker (model and wasm are cached)
      if (m.reason === 'slow') stats.gpuMedianMs = m.gpuMedianMs;
      console.info(`[detector] ${m.reason === 'slow' ? `GPU inference too slow (median ${Math.round(m.gpuMedianMs)} ms)` : `GPU inference failed (${m.message})`}; switched to CPU`);
      const old = worker;
      worker = null;
      inFlight = false;
      stats.inferMs = 0;
      stats.pipelineMs = 0;
      stats.fps = 0;
      count = 0;
      countT = performance.now();
      old?.terminate();
      if (stopped) return;
      stats.switching = true;
      spawn('CPU').then(() => {
        stats.switching = false;
        onDelegate('CPU');
      }, (err) => {
        stats.switching = false;
        console.error('[detector] CPU restart failed:', err?.message ?? err);
      });
    } else if (m.type === 'delegate') {
      stats.delegate = m.delegate;
      onDelegate(m.delegate);
    } else if (m.type === 'error') {
      console.error('[detector] worker:', m.message);
    }
  }

  return {
    stats,
    get ready() {
      return !!worker;
    },
    get busy() {
      return inFlight;
    },
    init() {
      return spawn(prefer);
    },
    /** Send a frame (transfers the bitmap). Returns false (and closes it) if one is already in flight. */
    detect(bitmap, ts) {
      if (!worker || inFlight || stopped) {
        bitmap.close?.();
        return false;
      }
      inFlight = true;
      worker.postMessage({ type: 'frame', bitmap, ts }, [bitmap]);
      return true;
    },
    stop() {
      stopped = true;
      worker?.postMessage({ type: 'close' });
      worker?.terminate();
      worker = null;
    },
  };
}
