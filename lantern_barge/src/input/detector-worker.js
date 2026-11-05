// input/detector-worker.js — MediaPipe HandLandmarker (+ D13 FaceDetector) in a CLASSIC worker (architecture §6.1). Owner: PD.
// Classic, not module (M7-in spike finding): in a module worker MediaPipe's wasm loader is import()ed once and can't
// be re-run, so a second task in the same worker fails with "ModuleFactory not set". In a classic worker the loader
// goes through importScripts, which re-runs it for every task. So no static imports here: constants come in by
// dynamic import(), which classic workers support.
// Protocol. In:  {type:'init', prefer:'GPU'|'CPU'}, {type:'frame', bitmap (transferred), ts (perf ms)}.
//           Out: {type:'stage', stage:'download'|'gpu'|'cpu'}, {type:'ready', delegate}, {type:'delegate', delegate},
//                {type:'result', ts, ms, w, h, hands:[{lm, world, label, score}], failed?}, {type:'error', message, retryCpu},
//                {type:'switch', delegate:'CPU', reason:'slow'|'inference-error'} (main restarts the worker on CPU).
// The model and wasm are downloaded BEFORE GPU setup starts, so main's gpuSetupMs timer measures GPU setup only.

let MP_BUNDLE_URL, MP_WASM_URL, HAND_MODEL_URL, FACE_MODEL_URL; // set in init() from shared/constants.js

// The wasm runtime prints routine native log lines through the console; keep the console for real problems.
const NATIVE_LOG = /^(INFO:|WARNING: All log messages|[IWE]\d{4} \d\d:\d\d:\d\d|Graph successfully started|.*OpenGL error checking is disabled|.*gl_context)/;
for (const k of ['log', 'info', 'warn', 'error']) {
  const orig = console[k].bind(console);
  console[k] = (...a) => {
    if (typeof a[0] === 'string' && NATIVE_LOG.test(a[0])) return;
    orig(...a);
  };
}

let vision = null;
let fileset = null;
let modelBytes = null;
let landmarker = null;
let delegate = null;
let lastTs = -Infinity;
let busy = false;
// GPU pace check: a GPU delegate slower than gpuSlowInferMs (median of the first gpuPaceFrames, after one warm-up
// frame) is replaced by the CPU delegate. Software-rendered GPUs (VMs, disabled acceleration) are far slower than CPU.
let pace = { slowMs: 100, frames: 5, samples: [], done: false };
// D13 spike (M7-in): the face detector runs after the hand landmarker on the same frame. If its median cost exceeds
// faceSlowMs it drops to every 2nd frame. faceBytes stays null unless init asks for the face model.
let faceBytes = null;
let faceDet = null;
let face = { wanted: false, slowMs: 8, every: 1, n: 0, samples: [], error: null };

