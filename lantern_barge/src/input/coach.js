// input/coach.js — D14 training feedback: near_miss events and the live per-hand meter (game-design §15.2–15.3).
// Owner: PD. It only OBSERVES the tracker and the recognizer after each result; it never changes a threshold, an
// arming rule or a commit (D14). The pipeline runs it only while training is on, or with ?debug=1.
//
// A "motion episode" starts when a hand's signal for any enabled classifier reaches nearMissStart (0.5) × its
// threshold, and ends when every signal falls below nearMissEnd (0.35) × threshold or the hand is lost. An episode
// that ends without a commit from that hand is judged once: the move it most looked like (largest signal/threshold)
// and the first gate it failed. The guard has its own check: both fists up near the guard, this one failing one
// guard gate for nearMissGuardMs. Every near_miss is debounced per hand (nearMissDebounceMs, 400 ms).

import { HANDS } from '../shared/constants.js';

const EPS = 1e-9;

export function createCoach({ tuning }) {
  const st = { left: fresh(), right: fresh() };
  function fresh() {
    return { ep: null, settle: false, lastEmit: -Infinity, guardFailSince: null, guardReason: null, lastCommit: null };
  }

  const enabled = () => ({
    straight: true,
    hook: true,
    uppercut: !!tuning.enableUppercut,
    parry: !!tuning.enableParry,
  });

  /** Per-hand signals in their classifier's units, and their thresholds. */
  function signals(tracker, recognizer, profile, hand) {
    const s = tracker.slots[hand];
    const dir = hand === 'left' ? 1 : -1; // + = toward the midline
    const vin = s.vx * dir;
    return {
      straight: { value: s.rate, threshold: recognizer.straightThreshold(profile, hand) },
      hook: { value: vin, threshold: tuning.hookThreshold },
      uppercut: { value: -s.vy, threshold: tuning.uppercutThreshold },
      parry: { value: -vin, threshold: tuning.parryThreshold },
      // a hook gesture moving the wrong way (outward) when there's no parry to call it
      hookOut: { value: -vin, threshold: tuning.hookThreshold },
    };
  }

  function guardCheck(tracker, profile, hand) {
    const s = tracker.slots[hand];
    if (!s.seenNow) return { reason: 'out_of_frame', value: null, threshold: null, dist: Infinity };
    const c = profile.hands[hand].center;
    const dist = Math.hypot((s.dispX - c.x) * tracker.aspect, s.dispY - c.y);
    const kr = s.raw.k / profile.hands[hand].kGuard;
    const [lo, hi] = tuning.guardRatioBand;
    if (!s.fist) return { reason: 'fist_open', value: null, threshold: null, dist };
    if (dist > tuning.guardRadius) return { reason: 'hand_out_of_zone', value: dist, threshold: tuning.guardRadius, dist };
    if (kr > hi) return { reason: 'too_close', value: kr, threshold: hi, dist };
    if (kr < lo) return { reason: 'too_far', value: kr, threshold: lo, dist };
    return { reason: null, value: null, threshold: null, dist };
  }

  function nearMiss(hand, t, kind, reason, value = null, threshold = null) {
    const h = st[hand];
    if (t - h.lastEmit < tuning.nearMissDebounceMs / 1000 - EPS) return null;
    h.lastEmit = t;
    const r4 = (v) => (v === null || !Number.isFinite(v) ? null : Math.round(v * 10000) / 10000);
    return { type: 'near_miss', t, tCommit: t, hand, kind, reason, value: r4(value), threshold: r4(threshold) };
  }

  // The way back from a committed punch is not an attempt: a hook returns outward (parry-like), so after a hook
  // commit, outward kinds are ignored for RETURN_S.
  const RETURN_KINDS = { hook: ['parry', 'hookOut'] };
  const RETURN_S = 0.6;

  /** Judge an episode that ended without a commit: the first failed gate of the move it most looked like. */
  function judge(ep, hand, t, recognizer, profile) {
    const en = enabled();
    let kind = null;
    let best = 0;
    for (const k of ['straight', 'hook', 'uppercut', 'parry', 'hookOut']) {
      if (k === 'uppercut' && !en.uppercut) continue;
      if (k === 'parry' && !en.parry) continue;
      if (k === 'hookOut' && en.parry) continue;
      const n = ep.peak[k] / ep.thr[k];
      if (n > best) {
        best = n;
        kind = k;
      }
    }
    if (!kind || best < tuning.nearMissStart - EPS) return null;
    const lc = st[hand].lastCommit;
    if (lc && RETURN_KINDS[lc.kind]?.includes(kind) && ep.t0 - lc.t < RETURN_S) return null;
    // a depth-rate blip from landmark noise is not an attempt: a straight attempt must hold the rate for 2 results and
    // actually come closer, past half of the extension gate (k/kGuard 1.075 with straightRatioMin 1.15)
    // (k averaged over the last 3 results: landmark noise moves single samples by several %)
    if (kind === 'straight' && (ep.halfSamples < 2 || (!ep.lost && ep.peakKRatio3 < 1 + (tuning.straightRatioMin - 1) * 0.5 - EPS))) return null;
    if (kind === 'hookOut') return nearMiss(hand, t, 'hook', 'wrong_direction', ep.peak.hookOut, ep.thr.hookOut);
    if (ep.lost) return nearMiss(hand, t, kind, 'out_of_frame');
    if (ep.opened) return nearMiss(hand, t, kind, 'fist_open');
    if (ep.lockedMs !== null) return nearMiss(hand, t, kind, 'locked_out', ep.lockedMs, tuning.refractoryMs);
    if (best < 1 - EPS) return nearMiss(hand, t, kind, 'too_slow', ep.peak[kind], ep.thr[kind]);
    const gy = profile.hands[hand].center.y;
    const other = recognizer.peek(hand === 'left' ? 'right' : 'left');
    if (kind === 'straight') {
      if (ep.peakKRatio <= tuning.straightRatioMin + EPS) return nearMiss(hand, t, kind, 'not_extended', ep.peakKRatio, tuning.straightRatioMin);
      if (ep.fastScreenSpeed >= tuning.straightScreenSpeedMax - EPS) return nearMiss(hand, t, kind, 'too_sideways', ep.fastScreenSpeed, tuning.straightScreenSpeedMax);
      return nearMiss(hand, t, kind, 'too_short', ep.overMs, tuning.straightMinMs);
    }
    if (kind === 'hook') {
      if (ep.hookVy >= tuning.hookVyRatio - EPS) return nearMiss(hand, t, kind, 'too_vertical', ep.hookVy, tuning.hookVyRatio);
      if (ep.travelIn <= tuning.hookTravelMin + EPS) return nearMiss(hand, t, kind, 'too_short', ep.travelIn, tuning.hookTravelMin);
      return null; // started outside the guard: no single plain-words reason
    }
    if (kind === 'uppercut') {
      const below = ep.pocketY - gy;
      if (below < tuning.uppercutPocketMin - EPS) return nearMiss(hand, t, kind, 'not_in_pocket', below, tuning.uppercutPocketMin);
      if (below > tuning.uppercutPocketMax + EPS) return nearMiss(hand, t, kind, 'not_in_pocket', below, tuning.uppercutPocketMax);
      if (twoHand(other.riseTimes, ep.t0, tuning.uppercutTwoHandRejectMs)) return nearMiss(hand, t, kind, 'both_hands');
      if (ep.upVx >= tuning.uppercutVxRatio - EPS) return nearMiss(hand, t, kind, 'too_sideways', ep.upVx, tuning.uppercutVxRatio);
      return nearMiss(hand, t, kind, 'too_short', ep.pocketY - ep.minY, tuning.uppercutTravelMin);
    }
    if (kind === 'parry') {
      if (twoHand(other.outTimes, ep.t0, tuning.parryTwoHandRejectMs)) return nearMiss(hand, t, kind, 'both_hands');
      if (ep.parryVy >= tuning.parryVyRatio - EPS) return nearMiss(hand, t, kind, 'too_vertical', ep.parryVy, tuning.parryVyRatio);
      return nearMiss(hand, t, kind, 'too_short', ep.travelOut, tuning.parryTravelMin);
    }
    return null;
  }

  const twoHand = (times, t0, ms) => times.some((x) => Math.abs(x - t0) <= ms / 1000 + 0.05);

  /**
   * After recognizer.update on the same result.
   * @param {object[]} committed   this result's recognizer output (punches and parries)
   * @returns {object[]} near_miss events
   */
  function update(tracker, recognizer, profile, { t, seen }, committed) {
    const out = [];
    const aspectInv = 1 / tracker.aspect;
    const fistsUp = HANDS.every((h) => tracker.slots[h].seenNow && tracker.slots[h].fist);
    const guardChecks = { left: guardCheck(tracker, profile, 'left'), right: guardCheck(tracker, profile, 'right') };
    for (const hand of HANDS) {
      const h = st[hand];
      const s = tracker.slots[hand];
      const mine = committed.filter((e) => e.hand === hand);

      // body line: a straight/hook that dropped at least half way but committed to the head (D12 body lesson)
      if (tuning.enableBody) {
        for (const p of mine) {
          if (p.type !== 'punch' || p.punchType === 'uppercut' || p.target === 'body') continue;
          const drop = s.raw.y - profile.hands[hand].center.y;
          if (drop >= tuning.bodyBelowGuard * 0.5 - EPS) {
            const e = nearMiss(hand, t, 'body', 'not_low', drop, tuning.bodyBelowGuard);
            if (e) out.push(e);
          }
        }
      }

      // ── motion episodes
      for (const p of mine) h.lastCommit = { kind: p.type === 'punch' ? p.punchType : p.type, t };
      if (mine.length && h.ep) {
        h.ep = null; // it committed: the game judges it (right move or wrong move)
        h.settle = true;
      } else if (mine.length) h.settle = true;
      if (!seen[hand]) {
        if (h.ep && !h.settle) {
          h.ep.lost = true;
          const e = judge(h.ep, hand, t, recognizer, profile);
          if (e) out.push(e);
        }
        h.ep = null;
        h.settle = false;
        h.guardFailSince = null;
        continue;
      }
      const sig = signals(tracker, recognizer, profile, hand);
      const en = enabled();
      const norm = (k) => sig[k].value / sig[k].threshold;
      const active = ['straight', 'hook', ...(en.uppercut ? ['uppercut'] : []), ...(en.parry ? ['parry'] : ['hookOut'])];
      const top = Math.max(...active.map(norm));
      if (h.settle) {
        if (top < tuning.nearMissEnd) h.settle = false; // the committed motion has died down
      } else if (!h.ep && top >= tuning.nearMissStart - EPS) {
        const prev = s.hist.length >= 2 ? s.hist[s.hist.length - 2] : s.hist[s.hist.length - 1];
        let pocketY = prev.y; // lowest point just before the episode (uppercut pocket)
        for (const p of s.hist) if (p.t >= t - tuning.uppercutLookbackMs / 1000 - EPS && p.y > pocketY) pocketY = p.y;
        const r = recognizer.peek(hand);
        const sinceCommit = t - r.lastCommit;
        h.ep = {
          t0: prev.t, x0: prev.x, pocketY, minY: s.raw.y, halfSamples: 0, peakKRatio3: 0,
          peak: { straight: 0, hook: 0, uppercut: 0, parry: 0, hookOut: 0 },
          thr: Object.fromEntries(Object.keys(sig).map((k) => [k, sig[k].threshold])),
          peakKRatio: 0, fastScreenSpeed: 0, overMs: 0, overSince: null, travelIn: 0, travelOut: 0,
          hookVy: 0, parryVy: 0, upVx: 0, opened: false, lost: false,
          lockedMs: sinceCommit < tuning.refractoryMs / 1000 - EPS ? sinceCommit * 1000 : null,
        };
      }
      const ep = h.ep;
      if (ep) {
        for (const k of Object.keys(ep.peak)) ep.peak[k] = Math.max(ep.peak[k], sig[k].value);
        if (!s.fist) ep.opened = true;
        const kr = s.raw.k / profile.hands[hand].kGuard;
        ep.peakKRatio = Math.max(ep.peakKRatio, kr);
        if (norm('straight') >= tuning.nearMissStart - EPS) ep.halfSamples += 1;
        const last3 = s.hist.slice(-3);
        const k3 = Math.exp(last3.reduce((a, p) => a + p.lnk, 0) / last3.length);
        ep.peakKRatio3 = Math.max(ep.peakKRatio3, k3 / profile.hands[hand].kGuard);
        const speed = Math.hypot(s.vx, s.vy * aspectInv);
        if (norm('straight') >= 1) {
          ep.fastScreenSpeed = Math.max(ep.fastScreenSpeed, speed);
          if (ep.overSince === null) ep.overSince = s.hist.length >= 2 ? s.hist[s.hist.length - 2].t : t;
          ep.overMs = Math.max(ep.overMs, (t - ep.overSince) * 1000);
        } else ep.overSince = null;
        const dir = hand === 'left' ? 1 : -1;
        ep.travelIn = Math.max(ep.travelIn, (s.raw.x - ep.x0) * dir);
        ep.travelOut = Math.max(ep.travelOut, (ep.x0 - s.raw.x) * dir);
        ep.minY = Math.min(ep.minY, s.raw.y);
        const ax = Math.abs(s.vx);
        const ay = Math.abs(s.vy * aspectInv);
        if (norm('hook') >= 1) ep.hookVy = Math.max(ep.hookVy, ax > EPS ? ay / ax : Infinity);
        if (en.parry && norm('parry') >= 1) ep.parryVy = Math.max(ep.parryVy, ax > EPS ? ay / ax : Infinity);
        if (en.uppercut && norm('uppercut') >= 1) {
          const vy = Math.abs(s.vy);
          ep.upVx = Math.max(ep.upVx, vy > EPS ? Math.abs(s.vx * tracker.aspect) / vy : Infinity);
        }
        if (top < tuning.nearMissEnd || t - ep.t0 > 1.0) {
          const e = judge(ep, hand, t, recognizer, profile);
          if (e) out.push(e);
          h.ep = null;
          if (top >= tuning.nearMissEnd) h.settle = true; // a 1 s episode: wait for the motion to stop
        }
      }

      // ── guard: both fists up near the guard, this one failing one guard gate for nearMissGuardMs
      const g = guardChecks[hand];
      const near = fistsUp && HANDS.every((x) => guardChecks[x].dist <= tuning.guardRadius * 2);
      if (!h.ep && !h.settle && near && g.reason && g.reason !== 'fist_open') {
        if (h.guardReason !== g.reason) {
          h.guardReason = g.reason;
          h.guardFailSince = t;
        } else if (h.guardFailSince !== null && t - h.guardFailSince >= tuning.nearMissGuardMs / 1000 - EPS) {
          const e = nearMiss(hand, t, 'guard', g.reason, g.value, g.threshold);
          if (e) {
            out.push(e);
            h.guardFailSince = t; // again after another full period, if it persists
          }
        }
      } else {
        h.guardReason = null;
        h.guardFailSince = null;
      }
    }
    return out;
  }

  /** frame.meter for the camera/replay sources (types.js InputMeter). */
  function meter(tracker, recognizer, profile) {
    const out = { kind: 'camera' };
    for (const hand of HANDS) {
      const s = tracker.slots[hand];
      const sig = signals(tracker, recognizer, profile, hand);
      const zero = (k) => ({ value: s.seenNow ? sig[k].value : 0, threshold: sig[k].threshold });
      const g = guardCheck(tracker, profile, hand);
      out[hand] = {
        straight: zero('straight'),
        hook: zero('hook'),
        uppercut: tuning.enableUppercut ? zero('uppercut') : null,
        parry: tuning.enableParry ? zero('parry') : null,
        body: tuning.enableBody
          ? { value: s.seenNow ? s.raw.y - profile.hands[hand].center.y : 0, threshold: tuning.bodyBelowGuard }
          : null,
        guard: { inZone: recognizer.inGuardZone(hand), reason: g.reason },
      };
    }
    return out;
  }

  return {
    update,
    meter,
    reset() {
      st.left = fresh();
      st.right = fresh();
    },
  };
}
