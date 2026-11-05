// game/rng.js — seeded PRNG (mulberry32). The only source of randomness in game/ (owner: GE).

/**
 * @param {number} seed
 */
export function createRng(seed = 1) {
  let s = seed >>> 0 || 0x9e3779b9;
  function next() {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  return {
    next,
    /** uniform in [a, b) */
    range(a, b) {
      return a + (b - a) * next();
    },
    /** integer in [a, b] */
    int(a, b) {
      return a + Math.floor(next() * (b - a + 1));
    },
    /** @param {Array<[any, number]>} entries [value, weight] pairs, in a fixed order */
    weighted(entries) {
      const total = entries.reduce((sum, [, wt]) => sum + Math.max(0, wt), 0);
      if (total <= 0) return entries[0][0];
      let r = next() * total;
      for (const [v, wt] of entries) {
        if (wt <= 0) continue;
        r -= wt;
        if (r < 0) return v;
      }
      return entries.filter(([, wt]) => wt > 0).at(-1)[0];
    },
  };
}
