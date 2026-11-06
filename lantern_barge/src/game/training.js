// game/training.js — D14 Training mode (GDD §15). Owner: GE.
//
// PHASE.TRAINING holds an ordered item list built from the feature flags:
//   lessons (guard, straight, hook, + uppercut / body / parry / rise with their flags), then the mitt drill, the
//   defence drill, free sparring and "start match".
// Rules (§15.7): training.damage = false (no HP, points or knockdowns, except the scripted "down" of the rise
// lesson); no pressure / anti-turtle / anti-spam; no feints or combos; her stamina doesn't change. The player's
// stamina is on only in free sparring. Match tuning is never touched.
// Mastery and persistence are main's (shared/training.js createTrainingProgress, fed by training_result{perMove});
// main seeds state.mastered with training_progress{mastered}. The sim only uses state.mastered to skip the practice
// card on the Box path once every default move is mastered.
// Internal flags (live combat, stamina, the session mode) live in w.ctx, so state.training keeps PD's shape.

import { EVENT, OPP_STATE, PUNCH, TARGET, ATTACK, PHASE, SIM_DT } from '../shared/constants.js';
import { trainingItems, DEFAULT_MOVES as SHARED_DEFAULTS, shotMove } from '../shared/training.js';
import { EPS } from './stamina.js';
import { toCircle, startSequence, updateOpponent, syncOpponent } from './opponent-ai.js';
import { initRise, updateRise, riseDecision } from './defence.js';

export const PHASE_TRAINING = PHASE.TRAINING ?? 'training';
const EV = {
  ITEM: EVENT.TRAINING_ITEM, REP: EVENT.TRAINING_REP, CALL: EVENT.TRAINING_CALL, RESULT: EVENT.TRAINING_RESULT,
};

export const DEFAULT_MOVES = SHARED_DEFAULTS;
const LESSON_REPS = { guard: 3, rise: 2 }; // others 5
const TWO_HANDED = new Set(['straight', 'hook', 'uppercut', 'body', 'parry']); // each hand ≥ 2 reps
const RESULTS_KEEP = 10;

/** Training-only numbers (GDD §15). Kept here, not in game/tuning.js: training never touches match tuning. */
export const TR = Object.freeze({
  guardHold: 2.0,
  guardBreakMax: 0.15,
  mittCalls: 10,
  mittWindow: 2.5,
  mittGap: 0.6,
  masteryScore: 0.8,
  parryLessonWindupScale: 2,
  parryLessonGap: 1.0,
  defenceWindupScale: 1.5,
  defenceGap: 1.0,
  riseGap: 1.0,
  defenceSteps: [
    { step: 'guard', attack: ATTACK.SWING_BRIDGE, needed: 3, feature: null },
    { step: 'interrupt', attack: ATTACK.ANCHOR_DROP, needed: 2, feature: null },
    { step: 'parry', attack: ATTACK.ROPE_SNAP, needed: 3, feature: 'parry' },
    { step: 'counter', attack: ATTACK.ROPE_SNAP, needed: 3, feature: null },
  ],
});

const on = (w, f) => (w.on ? w.on(f) : true);

export function isTraining(w) {
  return w.state.phase === PHASE_TRAINING;
}

/** Combat runs (with damage off) in the parry lesson, the defence drill and free sparring. */
export function trainingLive(w) {
  return isTraining(w) && !!w.state.training && !w.state.training.overlay && !!w.ctx.tr?.live;
}

/** The player's stamina is on (free sparring only). */
export function trainingStamina(w) {
  return !!w.ctx.tr?.stamina;
}

function features(w) {
  const keys = ['uppercut', 'body', 'parry', 'rise', 'slip'];
  return Object.fromEntries(keys.map((k) => [k, on(w, k) && k !== 'slip'])); // slip / duck arrive with D13
}

export function itemList(w) {
  return trainingItems(features(w));
}

/** All default moves mastered (state.mastered, seeded by main) → the Box path skips the practice card. */
export function defaultsMastered(st) {
  const m = st.mastered ?? [];
  return DEFAULT_MOVES.every((x) => m.includes(x));
}

/** main seeds the stored progress for this input: training_progress{mastered}. */
export function seedProgress(st, mastered) {
  st.mastered = [...new Set((mastered ?? []).filter((m) => typeof m === 'string'))];
}

