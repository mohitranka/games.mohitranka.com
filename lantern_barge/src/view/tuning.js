// view/tuning.js — view-only numbers (owner: TA). Colours, camera, glove mapping, animation timings,
// hit-stop / shake / vignette. Modules read these at use time, so __game.setTuning('view.x', v) works live.

export const tuning = {
  // camera (player's eyes)
  fov: 62,
  eye: [0, 1.56, 0],
  lookAt: [0, 1.32, -1.8],
  pixelRatioMax: 1.5,

  // opponent placement
  oppZ: -1.75,

  // colours
  colors: {
    skyTop: 0x1b1f45,
    skyMid: 0x6a3d6e,
    skyHorizon: 0xf08a4b,
    sun: 0xffc27a,
    fog: 0x5a3b58,
    water: 0x2a2f55,
    waterGlint: 0xf3a05e,
    lantern: 0xffb347,
    hull: 0x3a2a24,
    deck: 0x8a6440,
    canvas: 0xcfc0a0,
    canvasEdge: 0x7c2f2a,
    rope: 0xd8c7a0,
    post: 0x5c4030,
    bank: 0x1d1830,
    crowd: 0x120f22,

    skin: 0xb9785a,
    top: 0x1f2a44,
    topStripe: 0xd9c08a,
    trunks: 0xe8b81c,
    trunksBand: 0x2a2320,
    hair: 0xb5562a,
    oppGlove: 0xb8913a,
    ropeBurn: 0xa8463e,
    mitt: 0x8c1d1d,
    mittPad: 0xe9e1cf,
    boots: 0x2b2522,

    playerGlove: 0x8e1f24,
    playerCuff: 0xe8e2d4,
    playerArm: 0x7a4a36,
  },

  // attack glow colours (GDD §6: white glint / amber / red)
  attackGlow: {
    rope_snap: 0xffffff,
    swing_bridge: 0xffa21f,
    anchor_drop: 0xff2a1a,
  },

  // opponent animation
  throwMaxS: 0.16, // the visible throw at the end of a telegraph, s (≤ 30% of the wind-up)
  hurtLongS: 0.6, // hurt stageDur at or above this reads as a big stagger
  fallS: 0.65, // knockdown fall time

  // gloves (camera space, metres)
  glove: {
    xScale: 1.55,
    yScale: 0.6,
    baseY: -0.1,
    baseZ: -0.5,
    guardY: -0.075,
    guardX: 0.12,
    reach: 0.42, // extra z at ext = 1
    easeLost: 0.2, // s to ease back to guard pose when the hand is lost
    lostOpacity: 0.35,
    openOpacity: 0.55,
    fatigueDamp: 0.6, // extension multiplier while fatigued
    gassedDamp: 0.3,
    punchAnimS: 0.24, // event-driven punch (injected/test punches with no hand motion)
    blockJoltS: 0.18,
    brokenS: 0.6,
  },

  // hit feedback
  hitStopS: [0.05, 0.07], // player hit, scaled by power
  hitStopCounterS: 0.075,
  hitStopTakenS: 0.04,
  catchUpS: 0.15,
  kickPx: [3, 6],
  shakePx: [0, 4, 9, 14], // by shakeTier
  shakeS: [0, 0.15, 0.22, 0.3],
  vignetteS: 0.55,

  // HUD
  flashS: 0.9,
  fightFlashS: 0.7,
};
