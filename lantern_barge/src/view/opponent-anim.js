// view/opponent-anim.js — Tamsin's poses from (state, attack, side, stage progress) (owner: TA).
// Pure functions of the read-only GameState plus the presentation time; no state is mutated.
// Coordinates are her BASE space: +z toward the player, her left = +x, y up, metres.
//
// Telegraph readability (GDD §6): each attack has its own silhouette within the first ~150 ms of the wind-up,
// then holds it (with a building glow) until the throw, which only takes the last ≤ 160 ms before contact.
//   rope_snap    lead (left) shoulder dips, lead glove drawn low and back, white glint
//   swing_bridge striking arm swings wide and back, torso twisted away, amber glow
//   anchor_drop  right arm cocked high overhead, rises and leans back, red glow (plus the foghorn in audio)

import { tuning } from './tuning.js';

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const lerp = (a, b, t) => a + (b - a) * t;
const easeOut = (t) => 1 - (1 - t) ** 3;
const easeIn = (t) => t * t * t;
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const smooth = (t) => t * t * (3 - 2 * t);

const NO_GLOW = Object.freeze({ color: 0xffffff, amount: 0, pop: 0 });

/** The rest pose: high guard, orthodox stance (left foot forward). */
export function neutralPose() {
  return {
    x: 0, y: 0, z: 0, yaw: 0, fall: 0,
    hipY: 0.93, lean: 0.06, twist: 0.12, roll: 0,
    headPitch: 0.08, headYaw: 0, headRoll: 0,
    lHand: [0.12, 1.5, 0.3], rHand: [-0.12, 1.52, 0.24],
    lPole: [0.7, -1, -0.2], rPole: [-0.7, -1, -0.2],
    lFoot: [0.17, 0.06, 0.14], rFoot: [-0.18, 0.06, -0.14],
    lGlow: NO_GLOW, rGlow: NO_GLOW,
    mitts: false, shimmer: 0,
  };
}

const NUM_KEYS = ['x', 'y', 'z', 'yaw', 'fall', 'hipY', 'lean', 'twist', 'roll', 'headPitch', 'headYaw', 'headRoll'];
const VEC_KEYS = ['lHand', 'rHand', 'lPole', 'rPole', 'lFoot', 'rFoot'];

export function lerpPose(a, b, t) {
  const o = { ...a };
  for (const k of NUM_KEYS) o[k] = lerp(a[k], b[k], t);
  for (const k of VEC_KEYS) o[k] = [lerp(a[k][0], b[k][0], t), lerp(a[k][1], b[k][1], t), lerp(a[k][2], b[k][2], t)];
  return o;
}

function withPose(base, patch) {
  return { ...base, ...patch };
}

/** Quadratic bezier between hand positions (arcs for hooks and the overhead). */
function arc(a, c, b, t) {
  const u = 1 - t;
  return [0, 1, 2].map((i) => u * u * a[i] + 2 * u * t * c[i] + t * t * b[i]);
}

function guardPose(guard, t) {
  const p = neutralPose();
  if (guard === 'low') {
    p.lHand = [0.2, 1.17, 0.28];
    p.rHand = [-0.2, 1.15, 0.22];
    p.headPitch = 0.0;
    p.lean = 0.02;
  } else if (guard === 'none') {
    p.lHand = [0.26, 1.08, 0.18];
    p.rHand = [-0.26, 1.06, 0.14];
    p.headPitch = -0.05;
  }
  return p;
}

/** Circle: bob, weave and drift side to side while facing the player. */
function circlePose(st, t, guard) {
  const p = guardPose(guard, t);
  const sway = 0.2 * Math.sin(t * 0.85) + 0.05 * Math.sin(t * 2.3);
  const bob = 0.5 + 0.5 * Math.sin(t * Math.PI * 2 * 1.5);
  p.x = sway;
  p.z = 0.06 * Math.sin(t * 0.6);
  p.yaw = Math.atan2(-sway, -tuning.oppZ);
  p.hipY -= 0.035 * bob;
  p.roll = 0.06 * Math.sin(t * 1.7);
  p.headRoll = -p.roll * 0.6;
  p.lHand = [p.lHand[0], p.lHand[1] - 0.02 * bob, p.lHand[2] + 0.03 * Math.sin(t * 3.1)];
  p.rHand = [p.rHand[0], p.rHand[1] - 0.02 * bob, p.rHand[2]];
  p.lFoot = [0.17 + 0.03 * Math.sin(t * 3), 0.06, 0.14];
  p.rFoot = [-0.18, 0.06, -0.14 + 0.03 * Math.sin(t * 3 + 1)];
  return p;
}

