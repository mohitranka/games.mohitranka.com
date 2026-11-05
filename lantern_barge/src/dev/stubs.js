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
import { NO_FEATURES } from '../shared/features.js';

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
const DEFAULT_SIDE = { rope_snap: 'left', swing_bridge: 'left', anchor_drop: 'right' };
const COUNTER_MULT = 1.25; // D9
const HOOK_VS_HIGH = 0.5; // D9
const REST_HEAL = { player: 15, opponent: 25 }; // D9
// D12 (stub numbers from game-design §13)
const ATTACK_STAMINA = { rope_snap: 2, swing_bridge: 4, anchor_drop: 8, feint: 1 };
const OPP_REGEN = 3; // /s in Circle
const PARRY_WINDOW = [0.35, 0.237]; // onset in [contact − 0.35, contact − 0.237]
const RIPOSTE_MULT = 1.5;
const RISE = [null, { hold: 2.0, hp: 50 }, { hold: 3.5, hp: 30 }]; // player's 1st / 2nd knockdown; 3rd = KO
// D9 combos: strikes with the contact-to-contact gap before each follow-up
const COMBOS = {
  snap_drop: [{ attack: 'rope_snap', side: 'left' }, { attack: 'anchor_drop', side: 'right', gap: 0.9 }],
  bridge_snap: [{ attack: 'swing_bridge', side: 'right' }, { attack: 'rope_snap', side: 'left', gap: 0.3 }, { attack: 'rope_snap', side: 'left', gap: 0.3 }],
  double_bridge: [{ attack: 'swing_bridge', side: 'left' }, { attack: 'swing_bridge', side: 'right', gap: 0.5 }],
};

