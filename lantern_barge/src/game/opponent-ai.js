// game/opponent-ai.js — Tamsin "Tugboat" Rourke (GDD §6, decisions D9). Owner: GE.
//
// She attacks in SEQUENCES: single (Rope Snap 1–3 jabs, Swing Bridge, Anchor Drop), feint (R2+), punish (the
// Rope Snap after a feint) and combo (R3). A sequence is a list of steps {attack, side, gap}; `gap` is contact to
// contact from the previous strike. Each step gets its own telegraph; o.combo{index,count} spans the sequence.
//   circle → telegraph → attack → (next step's telegraph …) → recover → circle
//   hurt / knockdown / getup interrupt the cycle; a feint cancels from telegraph into punish or circle.
//
// Free-hit windows (D9): Recover, the Hurt after an interrupt, and each low-guard spell in Circle (including
// the 250 ms Hurt it causes) have a budget of clean hits. When it runs out she covers up (guard high) for the
// rest of the window. The budget is spent in combat.js; syncOpponent() derives guard / covering / freeHits.
//
// All randomness comes from w.rng.

import { EVENT, OPP_STATE, ATTACK, SIM_DT } from '../shared/constants.js';
import { EPS } from './stamina.js';
import { resolveStrike } from './combat.js';

const ATTACK_ORDER = [ATTACK.ROPE_SNAP, ATTACK.SWING_BRIDGE, ATTACK.ANCHOR_DROP];
const FEINT_ORDER = [ATTACK.SWING_BRIDGE, ATTACK.ANCHOR_DROP];
const COMBO_ORDER = ['snap_drop', 'bridge_snap', 'double_bridge'];
const KIND_ORDER = ['single', 'feint', 'combo'];
const DEFAULT_SIDE = { rope_snap: 'left', swing_bridge: 'left', anchor_drop: 'right' };

export function createAIContext(rng, T) {
  return {
    seq: 0, // sequence id (snapshots carry it)
    history: [], // one entry per single / feint / punish, one per combo ATTACK (its jabs count once); newest last
    lastKind: null, // the last kind the picker chose: 'single' | 'feint' | 'combo'
    steps: [], // current sequence
    circleTime: 0, // cooldown accumulator: time spent in circle since her last sequence began
    decisionTime: 0, // 300 ms decision grid while circling
    circleGuard: 'high',
    guardTime: 0,
    guardDur: rng.range(T.guardHighDur[0], T.guardHighDur[1]),
    resolved: true, // the current strike has resolved
    offBalanceExt: 0,
    cleanHits: [],
    // feints
    feintCancelAt: null,
    feintPunish: null, // forced punish decision (force_sequence), or null = roll
    feintCoverUntil: -1,
    // free-hit windows
    winSeq: 0,
    windows: new Map(), // id → {kind:'recover'|'hurt'|'circle', left}
    circleWin: null, // id of the current low-guard spell's window
    recoverWin: null,
    hurtWin: null,
  };
}

export function roundIndex(st) {
  return Math.min(2, Math.max(0, st.round.n - 1));
}

function setStage(w, state, dur) {
  const o = w.state.opponent;
  o.state = state;
  o.stageStart = w.state.time;
  o.stageDur = dur;
}

const IDLE_SEQUENCE = () => ({ kind: 'single', combo: null }); // fixtures' idle value

function clearAttack(w) {
  const o = w.state.opponent;
  const ai = w.ctx.ai;
  o.attack = null;
  o.side = null;
  o.combo = { index: 0, count: 1 };
  o.opening = false;
  o.offBalance = false;
  o.contactAt = null;
  o.feint = false;
  o.sequence = IDLE_SEQUENCE();
  ai.steps = [];
  ai.feintCancelAt = null;
  ai.feintPunish = null;
  ai.recoverWin = null;
  ai.hurtWin = null;
}

// ───────────────────────────────────────────── free-hit windows

function openWindow(w, kind, budget) {
  const ai = w.ctx.ai;
  const id = ++ai.winSeq;
  ai.windows.set(id, { kind, left: budget });
  if (ai.windows.size > 16) ai.windows.delete(ai.windows.keys().next().value);
  return id;
}

/** The free-hit window her CURRENT state belongs to, or null. */
export function liveWindow(w) {
  const o = w.state.opponent;
  const ai = w.ctx.ai;
  if (o.state === OPP_STATE.RECOVER) return ai.recoverWin;
  if (o.state === OPP_STATE.HURT) return ai.hurtWin;
  if (o.state === OPP_STATE.CIRCLE && ai.circleGuard === 'low') return ai.circleWin;
  return null;
}

