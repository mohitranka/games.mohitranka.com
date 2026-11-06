// game/combat.js — punch resolution against the opponent snapshot ring, her strikes, late block, guard break
// (GDD §5, §6, §8; decisions D4; architecture §3.7). Owner: GE.
//
// Latency model (no re-simulation):
//   * every tick pushes a snapshot of Tamsin into a ring;
//   * a punch is CLASSIFIED against the snapshot at its hit time (tOnset − punchBackdate);
//   * its damage and side effects apply on the current tick;
//   * only the interrupt window closes early: latencyBudget + punchBackdate − impactDelay (113 ms) before
//     contact, so a straight backdated into it at the full latency budget still arrives before the strike
//     resolves (BUG-009; D4 "never applied after the strike resolved", D9 "always interrupts");
//   * her strike resolves at contact + impactDelay and is blocked by ≥ 2 consecutive raw guard samples
//     spanning ≥ 30 ms inside [contact, contact + impactDelay].

import { EVENT, OPP_STATE, ATTACK, PHASE, PUNCH, TARGET } from '../shared/constants.js';
import { EPS, isGassed, punchCost, fatigueFactor, spend } from './stamina.js';
import {
  staggerOpponent, extendOffBalance, liveWindow, windowLeft, spendFreeHit, splitGuard, tucked, splitOverlay,
  addOppStamina,
} from './opponent-ai.js';
import { isHurt, noteStrikeOutcome } from './defence.js';
import { trainingLive, trainingStamina, onTrainingHit, onTrainingBlocked, onTrainingStrike } from './training.js';
import { knockdown } from './phases.js';
import { noteCounter } from './pressure.js';

// ───────────────────────────────────────────── snapshot ring and raw guard samples

function ringKeep(T) {
  return Math.max(T.snapshotHistory, T.latencyBudget + T.punchBackdate + 0.1);
}

export function snapshotOf(w) {
  const o = w.state.opponent;
  return {
    t: w.state.time,
    state: o.state,
    attack: o.attack,
    side: o.side,
    comboIndex: o.combo.index,
    stageStart: o.stageStart,
    stageDur: o.stageDur,
    contactAt: o.contactAt,
    guard: o.guard,
    opening: o.opening,
    offBalance: o.offBalance,
    staggerImmuneUntil: o.staggerImmuneUntil,
    feint: o.feint,
    covering: o.covering,
    windowCover: !!w.ctx.ai.windowCover, // cover-up from spent free hits (D11: counts as tucked)
    tuckUntil: o.tuckUntil ?? -1,
    riposte: o.state === OPP_STATE.RECOVER && w.ctx.ai.riposteWin !== null && w.ctx.ai.recoverWin === w.ctx.ai.riposteWin, // D12
    winId: liveWindow(w), // free-hit window her state belonged to at this tick (D9)
    seq: w.ctx.ai.seq,
  };
}

/** Once per tick, after the opponent update. */
export function pushSnapshot(w) {
  const ring = w.ctx.ring;
  ring.push(snapshotOf(w));
  const oldest = w.state.time - ringKeep(w.T);
  while (ring.length > 1 && ring[0].t < oldest - EPS) ring.shift();
}

/** The latest snapshot at or before hitTime; older than the ring → the oldest entry (architecture §3.7). */
export function snapshotAt(w, hitTime) {
  const ring = w.ctx.ring;
  if (!ring.length) return snapshotOf(w);
  for (let i = ring.length - 1; i >= 0; i--) if (ring[i].t <= hitTime + EPS) return ring[i];
  return ring[0];
}

/** Once per tick: the raw in-position guard sample, void while the guard is broken. */
export function recordGuardSample(w, frame) {
  const t = w.state.time;
  const broken = t < w.state.player.guardBrokenUntil - EPS;
  const samples = w.ctx.guardSamples;
  samples.push({ t, ok: !!frame.guard?.raw && !broken });
  while (samples.length > 1 && samples[0].t < t - 1) samples.shift();
}

/**
 * Late block (GDD §8): ≥ lateBlockMinSamples consecutive raw samples spanning ≥ lateBlockMinMs inside
 * [contactAt, contactAt + impactDelay].
 */