function freshTraining(items, input) {
  return {
    input, items, index: 0, item: null, lesson: null, reps: 0, needed: 0, perHand: { left: 0, right: 0 },
    complete: false, results: [], overlay: false, call: null, step: null, score: null, tally: null,
  };
}

// ───────────────────────────────────────────── entry and navigation

/** BOOT (or CALIBRATION) → TRAINING. setPhase is phases.js's (passed in to keep the module graph simple). */
export function enterTraining(w, setPhase) {
  const st = w.state;
  w.ctx.mode = 'training';
  setPhase(w, PHASE_TRAINING);
  const src = w.frame?.source;
  st.training = freshTraining(itemList(w), src === 'camera' || src === 'replay' ? src : 'keyboard');
  st.round.clockRunning = false;
  st.round.countdown = null;
  st.practice = null;
  w.ctx.tr = {};
  gotoItem(w, st.training.items[0].id);
}

export function gotoItem(w, item) {
  const st = w.state;
  const tr = st.training;
  const index = tr.items.findIndex((x) => x.id === item);
  if (index < 0) {
    console.warn(`[sim] training: unknown item ${item}`);
    return;
  }
  const p = st.player;
  const o = st.opponent;
  const ai = w.ctx.ai;
  Object.assign(tr, {
    index, item, lesson: null, reps: 0, needed: 0, perHand: { left: 0, right: 0 }, complete: false, call: null,
    step: null, score: null, tally: null,
  });
  // a clean slate: full stamina, nothing pending, she holds the mitts
  p.stamina = p.maxStamina;
  p.gassedUntil = -1;
  p.guardBrokenUntil = -1;
  p.hurtUntil = -1;
  p.down = null;
  p.hp = p.maxHp;
  o.hp = o.maxHp;
  o.down = null;
  st.round.n = 1;
  ai.parked = true;
  ai.windupScale = 1;
  toCircle(w, { resetCooldown: true });
  o.mitts = true;
  o.guard = 'none';
  w.ctx.tr = { started: st.time, live: false, stamina: false };
  const ctx = w.ctx.tr;

  if (item.startsWith('lesson:')) {
    const move = item.slice(7);
    tr.lesson = move;
    tr.needed = LESSON_REPS[move] ?? 5;
    if (move === 'guard') ctx.hold = { start: null, last: null, needRelease: false };
    if (move === 'parry') {
      o.mitts = false;
      ctx.live = true; // her jabs resolve (no damage)
      ai.windupScale = TR.parryLessonWindupScale;
      ctx.next = st.time + TR.parryLessonGap;
      ctx.side = 'left';
    }
    if (move === 'rise') startDown(w);
  } else if (item === 'mitt') {
    tr.needed = TR.mittCalls;
    tr.score = { ok: 0, of: 0 };
    ctx.calls = buildCalls(w);
    ctx.idx = 0;
    ctx.next = st.time + TR.mittGap;
    ctx.byMove = {};
  } else if (item === 'defence') {
    o.mitts = false;
    ctx.live = true;
    ai.windupScale = TR.defenceWindupScale;
    ctx.steps = TR.defenceSteps.filter((s) => !s.feature || on(w, s.feature));
    ctx.stepIdx = 0;
    ctx.passed = 0;
    ctx.stepOk = {};
    tr.needed = ctx.steps.length;
    startStep(w);
  } else if (item === 'sparring') {
    o.mitts = false;
    ctx.live = true;
    ctx.stamina = true; // stamina and gassing stay on (§15.4)
    tr.tally = { hits: 0, blocks: 0, counters: 0 };
    ai.parked = false; // R1 rules: single attacks only (no feints in R1, no combos)
  }
  syncOpponent(w);
  w.emit(EV.ITEM, { item });
}

function itemIndex(st) {
  return st.training.index;
}

function itemId(st, i) {
  const items = st.training.items;
  return items[Math.max(0, Math.min(items.length - 1, i))].id;
}