// ───────────────────────────────────────────── attacks

/** Wind-up (held) and contact poses per attack; s = +1 her left, −1 her right. */
function windupPose(attack, s, comboIndex) {
  const p = neutralPose();
  const strike = s > 0 ? 'lHand' : 'rHand';
  const other = s > 0 ? 'rHand' : 'lHand';
  const strikePole = s > 0 ? 'lPole' : 'rPole';
  if (attack === 'rope_snap') {
    if (comboIndex > 0) { // follow-up jab: a short re-load, the guard is (hopefully) already up
      p[strike] = [s * 0.17, 1.42, 0.26];
      p.twist = s * 0.18;
      return p;
    }
    p.hipY = 0.85;
    p.roll = -s * 0.24; // lead shoulder dips
    p.lean = 0.14;
    p.twist = s * 0.3;
    p.headPitch = 0.18;
    p[strike] = [s * 0.27, 1.22, 0.06];
    p[strikePole] = [s * 0.9, -0.6, -0.4];
    p[other] = [-s * 0.1, 1.5, 0.28];
  } else if (attack === 'swing_bridge') {
    p.twist = s * 0.62; // striking shoulder turned back
    p.lean = -0.04;
    p.roll = s * 0.1;
    p.x = -s * 0.04;
    p[strike] = [s * 0.64, 1.36, -0.22];
    p[strikePole] = [s * 0.3, 0.3, -1];
    p[other] = [-s * 0.08, 1.52, 0.3];
    p.headYaw = s * 0.15;
  } else { // anchor_drop
    p.hipY = 1.0; // up on her toes
    p.lean = -0.2;
    p.twist = s * 0.34;
    p.roll = s * 0.06;
    p.headPitch = -0.12;
    p[strike] = [s * 0.18, 2.18, -0.22];
    p[strikePole] = [s * 0.8, 0.5, -0.4];
    p[other] = [-s * 0.13, 1.52, 0.26]; // lead glove stays tucked at the chin (reads as a guard, not a floating fist)
    p[s > 0 ? 'rPole' : 'lPole'] = [-s * 0.8, -1, -0.2];
    p.lFoot = [0.17, 0.1, 0.14];
    p.rFoot = [-0.18, 0.1, -0.14];
  }
  return p;
}

function contactPose(attack, s) {
  const p = neutralPose();
  const strike = s > 0 ? 'lHand' : 'rHand';
  const strikePole = s > 0 ? 'lPole' : 'rPole';
  const other = s > 0 ? 'rHand' : 'lHand';
  p[other] = [-s * 0.12, 1.5, 0.3];
  if (attack === 'rope_snap') {
    p.z = 0.5;
    p.lean = 0.24;
    p.twist = -s * 0.35;
    p[strike] = [s * 0.03, 1.66, 1.25];
    p[strikePole] = [s * 0.6, -1, 0];
  } else if (attack === 'swing_bridge') {
    p.z = 0.45;
    p.lean = 0.2;
    p.twist = -s * 0.5;
    p.roll = -s * 0.08;
    p[strike] = [s * 0.04, 1.64, 1.2];
    p[strikePole] = [s * 1, 0.4, 0];
  } else {
    p.z = 0.6;
    p.hipY = 0.84;
    p.lean = 0.42;
    p.twist = -s * 0.3;
    p.headPitch = 0.25;
    p[strike] = [0, 1.64, 1.2];
    p[strikePole] = [s * 0.6, 0.8, 0];
  }
  return p;
}

function throwControl(attack, s) {
  if (attack === 'swing_bridge') return [s * 0.78, 1.45, 0.75];
  if (attack === 'anchor_drop') return [s * 0.14, 2.35, 0.7];
  return null; // straight line
}

const GLOW_SIZE = { rope_snap: 0.55, swing_bridge: 1, anchor_drop: 1.25 };
function glowFor(attack, amount, pop) {
  return { color: tuning.attackGlow[attack] ?? 0xffffff, amount, pop, size: GLOW_SIZE[attack] ?? 1 };
}

