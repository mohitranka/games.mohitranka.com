// game/sim.js — createSim(): command queue, fixed step, owns GameState, emits GameEvents
// (architecture §3.7). Owner: GE.
//
// One step:
//   1. tick += 1, time = tick · SIM_DT (time never drifts; every event this step carries this t)
//   2. apply queued commands (in order)
//   3. read the frame: inputKind, effective guard (D3), raw guard sample for the late block
//   4. unless paused: resolve punch events, advance the phase (AI, strikes, clocks), regen stamina
//   5. display flags; push the opponent snapshot
// Deterministic: the sim reads time only from the tick count and randomness only from rng.js.

import { SIM_DT, PHASE, COMMAND, DEBUG_COMMANDS, ATTACK, INPUT_EVENT, PUNCH } from '../shared/constants.js';
import { createInitialState, createInputFrame } from '../shared/fixtures.js';
import { tuning as defaultTuning } from './tuning.js';
import { createRng } from './rng.js';
import { EPS, regen, updateFlags } from './stamina.js';
import { resolvePlayerPunch, pushSnapshot, recordGuardSample, snapshotAt } from './combat.js';
import { resolveParry, parryLocked } from './defence.js';
import { createAIContext, forceAttack, forceSequence, toCircle, syncOpponent } from './opponent-ai.js';
import { createPressureContext } from './pressure.js';
import {
  freshPlayer, freshOpponent, enterCalibration, enterPractice, enterBoot, startMatch, gotoPhase, updatePhase,
} from './phases.js';

function createCtx(rng, T) {
  return {
    ring: [], // opponent snapshots (combat.js)
    guardSamples: [], // raw guard samples (combat.js)
    lastActionT: -Infinity, // last punch or block (stamina regen delay)
    dealt: { player: 0, opponent: 0 }, // raw damage dealt this match; state points are % of the other's maxHp (D9)
    countdownT0: 0,
    pausedAt: null,
    ai: createAIContext(rng, T),
    pressure: createPressureContext(),
  };
}

function initialState(seed, T) {
  const st = createInitialState(seed);
  st.player = freshPlayer(T);
  st.opponent = freshOpponent(T);
  st.round.of = T.roundCount;
  st.round.timeLeft = T.roundLength;
  return st;
}

function setPath(root, path, value) {
  const keys = String(path).split('.');
  let o = root;
  for (let i = 0; i < keys.length - 1; i++) {
    o = o?.[keys[i]];
    if (o == null || typeof o !== 'object') return false;
  }
  const last = keys.at(-1);
  if (!(last in o)) return false;
  o[last] = value;
  return true;
}

/**
 * @param {{seed?:number, tuning?:object, allowDebug?:boolean, features?:object}} [opts]
 *   features: main's frozen ?next=1 flags {uppercut, body, parry, rise, slip}; a feature is on unless false
 * @returns {import('../shared/types.js').Sim}
 */
