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

  // uppercut (deferred, D6): only used when enableUppercut is true
  uppercutThreshold: 1.5, // fh/s upward
  uppercutStartBelow: 0.08, // fh below guard y
  uppercutTravelMin: 0.12, // fh

  // shared punch rules
  refractoryMs: 200,
  guardLockoutMs: 250,
  enableUppercut: false,

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
  calibFramingHoldMs: 300, // framing must hold this long before the guard step
  calibStillSpeed: 0.35, // fw/s: faster palm motion restarts the guard hold ("hold_still")
  calibProvisionalThreshold: 1.0, // 1/s: straights are detected with max(this, noiseFactor × noise) during calibration
  spotDriftMax: 0.15,

  // camera gestures for menu actions (D10)
  gestureConfirmHoldMs: 1000, // both fists in the guard zone: resume / skip practice / rematch
  gesturePauseHoldMs: 1000, // both hands open at face height: pause in FIGHT
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
  keyboardPower: 0.6,
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