export function lateBlock(samples, contactAt, T) {
  const lo = contactAt - EPS;
  const hi = contactAt + T.impactDelay + EPS;
  let n = 0;
  let start = 0;
  for (const s of samples) {
    if (s.t < lo || s.t > hi) continue;
    if (!s.ok) {
      n = 0;
      continue;
    }
    if (n === 0) start = s.t;
    n += 1;
    if (n >= T.lateBlockMinSamples && s.t - start >= T.lateBlockMinMs / 1000 - EPS) return true;
  }
  return false;
}

// ───────────────────────────────────────────── classification (GDD §6 interaction table, D9, D11)

/**
 * Classify against the snapshot. Free-hit budgets are checked afterwards against the LIVE window (combat
 * resolves on the current tick), see resolvePlayerPunch. `live.tucked`: she is tucked now (D11), which also
 * blocks an uppercut classified into a snapshot from just before a split.
 * @returns {{kind:'whiff'|'blocked'|'hit', M:number, counter:boolean, interrupt:boolean, clean:boolean,
 *            stagger:boolean, split:boolean}}
 */
export function classifyPunch(T, snap, punch, hitTime, live = { tucked: false }) {
  const res = { kind: 'hit', M: 1, counter: false, interrupt: false, clean: true, stagger: false, split: false, riposte: false };
  const type = punch.punchType;
  const upper = type === PUNCH.UPPERCUT;
  const body = punch.target === TARGET.BODY; // D12: straights and hooks only (resolvePlayerPunch enforces)
  if (snap.state === OPP_STATE.KNOCKDOWN || snap.state === OPP_STATE.GETUP) return { ...res, kind: 'whiff', clean: false };
  const aimX = punch.aim?.x ?? 0.5;
  const zone = upper ? T.aimZoneUppercut : type === PUNCH.HOOK ? null : T.aimZone; // hooks always reach
  if (zone && (aimX < zone[0] - EPS || aimX > zone[1] + EPS)) return { ...res, kind: 'whiff', clean: false };

  if (body) return classifyBody(T, snap, res);

  // interrupt window: a REAL Anchor Drop only (a feint is cancelled before its window would open); STRAIGHTS only
  if (snap.state === OPP_STATE.TELEGRAPH && snap.attack === ATTACK.ANCHOR_DROP && !snap.feint && snap.contactAt !== null) {
    const open = snap.contactAt - T.interruptWindowOpen;
    const close = interruptWindowClose(T, snap.contactAt);
    const inWindow = hitTime >= open - EPS && hitTime <= close + EPS;
    if (inWindow && type === PUNCH.STRAIGHT && punch.power >= T.interruptPowerMin - EPS) {
      return { ...res, M: T.interruptMult, interrupt: true };
    }
  }

  // any high guard: circle high, telegraphs before the interrupt window, feints, cover-up
  if (snap.guard === 'high') {
    const tuckedOrCovered = snap.windowCover || hitTime < (snap.tuckUntil ?? -1) - EPS || live.tucked;
    if (upper && !tuckedOrCovered) return { ...res, M: T.splitMult, clean: false, split: true }; // D11 split
    return highGuard(T, res, type);
  }
  if (snap.state === OPP_STATE.RECOVER) {
    if (snap.riposte) return { ...res, M: T.riposteMult, counter: true, riposte: true }; // D12, not stacked
    return { ...res, M: upper ? T.uppercutCounterMult : T.counterMult, counter: true };
  }
  // circle low / split window (low) is the only plain state that staggers (hurt is already staggered)
  const M = !upper ? 1 : snap.guard === 'low' ? T.uppercutLowMult : T.uppercutOpenMult;
  return { ...res, M, stagger: snap.state === OPP_STATE.CIRCLE };
}

/**
 * D12 body column (GDD §13.1): high guard / tuck and cover-up M 0.5 (not clean, the drain still applies); her low
 * guard and the split window block; Recover counters (riposte 1.5); Hurt, Attack, an open telegraph M 1.0. A body
 * shot never interrupts and never staggers.
 */