/** Training commands (§15.5). setPhase / startMatch are phases.js's. */
export function trainingCommand(w, cmd, { startMatch }) {
  const st = w.state;
  const tr = st.training;
  if (!isTraining(w) || !tr) return false;
  switch (cmd.type) {
    case 'training_next': {
      if (tr.item === 'start_match') {
        startMatchFromTraining(w, startMatch);
        break;
      }
      gotoItem(w, itemId(st, itemIndex(st) + 1));
      break;
    }
    case 'training_back':
      gotoItem(w, itemId(st, itemIndex(st) - 1));
      break;
    case 'training_repeat':
      gotoItem(w, tr.item);
      break;
    case 'training_goto':
      gotoItem(w, cmd.item);
      break;
    case 'training_overlay':
      tr.overlay = !!cmd.open;
      if (!tr.overlay) resumeAfterOverlay(w);
      break;
    case 'training_start_match':
      startMatchFromTraining(w, startMatch);
      break;
    default:
      return false;
  }
  return true;
}

function startMatchFromTraining(w, startMatch) {
  const st = w.state;
  w.ctx.mode = 'match';
  w.ctx.tr = null;
  st.training = null;
  w.ctx.ai.parked = false;
  w.ctx.ai.windupScale = 1;
  startMatch(w); // FIGHT, round 1 countdown: training replaces the practice card
}

/** Closing the overlay restarts whatever was timed (a mitt call, a drill attempt), so no rep is lost. */
function resumeAfterOverlay(w) {
  const st = w.state;
  const tr = st.training;
  const ctx = w.ctx.tr;
  if (tr.item === 'mitt') {
    tr.call = null;
    ctx.next = st.time + TR.mittGap;
  } else if (tr.item === 'defence' || tr.lesson === 'parry') {
    toCircle(w);
    w.state.opponent.mitts = false;
    ctx.attempt = null;
    ctx.next = st.time + TR.defenceGap;
  }
}

// ───────────────────────────────────────────── reps and results

function emitRep(w, ok, extra = {}) {
  const tr = w.state.training;
  const move = extra.move ?? tr.lesson ?? tr.step ?? null;
  const payload = { move, ok };
  for (const k of ['hand', 'reason', 'got', 'earlyMs', 'lateMs', 'value', 'threshold']) if (extra[k] !== undefined) payload[k] = extra[k];
  w.emit(EV.REP, payload);
  w.ctx.tr.lastRep = { ev: w.out.at(-1), tick: w.state.tick }; // a same-tick near_miss may add value/threshold
  tr.results.push({ ...payload, t: w.state.time });
  if (tr.results.length > RESULTS_KEEP) tr.results.splice(0, tr.results.length - RESULTS_KEEP);
}

/** A successful lesson rep for `hand` (or null). Returns false if it can't count (the other hand is owed reps). */
function countRep(w, hand) {
  const tr = w.state.training;
  if (tr.reps >= tr.needed) return false;
  if (hand && TWO_HANDED.has(tr.lesson)) {
    const other = hand === 'left' ? 'right' : 'left';
    const owed = Math.max(0, 2 - tr.perHand[other]);
    if (tr.needed - tr.reps - 1 < owed) return false; // keep room for the other hand's 2
  }
  if (hand) tr.perHand[hand] += 1;
  tr.reps += 1;
  if (tr.reps >= tr.needed) lessonDone(w);
  return true;
}

function lessonDone(w) {
  const tr = w.state.training;
  tr.complete = true;
  w.emit(EV.RESULT, { item: tr.item, score: 1 });
}

// ───────────────────────────────────────────── inputs while training

const TYPE_NAMES = { straight: PUNCH.STRAIGHT, hook: PUNCH.HOOK, uppercut: PUNCH.UPPERCUT };

/**
 * A player punch in TRAINING. Lessons and the mitt drill only count reps (no combat); the defence drill and
 * sparring resolve it with damage off (combat.js), then score it here. Returns true if combat should resolve it.
 */
