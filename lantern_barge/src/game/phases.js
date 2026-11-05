// game/phases.js — the phase machine (architecture §3.5 transition table) and the knockdown sub-state
// (GDD §2, decisions D5/D5a). Owner: GE.

import { EVENT, PHASE, OPP_STATE } from '../shared/constants.js';
import { createPlayer, createOpponent } from '../shared/fixtures.js';
import { EPS } from './stamina.js';
import { toCircle, updateOpponent } from './opponent-ai.js';

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
  p.maxHp = p.hp = T.hpMax;
  p.maxStamina = p.stamina = T.staminaMax;
  return p;
}

export function freshOpponent(T) {
  const o = createOpponent();
  o.maxHp = o.hp = T.hpMax;
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
  toCircle(w, { resetCooldown: true });
  if (r.countdown <= 0) startClock(w);
}

export function startClock(w) {
  const r = w.state.round;
  r.countdown = null;
  r.clockRunning = true;
  w.emit(EVENT.ROUND_START, { n: r.n });
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
    // points = total damage dealt; a tie goes to the player (D5)
    endMatch(w, st.player.points >= st.opponent.points ? 'player' : 'opponent', 'points');
  }
}

export function endMatch(w, winner, method) {
  const st = w.state;
  st.round.clockRunning = false;
  st.round.countdown = null;
  st.result = { winner, method };
  setPhase(w, PHASE.MATCH_END);
  w.emit(EVENT.MATCH_END, { winner, method });
}

/** ROUND_END → FIGHT: +15 HP each (capped), stamina refilled, then round n+1 with its countdown. */
function finishRest(w) {
  const st = w.state;
  const T = w.T;
  for (const f of [st.player, st.opponent]) f.hp = Math.min(f.maxHp, f.hp + T.restHeal);
  const p = st.player;
  p.stamina = p.maxStamina;
  p.gassedUntil = -1;
  p.guardBrokenUntil = -1;
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
      endMatch(w, st.player.points >= st.opponent.points ? 'player' : 'opponent', 'points');
      break;
    default:
      console.warn(`[sim] goto_phase: unknown phase ${phase}`);
  }
}

// ───────────────────────────────────────────── knockdown sub-state (FIGHT)

/**
 * HP reached 0. First knockdown of the match: count to 8, get up with 50 HP. Second: count to 10, KO.
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
  toCircle(w); // cancels any attack in progress
  if (who === 'opponent') {
    const o = st.opponent;
    o.state = OPP_STATE.KNOCKDOWN;
    o.guard = 'none';
    o.stageStart = t;
    o.stageDur = countTarget(w, f) * w.T.countInterval;
  }
}

function countTarget(w, f) {
  return f.knockdowns >= 2 ? w.T.koCount : w.T.getupCount;
}

function updateKnockdown(w, who) {
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
  f.hp = T.getupHp;
  w.emit(EVENT.GETUP, { who, hp: f.hp });
  st.round.clockRunning = true;
  if (who === 'opponent') {
    const o = st.opponent;
    o.state = OPP_STATE.GETUP;
    o.stageStart = st.time;
    o.stageDur = T.opponentGetupDur;
    o.guard = 'none';
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