/**
 * Spend one free hit of window `id` (combat.js, on a clean hit). Returns false if the budget was already empty
 * (the punch then meets her cover-up). Emits `cover` once, when the budget reaches 0.
 */
export function spendFreeHit(w, id) {
  const win = w.ctx.ai.windows.get(id);
  if (!win || win.left <= 0) return false;
  win.left -= 1;
  if (win.left <= 0) w.emit(EVENT.COVER, { reason: win.kind });
  syncOpponent(w);
  return true;
}

export function windowLeft(w, id) {
  return w.ctx.ai.windows.get(id)?.left ?? 0;
}

/**
 * Derive guard, covering and freeHits from her state (D9 telegraph guard and cover-up rules).
 * Called after every change and once per tick.
 */
export function syncOpponent(w) {
  const o = w.state.opponent;
  const ai = w.ctx.ai;
  const t = w.state.time;
  if (o.mitts) return; // practice card
  const winId = liveWindow(w);
  const left = winId ? windowLeft(w, winId) : 0;
  const feintCover = o.state === OPP_STATE.CIRCLE && t < ai.feintCoverUntil - EPS;
  o.freeHits = left;
  o.covering = (winId !== null && left <= 0) || feintCover;
  let natural;
  switch (o.state) {
    case OPP_STATE.CIRCLE: natural = ai.circleGuard; break;
    case OPP_STATE.HURT: natural = 'low'; break;
    case OPP_STATE.TELEGRAPH:
      natural = o.attack === ATTACK.ANCHOR_DROP && !o.feint && o.contactAt !== null &&
        t >= o.contactAt - w.T.interruptWindowOpen - EPS ? 'none' : 'high';
      break;
    default: natural = 'none'; // attack, recover, knockdown, getup
  }
  o.guard = o.covering ? 'high' : natural;
}

// ───────────────────────────────────────────── circling, cooldown, choices

/** Back to circling. resetCooldown: start a fresh cooldown (round start, get-ups). */
export function toCircle(w, { resetCooldown = false } = {}) {
  const ai = w.ctx.ai;
  clearAttack(w);
  setStage(w, OPP_STATE.CIRCLE, 0);
  ai.decisionTime = 0;
  ai.resolved = true;
  ai.offBalanceExt = 0;
  if (resetCooldown) ai.circleTime = 0;
  syncOpponent(w);
}

function antiSpam(w) {
  return w.state.player.stamina < w.T.antiSpamBelow;
}

/** D9a: pressure replaces the old continuous-guard anti-turtle trigger (see pressure.js). */
function pressured(w) {
  return !!w.state.player.pressured;
}

export function currentCooldown(w) {
  const base = w.T.cooldown[roundIndex(w.state)];
  return antiSpam(w) ? base * w.T.antiSpamCooldownFactor : base;
}

function zeroThirdRepeat(w, wt) {
  const h = w.ctx.ai.history;
  const n = w.T.maxSameAttackInRow;
  if (h.length >= n && h.slice(-n).every((a) => a === h.at(-1)) && h.at(-1) in wt) wt[h.at(-1)] = 0;
  return wt;
}

/** Single-attack weights after pressure, anti-spam and the no-3-in-a-row rule. */
export function attackWeights(w) {
  const T = w.T;
  const wt = { ...T.weights };
  if (pressured(w)) wt.anchor_drop = T.pressureAnchorWeight;
  if (antiSpam(w)) wt.rope_snap = T.antiSpamRopeWeight;
  return zeroThirdRepeat(w, wt);
}

export function feintWeights(w) {
  return zeroThirdRepeat(w, { ...w.T.feintWeights });
}

export function comboWeights(w) {
  return { ...(pressured(w) ? w.T.comboWeightsPressure : w.T.comboWeights) };
}

/** [single, feint, combo] probabilities this round, with the limits applied (a blocked kind becomes single). */
export function kindProbs(w) {
  const ai = w.ctx.ai;
  const [s, f, c] = w.T.sequenceKind[roundIndex(w.state)];
  const feintOk = ai.lastKind !== 'feint' && !antiSpam(w);
  const comboOk = ai.lastKind !== 'combo';
  return [s + (feintOk ? 0 : f) + (comboOk ? 0 : c), feintOk ? f : 0, comboOk ? c : 0];
}

export function chooseAttack(w) {
  const wt = attackWeights(w);
  return w.rng.weighted(ATTACK_ORDER.map((a) => [a, wt[a]]));
}

