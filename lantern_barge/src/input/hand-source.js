// input/hand-source.js — InputSource for the live camera AND for replays (architecture §3.2, D7). Owner: PD.
// Both backends feed the same pipeline (tracker + recognizer) and calibration, so a replay exercises exactly the
// code the camera does. Results carry sim-second timestamps (clock.fromPerfMs for the camera; t0 + t for replays).

import { HANDS } from '../shared/constants.js';
import { createInputFrame } from '../shared/fixtures.js';
import { createInputPipeline } from './pipeline.js';
import { createCalibration } from './calibration.js';
import { createReplayFeeder } from './replay.js';
import { createGestureDetector } from './gestures.js';
import { DEFAULT_PROFILE } from './tuning.js';

/**
 * @param {{backend:'camera'|'replay', clock:import('../shared/clock.js').Clock, tuning:object,
 *   recording?:{header:object, results:object[], cues:object[]}, calibrate?:boolean,
 *   video?:HTMLVideoElement, prefer?:'GPU'|'CPU'}} opts
 */
export function createHandSource({ backend, clock, tuning, recording = null, calibrate = false, video = null, prefer = 'GPU', face = false }) {
  const pipeline = createInputPipeline({ tuning, profile: DEFAULT_PROFILE });
  const calib = createCalibration({ tuning });
  const gestures = createGestureDetector({ tuning });
  const wanted = backend === 'camera' || (backend === 'replay' && calibrate);
  let calibratedProfile = null;
  const queue = [];
  let seq = 0;
  let lastSampleT = 0;
  let spotDrift = null;
  const listeners = new Set(); // overlay / recorder: ({result, punches, raw})
  const rawListeners = new Set(); // recorder: raw detector results (perf-ms timestamps)

  // camera backend
  let detector = null;
  let frames = null;
  let stream = null;
  let stopped = false; // stop() during start() cancels it: start() rejects with err.cancelled and releases the camera
  // replay backend
  const feeder = backend === 'replay' ? createReplayFeeder(recording) : null;

  function releaseCamera() {
    for (const tr of stream?.getTracks() ?? []) tr.stop();
    stream = null;
    if (video && video.srcObject) {
      video.pause?.();
      video.srcObject = null;
    }
  }

  const activeProfile = () => calib.provisionalProfile ?? calibratedProfile ?? DEFAULT_PROFILE;

  // D13 spike: the last face box (held for headGraceMs, as for a lost hand)
  let lastFace = null;
  let lastFaceT = -Infinity;

  function ingest(result, raw = null) {
    if (result.face) {
      lastFace = result.face;
      lastFaceT = result.t;
    }
    pipeline.setProfile(activeProfile());
    const { punches } = pipeline.ingest(result);
    if (calib.active) {
      const done = calib.update(pipeline.tracker, result.t, punches);
      if (done) calibratedProfile = done;
      // punches thrown while calibrating belong to calibration, not to the game
    } else {
      for (const p of punches) {
        const ev = { ...p };
        delete ev.peak; // calibration-only field
        queue.push(ev);
      }
    }
    updateSpot(result.t);
    gestures.update(pipeline.tracker, pipeline.recognizer, activeProfile(), result.t);
    for (const fn of listeners) fn({ result, punches, raw });
  }

  function updateSpot(t) {
    if (!calibratedProfile) return;
    const g = pipeline.recognizer.guardAt(t);
    if (g.level !== 'full') return;
    const ratios = HANDS.map((h) => {
      const s = pipeline.tracker.slots[h];
      return s.seenNow ? s.raw.k / calibratedProfile.hands[h].kGuard : null;
    }).filter((v) => v !== null);
    if (!ratios.length) return;
    const drift = Math.abs(ratios.reduce((a, b) => a + b, 0) / ratios.length - 1);
    spotDrift = spotDrift === null ? drift : spotDrift + 0.05 * (drift - spotDrift);
  }

  function tracking() {
    if (backend === 'camera') {
      const s = detector?.stats;
      return {
        // a GPU→CPU worker restart (a second or two) is not a camera loss: don't auto-pause the fight for it
        ok: !!(frames?.ok && (detector?.ready || detector?.stats.switching)),
        fps: s?.fps ?? 0,
        inferMs: s?.inferMs ?? 0,
        pipelineMs: s?.pipelineMs ?? 0,
        delegate: s?.delegate ?? null,
        ...(s?.face ? { face: { ...s.face } } : {}), // D13 spike: {ok, error, ms, every, runs, found}
      };
    }
    return { ok: true, fps: recording?.header?.fps ?? 0, inferMs: 0, pipelineMs: 0, delegate: null };
  }

  function buildFrame(t, drain) {
    if (drain && feeder) feeder.feed(t, (r) => ingest(r));
    const f = createInputFrame(t, backend);
    f.seq = drain ? ++seq : seq;
    const fs = pipeline.frameState(t);
    f.hands = fs.hands;
    f.guard = { ...fs.guard };
    f.tracking = tracking();
    f.calibration = { ...calib.status(), wanted };
    f.gesture = gestures.read(t, drain);
    if (lastFace && t - lastFaceT <= tuning.headGraceMs / 1000 + 1e-9) {
      f.head = { present: true, raw: { ...lastFace, x: 1 - lastFace.x } }; // mirrored like the hands; spike: dx/dy/w0/dodge come with M7
    }
    f.spot = {
      kGuardDrift: spotDrift,
      hint: spotDrift !== null && spotDrift > tuning.spotDriftMax ? 'return_to_spot' : null,
    };
    if (drain) {
      const due = [];
      for (let i = 0; i < queue.length; ) {
        if (queue[i].tCommit <= t + 1e-9) due.push(queue.splice(i, 1)[0]);
        else i++;
      }
      f.events = due.sort((a, b) => a.tCommit - b.tCommit);
      lastSampleT = t;
    }
    return f;
  }

  const source = {
    kind: backend,
    get profile() {
      return calibratedProfile ?? DEFAULT_PROFILE;
    },

    async start() {
      if (backend === 'replay') {
        if (!recording) throw new Error('replay backend needs a recording');
        if (!calibrate) feeder.start(clock.now()); // calibrating replays wait for beginCalibration()
        return;
      }
      const [{ openCamera, watchFrames }, { createDetector }] = await Promise.all([
        import('./camera.js'),
        import('./detector.js'),
      ]);
      detector = createDetector({
        prefer,
        gpuSetupMs: tuning.gpuSetupMs,
        gpuSlowInferMs: tuning.gpuSlowInferMs,
        gpuPaceFrames: tuning.gpuPaceFrames,
        face, // D13 spike: run the face detector too (?next=1)
        faceSlowMs: tuning.faceSlowMs,
        onResult: (m) => {
          const hands = m.hands ?? [];
          const faceRec = m.faceRan ? (m.face ?? null) : undefined; // undefined = not run this frame
          for (const fn of rawListeners) fn({ ts: m.ts, arrival: m.arrival, w: m.w, h: m.h, hands, face: faceRec });
          ingest({ t: clock.fromPerfMs(m.ts), w: m.w, h: m.h, hands, face: faceRec }, m);
        },
      });
      const cancelled = () => {
        releaseCamera();
        const err = new Error('camera start cancelled');
        err.cancelled = true;
        return err;
      };
      if (stopped) throw cancelled();
      // camera permission first (fast feedback), then the model download / worker start
      stream = await openCamera(video, { width: tuning.camWidth, height: tuning.camHeight, fps: tuning.camFps });
      if (stopped) throw cancelled();
      try {
        await detector.init();
      } catch (err) {
        releaseCamera();
        throw stopped ? cancelled() : err;
      }
      if (stopped) throw cancelled();
      frames = watchFrames(video, stream, (ts) => {
        if (detector.busy || !detector.ready || video.readyState < 2) return; // one frame in flight
        createImageBitmap(video).then((bmp) => detector.detect(bmp, ts), () => {});
      }, { stallMs: tuning.stallMs });
    },

    /** Stops tracking and releases the webcam. Safe to call while start() is still pending (cancels it). */
    stop() {
      stopped = true;
      frames?.stop();
      detector?.stop();
      frames = null;
      releaseCamera();
    },
    get stopped() {
      return stopped;
    },

    sample(t) {
      return buildFrame(t, true);
    },
    peek(t) {
      return buildFrame(t, false);
    },

    beginCalibration(session) {
      calib.begin(session, lastSampleT);
      if (feeder && calibrate && !feeder.started) feeder.start(lastSampleT);
    },
    cancelCalibration() {
      calib.cancel();
    },
    /** D10: which held gestures count right now (main.js derives this from the phase). */
    setGestureMode(m) {
      gestures.setMode(m);
    },

    // ── diagnostics (overlay, recorder, tests)
    get pipeline() {
      return pipeline;
    },
    get detectorStats() {
      return detector?.stats ?? null;
    },
    get replayDone() {
      return feeder ? feeder.started && feeder.done : false;
    },
    onResult(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    onRaw(fn) {
      rawListeners.add(fn);
      return () => rawListeners.delete(fn);
    },
  };
  return source;
}
