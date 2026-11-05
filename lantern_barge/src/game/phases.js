// game/phases.js — the phase machine (architecture §3.5 transition table) and the knockdown sub-state
// (GDD §2, decisions D5/D5a). Owner: GE.

import { EVENT, PHASE, OPP_STATE } from '../shared/constants.js';
import { createPlayer, createOpponent } from '../shared/fixtures.js';
import { EPS } from './stamina.js';
import { toCircle, updateOpponent, clearSplit, addOppStamina } from './opponent-ai.js';
import { initRise, updateRise, riseDecision, riseHp } from './defence.js';
import { restartPressure, updatePressure } from './pressure.js';

/**
 * Legal phase changes, from the architecture §3.5 table (goto_phase, a debug command, may jump anywhere).
 * [from, to, trigger]
 */
export const TRANSITIONS = Object.freeze([
  [PHASE.BOOT, PHASE.CALIBRATION, 'start, and frame.calibration.wanted (camera, or replay with {calibrate:true})'],
  [PHASE.BOOT, PHASE.PRACTICE, 'start, keyboard / replay without calibrate'],
  [PHASE.CALIBRATION, PHASE.PRACTICE, 'frame.calibration.done for state.calibSession'],
  [PHASE.CALIBRATION, PHASE.BOOT, 'cancel'],
  [PHASE.PRACTICE, PHASE.FIGHT, 'practice elapsed or skip_practice (n = 1, countdown)'],
  [PHASE.FIGHT, PHASE.ROUND_END, 'timeLeft reaches 0, n < of'],
  [PHASE.FIGHT, PHASE.MATCH_END, 'timeLeft reaches 0 at n === of (points), or the KO count reaches 10'],
  [PHASE.ROUND_END, PHASE.FIGHT, 'rest elapsed (n + 1, countdown)'],
  [PHASE.MATCH_END, PHASE.FIGHT, 'restart (n = 1, countdown)'],
]);

// ───────────────────────────────────────────── fighters

export function freshPlayer(T) {
  const p = createPlayer();
  p.maxHp = p.hp = T.hpMax.player;
  p.maxStamina = p.stamina = T.staminaMax;
  p.pressured = false; // D9a
  p.stats.splits = 0; // D11
  return p;
}

export function freshOpponent(T) {
  const o = createOpponent();
  o.maxHp = o.hp = T.hpMax.opponent;
  o.maxStamina = o.stamina = T.oppStaminaMax; // D12
  o.tired = 'fresh';
  o.splitUntil = -1; // D11
  o.tuckUntil = -1;
  return o;
}

// ───────────────────────────────────────────── phase changes

function setPhase(w, to) {
  const st = w.state;
  const from = st.phase;
  if (from === PHASE.PRACTICE && to !== PHASE.PRACTICE) st.practice = null;
  st.phase = to;
  st.phaseStart = st.time;
  w.emit(EVENT.PHASE, { from, to });
}

/** BOOT → CALIBRATION: the sim asks for session n+1; main calls source.beginCalibration on the phase event. */
export function enterCalibration(w) {
  w.state.calibSession += 1;
  setPhase(w, PHASE.CALIBRATION);
}

export function enterPractice(w) {
  const st = w.state;
  setPhase(w, PHASE.PRACTICE);
  st.practice = { timeLeft: w.T.practiceLength };
  st.round.clockRunning = false;
  st.round.countdown = null;
  toCircle(w, { resetCooldown: true });
  st.opponent.mitts = true;
  st.opponent.guard = 'none';
}

/** PRACTICE → FIGHT and MATCH_END → FIGHT: a fresh match (full HP and stamina, tallies cleared). */
export function startMatch(w) {
  const st = w.state;
  st.player = freshPlayer(w.T);
  st.opponent = freshOpponent(w.T);
  st.result = { winner: null, method: null };
  st.round.n = 1;
  st.round.of = w.T.roundCount;
  w.ctx.lastActionT = -Infinity;
  w.ctx.dealt = { player: 0, opponent: 0 };
  enterFight(w);
}

/** Enter FIGHT for round st.round.n: the 3-2-1 countdown runs first, then round_start. */
export function enterFight(w) {
  const st = w.state;
  const r = st.round;
  setPhase(w, PHASE.FIGHT);
  r.timeLeft = w.T.roundLength;
  r.clockRunning = false;
  r.countdown = w.T.countdownSeconds;
  w.ctx.countdownT0 = st.time;
  st.player.down = null;
  st.opponent.down = null;
  st.opponent.mitts = false;
  w.ctx.ai.cleanHits.length = 0;
  clearSplit(w);
  toCircle(w, { resetCooldown: true });
  if (r.countdown <= 0) startClock(w);
}

