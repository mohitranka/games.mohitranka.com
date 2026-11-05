// dev/stubs.js — stand-ins for the game and view layers (architecture §5.3). Owner: PD.
// createStubSim: full Sim API on createInitialState(). With autoplay it loops through every phase, every
//   opponent state × attack × side, crosses the fatigued/lowHp lines and emits every §3.6 event in < 30 s.
//   It also answers real player punches (keyboard / inject) with punch_thrown, hit, blocked or whiff.
//   It is NOT the game: timings are compressed and rules are simplified (no backdating, no snapshot ring).
// createNullView / createNullAudio: no-op view and audio. createNullView({hudRoot}) prints a text readout.

import {
  PHASE, OPP_STATE, ATTACK, EVENT, COMMAND, DEBUG_COMMANDS, SIM_DT,
} from '../shared/constants.js';
import { createInitialState, createPlayer, createOpponent } from '../shared/fixtures.js';

/** Stub-only timings (seconds). Compressed so the autoplay loop stays under 30 s. */
export const STUB_TIMING = Object.freeze({
  boot: 0.5, calibration: 1, practice: 1, countdownStep: 1 / 3, round: 5, rest: 1, matchEnd: 1,
  countStep: 0.25, getup: 0.5, impactDelay: 0.1, strikeHold: 0.25, followJab: 0.3,
  hurt: 0.25, interruptStagger: 1, gassed: 1.2, guardBroken: 0.6, regenDelay: 0.7, regen: 14,
  damageScale: 2.5, // opponent damage × this, so one loop crosses lowHp and shows a player knockdown
});
const T = STUB_TIMING;
const WINDUP = { rope_snap: [0.55, 0.5, 0.45], swing_bridge: [0.8, 0.7, 0.65], anchor_drop: [1.3, 1.2, 1.1] };
const RECOVER = { rope_snap: 0.6, swing_bridge: 0.9, anchor_drop: 1.4 };
const DAMAGE = { rope_snap: [5, 0], swing_bridge: [12, 2], anchor_drop: [22, 5] }; // [hit, blocked]
const BLOCK_COST = { rope_snap: 3, swing_bridge: 8, anchor_drop: 30 };
const SHAKE = { rope_snap: 1, swing_bridge: 2, anchor_drop: 3 };
const TELEGRAPH_GUARD = { rope_snap: 'high', swing_bridge: 'low', anchor_drop: 'none' };
const DEFAULT_SIDE = { rope_snap: 'left', swing_bridge: 'left', anchor_drop: 'right' };

// Autoplay choreography per round; `at` is round-clock elapsed seconds.
// attack: started when she is next in circle. ghost: a scripted player punch. guard: her circle guard.
// set: debug assignment. ghostGuard[i]: the player "holds guard" for strike i of that attack.
const g = (hand, punchType, power, aimX = 0.5) => ({ hand, punchType, power, aimX });
const SCRIPT = [
  [
    { at: 0.1, attack: 'rope_snap', side: 'left', count: 2, ghostGuard: [true, false] },
    { at: 1.6, ghost: g('left', 'straight', 0.8) }, // counter in Recover
    { at: 2.0, guard: 'low' },
    { at: 2.2, ghost: g('right', 'hook', 0.7) }, // clean hit on low guard -> hurt + stagger
    { at: 2.5, attack: 'swing_bridge', side: 'right' }, // unguarded -> player_hit
  ],
  [
    { at: 0.1, attack: 'anchor_drop', side: 'right' },
    { at: 0.8, ghost: g('left', 'straight', 0.9) }, // interrupt
    { at: 1.85, guard: 'high' },
    { at: 1.9, ghost: g('right', 'straight', 0.6) }, // blocked by her high guard
    { at: 2.0, ghost: g('left', 'straight', 0.6, 0.05) }, // whiff (out of aim zone)
    { at: 2.1, set: { 'opponent.hp': 1 } },
    { at: 2.1, ghost: g('left', 'hook', 0.8) }, // knockdown -> count 1..8 -> getup
    { at: 3.0, attack: 'swing_bridge', side: 'left', ghostGuard: [true] }, // blocked
  ],
  [
    { at: 0.1, attack: 'anchor_drop', side: 'right', ghostGuard: [true] },
    { at: 1.25, set: { 'player.stamina': 20 } }, // block with < 30 stamina -> guard_broken
    { at: 1.55, set: { 'player.stamina': 15 } },
    { at: 1.6, ghost: g('left', 'straight', 1) },
    { at: 1.75, ghost: g('right', 'straight', 1) }, // -> gassed
    { at: 1.9, ghost: g('left', 'straight', 1) }, // -> punch_rejected
    { at: 2.6, attack: 'rope_snap', side: 'left', count: 3 }, // player knockdown
  ],
];