function telegraphPose(o, tIn) {
  const s = o.side === 'right' ? -1 : 1;
  const W = Math.max(0.05, o.stageDur);
  const throwS = Math.min(tuning.throwMaxS, W * 0.3);
  const windIn = Math.min(0.15, (W - throwS) * 0.5);
  const start = o.combo?.index > 0 ? contactPose(o.attack, s) : neutralPose();
  if (o.combo?.index > 0) Object.assign(start, lerpPose(start, windupPose(o.attack, s, 1), 0.5));
  const wind = windupPose(o.attack, s, o.combo?.index ?? 0);
  const hit = contactPose(o.attack, s);
  let p;
  const tThrow = W - throwS;
  if (tIn < tThrow) {
    p = lerpPose(start, wind, easeOut(clamp01(tIn / windIn)));
    // build-up: a small tremble that grows towards the throw (Anchor Drop shakes the most)
    const build = clamp01(tIn / tThrow);
    const amp = (o.attack === 'anchor_drop' ? 0.012 : 0.005) * build;
    const key = s > 0 ? 'lHand' : 'rHand';
    p[key] = [p[key][0] + amp * Math.sin(tIn * 70), p[key][1] + amp * Math.sin(tIn * 53), p[key][2]];
  } else {
    const u = easeIn(clamp01((tIn - tThrow) / throwS));
    p = lerpPose(wind, hit, u);
    const key = s > 0 ? 'lHand' : 'rHand';
    const c = throwControl(o.attack, s);
    if (c) p[key] = arc(wind[key], c, hit[key], u);
  }
  const first = !(o.combo?.index > 0);
  const feint = o.feint === true;
  // D9 tell #1: every REAL first wind-up starts with a back-foot plant (rear = her right foot, orthodox).
  // Feints skip it. The plant lands inside the first 100 ms and the rear foot stays planted.
  if (first && !feint) {
    const plant = easeOut(clamp01(tIn / 0.08));
    const dip = Math.sin(Math.PI * clamp01(tIn / 0.14));
    p.rFoot = [p.rFoot[0] - 0.02 * plant, p.rFoot[1], p.rFoot[2] - 0.09 * plant];
    p.hipY -= 0.06 * dip; // the body settles onto the planted foot (visible even when the feet are below the gloves)
    p.lean -= 0.03 * plant;
  }
  // D9 chain cue: a combo follow-up rolls the shoulders through from the last strike into the next one.
  if (!first && o.sequence?.kind === 'combo') {
    const u = clamp01(tIn / Math.max(0.05, W - throwS));
    const roll = Math.sin(Math.PI * u);
    p.roll += -s * 0.3 * roll;
    p.twist += s * 0.25 * roll;
    p.headRoll += s * 0.12 * roll;
  }
  const amount = (first ? 0.45 + 0.55 * clamp01(tIn / Math.max(0.05, W - throwS)) : 0.5) * (feint ? 0.5 : 1); // D9 tell #2
  const pop = Math.max(0, 1 - tIn / 0.18) * (first ? 1 : 0.5) * (feint ? 0.5 : 1);
  const g = glowFor(o.attack, amount, pop);
  if (s > 0) p.lGlow = g;
  else p.rGlow = g;
  return p;
}

function attackPose(o, tIn) {
  const s = o.side === 'right' ? -1 : 1;
  const hit = contactPose(o.attack, s);
  const D = Math.max(0.1, o.stageDur);
  const over = withPose(lerpPose(hit, neutralPose(), 0.45), { lean: hit.lean * 0.8, z: hit.z * 0.6 });
  const u = smooth(clamp01((tIn - 0.06) / (D - 0.06)));
  const p = lerpPose(hit, over, u);
  const g = glowFor(o.attack, 1 - u, Math.max(0, 1 - tIn / 0.1));
  if (s > 0) p.lGlow = g;
  else p.rGlow = g;
  return p;
}

