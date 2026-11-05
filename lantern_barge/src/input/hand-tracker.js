// input/hand-tracker.js — two fixed slots (player's left / right hand), fist hysteresis, raw-sample rates,
// display filtering, prediction and loss grace (architecture §6.3). Owner: PD.
// Input: a detection result {t (sim s), w, h, hands:[{lm, world, label, score}]} with array landmarks.

import { depthScale, weakPerspectiveLnS, palmCenter, openness } from './features.js';
import { slope, createOneEuro } from './filters.js';
import { createHandState } from '../shared/fixtures.js';

const HISTORY_S = 0.6; // raw sample history kept per slot
const RECENT_S = 0.5; // a slot seen this recently is matched by position
const REFIT_GAP_S = 0.15;
const AMBIGUOUS = 0.12; // frame units: position costs closer than this are treated as a tie // a longer gap restarts the rate history (a jump is not motion)

function createSlot(hand) {
  return {
    hand,
    lastSeen: -Infinity,
    firstSeen: -Infinity,
    seenNow: false,
    gap: 1 / 30, // typical time between results (EMA)
    hist: [], // {t, lnk, x, y}
    raw: null, // {lm, world, k, lnk, lnS, x, y, open, label, score}
    rate: 0,
    vx: 0,
    vy: 0,
    fist: false,
    fistPendingSince: null,
    open: 1,
    labelAgree: 0, // EMA of +1 (MediaPipe label agrees with this slot) / −1
    fOpen: createOneEuro({ minCutoff: 3, beta: 0.5 }),
    fX: createOneEuro({ minCutoff: 1.5, beta: 3 }),
    fY: createOneEuro({ minCutoff: 1.5, beta: 3 }),
    dispX: 0.5,
    dispY: 0.5,
  };
}

/**
 * @param {{tuning: object}} opts  input tuning (read at use time)
 */
