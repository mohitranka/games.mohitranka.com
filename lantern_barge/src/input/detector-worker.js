// input/detector-worker.js — MediaPipe HandLandmarker in a module worker (architecture §6.1). Owner: PD.
// Protocol. In:  {type:'init', prefer:'GPU'|'CPU'}, {type:'frame', bitmap (transferred), ts (perf ms)}.
//           Out: {type:'stage', stage:'download'|'gpu'|'cpu'}, {type:'ready', delegate}, {type:'delegate', delegate},
//                {type:'result', ts, ms, w, h, hands:[{lm, world, label, score}], failed?}, {type:'error', message}.
// The model and wasm are downloaded BEFORE GPU setup starts, so main's gpuSetupMs timer measures GPU setup only.

import { MP_BUNDLE_URL, MP_WASM_URL, HAND_MODEL_URL } from '../shared/constants.js';

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

async function init(prefer) {
  self.postMessage({ type: 'stage', stage: 'download' });
  vision = await import(MP_BUNDLE_URL);
  fileset = await vision.FilesetResolver.forVisionTasks(MP_WASM_URL, true);
  // download everything first (into the HTTP cache), so GPU setup can be timed on its own
  [modelBytes] = await Promise.all([fetchBytes(HAND_MODEL_URL), fetchBytes(fileset.wasmLoaderPath), fetchBytes(fileset.wasmBinaryPath)]);
  if (prefer !== 'CPU' && typeof OffscreenCanvas !== 'undefined') {
    self.postMessage({ type: 'stage', stage: 'gpu' });
    try {
      landmarker = await create('GPU');
      delegate = 'GPU';
      return;
    } catch (err) {
      console.warn('[detector-worker] GPU delegate failed, using CPU:', err?.message ?? err);
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
    self.postMessage({ type: 'result', ts: m.ts, ms, w, h, hands: convert(res) });
  } catch (err) {
    self.postMessage({ type: 'result', ts: m.ts, ms: 0, w, h, hands: [], failed: true });
    if (delegate === 'GPU') {
      // some GPUs fail only at inference time: recreate on CPU once
      try {
        landmarker.close();
      } catch {}
      try {
        landmarker = await create('CPU');
        delegate = 'CPU';
        self.postMessage({ type: 'delegate', delegate });
      } catch (err2) {
        self.postMessage({ type: 'error', message: String(err2?.message ?? err2) });
      }
    } else {
      console.warn('[detector-worker] inference failed:', err?.message ?? err);
    }
  } finally {
    bmp.close?.();
    busy = false;
  }
}

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'init') {
    try {
      await init(m.prefer);
      self.postMessage({ type: 'ready', delegate });
    } catch (err) {
      self.postMessage({ type: 'error', message: String(err?.message ?? err) });
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