/** Recover = the opening: arms low, chin exposed; off-balance after an Anchor Drop stumbles forward. */
function recoverPose(o, tIn, t) {
  const s = o.side === 'right' ? -1 : 1;
  const D = Math.max(0.1, o.stageDur);
  const hit = contactPose(o.attack, s);
  const start = withPose(lerpPose(hit, neutralPose(), 0.45), { lean: hit.lean * 0.7, z: hit.z * 0.4 });
  const open = guardPose('none', t);
  open.z = 0.12;
  open.lean = 0.16;
  open.hipY = 0.87;
  open.headPitch = -0.15;
  open.twist = -s * 0.15;
  if (o.offBalance) {
    open.z = 0.26;
    open.lean = 0.32;
    open.roll = s * 0.22 * Math.sin(tIn * 6);
    open.headRoll = -s * 0.2;
    const key = s > 0 ? 'lHand' : 'rHand';
    open[key] = [-s * 0.05, 0.9, 0.5];
    open.lFoot = [0.22, 0.06, 0.32];
    open.rFoot = [-0.2, 0.06, -0.2];
  }
  const inU = easeOut(clamp01(tIn / 0.18));
  const outU = smooth(clamp01((tIn - D * 0.78) / (D * 0.22)));
  let p = lerpPose(start, open, inU);
  p = lerpPose(p, neutralPose(), outU);
  p.shimmer = 0.35 * (1 - outU) * (0.6 + 0.4 * Math.sin(t * 9));
  return p;
}

// ───────────────────────────────────────────── reactions and knockdowns

function hurtPose(o, tIn, t, lastHit) {
  const D = Math.max(0.1, o.stageDur);
  const big = D >= tuning.hurtLongS; // interrupt stagger (1 s)
  const u = clamp01(tIn / D);
  const snap = easeOut(clamp01(tIn / 0.08)) * (1 - smooth(clamp01((tIn - 0.08) / (D - 0.08))));
  const dir = lastHit?.hand === 'left' ? 1 : lastHit?.hand === 'right' ? -1 : 0;
  const hook = lastHit?.punchType === 'hook';
  const upper = lastHit?.punchType === 'uppercut';
  const body = lastHit?.target === 'body'; // a body hit never snaps the head (the fold is additive, below)
  const p = guardPose('low', t);
  p.headPitch = -0.55 * snap * (body ? 0 : hook ? 0.4 : upper ? 1.45 : 1); // D11: the uppercut snaps the chin up and back
  p.headYaw = dir * (hook ? 0.7 : upper ? 0.05 : 0.25) * snap;
  p.headRoll = -dir * (upper ? 0.05 : 0.25) * snap;
  p.lean = -(upper ? 0.32 : 0.25) * snap;
  p.z = -0.12 * snap;
  if (upper) p.hipY += 0.035 * snap; // lifted onto her heels
  if (big) {
    const wob = Math.sin(tIn * 9) * (1 - u);
    p.z = -0.3 * Math.sin(Math.PI * Math.min(1, u * 1.4));
    p.lean = -0.3 * (1 - u) + 0.1 * wob;
    p.roll = 0.18 * wob;
    p.hipY = 0.86;
    p.lHand = [0.38, 1.25 + 0.1 * wob, 0.05];
    p.rHand = [-0.36, 1.2 - 0.1 * wob, 0.0];
    p.lPole = [1, -0.2, -0.3];
    p.rPole = [-1, -0.2, -0.3];
    p.rFoot = [-0.2, 0.06, -0.34 * (1 - u)];
    const back = smooth(clamp01((u - 0.75) / 0.25));
    return lerpPose(p, neutralPose(), back);
  }
  return p;
}

function downPose(t, lying) {
  const p = neutralPose();
  p.fall = -1.45 * lying;
  p.yaw = 1.2 * lying; // she twists as she goes down, so she lies across the canvas, not end-on
  p.z = -0.35 * lying;
  p.y = 0.17 * lying;
  p.hipY = lerp(0.93, 0.72, Math.min(1, lying * 2));
  p.lean = lerp(0.06, -0.15, lying);
  p.headPitch = -0.35 * lying;
  p.headYaw = 0.3 * lying;
  p.lHand = [lerp(0.12, 0.5, lying), lerp(1.5, 1.2, lying), lerp(0.3, -0.05, lying)];
  p.rHand = [lerp(-0.12, -0.48, lying), lerp(1.52, 1.25, lying), lerp(0.24, 0.0, lying)];
  p.lPole = [1, 0, -0.5];
  p.rPole = [-1, 0, -0.5];
  p.lFoot = [0.22, 0.06, 0.18];
  p.rFoot = [-0.2, 0.06, 0.05];
  return p;
}

