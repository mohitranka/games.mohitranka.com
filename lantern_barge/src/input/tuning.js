// input/tuning.js — input-layer thresholds (owner: PD). Values from game-design.md §3–§5, §9 and decisions D1–D3.
// Units: rates are d ln k/dt in 1/s; ratios are k/kGuard; speeds are frame widths/s; lengths in frame heights (fh);
// every window is in ms. Modules read these at use time so __game.setTuning('input.x', v) works live.
// M0 holds the full key list; the camera/recognizer code that uses most of them lands in M1.

export const tuning = {
  // camera / worker (architecture-only values)
  camWidth: 1280,
  camHeight: 720,
  camFps: 60,
  gpuSetupMs: 8000,
  gpuSlowInferMs: 100, // a GPU delegate whose median inference (first gpuPaceFrames) exceeds this switches to CPU
  gpuPaceFrames: 5,
  minHandDetectionConfidence: 0.6, // D3a: MediaPipe HandLandmarker thresholds (passed to the worker at init)
  minHandPresenceConfidence: 0.55,
  minTrackingConfidence: 0.5,
  faceSlowMs: 8,
  lumEvery: 0, // ?debug=1 sets 15: the worker reports half-frame brightness every 15th frame (overlay + recordings) // D13: face detector median above this → every 2nd frame
  headGraceMs: 150, // D13: a lost face holds its last head state this long
  stallMs: 2000,
  predictMaxMs: 55,
  lossGraceMs: 160,
  handednessFlip: false, // set after the day-1 label check

  // fist (D2)
  fistCloseBelow: 0.45,
  fistOpenAbove: 0.62,
  fistDebounceMs: 30,

  // rate estimation
  rateWindowMs: 70, // least-squares slope window over raw ln k (≥ 2–3 results at 30 fps); validate on recordings (MC-3)

  // straight (GDD §4)
  straightThresholdDefault: 1.6, // T_straight before calibration, 1/s
  straightRateFullDefault: 3.5, // rate_full before calibration, 1/s
  straightMinMs: 50,
  straightMinSamples: 2,
  straightRatioMin: 1.15,
  straightScreenSpeedMax: 1.2, // fw/s
  straightThresholdClamp: [1.2, 2.4],
  calibThresholdFactor: 0.6, // T_straight = max(0.6 × median peak, noiseFactor × noise), clamped
  calibRateFullFactor: 1.15, // rate_full = 1.15 × median peak
  noiseFactor: 3,

  // hook (GDD §4, §5)
  hookThreshold: 1.4, // fw/s
  hookRateFull: 3.5, // fw/s
  hookMinMs: 50,
  hookMinSamples: 2,
  hookTravelMin: 0.15, // fw
  hookVyRatio: 0.6,
  hookStartTolerance: 0.03, // fw: "starts at or outside the guard x" allows this much inside
  hookLookbackMs: 300, // the hook's start x is the outermost x in this window
  hookSustainFactor: 0.7, // an armed hook stays armed while toward-midline speed > 0.7 × hookThreshold

  // uppercut (D11, game-design §4): the guard-splitter
  uppercutThreshold: 1.8, // fh/s upward; also where power starts
  uppercutRateFull: 3.6, // fh/s upward at power 1
  uppercutMinMs: 50, // sustained above threshold for ≥ 50 ms ...
  uppercutMinSamples: 2, // ... across ≥ 2 results
  uppercutSustainFactor: 0.7, // stays armed while upward speed > 0.7 × threshold
  uppercutLookbackMs: 300, // the pocket is the lowest point in the 300 ms before onset
  uppercutPocketMin: 0.1, // fh below guard y
  uppercutPocketMax: 0.3, // fh below guard y (lower = waist / out of frame: not an uppercut)
  uppercutTravelMin: 0.15, // fh of upward travel
  uppercutVxRatio: 0.6, // |vx| < 0.6·|vy| (same units)
  uppercutTrackedMs: 150, // the hand must have been tracked this long before onset
  uppercutCommitAboveGuard: 0.02, // commit only at guard y + 0.02 fh or higher, while still above threshold
  uppercutTwoHandRejectMs: 100, // other hand rising > 0.7 × threshold within ±100 ms of onset → neither commits
  uppercutTwoHandFactor: 0.7,
  uppercutReturnLockoutMs: 400, // no uppercut within 400 ms of the same hand's previous punch commit
  uppercutGuardLockoutMs: 350, // the hand can't count toward guard for 350 ms after an uppercut

  // D12 body shots (main.js sets enableBody from features.body, ?next=1)
  enableBody: false,
  bodyBelowGuard: 0.12, // fh: a straight or hook committed with the palm this far below guard y is a body shot

  // D12 parry: a closed fist swiping OUTWARD from inside the guard zone (main.js sets enableParry from features.parry)
  enableParry: false,
  parryThreshold: 1.2, // fw/s outward
  parryMinMs: 50, // sustained ≥ 50 ms ...
  parryMinSamples: 2, // ... across ≥ 2 results
  parrySustainFactor: 0.7, // stays armed above 0.7 × threshold
  parryTravelMin: 0.08, // fw of outward travel
  parryVyRatio: 0.8, // |vy| < 0.8·|vx| (same units)
  parryTwoHandRejectMs: 100, // both fists swiping out within ±100 ms = spreading the guard, not a parry
  parryTwoHandFactor: 0.7,
  parryRefractoryMs: 400, // per hand, both inputs

  // shared punch rules
  refractoryMs: 200,
  guardLockoutMs: 250,
  enableUppercut: false, // D11: main.js sets it from features.uppercut (?next=1); unit tests set it directly

  // P1a / P1b guard parity (on with ?next=1: main.js sets guardParity from features.uppercut)
  guardParity: false,
  guardReturnMs: 450, // a punching hand can't count toward guard until onset + 450 ms (both inputs) ...
  uppercutGuardReturnMs: 550, // ... or onset + 550 ms after an uppercut. Replaces the 250 / 350 ms lockout.
  cameraGuardLatencyMs: 110, // documentation: capture → raw guard sample on camera (P1b; re-measured in MC-26)
  keyboardLatencyMs: 20, // documentation: keydown → sample on keyboard
  keyboardGuardDelayMs: 90, // = cameraGuardLatencyMs − keyboardLatencyMs: every keyboard guard change lands this late

  // guard (D3, GDD §4)
  guardRadius: 0.12, // fh
  guardRatioBand: [0.8, 1.4],
  guardOnMs: 90,
  guardOffMs: 150,
  guardGraceMs: 300,

  // calibration / framing (D1, GDD §9)
  framingKMin: 0.07,
  framingKMax: 0.16,
  calibGuardHoldMs: 1500,
  calibStraights: 3,
  calibMeterDelayMs: 4000,
  calibFramingHoldMs: 1000, // D3a: framing must hold this long (stable) before the guard step
  calibHoldGraceMs: 300, // D3a: framing / guard holds keep their state through failures this short
  framingYMin: 0.35, // D3a: palm-centre y band (frame heights) the guard must sit in
  framingYMax: 0.7,
  framingTrackMin: 0.8, // D3a: both hands seen in ≥ 80 % of results ...
  framingTrackWindowMs: 2000, // ... over the last 2 s
  calibUseFace: false, // D3a (?next=1): chin-height check from the face box; main.js sets it from features.slip
  guardChinBelowMax: 0.1, // fh: palm centres may sit at most this far below the bottom of the face box
  calibStillSpeed: 0.35, // fw/s: faster palm motion restarts the guard hold ("hold_still")
  calibProvisionalThreshold: 1.0, // 1/s: straights are detected with max(this, noiseFactor × noise) during calibration
  spotDriftMax: 0.15,

  // camera gestures for menu actions (D10)
  gestureConfirmHoldMs: 1000, // both fists in the guard zone: resume / skip practice / rematch
  gesturePauseHoldMs: 1000, // both hands open at face height: pause in FIGHT
  // D14 near misses (input/coach.js; observation only, no commit rule changes)
  nearMissDebounceMs: 400, // at most one near_miss per hand per 400 ms
  nearMissStart: 0.5, // a motion episode starts at 0.5 × any classifier's threshold (also the too_slow floor)
  nearMissEnd: 0.35, // ... and ends when every signal is below 0.35 × its threshold
  nearMissGuardMs: 400, // a guard gate failing this long (both fists up near the guard) → a guard near_miss
  gestureCancelHoldMs: 1500, // the same pose cancels calibration
  gestureResumeMs: 3000, // 3-2-1 auto-resume after a camera-loss pause (guard held throughout)
  gestureBreakMs: 150, // a hold resets when its pose is broken for longer than this
  pauseFingersUpMin: 0.03, // fh: mean fingertip y must be this far above the wrist
  pauseMaxBelowGuard: 0.05, // fh: palm centre at most this far below the guard centre ("about face height")
  pauseRequirePalmFacing: false, // palm-towards-camera check; enable after MC-19 confirms palmFacingSign
  palmFacingSign: 1,

  // view-only glove depth
  extFullRatio: 1.4, // kRatio at which ext = 1

  // keyboard (GDD §5, §10)
  keyboardPower: 0.65, // D11 P1 (was 0.6): balances the keyboard's fixed power against camera power
  keyboardPunchAnimMs: 250, // synthesized glove motion for keyboard hands
};

const hand = (x) =>
  Object.freeze({
    kGuard: 0.11, // middle of the 0.07–0.16 framing band
    center: Object.freeze({ x, y: 0.55 }),
    noise: 0,
    straightThreshold: 1.6,
    straightRateFull: 3.5,
  });

/**
 * Profile used by keyboard, replay without {calibrate:true}, and ?test=1 (decisions D5, lead ruling).
 * @type {import('../shared/types.js').CalibrationProfile}
 */
export const DEFAULT_PROFILE = Object.freeze({
  version: 1,
  hands: Object.freeze({ left: hand(0.38), right: hand(0.62) }),
});