export function trainingPunch(w, ev, target) {
  const st = w.state;
  const tr = st.training;
  const ctx = w.ctx.tr;
  if (!tr || tr.overlay) return false; // nothing counts while the overlay is open
  if (ctx.live) return true;
  const { id, hand, punchType } = ev;
  const power = Math.min(1, Math.max(0, +ev.power || 0));
  w.emit(EVENT.PUNCH_THROWN, { id, hand, punchType, power, inferred: !!ev.inferred, target });

  const got = target === TARGET.BODY ? 'body' : punchType;
  if (tr.lesson && TYPE_NAMES[tr.lesson]) {
    if (punchType === TYPE_NAMES[tr.lesson]) {
      if (countRep(w, hand)) emitRep(w, true, { hand });
      else emitRep(w, false, { hand, reason: 'other_hand' });
    } else {
      emitRep(w, false, { hand, reason: 'wrong_move', got });
    }
  } else if (tr.lesson === 'body') {
    if (punchType === PUNCH.UPPERCUT) emitRep(w, false, { hand, reason: 'wrong_move', got });
    else if (target !== TARGET.BODY) {
      const nl = ctx.notLow; // its near_miss came first this tick
      const vt = nl && nl.tick === st.tick && nl.hand === hand ? { value: nl.value, threshold: nl.threshold } : {};
      emitRep(w, false, { hand, reason: 'not_low', ...vt });
    }
    else if (countRep(w, hand)) emitRep(w, true, { hand });
    else emitRep(w, false, { hand, reason: 'other_hand' });
  } else if (tr.item === 'mitt' && tr.call) {
    const want = tr.call.shot;
    const ok = punchType === want.punchType && hand === want.hand && target === want.target;
    const reason = ok ? undefined : punchType !== want.punchType ? 'wrong_move' : hand !== want.hand ? 'wrong_hand' : 'wrong_target';
    scoreCall(w, ok, shotMove(want), { hand, reason, got: ok ? undefined : got });
  }
  return false;
}

/** near_miss{hand, kind, reason, value, threshold} from the input layer → a failed rep with its reason. */
export function trainingNearMiss(w, ev) {
  const tr = w.state.training;
  if (!tr || tr.overlay) return;
  const vt = { value: ev.value, threshold: ev.threshold }; // TA's "you reached 70%" (the view sees no input events)
  // body/not_low rides along with a committed head straight or hook: the punch itself carries the verdict
  // (body lesson: 'not_low'; elsewhere the head punch may be exactly right), so don't count it twice; just lend
  // its value/threshold to the body lesson's not_low rep (either event may come first in the frame)
  if (ev.kind === 'body' && ev.reason === 'not_low') {
    if (tr.lesson !== 'body') return;
    const last = w.ctx.tr.lastRep;
    if (last && last.tick === w.state.tick && last.ev.reason === 'not_low' && last.ev.hand === ev.hand) attachVt(w, last.ev, vt);
    else w.ctx.tr.notLow = { hand: ev.hand, tick: w.state.tick, ...vt };
    return;
  }
  if (tr.lesson || (tr.item === 'mitt' && tr.call)) emitRep(w, false, { reason: ev.reason, hand: ev.hand, move: tr.lesson ?? ev.kind, ...vt });
}

function attachVt(w, repEvent, vt) {
  for (const k of ['value', 'threshold']) if (vt[k] !== undefined) repEvent[k] = vt[k];
  const res = w.state.training.results.at(-1);
  if (res) for (const k of ['value', 'threshold']) if (vt[k] !== undefined) res[k] = vt[k];
}

/** A parry input in TRAINING: the parry lesson and the defence drill's parry step score it. */
export function trainingParry(w, ev, resolveParry) {
  const tr = w.state.training;
  if (!tr || tr.overlay || !w.ctx.tr?.live) return;
  const res = resolveParry(w, ev);
  if (!res) return;
  const lessonParry = tr.lesson === 'parry';
  const stepParry = tr.item === 'defence' && tr.step === 'parry';
  if (!lessonParry && !stepParry) return;
  const timing = {};
  if (res.earlyMs !== undefined) timing.earlyMs = res.earlyMs;
  if (res.lateMs !== undefined) timing.lateMs = res.lateMs;
  if (res.result === 'success') {
    if (lessonParry) {
      if (countRep(w, ev.hand)) emitRep(w, true, { hand: ev.hand, ...timing });
      else emitRep(w, false, { hand: ev.hand, reason: 'other_hand' });
    } else attemptVerdict(w, true, { hand: ev.hand, reason: 'parried', ...timing });
  } else {
    const reason = res.reason ?? 'missed';
    if (lessonParry) emitRep(w, false, { hand: ev.hand, reason, ...timing });
    else attemptVerdict(w, false, { hand: ev.hand, reason, ...timing });
  }
}

// ───────────────────────────────────────────── mitt drill

function buildCalls(w) {
  // every enabled shot kind (type × target) at least once (round-robin), then balanced hands: 5 left, 5 right
  const kinds = [];
  for (const shot of mittShotsFor(w)) if (!kinds.some((k) => k.punchType === shot.punchType && k.target === shot.target)) kinds.push(shot);
  const shots = Array.from({ length: TR.mittCalls }, (_, i) => ({ ...kinds[i % kinds.length] }));
  shuffle(w, shots);
  const hands = Array.from({ length: shots.length }, (_, i) => (i % 2 ? 'right' : 'left'));
  shuffle(w, hands);
  return shots.map((s, i) => ({ hand: hands[i], punchType: s.punchType, target: s.target }));
}

