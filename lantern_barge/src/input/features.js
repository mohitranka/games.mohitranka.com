// input/features.js — per-detection features (architecture §6.2, D1). Owner: PD.
// Landmarks are arrays of 21 [x, y, z]. Image landmarks are normalized to the UNMIRRORED camera image;
// world landmarks are metric and hand-centered. Mirroring to screen space happens here (x → 1 − x).

export const WRIST = 0;
export const PALM = Object.freeze([0, 5, 9, 13, 17]);
// [mcp, pip, dip, tip] for index, middle, ring, pinky
export const FINGERS = Object.freeze([
  [5, 6, 7, 8],
  [9, 10, 11, 12],
  [13, 14, 15, 16],
  [17, 18, 19, 20],
]);

const d3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Knuckle span k: landmark 5 → 17 in image space with x scaled by W/H, in frame heights.
 * THE depth feature (D1). Recognizer code calls only this, so an A/B swap is one function.
 */
export function depthScale(lm, W, H) {
  const a = W / H;
  return Math.hypot((lm[5][0] - lm[17][0]) * a, lm[5][1] - lm[17][1]);
}

/**
 * Weak-perspective ln s: ln(image palm spread / world palm spread) over the palm points.
 * Overlay and recorder only (D1 A/B evidence); never used by the recognizer.
 */
export function weakPerspectiveLnS(lm, world, W, H) {
  if (!world) return NaN;
  const a = W / H;
  let ix = 0, iy = 0, wx = 0, wy = 0;
  for (const i of PALM) {
    ix += lm[i][0] * a;
    iy += lm[i][1];
    wx += world[i][0];
    wy += world[i][1];
  }
  ix /= PALM.length; iy /= PALM.length; wx /= PALM.length; wy /= PALM.length;
  let si = 0, sw = 0;
  for (const i of PALM) {
    si += Math.hypot(lm[i][0] * a - ix, lm[i][1] - iy);
    sw += Math.hypot(world[i][0] - wx, world[i][1] - wy);
  }
  return sw > 1e-9 && si > 1e-9 ? Math.log(si / sw) : NaN;
}

/** Palm center in mirrored screen space [x, y]. */
export function palmCenter(lm) {
  let x = 0, y = 0;
  for (const i of PALM) {
    x += lm[i][0];
    y += lm[i][1];
  }
  return [1 - x / PALM.length, y / PALM.length];
}

/**
 * Openness 0..1 from world landmarks (0 = tight fist, 1 = flat open hand).
 * Per finger: how straight the finger chain is, and how far the tip reaches beyond the knuckle
 * relative to the wrist→knuckle length. Averaged over the four fingers.
 */
export function openness(world) {
  const w = world[WRIST];
  let sum = 0;
  for (const [m, p, d, t] of FINGERS) {
    const chain = d3(world[m], world[p]) + d3(world[p], world[d]) + d3(world[d], world[t]);
    const straight = chain > 1e-9 ? d3(world[m], world[t]) / chain : 0; // ~1 straight, ~0.3–0.5 curled
    const base = d3(w, world[m]);
    const reach = base > 1e-9 ? d3(w, world[t]) / base : 0; // ~1.8–2 open, ~0.8–1.1 fist
    sum += 0.5 * clamp01((straight - 0.45) / 0.5) + 0.5 * clamp01((reach - 1.05) / 0.8);
  }
  return sum / FINGERS.length;
}

/** Mirrored [x, y] for all 21 points (skeleton drawing). */
export function mirroredPoints(lm) {
  return lm.map((p) => [1 - p[0], p[1]]);
}

/** Normalize a MediaPipe landmark list ({x,y,z} objects or [x,y,z] arrays) to arrays. */
export function toArrays(list) {
  if (!list) return null;
  return list.map((p) => (Array.isArray(p) ? p : [p.x, p.y, p.z ?? 0]));
}