export function startClock(w) {
  const r = w.state.round;
  r.countdown = null;
  r.clockRunning = true;
  w.emit(EVENT.ROUND_START, { n: r.n });
  restartPressure(w); // D9a: the no-counter timer restarts at each round start
}

function endRound(w) {
  const st = w.state;
  const r = st.round;
  r.timeLeft = 0;
  r.clockRunning = false;
  w.emit(EVENT.ROUND_END, { n: r.n });
  if (r.n < r.of) {
    setPhase(w, PHASE.ROUND_END);
    toCircle(w);
  } else {
    endMatch(w, pointsWinner(st), 'points');
  }
}

/** Points are % of the opponent's max HP (D9); a tie goes to the player. */
function pointsWinner(st) {
  return st.player.points >= st.opponent.points ? 'player' : 'opponent';
}

export function endMatch(w, winner, method) {
  const st = w.state;
  st.round.clockRunning = false;
  st.round.countdown = null;
  st.result = { winner, method };
  setPhase(w, PHASE.MATCH_END);
  w.emit(EVENT.MATCH_END, { winner, method, points: { player: st.player.points, opponent: st.opponent.points } });
}

/** ROUND_END → FIGHT: rest healing per fighter (D9: player +15, Tamsin +25, capped), stamina refilled. */
function finishRest(w) {
  const st = w.state;
  const T = w.T;
  for (const who of ['player', 'opponent']) st[who].hp = Math.min(st[who].maxHp, st[who].hp + T.restHeal[who]);
  const p = st.player;
  p.stamina = p.maxStamina;
  p.gassedUntil = -1;
  p.guardBrokenUntil = -1;
  p.hurtUntil = -1;
  addOppStamina(w, T.oppRestStamina); // D12: +30 between rounds (no-op without features.body)
  st.round.n = Math.min(st.round.of, st.round.n + 1);
  enterFight(w);
}

/** Any phase → BOOT (cancel from calibration, or goto_phase boot): a fresh match state. */
export function enterBoot(w) {
  const st = w.state;
  setPhase(w, PHASE.BOOT);
  st.player = freshPlayer(w.T);
  st.opponent = freshOpponent(w.T);
  st.result = { winner: null, method: null };
  w.ctx.dealt = { player: 0, opponent: 0 };
  st.round = { n: 1, of: w.T.roundCount, timeLeft: w.T.roundLength, clockRunning: false, countdown: null, restLeft: null };
  st.practice = null;
  toCircle(w, { resetCooldown: true });
}

/** goto_phase (test/debug): jump to a phase and run its entry effects. */
export function gotoPhase(w, phase) {
  const st = w.state;
  switch (phase) {
    case PHASE.BOOT: enterBoot(w); break;
    case PHASE.CALIBRATION: enterCalibration(w); break;
    case PHASE.PRACTICE: enterPractice(w); break;
    case PHASE.FIGHT: enterFight(w); break; // full entry effects, including the 3-2-1 countdown (lead ruling)
    case PHASE.ROUND_END:
      st.round.clockRunning = false;
      st.round.countdown = null;
      setPhase(w, PHASE.ROUND_END);
      toCircle(w);
      break;
    case PHASE.MATCH_END:
      endMatch(w, pointsWinner(st), 'points');
      break;
    default:
      console.warn(`[sim] goto_phase: unknown phase ${phase}`);
  }
}

// ───────────────────────────────────────────── knockdown sub-state (FIGHT)

/**
 * HP reached 0. First knockdown of the match: count to 8, get up at 50% of max HP. Second: count to 10, KO.
 * The round clock pauses for the count, so the bell can never ring mid-count.
 */
export function knockdown(w, who) {
  const st = w.state;
  const f = st[who];
  const t = st.time;
  f.hp = 0;
  f.knockdowns += 1;
  f.down = { since: t, count: 0 };
  st.round.clockRunning = false;
  w.emit(EVENT.KNOCKDOWN, { who, count: f.knockdowns });
  clearSplit(w);
  toCircle(w); // cancels any attack in progress
  if (who === 'player' && playerRises(w)) initRise(w, f.knockdowns); // D12: hold a guard to rise
  if (who === 'opponent') {
    const o = st.opponent;
    o.state = OPP_STATE.KNOCKDOWN;
    o.guard = 'none';
    o.covering = false;
    o.freeHits = 0;
    o.stageStart = t;
    o.stageDur = countTarget(w, f) * w.T.countInterval;
  }
}