function knockdownPose(o, tIn, t) {
  const F = tuning.fallS;
  const buckle = easeOut(clamp01(tIn / 0.22));
  const fall = easeIn(clamp01((tIn - 0.12) / (F - 0.12)));
  const bounce = tIn > F ? Math.max(0, Math.sin((tIn - F) * 18) * Math.exp(-(tIn - F) * 7)) * 0.08 : 0;
  const p = downPose(t, fall);
  p.hipY = lerp(lerp(0.93, 0.7, buckle), 0.9, fall); // knees buckle, then the legs straighten out on the canvas
  p.y += bounce;
  // stirring as the count climbs
  const n = o.down?.count ?? 0;
  if (n >= 4 && o.knockdowns < 2) p.headPitch += 0.25 * Math.sin(t * 2) * 0.5 + 0.2;
  return p;
}

function getupPose(o, tIn, t) {
  const D = Math.max(0.2, o.stageDur);
  const u = clamp01(tIn / D);
  const p = downPose(t, 1 - easeInOut(u));
  // push off the knee on the way up
  const push = Math.sin(Math.PI * u);
  p.rHand = [lerp(p.rHand[0], -0.15, push), lerp(p.rHand[1], 0.6, push), lerp(p.rHand[2], 0.25, push)];
  p.headPitch = lerp(p.headPitch, 0.2, push);
  return p;
}

// ───────────────────────────────────────────── entry

/**
 * @param {import('../shared/types.js').GameState} state
 * @param {number} t   presentation time (s)
 * @param {{lastHit?:{t:number, hand:string, punchType:string}, lastBlock?:{t:number, hand:string},
 *          lastPunch?:{t:number, hand:string, punchType:string}}} ctx
 */
