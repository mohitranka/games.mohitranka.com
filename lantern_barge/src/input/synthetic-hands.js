// input/synthetic-hands.js — parametric hand → MediaPipe-shaped results, for recognizer unit tests and
// synthetic replays only (architecture §6.7, D7). Owner: PD. Never used with a real camera.
// World landmarks keep a FIXED real hand size; `depth` scales only the image landmarks (1 = guard depth,
// 0.7 = 30% closer to the camera), so ln k tracks −ln depth exactly when there is no noise.

const DEG = Math.PI / 180;

// Hand-local frame in metres: wrist at origin, fingers along +y, thumb side along +x, palm normal −z.
const MCP = [
  [0.034, 0.088, 0],
  [0.011, 0.093, 0],
  [-0.012, 0.088, 0],
  [-0.033, 0.077, 0],
];
const SEG = [
  [0.04, 0.025, 0.021],
  [0.045, 0.028, 0.023],
  [0.042, 0.026, 0.022],
  [0.033, 0.019, 0.019],
];
const BEND = [1.55, 1.7, 1.2]; // full-curl joint angles (rad)
const WORLD_SPAN = Math.hypot(MCP[0][0] - MCP[3][0], MCP[0][1] - MCP[3][1]); // landmark 5 → 17

function handLocal(open) {
  const curl = 1 - open;
  const pts = new Array(21);
  pts[0] = [0, 0, 0];
  // thumb: CMC, MCP, IP, TIP — tucks across the palm as the hand closes
  const tx = (o, c) => o * open + c * curl;
  pts[1] = [0.024, 0.026, -0.008];
  pts[2] = [tx(0.048, 0.04), tx(0.047, 0.05), tx(-0.012, -0.022)];
  pts[3] = [tx(0.066, 0.03), tx(0.068, 0.066), tx(-0.014, -0.034)];
  pts[4] = [tx(0.083, 0.012), tx(0.087, 0.07), tx(-0.016, -0.04)];
  for (let f = 0; f < 4; f++) {
    const base = MCP[f];
    const splay = (1.5 - f) * 8 * DEG * open;
    let x = base[0], y = base[1], z = base[2];
    let theta = 0;
    pts[5 + f * 4] = [x, y, z];
    for (let s = 0; s < 3; s++) {
      theta += BEND[s] * curl;
      const len = SEG[f][s];
      const dy = Math.cos(theta);
      x += len * Math.sin(splay) * dy;
      y += len * Math.cos(splay) * dy;
      z += -len * Math.sin(theta);
      pts[6 + f * 4 + s] = [x, y, z];
    }
  }
  return pts;
}

/** Seeded RNG (mulberry32) + Gaussian, so noisy sequences are reproducible. */
export function createRng(seed = 1) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gauss = () => {
    const u = Math.max(1e-12, next());
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
  };
  return { next, gauss };
}

/**
 * One synthetic hand.
 * @param {{hand:'left'|'right', x:number, y:number, depth?:number, open?:number, kGuard?:number, roll?:number}} spec
 *   x, y: palm center in MIRRORED screen space; depth 1 = guard; open 0 = fist, 1 = flat hand;
 *   kGuard: knuckle span (frame heights) at depth 1; roll: rotation about the camera axis (deg).
 * @param {{w?:number, h?:number, noisePx?:number, rng?:ReturnType<typeof createRng>}} [opts]
 * @returns {{lm:number[][], world:number[][], label:string, score:number}}
 */
export function synthHand(spec, { w = 1280, h = 720, noisePx = 0, rng = null } = {}) {
  const { hand, x, y, depth = 1, open = 0, kGuard = 0.11, roll = 0 } = spec;
  const side = hand === 'left' ? 1 : -1; // thumb points toward the midline in the mirrored view
  const local = handLocal(open).map(([px, py, pz]) => [px * side, py, pz]);
  // world: hand-centred (palm centroid at origin), fixed metric size, y up → MediaPipe y down
  const palm = [0, 5, 9, 13, 17];
  const c = [0, 1, 2].map((i) => palm.reduce((s, j) => s + local[j][i], 0) / palm.length);
  const cr = Math.cos(roll * DEG);
  const sr = Math.sin(roll * DEG);
  const world = local.map(([px, py, pz]) => {
    const lx = px - c[0];
    const ly = py - c[1];
    return [lx * cr - ly * sr, -(lx * sr + ly * cr), pz - c[2]];
  });
  // image: scale (frame heights per metre) ∝ 1/depth; only the image landmarks see depth
  const s = kGuard / WORLD_SPAN / depth;
  const aspect = w / h;
  const lm = world.map(([wx, wy, wz]) => {
    let xm = x + (wx * s) / aspect; // mirrored screen x (frame widths)
    let yy = y + wy * s;
    if (noisePx && rng) {
      xm += (rng.gauss() * noisePx) / w;
      yy += (rng.gauss() * noisePx) / h;
    }
    return [1 - xm, yy, wz * s]; // MediaPipe sees the unmirrored image
  });
  return { lm, world, label: hand === 'left' ? 'Left' : 'Right', score: 0.95 };
}

const smooth = (u) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));

/** Guard pose for a hand from a profile (or the default guard centres). */
export function guardSpec(hand, profile) {
  const p = profile?.hands?.[hand];
  return {
    hand,
    x: p ? p.center.x : hand === 'left' ? 0.38 : 0.62,
    y: p ? p.center.y : 0.55,
    depth: 1,
    open: 0,
    kGuard: p ? p.kGuard : 0.11,
  };
}

/**
 * Motion primitives: return a spec at time t (seconds) for a punch starting at t0, or null when idle.
 * Straight: depth 1 → `reach` over `outS` (eased), hold, retract.
 */