function randomSide(w) {
  return w.rng.next() < 0.5 ? 'left' : 'right';
}

function sideFor(w, attack) {
  return attack === ATTACK.SWING_BRIDGE ? randomSide(w) : DEFAULT_SIDE[attack];
}

// ───────────────────────────────────────────── sequence builders

function singleSteps(attack, side, jabs) {
  const n = attack === ATTACK.ROPE_SNAP ? Math.max(1, Math.min(3, jabs | 0 || 1)) : 1;
  return Array.from({ length: n }, () => ({ attack, side })); // jabs use ropeSnapInterval
}

function comboSteps(w, name, sideA) {
  const def = w.T.combos[name];
  const a = sideA ?? randomSide(w);
  const other = a === 'left' ? 'right' : 'left';
  return def.map((s) => ({
    attack: s.attack,
    side: s.attack === ATTACK.SWING_BRIDGE ? (s.otherSide ? other : a) : DEFAULT_SIDE[s.attack],
    gap: s.gap,
    jab: !!s.jab,
  }));
}

/**
 * No-3-in-a-row history (GDD §6): the attack step i adds to the history, or null. One entry per single / feint /
 * punish (a multi-jab Rope Snap counts once); one per combo ATTACK, where Bridge-Snap's two jabs are one Rope
 * Snap. The rule filters singles and feint picks, never combo contents.
 */
export function historyEntry(step, i, kind) {
  return i === 0 || (kind === 'combo' && !step.jab) ? step.attack : null;
}

export function comboStepsFor(w, name, sideA) {
  return comboSteps(w, name, sideA);
}

/** Contact-to-contact gap before step i (Rope Snap jabs use ropeSnapInterval). */
function stepGap(w, i) {
  const s = w.ctx.ai.steps[i];
  return s.gap ?? w.T.ropeSnapInterval;
}

function telegraphStep(w, i, windup) {
  const o = w.state.opponent;
  const ai = w.ctx.ai;
  const step = ai.steps[i];
  o.attack = step.attack;
  o.side = step.side;
  o.combo = { index: i, count: ai.steps.length };
  setStage(w, OPP_STATE.TELEGRAPH, windup);
  o.contactAt = w.state.time + windup;
  ai.resolved = false;
  const entry = historyEntry(step, i, o.sequence.kind);
  if (entry) {
    ai.history.push(entry);
    if (ai.history.length > 8) ai.history.shift();
  }
  if (o.feint) {
    const fc = w.T.feintCancel[step.attack];
    ai.feintCancelAt = w.state.time + (fc.frac !== undefined ? fc.frac * windup : windup - fc.beforeContact);
  }
  syncOpponent(w);
  w.emit(EVENT.TELEGRAPH, {
    attack: o.attack, side: o.side, windup, comboIndex: i, comboCount: ai.steps.length,
    feint: o.feint, combo: o.sequence.combo, afterFeint: o.sequence.kind === 'punish',
  });
}

/**
 * Start a sequence now. The first strike is telegraphed at least telegraphFloor ahead (D4); a punish uses the
 * fixed punishWindup from the cancel.
 * @param {{kind:'single'|'feint'|'punish'|'combo', combo?:string|null, steps:object[], punish?:boolean|null}} seq
 */
export function startSequence(w, { kind, combo = null, steps, punish = null }) {
  const T = w.T;
  const o = w.state.opponent;
  const ai = w.ctx.ai;
  clearAttack(w);
  ai.seq += 1;
  ai.steps = steps;
  ai.circleTime = 0;
  ai.decisionTime = 0;
  ai.offBalanceExt = 0;
  ai.feintCoverUntil = -1;
  o.sequence = { kind, combo };
  o.feint = kind === 'feint';
  if (o.feint) ai.feintPunish = punish;
  const first = steps[0].attack;
  const windup = kind === 'punish' ? Math.max(T.telegraphFloor, T.punishWindup)
    : Math.max(T.telegraphFloor, T.windup[first][roundIndex(w.state)]);
  telegraphStep(w, 0, windup);
}

/** Single attack (also force_attack): Rope Snap jabs 300 ms apart. */
export function startAttack(w, attack, side, count) {
  w.ctx.ai.lastKind = 'single';
  startSequence(w, { kind: 'single', steps: singleSteps(attack, side ?? DEFAULT_SIDE[attack], count) });
}

export function startFeint(w, attack, side, punish = null) {
  w.ctx.ai.lastKind = 'feint';
  startSequence(w, { kind: 'feint', steps: [{ attack, side: side ?? sideFor(w, attack) }], punish });
}