export function computeOpponentPose(state, t, ctx = {}) {
  const o = state.opponent;
  const tIn = Math.max(0, t - o.stageStart);
  let p;

  if (state.phase === 'practice' || o.mitts) {
    p = circlePose(state, t * 0.6, 'high');
    p.lHand = [0.22, 1.46, 0.42];
    p.rHand = [-0.22, 1.46, 0.42];
    p.lPole = [1, -0.6, -0.4];
    p.rPole = [-1, -0.6, -0.4];
    p.mitts = true;
    // the mitt on the punching hand's side gives a little
    if (ctx.lastPunch) {
      const age = t - ctx.lastPunch.t;
      if (age >= 0 && age < 0.3) {
        const k = Math.sin(Math.PI * clamp01(age / 0.3));
        const key = ctx.lastPunch.hand === 'left' ? 'rHand' : 'lHand'; // player's left lands on her right mitt
        p[key] = [p[key][0], p[key][1], p[key][2] - 0.14 * k];
      }
    }
    return p;
  }

  // between rounds, before the fight and after a decision she is out of the exchange, whatever her stage was
  const resting = state.phase === 'round_end' || state.phase === 'boot' || state.phase === 'calibration' ||
    (state.phase === 'match_end' && o.state !== 'knockdown' && o.state !== 'getup');
  switch (resting ? 'circle' : o.state) {
    case 'telegraph': p = telegraphPose(o, tIn); break;
    case 'attack': p = attackPose(o, tIn); break;
    case 'recover': p = recoverPose(o, tIn, t); break;
    case 'hurt': p = hurtPose(o, tIn, t, ctx.lastHit); break;
    case 'knockdown': p = knockdownPose(o, tIn, t); break;
    case 'getup': p = getupPose(o, tIn, t); break;
    default: {
      p = circlePose(state, t, resting ? 'low' : o.guard);
      if (state.player.down) { // she backs off to let the count run, gloves up
        p.z = -0.45;
        p.lHand = [0.28, 1.85, 0.12];
        p.rHand = [-0.2, 1.55, 0.2];
      }
      if (state.phase === 'round_end' || state.phase === 'boot' || state.phase === 'calibration') {
        p = lerpPose(p, guardPose('none', t), 0.7);
        p.z = -0.35;
        p.hipY -= 0.01 * Math.sin(t * 2.2);
      }
      if (state.phase === 'match_end' && state.result.winner === 'opponent') {
        const b = Math.abs(Math.sin(t * 4));
        p.lHand = [0.32, 2.05 + 0.05 * b, 0.05];
        p.rHand = [-0.32, 2.05 + 0.05 * b, 0.05];
        p.lPole = [1, 0, 0];
        p.rPole = [-1, 0, 0];
        p.headPitch = -0.2;
        p.hipY += 0.03 * b;
      } else if (state.phase === 'match_end') {
        p = lerpPose(p, guardPose('none', t), 1);
        p.headPitch = 0.35;
        p.z = -0.3;
      }
    }
  }

  // D11 guard split: her gloves are knocked apart and up, then hang low until opponent.splitUntil
  const F = ctx.features ?? {}; // ?next=1 flags (frame.features); without them nothing below D11 is drawn
  const splitLive = !!F.uppercut && Number.isFinite(o.splitUntil) && state.time < o.splitUntil;
  if (F.uppercut && ctx.split && o.state !== 'knockdown' && o.state !== 'getup' && (splitLive || t - ctx.split.t < 0.05)) {
    const age = t - ctx.split.t;
    if (age >= 0) {
      const fly = easeOut(clamp01(age / 0.07)) * (1 - smooth(clamp01((age - 0.07) / 0.12)));
      const low = smooth(clamp01((age - 0.07) / 0.12));
      const keep = { lGlow: NO_GLOW, rGlow: NO_GLOW };
      const sp = { ...p };
      sp.lHand = [lerp(0.36, 0.3, low), lerp(1.86, 1.05, low), lerp(0.16, 0.22, low)];
      sp.rHand = [lerp(-0.36, -0.3, low), lerp(1.86, 1.05, low), lerp(0.16, 0.22, low)];
      sp.lPole = [1, -0.3, -0.3];
      sp.rPole = [-1, -0.3, -0.3];
      sp.headPitch = -0.2 * fly + 0.02;
      sp.lean = p.lean - 0.08 * fly;
      p = { ...lerpPose(p, sp, Math.max(fly, low)), ...keep };
    }
  }

  // D11 tuck: elbows pinched, gloves tight together at the chin, chin down (circle, and her off hand in a telegraph)
  const tucked = !!F.uppercut && Number.isFinite(o.tuckUntil) && state.time < o.tuckUntil && !splitLive;
  if (tucked && (o.state === 'circle' || o.state === 'telegraph') && !o.covering) {
    const k = ctx.tuck ? easeOut(clamp01((t - ctx.tuck.t) / 0.15)) : 1;
    const striking = o.state === 'telegraph' ? (o.side === 'right' ? 'rHand' : 'lHand') : null;
    const tk = { ...p };
    if (striking !== 'lHand') { tk.lHand = [0.07, 1.6, 0.24]; tk.lPole = [0.05, -1, 0.35]; }
    if (striking !== 'rHand') { tk.rHand = [-0.07, 1.6, 0.24]; tk.rPole = [-0.05, -1, 0.35]; }
    if (!striking) {
      tk.headPitch = 0.3;
      tk.hipY = p.hipY - 0.03;
    }
    p = { ...lerpPose(p, tk, k), lGlow: p.lGlow, rGlow: p.rGlow };
  }

  // D9 cover-up: gloves tight at the temples, chin tucked, elbows in, while opponent.covering is true
  if (o.covering && o.state !== 'knockdown' && o.state !== 'getup') {
    const k = ctx.cover ? easeOut(clamp01((t - ctx.cover.t) / 0.1)) : 1;
    const c = { ...p };
    c.lHand = [0.12, 1.79, 0.13];
    c.rHand = [-0.12, 1.79, 0.13];
    c.lPole = [0.25, -1, 0.2];
    c.rPole = [-0.25, -1, 0.2];
    c.headPitch = 0.28;
    c.headYaw = 0;
    c.hipY = p.hipY - 0.04;
    c.lean = Math.max(p.lean, 0.1);
    c.twist = 0;
    c.lGlow = c.rGlow = NO_GLOW;
    p = { ...lerpPose(p, c, k), lGlow: NO_GLOW, rGlow: NO_GLOW, shimmer: 0 };
  }

  // D9 feint_cancel: blend from the abandoned wind-up into whatever she is doing now within ~100 ms
  if (ctx.feintCancel?.from) {
    const age = t - ctx.feintCancel.t;
    if (age >= 0 && age < 0.1) {
      const glows = { lGlow: p.lGlow, rGlow: p.rGlow };
      p = { ...lerpPose(ctx.feintCancel.from, p, easeOut(age / 0.1)), ...glows };
    }
  }

  // additive reactions: flinch on any landed hit, glove bounce when she blocks
  // D12 tired / exhausted: lower shoulders and visible breathing; exhausted gloves sag and the head drops
  const tired = !!F.body && (o.tired === 'tired' || o.tired === 'exhausted');
  if (tired && (o.state === 'circle' || o.state === 'recover') && !o.covering && !o.mitts) {
    const ex = o.tired === 'exhausted';
    const breath = Math.sin(t * (ex ? 4.2 : 3.2));
    const sag = ex ? 0.12 : 0.05;
    p.lHand = [p.lHand[0], p.lHand[1] - sag + 0.012 * breath, p.lHand[2]];
    p.rHand = [p.rHand[0], p.rHand[1] - sag + 0.012 * breath, p.rHand[2]];
    p.hipY += (ex ? 0.022 : 0.012) * breath - (ex ? 0.03 : 0.015);
    p.headPitch += ex ? 0.14 : 0.05;
    p.lean += ex ? 0.06 : 0.02;
  }

  // D12 parry: her striking arm is knocked wide and up
  if (F.parry && ctx.parry && o.state !== 'knockdown' && o.state !== 'getup') {
    const age = t - ctx.parry.t;
    if (age >= 0 && age < 0.4) {
      const k = Math.sin(Math.PI * clamp01(age / 0.4)) * (age < 0.05 ? age / 0.05 : 1);
      const key = ctx.parry.herSide === 'left' ? 'lHand' : 'rHand';
      const sx = ctx.parry.herSide === 'left' ? 1 : -1;
      p[key] = [p[key][0] + sx * 0.45 * k, p[key][1] + 0.12 * k, p[key][2] - 0.2 * k];
      p.twist += sx * 0.25 * k;
      p.lean -= 0.08 * k;
      if (sx > 0) p.lGlow = NO_GLOW;
      else p.rGlow = NO_GLOW;
    }
  }

  // D12 body hit: she folds at the waist (no head snap)
  if (F.body && ctx.lastHit?.target === 'body' && o.state !== 'knockdown' && o.state !== 'getup') {
    const age = t - ctx.lastHit.t;
    if (age >= 0 && age < 0.35) {
      const k = Math.sin(Math.PI * clamp01(age / 0.35));
      p.lean += 0.35 * k;
      p.hipY -= 0.06 * k;
      p.headPitch += 0.25 * k;
      p.lHand = [p.lHand[0] * (1 - 0.3 * k), p.lHand[1] - 0.18 * k, p.lHand[2] - 0.04 * k];
      p.rHand = [p.rHand[0] * (1 - 0.3 * k), p.rHand[1] - 0.18 * k, p.rHand[2] - 0.04 * k];
    }
  } else if (ctx.lastHit && o.state !== 'knockdown' && o.state !== 'getup') {
    const age = t - ctx.lastHit.t;
    if (age >= 0 && age < 0.25) {
      const k = Math.sin(Math.PI * clamp01(age / 0.25)) * (o.state === 'hurt' ? 0.3 : 1);
      const dir = ctx.lastHit.hand === 'left' ? 1 : -1;
      const upper = ctx.lastHit.punchType === 'uppercut';
      p.headPitch -= (upper ? 0.55 : 0.25) * k; // up and back for the uppercut
      p.headYaw += dir * (upper ? 0.04 : 0.2) * k;
      p.lean -= (upper ? 0.12 : 0.06) * k;
      if (upper) p.hipY += 0.02 * k;
    }
  }
  if (ctx.lastBlock) {
    const age = t - ctx.lastBlock.t;
    if (age >= 0 && age < 0.2) {
      const k = Math.sin(Math.PI * clamp01(age / 0.2));
      p.lHand = [p.lHand[0], p.lHand[1] + 0.02 * k, p.lHand[2] - 0.08 * k];
      p.rHand = [p.rHand[0], p.rHand[1] + 0.02 * k, p.rHand[2] - 0.08 * k];
      p.headPitch += 0.08 * k;
    }
  }
  return p;
}
