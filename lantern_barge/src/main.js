// main.js — boot, URL params, source selection, fixed-step loop, command routing, wiring (architecture §2, §5).
// Owner: PD. The ONLY place that wires layers together. Layers are loaded with dynamic import(); a layer that
// fails to load, or is named in ?stub=, is replaced by its stub from dev/stubs.js.

import { SIM_DT, PHASE, COMMAND, EVENT } from './shared/constants.js';
import { createClock } from './shared/clock.js';
import { createInputFrame } from './shared/fixtures.js';
import { createEventSource } from './input/event-source.js';
import { attachKeyboard } from './input/keyboard-source.js';
import { tuning as inputTuning } from './input/tuning.js';
import { createHandSource } from './input/hand-source.js';
import { parseJsonl } from './input/replay.js';
import { createStubSim, createNullView, createNullAudio } from './dev/stubs.js';
import { installTestHook } from './test-hook.js';

const params = new URLSearchParams(location.search);
const TEST = params.get('test') === '1';
const DEBUG = params.get('debug') === '1';
const INPUT = params.get('input'); // 'keyboard' | 'camera'
const PREFER = params.get('delegate') === 'cpu' ? 'CPU' : 'GPU'; // ?delegate=cpu (debug / CI fake camera)
const STUBS = new Set((params.get('stub') ?? '').split(',').map((s) => s.trim()).filter(Boolean));
if (STUBS.has('view')) STUBS.add('audio');
// Stub sim autoplay: on for ?stub=game outside tests; ?stubAutoplay=1|0 overrides (dev-only, stub-only).
const STUB_AUTOPLAY = params.has('stubAutoplay') ? params.get('stubAutoplay') === '1' : !TEST;
const ALLOW_DEBUG = TEST || DEBUG;
const MAX_CATCHUP = 0.25; // s
const EVENT_LOG_CAP = 10000;
const LOAD_TIMEOUT_MS = 15000; // BUG-008: a layer (or three.js from the CDN) that hangs fails loudly instead

const $ = (id) => document.getElementById(id);

// ───────────────────────────────────────────── core state
const clock = createClock({ manual: TEST });
const tuning = { input: inputTuning, game: {}, view: {} };
const layers = { game: 'stub', view: 'stub', audio: 'stub' };
const events = createEventSource({ clock, tuning: inputTuning });
/** @type {import('./shared/types.js').InputSource & Record<string, any>} */
let source = events;
/** @type {import('./shared/types.js').Sim} */
let sim = null;
/** @type {import('./shared/types.js').Renderer} */
let renderer = null;
/** @type {import('./shared/types.js').Audio} */
let audio = createNullAudio();

let simTime = 0;
let leftover = 0;
let lastFrame = createInputFrame(0, 'none');
const pending = [];
const log = { entries: [], dropped: 0 };
const commandLog = [];
const perf = { simMs: 0, renderMs: 0, fps: 0, _frames: 0, _fpsT: performance.now() };
let bodyPhase = null;
let bodyInput = null;
let pausedForLoss = false; // D10: we paused the fight because the camera was lost (auto-resume applies)
let detachKeyboard = () => {};
let overlay = null;

// ───────────────────────────────────────────── loop
function tick() {
  const t0 = performance.now();
  source.setGestureMode?.(gestureModeFor(sim.state, lastFrame));
  const frame = events.decorate(source.sample(simTime + SIM_DT));
  lastFrame = frame;
  const out = sim.step(frame, SIM_DT) ?? [];
  simTime = typeof sim.state.time === 'number' ? sim.state.time : simTime + SIM_DT;
  const tickNo = sim.state.tick;
  for (const e of out) log.entries.push({ tick: tickNo, ...e });
  if (log.entries.length > EVENT_LOG_CAP) {
    const drop = log.entries.length - EVENT_LOG_CAP;
    log.entries.splice(0, drop);
    log.dropped += drop;
  }
  pending.push(...out);
  if (pending.length > 2000) pending.splice(0, pending.length - 2000);
  audio.handle(out, sim.state);
  phaseSideEffects(out, frame);
  if (frame.gesture?.fired) routeGesture(frame.gesture.kind, sim.state);
  perf.simMs += 0.1 * (performance.now() - t0 - perf.simMs);
}