export function straightAt(base, t, t0, { reach = 0.7, outS = 0.15, holdS = 0.05, backS = 0.2, drift = 0.02 } = {}) {
  const u = t - t0;
  if (u < 0 || u > outS + holdS + backS) return null;
  let k;
  if (u <= outS) k = smooth(u / outS);
  else if (u <= outS + holdS) k = 1;
  else k = 1 - smooth((u - outS - holdS) / backS);
  const toward = base.hand === 'left' ? 1 : -1;
  return { ...base, depth: 1 + (reach - 1) * k, x: base.x + toward * drift * k, y: base.y - 0.02 * k };
}

/** Hook: the fist sweeps `travel` toward the midline over `outS`, slightly closer, then returns. */
export function hookAt(base, t, t0, { travel = 0.22, outS = 0.13, backS = 0.25, depth = 0.95 } = {}) {
  const u = t - t0;
  if (u < 0 || u > outS + backS) return null;
  const k = u <= outS ? smooth(u / outS) : 1 - smooth((u - outS) / backS);
  const toward = base.hand === 'left' ? 1 : -1;
  return { ...base, x: base.x + toward * travel * k, depth: 1 + (depth - 1) * k };
}

/**
 * Build a recording-shaped sequence.
 * @param {{fps?:number, durS:number, w?:number, h?:number, noisePx?:number, seed?:number,
 *   specs:(t:number) => Array<object|null>, drop?:(t:number, hand:string) => boolean,
 *   cues?: Array<{t:number, expect:{hand:string,punchType:string}|null, segment:string}>,
 *   header?: object}} o   times in seconds; `drop` simulates detection dropouts
 * @returns {{header:object, results:Array<{t:number, hands:object[]}>, cues:object[]}}  t in ms (recording format)
 */
export function synthRecording({ fps = 30, durS, w = 1280, h = 720, noisePx = 0, seed = 1, specs, drop, cues = [], header = {} }) {
  const rng = createRng(seed);
  const results = [];
  const n = Math.floor(durS * fps);
  for (let i = 0; i <= n; i++) {
    const t = i / fps;
    const hands = [];
    for (const sp of specs(t)) {
      if (!sp || sp.present === false) continue;
      if (drop && drop(t, sp.hand)) continue;
      hands.push(synthHand(sp, { w, h, noisePx, rng }));
    }
    results.push({ t: Math.round(t * 1e6) / 1e3, hands });
  }
  return {
    header: { v: 1, kind: 'header', w, h, fps, delegate: 'synthetic', ua: 'synthetic', script: 'synthetic', subject: 'synthetic', distance: 'n/a', lighting: 'n/a', ...header },
    results,
    cues: cues.map((c) => ({ kind: 'cue', t: Math.round(c.t * 1000), expect: c.expect ?? null, segment: c.segment })),
  };
}

/**
 * A labelled synthetic session in the recorder's format: calibration (framing, guard hold, 3 straights),
 * a guard hold, punch cues (each punch starts `reactS` after its cue), then an idle segment with bobbing and a
 * slow lean. Used by the replay / calibration / eval specs; never a substitute for the real corpus.
 * @param {{seed?:number, fps?:number, noisePx?:number, kGuard?:number, reactS?:number,
 *   punches?:Array<[string, string]>, idleS?:number}} [o]
 */
export function synthSession({
  seed = 7, fps = 30, noisePx = 1, kGuard = 0.11, reactS = 0.1, idleS = 12, calibStraights = [2.6, 4.1, 5.6],
  punches = [['left', 'straight'], ['right', 'straight'], ['left', 'hook'], ['right', 'hook'], ['right', 'straight'], ['left', 'hook']],
} = {}) {
  const base = {
    left: { hand: 'left', x: 0.38, y: 0.55, depth: 1, open: 0, kGuard },
    right: { hand: 'right', x: 0.62, y: 0.55, depth: 1, open: 0, kGuard },
  };
  const cues = [{ t: 0, expect: null, segment: 'calib' }];
  const moves = []; // {hand, type, t0}
  calibStraights.forEach((t, i) => {
    const hand = i % 2 ? 'right' : 'left';
    cues.push({ t, expect: { hand: 'any', punchType: 'straight' }, segment: 'calib' });
    moves.push({ hand, type: 'straight', t0: t + reactS });
  });
  cues.push({ t: 7, expect: null, segment: 'guard' });
  let t = 9;
  for (const [hand, type] of punches) {
    cues.push({ t, expect: { hand, punchType: type }, segment: 'punch' });
    moves.push({ hand, type, t0: t + reactS });
    t += 1.5;
  }
  const idleStart = t + 0.5;
  cues.push({ t: idleStart, expect: null, segment: 'idle' });
  const durS = idleStart + idleS;
  const specs = (s) =>
    ['left', 'right'].map((h) => {
      let sp = { ...base[h] };
      if (s >= idleStart) {
        const u = s - idleStart;
        const lean = Math.min(1, u / 3) * (u < idleS / 2 ? 1 : Math.max(0, 1 - (u - idleS / 2) / 3));
        sp = { ...sp, x: sp.x + 0.02 * Math.sin(u * 2.1), y: sp.y + 0.03 * Math.sin(u * 1.3), depth: 1 - 0.12 * lean };
      }
      for (const m of moves) {
        if (m.hand !== h) continue;
        const p = m.type === 'hook' ? hookAt(sp, s, m.t0) : straightAt(sp, s, m.t0);
        if (p) return p;
      }
      return sp;
    });
  return synthRecording({ fps, durS, noisePx, seed, specs, cues, header: { script: 'synthetic-session' } });
}