export function createSim({ seed = 1, tuning = defaultTuning, allowDebug = false, features = {} } = {}) {
  const T = tuning;
  const on = (f) => features?.[f] !== false;
  const queue = [];
  const w = {
    T,
    on,
    state: null,
    ctx: null,
    rng: null,
    frame: null,
    out: [],
    emit(type, payload = {}) {
      w.out.push({ type, t: w.state.time, ...payload });
    },
  };

  function reset(s = w.state?.seed ?? seed) {
    w.rng = createRng(s);
    w.ctx = createCtx(w.rng, T);
    w.state = initialState(s, T);
    queue.length = 0;
  }

  /** MATCH_END → restart: reset(seed) but keep time, tick, calibration session and input kind. */
  function restart(s) {
    const old = w.state;
    reset(s ?? old.seed);
    Object.assign(w.state, {
      time: old.time, tick: old.tick, calibSession: old.calibSession, inputKind: old.inputKind,
      phase: old.phase, phaseStart: old.phaseStart,
    });
    startMatch(w);
  }

  // Pause freezes phase timers and the AI. On resume every absolute timestamp moves forward by the pause.
  function shiftTimes(d) {
    const st = w.state;
    const p = st.player;
    const o = st.opponent;
    const sh = (v) => (v > 0 || v === 0 ? v + d : v); // -1 / -Infinity mean "never"
    st.phaseStart += d;
    p.gassedUntil = sh(p.gassedUntil);
    p.guardBrokenUntil = sh(p.guardBrokenUntil);
    if (p.guardHeldSince >= 0) p.guardHeldSince += d;
    if (p.down) p.down.since += d;
    o.stageStart += d;
    if (o.contactAt !== null) o.contactAt += d;
    o.staggerImmuneUntil = sh(o.staggerImmuneUntil);
    o.splitUntil = sh(o.splitUntil); // D11
    o.tuckUntil = sh(o.tuckUntil);
    w.ctx.ai.splitStart = sh(w.ctx.ai.splitStart);
    if (o.down) o.down.since += d;
    w.ctx.lastActionT = sh(w.ctx.lastActionT);
    w.ctx.pressure.lastCounterT += d;
    w.ctx.countdownT0 += d;
    w.ctx.ai.cleanHits = w.ctx.ai.cleanHits.map((x) => x + d);
    if (w.ctx.ai.feintCancelAt !== null) w.ctx.ai.feintCancelAt += d;
    p.hurtUntil = sh(p.hurtUntil ?? -1); // D12
    w.ctx.parryLockUntil = sh(w.ctx.parryLockUntil ?? -1);
    w.ctx.unblockedHits = (w.ctx.unblockedHits ?? []).map((x) => x + d);
    if (w.ctx.rise) for (const k of ['holdStart', 'lastOk', 'doneAt']) if (w.ctx.rise[k] !== null) w.ctx.rise[k] += d;
    w.ctx.ai.feintCoverUntil = sh(w.ctx.ai.feintCoverUntil);
    w.ctx.ring.length = 0; // pre-pause snapshots and samples no longer line up with the shifted timeline
    w.ctx.guardSamples.length = 0;
  }

  function applyCommand(cmd) {
    const st = w.state;
    if (DEBUG_COMMANDS.includes(cmd.type) && !allowDebug) {
      console.warn(`[sim] ignoring debug command ${cmd.type} (allowDebug is off)`);
      return;
    }
    switch (cmd.type) {
      case COMMAND.START:
        if (st.phase !== PHASE.BOOT) break;
        if (w.frame?.calibration?.wanted) enterCalibration(w); // camera, or replay with {calibrate:true}
        else enterPractice(w);
        break;
      case COMMAND.CANCEL:
        if (st.phase === PHASE.CALIBRATION) enterBoot(w);
        break;
      case COMMAND.SKIP_PRACTICE:
        if (st.phase === PHASE.PRACTICE) startMatch(w);
        break;
      case COMMAND.PAUSE:
        if (!st.paused) {
          st.paused = true;
          w.ctx.pausedAt = st.time;
        }
        break;
      case COMMAND.RESUME:
        if (st.paused) {
          st.paused = false;
          shiftTimes(st.time - w.ctx.pausedAt);
          w.ctx.pausedAt = null;
        }
        break;
      case COMMAND.RESTART:
        if (st.phase === PHASE.MATCH_END) restart(cmd.seed);
        break;
      case COMMAND.GOTO_PHASE:
        gotoPhase(w, cmd.phase);
        break;
      case COMMAND.FORCE_ATTACK:
      case COMMAND.FORCE_SEQUENCE: {
        const blocked = st.phase !== PHASE.FIGHT ? `phase ${st.phase}`
          : st.player.down || st.opponent.down ? 'a knockdown count'
            : st.round.countdown !== null ? 'the pre-round countdown' : null;
        if (blocked) {
          console.warn(`[sim] ${cmd.type} ignored during ${blocked}`);
          break;
        }
        if (cmd.type === COMMAND.FORCE_ATTACK) {
          if (!Object.values(ATTACK).includes(cmd.attack)) console.warn(`[sim] force_attack: bad attack ${cmd.attack}`);
          else forceAttack(w, cmd.attack, cmd.side, cmd.combo);
        } else if (!forceSequence(w, cmd)) {
          console.warn(`[sim] force_sequence: invalid ${JSON.stringify(cmd)}`);
        }
        break;
      }
      case COMMAND.DEBUG_SET:
        if (!setPath(st, cmd.path, cmd.value)) console.warn(`[sim] debug_set: unknown path ${cmd.path}`);
        break;
      case COMMAND.SET_ROUND: {
        const n = Math.max(1, Math.min(st.round.of, cmd.n | 0));
        st.round.n = n;
        st.round.timeLeft = T.roundLength;
        if (st.phase === PHASE.FIGHT && !st.player.down && !st.opponent.down) toCircle(w, { resetCooldown: true });
        break;
      }
      default:
        console.warn(`[sim] unknown command ${cmd.type}`);
    }
  }

  /** A live round: FIGHT, clock running (not the countdown, a knockdown count or the rest). */
  function liveRound() {
    const st = w.state;
    return st.phase === PHASE.FIGHT && st.round.countdown === null && st.round.clockRunning;
  }

  function updateGuard(frame) {
    const st = w.state;
    const p = st.player;
    const t = st.time;
    // a guard break, or a missed parry's glove (D12), takes the guard down whatever the input says
    const broken = t < p.guardBrokenUntil - EPS || parryLocked(w);
    if (parryLocked(w) && frame.guard) frame.guard = { ...frame.guard, raw: false };
    const level = broken ? 'none' : frame.guard?.level === 'full' ? 'full' : 'none';
    if (level === 'full' && p.guard !== 'full') p.guardHeldSince = t;
    if (level !== 'full') p.guardHeldSince = -1;
    p.guard = level;
    recordGuardSample(w, frame);
  }

  reset(seed);

  return {
    get state() {
      return w.state;
    },
    step(frame, dt = SIM_DT) {
      const st0 = w.state;
      w.out = [];
      w.frame = frame ?? createInputFrame(st0.time + SIM_DT, 'none');
      st0.tick += 1;
      st0.time = st0.tick * SIM_DT;
      while (queue.length) applyCommand(queue.shift());
      const st = w.state; // restart replaces the state object
      st.inputKind = w.frame.source ?? 'none';
      updateGuard(w.frame);
      if (!st.paused) {
        // regen first, so the tick on which gassed ends already has stamina > 0 for a punch
        if (st.phase === PHASE.FIGHT && st.round.countdown === null) regen(w, dt);
        for (const ev of w.frame.events ?? []) {
          if (ev.type === INPUT_EVENT.PARRY) {
            if (on('parry') && liveRound()) resolveParry(w, ev, (h) => snapshotAt(w, h)); // D12, behind ?next=1
            continue;
          }
          if (ev.type !== INPUT_EVENT.PUNCH) continue;
          if (ev.punchType === PUNCH.UPPERCUT && !on('uppercut')) continue; // D11 is behind ?next=1
          resolvePlayerPunch(w, ev);
        }
        updatePhase(w, dt);
      }
      // round.restLeft: seconds remaining in the ROUND_END rest, else null (frozen while paused)
      const s2 = w.state;
      if (s2.phase !== PHASE.ROUND_END) s2.round.restLeft = null;
      else if (!s2.paused) s2.round.restLeft = Math.max(0, T.restLength - (s2.time - s2.phaseStart));
      updateFlags(w);
      if (w.state.phase === PHASE.FIGHT && !w.state.paused) syncOpponent(w);
      if (!w.state.paused) pushSnapshot(w);
      return w.out;
    },
    command(cmd) {
      if (!cmd || typeof cmd.type !== 'string') throw new Error('sim.command: expected {type}');
      queue.push(structuredClone(cmd));
    },
    reset(s) {
      reset(s);
    },
    snapshot() {
      return structuredClone(w.state);
    },
  };
}