function draw(alpha) {
  const t0 = performance.now();
  const view = events.decorate(source.peek(clock.now()), { drain: false });
  renderer.update(sim.state, pending.splice(0), view, alpha);
  overlay?.draw(view, sim.state);
  perf.renderMs += 0.1 * (performance.now() - t0 - perf.renderMs);
  perf._frames += 1;
  const now = performance.now();
  if (now - perf._fpsT >= 1000) {
    perf.fps = (perf._frames * 1000) / (now - perf._fpsT);
    perf._frames = 0;
    perf._fpsT = now;
  }
}

function onRaf() {
  requestAnimationFrame(onRaf);
  if (!sim || clock.manual) return;
  const lag = clock.now() - simTime;
  if (lag > MAX_CATCHUP) clock.rebase(lag - MAX_CATCHUP); // shift perf→sim offset; sim time never jumps
  while (clock.now() - simTime >= SIM_DT) tick();
  draw((clock.now() - simTime) / SIM_DT);
}

function toManual() {
  if (clock.manual) return;
  clock.manual = true;
  clock.set(simTime);
  leftover = 0;
}

/** Manual clock: run whole ticks, carrying the sub-tick remainder across calls. */
function advance(ms, { render = true } = {}) {
  toManual();
  leftover += Math.max(0, ms) / 1000;
  let ticks = 0;
  while (leftover >= SIM_DT - 1e-9) {
    clock.set(simTime + SIM_DT);
    tick();
    leftover -= SIM_DT;
    ticks += 1;
  }
  if (Math.abs(leftover) < 1e-9) leftover = 0;
  clock.set(simTime);
  if (render) draw(0);
  return { ticks, state: sim.snapshot() };
}

function step(n = 1, { render = true } = {}) {
  toManual();
  for (let i = 0; i < n; i++) {
    clock.set(simTime + SIM_DT);
    tick();
  }
  clock.set(simTime);
  if (render) draw(0);
  return { ticks: n, state: sim.snapshot() };
}

// ───────────────────────────────────────────── commands and phase side effects
function command(cmd) {
  if (!cmd || typeof cmd.type !== 'string') throw new Error('command: expected {type}');
  if (cmd.type === COMMAND.RESUME) pausedForLoss = false; // any resume (key, gesture, auto) ends a loss pause
  commandLog.push({ tick: sim.state.tick + 1, cmd: structuredClone(cmd) }); // applied at the start of the next step
  sim.command(cmd);
}

function phaseSideEffects(out, frame) {
  for (const e of out) {
    if (e.type !== EVENT.PHASE) continue;
    if (e.to === PHASE.CALIBRATION) source.beginCalibration(sim.state.calibSession);
    if (e.from === PHASE.CALIBRATION && e.to === PHASE.BOOT) {
      source.cancelCalibration();
      // backing out of calibration releases the webcam; "Box with camera" starts afresh (BUG-005)
      if (source.kind === 'camera') {
        setSource(events);
        setBootStatus('');
      }
    }
  }
  const st = sim.state;
  // camera loss pauses the fight; D10 auto-resume (3-2-1 with guard held) brings it back
  const tracked = frame.source === 'camera' || frame.source === 'replay';
  if (tracked && !frame.tracking.ok && st.phase === PHASE.FIGHT && !st.paused && !pausedForLoss) {
    command({ type: COMMAND.PAUSE });
    pausedForLoss = true;
  }
  if (st.phase !== PHASE.FIGHT) pausedForLoss = false;
  if (st.phase !== bodyPhase) {
    if (bodyPhase) document.body.classList.remove(`phase-${bodyPhase}`);
    bodyPhase = st.phase;
    document.body.classList.add(`phase-${bodyPhase}`);
  }
  if (frame.source !== bodyInput) {
    if (bodyInput) document.body.classList.remove(`input-${bodyInput}`);
    bodyInput = frame.source;
    document.body.classList.add(`input-${bodyInput}`);
  }
}

