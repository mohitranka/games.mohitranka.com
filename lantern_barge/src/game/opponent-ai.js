// game/opponent-ai.js — Tamsin "Tugboat" Rourke (GDD §6). Owner: GE.
// circle → telegraph → attack → recover → circle; hurt / knockdown / getup interrupt the cycle.
// Rope Snap: 1–3 jabs with contacts 300 ms apart (each follow-up gets its own telegraph{comboIndex}).
// All randomness comes from w.rng.

import { EVENT, OPP_STATE, ATTACK, SIM_DT } from '../shared/constants.js';
import { EPS } from './stamina.js';
import { resolveStrike } from './combat.js';

const ATTACK_ORDER = [ATTACK.ROPE_SNAP, ATTACK.SWING_BRIDGE, ATTACK.ANCHOR_DROP];

export function createAIContext(rng, T) {
  return {
    seq: 0, // attack-sequence id (snapshots carry it)
    history: [], // attacks started, most recent last
    circleTime: 0, // cooldown accumulator: time spent in circle since her last attack began
    decisionTime: 0, // 300 ms decision grid while circling
    circleGuard: 'high',
    guardTime: 0,
    guardDur: rng.range(T.guardHighDur[0], T.guardHighDur[1]),
    resolved: true, // the current strike has resolved
    offBalanceExt: 0,
    cleanHits: [],
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

function clearAttack(o) {
  o.attack = null;
  o.side = null;
  o.combo = { index: 0, count: 1 };
  o.opening = false;
  o.offBalance = false;
  o.contactAt = null;
}

/** Back to circling. resetCooldown: start a fresh cooldown (round start, get-ups). */
export function toCircle(w, { resetCooldown = false } = {}) {
  const o = w.state.opponent;
  const ai = w.ctx.ai;
  clearAttack(o);
  setStage(w, OPP_STATE.CIRCLE, 0);
  o.guard = ai.circleGuard;
  ai.decisionTime = 0;
  ai.resolved = true;
  ai.offBalanceExt = 0;
  if (resetCooldown) ai.circleTime = 0;
}

export function currentCooldown(w) {
  const T = w.T;
  const base = T.cooldown[roundIndex(w.state)];
  return w.state.player.stamina < T.antiSpamBelow ? base * T.antiSpamCooldownFactor : base;
}

/** Attack weights after anti-turtle, anti-spam and the no-3-in-a-row rule. */
export function attackWeights(w) {
  const T = w.T;
  const p = w.state.player;
  const t = w.state.time;
  const wt = { ...T.weights };
  if (p.guardHeldSince >= 0 && t - p.guardHeldSince >= T.antiTurtleHold - EPS) wt.anchor_drop = T.antiTurtleAnchorWeight;
  if (p.stamina < T.antiSpamBelow) wt.rope_snap = T.antiSpamRopeWeight;
  const h = w.ctx.ai.history;
  const n = T.maxSameAttackInRow;
  if (h.length >= n && h.slice(-n).every((a) => a === h.at(-1))) wt[h.at(-1)] = 0;
  return wt;
}

export function chooseAttack(w) {
  const wt = attackWeights(w);
  return w.rng.weighted(ATTACK_ORDER.map((a) => [a, wt[a]]));
}

function telegraph(w, windup) {
  const o = w.state.opponent;
  setStage(w, OPP_STATE.TELEGRAPH, windup);
  o.contactAt = w.state.time + windup;
  o.guard = w.T.telegraphGuard[o.attack];
  w.ctx.ai.resolved = false;
  w.emit(EVENT.TELEGRAPH, {
    attack: o.attack, side: o.side, windup, comboIndex: o.combo.index, comboCount: o.combo.count,
  });
}

/**
 * Begin an attack sequence now (the AI's pick or force_attack). The first strike is always telegraphed
 * at least telegraphFloor ahead (D4).
 */
export function startAttack(w, attack, side, count) {
  const T = w.T;
  const o = w.state.opponent;
  const ai = w.ctx.ai;
  clearAttack(o);
  ai.seq += 1;
  ai.history.push(attack);
  if (ai.history.length > 8) ai.history.shift();
  ai.circleTime = 0;
  ai.decisionTime = 0;
  ai.offBalanceExt = 0;
  o.attack = attack;
  o.side = side;
  o.combo = { index: 0, count: attack === ATTACK.ROPE_SNAP ? Math.max(1, Math.min(3, count | 0 || 1)) : 1 };
  telegraph(w, Math.max(T.telegraphFloor, T.windup[attack][roundIndex(w.state)]));
}

function aiPickAndStart(w) {
  const T = w.T;
  const attack = chooseAttack(w);
  let side = 'left';
  let count = 1;
  if (attack === ATTACK.ROPE_SNAP) count = w.rng.int(T.ropeSnapJabs[0], T.ropeSnapJabs[1]);
  else if (attack === ATTACK.SWING_BRIDGE) side = w.rng.next() < 0.5 ? 'left' : 'right';
  else side = 'right';
  startAttack(w, attack, side, count);
}

/** Stagger her: hurt for dur, cancelling any attack in progress (only interrupts reach her mid-attack). */
export function staggerOpponent(w, dur, interrupt) {
  const o = w.state.opponent;
  clearAttack(o);
  w.ctx.ai.resolved = true;
  setStage(w, OPP_STATE.HURT, dur);
  o.guard = 'low';
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

function circleUpdate(w, dt) {
  const T = w.T;
  const o = w.state.opponent;
  const ai = w.ctx.ai;
  ai.guardTime += dt;
  if (ai.guardTime >= ai.guardDur - EPS) {
    ai.circleGuard = ai.circleGuard === 'high' ? 'low' : 'high';
    const r = ai.circleGuard === 'high' ? T.guardHighDur : T.guardLowDur;
    ai.guardDur = w.rng.range(r[0], r[1]);
    ai.guardTime = 0;
  }
  o.guard = ai.circleGuard;
  ai.circleTime += dt;
  ai.decisionTime += dt;
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
      if (t >= o.contactAt - EPS) {
        w.emit(EVENT.STRIKE, { attack: o.attack, side: o.side, comboIndex: o.combo.index });
        setStage(w, OPP_STATE.ATTACK, Math.max(T.strikeHold, T.impactDelay));
        o.stageStart = o.contactAt;
        o.guard = 'none';
      }
      break;
    case OPP_STATE.ATTACK:
      if (!ai.resolved && t >= o.contactAt + T.impactDelay - EPS) {
        ai.resolved = true;
        if (resolveStrike(w)) return; // the player went down; knockdown() reset her to circle
      }
      if (ai.resolved && stageOver()) {
        if (o.attack === ATTACK.ROPE_SNAP && o.combo.index + 1 < o.combo.count) {
          const nextContact = o.contactAt + T.ropeSnapInterval;
          o.combo = { index: o.combo.index + 1, count: o.combo.count };
          telegraph(w, Math.max(SIM_DT, nextContact - t));
        } else {
          const dur = T.recoverDur[o.attack];
          o.offBalance = o.attack === ATTACK.ANCHOR_DROP;
          o.opening = true;
          o.contactAt = null;
          o.guard = 'none';
          ai.offBalanceExt = 0;
          setStage(w, OPP_STATE.RECOVER, dur);
          w.emit(EVENT.OPENING, { dur });
        }
      }
      break;
    case OPP_STATE.RECOVER:
      if (stageOver()) toCircle(w);
      break;
    default: // knockdown: driven by phases.js
      break;
  }
}

/** force_attack (test/debug): cancel whatever she is doing and start the attack now, ignoring cooldown. */
export function forceAttack(w, attack, side, combo) {
  const defaults = { rope_snap: 'left', swing_bridge: 'left', anchor_drop: 'right' };
  toCircle(w);
  startAttack(w, attack, side ?? defaults[attack], combo ?? 1);
}
