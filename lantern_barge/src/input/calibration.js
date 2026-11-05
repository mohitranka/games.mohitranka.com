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

  // D3a: tracking quality over the last framingTrackWindowMs (share of results with both hands seen)
  const trackHist = []; // {t, both}
  function trackRatio(t) {
    while (trackHist.length && trackHist[0].t < t - tuning.framingTrackWindowMs / 1000 - 1e-9) trackHist.shift();
    if (!trackHist.length) return 0;
    return trackHist.filter((x) => x.both).length / trackHist.length;
  }
  const windowFull = (t) => trackHist.length && t - trackHist[0].t >= tuning.framingTrackWindowMs / 1000 - 0.05;

  /**
   * The failing condition on this result, most basic first, or null when all pass (D3a: each failure names itself).
   * step 'framing' adds the vertical band, the 2 s tracking quality and (with a face box) the chin-height check;
   * step 'guard' adds stillness.
   */
  function failing(tracker, t, step, face) {
    const s = tracker.slots;
    if (!HANDS.every((h) => s[h].seenNow)) return CALIB_HINT.SHOW_BOTH_FISTS;
    if (!HANDS.every((h) => s[h].fist)) return CALIB_HINT.MAKE_FISTS;
    // tracking quality is judged once 2 s of history exist; the 1 s stable hold may run while the window fills
    if (step === 'framing' && windowFull(t) && trackRatio(t) < tuning.framingTrackMin) return CALIB_HINT.TRACKING_POOR;
    if (HANDS.some((h) => s[h].raw.k < tuning.framingKMin)) return CALIB_HINT.MOVE_CLOSER;
    if (HANDS.some((h) => s[h].raw.k > tuning.framingKMax)) return CALIB_HINT.MOVE_BACK;
    if (step === 'framing') {
      if (HANDS.some((h) => s[h].raw.y < tuning.framingYMin)) return CALIB_HINT.FISTS_TOO_HIGH;
      if (HANDS.some((h) => s[h].raw.y > tuning.framingYMax)) return CALIB_HINT.FISTS_TOO_LOW;
      if (face && tuning.calibUseFace) {
        const chin = face.y + face.h / 2; // bottom of the face box (frame heights)
        if (HANDS.some((h) => s[h].raw.y > chin + tuning.guardChinBelowMax)) return CALIB_HINT.GUARD_TO_CHIN;
      }
    }
    if (step === 'guard' && HANDS.some((h) => Math.hypot(s[h].vx, s[h].vy / tracker.aspect) >= tuning.calibStillSpeed)) {
      return CALIB_HINT.HOLD_STILL;
    }
    return null;
  }

  /**
   * D3a hold: runs on passing results and keeps its last state through failures of up to calibHoldGraceMs; a longer
   * failure restarts it. Returns {ok, progress, reset}.
   */
  let lastOkT = -Infinity;
  function hold(t, ok, needMs) {
    if (ok) {
      if (holdStart === null) holdStart = t;
      lastOkT = t;
    } else if (holdStart !== null && t - lastOkT > tuning.calibHoldGraceMs / 1000 + 1e-9) {
      holdStart = null; // failed for longer than the grace: start again
      return { ok, progress: 0, reset: true };
    }
    if (holdStart === null) return { ok, progress: 0, reset: false };
    return { ok, progress: clamp((t - holdStart) / (needMs / 1000), 0, 1), reset: false };
  }

  function buildProfile(hands) {
    return { version: 1, hands };
  }

  return {
    /** Start a session (synchronous status reset, architecture §3.2). */
    begin(session, t) {
      st = { ...createCalibrationStatus(), active: true, session, step: 'framing', hint: CALIB_HINT.SHOW_BOTH_FISTS };
      toStep('framing', t);
      trackHist.length = 0;
      lastOkT = -Infinity;
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
     * @param {{y:number, h:number}|null} [face]  D3a/D13: latest face box (?next=1 only) for the chin-height check
     * @returns {import('../shared/types.js').CalibrationProfile|null}  the profile when the session completes
     */
    update(tracker, t, punches, face = null) {
      if (!st.active) return null;
      for (const h of HANDS) {
        const s = tracker.slots[h];
        landmarks[h] = s.raw && t - s.lastSeen <= tuning.lossGraceMs / 1000 ? mirroredPoints(s.raw.lm) : [];
      }

      trackHist.push({ t, both: HANDS.every((h) => tracker.slots[h].seenNow) });

      if (st.step === 'framing') {
        const fail = failing(tracker, t, 'framing', face);
        const h = hold(t, !fail, tuning.calibFramingHoldMs);
        st.hint = fail;
        st.progress = h.progress;
        if (!fail && h.progress >= 1 && windowFull(t)) { // stable 1 s AND ≥ 80 % two-hand tracking over 2 s
          toStep('guard', t);
          st.hint = CALIB_HINT.HOLD_GUARD;
        }
        return null;
      }

      if (st.step === 'guard') {
        const fail = failing(tracker, t, 'guard', face);
        const h = hold(t, !fail, tuning.calibGuardHoldMs);
        if (h.reset || holdStart === null) guardSamples = null;
        st.hint = fail ?? CALIB_HINT.HOLD_GUARD;
        st.progress = h.progress;
        if (!fail) {
          guardSamples ??= { left: [], right: [] };
          for (const hand of HANDS) {
            const s = tracker.slots[hand];
            guardSamples[hand].push({ x: s.raw.x, y: s.raw.y, k: s.raw.k, rate: s.rate });
          }
        }
        if (!fail && h.progress >= 1) {
          const hands = {};
          for (const hand of HANDS) {
            const g = guardSamples[hand];
            const noise = std(g.slice(Math.min(3, g.length - 2)).map((s) => s.rate)); // skip the first rate samples
            hands[hand] = {
              kGuard: median(g.map((s) => s.k)),
              center: { x: mean(g.map((s) => s.x)), y: mean(g.map((s) => s.y)) },
              noise,
              straightThreshold: tuning.calibProvisionalThreshold,
              straightRateFull: DEFAULT_PROFILE.hands[hand].straightRateFull,
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
      if (st.active) {
        out.landmarks = { left: landmarks.left, right: landmarks.right };
        // D3a: the vertical band framing checks (TA draws the target box from it)
        out.framingBand = { yMin: tuning.framingYMin, yMax: tuning.framingYMax, xMin: 0.22, xMax: 0.78 };
      }
      return out;
    },
  };
}
