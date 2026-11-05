// input/filters.js — display filtering and rate estimation (architecture §6.2). Owner: PD.
// Rates come from raw samples (least squares over a short window); One Euro is for display only.

/** Least-squares slope dv/dt of samples [{t, v}] (t in seconds). Returns 0 with fewer than 2 samples. */
export function slope(samples, key = 'v') {
  const n = samples.length;
  if (n < 2) return 0;
  let mt = 0, mv = 0;
  for (const s of samples) {
    mt += s.t;
    mv += s[key];
  }
  mt /= n;
  mv /= n;
  let num = 0, den = 0;
  for (const s of samples) {
    const dt = s.t - mt;
    num += dt * (s[key] - mv);
    den += dt * dt;
  }
  return den > 1e-12 ? num / den : 0;
}

const smoothing = (cutoffHz, dt) => {
  const r = 2 * Math.PI * cutoffHz * dt;
  return r / (r + 1);
};

/**
 * One Euro filter (Casiez et al. 2012): adaptive low-pass, smooth when slow, responsive when fast.
 * @param {{minCutoff?:number, beta?:number, dCutoff?:number}} [o]
 */
export function createOneEuro({ minCutoff = 1.0, beta = 0.0, dCutoff = 1.0 } = {}) {
  let x = null;
  let dx = 0;
  let lastT = null;
  return {
    /** @param {number} v @param {number} t seconds */
    filter(v, t) {
      if (x === null || lastT === null || t <= lastT) {
        x = v;
        lastT = t;
        return x;
      }
      const dt = t - lastT;
      lastT = t;
      const rawDx = (v - x) / dt;
      dx += smoothing(dCutoff, dt) * (rawDx - dx);
      const cutoff = minCutoff + beta * Math.abs(dx);
      x += smoothing(cutoff, dt) * (v - x);
      return x;
    },
    reset() {
      x = null;
      dx = 0;
      lastT = null;
    },
    get value() {
      return x;
    },
  };
}
