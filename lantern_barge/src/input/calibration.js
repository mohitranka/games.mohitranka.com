// input/calibration.js — framing → guard hold → 3 straights, in sessions (architecture §6.6, D5a, GDD §9).
// Owner: PD. Pure: it reads the tracker's slots and the recognizer's punches; it never touches the clock or DOM.
// The resulting CalibrationProfile is held in memory only (D6).

import { HANDS, CALIB_HINT } from '../shared/constants.js';
import { createCalibrationStatus } from '../shared/fixtures.js';
import { mirroredPoints } from './features.js';
import { DEFAULT_PROFILE } from './tuning.js';

const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const std = (a) => {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) * (v - m), 0) / (a.length - 1));
};
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * @param {{tuning: object}} opts
 */
export function createCalibration({ tuning }) {
  let st = createCalibrationStatus();
  let stepStart = 0;
  let holdStart = null; // framing / guard hold start
  let guardSamples = null; // {left:[{x,y,k,rate}], right:[...]}
  let lastProgressT = 0;
  let peaks = []; // {hand, peak}
  let provisional = null; // profile used while detecting the calibration straights
  let result = null;
  let landmarks = { left: [], right: [] };

  function toStep(step, t) {
    st.step = step;
    st.progress = 0;
    st.meter = null;
    stepStart = t;
    lastProgressT = t;
    holdStart = null;
  }

  function both(tracker, pred) {
    return HANDS.every((h) => tracker.slots[h].seenNow && pred(tracker.slots[h], h));
  }

  function framingHint(tracker) {
    const s = tracker.slots;
    if (!both(tracker, (sl) => sl.fist)) return CALIB_HINT.SHOW_BOTH_FISTS;
    if (HANDS.some((h) => s[h].raw.k < tuning.framingKMin)) return CALIB_HINT.MOVE_CLOSER;
    if (HANDS.some((h) => s[h].raw.k > tuning.framingKMax)) return CALIB_HINT.MOVE_BACK;
    return null;
  }

  function buildProfile(hands) {
    return { version: 1, hands };
  }

  return {
    /** Start a session (synchronous status reset, architecture §3.2). */
    begin(session, t) {
      st = { ...createCalibrationStatus(), active: true, session, step: 'framing', hint: CALIB_HINT.SHOW_BOTH_FISTS };
      toStep('framing', t);
      guardSamples = null;
      peaks = [];
      provisional = null;
      result = null;
    },
    cancel() {
      st = createCalibrationStatus();
      provisional = null;
      result = null;
    },
    get active() {
      return st.active;
    },
    /** Profile the recognizer should use while calibrating (null outside the straights step). */
    get provisionalProfile() {
      return st.active && st.step === 'straights' ? provisional : null;
    },
    /** The profile from the last finished session, or null. */
    get result() {
      return result;
    },

    /**
     * @param {ReturnType<import('./hand-tracker.js').createHandTracker>} tracker
     * @param {number} t
     * @param {object[]} punches  recognizer output for this result (with `peak`)
     * @returns {import('../shared/types.js').CalibrationProfile|null}  the profile when the session completes
     */
    update(tracker, t, punches) {
      if (!st.active) return null;
      for (const h of HANDS) {
        const s = tracker.slots[h];
        landmarks[h] = s.raw && t - s.lastSeen <= tuning.lossGraceMs / 1000 ? mirroredPoints(s.raw.lm) : [];
      }

      if (st.step === 'framing') {
        const hint = framingHint(tracker);
        st.hint = hint;
        if (hint) {
          holdStart = null;
          st.progress = 0;
        } else {
          if (holdStart === null) holdStart = t;
          st.progress = clamp((t - holdStart) / (tuning.calibFramingHoldMs / 1000), 0, 1);
          if (st.progress >= 1) {
            toStep('guard', t);
            st.hint = CALIB_HINT.HOLD_GUARD;
          }
        }
        return null;
      }

      if (st.step === 'guard') {
        const okFrame = !framingHint(tracker);
        const still = okFrame && both(tracker, (s) => Math.hypot(s.vx, s.vy / tracker.aspect) < tuning.calibStillSpeed);
        if (!okFrame) {
          st.hint = framingHint(tracker);
          holdStart = null;
          guardSamples = null;
          st.progress = 0;
          return null;
        }
        if (!still) {
          st.hint = holdStart !== null ? CALIB_HINT.HOLD_STILL : CALIB_HINT.HOLD_GUARD;
          holdStart = null;
          guardSamples = null;
          st.progress = 0;
          return null;
        }
        if (holdStart === null) {
          holdStart = t;
          guardSamples = { left: [], right: [] };
        }
        st.hint = CALIB_HINT.HOLD_GUARD;
        for (const h of HANDS) {
          const s = tracker.slots[h];
          guardSamples[h].push({ x: s.raw.x, y: s.raw.y, k: s.raw.k, rate: s.rate });
        }
        st.progress = clamp((t - holdStart) / (tuning.calibGuardHoldMs / 1000), 0, 1);
        if (st.progress >= 1) {
          const hands = {};
          for (const h of HANDS) {
            const g = guardSamples[h];
            const noise = std(g.slice(Math.min(3, g.length - 2)).map((s) => s.rate)); // skip the first rate samples
            hands[h] = {
              kGuard: median(g.map((s) => s.k)),
              center: { x: mean(g.map((s) => s.x)), y: mean(g.map((s) => s.y)) },
              noise,
              straightThreshold: tuning.calibProvisionalThreshold,
              straightRateFull: DEFAULT_PROFILE.hands[h].straightRateFull,
            };
          }
          provisional = buildProfile(hands);
          toStep('straights', t);
          st.count = 0;
          st.target = tuning.calibStraights;
          st.hint = CALIB_HINT.THROW_STRAIGHT;
        }
        return null;
      }

      if (st.step === 'straights') {
        for (const p of punches) {
          if (p.punchType !== 'straight') continue;
          peaks.push({ hand: p.hand, peak: p.peak });
          st.count = peaks.length;
          lastProgressT = t;
        }
        const anyHand = HANDS.some((h) => tracker.slots[h].seenNow);
        st.hint = anyHand ? CALIB_HINT.THROW_STRAIGHT : CALIB_HINT.NOT_SEEN;
        st.progress = clamp(st.count / st.target, 0, 1);
        if (t - lastProgressT >= tuning.calibMeterDelayMs / 1000) {
          const value = Math.max(0, ...HANDS.map((h) => (tracker.slots[h].seenNow ? tracker.slots[h].rate : 0)));
          const threshold = Math.max(...HANDS.map((h) =>
            Math.max(provisional.hands[h].straightThreshold, tuning.noiseFactor * provisional.hands[h].noise)));
          st.meter = { value, threshold };
        } else st.meter = null;
        if (st.count >= st.target) {
          const all = peaks.map((p) => p.peak);
          const hands = {};
          for (const h of HANDS) {
            const own = peaks.filter((p) => p.hand === h).map((p) => p.peak);
            const med = median(own.length ? own : all); // a hand that threw none borrows the other's peaks
            const pv = provisional.hands[h];
            const thr = clamp(Math.max(tuning.calibThresholdFactor * med, tuning.noiseFactor * pv.noise),
              tuning.straightThresholdClamp[0], tuning.straightThresholdClamp[1]);
            hands[h] = { ...pv, straightThreshold: thr, straightRateFull: Math.max(tuning.calibRateFullFactor * med, thr + 0.3) };
          }
          result = buildProfile(hands);
          st = { ...st, active: false, step: 'done', progress: 1, meter: null, hint: null, done: true };
          return result;
        }
      }
      return null;
    },

    /** @returns {import('../shared/types.js').CalibrationStatus} */
    status() {
      const out = { ...st };
      if (st.active) out.landmarks = { left: landmarks.left, right: landmarks.right };
      return out;
    },
  };
}
