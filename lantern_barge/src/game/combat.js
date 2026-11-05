// game/combat.js — punch resolution against the opponent snapshot ring, her strikes, late block, guard break
// (GDD §5, §6, §8; decisions D4; architecture §3.7). Owner: GE.
//
// Latency model (no re-simulation):
//   * every tick pushes a snapshot of Tamsin into a ring;
//   * a punch is CLASSIFIED against the snapshot at its hit time (tOnset − punchBackdate);
//   * its damage and side effects apply on the current tick;
//   * only the interrupt window closes early (latencyBudget − impactDelay before contact);
//   * her strike resolves at contact + impactDelay and is blocked by ≥ 2 consecutive raw guard samples
//     spanning ≥ 30 ms inside [contact, contact + impactDelay].

import { EVENT, OPP_STATE, ATTACK, PHASE, PUNCH } from '../shared/constants.js';
import { EPS, isGassed, punchCost, fatigueFactor, spend } from './stamina.js';
import { staggerOpponent, extendOffBalance } from './opponent-ai.js';
import { knockdown } from './phases.js';

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

// ───────────────────────────────────────────── classification (GDD §6 interaction table)

/**
 * @returns {{kind:'whiff'|'blocked'|'hit', M:number, counter:boolean, interrupt:boolean, clean:boolean,
 *            stagger:boolean}}
 */
export function classifyPunch(T, snap, punch, hitTime) {
  const res = { kind: 'hit', M: 1, counter: false, interrupt: false, clean: true, stagger: false };
  const straight = punch.punchType !== PUNCH.HOOK;
  if (snap.state === OPP_STATE.KNOCKDOWN || snap.state === OPP_STATE.GETUP) return { ...res, kind: 'whiff', clean: false };
  const aimX = punch.aim?.x ?? 0.5;
  if (straight && (aimX < T.aimZone[0] - EPS || aimX > T.aimZone[1] + EPS)) return { ...res, kind: 'whiff', clean: false };

  if (snap.state === OPP_STATE.RECOVER) return { ...res, M: T.counterMult, counter: true };

  if (snap.state === OPP_STATE.TELEGRAPH && snap.attack === ATTACK.ANCHOR_DROP && snap.contactAt !== null) {
    const open = snap.contactAt - T.interruptWindowOpen;
    const close = snap.contactAt - (T.latencyBudget - T.impactDelay);
    const inWindow = hitTime >= open - EPS && hitTime <= close + EPS;
    if (inWindow && straight && punch.power >= T.interruptPowerMin - EPS) {
      return { ...res, M: T.interruptMult, interrupt: true };
    }
  }

  if (snap.guard === 'high') {
    if (straight) return { ...res, kind: 'blocked', M: 0, clean: false };
    return { ...res, M: T.highGuardHookMult, clean: false };
  }
  // circle with a low guard is the only plain state that staggers (hurt is already staggered)
  return { ...res, stagger: snap.state === OPP_STATE.CIRCLE };
}

// ───────────────────────────────────────────── player punches

