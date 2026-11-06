// game/defence.js — D12 player defence (GDD §13.2–13.4). Owner: GE.
//   * parry (features.parry): a timed deflect with the glove on the incoming side, against jabs and Swing Bridge;
//   * player hurt (with features.rise): heavy gloves after big or repeated unblocked hits;
//   * player get-up (features.rise): hold a full guard to rise; the 3rd knockdown is a KO.
// Like punches, a parry is classified on the backdated timeline (tOnset − punchBackdate) against the snapshot
// ring; its effects apply on the current tick (D4, P1).

import { EVENT, OPP_STATE, ATTACK, PARRY_RESULT, HURT_CAUSE } from '../shared/constants.js';
import { EPS } from './stamina.js';
import { parryRecover } from './opponent-ai.js';

const PARRYABLE = new Set([ATTACK.ROPE_SNAP, ATTACK.SWING_BRIDGE]); // never the Anchor Drop

export function isHurt(w) {
  return w.state.time < (w.state.player.hurtUntil ?? -1) - EPS;
}

// ───────────────────────────────────────────── parry

/** The player's glove that must parry a strike from her `side` (screen space is mirrored). */
export function parryGlove(side) {
  return side === 'left' ? 'right' : 'left';
}

export function parryWindow(T, contactAt) {
  return [contactAt - T.parryWindowOpen, contactAt - (T.latencyBudget + T.punchBackdate - T.impactDelay)];
}

/**
 * Resolve a parry input event {hand, tOnset, tCommit}.
 * Success: right glove, real jab / Swing Bridge, backdated onset inside the window, strike still unresolved.
 * Whiff: a swipe against a strike in progress (telegraph or attack) that fails any of those; that glove is out
 * of guard for parryWhiffLock. Nothing happens if no strike is in progress, or while the player is hurt.
 * @param {(t:number) => object} snapshotAt
 */
export function resolveParry(w, ev, snapshotAt) {
  const st = w.state;
  const T = w.T;
  const o = st.opponent;
  const ai = w.ctx.ai;
  if (st.player.down || isHurt(w)) return null; // D12: parry and dodge are disabled while hurt
  const hitTime = ev.tOnset - T.punchBackdate;
  const snap = snapshotAt(hitTime);
  if (snap.state !== OPP_STATE.TELEGRAPH && snap.state !== OPP_STATE.ATTACK) return null; // nothing to parry
  const [open, close] = parryWindow(T, snap.contactAt ?? -Infinity);
  const inWindow = snap.contactAt !== null && hitTime >= open - EPS && hitTime <= close + EPS;
  const real = !snap.feint && PARRYABLE.has(snap.attack);
  const glove = ev.hand === parryGlove(snap.side);
  // the same strike must still be pending live (same sequence and strike, not yet resolved)
  const pending = ai.seq === snap.seq && o.combo.index === snap.comboIndex && !ai.resolved &&
    (o.state === OPP_STATE.TELEGRAPH || o.state === OPP_STATE.ATTACK);
  if (inWindow && real && glove && pending) {
    st.player.stats.parries = (st.player.stats.parries ?? 0) + 1;
    w.emit(EVENT.PARRY, { result: PARRY_RESULT.SUCCESS, attack: snap.attack, hand: ev.hand });
    parryRecover(w);
    return { result: PARRY_RESULT.SUCCESS, attack: snap.attack };
  }
  w.emit(EVENT.PARRY, { result: PARRY_RESULT.WHIFF, attack: null, hand: ev.hand });
  // the verdict for training feedback (D14): why, and early / late in ms against the window
  const verdict = { result: PARRY_RESULT.WHIFF, attack: null };
  if (!real) verdict.reason = snap.feint ? 'feint' : 'not_parryable';
  else if (!glove) verdict.reason = 'wrong_hand';
  else if (snap.contactAt !== null && hitTime < open - EPS) Object.assign(verdict, { reason: 'early', earlyMs: Math.round((open - hitTime) * 1000) });
  else if (snap.contactAt !== null && hitTime > close + EPS) Object.assign(verdict, { reason: 'late', lateMs: Math.round((hitTime - close) * 1000) });
  else verdict.reason = 'late';
  // that glove is out of guard from the backdated onset (P1); later guard samples in that span stop counting
  const until = Math.min(hitTime, st.time) + T.parryWhiffLock;
  w.ctx.parryLockUntil = Math.max(w.ctx.parryLockUntil ?? -1, until);
  for (const s of w.ctx.guardSamples) if (s.t >= hitTime - EPS && s.t < until - EPS) s.ok = false;
  return verdict;
}