const r2 = (x) => Math.round(x * 100) / 100;

function setPath(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (o[keys[i]] == null || typeof o[keys[i]] !== 'object') throw new Error(`debug_set: bad path ${path}`);
    o = o[keys[i]];
  }
  o[keys.at(-1)] = value;
}

/**
 * @param {{seed?:number, allowDebug?:boolean, autoplay?:boolean}} [opts]
 * @returns {import('../shared/types.js').Sim}
 */
export function createStubSim({ seed = 1, allowDebug = false, autoplay = false } = {}) {
  let state = createInitialState(seed);
  const queue = [];
  let out = [];
  let frame = null;
  let ctx;
  let ghostId = -1;

  function freshCtx() {
    return {
      countdownT0: 0, roundElapsed: 0, scriptIdx: 0, circleGuard: 'high',
      ghostGuard: [], resolveAt: null, rawTicks: 0, lastActionT: -Infinity, countT0: 0,
    };
  }
  ctx = freshCtx();

  const now = () => state.time;
  const emit = (type, payload = {}) => out.push({ type, t: now(), ...payload });
  const roundIdx = () => Math.min(2, Math.max(0, state.round.n - 1));

  // ── phases
  function setPhase(to) {
    const from = state.phase;
    if (from === PHASE.PRACTICE) state.practice = null;
    if (from === PHASE.ROUND_END) state.round.restLeft = null;
    state.phase = to;
    state.phaseStart = now();
    emit(EVENT.PHASE, { from, to });
    if (to === PHASE.CALIBRATION) state.calibSession += 1;
    if (to === PHASE.PRACTICE) {
      state.practice = { timeLeft: T.practice };
      state.opponent.mitts = true;
    }
    if (to === PHASE.FIGHT) enterRound();
    if (to === PHASE.ROUND_END) {
      state.round.restLeft = T.rest;
      for (const f of [state.player, state.opponent]) f.hp = Math.min(f.maxHp, f.hp + 15);
      state.player.stamina = state.player.maxStamina;
      state.player.gassedUntil = -1;
    }
  }

  function enterRound({ skipCountdown = false } = {}) {
    const r = state.round;
    r.timeLeft = T.round;
    r.clockRunning = false;
    r.countdown = 3;
    ctx.countdownT0 = now();
    ctx.roundElapsed = 0;
    ctx.scriptIdx = 0;
    ctx.circleGuard = 'high';
    toCircle();
    state.opponent.mitts = false;
    if (skipCountdown) startClock();
  }

  function startClock() {
    state.round.countdown = null;
    state.round.clockRunning = true;
    emit(EVENT.ROUND_START, { n: state.round.n });
  }

  function startMatch() {
    state.player = createPlayer();
    state.opponent = createOpponent();
    state.result = { winner: null, method: null };
    state.round.n = 1;
    setPhase(PHASE.FIGHT);
  }

  function startCommand() {
    if (state.phase !== PHASE.BOOT) return;
    const toCalib = !!frame?.calibration?.wanted || autoplay;
    setPhase(toCalib ? PHASE.CALIBRATION : PHASE.PRACTICE);
  }

  function matchEnd(method, winner) {
    state.round.clockRunning = false;
    state.result = { winner, method };
    setPhase(PHASE.MATCH_END);
    emit(EVENT.MATCH_END, { winner, method });
  }

  function softResetToBoot() {
    const keep = { time: state.time, tick: state.tick, calibSession: state.calibSession, inputKind: state.inputKind };
    const from = state.phase;
    state = Object.assign(createInitialState(state.seed), keep, { phaseStart: keep.time });
    ctx = freshCtx();
    emit(EVENT.PHASE, { from, to: PHASE.BOOT });
  }

  // ── opponent
  function toCircle() {
    const o = state.opponent;
    Object.assign(o, {
      state: OPP_STATE.CIRCLE, attack: null, side: null, combo: { index: 0, count: 1 },
      opening: false, offBalance: false, contactAt: null, guard: ctx.circleGuard,
      stageStart: now(), stageDur: 0,
    });
    ctx.resolveAt = null;
  }

  function setStage(st, dur) {
    const o = state.opponent;
    o.state = st;
    o.stageStart = now();
    o.stageDur = dur;
  }

  function telegraph(windup) {
    const o = state.opponent;
    setStage(OPP_STATE.TELEGRAPH, windup);
    o.contactAt = now() + windup;
    o.guard = TELEGRAPH_GUARD[o.attack];
    emit(EVENT.TELEGRAPH, {
      attack: o.attack, side: o.side, windup, comboIndex: o.combo.index, comboCount: o.combo.count,
    });
  }

  function startAttack(attack, side, count = 1, ghostGuard = []) {
    const o = state.opponent;
    if (o.state !== OPP_STATE.CIRCLE) return false;
    o.attack = attack;
    o.side = side ?? DEFAULT_SIDE[attack];
    o.combo = { index: 0, count: attack === ATTACK.ROPE_SNAP ? Math.max(1, Math.min(3, count)) : 1 };
    ctx.ghostGuard = ghostGuard;
    telegraph(WINDUP[attack][roundIdx()]);
    return true;
  }

  function resolveStrike() {
    const o = state.opponent;
    const p = state.player;
    const a = o.attack;
    const ghost = !!ctx.ghostGuard[o.combo.index];
    const broken = now() < p.guardBrokenUntil;
    const guarded = (ghost || ctx.rawTicks >= 2) && !broken;
    if (guarded && a === ATTACK.ANCHOR_DROP && p.stamina < 30) {
      p.guardBrokenUntil = now() + T.guardBroken;
      emit(EVENT.GUARD_BROKEN, { until: p.guardBrokenUntil });
      damagePlayer(DAMAGE[a][0], a, o.side);
    } else if (guarded) {
      const cost = BLOCK_COST[a];
      p.stamina = Math.max(0, p.stamina - cost);
      ctx.lastActionT = now();
      emit(EVENT.BLOCKED, { by: 'opponent', hand: o.side, punchType: null, attack: a, staminaCost: cost });
      const dmg = DAMAGE[a][1] * T.damageScale;
      if (dmg > 0) applyDamage(p, state.opponent, dmg);
      if (p.hp <= 0) knockdown('player');
    } else {
      damagePlayer(DAMAGE[a][0], a, o.side);
    }
  }

  function applyDamage(target, attacker, dmg) {
    const applied = r2(Math.min(target.hp, dmg));
    target.hp = r2(target.hp - applied);
    attacker.points = r2(attacker.points + applied);
    return applied;
  }

  function damagePlayer(base, attack, side) {
    const applied = applyDamage(state.player, state.opponent, base * T.damageScale);
    emit(EVENT.PLAYER_HIT, { attack, side, damage: applied, shakeTier: SHAKE[attack] });
    if (state.player.hp <= 0) knockdown('player');
  }

  function updateOpponent() {
    const o = state.opponent;
    const t = now();
    switch (o.state) {
      case OPP_STATE.CIRCLE:
        o.guard = ctx.circleGuard;
        break;
      case OPP_STATE.TELEGRAPH:
        if (o.contactAt !== null && t >= o.contactAt - 1e-9) {
          emit(EVENT.STRIKE, { attack: o.attack, side: o.side, comboIndex: o.combo.index });
          setStage(OPP_STATE.ATTACK, T.strikeHold);
          o.stageStart = o.contactAt;
          ctx.resolveAt = o.contactAt + T.impactDelay;
          ctx.rawTicks = 0;
        }
        break;
      case OPP_STATE.ATTACK:
        if (ctx.resolveAt !== null) {
          if (frame?.guard?.raw) ctx.rawTicks += 1;
          if (t >= ctx.resolveAt - 1e-9) {
            ctx.resolveAt = null;
            resolveStrike();
            if (state.phase !== PHASE.FIGHT || o.state !== OPP_STATE.ATTACK) return; // knockdown happened
          }
        }
        if (t >= o.stageStart + o.stageDur - 1e-9 && ctx.resolveAt === null) {
          if (o.attack === ATTACK.ROPE_SNAP && o.combo.index + 1 < o.combo.count) {
            o.combo = { index: o.combo.index + 1, count: o.combo.count };
            telegraph(T.followJab);
          } else {
            const dur = RECOVER[o.attack];
            setStage(OPP_STATE.RECOVER, dur);
            o.opening = true;
            o.offBalance = o.attack === ATTACK.ANCHOR_DROP;
            o.guard = 'none';
            o.contactAt = null;
            emit(EVENT.OPENING, { dur });
          }
        }
        break;
      case OPP_STATE.RECOVER:
      case OPP_STATE.HURT:
      case OPP_STATE.GETUP:
        if (t >= o.stageStart + o.stageDur - 1e-9) toCircle();
        break;
      default:
        break;
    }
  }

  // ── knockdowns
  function knockdown(who) {
    const f = state[who];
    f.hp = 0;
    f.knockdowns += 1;
    f.down = { since: now(), count: 0 };
    state.round.clockRunning = false;
    ctx.countT0 = now();
    emit(EVENT.KNOCKDOWN, { who, count: f.knockdowns });
    toCircle();
    if (who === 'opponent') setStage(OPP_STATE.KNOCKDOWN, 0);
  }

  function updateKnockdown(who) {
    const f = state[who];
    const target = f.knockdowns >= 2 ? 10 : 8;
    const n = Math.floor((now() - ctx.countT0) / T.countStep + 1e-9);
    while (f.down.count < Math.min(n, target)) {
      f.down.count += 1;
      emit(EVENT.COUNT, { who, n: f.down.count });
    }
    if (f.down.count < target) return;
    if (f.knockdowns >= 2) {
      matchEnd('ko', who === 'player' ? 'opponent' : 'player');
      return;
    }
    f.down = null;
    f.hp = 50;
    emit(EVENT.GETUP, { who, hp: 50 });
    state.round.clockRunning = true;
    if (who === 'opponent') setStage(OPP_STATE.GETUP, T.getup);
  }

  // ── player
  function handlePunch(ev) {
    const p = state.player;
    const o = state.opponent;
    const t = now();
    const { id, hand, punchType, power } = ev;
    const live = state.phase === PHASE.FIGHT && state.round.clockRunning;
    if (live && t < p.gassedUntil) {
      emit(EVENT.PUNCH_REJECTED, { id, hand, reason: 'gassed' });
      return;
    }
    emit(EVENT.PUNCH_THROWN, { id, hand, punchType, power, inferred: !!ev.inferred });
    if (!live) return; // outside a running round the stub only acknowledges punches
    p.stats.thrown += 1;
    p.stamina = Math.max(0, r2(p.stamina - (5 + 7 * power)));
    ctx.lastActionT = t;
    if (p.stamina <= 0) {
      p.gassedUntil = t + T.gassed;
      emit(EVENT.GASSED, { until: p.gassedUntil });
    }
    const aimX = ev.aim?.x ?? 0.5;
    const downOrUp = o.state === OPP_STATE.KNOCKDOWN || o.state === OPP_STATE.GETUP;
    if (downOrUp || (punchType === 'straight' && (aimX < 0.2 || aimX > 0.8))) {
      p.stamina = Math.max(0, p.stamina - 4);
      p.stats.whiffed += 1;
      emit(EVENT.WHIFF, { by: 'player', id, hand, punchType });
      return;
    }
    let M = 1;
    let counter = false;
    let interrupt = false;
    let clean = true;
    if (o.state === OPP_STATE.TELEGRAPH && o.attack === ATTACK.ANCHOR_DROP && punchType === 'straight' &&
        power >= 0.5 && t >= o.contactAt - 0.6 && t <= o.contactAt - 0.08) {
      M = 2;
      interrupt = true;
    } else if (o.state === OPP_STATE.RECOVER) {
      M = 1.5;
      counter = true;
    } else if ((o.state === OPP_STATE.CIRCLE || o.state === OPP_STATE.TELEGRAPH) && o.guard === 'high') {
      if (punchType === 'straight') {
        p.stats.blocked += 1;
        emit(EVENT.BLOCKED, { by: 'player', hand, punchType, attack: null, staminaCost: 0 });
        return;
      }
      M = 0.7;
      clean = false;
    }
    const base = punchType === 'hook' ? 10 : 7;
    const dmg = base * (0.5 + 0.5 * power) * (p.fatigued ? 0.5 : 1) * M;
    const applied = applyDamage(o, p, dmg);
    p.stats.landed += 1;
    if (counter) p.stats.counters += 1;
    if (interrupt) p.stats.interrupts += 1;
    emit(EVENT.HIT, { by: 'player', hand, punchType, power, damage: applied, counter, interrupt });
    if (o.hp <= 0) {
      knockdown('opponent');
      return;
    }
    if (interrupt) {
      emit(EVENT.STAGGER, { who: 'opponent', dur: T.interruptStagger, interrupt: true });
      toCircle();
      setStage(OPP_STATE.HURT, T.interruptStagger);
    } else if (clean && o.state === OPP_STATE.CIRCLE && t >= o.staggerImmuneUntil) {
      emit(EVENT.STAGGER, { who: 'opponent', dur: T.hurt, interrupt: false });
      setStage(OPP_STATE.HURT, T.hurt);
      o.guard = 'low';
    }
  }

  function updatePlayer(dt) {
    const p = state.player;
    const t = now();
    const broken = t < p.guardBrokenUntil;
    const level = broken ? 'none' : (frame?.guard?.level ?? 'none');
    if (level === 'full' && p.guard !== 'full') p.guardHeldSince = t;
    if (level !== 'full') p.guardHeldSince = -1;
    p.guard = level;
    if (state.phase === PHASE.FIGHT && state.round.clockRunning && t >= p.gassedUntil &&
        t - ctx.lastActionT >= T.regenDelay) {
      p.stamina = Math.min(p.maxStamina, r2(p.stamina + T.regen * dt * (p.guard === 'full' ? 0.5 : 1)));
    }
    p.fatigued = p.stamina < 25;
    p.lowHp = p.hp < 25;
  }

  // ── script
  function runScript() {
    const entries = SCRIPT[roundIdx()];
    while (ctx.scriptIdx < entries.length && entries[ctx.scriptIdx].at <= ctx.roundElapsed + 1e-9) {
      const e = entries[ctx.scriptIdx];
      if (e.attack) {
        if (!startAttack(e.attack, e.side, e.count, e.ghostGuard)) return; // wait until she is in circle
      } else if (e.guard) {
        ctx.circleGuard = e.guard;
        if (state.opponent.state === OPP_STATE.CIRCLE) state.opponent.guard = e.guard;
      } else if (autoplay && e.set) {
        for (const [k, v] of Object.entries(e.set)) setPath(state, k, v);
      } else if (autoplay && e.ghost) {
        handlePunch({ id: ghostId--, hand: e.ghost.hand, punchType: e.ghost.punchType, power: e.ghost.power, aim: { x: e.ghost.aimX } });
      }
      ctx.scriptIdx += 1;
      if (state.phase !== PHASE.FIGHT) return;
    }
  }

  function updateFight(dt) {
    const r = state.round;
    if (r.countdown !== null) {
      const n = 3 - Math.floor((now() - ctx.countdownT0) / T.countdownStep + 1e-9);
      if (n <= 0) startClock();
      else r.countdown = n;
      return;
    }
    const down = state.player.down ? 'player' : state.opponent.down ? 'opponent' : null;
    if (down) {
      updateKnockdown(down);
      return;
    }
    if (!r.clockRunning) return;
    r.timeLeft = Math.max(0, r2(r.timeLeft - dt));
    ctx.roundElapsed += dt;
    runScript();
    if (state.phase !== PHASE.FIGHT || !r.clockRunning) return;
    updateOpponent();
    if (state.phase !== PHASE.FIGHT) return;
    if (r.timeLeft <= 0) {
      r.clockRunning = false;
      emit(EVENT.ROUND_END, { n: r.n });
      if (r.n < r.of) setPhase(PHASE.ROUND_END);
      else {
        const winner = state.player.points >= state.opponent.points ? 'player' : 'opponent';
        matchEnd('points', winner);
      }
    }
  }

  function updatePhase(dt) {
    const elapsed = now() - state.phaseStart;
    switch (state.phase) {
      case PHASE.BOOT:
        if (autoplay && elapsed >= T.boot) startCommand();
        break;
      case PHASE.CALIBRATION: {
        const c = frame?.calibration;
        const done = c && c.done && c.session === state.calibSession;
        if (done || (autoplay && elapsed >= T.calibration)) setPhase(PHASE.PRACTICE);
        break;
      }
      case PHASE.PRACTICE:
        state.practice.timeLeft = Math.max(0, r2(state.practice.timeLeft - dt));
        if (state.practice.timeLeft <= 0) startMatch();
        break;
      case PHASE.FIGHT:
        updateFight(dt);
        break;
      case PHASE.ROUND_END:
        state.round.restLeft = Math.max(0, r2(T.rest - elapsed));
        if (elapsed >= T.rest - 1e-9) {
          state.round.n += 1;
          setPhase(PHASE.FIGHT);
        }
        break;
      case PHASE.MATCH_END:
        if (autoplay && elapsed >= T.matchEnd) softResetToBoot();
        break;
      default:
        break;
    }
  }

  // ── commands
  function applyCommand(cmd) {
    if (DEBUG_COMMANDS.includes(cmd.type) && !allowDebug) {
      console.warn(`[stub sim] ignoring debug command ${cmd.type} (allowDebug is off)`);
      return;
    }
    switch (cmd.type) {
      case COMMAND.START: startCommand(); break;
      case COMMAND.CANCEL: if (state.phase === PHASE.CALIBRATION) setPhase(PHASE.BOOT); break;
      case COMMAND.SKIP_PRACTICE: if (state.phase === PHASE.PRACTICE) startMatch(); break;
      case COMMAND.PAUSE: state.paused = true; break;
      case COMMAND.RESUME: state.paused = false; break;
      case COMMAND.RESTART:
        if (cmd.seed !== undefined) state.seed = cmd.seed;
        startMatch();
        break;
      case COMMAND.GOTO_PHASE:
        if (!Object.values(PHASE).includes(cmd.phase)) throw new Error(`goto_phase: unknown phase ${cmd.phase}`);
        setPhase(cmd.phase);
        if (cmd.phase === PHASE.FIGHT) startClock(); // stub: tests get a running clock right away
        break;
      case COMMAND.FORCE_ATTACK:
        if (state.phase !== PHASE.FIGHT) break;
        if (state.round.countdown !== null) startClock();
        toCircle();
        startAttack(cmd.attack, cmd.side, cmd.combo ?? 1);
        break;
      case COMMAND.DEBUG_SET: setPath(state, cmd.path, cmd.value); break;
      case COMMAND.SET_ROUND:
        state.round.n = cmd.n;
        state.round.timeLeft = T.round;
        ctx.scriptIdx = 0;
        ctx.roundElapsed = 0;
        break;
      default:
        console.warn(`[stub sim] unknown command ${cmd.type}`);
    }
  }

  const sim = {
    get state() {
      return state;
    },
    step(f, dt = SIM_DT) {
      out = [];
      frame = f;
      while (queue.length) applyCommand(queue.shift());
      state.tick += 1;
      state.time = state.tick * SIM_DT;
      state.inputKind = f?.source ?? 'none';
      for (const ev of f?.events ?? []) if (ev.type === 'punch') handlePunch(ev);
      if (!state.paused) updatePhase(dt);
      updatePlayer(state.paused ? 0 : dt);
      return out;
    },
    command(cmd) {
      queue.push(cmd);
    },
    reset(s = state.seed) {
      state = createInitialState(s);
      ctx = freshCtx();
      queue.length = 0;
    },
    snapshot() {
      return structuredClone(state);
    },
  };
  return sim;
}

