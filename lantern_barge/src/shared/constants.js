// shared/constants.js — frozen enums and constants shared by every layer (owner: PD).
// Additive changes only after the M0 freeze; never rename a value.

export const SIM_HZ = 60;
export const SIM_DT = 1 / 60;

export const HAND = Object.freeze({ LEFT: 'left', RIGHT: 'right' });
export const HANDS = Object.freeze(['left', 'right']);

export const PUNCH = Object.freeze({
  STRAIGHT: 'straight',
  HOOK: 'hook',
  UPPERCUT: 'uppercut', // reserved: only emitted when input tuning enableUppercut is true (false in MVP)
});

export const GUARD = Object.freeze({ NONE: 'none', FULL: 'full' });

export const WHO = Object.freeze({ PLAYER: 'player', OPPONENT: 'opponent' });

export const SOURCE = Object.freeze({ CAMERA: 'camera', REPLAY: 'replay', KEYBOARD: 'keyboard', NONE: 'none' });

// D5a: BOOT -> CALIBRATION -> PRACTICE -> FIGHT (countdown + knockdown sub-states) -> ROUND_END (rest) -> MATCH_END
export const PHASE = Object.freeze({
  BOOT: 'boot',
  CALIBRATION: 'calibration',
  PRACTICE: 'practice',
  FIGHT: 'fight',
  ROUND_END: 'round_end',
  MATCH_END: 'match_end',
});

// D5a: Shell cut entirely.
export const OPP_STATE = Object.freeze({
  CIRCLE: 'circle',
  TELEGRAPH: 'telegraph',
  ATTACK: 'attack',
  RECOVER: 'recover',
  HURT: 'hurt',
  KNOCKDOWN: 'knockdown',
  GETUP: 'getup',
});

export const ATTACK = Object.freeze({
  ROPE_SNAP: 'rope_snap',
  SWING_BRIDGE: 'swing_bridge',
  ANCHOR_DROP: 'anchor_drop',
});

export const OPP_GUARD = Object.freeze({ HIGH: 'high', LOW: 'low', NONE: 'none' });

// D9: what kind of sequence she is in, and which combo
export const SEQUENCE = Object.freeze({ SINGLE: 'single', FEINT: 'feint', PUNISH: 'punish', COMBO: 'combo' });
export const COMBO = Object.freeze({ SNAP_DROP: 'snap_drop', BRIDGE_SNAP: 'bridge_snap', DOUBLE_BRIDGE: 'double_bridge' });
// D9: why she covered up (free hits used up in that window, or the guard after a feint cancel)
export const COVER_REASON = Object.freeze({ RECOVER: 'recover', HURT: 'hurt', CIRCLE: 'circle', FEINT: 'feint' });

export const RESULT_METHOD = Object.freeze({ KO: 'ko', POINTS: 'points' });

export const INPUT_EVENT = Object.freeze({ PUNCH: 'punch', GUARD: 'guard' });

// Game events: one key per row of the architecture §3.6 table (payloads in types.js).
export const EVENT = Object.freeze({
  PHASE: 'phase',
  ROUND_START: 'round_start',
  ROUND_END: 'round_end',
  MATCH_END: 'match_end',
  PUNCH_THROWN: 'punch_thrown',
  PUNCH_REJECTED: 'punch_rejected',
  HIT: 'hit',
  PLAYER_HIT: 'player_hit',
  BLOCKED: 'blocked',
  WHIFF: 'whiff',
  GUARD_BROKEN: 'guard_broken',
  TELEGRAPH: 'telegraph',
  STRIKE: 'strike',
  STAGGER: 'stagger',
  OPENING: 'opening',
  GASSED: 'gassed',
  KNOCKDOWN: 'knockdown',
  COUNT: 'count',
  GETUP: 'getup',
  FEINT_CANCEL: 'feint_cancel', // D9
  COVER: 'cover', // D9
  PRESSURE: 'pressure', // D9a
});
export const EVENT_TYPES = Object.freeze(Object.values(EVENT));

export const PUNCH_REJECT_REASON = Object.freeze({ GASSED: 'gassed' });

// SimCommand types (architecture §3.7).
export const COMMAND = Object.freeze({
  START: 'start',
  CANCEL: 'cancel',
  SKIP_PRACTICE: 'skip_practice',
  PAUSE: 'pause',
  RESUME: 'resume',
  RESTART: 'restart',
  // test/debug only (ignored with a console warning unless the sim was created with allowDebug)
  GOTO_PHASE: 'goto_phase',
  FORCE_ATTACK: 'force_attack',
  DEBUG_SET: 'debug_set',
  SET_ROUND: 'set_round',
  FORCE_SEQUENCE: 'force_sequence', // D9
});
export const DEBUG_COMMANDS = Object.freeze([
  COMMAND.GOTO_PHASE,
  COMMAND.FORCE_ATTACK,
  COMMAND.DEBUG_SET,
  COMMAND.SET_ROUND,
  COMMAND.FORCE_SEQUENCE,
]);

export const CALIB_STEP = Object.freeze({
  FRAMING: 'framing',
  GUARD: 'guard',
  STRAIGHTS: 'straights',
  DONE: 'done',
});

// Frozen hint keys; TA renders the prompt text for each.
export const CALIB_HINT = Object.freeze({
  SHOW_BOTH_FISTS: 'show_both_fists',
  MOVE_CLOSER: 'move_closer',
  MOVE_BACK: 'move_back',
  HOLD_GUARD: 'hold_guard',
  HOLD_STILL: 'hold_still',
  THROW_STRAIGHT: 'throw_straight',
  NOT_SEEN: 'not_seen',
  RETURN_TO_SPOT: 'return_to_spot', // between rounds, k at guard drifted > 15% (D5)
});

export const THREE_VERSION = '0.170.0';
export const MP_VERSION = '0.10.35';
export const THREE_URL = `https://cdn.jsdelivr.net/npm/three@${THREE_VERSION}/build/three.module.js`;
export const MP_BUNDLE_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/vision_bundle.mjs`;
export const MP_WASM_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/wasm`;
export const HAND_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