export function createHandTracker({ tuning }) {
  const slots = { left: createSlot('left'), right: createSlot('right') };
  let lastResultT = -Infinity;
  let W = 16;
  let H = 9;

  const labelHand = (label) => {
    if (!label) return null;
    const h = String(label).toLowerCase().startsWith('l') ? 'left' : 'right';
    return tuning.handednessFlip ? (h === 'left' ? 'right' : 'left') : h;
  };

  function predictedPos(slot, t) {
    const dt = Math.min(Math.max(0, t - slot.lastSeen), tuning.predictMaxMs / 1000, slot.gap * 1.5);
    return [slot.dispX + slot.vx * dt, slot.dispY + slot.vy * dt];
  }

  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

  /** Assign up to two detections (with .c = mirrored center) to slots. Returns Map(slot → det). */
  function assign(dets, t) {
    const out = new Map();
    const recent = (s) => t - s.lastSeen <= RECENT_S;
    const L = slots.left;
    const R = slots.right;
    if (dets.length >= 2) {
      const [a, b] = dets;
      if (recent(L) && recent(R)) {
        const pl = predictedPos(L, t);
        const pr = predictedPos(R, t);
        const keep = dist(a.c, pl) + dist(b.c, pr);
        const swap = dist(a.c, pr) + dist(b.c, pl);
        let useKeep = keep <= swap;
        // ambiguous (fists close together, e.g. a hook passing the other fist): anatomy decides — the
        // player's left fist is the one further left on the mirrored screen
        if (Math.abs(keep - swap) < AMBIGUOUS) useKeep = a.c[0] <= b.c[0];
        out.set(L, useKeep ? a : b);
        out.set(R, useKeep ? b : a);
      } else {
        const [l, r] = a.c[0] <= b.c[0] ? [a, b] : [b, a];
        out.set(L, l);
        out.set(R, r);
      }
      return out;
    }
    if (dets.length === 1) {
      const d = dets[0];
      const cands = [L, R].filter(recent);
      if (cands.length === 2) {
        const dl = dist(d.c, predictedPos(L, t));
        const dr = dist(d.c, predictedPos(R, t));
        out.set(dl <= dr ? L : R, d);
      } else if (cands.length === 1 && dist(d.c, predictedPos(cands[0], t)) < 0.2) {
        out.set(cands[0], d);
      } else {
        // No position history: screen side decides. MediaPipe labels are only tracked (labelAgree) until
        // the day-1 check (manual-checks MC-1) shows whether they can be trusted on this input.
        out.set(d.c[0] < 0.5 ? L : R, d);
      }
    }
    return out;
  }

  function updateSlot(slot, d, t) {
    const gapSince = t - slot.lastSeen;
    if (gapSince > REFIT_GAP_S) {
      slot.hist.length = 0;
      slot.fX.reset();
      slot.fY.reset();
      slot.firstSeen = t;
    } else if (gapSince > 1e-6) {
      slot.gap += 0.2 * (Math.min(gapSince, 0.25) - slot.gap);
    }
    slot.lastSeen = t;
    slot.seenNow = true;

    const k = depthScale(d.lm, W, H);
    const lnk = Math.log(Math.max(k, 1e-6));
    const [x, y] = d.c;
    const open = d.world ? openness(d.world) : 1;
    slot.raw = {
      lm: d.lm, world: d.world, k, lnk, lnS: weakPerspectiveLnS(d.lm, d.world, W, H),
      x, y, open, label: d.label ?? '', score: d.score ?? 1,
    };
    const lbl = labelHand(d.label);
    if (lbl) slot.labelAgree += 0.1 * ((lbl === slot.hand ? 1 : -1) - slot.labelAgree);

    slot.hist.push({ t, lnk, x, y });
    while (slot.hist.length && slot.hist[0].t < t - HISTORY_S) slot.hist.shift();
    const win = slot.hist.filter((s) => s.t >= t - tuning.rateWindowMs / 1000 - 1e-9);
    slot.rate = slope(win, 'lnk');
    slot.vx = slope(win, 'x');
    slot.vy = slope(win, 'y');

    // fist: hysteresis + debounce on filtered openness (D2). Verbs read only slot.fist.
    slot.open = slot.fOpen.filter(open, t);
    if (gapSince > REFIT_GAP_S) {
      slot.fist = open < tuning.fistCloseBelow;
      slot.fistPendingSince = null;
    } else {
      const want = slot.fist ? slot.open < tuning.fistOpenAbove : slot.open < tuning.fistCloseBelow;
      if (want !== slot.fist) {
        if (slot.fistPendingSince === null) slot.fistPendingSince = t;
        if (t - slot.fistPendingSince >= tuning.fistDebounceMs / 1000 - 1e-9) {
          slot.fist = want;
          slot.fistPendingSince = null;
        }
      } else slot.fistPendingSince = null;
    }

    slot.dispX = slot.fX.filter(x, t);
    slot.dispY = slot.fY.filter(y, t);
  }

  return {
    slots,
    get lastResultT() {
      return lastResultT;
    },
    get aspect() {
      return W / H;
    },

    /**
     * @param {{t:number, w:number, h:number, hands:Array<{lm:number[][], world:number[][]|null, label?:string, score?:number}>}} result
     */
    update(result) {
      const t = result.t;
      if (result.w && result.h) {
        W = result.w;
        H = result.h;
      }
      lastResultT = t;
      for (const s of Object.values(slots)) s.seenNow = false;
      const dets = (result.hands ?? [])
        .filter((d) => d && d.lm && d.lm.length >= 21)
        .sort((a, b) => (b.score ?? 1) - (a.score ?? 1))
        .slice(0, 2)
        .map((d) => ({ ...d, c: palmCenter(d.lm) }));
      for (const [slot, d] of assign(dets, t)) updateSlot(slot, d, t);
      return { t, seen: { left: slots.left.seenNow, right: slots.right.seenNow } };
    },

    present(hand, t) {
      return t - slots[hand].lastSeen <= tuning.lossGraceMs / 1000 + 1e-9;
    },

    /** HandState for a frame at time t (display position predicted to t). */
    handState(hand, t, profile) {
      const s = slots[hand];
      const hs = createHandState();
      if (!s.raw) return hs;
      const present = this.present(hand, t);
      const since = Math.max(0, t - s.lastSeen);
      const dt = Math.min(since, tuning.predictMaxMs / 1000, s.gap * 1.5);
      const kGuard = profile?.hands?.[hand]?.kGuard;
      const kRatio = kGuard ? s.raw.k / kGuard : NaN;
      const ext = Number.isFinite(kRatio)
        ? Math.max(-0.5, Math.min(1.5, Math.log(kRatio) / Math.log(tuning.extFullRatio)))
        : 0;
      Object.assign(hs, {
        present,
        predicted: since > 1e-6,
        fist: present && s.fist,
        openness: s.open,
        x: present ? s.dispX + s.vx * dt : s.dispX,
        y: present ? s.dispY + s.vy * dt : s.dispY,
        vx: s.vx,
        vy: s.vy,
        k: s.raw.k,
        kRatio,
        rate: s.rate,
        ext,
      });
      return hs;
    },
  };
}