export function startCombo(w, name, sideA) {
  w.ctx.ai.lastKind = 'combo';
  startSequence(w, { kind: 'combo', combo: name, steps: comboSteps(w, name, sideA) });
}

export function startPunish(w) {
  const T = w.T;
  const jabs = w.rng.int(T.punishJabs[0], T.punishJabs[1]);
  startSequence(w, { kind: 'punish', steps: singleSteps(ATTACK.ROPE_SNAP, 'left', jabs) });
}

/** Roll the kind, then the attack or combo (GDD §6 "Choosing a sequence"). */
function aiPickAndStart(w) {
  const T = w.T;
  const probs = kindProbs(w);
  const kind = w.rng.weighted(KIND_ORDER.map((k, i) => [k, probs[i]]));
  if (kind === 'feint') {
    const wt = feintWeights(w);
    const attack = w.rng.weighted(FEINT_ORDER.map((a) => [a, wt[a]]));
    startFeint(w, attack, sideFor(w, attack));
  } else if (kind === 'combo') {
    const wt = comboWeights(w);
    startCombo(w, w.rng.weighted(COMBO_ORDER.map((c) => [c, wt[c]])));
  } else {
    const attack = chooseAttack(w);
    const jabs = attack === ATTACK.ROPE_SNAP ? w.rng.int(T.ropeSnapJabs[0], T.ropeSnapJabs[1]) : 1;
    startAttack(w, attack, sideFor(w, attack), jabs);
  }
}

// ───────────────────────────────────────────── reactions

/** Stagger her: hurt for dur, cancelling any attack (and the rest of a combo). Interrupts open a 2-hit window. */
export function staggerOpponent(w, dur, interrupt) {
  const ai = w.ctx.ai;
  const keepCircleWin = !interrupt;
  clearAttack(w);
  ai.resolved = true;
  setStage(w, OPP_STATE.HURT, dur);
  // the 250 ms Hurt from a circle hit belongs to that low-guard spell's window
  ai.hurtWin = interrupt ? openWindow(w, 'hurt', w.T.freeHits.interruptHurt) : keepCircleWin ? ai.circleWin : null;
  syncOpponent(w);
  w.emit(EVENT.STAGGER, { who: 'opponent', dur, interrupt });
}

/** A clean hit during an off-balance Recover extends it by 150 ms, up to +450 ms. */
export function extendOffBalance(w) {
  const T = w.T;
  const ai = w.ctx.ai;
  const add = Math.min(T.offBalanceExtend, T.offBalanceExtendMax - ai.offBalanceExt);
  if (add <= EPS) return;
  ai.offBalanceExt += add;
  w.state.opponent.stageDur += add;
}

function cancelFeint(w) {
  const T = w.T;
  const o = w.state.opponent;
  const ai = w.ctx.ai;
  const { attack, side } = o;
  const forced = ai.feintPunish;
  w.emit(EVENT.FEINT_CANCEL, { attack, side });
  const punish = forced ?? w.rng.next() < T.punishProb[roundIndex(w.state)];
  if (punish) {
    startPunish(w);
    return;
  }
  toCircle(w);
  ai.circleTime = T.feintCooldownCredit * currentCooldown(w);
  ai.feintCoverUntil = w.state.time + T.feintCoverDur;
  syncOpponent(w);
  w.emit(EVENT.COVER, { reason: 'feint' });
}

function startRecover(w) {
  const T = w.T;
  const o = w.state.opponent;
  const ai = w.ctx.ai;
  const combo = o.sequence.kind === 'combo';
  const dur = T.recoverDur[o.attack] + (combo ? T.comboRecoverExtra : 0);
  const freeHits = T.freeHits[o.attack] + (combo ? T.comboExtraFreeHits : 0);
  o.offBalance = o.attack === ATTACK.ANCHOR_DROP;
  o.opening = true;
  o.contactAt = null;
  ai.offBalanceExt = 0;
  setStage(w, OPP_STATE.RECOVER, dur);
  ai.recoverWin = openWindow(w, 'recover', freeHits);
  syncOpponent(w);
  w.emit(EVENT.OPENING, { dur, freeHits });
}

