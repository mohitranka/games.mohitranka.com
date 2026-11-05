// game/pressure.js — D9a pressure (replaces the old continuous-guard anti-turtle). Owner: GE.
//
// ON when both hold:
//   * the player has landed no counter or interrupt for pressureWindow (8 s); the timer restarts at each round
//     start and each get-up;
//   * the player's effective guard was 'full' on ≥ pressureGuardShare (70%) of the live ticks in the last 8 s.
// OFF on any counter / interrupt, or when the guard share drops below 70%.
// Sampled only on live round ticks (clock running, nobody down), on a 60 Hz ring of guard samples.
// Effects live where they apply: AI weights (opponent-ai.js), Anchor Drop block / guard break (combat.js),
// guarding regen (stamina.js). Emits pressure{on} and sets player.pressured on every change.

import { EVENT, SIM_DT } from '../shared/constants.js';
import { EPS } from './stamina.js';

const EV_PRESSURE = EVENT.PRESSURE;

export function createPressureContext() {
  return { ring: null, idx: 0, sum: 0, lastCounterT: 0 };
}

function ringSize(T) {
  return Math.max(1, Math.round(T.pressureWindow / SIM_DT));
}

function setPressured(w, on) {
  const p = w.state.player;
  if (!!p.pressured === on) return;
  p.pressured = on;
  w.emit(EV_PRESSURE, { on });
}

/** Round start and every get-up: restart the no-counter timer and the guard window; pressure ends. */
export function restartPressure(w) {
  const pc = w.ctx.pressure;
  pc.ring = new Uint8Array(ringSize(w.T));
  pc.idx = 0;
  pc.sum = 0;
  pc.lastCounterT = w.state.time;
  setPressured(w, false);
}

/** A counter or interrupt landed: pressure ends, and the no-counter timer restarts. */
export function noteCounter(w) {
  w.ctx.pressure.lastCounterT = w.state.time;
  setPressured(w, false);
}

export function guardShare(w) {
  const pc = w.ctx.pressure;
  return pc.ring ? pc.sum / pc.ring.length : 0;
}

/** Once per live round tick, after punches resolve: sample the guard and update pressure. */
export function updatePressure(w) {
  const T = w.T;
  const pc = w.ctx.pressure;
  if (!pc.ring || pc.ring.length !== ringSize(T)) restartPressure(w);
  const sample = w.state.player.guard === 'full' ? 1 : 0;
  pc.sum += sample - pc.ring[pc.idx];
  pc.ring[pc.idx] = sample;
  pc.idx = (pc.idx + 1) % pc.ring.length;
  const quiet = w.state.time - pc.lastCounterT >= T.pressureWindow - EPS;
  setPressured(w, quiet && guardShare(w) >= T.pressureGuardShare - EPS);
}

export function isPressured(w) {
  return !!w.state.player.pressured;
}
