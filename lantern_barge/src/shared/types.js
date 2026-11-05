// shared/types.js — JSDoc typedefs and the normative event table (owner: PD). No runtime code.
// Import types with: /** @typedef {import('../shared/types.js').InputFrame} InputFrame */
// Source of truth: docs/architecture.md §3 (frozen). Units: every `t` is SIM SECONDS (D4).
// Screen space is the mirrored camera image normalized to [0,1], x right, y down.
// left/right always mean the player's anatomical hands.

export {};

// ───────────────────────────────────────────── input (§3.2–3.4)

/**
 * @typedef {Object} HandState
 * @property {boolean} present      detected now or within lossGraceMs
 * @property {boolean} predicted    extrapolated this frame (no new detection)
 * @property {boolean} fist         THE fist signal; verbs read only this (D2)
 * @property {number}  openness     0..1 filtered (0 = tight fist), display/tint only
 * @property {number}  x            mirrored screen x of palm center (display-filtered, predicted to t)
 * @property {number}  y            screen y, down
 * @property {number}  vx           frame widths/s (+ = screen right)
 * @property {number}  vy           frame heights/s (+ = down)
 * @property {number}  k            knuckle span (landmark 5–17), frame heights; raw latest
 * @property {number}  kRatio       k / kGuard (1 at guard depth; NaN before calibration)
 * @property {number}  rate         d ln k / dt, 1/s, from raw samples
 * @property {number}  ext          view-only glove depth: 0 at guard, 1 at kRatio = extFullRatio; clamp -0.5..1.5
 * @property {boolean} inGuardZone  geometric: fist in this hand's guard zone, not locked out
 * @property {'idle'|'onset'|'refractory'} punchPhase   'onset' = classifier armed; gloves may lead with it
 */

/**
 * D13 (M7-in spike, ?next=1 only): present + raw face box; dx/dy/w0/dodge arrive with M7. Otherwise {present:false}.
 * @typedef {Object} HeadState
 * @property {boolean} present
 * @property {{x:number, y:number, w:number, h:number, score:number}} [raw]   face-box centre and size (normalized; x mirrored like the hands)
 */

/**
 * @typedef {Object} CalibrationStatus
 * @property {boolean} active
 * @property {boolean} wanted       this source wants a calibration session (camera; replay with {calibrate:true})
 *           GE: BOOT + start → frame.calibration.wanted ? CALIBRATION : PRACTICE
 * @property {number}  session      echo of beginCalibration(session); 0 when none
 * @property {'framing'|'guard'|'straights'|'done'|null} step   CALIB_STEP
 * @property {number}  progress     0..1 within step (hold timers)
 * @property {number}  count        e.g. straights detected so far
 * @property {number}  target       e.g. 3
 * @property {{value:number, threshold:number}|null} meter   live peak rate vs threshold (after the GDD delay)
 * @property {string|null} hint     one of CALIB_HINT
 * @property {boolean} done         a profile from THIS session is ready
 * @property {{left:number[][], right:number[][]}} [landmarks]  21 mirrored [x,y] per hand; ONLY while active
 * @property {{yMin:number, yMax:number, xMin:number, xMax:number}} [framingBand]  D3a: the band framing checks (target box); only while active
 */

/**
 * @typedef {Object} TrackingStatus
 * @property {boolean} ok           false: camera stalled/ended or worker died
 * @property {number}  fps          detection results per second
 * @property {number}  inferMs
 * @property {number}  pipelineMs   result arrival − capture (EMA)
 * @property {'GPU'|'CPU'|null} delegate
 * @property {{ok:boolean|null, error:string|null, ms:number, every:number, runs:number, found:number}} [face]
 *           D13 spike (?next=1): face detector status and cost
 */

/**
 * @typedef {Object} GuardState
 * @property {'none'|'full'} level  geometric guard after the D3 timing rules (90 on / 150 off / 300 grace)
 * @property {boolean} raw          both hands in-zone on THIS sample, no debounce (late-block input, D4)
 * @property {boolean} left         per-hand inGuardZone (HUD pips)
 * @property {boolean} right
 * @property {number}  since        sim s when `level` last changed
 */

/**
 * @typedef {Object} InputFrame
 * @property {number} t                     sim seconds (D4)
 * @property {number} seq
 * @property {'camera'|'replay'|'keyboard'|'none'} source
 * @property {TrackingStatus} tracking
 * @property {{left:HandState, right:HandState}} hands
 * @property {HeadState} head
 * @property {GuardState} guard
 * @property {InputEvent[]} events         drained by sample(); always [] from peek()
 * @property {CalibrationStatus} calibration
 * @property {{kGuardDrift:number|null, hint:'return_to_spot'|null}} spot   always {null,null} for keyboard
 * @property {GestureState} gesture        D10 camera gestures; always idle for keyboard
 * @property {import('./features.js').Features} features   M5+ flags (?next=1), stamped by main.js on every frame
 */