function classifyBody(T, snap, res) {
  if (snap.guard === 'high') return { ...res, M: snap.windowCover ? T.bodyCoverMult : T.bodyHighGuardMult, clean: false };
  if (snap.state === OPP_STATE.RECOVER) {
    return snap.riposte ? { ...res, M: T.riposteMult, counter: true, riposte: true } : { ...res, M: T.counterMult, counter: true };
  }
  if (snap.guard === 'low' && snap.state !== OPP_STATE.HURT) return { ...res, kind: 'blocked', M: 0, clean: false };
  return res; // Hurt, Attack, an open telegraph: M 1.0, clean, no stagger
}

/** Her high guard when nothing better applies (tucked / covered for an uppercut): straight and uppercut blocked. */
function highGuard(T, res, type, body = false) {
  if (body) return { ...res, M: T.bodyCoverMult, clean: false, counter: false, stagger: false, split: false, riposte: false };
  if (type !== PUNCH.HOOK) return { ...res, kind: 'blocked', M: 0, clean: false, counter: false, stagger: false, split: false, riposte: false };
  return { ...res, M: T.highGuardHookMult, clean: false, counter: false, stagger: false, split: false, riposte: false };
}

/** The interrupt window closes this long before contact (BUG-009: the backdate is part of the budget). */
export function interruptWindowClose(T, contactAt) {
  return contactAt - (T.latencyBudget + T.punchBackdate - T.impactDelay);
}

// ───────────────────────────────────────────── points (D9: % of the opponent's max HP, 0.1 steps)

function addDamage(w, by, amount) {
  const st = w.state;
  const d = w.ctx.dealt;
  d[by] += amount;
  const target = by === 'player' ? st.opponent : st.player;
  st[by].points = Math.round((1000 * d[by]) / target.maxHp) / 10;
}

// ───────────────────────────────────────────── player punches

/** Is a round live enough for punches to cost stamina and resolve? (countdown and rest only acknowledge) */
function punchesResolve(w) {
  const st = w.state;
  if (trainingLive(w)) return true; // D14: parry lesson, defence drill and sparring (damage off)
  if (st.phase !== PHASE.FIGHT || st.round.countdown !== null) return false;
  return st.round.clockRunning || !!st.opponent.down;
}

/**
 * @param {object} w world
 * @param {import('../shared/types.js').PunchEvent} ev
 */
