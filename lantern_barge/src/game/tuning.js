// game/tuning.js — every gameplay number (owner: GE). Values come from docs/game-design.md (GDD) and
// docs/decisions.md. Units: seconds unless the key ends in Ms. The sim reads these AT USE TIME, so
// __game.setTuning('game.<key>', v) takes effect on the next tick.
// Keys marked "GE pick" are not fixed by the docs; they are listed in the M1 report.

export const tuning = {
  // ── match format (GDD §2)
  hpMax: { player: 100, opponent: 275 }, // D9: Tamsin is the tank (QA tunes hers in ±25 steps)
  staminaMax: 100,
  roundCount: 3,
  roundLength: 60,
  restLength: 20,
  restHeal: { player: 15, opponent: 25 }, // D9; capped at hpMax; stacks on the get-up HP (D5a)
  countdownSeconds: 3, // pre-round 3-2-1 (GE pick: 1 s per number)
  practiceLength: 15,

  // ── knockdowns (GDD §2, D5)
  countInterval: 1, // one count per second
  getupCount: 8,
  koCount: 10,
  getupHpFrac: 0.5, // D9: get up at Math.round(0.5 × max HP): player 50, Tamsin 138 (of 275); follows hpMax tuning
  opponentGetupDur: 1.0, // her getup animation after the count, before she circles again (GE pick)

  // ── player damage (GDD §5, §6)
  baseDamage: { straight: 7, hook: 10, uppercut: 7 },
  fatigueMult: 0.5,
  highGuardHookMult: 0.5, // D9: her high guard (incl. cover-up) vs a hook (not clean); straights are blocked (M 0)
  counterMult: 1.25, // D9
  interruptMult: 2.0,
  aimZone: [0.2, 0.8], // straights in range; hooks always reach
  whiffExtraStamina: 4,

  // ── stamina (GDD §5)
  punchCostBase: 5,
  punchCostPower: 7,
  regenRate: 14, // per s
  regenDelay: 0.7, // after the last punch or block
  regenGuardFactor: 0.5,
  pressureRegenGuardFactor: 0.25, // D9a: guarding regen under pressure
  gassedDur: 1.2,
  fatigueLine: 25, // player.fatigued below this stamina
  lowHpLine: 25, // player.lowHp below this HP
  blockCost: { rope_snap: 3, swing_bridge: 8, anchor_drop: 30 },
  guardBreakBelow: 30, // blocking an Anchor Drop with less stamina breaks the guard
  pressureGuardBreakBelow: 40, // D9a
  pressureAnchorBlockCost: 40, // D9a: a blocked Anchor Drop under pressure (normally blockCost 30)
  pressureAnchorBlockedDmg: 10, // D9a (normally blockedDamage 5)
  blockedStraightExtraStamina: 4, // D9a: a straight blocked by her high guard / cover-up costs this extra
  guardBreakDur: 0.6,

  // ── latency (D4, GDD §8)
  punchBackdate: 0.033,
  latencyBudget: 0.18, // measured in M3; the interrupt window closes latencyBudget + punchBackdate − impactDelay
  //                      (113 ms) before contact, so an interrupt always lands before her strike resolves (BUG-009)
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
  ropeSnapJabs: [1, 3],
  ropeSnapInterval: 0.3, // contact to contact
  strikeHold: 0.15, // 'attack' stage length after contact (GE pick; must cover impactDelay)
  interruptWindowOpen: 0.6, // s before contact; a real Anchor Drop's guard drops to 'none' here (D9)
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
  cooldown: [2.0, 1.3, 1.0], // circle time before her next sequence, R1 / R2 / R3 (D9)
  weights: { rope_snap: 50, swing_bridge: 35, anchor_drop: 15 },
  maxSameAttackInRow: 2,
  antiSpamBelow: 30, // player stamina
  antiSpamRopeWeight: 70,
  antiSpamCooldownFactor: 0.7,

  // ── free hits and cover-up (D9, GDD §6): clean hits allowed per guard-down window
  freeHits: { rope_snap: 1, swing_bridge: 1, anchor_drop: 2, interruptHurt: 2, circleLow: 1 },
  comboRecoverExtra: 0.3, // Recover after a combo = last attack's Recover + this
  comboExtraFreeHits: 1,

  // ── sequences (D9, GDD §6 "Choosing a sequence"): [single, feint, combo] per round
  sequenceKind: [
    [1, 0, 0],
    [0.8, 0.2, 0],
    [0.45, 0.2, 0.35],
  ],

  // ── feints (R2, R3)
  feintWeights: { swing_bridge: 60, anchor_drop: 40 },
  feintCancel: { swing_bridge: { frac: 0.5 }, anchor_drop: { beforeContact: 0.7 } }, // from telegraph start
  feintCoverDur: 0.3, // high guard after a cancel (no punish)
  punishProb: [0, 0.5, 0.75], // per round
  punishJabs: [1, 2],
  punishWindup: 0.45, // the punish telegraph starts on the cancel tick; contact = cancel + 450 ms
  feintCooldownCredit: 0.5, // no punish: back to circle with this share of the cooldown already elapsed

  // ── combos (R3); gap = contact to contact from the previous strike
  combos: {
    snap_drop: [{ attack: 'rope_snap' }, { attack: 'anchor_drop', gap: 0.9 }],
    // jab: true = another jab of the same Rope Snap (one attack for the no-3-in-a-row history)
    bridge_snap: [{ attack: 'swing_bridge' }, { attack: 'rope_snap', gap: 0.3 }, { attack: 'rope_snap', gap: 0.3, jab: true }],
    double_bridge: [{ attack: 'swing_bridge' }, { attack: 'swing_bridge', gap: 0.5, otherSide: true }],
  },
  comboWeights: { snap_drop: 40, bridge_snap: 35, double_bridge: 25 },
  comboWeightsPressure: { snap_drop: 70, bridge_snap: 15, double_bridge: 15 },

  // ── pressure (D9a; replaces the continuous-guard anti-turtle)
  pressureWindow: 8, // s without a counter / interrupt, and the guard-share window
  pressureGuardShare: 0.7, // share of live ticks in full guard over the window
  pressureAnchorWeight: 45,
};
