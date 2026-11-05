// shared/fixtures.js — canonical data shapes (owner: PD).
// createInitialState(): the GameState at BOOT with every field present (architecture §3.5).
// createInputFrame(): an empty InputFrame (architecture §3.3), used by input sources, stubs and tests.
// GE: sim.reset() should start from createInitialState() and then apply game tuning (HP, stamina, round length).
// New fields go into types.js and here the same day, via PD.

/** @typedef {import('./types.js').GameState} GameState */
/** @typedef {import('./types.js').InputFrame} InputFrame */
/** @typedef {import('./types.js').HandState} HandState */

function createStats() {
  return { thrown: 0, landed: 0, blocked: 0, whiffed: 0, counters: 0, interrupts: 0 };
}

/** @returns {import('./types.js').Player} */
export function createPlayer() {
  return {
    hp: 100,
    maxHp: 100,
    stamina: 100,
    maxStamina: 100,
    fatigued: false,
    lowHp: false,
    pressured: false, // D9a: the turtle-pressure rules are on
    gassedUntil: -1,
    guard: 'none',
    guardBrokenUntil: -1,
    guardHeldSince: -1,
    knockdowns: 0,
    down: null,
    points: 0,
    stats: createStats(),
  };
}

/** @returns {import('./types.js').Opponent} */
export function createOpponent() {
  return {
    hp: 250, // D9: Tamsin's maxHp is 250 (game tuning owns the number; GE's reset applies it)
    maxHp: 250,
    state: 'circle',
    attack: null,
    side: null,
    combo: { index: 0, count: 1 },
    opening: false,
    offBalance: false,
    staggerImmuneUntil: -1,
    stageStart: 0,
    stageDur: 0,
    contactAt: null,
    guard: 'high',
    mitts: false,
    feint: false, // D9: the current telegraph is a feint (bots must not read this)
    covering: false, // D9: free hits used up, guard high for the rest of the window
    freeHits: 0, // D9: clean hits left in the current open window
    sequence: { kind: 'single', combo: null }, // D9 (bots must not read this)
    knockdowns: 0,
    down: null,
    points: 0,
  };
}

/**
 * @param {number} [seed=1]
 * @returns {GameState}
 */
export function createInitialState(seed = 1) {
  return {
    phase: 'boot',
    phaseStart: 0,
    time: 0,
    tick: 0,
    seed,
    paused: false,
    inputKind: 'none',
    calibSession: 0,
    round: { n: 1, of: 3, timeLeft: 60, clockRunning: false, countdown: null, restLeft: null },
    practice: null,
    result: { winner: null, method: null },
    player: createPlayer(),
    opponent: createOpponent(),
  };
}

/** @returns {HandState} */
export function createHandState() {
  return {
    present: false,
    predicted: false,
    fist: false,
    openness: 1,
    x: 0.5,
    y: 0.5,
    vx: 0,
    vy: 0,
    k: 0,
    kRatio: NaN,
    rate: 0,
    ext: 0,
    inGuardZone: false,
    punchPhase: 'idle',
  };
}

/** @returns {import('./types.js').CalibrationStatus} */
export function createCalibrationStatus() {
  return {
    active: false,
    wanted: false,
    session: 0,
    step: null,
    progress: 0,
    count: 0,
    target: 0,
    meter: null,
    hint: null,
    done: false,
  };
}

/**
 * @param {number} [t=0]  sim seconds
 * @param {'camera'|'replay'|'keyboard'|'none'} [source='none']
 * @returns {InputFrame}
 */
export function createInputFrame(t = 0, source = 'none') {
  return {
    t,
    seq: 0,
    source,
    tracking: { ok: true, fps: 0, inferMs: 0, pipelineMs: 0, delegate: null },
    hands: { left: createHandState(), right: createHandState() },
    head: { present: false },
    guard: { level: 'none', raw: false, left: false, right: false, since: 0 },
    events: [],
    calibration: createCalibrationStatus(),
    spot: { kGuardDrift: null, hint: null },
    gesture: { kind: null, progress: 0, fired: false, available: [] }, // D10
  };
}
