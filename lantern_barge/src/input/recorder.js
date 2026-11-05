// input/recorder.js — ?debug=1 recorder with a cue-labelled prompt script (architecture §6.7, D7). Owner: PD.
// Records every raw detector result (empty ones too, so idle time is measured) with capture-relative ms, and writes a
// cue line at each prompted "NOW". Output: the JSONL recording format in replay.js.

import { toJsonl } from './replay.js';

const LABEL = {
  'left straight': 'LEFT STRAIGHT',
  'right straight': 'RIGHT STRAIGHT',
  'left hook': 'LEFT HOOK',
  'right hook': 'RIGHT HOOK',
  'any straight': 'STRAIGHT (either hand)',
  'left uppercut': 'LEFT UPPERCUT',
  'right uppercut': 'RIGHT UPPERCUT',
  'left straight body': 'LEFT STRAIGHT to the BODY',
  'right straight body': 'RIGHT STRAIGHT to the BODY',
  'left hook body': 'LEFT HOOK to the BODY',
  'right hook body': 'RIGHT HOOK to the BODY',
  'left parry': 'LEFT PARRY (swipe out)',
  'right parry': 'RIGHT PARRY (swipe out)',
};
const P = (hand, punchType, target) => (target ? [hand, punchType, target] : [hand, punchType]);
const rep = (n, item) => Array.from({ length: n }, () => item);

function mixed(n, seed = 3) {
  const all = [P('left', 'straight'), P('right', 'straight'), P('left', 'hook'), P('right', 'hook'), P('left', 'uppercut'), P('right', 'uppercut')];
  let s = seed;
  const out = [];
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    out.push(all[s % all.length]);
  }
  return out;
}

/** Prompt scripts. Steps: {segment, say, dur} or {segment, say, cues:[[hand, type]...], every}. Times in s. */
export const PROMPT_SCRIPTS = Object.freeze({
  full: [
    { segment: 'calib', say: 'Step to your spot: both fists in view, guard up', dur: 6 },
    { segment: 'calib', say: 'Hold your guard still', dur: 4 },
    { segment: 'calib', say: 'Throw a straight at the air (either hand)', cues: rep(3, P('any', 'straight')), every: 3 },
    { segment: 'guard', say: 'Guard up. Hold it.', dur: 10 },
    { segment: 'punch', say: 'Left straights', cues: rep(8, P('left', 'straight')), every: 2.2 },
    { segment: 'punch', say: 'Right straights', cues: rep(8, P('right', 'straight')), every: 2.2 },
    { segment: 'punch', say: 'Left hooks', cues: rep(8, P('left', 'hook')), every: 2.2 },
    { segment: 'punch', say: 'Right hooks', cues: rep(8, P('right', 'hook')), every: 2.2 },
    // D11: uppercuts — dip below your guard, then drive straight up through the gap to chin height
    { segment: 'punch', say: 'Left uppercuts (dip, then straight up)', cues: rep(8, P('left', 'uppercut')), every: 2.4 },
    { segment: 'punch', say: 'Right uppercuts (dip, then straight up)', cues: rep(8, P('right', 'uppercut')), every: 2.4 },
    { segment: 'punch', say: 'Mixed: follow the prompt', cues: mixed(16), every: 2.0 },
    { segment: 'idle', say: 'Relax, hands down, look around. No punches.', dur: 30 },
    { segment: 'idle', say: 'Talk with your hands. No punches.', dur: 30 },
    { segment: 'guard', say: 'Guard up. Adjust your fists, bob your head. No punches.', dur: 20 },
    { segment: 'idle', say: 'Scratch your face, fix your hair. No punches.', dur: 15 },
    { segment: 'guard', say: 'Guard up and lean toward the screen and back. No punches.', dur: 15 },
    { segment: 'idle', say: 'Push OPEN palms toward the screen (slaps, not punches)', dur: 15 },
    { segment: 'idle', say: 'Drop your hands, then slowly raise your guard again', dur: 10 },
    // D12: body shots (bend the knees, punch at belly height) and parries (swipe the fist outward from guard)
    { segment: 'punch', say: 'Body straights: bend your knees, punch at belly height', cues: [...rep(4, P('left', 'straight', 'body')), ...rep(4, P('right', 'straight', 'body'))], every: 2.2 },
    { segment: 'punch', say: 'Body hooks: low hooks at belly height', cues: [...rep(4, P('left', 'hook', 'body')), ...rep(4, P('right', 'hook', 'body'))], every: 2.2 },
    { segment: 'punch', say: 'Parries: swipe the fist OUTWARD from your guard, then back', cues: [...rep(6, P('left', 'parry')), ...rep(6, P('right', 'parry'))], every: 1.8 },
    // D12 negatives: spreading both fists apart (not a parry), hooks (inward, not a parry)
    { segment: 'guard', say: 'Spread BOTH fists apart and back together. NO parries.', dur: 15 },
    // D11 negatives: the motions most like an uppercut
    { segment: 'guard', say: 'Punch, then pull back down and re-raise your guard. NO uppercuts.', dur: 20 },
    { segment: 'idle', say: 'Drop both hands to your waist, then raise them quickly. NO punches.', dur: 20 },
  ],
  // ~6 s; used by the headless recorder spec (fake camera) — no real person needed
  short: [
    { segment: 'calib', say: 'Framing', dur: 1 },
    { segment: 'calib', say: 'Straight', cues: [P('any', 'straight')], every: 0.6 },
    { segment: 'punch', say: 'Left straights', cues: rep(2, P('left', 'straight')), every: 0.6 },
    { segment: 'idle', say: 'Idle', dur: 1 },
  ],
});