// ───────────────────────────────────────────── D10 camera gestures
/** Which held gestures count in the current phase. Confirm is never active in a running fight (guard = guard). */
function gestureModeFor(st, frame) {
  if (source.kind !== 'camera' && source.kind !== 'replay') return {};
  if (st.paused) {
    if (!pausedForLoss) return { confirm: true }; // P / pause gesture → confirm resumes
    return frame.tracking.ok ? { resume: true } : {}; // camera back: guard up for 3-2-1
  }
  switch (st.phase) {
    case PHASE.CALIBRATION: return { pause: true, pauseHoldMs: inputTuning.gestureCancelHoldMs };
    case PHASE.PRACTICE: return { confirm: true };
    case PHASE.FIGHT: return { pause: true };
    case PHASE.MATCH_END: return { confirm: true };
    default: return {};
  }
}

/** A completed hold → the same COMMAND the key would send (onMenuKey). */
function routeGesture(kind, st) {
  if (kind === 'confirm' || kind === 'resume') {
    if (st.paused) command({ type: COMMAND.RESUME });
    else if (kind === 'confirm' && st.phase === PHASE.PRACTICE) command({ type: COMMAND.SKIP_PRACTICE });
    else if (kind === 'confirm' && st.phase === PHASE.MATCH_END) command({ type: COMMAND.RESTART });
  } else if (kind === 'pause') {
    if (st.phase === PHASE.CALIBRATION) command({ type: COMMAND.CANCEL });
    else if (st.phase === PHASE.FIGHT && !st.paused) command({ type: COMMAND.PAUSE });
  }
}

function onMenuKey(code) {
  if (!sim) return;
  const phase = sim.state.phase;
  if (code === 'Enter') {
    if (phase === PHASE.BOOT) startKeyboard();
    else if (phase === PHASE.MATCH_END) command({ type: COMMAND.RESTART });
    else if (phase === PHASE.PRACTICE) command({ type: COMMAND.SKIP_PRACTICE });
  } else if (code === 'KeyP') {
    if (phase !== PHASE.BOOT) command({ type: sim.state.paused ? COMMAND.RESUME : COMMAND.PAUSE });
  } else if (code === 'Escape') {
    if (phase === PHASE.CALIBRATION) command({ type: COMMAND.CANCEL });
  }
}

function useKeyboardPunches() {
  if (events.kind === 'keyboard') return;
  detachKeyboard();
  detachKeyboard = attachKeyboard(events, { onMenuKey, punches: true });
}

// Source selection is final (BUG-002): every choice takes a new token; a camera start that resolves after the
// player chose something else is cancelled and releases the webcam instead of taking over.
let sourceChoice = 0;
let pendingCamera = null;

function cancelPendingCamera() {
  pendingCamera?.stop(); // rejects its start() with err.cancelled and releases the tracks
  pendingCamera = null;
  setBootStatus('');
}

function startKeyboard() {
  sourceChoice += 1;
  cancelPendingCamera();
  audio.unlock().catch(() => {});
  useKeyboardPunches();
  setSource(events);
  command({ type: COMMAND.START });
}

function setSource(next) {
  if (source !== next && source !== events) source.stop?.();
  source = next;
  overlay?.setSource(next);
}

function bootMessage(text) {
  const msg = $('boot-msg');
  if (!msg) return;
  msg.textContent = text;
  msg.hidden = !text;
}

function setBootStatus(text) {
  const status = $('boot-status');
  if (status) status.textContent = text;
}

