// input/recognizer.js — straight + hook classifiers, refractory, blur rescue, power, guard geometry
// (architecture §6.4, decisions D2/D3, game-design §4–§5). Owner: PD.
// Runs once per detection result, on the tracker's slots. Per-hand state is keyed by slot (left/right).

import { HANDS } from '../shared/constants.js';

const EPS = 1e-9;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function createHandRec() {
  return {
    sArmed: false, sOnset: 0, sSamples: 0, sPeak: 0,
    hArmed: false, hOnset: 0, hX0: 0, hSamples: 0, hPeak: 0,
    uArmed: false, uOnset: 0, uY0: 0, uSamples: 0, uPeak: 0,
    lastRate: 0, lastCommit: -Infinity, lockoutUntil: -Infinity,
    wasSeen: false, wasFist: false,
  };
}

/**
 * @param {{tuning: object}} opts
 */
export function createRecognizer({ tuning }) {
  const rec = { left: createHandRec(), right: createHandRec() };
  let nextId = 1;
  const guard = {
    level: 'none', raw: false, left: false, right: false, since: 0,
    inSince: null, outSince: null, lastRawT: -Infinity, lastResultT: -Infinity,
  };

  /** Effective straight threshold for a hand: max(profile threshold, noiseFactor × measured noise). */
  function straightThreshold(profile, hand) {
    const p = profile.hands[hand];
    return Math.max(p.straightThreshold, tuning.noiseFactor * (p.noise || 0));
  }
  function straightFull(profile, hand) {
    return Math.max(profile.hands[hand].straightRateFull, straightThreshold(profile, hand) + 0.1);
  }

  function disarm(r) {
    r.sArmed = r.hArmed = r.uArmed = false;
  }

  function punch(hand, punchType, power, tOnset, tCommit, aimX, inferred, peak) {
    return {
      type: 'punch', id: nextId++, hand, punchType, power: Math.round(clamp01(power) * 1000) / 1000,
      aim: { x: aimX }, tOnset, tCommit, inferred, peak,
    };
  }

  function commit(r, ev, t) {
    r.lastCommit = t;
    r.lockoutUntil = t + tuning.guardLockoutMs / 1000;
    disarm(r);
    return ev;
  }

  /**
   * @param {ReturnType<import('./hand-tracker.js').createHandTracker>} tracker
   * @param {{t:number, seen:{left:boolean,right:boolean}}} upd
   * @param {import('../shared/types.js').CalibrationProfile} profile
   * @returns {object[]} punch events (with an extra `peak` field used by calibration)
   */
  function update(tracker, upd, profile) {
    const { t, seen } = upd;
    const out = [];
    const aspectInv = 1 / tracker.aspect; // H/W: frame heights → frame widths
    for (const hand of HANDS) {
      const s = tracker.slots[hand];
      const r = rec[hand];
      const thr = straightThreshold(profile, hand);
      const full = straightFull(profile, hand);
      const refractory = t - r.lastCommit < tuning.refractoryMs / 1000 - EPS;

      if (!seen[hand]) {
        // blur rescue: the very first result that loses an armed straight commits it (D2)
        if (r.wasSeen && r.sArmed && r.wasFist && r.lastRate > thr && !refractory) {
          const tc = s.lastSeen;
          out.push(commit(r, punch(hand, 'straight', (Math.max(r.sPeak, r.lastRate) - thr) / (full - thr),
            r.sOnset, tc, s.raw.x, true, Math.max(r.sPeak, r.lastRate)), tc));
        }
        disarm(r);
        r.wasSeen = false;
        continue;
      }

      const prev = s.hist.length >= 2 ? s.hist[s.hist.length - 2] : s.hist[s.hist.length - 1];
      if (!s.fist) {
        // the fist opened mid-punch (blur often reads as open): same rescue rule
        if (r.wasSeen && r.sArmed && r.wasFist && r.lastRate > thr && !refractory) {
          out.push(commit(r, punch(hand, 'straight', (Math.max(r.sPeak, r.lastRate) - thr) / (full - thr),
            r.sOnset, prev.t, s.raw.x, true, Math.max(r.sPeak, r.lastRate)), prev.t));
        }
        disarm(r);
        r.wasSeen = true;
        r.wasFist = false;
        r.lastRate = s.rate;
        continue;
      }

      const rate = s.rate;
      const x = s.raw.x;
      const kGuard = profile.hands[hand].kGuard;
      const kRatio = s.raw.k / kGuard;
      const speed = Math.hypot(s.vx, s.vy * aspectInv); // frame widths/s

      // ── straight: depth-rate onset (GDD §4)
      let straight = null;
      if (!refractory && rate > thr) {
        if (!r.sArmed) {
          r.sArmed = true;
          r.sOnset = prev.t; // the growth started at the previous sample
          r.sSamples = 1;
          r.sPeak = rate;
        } else {
          r.sSamples += 1;
          r.sPeak = Math.max(r.sPeak, rate);
        }
        if (t - r.sOnset >= tuning.straightMinMs / 1000 - EPS && r.sSamples >= tuning.straightMinSamples &&
            kRatio > tuning.straightRatioMin && speed < tuning.straightScreenSpeedMax) {
          straight = punch(hand, 'straight', (r.sPeak - thr) / (full - thr), r.sOnset, t, x, false, r.sPeak);
        }
      } else r.sArmed = false;

      // ── hook: sideways onset toward the midline (GDD §4)
      let hook = null;
      const dir = hand === 'left' ? 1 : -1;
      const vin = s.vx * dir;
      if (!refractory) {
        const gx = profile.hands[hand].center.x;
        if (!r.hArmed) {
          if (vin > tuning.hookThreshold) {
            // where the sideways motion began: the outermost x in the last hookLookbackMs
            let x0 = prev.x;
            for (const h of s.hist) if (h.t >= t - tuning.hookLookbackMs / 1000 - EPS && (h.x - x0) * dir < 0) x0 = h.x;
            if ((x0 - gx) * dir <= tuning.hookStartTolerance) {
              r.hArmed = true;
              r.hOnset = prev.t;
              r.hX0 = x0;
              r.hSamples = 1;
              r.hPeak = vin;
            }
          }
        } else if (vin > tuning.hookThreshold * tuning.hookSustainFactor) {
          if (vin > tuning.hookThreshold) r.hSamples += 1;
          r.hPeak = Math.max(r.hPeak, vin);
        } else r.hArmed = false;
        if (r.hArmed) {
          const travel = (x - r.hX0) * dir;
          if (t - r.hOnset >= tuning.hookMinMs / 1000 - EPS && r.hSamples >= tuning.hookMinSamples &&
              travel > tuning.hookTravelMin && Math.abs(s.vy * aspectInv) < tuning.hookVyRatio * Math.abs(s.vx)) {
            hook = punch(hand, 'hook', (r.hPeak - tuning.hookThreshold) / (tuning.hookRateFull - tuning.hookThreshold),
              r.hOnset, t, x, false, r.hPeak);
          }
        }
      } else r.hArmed = false;

      // ── uppercut: deferred (D6). Only runs when enableUppercut is true.
      let upper = null;
      if (tuning.enableUppercut && !refractory) {
        const vup = -s.vy; // frame heights/s, + = up
        const gy = profile.hands[hand].center.y;
        if (!r.uArmed) {
          if (vup > tuning.uppercutThreshold) {
            let y0 = prev.y; // lowest point in the lookback window = where the uppercut began
            for (const h of s.hist) if (h.t >= t - tuning.hookLookbackMs / 1000 - EPS && h.y > y0) y0 = h.y;
            if (y0 >= gy + tuning.uppercutStartBelow) {
              Object.assign(r, { uArmed: true, uOnset: prev.t, uY0: y0, uSamples: 1, uPeak: vup });
            }
          }
        } else if (vup > tuning.uppercutThreshold * 0.7) {
          r.uSamples += 1;
          r.uPeak = Math.max(r.uPeak, vup);
        } else r.uArmed = false;
        if (r.uArmed && r.uSamples >= 2 && r.uY0 - s.raw.y > tuning.uppercutTravelMin &&
            Math.abs(s.vx) < 0.6 * Math.abs(s.vy * aspectInv)) {
          upper = punch(hand, 'uppercut', (r.uPeak - tuning.uppercutThreshold) / tuning.uppercutThreshold,
            r.uOnset, t, x, false, r.uPeak);
        }
      } else r.uArmed = false;

      // priority: straight, then hook, then uppercut (GDD §4)
      const winner = straight ?? hook ?? upper;
      if (winner) out.push(commit(r, winner, t));

      r.lastRate = rate;
      r.wasSeen = true;
      r.wasFist = true;
    }
    updateGuard(tracker, upd, profile);
    return out;
  }

  function inZone(tracker, hand, t, profile) {
    const s = tracker.slots[hand];
    const r = rec[hand];
    if (!s.seenNow || !s.fist || r.sArmed || r.hArmed || r.uArmed || t < r.lockoutUntil - EPS) return false;
    const c = profile.hands[hand].center;
    const d = Math.hypot((s.dispX - c.x) * tracker.aspect, s.dispY - c.y); // frame heights
    if (d > tuning.guardRadius) return false;
    const kr = s.raw.k / profile.hands[hand].kGuard;
    return kr >= tuning.guardRatioBand[0] && kr <= tuning.guardRatioBand[1];
  }

  function updateGuard(tracker, { t, seen }, profile) {
    guard.lastResultT = t;
    const l = inZone(tracker, 'left', t, profile);
    const r = inZone(tracker, 'right', t, profile);
    let raw = l && r;
    if (raw) guard.lastRawT = t;
    else if (!seen.left && !seen.right && t - guard.lastRawT <= tuning.guardGraceMs / 1000 + EPS) {
      raw = true; // both hands lost inside the guard zone: grace (D3)
    }
    guard.raw = raw;
    guard.left = l || (raw && !seen.left);
    guard.right = r || (raw && !seen.right);
    if (raw) {
      guard.outSince = null;
      if (guard.inSince === null) guard.inSince = t;
      if (guard.level === 'none' && t - guard.inSince >= tuning.guardOnMs / 1000 - EPS) {
        guard.level = 'full';
        guard.since = t;
      }
    } else {
      guard.inSince = null;
      if (guard.outSince === null) guard.outSince = t;
      if (guard.level === 'full' && t - guard.outSince >= tuning.guardOffMs / 1000 - EPS) {
        guard.level = 'none';
        guard.since = t;
      }
    }
  }

  return {
    update,
    straightThreshold,
    /** Guard at time t (between results): no results for longer than the grace drops it. */
    guardAt(t) {
      if (t - guard.lastResultT > tuning.guardGraceMs / 1000 + EPS) {
        return { level: 'none', raw: false, left: false, right: false, since: guard.since };
      }
      return { level: guard.level, raw: guard.raw, left: guard.left, right: guard.right, since: guard.since };
    },
    punchPhase(hand, t) {
      const r = rec[hand];
      if (r.sArmed || r.hArmed || r.uArmed) return 'onset';
      if (t - r.lastCommit < tuning.refractoryMs / 1000 - EPS) return 'refractory';
      return 'idle';
    },
    inGuardZone(hand) {
      return guard[hand];
    },
    debug() {
      return structuredClone({ rec, guard });
    },
  };
}