export function resolvePlayerPunch(w, ev) {
  const st = w.state;
  const T = w.T;
  const p = st.player;
  const o = st.opponent;
  const t = st.time;
  const { id, hand, punchType } = ev;
  const power = Math.min(1, Math.max(0, +ev.power || 0));
  if (p.down) return; // the player is on the canvas: input is ignored until the get-up
  // D12: body shots are straights and hooks only, behind features.body; everything else is a head shot
  const bodyOk = (w.on ? w.on('body') : true) && (punchType === PUNCH.STRAIGHT || punchType === PUNCH.HOOK);
  const target = bodyOk && ev.target === TARGET.BODY ? TARGET.BODY : TARGET.HEAD;
  const body = target === TARGET.BODY;

  const live = punchesResolve(w);
  const training = !!st.training; // D14: training.damage = false; stamina only where training.stamina
  const staminaOn = !training || trainingStamina(w);
  const pay = (amount) => { if (staminaOn) spend(w, amount); };
  if (live && staminaOn && (isGassed(p, t) || p.stamina <= 0)) {
    w.emit(EVENT.PUNCH_REJECTED, { id, hand, reason: 'gassed' });
    return;
  }
  w.emit(EVENT.PUNCH_THROWN, { id, hand, punchType, power, inferred: !!ev.inferred, target });
  if (!live) return; // practice (mitts, no damage), countdown, rest, boot, match end

  p.stats.thrown += 1;
  const fatigue = fatigueFactor(T, p);
  let cost = punchCost(T, power, punchType);
  const upper = punchType === PUNCH.UPPERCUT;
  const hurt = isHurt(w); // D12: heavy gloves
  if (hurt) cost += T.hurtPunchExtraStamina;
  const hitTime = ev.tOnset - T.punchBackdate;
  const snap = o.down ? { ...snapshotOf(w), state: OPP_STATE.KNOCKDOWN } : splitOverlay(w, snapshotAt(w, hitTime), hitTime);
  const c = classifyPunch(T, snap, { punchType, power, aim: ev.aim, target }, hitTime, { tucked: tucked(w) });

  // An interrupt only counts while the strike it would cancel is still unresolved (same attack sequence).
  if (c.interrupt) {
    const ai = w.ctx.ai;
    const pending = ai.seq === snap.seq && !ai.resolved &&
      (o.state === OPP_STATE.TELEGRAPH || o.state === OPP_STATE.ATTACK) && o.attack === ATTACK.ANCHOR_DROP;
    if (!pending) Object.assign(c, { M: 1, interrupt: false });
  }

  // free hits (D9): a clean hit in a guard-down window needs budget left in that window, checked live
  let spendWin = null;
  if (c.kind === 'hit' && c.clean && !c.interrupt && snap.winId != null) {
    if (windowLeft(w, snap.winId) > 0) spendWin = snap.winId;
    else Object.assign(c, highGuard(T, c, punchType, body)); // she has covered up (counts as tucked for an uppercut)
  }

  if (c.kind === 'whiff') {
    cost += upper ? T.uppercutExtraStamina : T.whiffExtraStamina; // D11: +6 for an uppercut
    p.stats.whiffed += 1;
    w.emit(EVENT.WHIFF, { by: 'player', id, hand, punchType });
    pay(cost);
    return;
  }
  if (c.kind === 'blocked') {
    p.stats.blocked += 1;
    w.emit(EVENT.BLOCKED, { by: 'player', hand, punchType, attack: null, staminaCost: 0 });
    if (training) onTrainingBlocked(w, { punchType, hitTime, snap });
    const extra = body ? T.bodyBlockedExtraStamina : upper ? T.uppercutExtraStamina : T.blockedStraightExtraStamina;
    pay(cost + extra); // D9a / D11 / D12
    return;
  }

  const base = T.baseDamage[punchType] ?? T.baseDamage.straight;
  // D12: heavy gloves while hurt; an exhausted Tamsin takes more to the head
  const exhaustedHead = !body && o.tired === 'exhausted' ? T.exhaustedHeadDamageMult : 1;
  const formula = base * (0.5 + 0.5 * power) * fatigue * c.M * (hurt ? T.hurtPunchMult : 1) * exhaustedHead;
  const damage = Math.min(o.hp, body ? formula * T.bodyHpFactor : formula); // a body hit: 50% to HP…
  const staminaDrain = body ? formula * T.bodyStaminaDrain : 0; // …and 0.7 × the formula from her stamina
  if (!training) {
    o.hp -= damage;
    addDamage(w, 'player', damage);
    if (staminaDrain > 0) addOppStamina(w, -staminaDrain);
  }
  if (body) p.stats.bodyHits = (p.stats.bodyHits ?? 0) + 1;
  p.stats.landed += 1;
  if (c.counter) p.stats.counters += 1;
  if (c.interrupt) p.stats.interrupts += 1;
  if (c.counter || c.interrupt) noteCounter(w); // D9a: pressure ends (an uppercut counter too; a split doesn't)
  w.emit(EVENT.HIT, {
    by: 'player', hand, punchType, power, damage, counter: c.counter, interrupt: c.interrupt,
    target, staminaDrain, riposte: !!c.riposte,
  });

  if (training) onTrainingHit(w, { hit: { punchType, counter: c.counter, interrupt: c.interrupt }, hitTime, snap });
  if (!training && o.hp <= EPS) {
    o.hp = 0;
    pay(cost);
    knockdown(w, 'opponent');
    return;
  }

  if (c.split) {
    p.stats.splits = (p.stats.splits ?? 0) + 1;
    splitGuard(w, hitTime); // D11: low for 400 ms with 1 free hit, tucked 4 s, both from the backdated hit time
  }

  if (c.clean) {
    const ai = w.ctx.ai;
    if (c.interrupt) {
      staggerOpponent(w, T.interruptStagger, true); // cancels the Anchor Drop, ignores immunity
    } else if (c.counter) {
      if (o.state === OPP_STATE.RECOVER && o.offBalance && ai.seq === snap.seq) extendOffBalance(w);
    } else if (c.stagger && o.state === OPP_STATE.CIRCLE && (t >= o.staggerImmuneUntil - EPS || o.offBalance)) {
      staggerOpponent(w, T.hurtDur, false, spendWin);
    }
    if (spendWin !== null) spendFreeHit(w, spendWin); // emits cover when the budget runs out
    // anti-stun-lock: 3 clean hits within 1.5 s → immune to stagger for 1 s
    ai.cleanHits.push(t);
    while (ai.cleanHits.length && ai.cleanHits[0] < t - T.stunLockWindow - EPS) ai.cleanHits.shift();
    if (ai.cleanHits.length >= T.stunLockHits) {
      o.staggerImmuneUntil = t + T.staggerImmuneDur;
      ai.cleanHits.length = 0;
    }
  }
  pay(cost);
}