const LEAD_S = 1.2; // the prompt shows "<PUNCH> …" this long before "NOW!"

/** Flatten a script into a timeline of {at, text, cue?}. */
export function buildTimeline(steps) {
  const tl = [];
  let at = 0;
  for (const st of steps) {
    tl.push({ at, text: st.say, cue: { expect: null, segment: st.segment } });
    if (st.cues) {
      at += LEAD_S;
      for (const [hand, punchType, target] of st.cues) {
        tl.push({ at: at - LEAD_S * 0.8, text: `${LABEL[`${hand} ${punchType}${target ? ` ${target}` : ''}`]} …` });
        tl.push({ at, text: 'NOW!', cue: { expect: target ? { hand, punchType, target } : { hand, punchType }, segment: st.segment } });
        at += st.every;
      }
    } else at += st.dur;
  }
  tl.push({ at, text: 'Done. Saving…', end: true });
  return tl;
}

/** Length of a prompt script in seconds (the overlay shows it before Record; D3a). */
export function scriptDurationS(script) {
  const steps = PROMPT_SCRIPTS[script];
  if (!steps) throw new Error(`unknown prompt script ${script}`);
  return buildTimeline(steps).at(-1).at;
}

export const REQUIRED_LABELS = Object.freeze(['subject', 'distance', 'lighting']);
/** D3a pre-roll: cues start only after both hands were tracked in ≥ minRatio of results over the last `seconds`. */
export const DEFAULT_PREROLL = Object.freeze({ seconds: 3, minRatio: 0.8 });

/**
 * @param {{source: {onRaw:(fn:Function) => Function, detectorStats?:object}, script?:string,
 *   meta:{subject:string, distance:string, lighting:string}, onPrompt?:(text:string) => void,
 *   preroll?:{seconds:number, minRatio:number}|null}} opts
 *   D3a: all three labels are required; `preroll: null` skips the two-hand gate (headless fake-camera specs only).
 */