function mittShotsFor(w) {
  const f = features(w);
  const types = ['straight', 'hook', ...(f.uppercut ? ['uppercut'] : [])];
  const out = types.map((punchType) => ({ punchType, target: TARGET.HEAD }));
  if (f.body) out.push({ punchType: 'straight', target: TARGET.BODY }, { punchType: 'hook', target: TARGET.BODY });
  return out;
}

function shuffle(w, a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = w.rng.int(0, i);
    [a[i], a[j]] = [a[j], a[i]];
  }
}

function scoreCall(w, ok, move, extra = {}) {
  const st = w.state;
  const tr = st.training;
  const ctx = w.ctx.tr;
  const by = (ctx.byMove[move] ??= { ok: 0, n: 0 });
  by.n += 1;
  if (ok) by.ok += 1;
  tr.reps += 1; // shots taken
  tr.score = { ok: tr.score.ok + (ok ? 1 : 0), of: tr.score.of + 1 };
  emitRep(w, ok, { move, ...extra });
  tr.call = null;
  ctx.idx += 1;
  ctx.next = st.time + TR.mittGap;
  if (ctx.idx >= ctx.calls.length) finishMitt(w);
}

function finishMitt(w) {
  const tr = w.state.training;
  const ctx = w.ctx.tr;
  const perMove = Object.fromEntries(Object.entries(ctx.byMove).map(([m, v]) => [m, v.ok / v.n]));
  tr.complete = true;
  w.emit(EV.RESULT, { item: 'mitt', score: tr.score.ok / TR.mittCalls, perMove });
  ctx.next = Infinity;
}

function updateMitt(w) {
  const st = w.state;
  const tr = st.training;
  const ctx = w.ctx.tr;
  const t = st.time;
  if (tr.call && t >= tr.call.until - EPS) {
    const want = tr.call.shot;
    scoreCall(w, false, shotMove(want), { hand: want.hand, reason: 'too_slow' });
    return;
  }
  if (!tr.call && ctx.idx < ctx.calls.length && t >= ctx.next - EPS) {
    const shot = ctx.calls[ctx.idx];
    tr.call = { shot, until: t + TR.mittWindow };
    w.emit(EV.CALL, { shot });
  }
}

// ───────────────────────────────────────────── lessons that need the sim

function updateGuardLesson(w, frame) {
  const st = w.state;
  const tr = st.training;
  const h = w.ctx.tr.hold;
  const t = st.time;
  if (tr.reps >= tr.needed) return;
  const raw = !!frame.guard?.raw;
  if (h.needRelease) {
    if (!raw) h.needRelease = false;
    return;
  }
  if (raw) {
    if (h.start === null) h.start = t;
    h.last = t;
    if (t - h.start >= TR.guardHold - EPS) {
      countRep(w, null);
      emitRep(w, true);
      Object.assign(h, { start: null, last: null, needRelease: true });
    }
  } else if (h.last !== null && t - h.last > TR.guardBreakMax + EPS) {
    if (t - h.start > 0.3) emitRep(w, false, { reason: 'guard_dropped' });
    Object.assign(h, { start: null, last: null });
  }
}

/** Rise lesson: the player starts down (no damage, no knockdown tally); the count runs; the hold-to-rise counts. */
function startDown(w) {
  const st = w.state;
  const tr = st.training;
  const p = st.player;
  p.down = { since: st.time, count: 0 };
  initRise(w, tr.reps + 1); // 2.0 s, then 3.5 s
  w.ctx.tr.downAt = st.time;
}