/** Is a round live enough for punches to cost stamina and resolve? (countdown and rest only acknowledge) */
function punchesResolve(st) {
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

  const live = punchesResolve(st);
  if (live && (isGassed(p, t) || p.stamina <= 0)) {
    w.emit(EVENT.PUNCH_REJECTED, { id, hand, reason: 'gassed' });
    return;
  }
  w.emit(EVENT.PUNCH_THROWN, { id, hand, punchType, power, inferred: !!ev.inferred });
  if (!live) return; // practice (mitts, no damage), countdown, rest, boot, match end

  p.stats.thrown += 1;
  const fatigue = fatigueFactor(T, p);
  let cost = punchCost(T, power);
  const hitTime = ev.tOnset - T.punchBackdate;
  const snap = o.down ? { ...snapshotOf(w), state: OPP_STATE.KNOCKDOWN } : snapshotAt(w, hitTime);
  const c = classifyPunch(T, snap, { punchType, power, aim: ev.aim }, hitTime);

  // An interrupt only counts while the strike it would cancel is still unresolved (same attack sequence).
  if (c.interrupt) {
    const ai = w.ctx.ai;
    const pending = ai.seq === snap.seq && !ai.resolved &&
      (o.state === OPP_STATE.TELEGRAPH || o.state === OPP_STATE.ATTACK) && o.attack === ATTACK.ANCHOR_DROP;
    if (!pending) Object.assign(c, { M: 1, interrupt: false });
  }

  if (c.kind === 'whiff') {
    cost += T.whiffExtraStamina;
    p.stats.whiffed += 1;
    w.emit(EVENT.WHIFF, { by: 'player', id, hand, punchType });
    spend(w, cost);
    return;
  }
  if (c.kind === 'blocked') {
    p.stats.blocked += 1;
    w.emit(EVENT.BLOCKED, { by: 'player', hand, punchType, attack: null, staminaCost: 0 });
    spend(w, cost);
    return;
  }

  const base = T.baseDamage[punchType] ?? T.baseDamage.straight;
  const raw = base * (0.5 + 0.5 * power) * fatigue * c.M;
  const damage = Math.min(o.hp, raw);
  o.hp -= damage;
  p.points += damage;
  p.stats.landed += 1;
  if (c.counter) p.stats.counters += 1;
  if (c.interrupt) p.stats.interrupts += 1;
  w.emit(EVENT.HIT, { by: 'player', hand, punchType, power, damage, counter: c.counter, interrupt: c.interrupt });

  if (o.hp <= EPS) {
    o.hp = 0;
    spend(w, cost);
    knockdown(w, 'opponent');
    return;
  }

  if (c.clean) {
    const ai = w.ctx.ai;
    if (c.interrupt) {
      staggerOpponent(w, T.interruptStagger, true); // cancels the Anchor Drop, ignores immunity
    } else if (c.counter) {
      if (o.state === OPP_STATE.RECOVER && o.offBalance && ai.seq === snap.seq) extendOffBalance(w);
    } else if (c.stagger && o.state === OPP_STATE.CIRCLE && (t >= o.staggerImmuneUntil - EPS || o.offBalance)) {
      staggerOpponent(w, T.hurtDur, false);
    }
    // anti-stun-lock: 3 clean hits within 1.5 s → immune to stagger for 1 s
    ai.cleanHits.push(t);
    while (ai.cleanHits.length && ai.cleanHits[0] < t - T.stunLockWindow - EPS) ai.cleanHits.shift();
    if (ai.cleanHits.length >= T.stunLockHits) {
      o.staggerImmuneUntil = t + T.staggerImmuneDur;
      ai.cleanHits.length = 0;
    }
  }
  spend(w, cost);
}

// ───────────────────────────────────────────── her strikes

function damagePlayer(w, amount) {
  const st = w.state;
  const applied = Math.min(st.player.hp, amount);
  st.player.hp -= applied;
  st.opponent.points += applied;
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

  if (guarded && attack === ATTACK.ANCHOR_DROP && p.stamina < T.guardBreakBelow) {
    p.guardBrokenUntil = t + T.guardBreakDur;
    p.guard = 'none';
    p.guardHeldSince = -1;
    w.emit(EVENT.GUARD_BROKEN, { until: p.guardBrokenUntil });
    const damage = damagePlayer(w, T.strikeDamage[attack]);
    w.emit(EVENT.PLAYER_HIT, { attack, side, damage, shakeTier: T.shakeTier[attack] });
  } else if (guarded) {
    const cost = T.blockCost[attack];
    w.emit(EVENT.BLOCKED, { by: 'opponent', hand: side, punchType: null, attack, staminaCost: cost });
    spend(w, cost);
    damagePlayer(w, T.blockedDamage[attack]);
  } else {
    const damage = damagePlayer(w, T.strikeDamage[attack]);
    w.emit(EVENT.PLAYER_HIT, { attack, side, damage, shakeTier: T.shakeTier[attack] });
  }
  if (p.hp <= EPS) {
    p.hp = 0;
    knockdown(w, 'player');
    return true;
  }
  return false;
}