export function createRecorder({ source, script = 'full', meta = {}, onPrompt = () => {}, preroll = DEFAULT_PREROLL }) {
  if (!source?.onRaw) throw new Error('recorder needs the camera hand source');
  const steps = PROMPT_SCRIPTS[script];
  if (!steps) throw new Error(`unknown prompt script ${script}`);
  const missing = REQUIRED_LABELS.filter((k) => !String(meta[k] ?? '').trim());
  if (missing.length) throw new Error(`recorder needs labels: ${missing.join(', ')}`);
  const timeline = buildTimeline(steps);
  const results = [];
  const cues = [];
  let t0 = 0;
  let size = { w: 0, h: 0 };
  let unsub = null;
  let timer = 0;
  let next = 0;
  let running = false;
  let phase = 'idle'; // 'preroll' | 'recording' | 'done'
  let completed = false; // the script reached its end (otherwise the header says incomplete)
  const preHist = []; // {ts, both}
  let finished = null;
  let resolveDone;
  const done = new Promise((r) => (resolveDone = r));

  function step() {
    const el = (performance.now() - t0) / 1000;
    while (next < timeline.length && timeline[next].at <= el) {
      const ev = timeline[next++];
      onPrompt(ev.text);
      if (ev.cue) cues.push({ kind: 'cue', t: Math.round(ev.at * 1000), expect: ev.cue.expect, segment: ev.cue.segment });
      if (ev.end) {
        completed = true;
        stop();
        return;
      }
    }
  }

  function stop() {
    if (!running) return finished;
    running = false;
    phase = 'done';
    clearInterval(timer);
    unsub?.();
    const stats = source.detectorStats ?? {};
    const durS = results.length ? results[results.length - 1].t / 1000 : 0;
    const rec = {
      header: {
        v: 1, kind: 'header', w: size.w, h: size.h,
        fps: durS > 0 ? Math.round((results.length / durS) * 10) / 10 : 0,
        delegate: stats.delegate ?? null, ua: navigator.userAgent, script,
        subject: meta.subject || 'anon', distance: meta.distance || 'unknown', lighting: meta.lighting || 'unknown',
        recordedAt: new Date().toISOString(),
        ...(completed ? {} : { incomplete: true }), // D3a: stopped before the script ended
      },
      results,
      cues,
    };
    const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'x';
    finished = {
      rec,
      jsonl: toJsonl(rec),
      filename: `${slug(rec.header.subject)}-${slug(rec.header.distance)}-${slug(rec.header.lighting)}-${script}.jsonl`,
    };
    resolveDone(finished);
    return finished;
  }

  return {
    timeline,
    done,
    get running() {
      return running;
    },
    get count() {
      return results.length;
    },
    /** 'idle' | 'preroll' (waiting for both hands) | 'recording' | 'done' */
    get phase() {
      return phase;
    },
    /** Two-hand share over the pre-roll window so far (0..1). */
    get prerollRatio() {
      return preHist.length ? preHist.filter((x) => x.both).length / preHist.length : 0;
    },
    get durationS() {
      return timeline.at(-1).at;
    },
    start() {
      if (running) return;
      running = true;
      const begin = (at) => {
        phase = 'recording';
        t0 = at;
        timer = setInterval(step, 30);
        step();
      };
      phase = 'preroll';
      const startedAt = performance.now();
      unsub = source.onRaw((r) => {
        if (phase === 'preroll') {
          if (r.ts < startedAt) return;
          preHist.push({ ts: r.ts, both: (r.hands?.length ?? 0) >= 2 });
          while (preHist.length && preHist[0].ts < r.ts - preroll.seconds * 1000) preHist.shift();
          const ratio = preHist.filter((x) => x.both).length / preHist.length;
          const span = (r.ts - startedAt) / 1000;
          onPrompt(`Get ready: both fists in view, guard up (${Math.round(ratio * 100)}% tracked)`);
          if (span >= preroll.seconds - 0.05 && ratio >= preroll.minRatio) begin(r.ts);
          return; // pre-roll results are not recorded
        }
        if (phase !== 'recording' || r.ts < t0) return;
        size = { w: r.w, h: r.h };
        results.push({ t: Math.round((r.ts - t0) * 1000) / 1000, hands: r.hands, pipe: Math.round(r.arrival - r.ts), ...(r.face !== undefined ? { face: r.face } : {}) });
      });
      if (!preroll) begin(performance.now());
    },
    stop,
    /** Save the finished recording through a download link. */
    download() {
      const f = finished ?? stop();
      if (!f) return null;
      const url = URL.createObjectURL(new Blob([f.jsonl], { type: 'application/x-ndjson' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = f.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      return f.filename;
    },
  };
}