function updateRiseLesson(w, frame) {
  const st = w.state;
  const T = w.T;
  const tr = st.training;
  const p = st.player;
  const ctx = w.ctx.tr;
  if (!p.down) {
    if (tr.reps < tr.needed && ctx.nextDown !== undefined && st.time >= ctx.nextDown - EPS) startDown(w);
    return;
  }
  updateRise(w, frame);
  const n = Math.floor((st.time - p.down.since) / T.countInterval + EPS);
  while (p.down && p.down.count < Math.min(n, T.koCount)) {
    p.down.count += 1;
    w.emit(EVENT.COUNT, { who: 'player', n: p.down.count });
    const d = riseDecision(w, p.down.count);
    if (d === 'rise') {
      p.down = null;
      w.ctx.rise = null;
      w.emit(EVENT.GETUP, { who: 'player', hp: p.hp });
      countRep(w, null);
      emitRep(w, true);
      ctx.nextDown = st.time + TR.riseGap;
    } else if (d === 'ko') {
      p.down = null;
      w.ctx.rise = null;
      emitRep(w, false, { reason: 'too_slow' });
      ctx.nextDown = st.time + TR.riseGap; // the same rep again
    }
  }
}

/** Parry lesson: slow jabs (wind-up ×2) from alternating sides. */
function updateParryLesson(w, dt) {
  const st = w.state;
  const tr = st.training;
  const ctx = w.ctx.tr;
  const o = st.opponent;
  if (tr.reps >= tr.needed) return;
  if (o.state === OPP_STATE.CIRCLE && !ctx.attempt && st.time >= ctx.next - EPS) {
    ctx.attempt = { seq: true };
    startSequence(w, { kind: 'single', steps: [{ attack: ATTACK.ROPE_SNAP, side: ctx.side }] });
    ctx.side = ctx.side === 'left' ? 'right' : 'left';
  }
  updateOpponent(w, dt);
  if (ctx.attempt && st.opponent.state === OPP_STATE.CIRCLE) {
    ctx.attempt = null;
    ctx.next = st.time + TR.parryLessonGap;
  }
}

// ───────────────────────────────────────────── defence drill

function startStep(w) {
  const st = w.state;
  const tr = st.training;
  const ctx = w.ctx.tr;
  const s = ctx.steps[ctx.stepIdx];
  if (!s) {
    finishDefence(w);
    return;
  }
  tr.step = s.step;
  tr.score = { ok: 0, of: s.needed };
  ctx.attempt = null;
  ctx.next = st.time + TR.defenceGap;
}

/** Defence moves mastered through their step: guard → guard, parry → parry (slip_duck → slip / duck with D13). */
const STEP_MOVES = { guard: ['guard'], parry: ['parry'], slip_duck: ['slip', 'duck'] };

function finishDefence(w) {
  const tr = w.state.training;
  const ctx = w.ctx.tr;
  tr.step = null;
  tr.complete = true;
  const score = ctx.steps.length ? ctx.passed / ctx.steps.length : 1;
  const perMove = {};
  for (const s of ctx.steps) for (const m of STEP_MOVES[s.step] ?? []) perMove[m] = ctx.stepOk[s.step] ? 1 : 0;
  w.emit(EV.RESULT, { item: 'defence', score, perMove });
}

/** One defence attempt's verdict; a step repeats until it has `needed` successes (or is skipped). */
function attemptVerdict(w, ok, extra = {}) {
  const st = w.state;
  const tr = st.training;
  const ctx = w.ctx.tr;
  if (!ctx.attempt || ctx.attempt.done) return;
  ctx.attempt.done = true;
  emitRep(w, ok, extra);
  if (ok) tr.score = { ok: tr.score.ok + 1, of: tr.score.of };
  if (tr.score.ok >= tr.score.of) {
    ctx.stepOk[tr.step] = true;
    ctx.passed += 1;
    tr.reps += 1; // steps done
    ctx.stepIdx += 1;
    startStep(w); // the next step shows at once; its first attempt waits for her to circle again
  }
}

function updateDefence(w, dt) {
  const st = w.state;
  const tr = st.training;
  const ctx = w.ctx.tr;
  const o = st.opponent;
  if (!tr.step) return;
  if (o.state === OPP_STATE.CIRCLE && !ctx.attempt && st.time >= ctx.next - EPS) {
    const s = ctx.steps[ctx.stepIdx];
    ctx.attempt = { step: s.step, done: false, straights: [], openingAt: null, earlyPunch: null };
    startSequence(w, { kind: 'single', steps: [{ attack: s.attack, side: s.attack === ATTACK.ANCHOR_DROP ? 'right' : 'left' }] });
  }
  updateOpponent(w, dt);
  const a = ctx.attempt;
  if (a && st.opponent.state === OPP_STATE.CIRCLE) {
    // the attempt is over without a verdict → a miss with the most useful reason
    if (!a.done) {
      if (a.step === 'counter') attemptVerdict(w, false, a.earlyPunch ? { reason: 'early', earlyMs: a.earlyPunch } : { reason: 'missed_opening' });
      else if (a.step === 'interrupt') attemptVerdict(w, false, a.straightTiming ?? { reason: 'no_straight' });
      else if (a.step === 'parry') attemptVerdict(w, false, { reason: 'no_parry' });
    }
    ctx.attempt = null;
    ctx.next = st.time + TR.defenceGap;
  }
}