function countTarget(w, f) {
  return f.knockdowns >= 2 ? w.T.koCount : w.T.getupCount;
}

/** D12 (features.rise): the player rises by holding a guard; 3rd knockdown = KO. Tamsin keeps the auto get-up. */
function playerRises(w) {
  return w.on ? w.on('rise') : true;
}

function updatePlayerRise(w) {
  const st = w.state;
  const T = w.T;
  const f = st.player;
  updateRise(w, w.frame ?? {});
  const n = Math.floor((st.time - f.down.since) / T.countInterval + EPS);
  while (f.down && f.down.count < Math.min(n, T.koCount)) {
    f.down.count += 1;
    w.emit(EVENT.COUNT, { who: 'player', n: f.down.count });
    const d = riseDecision(w, f.down.count);
    if (d === 'ko') {
      endMatch(w, 'opponent', 'ko');
      return;
    }
    if (d === 'rise') {
      f.down = null;
      f.hp = riseHp(w);
      w.ctx.rise = null;
      w.emit(EVENT.GETUP, { who: 'player', hp: f.hp });
      st.round.clockRunning = true;
      restartPressure(w);
      toCircle(w, { resetCooldown: true });
      return;
    }
  }
}

function updateKnockdown(w, who) {
  if (who === 'player' && playerRises(w)) {
    updatePlayerRise(w);
    return;
  }
  const st = w.state;
  const T = w.T;
  const f = st[who];
  const target = countTarget(w, f);
  const n = Math.floor((st.time - f.down.since) / T.countInterval + EPS);
  while (f.down.count < Math.min(n, target)) {
    f.down.count += 1;
    w.emit(EVENT.COUNT, { who, n: f.down.count });
  }
  if (f.down.count < target) return;
  if (f.knockdowns >= 2) {
    endMatch(w, who === 'player' ? 'opponent' : 'player', 'ko');
    return;
  }
  f.down = null;
  f.hp = Math.round(T.getupHpFrac * f.maxHp);
  w.emit(EVENT.GETUP, { who, hp: f.hp });
  st.round.clockRunning = true;
  restartPressure(w); // D9a: … and after each get-up
  if (who === 'opponent') {
    const o = st.opponent;
    o.state = OPP_STATE.GETUP;
    o.stageStart = st.time;
    o.stageDur = T.opponentGetupDur;
    o.guard = 'none';
    o.covering = false;
    o.freeHits = 0;
    addOppStamina(w, Math.max(0, T.oppGetupStaminaMin - o.stamina)); // D12: max(current, 60)
  } else {
    toCircle(w, { resetCooldown: true });
  }
}

function updateFight(w, dt) {
  const st = w.state;
  const r = st.round;
  if (r.countdown !== null) {
    const n = w.T.countdownSeconds - Math.floor((st.time - w.ctx.countdownT0) + EPS);
    if (n <= 0) startClock(w);
    else r.countdown = n;
    return;
  }
  const down = st.player.down ? 'player' : st.opponent.down ? 'opponent' : null;
  if (down) {
    updateKnockdown(w, down);
    if (st.phase !== PHASE.FIGHT || st.player.down || st.opponent.down) return;
    // got up this tick: the clock runs on, so it is stopped for exactly getup.t − knockdown.t
  }
  if (!r.clockRunning) return;
  updatePressure(w); // live round ticks only (D9a)
  updateOpponent(w, dt);
  // the clock ticks after the AI, so a knockdown on this tick (punch or strike) never consumes clock time
  if (st.phase !== PHASE.FIGHT || !r.clockRunning) return;
  r.timeLeft = Math.max(0, r.timeLeft - dt);
  if (r.timeLeft <= EPS) endRound(w);
}

/**
 * Advance the current phase by one tick (not called while paused).
 * @param {object} w world
 */
export function updatePhase(w, dt) {
  const st = w.state;
  // A phase entered by a command this tick starts counting next tick, so timers run their full length.
  if (st.phaseStart >= st.time - EPS) return;
  switch (st.phase) {
    case PHASE.CALIBRATION: {
      const c = w.frame?.calibration;
      if (c && c.done && c.session === st.calibSession) enterPractice(w);
      break;
    }
    case PHASE.PRACTICE:
      st.practice.timeLeft = Math.max(0, st.practice.timeLeft - dt);
      if (st.practice.timeLeft <= EPS) startMatch(w);
      break;
    case PHASE.FIGHT:
      updateFight(w, dt);
      break;
    case PHASE.ROUND_END:
      if (st.time - st.phaseStart >= w.T.restLength - EPS) finishRest(w);
      break;
    default: // BOOT and MATCH_END wait for commands
      break;
  }
}
