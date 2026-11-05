// input/gestures.js — held camera gestures for menu actions (decisions D10). Owner: PD.
// confirm: both fists in the guard zone (the recognizer's raw guard), held gestureConfirmHoldMs.
// pause:   both hands open, fingers up, at or above guard height, held gesturePauseHoldMs (or the cancel hold).
// resume:  the confirm pose held for gestureResumeMs: the 3-2-1 auto-resume after a camera-loss pause.
// main.js says which gestures are available in the current phase (setMode); the input layer knows no game rules.
// A hold resets when its pose has been broken for more than gestureBreakMs. A fired hold latches until released.

import { HANDS } from '../shared/constants.js';

const TIPS = [8, 12, 16, 20];
const KINDS = ['confirm', 'pause', 'resume'];

/** @returns {{kind:null, progress:0, fired:false, available:string[]}} */
export function emptyGesture() {
  return { kind: null, progress: 0, fired: false, available: [] };
}

/**
 * Pause pose: both hands seen, open (filtered openness above fistOpenAbove), fingers pointing up,
 * palm centre at or above (guard y + pauseMaxBelowGuard). Palm-facing is checked only when enabled (MC-19).
 */
export function pausePose(tracker, profile, tuning) {
  return HANDS.every((h) => {
    const s = tracker.slots[h];
    if (!s.seenNow || s.fist || s.open <= tuning.fistOpenAbove) return false;
    const lm = s.raw.lm;
    const tipY = TIPS.reduce((a, i) => a + lm[i][1], 0) / TIPS.length;
    if (lm[0][1] - tipY < tuning.pauseFingersUpMin) return false; // fingertips above the wrist (image y down)
    if (s.raw.y > profile.hands[h].center.y + tuning.pauseMaxBelowGuard) return false;
    if (tuning.pauseRequirePalmFacing) {
      const w = s.raw.world;
      if (!w) return false;
      const a = [w[5][0] - w[0][0], w[5][1] - w[0][1]];
      const b = [w[17][0] - w[0][0], w[17][1] - w[0][1]];
      const nz = a[0] * b[1] - a[1] * b[0]; // z of (wrist→index MCP) × (wrist→pinky MCP)
      if ((h === 'left' ? 1 : -1) * nz * tuning.palmFacingSign <= 0) return false;
    }
    return true;
  });
}

/** @param {{tuning: object}} opts */
export function createGestureDetector({ tuning }) {
  let mode = { confirm: false, pause: false, resume: false, pauseHoldMs: null };
  const holds = Object.fromEntries(KINDS.map((k) => [k, { start: null, last: -Infinity, latched: false }]));
  let firedPending = null;

  const holdMs = (k) =>
    k === 'confirm' ? tuning.gestureConfirmHoldMs
      : k === 'resume' ? tuning.gestureResumeMs
        : mode.pauseHoldMs ?? tuning.gesturePauseHoldMs;

  function reset(k) {
    holds[k].start = null;
    holds[k].latched = false;
  }

  return {
    /** @param {{confirm?:boolean, pause?:boolean, resume?:boolean, pauseHoldMs?:number|null}} m */
    setMode(m) {
      const next = { confirm: !!m.confirm, pause: !!m.pause, resume: !!m.resume, pauseHoldMs: m.pauseHoldMs ?? null };
      for (const k of KINDS) if (!next[k] && mode[k]) reset(k);
      if (next.pauseHoldMs !== mode.pauseHoldMs) reset('pause');
      mode = next;
    },
    get mode() {
      return { ...mode };
    },

    /** Once per detection result (t in sim seconds), after the pipeline has ingested it. */
    update(tracker, recognizer, profile, t) {
      const poses = {
        confirm: recognizer.guardAt(t).raw,
        pause: pausePose(tracker, profile, tuning),
      };
      poses.resume = poses.confirm;
      for (const k of KINDS) {
        const h = holds[k];
        if (!mode[k]) continue;
        if (poses[k]) {
          if (h.start === null) h.start = t;
          h.last = t;
          if (!h.latched && t - h.start >= holdMs(k) / 1000 - 1e-9) {
            h.latched = true;
            firedPending = k;
          }
        } else if (h.start !== null && t - h.last > tuning.gestureBreakMs / 1000 + 1e-9) {
          reset(k);
        }
      }
    },

    /**
     * Gesture state at time t. drain=true (sample) consumes a pending `fired`.
     * The shown kind is the one that fired, else the available hold furthest along.
     */
    read(t, drain) {
      const out = emptyGesture();
      out.available = KINDS.filter((k) => mode[k]);
      let best = null;
      for (const k of out.available) {
        const h = holds[k];
        if (h.start === null) continue;
        if (t - h.last > tuning.gestureBreakMs / 1000 + 1e-9) continue; // pose broken (no fresh result)
        const p = h.latched ? 1 : Math.min(1, Math.max(0, (t - h.start) / (holdMs(k) / 1000)));
        if (!best || p > best.p) best = { k, p };
      }
      if (best) {
        out.kind = best.k;
        out.progress = best.p;
      }
      if (firedPending) {
        out.kind = firedPending;
        out.progress = 1;
        out.fired = true;
        if (drain) firedPending = null;
      }
      return out;
    },
  };
}
