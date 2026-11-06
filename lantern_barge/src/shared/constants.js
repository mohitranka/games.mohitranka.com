// shared/constants.js — frozen enums and constants shared by every layer (owner: PD).
// Additive changes only after the M0 freeze; never rename a value.

export const SIM_HZ = 60;
export const SIM_DT = 1 / 60;

export const HAND = Object.freeze({ LEFT: 'left', RIGHT: 'right' });
export const HANDS = Object.freeze(['left', 'right']);

export const PUNCH = Object.freeze({
  STRAIGHT: 'straight',
  HOOK: 'hook',
  UPPERCUT: 'uppercut', // D11: on (input tuning enableUppercut true)
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
  TRAINING: 'training', // D14: BOOT → (CALIBRATION) → TRAINING → FIGHT (training_start_match: no practice card)
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
export const COVER_REASON = Object.freeze({ RECOVER: 'recover', HURT: 'hurt', CIRCLE: 'circle', FEINT: 'feint', SPLIT: 'split' }); // split: D11

export const RESULT_METHOD = Object.freeze({ KO: 'ko', POINTS: 'points' });

export const INPUT_EVENT = Object.freeze({ PUNCH: 'punch', GUARD: 'guard', PARRY: 'parry', NEAR_MISS: 'near_miss' }); // parry: D12; near_miss: D14

// D12
export const TARGET = Object.freeze({ HEAD: 'head', BODY: 'body' });
export const TIRED = Object.freeze({ FRESH: 'fresh', TIRED: 'tired', EXHAUSTED: 'exhausted' });
export const PARRY_RESULT = Object.freeze({ SUCCESS: 'success', WHIFF: 'whiff' });
export const HURT_CAUSE = Object.freeze({ BIG_HIT: 'big_hit', GUARD_BREAK: 'guard_break', TWO_HITS: 'two_hits' });

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
  GUARD_SPLIT: 'guard_split', // D11
  PARRY: 'parry', // D12: game event {result, attack, hand}
  OPPONENT_TIRED: 'opponent_tired', // D12
  PLAYER_HURT: 'player_hurt', // D12
  TRAINING_ITEM: 'training_item', // D14
  TRAINING_REP: 'training_rep', // D14
  TRAINING_CALL: 'training_call', // D14
  TRAINING_RESULT: 'training_result', // D14
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
  // D14 training (TRAINING phase only; ignored elsewhere)
  TRAINING_NEXT: 'training_next',
  TRAINING_REPEAT: 'training_repeat',
  TRAINING_BACK: 'training_back',
  TRAINING_GOTO: 'training_goto', // {item}: jump to any item from the menu
  TRAINING_START_MATCH: 'training_start_match',
  TRAINING_OVERLAY: 'training_overlay', // {open}
  TRAINING_PROGRESS: 'training_progress', // {mastered}: main.js → sim, any phase (stored progress for this input)
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
  // D3a framing / hold hints (each names the failing condition)
  MAKE_FISTS: 'make_fists', // both hands seen, one open
  TRACKING_POOR: 'tracking_poor', // both hands seen in < 80 % of results over 2 s
  FISTS_TOO_HIGH: 'fists_too_high', // palm centre above framingYMin
  FISTS_TOO_LOW: 'fists_too_low', // palm centre below framingYMax
  GUARD_TO_CHIN: 'guard_to_chin', // ?next=1: fists > 0.10 fh below the bottom of the face box
});

// ───────────────────────────────────────────── D14 training (game-design §15)
export const START_MODE = Object.freeze({ MATCH: 'match', TRAINING: 'training' }); // start{mode}; absent = match

/** Trainable moves, in lesson order. shared/training.js filters them by the active features. */
export const TRAINING_MOVE = Object.freeze({
  GUARD: 'guard',
  STRAIGHT: 'straight',
  HOOK: 'hook',
  UPPERCUT: 'uppercut', // features.uppercut
  BODY: 'body', // features.body
  PARRY: 'parry', // features.parry
  RISE: 'rise', // features.rise ("getting up")
  SLIP: 'slip', // features.slip (D13)
  DUCK: 'duck', // features.slip (D13)
});

/** Item kinds; item ids are 'lesson:<move>' | 'mitt' | 'defence' | 'sparring' | 'start_match'. */
export const TRAINING_ITEM_KIND = Object.freeze({
  LESSON: 'lesson',
  MITT: 'mitt',
  DEFENCE: 'defence',
  SPARRING: 'sparring',
  START_MATCH: 'start_match',
});

/** Input near_miss reasons (§15.3). Guard reasons come from the guard check, the rest from a failed motion. */
export const NEAR_MISS_REASON = Object.freeze({
  FIST_OPEN: 'fist_open',
  TOO_SLOW: 'too_slow',
  TOO_SHORT: 'too_short',
  NOT_EXTENDED: 'not_extended',
  WRONG_DIRECTION: 'wrong_direction',
  TOO_VERTICAL: 'too_vertical',
  TOO_SIDEWAYS: 'too_sideways',
  NOT_LOW: 'not_low',
  NOT_IN_POCKET: 'not_in_pocket',
  BOTH_HANDS: 'both_hands',
  LOCKED_OUT: 'locked_out',
  OUT_OF_FRAME: 'out_of_frame',
  HAND_OUT_OF_ZONE: 'hand_out_of_zone',
  TOO_CLOSE: 'too_close',
  TOO_FAR: 'too_far',
});

export const TRAINING_STORAGE_KEY = 'lanternBarge.training.v1';

export const THREE_VERSION = '0.170.0';
export const MP_VERSION = '0.10.35';
export const THREE_URL = `https://cdn.jsdelivr.net/npm/three@${THREE_VERSION}/build/three.module.js`;
export const MP_BUNDLE_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/vision_bundle.mjs`;
export const MP_WASM_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}/wasm`;
// D13 (verified 200, 229 746 bytes, 2026-11-05): MediaPipe Face Detector, BlazeFace short-range, float16
export const FACE_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite';
export const HAND_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