/**
 * D10 held camera gestures (camera and replay sources).
 * @typedef {Object} GestureState
 * @property {'confirm'|'pause'|'resume'|null} kind   the hold in progress (or the one that just fired), else null
 *           confirm = both fists in the guard zone; pause = both hands open at face height (also cancels
 *           calibration); resume = the 3-2-1 auto-resume after a camera-loss pause (guard held 3 s)
 * @property {number}  progress     0..1 of the hold (resume: 3-2-1 is 3 − floor(progress × 3))
 * @property {boolean} fired        true on the one sampled frame where the hold completed
 * @property {Array<'confirm'|'pause'|'resume'>} available   gestures that count in this phase (prompt copy)
 */

/**
 * @typedef {Object} PunchEvent
 * @property {'punch'} type
 * @property {number} id                    unique per source session; never re-used
 * @property {'left'|'right'} hand
 * @property {'straight'|'hook'|'uppercut'} punchType
 * @property {'head'|'body'} target         D12: camera = palm ≥ 0.12 fh below guard at commit (straight/hook); keyboard = Shift
 * @property {number} power                 0..1, computed by input
 * @property {{x:number}} aim               mirrored screen x at commit
 * @property {number} tOnset                capture time of the onset run's first sample (true time, NO backdate)
 * @property {number} tCommit               capture time of the confirming (or last-seen, if inferred) sample
 * @property {boolean} inferred             committed by blur rescue
 */

/**
 * Convenience event; frame.guard is authoritative.
 * @typedef {{type:'guard', level:'none'|'full', t:number}} GuardEvent
 */

/**
 * D12 parry: a closed fist swiping outward from the guard zone (camera) or A / ; (keyboard). The game decides
 * whether a parryable strike is pending (window, side, attack) and emits the game event parry{result}.
 * @typedef {{type:'parry', id:number, hand:'left'|'right', tOnset:number, tCommit:number}} ParryInputEvent
 */

/** @typedef {PunchEvent|GuardEvent|ParryInputEvent} InputEvent */

/**
 * @typedef {Object} HandProfile
 * @property {number} kGuard              knuckle span at guard (frame heights)
 * @property {{x:number, y:number}} center   guard center (mirrored screen)
 * @property {number} noise               σ of rate (1/s) during the guard hold
 * @property {number} straightThreshold   1/s
 * @property {number} straightRateFull    1/s
 */

/**
 * @typedef {Object} CalibrationProfile
 * @property {1} version
 * @property {{left:HandProfile, right:HandProfile}} hands
 */

/**
 * @typedef {Object} InputSource
 * @property {'camera'|'replay'|'keyboard'|'none'} kind
 * @property {() => Promise<void>} start
 * @property {() => void} stop
 * @property {(t:number) => InputFrame} sample      drains events with tCommit ≤ t; once per tick
 * @property {(t:number) => InputFrame} peek        never drains; events: []
 * @property {(session:number) => void} beginCalibration   synchronously resets status: done=false, session=session
 * @property {() => void} cancelCalibration
 * @property {CalibrationProfile|null} profile
 */

// ───────────────────────────────────────────── game state (§3.5)

/**
 * @typedef {Object} FighterStats
 * @property {number} thrown @property {number} landed @property {number} blocked
 * @property {number} whiffed @property {number} counters @property {number} interrupts
 * @property {number} splits    D11: her guard split by an uppercut
 * @property {number} parries   D12: successful parries
 * @property {number} bodyHits  D12: body shots that landed
 */

/**
 * Knockdown sub-state: count = the current count number (0 right after the knockdown, then 1..8 or 1..10).
 * D12 (player only, hold-guard rise): holdProgress / holdNeeded in seconds (the ring shows the ratio), deadlineCount =
 * the count the hold must finish by (9). Absent = automatic get-up (Tamsin, or without ?next=1).
 * @typedef {{since:number, count:number, holdProgress?:number, holdNeeded?:number, deadlineCount?:number}} DownState
 */

