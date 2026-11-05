// game/stamina.js — punch and block costs, regeneration, fatigued / gassed / lowHp flags (GDD §5). Owner: GE.

import { EVENT } from '../shared/constants.js';

export const EPS = 1e-9;

export function punchCost(T, power) {
  return T.punchCostBase + T.punchCostPower * Math.min(1, Math.max(0, power));
}

export function isGassed(player, t) {
  return t < player.gassedUntil - EPS;
}

/** Fatigue multiplier from the stamina the player had before paying for this punch. */
export function fatigueFactor(T, player) {
  return player.stamina < T.fatigueLine ? T.fatigueMult : 1;
}

/**
 * Pay stamina for a punch or a block. Reaching 0 makes the player gassed (once per gassed spell).
 * @param {object} w world
 */
export function spend(w, amount) {
  const p = w.state.player;
  const t = w.state.time;
  p.stamina = Math.max(0, p.stamina - amount);
  w.ctx.lastActionT = t;
  if (p.stamina <= 0 && !isGassed(p, t)) {
    p.gassedUntil = t + w.T.gassedDur;
    w.emit(EVENT.GASSED, { until: p.gassedUntil });
  }
}

/**
 * 14/s starting 700 ms after the last punch or block, half rate while the effective guard is up,
 * paused while gassed and resuming immediately when it ends.
 */
export function regen(w, dt) {
  const p = w.state.player;
  const T = w.T;
  const t = w.state.time;
  if (isGassed(p, t) || p.stamina >= p.maxStamina) return;
  const delayDone = t - w.ctx.lastActionT >= T.regenDelay - EPS;
  const gassedJustEnded = p.gassedUntil > w.ctx.lastActionT; // gassed after the last action, and now over
  if (!delayDone && !gassedJustEnded) return;
  const rate = T.regenRate * (p.guard === 'full' ? T.regenGuardFactor : 1);
  p.stamina = Math.min(p.maxStamina, p.stamina + rate * dt);
}

export function updateFlags(w) {
  const p = w.state.player;
  p.fatigued = p.stamina < w.T.fatigueLine;
  p.lowHp = p.hp < w.T.lowHpLine;
}