// Autoplay choreography per round; `at` is round-clock elapsed seconds.
// attack: started when she is next in circle. ghost: a scripted player punch. guard: her circle guard.
// set: debug assignment. ghostGuard[i]: the player "holds guard" for strike i of that attack.
const g = (hand, punchType, power, aimX = 0.5) => ({ hand, punchType, power, aimX });
const SCRIPT = [
  [
    { at: 0.1, attack: 'rope_snap', side: 'left', count: 2, ghostGuard: [true, false] },
    { at: 0.35, parry: 'right', feature: 'parry' }, // D12: her left jab → the player's right glove parries; riposte next
    { at: 0.6, ghost: g('left', 'straight', 0.8), feature: 'parry' }, // D12 riposte (M 1.5)
    { at: 1.6, ghost: g('left', 'straight', 0.8) }, // counter in Recover
    { at: 2.0, guard: 'low' },
    { at: 2.2, ghost: g('right', 'hook', 0.7) }, // clean hit on low guard -> hurt + stagger
    { at: 2.45, parry: 'left', feature: 'parry' }, // D12: nothing to parry → parry{whiff}
    { at: 2.5, attack: 'swing_bridge', side: 'right' }, // unguarded -> player_hit (D12: 12 dmg → player_hurt)
  ],
  [
    { at: 0.1, attack: 'anchor_drop', side: 'right' },
    { at: 0.8, ghost: g('left', 'straight', 0.9) }, // interrupt
    { at: 1.85, guard: 'high' },
    { at: 1.9, ghost: g('right', 'straight', 0.6) }, // blocked by her high guard
    { at: 1.95, ghost: g('left', 'uppercut', 0.8) }, // D11: splits her high guard (guard_split), then a 4 s tuck
    { at: 2.0, ghost: g('left', 'straight', 0.6, 0.05) }, // whiff (out of aim zone)
    { at: 2.1, set: { 'opponent.hp': 1 } },
    { at: 2.1, ghost: g('left', 'hook', 0.8) }, // knockdown -> count 1..8 -> getup
    { at: 2.9, ghost: g('right', 'uppercut', 0.6) }, // D11: she is tucked → the uppercut is blocked (+6 stamina)
    { at: 2.95, set: { 'opponent.stamina': 45 }, feature: 'body' }, // D12: → opponent_tired{tired}
    // D9: a feinted Swing Bridge, cancelled at 50 %, punished by a jab 450 ms after the cancel (blocked)
    { at: 3.0, attack: 'swing_bridge', side: 'left', kind: 'feint', punish: true, ghostGuard: [true] },
  ],
  [
    { at: 0.05, pressure: true }, // D9a: turtle pressure on; the counters in this Recover turn it off
    { at: 0.1, attack: 'anchor_drop', side: 'right', ghostGuard: [true] },
    { at: 1.25, set: { 'player.stamina': 20 } }, // block with < 30 stamina -> guard_broken
    { at: 1.55, set: { 'player.stamina': 15 } },
    { at: 1.58, set: { 'opponent.stamina': 22 }, feature: 'body' },
    { at: 1.6, ghost: { ...g('left', 'straight', 1), target: 'body' } }, // D12 (with ?next=1): a body counter → exhausted
    { at: 1.75, ghost: g('right', 'straight', 1) }, // -> gassed
    { at: 1.9, ghost: g('left', 'straight', 1) }, // -> punch_rejected
    { at: 2.55, set: { 'player.hp': 5 }, feature: 'rise' }, // D12: make sure the combo floors the player (hold-guard rise)
    { at: 2.6, kind: 'combo', combo: 'bridge_snap' }, // D9 combo; its first hit knocks the player down
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
 * @param {{seed?:number, allowDebug?:boolean, autoplay?:boolean, features?:object}} [opts]
 * @returns {import('../shared/types.js').Sim}
 */
export function createStubSim({ seed = 1, allowDebug = false, autoplay = false, features = NO_FEATURES } = {}) {
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
      seq: null, dealt: { player: 0, opponent: 0 },
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
      state.player.hp = Math.min(state.player.maxHp, state.player.hp + REST_HEAL.player);
      state.opponent.hp = Math.min(state.opponent.maxHp, state.opponent.hp + REST_HEAL.opponent);
      if (features.body) setOppStamina(state.opponent.stamina + 30); // D12
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
    emit(EVENT.MATCH_END, { winner, method, points: { player: state.player.points, opponent: state.opponent.points } });
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
      stageStart: now(), stageDur: 0, feint: false, covering: false,
      freeHits: ctx.circleGuard === 'low' ? 1 : 0, sequence: { kind: 'single', combo: null },
    });
    ctx.resolveAt = null;
    ctx.seq = null;
    ctx.riposte = false;
  }

  /** D12: her stamina and tiredness level (opponent_tired on a level change). */
  function setOppStamina(v) {
    const o = state.opponent;
    o.stamina = Math.max(0, Math.min(o.maxStamina, r2(v)));
    const level = o.stamina < 20 ? 'exhausted' : o.stamina < 50 ? 'tired' : 'fresh';
    if (level !== o.tired) {
      o.tired = level;
      emit(EVENT.OPPONENT_TIRED, { level });
    }
  }

  const d12 = () => features.body || features.parry || features.rise;

  /** D12: the player is hurt (refreshes to the longer value, never stacks). */
  function hurt(cause, attack) {
    if (!d12()) return;
    const p = state.player;
    const until = now() + (cause === 'guard_break' || attack === ATTACK.ANCHOR_DROP ? 1.5 : 1.0);
    p.hurtUntil = Math.max(p.hurtUntil, until);
    emit(EVENT.PLAYER_HURT, { until: p.hurtUntil, cause });
  }

  /** D12: a parry input (camera swipe or A / ;). Success needs a jab / Swing Bridge on that side, in the window. */
  function handleParry(ev) {
    if (!features.parry || state.phase !== PHASE.FIGHT || !state.round.clockRunning) return;
    const o = state.opponent;
    const p = state.player;
    if (now() < p.hurtUntil) return; // parry is disabled while hurt
    const side = ev.hand === 'right' ? 'left' : 'right'; // her left hand → the player's right glove
    const parryable = o.state === OPP_STATE.TELEGRAPH && !o.feint && o.side === side &&
      (o.attack === ATTACK.ROPE_SNAP || o.attack === ATTACK.SWING_BRIDGE) &&
      ev.tOnset >= o.contactAt - PARRY_WINDOW[0] - 1e-9 && ev.tOnset <= o.contactAt - PARRY_WINDOW[1] + 1e-9;
    if (!parryable) {
      emit(EVENT.PARRY, { result: 'whiff', attack: null, hand: ev.hand });
      return;
    }
    const attack = o.attack;
    p.stats.parries += 1;
    emit(EVENT.PARRY, { result: 'success', attack, hand: ev.hand });
    toCircle(); // the rest of her sequence is cancelled
    setStage(OPP_STATE.RECOVER, 0.5);
    o.opening = true;
    o.guard = 'none';
    o.freeHits = 1;
    ctx.riposte = true;
    emit(EVENT.OPENING, { dur: 0.5, freeHits: 1 });
  }

  /** D9a: pressure on/off (the real rule lives in game/pressure.js; the stub scripts it). */
  function setPressure(on) {
    if (state.player.pressured === on) return;
    state.player.pressured = on;
    emit(EVENT.PRESSURE, { on });
  }

  /** D9: free hits used up → she covers up (guard high for the rest of the window). */
  function coverUp(reason) {
    const o = state.opponent;
    o.covering = true;
    o.guard = 'high';
    if (reason === 'circle') ctx.circleGuard = 'high';
    emit(EVENT.COVER, { reason });
  }

  function setStage(st, dur) {
    const o = state.opponent;
    o.state = st;
    o.stageStart = now();
    o.stageDur = dur;
  }

  function telegraph(windup) {
    const o = state.opponent;
    const q = ctx.seq;
    setStage(OPP_STATE.TELEGRAPH, windup);
    o.contactAt = now() + windup;
    o.guard = 'high'; // D9: high during every telegraph; an Anchor Drop opens at its interrupt window
    o.covering = false;
    o.freeHits = 0;
    emit(EVENT.TELEGRAPH, {
      attack: o.attack, side: o.side, windup, comboIndex: o.combo.index, comboCount: o.combo.count,
      feint: o.feint, combo: q?.combo ?? null, afterFeint: !!q?.afterFeint,
    });
  }

  /**
   * Start a sequence (D9). kind: 'single' (rope snap may have count jabs), 'feint' (swing_bridge | anchor_drop,
   * optional punish), 'punish' (rope snap after a feint), 'combo' (snap_drop | bridge_snap | double_bridge).
   */
  function startSequence({ kind = 'single', attack, side, count = 1, combo = null, punish = false, afterFeint = false, windup, ghostGuard = [] }) {
    const o = state.opponent;
    if (o.state !== OPP_STATE.CIRCLE) return false;
    if (o.covering && o.stageDur > 0 && now() < o.stageStart + o.stageDur) return false; // post-feint cover (300 ms)
    let strikes;
    if (kind === 'combo') strikes = COMBOS[combo].map((s) => ({ ...s }));
    else {
      const n = attack === ATTACK.ROPE_SNAP ? Math.max(1, Math.min(3, count)) : 1;
      strikes = Array.from({ length: n }, (_, i) => ({ attack, side: side ?? DEFAULT_SIDE[attack], gap: i ? null : undefined }));
    }
    ctx.seq = { kind, combo: kind === 'combo' ? combo : null, strikes, punish, afterFeint, cancelAt: null };
    if (features.body) {
      // D12: her attacks cost stamina (per jab for Rope Snap; a feint costs 1)
      const cost = kind === 'feint' ? ATTACK_STAMINA.feint : strikes.reduce((a, s) => a + ATTACK_STAMINA[s.attack], 0);
      setOppStamina(state.opponent.stamina - cost);
    }
    ctx.ghostGuard = ghostGuard;
    o.sequence = { kind, combo: ctx.seq.combo };
    o.feint = kind === 'feint';
    o.attack = strikes[0].attack;
    o.side = strikes[0].side;
    o.combo = { index: 0, count: strikes.length };
    const w = windup ?? WINDUP[o.attack][roundIdx()];
    telegraph(w);
    if (o.feint) ctx.seq.cancelAt = now() + (o.attack === ATTACK.SWING_BRIDGE ? 0.5 * w : w - 0.7);
    return true;
  }

  function startAttack(attack, side, count = 1, ghostGuard = []) {
    return startSequence({ kind: 'single', attack, side, count, ghostGuard });
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
      damagePlayer(DAMAGE[a][0], a, o.side, 'guard_break');
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
    const key = attacker === state.player ? 'player' : 'opponent';
    ctx.dealt[key] += applied;
    // D9: points = 100 × damage dealt / the other fighter's maxHp, overkill excluded, 0.1 steps
    attacker.points = Math.round((1000 * ctx.dealt[key]) / target.maxHp) / 10;
    return applied;
  }

  function damagePlayer(base, attack, side, cause = null) {
    const applied = applyDamage(state.player, state.opponent, base * T.damageScale);
    emit(EVENT.PLAYER_HIT, { attack, side, damage: applied, shakeTier: SHAKE[attack] });
    if (state.player.hp <= 0) {
      knockdown('player');
      return;
    }
    // D12 hurt: a guard break, an unblocked strike of ≥ 12 (base) damage, or 2 unblocked strikes within 1.5 s
    const t = now();
    if (cause === 'guard_break') hurt('guard_break', attack);
    else if (base >= 12) hurt('big_hit', attack);
    else if (t - (ctx.lastUnblockedT ?? -Infinity) <= 1.5) hurt('two_hits', attack);
    ctx.lastUnblockedT = t;
  }

  function updateOpponent() {
    const o = state.opponent;
    const t = now();
    switch (o.state) {
      case OPP_STATE.CIRCLE:
        if (features.body && o.stamina < o.maxStamina) setOppStamina(o.stamina + OPP_REGEN * SIM_DT); // D12 regen
        if (o.covering && o.stageDur > 0 && t >= o.stageStart + o.stageDur - 1e-9) {
          o.covering = false; // the post-feint cover lasts 300 ms
          o.stageDur = 0;
        }
        o.guard = o.covering ? 'high' : t < o.splitUntil ? 'low' : ctx.circleGuard;
        break;
      case OPP_STATE.TELEGRAPH:
        if (o.feint && ctx.seq && t >= ctx.seq.cancelAt - 1e-9) {
          // D9: the feint is cancelled before any interrupt window; high guard for 300 ms, maybe a punish
          const { attack, side } = o;
          const punish = ctx.seq.punish;
          emit(EVENT.FEINT_CANCEL, { attack, side });
          toCircle();
          if (punish) {
            startSequence({ kind: 'punish', attack: ATTACK.ROPE_SNAP, side: 'left', count: 1, afterFeint: true, windup: 0.45, ghostGuard: ctx.ghostGuard });
          } else {
            coverUp('feint');
            o.stageDur = 0.3;
          }
          break;
        }
        if (o.attack === ATTACK.ANCHOR_DROP && !o.feint && o.contactAt !== null && t >= o.contactAt - 0.6 - 1e-9) {
          o.guard = 'none'; // the interrupt window is open
        } else if (t < o.splitUntil) {
          o.guard = 'low'; // D11: split during a telegraph
        } else if (o.guard === 'low') {
          o.guard = 'high'; // the split window closed
        }
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
          const q = ctx.seq;
          const next = q?.strikes[o.combo.index + 1];
          if (next) {
            o.combo = { index: o.combo.index + 1, count: o.combo.count };
            o.attack = next.attack;
            o.side = next.side;
            // combos: contact-to-contact gap; repeated jabs: the follow-jab wind-up
            telegraph(next.gap ? Math.max(0.05, next.gap - T.strikeHold) : T.followJab);
          } else {
            const isCombo = q?.kind === 'combo';
            const dur = RECOVER[o.attack] + (isCombo ? 0.3 : 0);
            setStage(OPP_STATE.RECOVER, dur);
            o.opening = true;
            o.offBalance = o.attack === ATTACK.ANCHOR_DROP;
            o.guard = 'none';
            o.covering = false;
            o.contactAt = null;
            o.freeHits = (o.attack === ATTACK.ANCHOR_DROP ? 2 : 1) + (isCombo ? 1 : 0);
            emit(EVENT.OPENING, { dur, freeHits: o.freeHits });
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
    if (who === 'player' && features.rise && RISE[f.knockdowns]) {
      // D12: hold a full guard to rise (1st 2.0 s, 2nd 3.5 s) by count 9; the 3rd knockdown is a KO
      Object.assign(f.down, { holdProgress: 0, holdNeeded: RISE[f.knockdowns].hold, deadlineCount: 9 });
      ctx.holdLastT = null;
    }
    state.round.clockRunning = false;
    ctx.countT0 = now();
    emit(EVENT.KNOCKDOWN, { who, count: f.knockdowns });
    toCircle();
    if (who === 'opponent') setStage(OPP_STATE.KNOCKDOWN, 0);
  }

  function updateKnockdown(who) {
    const f = state[who];
    if (who === 'player' && features.rise) {
      updateRise(f);
      return;
    }
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
    f.hp = f.maxHp / 2; // D9: get-up at 50 % of max HP (player 50, Tamsin 125)
    emit(EVENT.GETUP, { who, hp: f.hp });
    state.round.clockRunning = true;
    if (who === 'opponent') setStage(OPP_STATE.GETUP, T.getup);
  }

  /** D12 player rise: hold a full guard (raw) continuously; a break > 150 ms resets. Rise on the next count tick. */
  function updateRise(f) {
    const t = now();
    const d = f.down;
    const holding = autoplay || !!frame?.guard?.raw; // autoplay's ghost player holds guard
    if (d.holdNeeded) {
      if (holding) {
        if (ctx.holdLastT !== null && t - ctx.holdLastT <= 0.15) d.holdProgress = r2(d.holdProgress + (t - ctx.holdLastT));
        ctx.holdLastT = t;
      } else if (ctx.holdLastT !== null && t - ctx.holdLastT > 0.15) {
        d.holdProgress = 0; // broken > 150 ms
        ctx.holdLastT = null;
      }
    }
    const n = Math.floor((t - ctx.countT0) / T.countStep + 1e-9);
    while (d.count < Math.min(n, 10)) {
      d.count += 1;
      emit(EVENT.COUNT, { who: 'player', n: d.count });
      if (d.holdNeeded && d.holdProgress >= d.holdNeeded - 1e-9 && d.count <= d.deadlineCount) {
        const hp = RISE[f.knockdowns].hp;
        f.down = null;
        f.hp = hp;
        emit(EVENT.GETUP, { who: 'player', hp });
        state.round.clockRunning = true;
        return;
      }
    }
    if (d.count >= 10) matchEnd('ko', 'opponent'); // not risen in time, or the 3rd knockdown
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
    const body = features.body && ev.target === 'body' && (punchType === 'straight' || punchType === 'hook'); // D12
    const target = body ? 'body' : 'head';
    emit(EVENT.PUNCH_THROWN, { id, hand, punchType, power, inferred: !!ev.inferred, target });
    if (!live) return; // outside a running round the stub only acknowledges punches
    p.stats.thrown += 1;
    const upper = punchType === 'uppercut';
    const hurtNow = t < p.hurtUntil; // D12: punches ×0.7 and +3 stamina while hurt
    p.stamina = Math.max(0, r2(p.stamina - ((upper ? 7 : 5) + 7 * power + (hurtNow ? 3 : 0)))); // D11: uppercut 7 + 7p
    ctx.lastActionT = t;
    if (p.stamina <= 0) {
      p.gassedUntil = t + T.gassed;
      emit(EVENT.GASSED, { until: p.gassedUntil });
    }
    const aimX = ev.aim?.x ?? 0.5;
    const downOrUp = o.state === OPP_STATE.KNOCKDOWN || o.state === OPP_STATE.GETUP;
    const outOfRange = (punchType === 'straight' && (aimX < 0.2 || aimX > 0.8)) || (upper && (aimX < 0.25 || aimX > 0.75));
    if (downOrUp || outOfRange) {
      p.stamina = Math.max(0, p.stamina - (upper ? 6 : 4)); // D11: an uppercut whiff costs +6
      p.stats.whiffed += 1;
      emit(EVENT.WHIFF, { by: 'player', id, hand, punchType });
      return;
    }
    let M = 1;
    let counter = false;
    let interrupt = false;
    let clean = true;
    let riposte = false;
    if (body) {
      // D12 body: high/tuck/cover M 0.5 (not clean); low or split blocked (+4); Recover a counter; never interrupts
      if (o.guard === 'low' || t < o.splitUntil) {
        p.stamina = Math.max(0, p.stamina - 4);
        p.stats.blocked += 1;
        emit(EVENT.BLOCKED, { by: 'player', hand, punchType, attack: null, staminaCost: 0 });
        return;
      }
      if (o.guard === 'high') {
        M = 0.5;
        clean = false;
      } else if (o.state === OPP_STATE.RECOVER) {
        M = COUNTER_MULT;
        counter = true;
      }
    } else if (o.state === OPP_STATE.TELEGRAPH && o.attack === ATTACK.ANCHOR_DROP && punchType === 'straight' &&
        power >= 0.5 && t >= o.contactAt - 0.6 && t <= o.contactAt - 0.08) {
      M = 2;
      interrupt = true;
    } else if (o.guard === 'high') {
      // her high guard (circle, every telegraph, or covering up): straights blocked, hooks chip ×0.5 (D9)
      if (upper) {
        if (o.covering || t < o.tuckUntil) {
          // D11: tucked (cover-up always counts): blocked, +6 stamina
          p.stamina = Math.max(0, p.stamina - 6);
          p.stats.blocked += 1;
          emit(EVENT.BLOCKED, { by: 'player', hand, punchType, attack: null, staminaCost: 0 });
          return;
        }
        M = 0.3; // D11 split: M 0.3, not clean; the guard drops after the hit below
        clean = false;
      } else if (punchType === 'straight') {
        p.stamina = Math.max(0, p.stamina - 4); // D9a: a poke into her high guard costs +4
        p.stats.blocked += 1;
        emit(EVENT.BLOCKED, { by: 'player', hand, punchType, attack: null, staminaCost: 0 });
        return;
      } else {
        M = HOOK_VS_HIGH;
        clean = false;
      }
    } else if (o.state === OPP_STATE.RECOVER) {
      M = upper ? 1.0 : COUNTER_MULT; // D11: an uppercut counter is M 1.0
      counter = true;
      if (ctx.riposte) {
        M = RIPOSTE_MULT; // D12: the free hit after a parry is a riposte (not stacked)
        riposte = true;
      }
    } else if (upper) {
      // D11: M 1.0 during her strike or in the Anchor Drop window (no interrupt); M 0.8 on a low guard / Hurt / split
      M = o.state === OPP_STATE.ATTACK || o.state === OPP_STATE.TELEGRAPH ? 1.0 : 0.8;
    }
    const base = punchType === 'hook' ? 10 : upper ? 9 : 7;
    const exhaustedHead = !body && o.tired === 'exhausted' ? 1.2 : 1; // D12: exhausted takes head damage ×1.2
    const dmg = base * (0.5 + 0.5 * power) * (p.fatigued ? 0.5 : 1) * M * (hurtNow ? 0.7 : 1) * exhaustedHead;
    const applied = applyDamage(o, p, body ? dmg * 0.5 : dmg); // D12: a body hit takes 50 % from her HP ...
    const staminaDrain = body ? r2(0.7 * dmg) : 0; // ... and drains 0.7 × damage from her stamina
    if (body) {
      p.stats.bodyHits += 1;
      setOppStamina(o.stamina - staminaDrain);
    }
    if (riposte) ctx.riposte = false;
    p.stats.landed += 1;
    if (counter) p.stats.counters += 1;
    if (counter || interrupt) setPressure(false); // D9a: any counter or interrupt ends pressure
    const split = upper && M === 0.3;
    if (interrupt) p.stats.interrupts += 1;
    emit(EVENT.HIT, { by: 'player', hand, punchType, power, damage: applied, counter, interrupt, target, staminaDrain, riposte });
    if (o.hp <= 0) {
      knockdown('opponent');
      return;
    }
    if (split) {
      // D11: guard split — low for 400 ms with 1 free hit, then a 4 s tuck
      o.splitUntil = t + 0.4;
      o.tuckUntil = o.splitUntil + 4;
      o.guard = 'low';
      o.freeHits = 1;
      o.covering = false;
      p.stats.splits += 1;
      emit(EVENT.GUARD_SPLIT, { until: o.splitUntil });
      return;
    }
    if (interrupt) {
      emit(EVENT.STAGGER, { who: 'opponent', dur: T.interruptStagger, interrupt: true });
      toCircle(); // an interrupt ends the whole sequence (D9)
      setStage(OPP_STATE.HURT, T.interruptStagger);
      o.guard = 'none';
      o.freeHits = 2; // D9: 2 free hits in the Hurt after an interrupt
      return;
    }
    const wasCircleLow = o.state === OPP_STATE.CIRCLE && o.guard === 'low';
    if (clean && o.freeHits > 0) {
      o.freeHits -= 1;
      if (o.freeHits === 0) {
        coverUp(o.state === OPP_STATE.RECOVER ? 'recover' : o.state === OPP_STATE.HURT ? 'hurt' : 'circle');
        return;
      }
    }
    if (clean && wasCircleLow && t >= o.staggerImmuneUntil) {
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
      if (e.feature && !features[e.feature]) {
        ctx.scriptIdx += 1; // a ?next=1 example
        continue;
      }
      if (autoplay && e.parry) {
        handleParry({ id: ghostId--, hand: e.parry, tOnset: now(), tCommit: now() });
      } else if (e.attack || e.combo) {
        const ok = startSequence({ kind: e.kind ?? 'single', attack: e.attack, side: e.side, count: e.count, combo: e.combo, punish: e.punish, ghostGuard: e.ghostGuard });
        if (!ok) return; // wait until she is in circle
      } else if (autoplay && e.pressure !== undefined) {
        setPressure(e.pressure);
      } else if (e.guard) {
        ctx.circleGuard = e.guard;
        if (state.opponent.state === OPP_STATE.CIRCLE) {
          state.opponent.guard = e.guard;
          state.opponent.freeHits = e.guard === 'low' ? 1 : 0; // D9: 1 free hit per low-guard spell
          state.opponent.covering = false;
        }
      } else if (autoplay && e.set) {
        for (const [k, v] of Object.entries(e.set)) setPath(state, k, v);
      } else if (autoplay && e.ghost && e.ghost.punchType === 'uppercut' && !features.uppercut) {
        // D11 uppercuts only with ?next=1
      } else if (autoplay && e.ghost) {
        handlePunch({ id: ghostId--, hand: e.ghost.hand, punchType: e.ghost.punchType, power: e.ghost.power, aim: { x: e.ghost.aimX }, target: e.ghost.target });
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
      case COMMAND.FORCE_SEQUENCE: {
        if (state.phase !== PHASE.FIGHT) break;
        if (state.round.countdown !== null) startClock();
        toCircle();
        const kind = cmd.kind ?? 'single';
        if (kind === 'combo' && !COMBOS[cmd.combo]) throw new Error(`force_sequence: unknown combo ${cmd.combo}`);
        if (kind === 'feint' && cmd.attack !== ATTACK.SWING_BRIDGE && cmd.attack !== ATTACK.ANCHOR_DROP) {
          throw new Error('force_sequence: only swing_bridge and anchor_drop are feinted');
        }
        startSequence({ kind, attack: cmd.attack ?? ATTACK.ROPE_SNAP, side: cmd.side, combo: cmd.combo, punish: !!cmd.punish });
        break;
      }
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
      for (const ev of f?.events ?? []) {
        if (ev.type === 'punch') handlePunch(ev);
        else if (ev.type === 'parry') handleParry(ev); // D12
      }
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
