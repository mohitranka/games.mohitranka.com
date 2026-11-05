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
    riseTimes: [], // D11 two-hand reject: result times when this fist was rising faster than 0.7 × threshold
    pArmed: false, pOnset: 0, pX0: 0, pSamples: 0, lastParry: -Infinity, // D12 parry
    zoneLastT: -Infinity, // D3a: last result time this hand was seen in the guard zone
    outTimes: [], // D12 two-hand reject: result times when this fist was swiping outward faster than 0.7 × threshold
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
      target: 'head', // D12: set to 'body' at commit from the palm height (enableBody)
      aim: { x: aimX }, tOnset, tCommit, inferred, peak,
    };
  }

  function commit(r, ev, t) {
    r.lastCommit = t;
    if (tuning.guardParity) {
      // P1a/P1b: the hand counts toward guard again only at onset + guardReturnMs (550 ms after an uppercut)
      const back = ev.punchType === 'uppercut' ? tuning.uppercutGuardReturnMs : tuning.guardReturnMs;
      r.lockoutUntil = ev.tOnset + back / 1000;
    } else {
      const lockMs = ev.punchType === 'uppercut' ? tuning.uppercutGuardLockoutMs : tuning.guardLockoutMs; // D11
      r.lockoutUntil = t + lockMs / 1000;
    }
    disarm(r);
    return ev;
  }

  /**
   * @param {ReturnType<import('./hand-tracker.js').createHandTracker>} tracker
   * @param {{t:number, seen:{left:boolean,right:boolean}}} upd
   * @param {import('../shared/types.js').CalibrationProfile} profile
   * @returns {object[]} punch events (with an extra `peak` field used by calibration) and D12 parry events
   */
  function update(tracker, upd, profile) {
    const { t, seen } = upd;
    const out = [];
    const aspectInv = 1 / tracker.aspect; // H/W: frame heights → frame widths
    // D11 two-hand reject needs both hands' rising samples for this result before either hand is classified
    for (const hand of HANDS) {
      const s = tracker.slots[hand];
      const r = rec[hand];
      if (seen[hand] && s.fist && -s.vy > tuning.uppercutThreshold * tuning.uppercutTwoHandFactor) r.riseTimes.push(t);
      while (r.riseTimes.length && r.riseTimes[0] < t - 1) r.riseTimes.shift();
      const outward = (hand === 'left' ? -1 : 1) * s.vx; // away from the midline
      if (seen[hand] && s.fist && outward > tuning.parryThreshold * tuning.parryTwoHandFactor) r.outTimes.push(t);
      while (r.outTimes.length && r.outTimes[0] < t - 1) r.outTimes.shift();
    }
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

      // ── uppercut (D11): up through the gap, from the pocket below guard, still fast at guard height
      let upper = null;
      if (tuning.enableUppercut && !refractory) {
        const vup = -s.vy; // frame heights/s, + = up
        const gy = profile.hands[hand].center.y;
        const thr = tuning.uppercutThreshold;
        if (!r.uArmed) {
          const onset = prev.t;
          const tracked = onset - s.firstSeen >= tuning.uppercutTrackedMs / 1000 - EPS;
          const returnOk = onset - r.lastCommit >= tuning.uppercutReturnLockoutMs / 1000 - EPS; // not the pull-back
          if (vup > thr && tracked && returnOk) {
            let y0 = prev.y; // the pocket: lowest point (largest y) in the lookback window before onset
            for (const h of s.hist) {
              if (h.t >= onset - tuning.uppercutLookbackMs / 1000 - EPS && h.t <= onset + EPS && h.y > y0) y0 = h.y;
            }
            const below = y0 - gy;
            if (below >= tuning.uppercutPocketMin - EPS && below <= tuning.uppercutPocketMax + EPS) {
              Object.assign(r, { uArmed: true, uOnset: onset, uY0: y0, uSamples: 1, uPeak: vup });
            }
          }
        } else if (vup > thr * tuning.uppercutSustainFactor) {
          if (vup > thr) r.uSamples += 1;
          r.uPeak = Math.max(r.uPeak, vup);
        } else r.uArmed = false;
        if (r.uArmed && vup > thr && t - r.uOnset >= tuning.uppercutMinMs / 1000 - EPS &&
            r.uSamples >= tuning.uppercutMinSamples && r.uY0 - s.raw.y > tuning.uppercutTravelMin &&
            s.raw.y <= gy + tuning.uppercutCommitAboveGuard && // still rising fast at guard height (a guard raise slows)
            Math.abs(s.vx * tracker.aspect) < tuning.uppercutVxRatio * Math.abs(s.vy)) {
          const other = rec[hand === 'left' ? 'right' : 'left'];
          const lo = r.uOnset - tuning.uppercutTwoHandRejectMs / 1000 - EPS;
          const hi = r.uOnset + tuning.uppercutTwoHandRejectMs / 1000 + EPS;
          if (other.riseTimes.some((rt) => rt >= lo && rt <= hi)) {
            r.uArmed = false; // both fists rising together: a guard raise, not a punch (neither commits)
            other.uArmed = false;
          } else {
            upper = punch(hand, 'uppercut', (r.uPeak - thr) / (tuning.uppercutRateFull - thr), r.uOnset, t, x, false, r.uPeak);
          }
        }
      } else r.uArmed = false;

      // ── parry (D12): a closed fist swiping OUTWARD from inside the guard zone. Hooks go inward, so they never collide.
      if (tuning.enableParry && t - r.lastParry >= tuning.parryRefractoryMs / 1000 - EPS) {
        const dirOut = hand === 'left' ? -1 : 1;
        const vout = s.vx * dirOut;
        const c = profile.hands[hand].center;
        if (!r.pArmed) {
          const inZone = Math.hypot((prev.x - c.x) * tracker.aspect, prev.y - c.y) <= tuning.guardRadius;
          if (vout > tuning.parryThreshold && inZone) Object.assign(r, { pArmed: true, pOnset: prev.t, pX0: prev.x, pSamples: 1 });
        } else if (vout > tuning.parryThreshold * tuning.parrySustainFactor) {
          if (vout > tuning.parryThreshold) r.pSamples += 1;
        } else r.pArmed = false;
        if (r.pArmed && t - r.pOnset >= tuning.parryMinMs / 1000 - EPS && r.pSamples >= tuning.parryMinSamples &&
            (x - r.pX0) * dirOut > tuning.parryTravelMin && Math.abs(s.vy * aspectInv) < tuning.parryVyRatio * Math.abs(s.vx)) {
          const other = rec[hand === 'left' ? 'right' : 'left'];
          const lo = r.pOnset - tuning.parryTwoHandRejectMs / 1000 - EPS;
          const hi = r.pOnset + tuning.parryTwoHandRejectMs / 1000 + EPS;
          if (other.outTimes.some((ot) => ot >= lo && ot <= hi)) {
            r.pArmed = false; // both fists swiping out together: spreading the guard (neither parries)
            other.pArmed = false;
          } else {
            out.push({ type: 'parry', id: nextId++, hand, tOnset: r.pOnset, tCommit: t });
            r.pArmed = false;
            r.lastParry = t;
          }
        }
      } else r.pArmed = false;

      // priority (D11): uppercut, then straight, then hook
      const winner = upper ?? straight ?? hook;
      if (upper) r.sArmed = r.hArmed = false;
      if (winner && winner.punchType !== 'uppercut' && tuning.enableBody &&
          s.raw.y - profile.hands[hand].center.y >= tuning.bodyBelowGuard - EPS) {
        winner.target = 'body'; // D12: straight or hook committed with the palm ≥ 0.12 fh below guard y
      }
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
    if (r.sArmed || r.hArmed || r.uArmed || t < r.lockoutUntil - EPS) {
      r.zoneLastT = -Infinity; // punching: no grace carries over
      return false;
    }
    if (!s.seenNow) {
      // D3a per-hand grace: a hand lost while in the zone keeps counting for up to guardGraceMs (300 ms)
      return t - r.zoneLastT <= tuning.guardGraceMs / 1000 + EPS;
    }
    const c = profile.hands[hand].center;
    const d = Math.hypot((s.dispX - c.x) * tracker.aspect, s.dispY - c.y); // frame heights
    const kr = s.raw.k / profile.hands[hand].kGuard;
    const ok = s.fist && d <= tuning.guardRadius && kr >= tuning.guardRatioBand[0] && kr <= tuning.guardRatioBand[1];
    r.zoneLastT = ok ? t : -Infinity;
    return ok;
  }

  function updateGuard(tracker, { t }, profile) {
    guard.lastResultT = t;
    const l = inZone(tracker, 'left', t, profile);
    const r = inZone(tracker, 'right', t, profile);
    const raw = l && r; // D3a: each hand carries its own 300 ms grace (replaces D3's "both lost" rule)
    if (raw) guard.lastRawT = t;
    guard.raw = raw;
    guard.left = l;
    guard.right = r;
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