function circleUpdate(w, dt) {
  const T = w.T;
  const ai = w.ctx.ai;
  ai.guardTime += dt;
  if (ai.guardTime >= ai.guardDur - EPS) {
    ai.circleGuard = ai.circleGuard === 'high' ? 'low' : 'high';
    const r = ai.circleGuard === 'high' ? T.guardHighDur : T.guardLowDur;
    ai.guardDur = w.rng.range(r[0], r[1]);
    ai.guardTime = 0;
    ai.circleWin = ai.circleGuard === 'low' ? openWindow(w, 'circle', T.freeHits.circleLow) : null;
  }
  ai.circleTime += dt;
  ai.decisionTime += dt;
  syncOpponent(w);
  if (ai.decisionTime >= T.decisionInterval - EPS) {
    ai.decisionTime -= T.decisionInterval;
    if (ai.circleTime >= currentCooldown(w) - EPS) aiPickAndStart(w);
  }
}

/**
 * Advance Tamsin by one tick. Called only while the round clock runs and nobody is down.
 * @param {object} w world
 */
export function updateOpponent(w, dt) {
  const T = w.T;
  const st = w.state;
  const o = st.opponent;
  const ai = w.ctx.ai;
  const t = st.time;
  const stageOver = () => t >= o.stageStart + o.stageDur - EPS;

  switch (o.state) {
    case OPP_STATE.CIRCLE:
      circleUpdate(w, dt);
      break;
    case OPP_STATE.HURT:
      if (stageOver()) toCircle(w);
      break;
    case OPP_STATE.GETUP:
      if (stageOver()) toCircle(w, { resetCooldown: true });
      break;
    case OPP_STATE.TELEGRAPH:
      if (o.feint && ai.feintCancelAt !== null && t >= ai.feintCancelAt - EPS) {
        cancelFeint(w);
      } else if (t >= o.contactAt - EPS) {
        w.emit(EVENT.STRIKE, { attack: o.attack, side: o.side, comboIndex: o.combo.index });
        setStage(w, OPP_STATE.ATTACK, Math.max(T.strikeHold, T.impactDelay));
        o.stageStart = o.contactAt;
      }
      break;
    case OPP_STATE.ATTACK:
      if (!ai.resolved && t >= o.contactAt + T.impactDelay - EPS) {
        ai.resolved = true;
        if (resolveStrike(w)) return; // the player went down; knockdown() reset her to circle
      }
      if (ai.resolved && stageOver()) {
        const next = o.combo.index + 1;
        if (next < ai.steps.length) {
          // no opening between strikes: straight into the next step's telegraph
          telegraphStep(w, next, Math.max(SIM_DT, o.contactAt + stepGap(w, next) - t));
        } else {
          startRecover(w);
        }
      }
      break;
    case OPP_STATE.RECOVER:
      if (stageOver()) toCircle(w);
      break;
    default: // knockdown: driven by phases.js
      break;
  }
  syncOpponent(w);
}

// ───────────────────────────────────────────── test / debug

/** force_attack (test/debug): cancel whatever she is doing and start a single attack now, ignoring cooldown. */
export function forceAttack(w, attack, side, combo) {
  toCircle(w);
  startAttack(w, attack, side ?? DEFAULT_SIDE[attack], combo ?? 1);
}

/**
 * force_sequence (test/debug, D9): {kind, attack?, combo?, side?, punish?, jabs?}.
 * single → attack (default rope_snap; jabs default 1); feint → attack swing_bridge|anchor_drop (default
 * swing_bridge), punish true/false forces the outcome (omitted = rolled); combo → combo name (default snap_drop),
 * side = Swing Bridge side A; punish → a punish Rope Snap now. Returns false if the request is invalid.
 */
export function forceSequence(w, cmd) {
  const { kind } = cmd;
  if (kind === 'single') {
    const attack = cmd.attack ?? ATTACK.ROPE_SNAP;
    if (!ATTACK_ORDER.includes(attack)) return false;
    toCircle(w);
    startAttack(w, attack, cmd.side ?? DEFAULT_SIDE[attack], cmd.jabs ?? 1);
  } else if (kind === 'feint') {
    const attack = cmd.attack ?? ATTACK.SWING_BRIDGE;
    if (!FEINT_ORDER.includes(attack)) return false;
    toCircle(w);
    startFeint(w, attack, cmd.side ?? DEFAULT_SIDE[attack], typeof cmd.punish === 'boolean' ? cmd.punish : null);
  } else if (kind === 'combo') {
    const name = cmd.combo ?? 'snap_drop';
    if (!w.T.combos[name]) return false;
    toCircle(w);
    startCombo(w, name, cmd.side);
  } else if (kind === 'punish') {
    toCircle(w);
    startPunish(w);
  } else {
    return false;
  }
  return true;
}