async function startCamera() {
  if (pendingCamera || !sim || sim.state.phase !== PHASE.BOOT) return; // already starting, or a match is on
  if (source.kind === 'camera') {
    command({ type: COMMAND.START }); // camera already running at BOOT: just start
    return;
  }
  const my = ++sourceChoice;
  audio.unlock().catch(() => {});
  bootMessage('');
  setBootStatus('Starting the camera and hand tracking…');
  const hs = createHandSource({ backend: 'camera', clock, tuning: inputTuning, video: $('cam'), prefer: PREFER });
  pendingCamera = hs;
  try {
    await hs.start();
    if (my !== sourceChoice || sim.state.phase !== PHASE.BOOT) {
      hs.stop(); // the player chose something else meanwhile: release the webcam, don't take over
      return;
    }
    setSource(hs);
    setBootStatus(`Hand tracking ready (${hs.detectorStats?.delegate ?? '?'})`);
    command({ type: COMMAND.START });
  } catch (err) {
    hs.stop();
    if (err?.cancelled || my !== sourceChoice) return; // superseded by another choice: say nothing
    const denied = err?.name === 'NotAllowedError' || err?.name === 'SecurityError';
    const missing = err?.name === 'NotFoundError' || err?.name === 'OverconstrainedError';
    console.warn('[main] camera unavailable:', err?.name ?? '', err?.message ?? err);
    bootMessage(denied ? 'Camera permission was denied. You can box with the keyboard instead.'
      : missing ? 'No camera was found. You can box with the keyboard instead.'
        : `Hand tracking could not start (${err?.message ?? err}). You can box with the keyboard instead.`);
    setBootStatus('');
    $('btn-keyboard')?.focus();
  } finally {
    if (pendingCamera === hs) pendingCamera = null;
  }
}