/** Combat hooks (combat.js calls these in TRAINING) — verdicts and the sparring tally. */
export function onTrainingStrike(w, { blocked, contactAt, firstGuardAt }) {
  const tr = w.state.training;
  if (!tr) return;
  if (blocked && tr.tally) tr.tally.blocks += 1;
  const a = w.ctx.tr?.attempt;
  if (tr.item !== 'defence' || !a) return;
  if (a.step === 'guard') {
    if (blocked) attemptVerdict(w, true, { reason: 'blocked' });
    else if (firstGuardAt !== null) attemptVerdict(w, false, { reason: 'late_guard', lateMs: Math.round((firstGuardAt - contactAt) * 1000) });
    else attemptVerdict(w, false, { reason: 'no_guard' });
  }
}

export function onTrainingHit(w, { hit, hitTime, snap }) {
  const tr = w.state.training;
  if (!tr) return;
  if (tr.tally) {
    tr.tally.hits += 1;
    if (hit.counter) tr.tally.counters += 1;
  }
  const a = w.ctx.tr?.attempt;
  if (tr.item !== 'defence' || !a) return;
  if (a.step === 'interrupt' && hit.punchType === PUNCH.STRAIGHT) {
    if (hit.interrupt) attemptVerdict(w, true, { reason: 'interrupted' });
    else a.straightTiming = windowTiming(w, snap, hitTime);
  }
  if (a.step === 'counter') {
    if (hit.counter) attemptVerdict(w, true, { reason: 'countered' });
    else if (snap.state === OPP_STATE.TELEGRAPH || snap.state === OPP_STATE.ATTACK) {
      const opensAt = (snap.contactAt ?? hitTime) + w.T.strikeHold;
      a.earlyPunch = Math.round((opensAt - hitTime) * 1000);
    }
  }
}

/** Blocked punches still matter for the interrupt step (a straight into her high guard is early). */
export function onTrainingBlocked(w, { punchType, hitTime, snap }) {
  const a = w.ctx.tr?.attempt;
  if (w.state.training?.item !== 'defence' || !a) return;
  if (a.step === 'interrupt' && punchType === PUNCH.STRAIGHT) a.straightTiming = windowTiming(w, snap, hitTime);
  if (a.step === 'counter' && (snap.state === OPP_STATE.TELEGRAPH || snap.state === OPP_STATE.ATTACK)) {
    a.earlyPunch = Math.round(((snap.contactAt ?? hitTime) + w.T.strikeHold - hitTime) * 1000);
  }
}

function windowTiming(w, snap, hitTime) {
  const T = w.T;
  if (snap.contactAt === null || snap.attack !== ATTACK.ANCHOR_DROP) return { reason: 'not_in_window' };
  const open = snap.contactAt - T.interruptWindowOpen;
  const close = snap.contactAt - (T.latencyBudget + T.punchBackdate - T.impactDelay);
  if (hitTime < open) return { reason: 'early', earlyMs: Math.round((open - hitTime) * 1000) };
  if (hitTime > close) return { reason: 'late', lateMs: Math.round((hitTime - close) * 1000) };
  return { reason: 'not_in_window' };
}

// ───────────────────────────────────────────── per tick

/** Advance TRAINING by one tick (not while paused). */
export function updateTraining(w, dt, frame) {
  const st = w.state;
  const tr = st.training;
  if (!tr || tr.overlay) return;
  if (tr.lesson === 'guard') updateGuardLesson(w, frame ?? {});
  else if (tr.lesson === 'rise') updateRiseLesson(w, frame ?? {});
  else if (tr.lesson === 'parry') updateParryLesson(w, dt);
  else if (tr.item === 'mitt') updateMitt(w);
  else if (tr.item === 'defence') updateDefence(w, dt);
  else if (tr.item === 'sparring') updateOpponent(w, dt); // no clock, no knockdowns, damage off
  void SIM_DT;
}