/**
 * No-op renderer. With hudRoot it prints a compact text readout (useful for GE with ?stub=view).
 * @param {{hudRoot?: HTMLElement|null}} [opts]
 * @returns {import('../shared/types.js').Renderer}
 */
export function createNullView({ hudRoot = null } = {}) {
  let pre = null;
  const recent = [];
  if (hudRoot) {
    pre = document.createElement('pre');
    pre.className = 'stub-view';
    hudRoot.appendChild(pre);
  }
  return {
    update(state, events) {
      if (!pre) return;
      for (const e of events) recent.push(e);
      if (recent.length > 10) recent.splice(0, recent.length - 10);
      const p = state.player;
      const o = state.opponent;
      const r = state.round;
      pre.textContent = [
        `[stub view] phase ${state.phase}  t ${state.time.toFixed(2)}  tick ${state.tick}${state.paused ? '  PAUSED' : ''}`,
        `round ${r.n}/${r.of}  left ${r.timeLeft.toFixed(1)}  countdown ${r.countdown ?? '-'}  clock ${r.clockRunning ? 'on' : 'off'}`,
        `player  hp ${p.hp}  sta ${p.stamina.toFixed(0)}  guard ${p.guard}${p.fatigued ? ' fatigued' : ''}${p.lowHp ? ' lowHp' : ''}  kd ${p.knockdowns}${p.down ? ` DOWN ${p.down.count}` : ''}  pts ${p.points}`,
        `tamsin  hp ${o.hp}  ${o.state} ${o.attack ?? ''} ${o.side ?? ''}  guard ${o.guard}${o.opening ? ' OPEN' : ''}  kd ${o.knockdowns}${o.down ? ` DOWN ${o.down.count}` : ''}`,
        ...recent.map((e) => `  ${e.t.toFixed(2)} ${e.type} ${JSON.stringify({ ...e, type: undefined, t: undefined })}`),
      ].join('\n');
    },
    resize() {},
    onCommand() {},
    stats() {
      return { fps: 0, drawCalls: 0, triangles: 0 };
    },
    dispose() {
      pre?.remove();
    },
  };
}

/** @returns {import('../shared/types.js').Audio} */
export function createNullAudio() {
  return {
    async unlock() {},
    handle() {},
    setMuted() {},
    setVolume() {},
    dispose() {},
  };
}