export function parryLocked(w) {
  return w.state.time < (w.ctx.parryLockUntil ?? -1) - EPS;
}

// ───────────────────────────────────────────── player hurt

function hurt(w, dur, cause) {
  const p = w.state.player;
  const until = Math.max(p.hurtUntil ?? -1, w.state.time + dur); // refreshes, never stacks
  p.hurtUntil = until;
  w.ctx.ai.pressNext = true; // her next cooldown ×0.6
  w.emit(EVENT.PLAYER_HURT, { until, cause });
}

/**
 * After one of her strikes resolves (not a knockdown). unblocked: it hit the player; guardBroken: a guard break.
 */
export function noteStrikeOutcome(w, { attack, unblocked, guardBroken }) {
  const T = w.T;
  const t = w.state.time;
  const ctx = w.ctx;
  if (guardBroken) {
    hurt(w, T.playerHurtLongDur, HURT_CAUSE.GUARD_BREAK);
    return;
  }
  if (!unblocked) return;
  ctx.unblockedHits = (ctx.unblockedHits ?? []).filter((x) => x > t - T.playerHurtTwoHitsWindow - EPS);
  ctx.unblockedHits.push(t);
  const long = attack === ATTACK.ANCHOR_DROP;
  if (T.strikeDamage[attack] >= T.playerHurtBigHit) {
    hurt(w, long ? T.playerHurtLongDur : T.playerHurtDur, HURT_CAUSE.BIG_HIT);
  } else if (ctx.unblockedHits.length >= 2) {
    hurt(w, long ? T.playerHurtLongDur : T.playerHurtDur, HURT_CAUSE.TWO_HITS);
  }
}

// ───────────────────────────────────────────── player get-up (hold a full guard)

/** On the player's knockdown n (1-based): set up the hold, or null for no rise (the 3rd: KO). */
export function initRise(w, n) {
  const T = w.T;
  const p = w.state.player;
  w.ctx.rise = null;
  if (n >= T.playerKoKnockdown) return; // no rise: the count runs to 10, then KO
  const need = T.riseHold[Math.min(n, T.riseHold.length) - 1];
  Object.assign(p.down, { holdProgress: 0, holdNeeded: need, deadlineCount: T.riseDeadlineCount });
  w.ctx.rise = { holdStart: null, lastOk: null, doneAt: null };
}

/** Once per tick while the player is down: accumulate a continuous full-guard hold (raw guard samples). */
export function updateRise(w, frame) {
  const T = w.T;
  const p = w.state.player;
  const r = w.ctx.rise;
  if (!p.down || !r || p.down.holdNeeded == null || r.doneAt !== null) return;
  const t = w.state.time;
  if (t < p.down.since + T.riseStartCount * T.countInterval - EPS) return; // the hold may start at count 1
  if (frame.guard?.raw) {
    if (r.holdStart === null) r.holdStart = t;
    r.lastOk = t;
  } else if (r.lastOk !== null && t - r.lastOk > T.riseBreakMax + EPS) {
    r.holdStart = null;
    r.lastOk = null;
  }
  const progress = r.holdStart === null ? 0 : (r.lastOk ?? t) - r.holdStart;
  p.down.holdProgress = Math.min(progress, p.down.holdNeeded);
  if (progress >= p.down.holdNeeded - EPS) r.doneAt = r.holdStart + p.down.holdNeeded;
}

/**
 * At a count tick n: 'rise' if the hold completed (by the deadline count + latencyBudget arrival grace),
 * 'ko' at the final count, else null.
 */
export function riseDecision(w, n) {
  const T = w.T;
  const p = w.state.player;
  const r = w.ctx.rise;
  const deadline = p.down.since + T.riseDeadlineCount * T.countInterval + T.latencyBudget;
  if (r && r.doneAt !== null && r.doneAt <= deadline + EPS) return 'rise';
  return n >= T.koCount ? 'ko' : null;
}

export function riseHp(w) {
  const T = w.T;
  const n = w.state.player.knockdowns;
  return T.riseHp[Math.min(n, T.riseHp.length) - 1];
}