async function fetchBytes(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

async function create(d) {
  const opts = {
    baseOptions: { modelAssetBuffer: modelBytes.slice(), delegate: d },
    runningMode: 'VIDEO',
    numHands: 2,
    minHandDetectionConfidence: 0.6,
    minHandPresenceConfidence: 0.55,
    minTrackingConfidence: 0.5,
  };
  if (d === 'GPU') opts.canvas = new OffscreenCanvas(1, 1);
  return vision.HandLandmarker.createFromOptions(fileset, opts);
}

async function createFace(d) {
  const opts = {
    baseOptions: { modelAssetBuffer: faceBytes.slice(), delegate: d },
    runningMode: 'VIDEO',
    minDetectionConfidence: 0.5,
  };
  if (d === 'GPU') opts.canvas = new OffscreenCanvas(1, 1); // each GPU task needs its own canvas
  return vision.FaceDetector.createFromOptions(fileset, opts);
}

async function initFace() {
  try {
    faceDet = await createFace(delegate);
  } catch (err) {
    face.error = String(err?.message ?? err);
    faceDet = null;
  }
  self.postMessage({ type: 'face', ok: !!faceDet, delegate, error: face.error });
}

async function init(prefer) {
  self.postMessage({ type: 'stage', stage: 'download' });
  ({ MP_BUNDLE_URL, MP_WASM_URL, HAND_MODEL_URL, FACE_MODEL_URL } = await import(new URL('../shared/constants.js', self.location.href).href));
  vision = await import(MP_BUNDLE_URL);
  fileset = await vision.FilesetResolver.forVisionTasks(MP_WASM_URL, false); // classic loader (importScripts)
  // download everything first (into the HTTP cache), so GPU setup can be timed on its own
  const loads = [fetchBytes(HAND_MODEL_URL), fetchBytes(fileset.wasmLoaderPath), fetchBytes(fileset.wasmBinaryPath)];
  if (face.wanted) loads.push(fetchBytes(FACE_MODEL_URL));
  const got = await Promise.all(loads);
  modelBytes = got[0];
  if (face.wanted) faceBytes = got[3];
  if (prefer !== 'CPU' && typeof OffscreenCanvas !== 'undefined') {
    self.postMessage({ type: 'stage', stage: 'gpu' });
    try {
      landmarker = await create('GPU');
      delegate = 'GPU';
      return;
    } catch (err) {
      // can't create a CPU landmarker in this same worker (see requestCpu): main restarts us on CPU
      const e = new Error(`GPU delegate failed: ${err?.message ?? err}`);
      e.retryCpu = true;
      throw e;
    }
  }
  self.postMessage({ type: 'stage', stage: 'cpu' });
  landmarker = await create('CPU');
  delegate = 'CPU';
}

const toArr = (list) => (list ? list.map((p) => [p.x, p.y, p.z ?? 0]) : null);

function convert(res) {
  const lms = res.landmarks ?? [];
  const worlds = res.worldLandmarks ?? [];
  const hd = res.handedness ?? res.handednesses ?? [];
  return lms.map((lm, i) => ({
    lm: toArr(lm),
    world: toArr(worlds[i]),
    label: hd[i]?.[0]?.categoryName ?? '',
    score: hd[i]?.[0]?.score ?? 1,
  }));
}

// A delegate switch asks main to restart the worker on CPU (a clean wasm instance; model and wasm come from the HTTP
// cache). This was required while the worker was a module worker ("ModuleFactory not set") and stays the safe path.
function requestCpu(reason, extra = {}) {
  try {
    landmarker?.close();
  } catch {}
  landmarker = null; // drop frames until main replaces this worker
  self.postMessage({ type: 'switch', delegate: 'CPU', reason, ...extra });
}

function paceCheck(ms) {
  pace.samples.push(ms);
  if (pace.samples.length < pace.frames + 1) return;
  pace.done = true;
  const s = pace.samples.slice(1).sort((a, b) => a - b); // drop the warm-up frame
  const median = s[s.length >> 1];
  if (median > pace.slowMs) requestCpu('slow', { gpuMedianMs: median });
}

/** Face detector on this frame (or skipped by the every-2nd-frame cadence). Normalized box of the best face. */
function runFace(bmp, mts, w, h) {
  face.n += 1;
  if (face.every > 1 && face.n % face.every !== 0) return { faceRan: false, faceEvery: face.every };
  const t0 = performance.now();
  let res;
  try {
    res = faceDet.detectForVideo(bmp, mts);
  } catch (err) {
    face.error = String(err?.message ?? err);
    return { faceRan: false, faceEvery: face.every, faceError: face.error };
  }
  const faceMs = performance.now() - t0;
  face.samples.push(faceMs);
  if (face.samples.length > 30) face.samples.shift();
  if (face.samples.length >= 10 && face.every === 1) {
    const s = [...face.samples].sort((a, b) => a - b);
    if (s[s.length >> 1] > face.slowMs) face.every = 2; // D13: > 8 ms median → every 2nd frame
  }
  const best = (res.detections ?? []).reduce((a, d) => (!a || (d.categories?.[0]?.score ?? 0) > (a.categories?.[0]?.score ?? 0) ? d : a), null);
  const b = best?.boundingBox;
  return {
    faceRan: true,
    faceMs,
    faceEvery: face.every,
    face: b ? { x: (b.originX + b.width / 2) / w, y: (b.originY + b.height / 2) / h, w: b.width / w, h: b.height / h, score: best.categories?.[0]?.score ?? 0 } : null,
  };
}

async function onFrame(m) {
  const bmp = m.bitmap;
  const w = bmp.width;
  const h = bmp.height;
  busy = true;
  try {
    const mts = Math.max(Math.round(m.ts), lastTs + 1); // MediaPipe needs strictly increasing timestamps
    lastTs = mts;
    const t0 = performance.now();
    const res = landmarker.detectForVideo(bmp, mts);
    const ms = performance.now() - t0;
    let faceOut;
    if (faceDet) faceOut = runFace(bmp, mts, w, h);
    self.postMessage({ type: 'result', ts: m.ts, ms, w, h, hands: convert(res), ...(faceOut ?? {}) });
    if (delegate === 'GPU' && !pace.done) paceCheck(ms);
  } catch (err) {
    self.postMessage({ type: 'result', ts: m.ts, ms: 0, w, h, hands: [], failed: true });
    if (delegate === 'GPU') requestCpu('inference-error', { message: String(err?.message ?? err) }); // GPUs that fail only at inference time
    else console.warn('[detector-worker] inference failed:', err?.message ?? err);
  } finally {
    bmp.close?.();
    busy = false;
  }
}

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'init') {
    if (m.gpuSlowInferMs) pace.slowMs = m.gpuSlowInferMs;
    if (m.gpuPaceFrames) pace.frames = m.gpuPaceFrames;
    face.wanted = !!m.face;
    if (m.faceSlowMs) face.slowMs = m.faceSlowMs;
    try {
      await init(m.prefer);
      if (face.wanted) await initFace();
      self.postMessage({ type: 'ready', delegate });
    } catch (err) {
      self.postMessage({ type: 'error', message: String(err?.message ?? err), retryCpu: !!err?.retryCpu });
    }
  } else if (m.type === 'frame') {
    if (!landmarker || busy) {
      m.bitmap?.close?.();
      return;
    }
    await onFrame(m);
  } else if (m.type === 'close') {
    try {
      landmarker?.close();
    } catch {}
    self.close();
  }
};
