// game/tuning.js — every gameplay number (owner: GE). Values come from docs/game-design.md (GDD) and
// docs/decisions.md. Units: seconds unless the key ends in Ms. The sim reads these AT USE TIME, so
// __game.setTuning('game.<key>', v) takes effect on the next tick.
// Keys marked "GE pick" are not fixed by the docs; they are listed in the M1 report.

export const tuning = {
  // ── match format (GDD §2)
  hpMax: 100,
  staminaMax: 100,
  roundCount: 3,
  roundLength: 60,
  restLength: 20,
  restHeal: 15, // both fighters, capped at hpMax; stacks on a get-up's 50 HP (D5a)
  countdownSeconds: 3, // pre-round 3-2-1 (GE pick: 1 s per number)
  practiceLength: 15,

  // ── knockdowns (GDD §2, D5)
  countInterval: 1, // one count per second
  getupCount: 8,
  koCount: 10,
  getupHp: 50,
  opponentGetupDur: 1.0, // her getup animation after the count, before she circles again (GE pick)

  // ── player damage (GDD §5, §6)
  baseDamage: { straight: 7, hook: 10, uppercut: 7 },
  fatigueMult: 0.5,
  highGuardHookMult: 0.7, // her high guard vs a hook (not clean); straights are blocked (M 0)
  counterMult: 1.5,
  interruptMult: 2.0,
  aimZone: [0.2, 0.8], // straights in range; hooks always reach
  whiffExtraStamina: 4,

  // ── stamina (GDD §5)
  punchCostBase: 5,
  punchCostPower: 7,
  regenRate: 14, // per s
  regenDelay: 0.7, // after the last punch or block
  regenGuardFactor: 0.5,
  gassedDur: 1.2,
  fatigueLine: 25, // player.fatigued below this stamina
  lowHpLine: 25, // player.lowHp below this HP
  blockCost: { rope_snap: 3, swing_bridge: 8, anchor_drop: 30 },
  guardBreakBelow: 30, // blocking an Anchor Drop with less stamina breaks the guard
  guardBreakDur: 0.6,

  // ── latency (D4, GDD §8)
  punchBackdate: 0.033,
  latencyBudget: 0.18, // measured in M3; the interrupt window closes latencyBudget − impactDelay before contact
  impactDelay: 0.1, // her damage applies at contact + impactDelay
  lateBlockMinSamples: 2,
  lateBlockMinMs: 30,
  snapshotHistory: 1.0, // s of opponent snapshots kept (≥ latencyBudget + backdate + 0.1 is enforced)

  // ── Tamsin's attacks (GDD §6)
  windup: {
    // per round R1 / R2 / R3; the same table for keyboard and camera (D5a)
    rope_snap: [0.55, 0.5, 0.45],
    swing_bridge: [0.8, 0.7, 0.65],
    anchor_drop: [1.3, 1.2, 1.1],
  },
  telegraphFloor: 0.45, // the first strike of any sequence is never faster than this (D4)
  strikeDamage: { rope_snap: 5, swing_bridge: 12, anchor_drop: 22 },
  blockedDamage: { rope_snap: 0, swing_bridge: 2, anchor_drop: 5 },
  recoverDur: { rope_snap: 0.6, swing_bridge: 0.9, anchor_drop: 1.4 },
  shakeTier: { rope_snap: 1, swing_bridge: 2, anchor_drop: 3 },
  telegraphGuard: { rope_snap: 'high', swing_bridge: 'low', anchor_drop: 'none' },
  ropeSnapJabs: [1, 3],
  ropeSnapInterval: 0.3, // contact to contact
  strikeHold: 0.15, // 'attack' stage length after contact (GE pick; must cover impactDelay)
  interruptWindowOpen: 0.6, // s before contact
  interruptPowerMin: 0.5,
  interruptStagger: 1.0,
  offBalanceExtend: 0.15,
  offBalanceExtendMax: 0.45,

  // ── Tamsin's AI (GDD §6)
  decisionInterval: 0.3,
  guardHighDur: [1.2, 2.0],
  guardLowDur: [0.6, 0.9],
  hurtDur: 0.25,
  stunLockHits: 3,
  stunLockWindow: 1.5,
  staggerImmuneDur: 1.0,
  cooldown: [1.8, 1.3, 1.0], // circle time before her next attack, R1 / R2 / R3
  weights: { rope_snap: 50, swing_bridge: 35, anchor_drop: 15 },
  maxSameAttackInRow: 2,
  antiTurtleHold: 3, // s of continuous full guard
  antiTurtleAnchorWeight: 45,
  antiSpamBelow: 30, // player stamina
  antiSpamRopeWeight: 70,
  antiSpamCooldownFactor: 0.7,
};