/**
 * @typedef {Object} Player
 * @property {number} hp
 * @property {number} maxHp
 * @property {number} stamina
 * @property {number} maxStamina
 * @property {boolean} fatigued        display flag: stamina below the GDD fatigue line
 * @property {boolean} lowHp           display flag
 * @property {boolean} pressured       D9a: pressure is on (no counter for 8 s while guarding ≥ 70 %); see game-design §5/§6
 * @property {number}  hurtUntil       D12: sim s; hurt while time < hurtUntil (punches ×0.7, +3 stamina, no parry/dodge)
 * @property {number}  gassedUntil     sim s; gassed while time < gassedUntil (-1 = never)
 * @property {'none'|'full'} guard     EFFECTIVE guard: guardBroken ? 'none' : frame.guard.level (D3)
 * @property {number}  guardBrokenUntil  sim s (-1 = never)
 * @property {number}  guardHeldSince  sim s or -1 (anti-turtle; also for the view)
 * @property {number}  knockdowns      per MATCH (D12: the player's 3rd is a KO; a failed rise is a KO)
 * @property {DownState|null} down
 * @property {number}  points          100 × damage dealt / opponent.maxHp, overkill excluded, 0.1 steps (D9)
 * @property {FighterStats} stats
 */

/**
 * @typedef {Object} Opponent
 * @property {number} hp
 * @property {number} maxHp
 * @property {'circle'|'telegraph'|'attack'|'recover'|'hurt'|'knockdown'|'getup'} state   OPP_STATE
 * @property {'rope_snap'|'swing_bridge'|'anchor_drop'|null} attack   set during telegraph/attack/recover
 * @property {'left'|'right'|null} side            her striking hand, from HER perspective
 * @property {{index:number, count:number}} combo  strike i of n across the WHOLE sequence (D9); {0,1} when idle
 * @property {boolean} opening                     hits count as counters
 * @property {boolean} offBalance                  after Anchor Drop
 * @property {number}  staggerImmuneUntil
 * @property {number}  stageStart                  sim s the current state began
 * @property {number}  stageDur                    s; progress = (time − stageStart)/stageDur
 * @property {number|null} contactAt               sim s her current strike visually connects
 * @property {'high'|'low'|'none'} guard           OPP_GUARD
 * @property {boolean} mitts                       practice card
 * @property {boolean} feint                       D9: the current telegraph is a feint (bots must NOT read it)
 * @property {boolean} covering                    D9: free hits used up; guard high for the rest of the window
 * @property {number}  freeHits                    D9: clean hits left in the current open window
 * @property {{kind:'single'|'feint'|'punish'|'combo', combo:null|'snap_drop'|'bridge_snap'|'double_bridge'}} sequence
 *           D9: the sequence she is in (bots must NOT read it)
 * @property {number}  splitUntil                  D11: sim s; guard split (low, 1 free hit) while time < splitUntil
 * @property {number}  tuckUntil                   D11: sim s; tucked while time < tuckUntil (cover-up also counts)
 * @property {number}  stamina                     D12: Tamsin's stamina (body shots drain it)
 * @property {number}  maxStamina                  D12
 * @property {'fresh'|'tired'|'exhausted'} tired   D12: < 50 tired, < 20 exhausted
 * @property {number}  knockdowns                  per MATCH
 * @property {DownState|null} down
 * @property {number}  points                      100 × damage dealt / player.maxHp (D9)
 */

/**
 * @typedef {Object} RoundState
 * @property {number} n
 * @property {number} of
 * @property {number} timeLeft        s
 * @property {boolean} clockRunning
 * @property {number|null} countdown  pre-round 3-2-1 at the start of each FIGHT, else null
 * @property {number|null} restLeft   seconds remaining in ROUND_END (the rest), else null (GE fills it)
 */

/**
 * @typedef {Object} GameState
 * @property {string}  phase          PHASE.*
 * @property {number}  phaseStart     sim s
 * @property {number}  time           sim s since boot
 * @property {number}  tick
 * @property {number}  seed
 * @property {boolean} paused         sim time still advances; phase timers and AI freeze
 * @property {'camera'|'replay'|'keyboard'|'none'} inputKind   from frame.source
 * @property {number}  calibSession   session the sim is waiting for (0 when none)
 * @property {RoundState} round
 * @property {{timeLeft:number}|null} practice
 * @property {{winner:'player'|'opponent'|null, method:'ko'|'points'|null}} result   ties → player
 * @property {Player} player
 * @property {Opponent} opponent
 */

