// input/eval.js — precision / recall / false punches per idle minute / latency on labelled recordings
// (architecture §6.7, D7). Owner: PD. Pure: runs the same pipeline + calibration as the HandSource, no clock.
//
// Segments: each cue's `segment` applies from its t until the next cue. 'calib' is not scored;
// 'punch' cues with `expect` are the positives; 'idle' and 'guard' time is where false punches are counted.
// A punch matches a cue with the same hand (or hand 'any') and type when tOnset ∈ [cue − 300 ms, cue + 600 ms].

import { createInputPipeline } from './pipeline.js';
import { createCalibration } from './calibration.js';
import { DEFAULT_PROFILE, tuning as defaultTuning } from './tuning.js';

export const MATCH_WINDOW_MS = Object.freeze([-300, 600]);

function segmentAt(cues, tMs) {
  let seg = cues.length ? null : 'idle';
  for (const c of cues) {
    if (c.t <= tMs) seg = c.segment;
    else break;
  }
  return seg ?? 'idle';
}

/**
 * Run the recognizer over a recording. If it has a 'calib' segment, calibration runs on it first (as in the
 * game) and the resulting profile is used for the rest. Times in the output are recording ms.
 * @returns {{punches:object[], profile:object, calibrated:boolean, calibEndMs:number|null}}
 */
export function runRecognizer(rec, { tuning = defaultTuning, profile = null } = {}) {
  const pipeline = createInputPipeline({ tuning, profile: profile ?? DEFAULT_PROFILE });
  const hasCalib = !profile && rec.cues.some((c) => c.segment === 'calib');
  const calib = createCalibration({ tuning });
  let calibrated = null;
  let calibEndMs = null;
  if (hasCalib) calib.begin(1, 0);
  const punches = [];
  for (const r of rec.results) {
    const t = r.t / 1000;
    pipeline.setProfile(calib.provisionalProfile ?? calibrated ?? profile ?? DEFAULT_PROFILE);
    const out = pipeline.ingest({ t, w: rec.header.w, h: rec.header.h, hands: r.hands });
    if (calib.active) {
      const done = calib.update(pipeline.tracker, t, out.punches);
      if (done) {
        calibrated = done;
        calibEndMs = r.t;
      }
      continue;
    }
    for (const p of out.punches) {
      punches.push({ ...p, tOnsetMs: p.tOnset * 1000, tCommitMs: p.tCommit * 1000, pipe: r.pipe ?? null });
    }
  }
  return { punches, profile: calibrated ?? profile ?? DEFAULT_PROFILE, calibrated: !!calibrated, calibEndMs };
}

const pct = (a, p) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};

/** Score recognizer output against the recording's cues. */
export function score(rec, punches, { window = MATCH_WINDOW_MS } = {}) {
  const cues = rec.cues;
  const positives = cues.filter((c) => c.segment === 'punch' && c.expect);
  const used = new Set();
  const matched = [];
  const confusion = {};
  for (const c of positives) {
    const lo = c.t + window[0];
    const hi = c.t + window[1];
    let best = -1;
    for (let i = 0; i < punches.length; i++) {
      const p = punches[i];
      if (used.has(i) || p.tOnsetMs < lo || p.tOnsetMs > hi) continue;
      const handOk = c.expect.hand === 'any' || c.expect.hand === p.hand;
      if (handOk && c.expect.punchType === p.punchType) {
        best = i;
        break;
      }
    }
    if (best >= 0) {
      used.add(best);
      matched.push({ cue: c, punch: punches[best] });
    } else {
      const near = punches.find((p, i) => !used.has(i) && p.tOnsetMs >= lo && p.tOnsetMs <= hi);
      const key = `${c.expect.hand} ${c.expect.punchType} → ${near ? `${near.hand} ${near.punchType}` : 'nothing'}`;
      confusion[key] = (confusion[key] ?? 0) + 1;
    }
  }
  // time per segment
  const endMs = rec.results.length ? rec.results[rec.results.length - 1].t : 0;
  const segMs = {};
  for (let i = 0; i < cues.length; i++) {
    const from = cues[i].t;
    const to = i + 1 < cues.length ? cues[i + 1].t : endMs;
    segMs[cues[i].segment] = (segMs[cues[i].segment] ?? 0) + Math.max(0, to - from);
  }
  const unmatched = punches.filter((_, i) => !used.has(i)).map((p) => ({ ...p, segment: segmentAt(cues, p.tOnsetMs) }));
  const fpScored = unmatched.filter((p) => p.segment !== 'calib');
  const fpIdle = unmatched.filter((p) => p.segment === 'idle' || p.segment === 'guard');
  const idleMin = ((segMs.idle ?? 0) + (segMs.guard ?? 0)) / 60000;
  const lat = matched.map((m) => m.punch.tCommitMs - m.punch.tOnsetMs);
  const pipes = matched.map((m) => m.punch.pipe).filter((v) => typeof v === 'number');
  return {
    cues: positives.length,
    matched: matched.length,
    recall: positives.length ? matched.length / positives.length : null,
    precision: matched.length + fpScored.length ? matched.length / (matched.length + fpScored.length) : null,
    falsePunches: fpScored.length,
    falseInIdle: fpIdle.length,
    idleMinutes: Math.round(idleMin * 1000) / 1000,
    falsePerIdleMinute: idleMin > 0 ? fpIdle.length / idleMin : null,
    inferred: matched.filter((m) => m.punch.inferred).length,
    confusion,
    latencyMs: { onsetToCommitMean: lat.length ? lat.reduce((a, b) => a + b, 0) / lat.length : null, onsetToCommitP95: pct(lat, 0.95), pipelineMean: pipes.length ? pipes.reduce((a, b) => a + b, 0) / pipes.length : null },
    falsePunchList: fpScored.slice(0, 50).map((p) => ({ t: Math.round(p.tOnsetMs), hand: p.hand, punchType: p.punchType, segment: p.segment })),
  };
}

/** Full evaluation of one recording. */
export function evaluate(rec, opts = {}) {
  const run = runRecognizer(rec, opts);
  return { header: rec.header, calibrated: run.calibrated, profile: run.profile, ...score(rec, run.punches, opts) };
}

/** Sum several per-file reports into one. */
export function aggregate(reports) {
  const sum = (k) => reports.reduce((a, r) => a + (r[k] ?? 0), 0);
  const cues = sum('cues');
  const matched = sum('matched');
  const fp = sum('falsePunches');
  const fpIdle = sum('falseInIdle');
  const idleMin = sum('idleMinutes');
  return {
    files: reports.length,
    cues,
    matched,
    recall: cues ? matched / cues : null,
    precision: matched + fp ? matched / (matched + fp) : null,
    falsePunches: fp,
    falseInIdle: fpIdle,
    idleMinutes: idleMin,
    falsePerIdleMinute: idleMin > 0 ? fpIdle / idleMin : null,
  };
}