/** Switch to the replay HandSource. A replay with {calibrate:true} waits for beginCalibration (D7). */
async function loadReplay(urlOrJsonl, { calibrate = false } = {}) {
  const text = /^\s*\{/.test(urlOrJsonl) ? urlOrJsonl : await (await fetch(urlOrJsonl)).text();
  const recording = parseJsonl(text);
  const hs = createHandSource({ backend: 'replay', clock, tuning: inputTuning, recording, calibrate });
  await hs.start();
  setSource(hs);
  const last = recording.results.at(-1);
  return { results: recording.results.length, cues: recording.cues.length, durationS: last ? last.t / 1000 : 0, calibrate };
}

function setTuning(path, value) {
  const keys = path.split('.');
  let o = tuning;
  for (let i = 0; i < keys.length - 1; i++) {
    o = o?.[keys[i]];
    if (o == null || typeof o !== 'object') throw new Error(`setTuning: unknown path ${path}`);
  }
  const last = keys.at(-1);
  if (keys.length < 2 || !(last in o)) throw new Error(`setTuning: unknown key ${path}`);
  const prev = o[last];
  o[last] = value;
  return prev;
}

// ───────────────────────────────────────────── layer loading
/** Reject if `p` hasn't settled within ms. The error names the layer for the #boot message. */
function withTimeout(p, ms, what) {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${what} did not load within ${Math.round(ms / 1000)} s`);
      err.layer = what;
      err.timeout = true;
      reject(err);
    }, ms);
  });
  return Promise.race([p, limit]).finally(() => clearTimeout(timer));
}

/** A real layer that fails or hangs stops the boot with a visible error and a Retry button (BUG-008). */
function layerError(what, err) {
  const e = err?.layer ? err : new Error(`${what} failed to load: ${err?.message ?? err}`);
  e.layer = what;
  return e;
}

async function loadGame(seed) {
  const opts = { seed, allowDebug: ALLOW_DEBUG };
  if (STUBS.has('game')) return createStubSim({ ...opts, autoplay: STUB_AUTOPLAY });
  try {
    const [simMod, tunMod] = await withTimeout(
      Promise.all([import('./game/sim.js'), import('./game/tuning.js')]), LOAD_TIMEOUT_MS, 'the game rules');
    if (tunMod?.tuning) tuning.game = tunMod.tuning;
    const s = simMod.createSim({ ...opts, tuning: tuning.game });
    layers.game = 'real';
    return s;
  } catch (err) {
    throw layerError('the game rules', err);
  }
}

async function loadView() {
  const hudRoot = $('hud');
  if (STUBS.has('view')) return createNullView({ hudRoot: TEST ? null : hudRoot });
  try {
    // renderer.js pulls three.js from the CDN through the import map: the usual thing to hang offline
    const [rMod, tunMod] = await withTimeout(
      Promise.all([import('./view/renderer.js'), import('./view/tuning.js')]), LOAD_TIMEOUT_MS, 'the 3D view');
    if (tunMod?.tuning) tuning.view = tunMod.tuning;
    const r = rMod.createRenderer({ canvas: $('gl'), hudRoot });
    layers.view = 'real';
    return r;
  } catch (err) {
    throw layerError('the 3D view', err);
  }
}

async function loadAudio() {
  if (STUBS.has('audio')) return createNullAudio();
  try {
    // sound is optional: a failure or hang plays silently instead of blocking the game
    const a = (await withTimeout(import('./view/audio.js'), LOAD_TIMEOUT_MS, 'audio')).createAudio();
    layers.audio = 'real';
    return a;
  } catch (err) {
    console.warn('[main] audio unavailable, using null audio:', err?.message ?? err);
    return createNullAudio();
  }
}

// ───────────────────────────────────────────── boot
async function boot() {
  const body = document.body;
  body.classList.add('booting', 'phase-boot'); // #boot is visible while layers load, so a load error can show
  bodyPhase = 'boot';
  if (TEST) body.classList.add('test');
  if (DEBUG) body.classList.add('debug');

  const seed = TEST ? 1 : (Date.now() % 2147483647) || 1;
  [sim, renderer, audio] = await Promise.all([loadGame(seed), loadView(), loadAudio()]);
  if (TEST) audio.setMuted(true);

  renderer.onCommand((cmd) => command(cmd));
  const resize = () => renderer.resize(innerWidth, innerHeight);
  addEventListener('resize', resize);
  resize();

  detachKeyboard = attachKeyboard(events, { onMenuKey, punches: INPUT === 'keyboard' });
  if (INPUT && INPUT !== 'keyboard' && INPUT !== 'camera') console.warn(`[main] unknown ?input=${INPUT}; ignoring`);
  if (DEBUG) {
    const { createDebugOverlay } = await import('./input/debug-overlay.js');
    overlay = createDebugOverlay({ root: $('overlay'), getSource: () => source, tuning, setTuning });
  }

  $('btn-keyboard')?.addEventListener('click', () => startKeyboard());
  $('btn-camera')?.addEventListener('click', () => startCamera());
  const status = $('boot-status');
  // developer layer info only under ?debug=1 (BUG-006); players see #boot-status only for camera start-up
  if (status && DEBUG) status.textContent = `game: ${layers.game} · view: ${layers.view} · input: ${events.kind}`;

  phaseSideEffects([], lastFrame);
  body.classList.remove('booting');
  requestAnimationFrame(onRaf);
  if (TEST) draw(0);

  if (params.has('replay')) {
    const info = await loadReplay(params.get('replay'), { calibrate: params.get('calibrate') === '1' });
    console.info('[main] replay loaded', info);
    if (!TEST) command({ type: COMMAND.START });
  } else if (INPUT === 'camera') {
    startCamera(); // reports failures on #boot itself
  }
}

const ready = boot();
ready.catch((err) => {
  console.error('[main] boot failed:', err);
  document.body.classList.add('load-error');
  bootMessage(err?.layer
    ? `Lantern Barge couldn't finish loading: ${err.message}. Check your internet connection, then retry.`
    : `Lantern Barge couldn't start (${err?.message ?? err}). Please retry.`);
  setBootStatus('');
  const retry = $('btn-retry');
  if (retry) {
    retry.hidden = false;
    retry.onclick = () => location.reload();
    retry.focus();
  }
});

installTestHook({
  ready,
  advance,
  step,
  now: () => clock.now(),
  getSim: () => sim,
  getLastFrame: () => lastFrame,
  log,
  commandLog,
  command,
  events,
  tuning,
  layers,
  perf: () => {
    // view stats come straight from the renderer's stats() (TA); the null view reports zeros
    const v = renderer?.stats?.() ?? {};
    const hasTracker = lastFrame.source === 'camera' || lastFrame.source === 'replay';
    return {
      fps: v.fps || perf.fps,
      drawCalls: v.drawCalls ?? 0,
      triangles: v.triangles ?? 0,
      inferHz: hasTracker ? lastFrame.tracking.fps : undefined,
      simMs: perf.simMs,
      renderMs: perf.renderMs,
      tracking: { ...lastFrame.tracking },
    };
  },
  loadReplay,
  setTuning,
  getSource: () => source,
  getOverlay: () => overlay,
});