// ───────────────────────────────────────────── game events (§3.6) — NORMATIVE
//
// Every event has `type` and `t` (sim seconds) and is logged with its `tick`.
// In every event, `by` means WHO THREW THE STRIKE.
//
// | type           | payload fields                                                   | emitted when
// |----------------|------------------------------------------------------------------|---------------------------------------------
// | phase          | from, to                                                         | every phase change
// | round_start    | n                                                                | pre-round countdown ends, clock starts
// | round_end      | n                                                                | the round clock reaches 0
// | match_end      | winner, method, points:{player, opponent}                        | match decided (points in %, D9)
// | punch_thrown   | id, hand, punchType, power, inferred, target                     | player punch accepted, before resolution
// | punch_rejected | id, hand, reason:'gassed'                                        | punch received while gassed (no stamina cost)
// | hit            | by:'player', hand, punchType, power, damage, counter, interrupt, | a player punch lands on Tamsin (D12: target,
// |                | target, staminaDrain, riposte                                    | her stamina drained, riposte after a parry)
// | player_hit     | attack, side, damage, shakeTier                                  | Tamsin's strike lands on the player; shakeTier 1–3
// | blocked        | by, hand, punchType|null, attack|null, staminaCost               | by:'player' → her guard blocked punchType;
// |                |                                                                  | by:'opponent' → player blocked attack (cost paid by player)
// | whiff          | by:'player', id, hand, punchType                                 | punch out of range or nothing to hit
// | guard_broken   | until                                                            | player's guard broken
// | telegraph      | attack, side, windup, comboIndex, comboCount, feint, combo,      | wind-up starts (audio/glow key off attack);
// |                | afterFeint                                                       | comboIndex/Count span the whole sequence (D9)
// | strike         | attack, side, comboIndex                                         | at contactAt (outcome follows at contact + impactDelay)
// | stagger        | who, dur, interrupt                                              | stagger begins (interrupt: 1 s)
// | opening        | dur, freeHits                                                    | her recover opening starts
// | gassed         | until                                                            | player stamina hits 0
// | knockdown      | who, count                                                       | count = this fighter's knockdown number (1 or 2)
// | count          | who, n                                                           | each count tick during a knockdown
// | getup          | who, hp                                                          | auto get-up at count 8
// | feint_cancel   | attack, side                                                     | a feinted wind-up is cancelled (D9)
// | cover          | reason:'recover'|'hurt'|'circle'|'feint'|'split'                         | she covers up: free hits used up, or after a feint
// | pressure       | on                                                               | player.pressured changes (D9a); TA: bark + jeer on
// | guard_split    | until                                                            | an uppercut split her high guard (D11); low until `until`
// | parry          | result:'success'|'whiff', attack, hand                           | D12: the player's parry (hand = player's glove;
// |                |                                                                  | attack = the parried attack, null on a whiff)
// | opponent_tired | level:'fresh'|'tired'|'exhausted'                                | D12: her tiredness level changes
// | player_hurt    | until, cause:'big_hit'|'guard_break'|'two_hits'                  | D12: the player is hurt (refreshes, never stacks)

/** @typedef {'player'|'opponent'} Who */
/** @typedef {'left'|'right'} Hand */
/** @typedef {'rope_snap'|'swing_bridge'|'anchor_drop'} Attack */

/** @typedef {{type:'phase', t:number, from:string, to:string}} PhaseEvent */
/** @typedef {{type:'round_start', t:number, n:number}} RoundStartEvent */
/** @typedef {{type:'round_end', t:number, n:number}} RoundEndEvent */
/** @typedef {{type:'match_end', t:number, winner:Who, method:'ko'|'points', points:{player:number, opponent:number}}} MatchEndEvent */
/** @typedef {{type:'punch_thrown', t:number, id:number, hand:Hand, punchType:string, power:number, inferred:boolean, target?:'head'|'body'}} PunchThrownEvent */
/** @typedef {{type:'punch_rejected', t:number, id:number, hand:Hand, reason:'gassed'}} PunchRejectedEvent */
/** @typedef {{type:'hit', t:number, by:'player', hand:Hand, punchType:string, power:number, damage:number, counter:boolean, interrupt:boolean, target?:'head'|'body', staminaDrain?:number, riposte?:boolean}} HitEvent */
/** @typedef {{type:'player_hit', t:number, attack:Attack, side:Hand, damage:number, shakeTier:1|2|3}} PlayerHitEvent */
/** @typedef {{type:'blocked', t:number, by:Who, hand:Hand, punchType:string|null, attack:Attack|null, staminaCost:number}} BlockedEvent */
/** @typedef {{type:'whiff', t:number, by:'player', id:number, hand:Hand, punchType:string}} WhiffEvent */
/** @typedef {{type:'guard_broken', t:number, until:number}} GuardBrokenEvent */
/** @typedef {'snap_drop'|'bridge_snap'|'double_bridge'} ComboName */
/** @typedef {{type:'telegraph', t:number, attack:Attack, side:Hand, windup:number, comboIndex:number, comboCount:number, feint:boolean, combo:ComboName|null, afterFeint:boolean}} TelegraphEvent */
/** @typedef {{type:'strike', t:number, attack:Attack, side:Hand, comboIndex:number}} StrikeEvent */
/** @typedef {{type:'stagger', t:number, who:Who, dur:number, interrupt:boolean}} StaggerEvent */
/** @typedef {{type:'opening', t:number, dur:number, freeHits:number}} OpeningEvent */
/** @typedef {{type:'gassed', t:number, until:number}} GassedEvent */
/** @typedef {{type:'knockdown', t:number, who:Who, count:number}} KnockdownEvent */
/** @typedef {{type:'count', t:number, who:Who, n:number}} CountEvent */
/** @typedef {{type:'getup', t:number, who:Who, hp:number}} GetupEvent */
/** @typedef {{type:'feint_cancel', t:number, attack:Attack, side:Hand}} FeintCancelEvent */
/** @typedef {{type:'cover', t:number, reason:'recover'|'hurt'|'circle'|'feint'|'split'}} CoverEvent */
/** @typedef {{type:'pressure', t:number, on:boolean}} PressureEvent */
/** @typedef {{type:'guard_split', t:number, until:number}} GuardSplitEvent */
/** @typedef {{type:'parry', t:number, result:'success'|'whiff', attack:Attack|null, hand:Hand}} ParryEvent */
/** @typedef {{type:'opponent_tired', t:number, level:'fresh'|'tired'|'exhausted'}} OpponentTiredEvent */
/** @typedef {{type:'player_hurt', t:number, until:number, cause:'big_hit'|'guard_break'|'two_hits'}} PlayerHurtEvent */

