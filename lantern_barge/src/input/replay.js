// input/replay.js — recording format (architecture §6.7) and a timed feeder for the replay HandSource. Owner: PD.
// JSONL: line 1 header {v:1, kind:'header', ...}; result lines {kind:'r', t, hands:[{lm, world, label, score}], pipe?};
// cue lines {kind:'cue', t, expect:{hand, punchType}|null, segment}. t is capture ms relative to the start.

/** @returns {{header:object, results:object[], cues:object[]}} */
export function parseJsonl(text) {
  const rec = { header: null, results: [], cues: [] };
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch (err) {
      throw new Error(`recording line ${i + 1}: ${err.message}`);
    }
    if (o.kind === 'header') rec.header = o;
    else if (o.kind === 'r') rec.results.push(o);
    else if (o.kind === 'cue') rec.cues.push(o);
  }
  if (!rec.header) throw new Error('recording has no header line');
  if (rec.header.v !== 1 && rec.header.v !== 2) throw new Error(`unsupported recording version ${rec.header.v}`);
  rec.results.sort((a, b) => a.t - b.t);
  rec.cues.sort((a, b) => a.t - b.t);
  return rec;
}

const r4 = (v) => Math.round(v * 1e4) / 1e4;
const pts = (list) => (list ? list.map((p) => [r4(p[0]), r4(p[1]), r4(p[2] ?? 0)]) : null);

/** Serialize a recording object to JSONL (landmarks rounded to 4 decimals). */
export function toJsonl(rec) {
  // v2 (D13): result lines may carry `face` {x, y, w, h, score} | null (null = run, no face; absent = not run)
  const v = rec.results.some((r) => r.face !== undefined) ? 2 : 1;
  const lines = [JSON.stringify({ ...rec.header, kind: 'header', v })];
  const events = [
    ...rec.results.map((r) => ({
      t: r.t,
      line: JSON.stringify({
        kind: 'r', t: r.t,
        hands: r.hands.map((h) => ({ lm: pts(h.lm), world: pts(h.world), label: h.label, score: r4(h.score ?? 1) })),
        ...(r.pipe !== undefined ? { pipe: r.pipe } : {}),
        ...(r.face !== undefined ? { face: r.face && { x: r4(r.face.x), y: r4(r.face.y), w: r4(r.face.w), h: r4(r.face.h), score: r4(r.face.score) } } : {}),
        ...(r.lum ? { lum: { l: r.lum.l, r: r.lum.r } } : {}), // optional ?debug=1 brightness probe (player's left/right half, 0–255)
      }),
    })),
    ...rec.cues.map((c) => ({ t: c.t, line: JSON.stringify({ kind: 'cue', t: c.t, expect: c.expect ?? null, segment: c.segment }) })),
  ];
  events.sort((a, b) => a.t - b.t);
  for (const e of events) lines.push(e.line);
  return lines.join('\n') + '\n';
}

/**
 * Feeds recorded results in order. start(t0) anchors recording time 0 at sim time t0 (seconds).
 * @param {{header:object, results:object[]}} rec
 */
export function createReplayFeeder(rec) {
  let i = 0;
  let t0 = null;
  return {
    get started() {
      return t0 !== null;
    },
    get done() {
      return i >= rec.results.length;
    },
    get t0() {
      return t0;
    },
    start(t) {
      t0 = t;
      i = 0;
    },
    /** Call ingest(result) for every record due at sim time t. Results get t in sim seconds. */
    feed(t, ingest) {
      if (t0 === null) return 0;
      let n = 0;
      while (i < rec.results.length && t0 + rec.results[i].t / 1000 <= t + 1e-9) {
        const r = rec.results[i++];
        ingest({ t: t0 + r.t / 1000, w: rec.header.w, h: rec.header.h, hands: r.hands, face: r.face }); // face: v2
        n++;
      }
      return n;
    },
  };
}
