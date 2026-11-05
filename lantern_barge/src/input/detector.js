// input/detector.js — owns the detector worker (architecture §6.1). Owner: PD.
// One frame in flight; GPU-setup timer (a slow GPU is skipped for CPU); delegate / fps / inferMs / pipelineMs stats.
// No main-thread fallback and no stuck-worker watchdog (D6): if the worker can't start, init() rejects.

const INIT_TIMEOUT_MS = 90000;

/**
 * @param {{prefer?:'GPU'|'CPU', gpuSetupMs?:number, onResult:(r:object) => void, onDelegate?:(d:string) => void}} opts
 *   onResult gets {ts (capture perf ms), arrival (perf ms), ms, w, h, hands, failed?}
 */
export function createDetector({ prefer = 'GPU', gpuSetupMs = 8000, onResult, onDelegate = () => {} }) {
  let worker = null;
  let inFlight = false;
  let stopped = false;
  const stats = { delegate: null, fps: 0, inferMs: 0, pipelineMs: 0, stage: 'idle', results: 0, failed: 0 };
  let countT = performance.now();
  let count = 0;

  function spawn(pref) {
    return new Promise((resolve, reject) => {
      let w;
      try {
        w = new Worker(new URL('./detector-worker.js', import.meta.url), { type: 'module' });
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
          fail(new Error(m.message));
        }
      };
      w.postMessage({ type: 'init', prefer: pref });
    });
  }

  function onMessage(m) {
    if (m.type === 'result') {
      inFlight = false;
      const arrival = performance.now();
      stats.results += 1;
      if (m.failed) stats.failed += 1;
      stats.inferMs += 0.1 * (m.ms - stats.inferMs);
      stats.pipelineMs += 0.1 * (arrival - m.ts - stats.pipelineMs);
      count += 1;
      if (arrival - countT >= 1000) {
        stats.fps = (count * 1000) / (arrival - countT);
        count = 0;
        countT = arrival;
      }
      onResult({ ...m, arrival });
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