/**
 * @typedef {PhaseEvent|RoundStartEvent|RoundEndEvent|MatchEndEvent|PunchThrownEvent|PunchRejectedEvent|
 *   HitEvent|PlayerHitEvent|BlockedEvent|WhiffEvent|GuardBrokenEvent|TelegraphEvent|StrikeEvent|
 *   StaggerEvent|OpeningEvent|GassedEvent|KnockdownEvent|CountEvent|GetupEvent|FeintCancelEvent|CoverEvent|PressureEvent|GuardSplitEvent|ParryEvent|OpponentTiredEvent|PlayerHurtEvent} GameEvent
 */

// ───────────────────────────────────────────── APIs (§3.7–3.9)

/**
 * @typedef {{type:'start'} | {type:'cancel'} | {type:'skip_practice'} | {type:'pause'} | {type:'resume'} |
 *   {type:'restart', seed?:number} |
 *   {type:'goto_phase', phase:string} |
 *   {type:'force_attack', attack:Attack, side?:Hand, combo?:number} |
 *   {type:'debug_set', path:string, value:any} |
 *   {type:'set_round', n:number} |
 *   {type:'force_sequence', kind:'single'|'feint'|'combo', attack?:Attack, combo?:ComboName, side?:Hand, punish?:boolean}} SimCommand
 * goto_phase, force_attack, debug_set, set_round and force_sequence are test/debug only (ignored with a console
 * warning unless allowDebug). force_sequence (D9): kind 'feint' needs attack swing_bridge|anchor_drop and takes
 * punish (force the punish roll); kind 'combo' takes combo; kind 'single' takes attack (like force_attack).
 */

/**
 * createSim(opts) from src/game/sim.js. main.js always reads `sim.state` (never caches it), so a getter is fine.
 * @typedef {Object} Sim
 * @property {GameState} state                                  live object; read-only outside game/
 * @property {(frame:InputFrame, dt:number) => GameEvent[]} step  1) apply queued commands, 2) advance one tick
 * @property {(cmd:SimCommand) => void} command                 enqueue only
 * @property {(seed?:number) => void} reset
 * @property {() => GameState} snapshot                          structuredClone(state)
 */

/**
 * createRenderer({canvas, hudRoot}) from src/view/renderer.js.
 * @typedef {Object} Renderer
 * @property {(state:GameState, events:GameEvent[], input:InputFrame, alpha:number) => void} update   once per rAF
 * @property {(w:number, h:number) => void} resize
 * @property {(fn:(cmd:SimCommand) => void) => void} onCommand
 * @property {() => {fps:number, drawCalls:number, triangles:number}} stats
 * @property {() => void} dispose
 */

/**
 * createAudio() from src/view/audio.js.
 * @typedef {Object} Audio
 * @property {() => Promise<void>} unlock
 * @property {(events:GameEvent[], state:GameState) => void} handle
 * @property {(m:boolean) => void} setMuted
 * @property {(v:number) => void} setVolume
 * @property {() => void} dispose
 */