// ───────────────────────────────────────────── her strikes

function damagePlayer(w, amount) {
  const st = w.state;
  if (st.training) return 0; // D14: training.damage = false
  const applied = Math.min(st.player.hp, amount);
  st.player.hp -= applied;
  addDamage(w, 'opponent', applied);
  return applied;
}

/**
 * Resolve her current strike at contact + impactDelay. Returns true if the player went down.
 * @param {object} w world
 */
export function resolveStrike(w) {
  const st = w.state;
  const T = w.T;
  const p = st.player;
  const o = st.opponent;
  const t = st.time;
  const attack = o.attack;
  const side = o.side;
  const guarded = lateBlock(w.ctx.guardSamples, o.contactAt, T) && t >= p.guardBrokenUntil - EPS;
  const anchor = attack === ATTACK.ANCHOR_DROP;
  const pressured = !!p.pressured; // D9a
  const breakBelow = pressured ? T.pressureGuardBreakBelow : T.guardBreakBelow;
  const training = !!st.training; // D14: no damage, no knockdown, no hurt; stamina only in sparring
  const staminaOn = !training || trainingStamina(w);

  const guardBroken = guarded && anchor && staminaOn && p.stamina < breakBelow;
  if (guardBroken) {
    p.guardBrokenUntil = t + T.guardBreakDur;
    p.guard = 'none';
    p.guardHeldSince = -1;
    w.emit(EVENT.GUARD_BROKEN, { until: p.guardBrokenUntil });
    const damage = damagePlayer(w, T.strikeDamage[attack]);
    w.emit(EVENT.PLAYER_HIT, { attack, side, damage, shakeTier: T.shakeTier[attack] });
  } else if (guarded) {
    const cost = anchor && pressured ? T.pressureAnchorBlockCost : T.blockCost[attack];
    w.emit(EVENT.BLOCKED, { by: 'opponent', hand: side, punchType: null, attack, staminaCost: staminaOn ? cost : 0 });
    if (staminaOn) spend(w, cost);
    damagePlayer(w, anchor && pressured ? T.pressureAnchorBlockedDmg : T.blockedDamage[attack]);
  } else {
    const damage = damagePlayer(w, T.strikeDamage[attack]);
    w.emit(EVENT.PLAYER_HIT, { attack, side, damage, shakeTier: T.shakeTier[attack] });
  }
  if (training) {
    const firstGuard = w.ctx.guardSamples.find((g) => g.ok && g.t >= o.contactAt - EPS);
    onTrainingStrike(w, { blocked: guarded && !guardBroken, contactAt: o.contactAt, firstGuardAt: firstGuard ? firstGuard.t : null });
    return false;
  }
  if (p.hp <= EPS) {
    p.hp = 0;
    knockdown(w, 'player');
    return true;
  }
  // D12 player hurt (with features.rise): big / repeated unblocked hits and guard breaks
  if (w.on ? w.on('rise') : true) noteStrikeOutcome(w, { attack, unblocked: !guarded || guardBroken, guardBroken });
  return false;
}
