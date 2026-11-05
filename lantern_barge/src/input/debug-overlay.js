// input/debug-overlay.js — ?debug=1 panel in #overlay (architecture §1, D6/D7). Owner: PD.
// Landmark skeleton, ln k / ln s / rate plots with the live threshold and noise, recognizer + guard state,
// sliders for every numeric tuning key (input, game, view — edited through setTuning), copy-to-clipboard,
// and the recorder with its prompt script. TA may restyle via the .dbg-* classes; layout-critical styles are inline.

import { HANDS } from '../shared/constants.js';
import { createRecorder, PROMPT_SCRIPTS } from './recorder.js';

const HISTORY_S = 4;
const COLORS = { left: '#4aa3ff', right: '#ffa04a', thr: '#e5484d', grid: 'rgba(255,255,255,0.12)', text: '#ddd' };
const BONES = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]];

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'style') e.style.cssText = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const k of kids) e.append(k);
  return e;
}

const std = (a) => {
  if (a.length < 2) return 0;
  const m = a.reduce((x, y) => x + y, 0) / a.length;
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
};

/**
 * @param {{root:HTMLElement, getSource:() => object, tuning:{input:object, game:object, view:object},
 *   setTuning:(path:string, v:any) => any}} opts
 */
export function createDebugOverlay({ root, getSource, tuning, setTuning }) {
  root.hidden = false;
  root.classList.add('dbg');
  root.style.cssText = 'position:fixed;top:8px;right:8px;z-index:50;max-height:calc(100vh - 16px);overflow:auto;' +
    'width:min(520px,calc(100vw - 32px));background:rgba(10,12,16,0.86);color:#ddd;padding:8px;border-radius:6px;' +
    'font:11px/1.35 ui-monospace,monospace;pointer-events:auto';
  const status = el('pre', { class: 'dbg-status', style: 'margin:0 0 6px;white-space:pre-wrap' });
  const canvas = el('canvas', { class: 'dbg-plot', width: 504, height: 250, style: 'width:100%;display:block' });
  const log = el('pre', { class: 'dbg-log', style: 'margin:6px 0;white-space:pre-wrap;max-height:90px;overflow:auto' });
  const prompt = el('div', {
    class: 'dbg-prompt',
    style: 'position:fixed;left:50%;top:18%;transform:translateX(-50%);font:700 44px/1.2 system-ui,sans-serif;' +
      'color:#fff;text-shadow:0 2px 8px #000;pointer-events:none;text-align:center;z-index:60',
  });
  document.body.append(prompt);

  // ── recorder panel
  const subject = el('input', { placeholder: 'subject', size: 8 });
  const distance = el('input', { placeholder: 'distance (e.g. 1.1m)', size: 12 });
  const lighting = el('input', { placeholder: 'lighting', size: 8 });
  const scriptSel = el('select', {}, ...Object.keys(PROMPT_SCRIPTS).map((k) => el('option', { value: k }, k)));
  const recStatus = el('span', { class: 'dbg-rec-status' });
  let recorder = null;
  const startBtn = el('button', { type: 'button', onclick: () => api.startRecording() }, 'Record');
  const stopBtn = el('button', { type: 'button', onclick: () => recorder?.stop() }, 'Stop + save');
  const recPanel = el('details', { class: 'dbg-rec' }, el('summary', {}, 'Recorder'),
    el('div', { style: 'display:flex;flex-wrap:wrap;gap:4px;margin:4px 0' }, subject, distance, lighting, scriptSel, startBtn, stopBtn),
    recStatus);

  // ── tuning sliders
  const copyBtn = el('button', { type: 'button', onclick: () => api.copyText() }, 'Copy tuning JSON');
  const copyStatus = el('span', { style: 'margin-left:6px' });
  const sliderBox = el('div');
  const sliders = new Map();
  function buildSliders() {
    sliderBox.textContent = '';
    sliders.clear();
    for (const root of ['input', 'game', 'view']) {
      const obj = tuning[root] ?? {};
      const keys = Object.keys(obj).filter((k) => typeof obj[k] === 'number');
      if (!keys.length) continue;
      const group = el('details', { class: 'dbg-group' }, el('summary', {}, `${root} (${keys.length})`));
      for (const k of keys) {
        const v = obj[k];
        const max = v > 0 ? v * 3 : 1;
        const step = Number.isInteger(v) && v >= 10 ? 1 : max / 300;
        const val = el('span', { style: 'display:inline-block;width:62px;text-align:right' }, String(v));
        const input = el('input', { type: 'range', min: 0, max, step, value: v, style: 'flex:1' });
        input.addEventListener('input', () => {
          setTuning(`${root}.${k}`, +input.value);
          val.textContent = String(+(+input.value).toFixed(4));
        });
        sliders.set(`${root}.${k}`, { input, val });
        group.append(el('label', { style: 'display:flex;gap:6px;align-items:center' },
          el('span', { style: 'width:170px;overflow:hidden;text-overflow:ellipsis' }, k), input, val));
      }
      sliderBox.append(group);
    }
  }
  buildSliders();
  const tunePanel = el('details', { class: 'dbg-tuning' }, el('summary', {}, 'Tuning'), el('div', { style: 'margin:4px 0' }, copyBtn, copyStatus), sliderBox);

  root.append(status, canvas, log, recPanel, tunePanel);
  const ctx = canvas.getContext('2d');

  // ── data from the hand source
  let hist = [];
  const punches = [];
  let lastLm = { left: null, right: null };
  let unsub = null;
  let boundSource = null;
  function bind(source) {
    if (source === boundSource) return;
    unsub?.();
    unsub = null;
    boundSource = source;
    hist = [];
    if (!source?.onResult) return;
    unsub = source.onResult(({ result, punches: ps }) => {
      const tr = source.pipeline.tracker;
      const row = { t: result.t };
      for (const h of HANDS) {
        const s = tr.slots[h];
        row[h] = s.seenNow ? { lnk: s.raw.lnk, lnS: s.raw.lnS, rate: s.rate } : null;
        lastLm[h] = s.seenNow ? s.raw.lm : null;
      }
      hist.push(row);
      while (hist.length && hist[0].t < result.t - HISTORY_S) hist.shift();
      for (const p of ps) punches.push(p);
      if (punches.length > 8) punches.splice(0, punches.length - 8);
    });
  }

  function plot(y0, h, key, label, thrFn) {
    const x0 = 170;
    const w = canvas.width - x0 - 4;
    ctx.strokeStyle = COLORS.grid;
    ctx.strokeRect(x0, y0, w, h);
    ctx.fillStyle = COLORS.text;
    ctx.fillText(label, x0 + 4, y0 + 11);
    if (hist.length < 2) return;
    const tEnd = hist[hist.length - 1].t;
    const vals = hist.flatMap((r) => HANDS.map((hh) => r[hh]?.[key]).filter((v) => Number.isFinite(v)));
    const thr = thrFn ? HANDS.map(thrFn) : [];
    let lo = Math.min(...vals, ...thr);
    let hi = Math.max(...vals, ...thr);
    if (!Number.isFinite(lo)) return;
    if (hi - lo < 1e-3) {
      hi += 0.5;
      lo -= 0.5;
    }
    const X = (t) => x0 + w - ((tEnd - t) / HISTORY_S) * w;
    const Y = (v) => y0 + h - 3 - ((v - lo) / (hi - lo)) * (h - 16);
    for (const hh of HANDS) {
      ctx.strokeStyle = COLORS[hh];
      ctx.beginPath();
      let pen = false;
      for (const r of hist) {
        const v = r[hh]?.[key];
        if (!Number.isFinite(v)) {
          pen = false;
          continue;
        }
        if (pen) ctx.lineTo(X(r.t), Y(v));
        else ctx.moveTo(X(r.t), Y(v));
        pen = true;
      }
      ctx.stroke();
    }
    ctx.strokeStyle = COLORS.thr;
    for (const v of thr) {
      ctx.beginPath();
      ctx.moveTo(x0, Y(v));
      ctx.lineTo(x0 + w, Y(v));
      ctx.stroke();
    }
  }

  function drawSkeleton(profile, aspect) {
    const bw = 160;
    const bh = bw / aspect;
    ctx.strokeStyle = COLORS.grid;
    ctx.strokeRect(2, 2, bw, bh);
    for (const h of HANDS) {
      const c = profile?.hands?.[h]?.center;
      if (c) {
        ctx.strokeStyle = COLORS[h];
        ctx.beginPath();
        ctx.arc(2 + c.x * bw, 2 + c.y * bh, 4, 0, 2 * Math.PI);
        ctx.stroke();
      }
      const lm = lastLm[h];
      if (!lm) continue;
      ctx.strokeStyle = COLORS[h];
      ctx.beginPath();
      for (const [a, b] of BONES) {
        ctx.moveTo(2 + (1 - lm[a][0]) * bw, 2 + lm[a][1] * bh);
        ctx.lineTo(2 + (1 - lm[b][0]) * bw, 2 + lm[b][1] * bh);
      }
      ctx.stroke();
    }
  }

  const api = {
    /** Called by main.js on every render with the (peeked) frame and the game state. */
    draw(frame, state) {
      const source = getSource();
      bind(source);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.font = '10px ui-monospace, monospace';
      const hasHands = !!source?.pipeline;
      const rec = hasHands ? source.pipeline.recognizer : null;
      const profile = hasHands ? source.pipeline.profile : null;
      drawSkeleton(profile, hasHands ? source.pipeline.tracker.aspect : 16 / 9);
      plot(2, 80, 'lnk', 'ln k (knuckle span)');
      plot(86, 80, 'rate', 'd ln k/dt  (red: straight threshold)', rec ? (h) => rec.straightThreshold(profile, h) : null);
      plot(170, 76, 'lnS', 'ln s (weak-perspective, A/B only)');

      const f = frame;
      const tr = f.tracking;
      const noise = HANDS.map((h) => std(hist.slice(-30).map((r) => r[h]?.rate).filter(Number.isFinite)).toFixed(2));
      const lines = [
        `src ${f.source}  ${tr.delegate ?? '-'}  ${tr.fps.toFixed(1)} fps  infer ${tr.inferMs.toFixed(1)} ms  pipe ${tr.pipelineMs.toFixed(0)} ms  ok ${tr.ok}`,
        `guard ${f.guard.level} raw ${f.guard.raw} L ${f.guard.left} R ${f.guard.right}   phase ${state?.phase ?? '-'}`,
        ...HANDS.map((h) => {
          const hs = f.hands[h];
          const s = hasHands ? source.pipeline.tracker.slots[h] : null;
          return `${h.padEnd(5)} ${hs.present ? 'seen' : '----'} fist ${hs.fist ? 'Y' : 'n'} open ${hs.openness.toFixed(2)} ${hs.punchPhase.padEnd(10)} ` +
            `rate ${hs.rate.toFixed(2).padStart(5)} kR ${Number.isFinite(hs.kRatio) ? hs.kRatio.toFixed(2) : '-'} ` +
            `σ ${noise[HANDS.indexOf(h)]} lbl ${s ? s.labelAgree.toFixed(2) : '-'}`;
        }),
        `calib ${f.calibration.step ?? '-'} ${f.calibration.hint ?? ''} ${f.calibration.count}/${f.calibration.target} ` +
          `${f.calibration.meter ? `meter ${f.calibration.meter.value.toFixed(2)}/${f.calibration.meter.threshold.toFixed(2)}` : ''}` +
          `  spot ${f.spot.kGuardDrift === null ? '-' : f.spot.kGuardDrift.toFixed(3)}`,
        `gesture ${f.gesture?.kind ?? '-'} ${f.gesture ? `${Math.round(f.gesture.progress * 100)}%` : ''}` +
          `  available [${f.gesture?.available?.join(', ') ?? ''}]`,
      ];
      status.textContent = lines.join('\n');
      log.textContent = punches.map((p) => `${p.tCommit.toFixed(2)} ${p.hand} ${p.punchType} p=${p.power}${p.inferred ? ' (rescue)' : ''} onset→commit ${((p.tCommit - p.tOnset) * 1000).toFixed(0)} ms`).reverse().join('\n');
      startBtn.disabled = !(source?.kind === 'camera') || !!recorder?.running;
      stopBtn.disabled = !recorder?.running;
      if (recorder?.running) recStatus.textContent = `recording… ${recorder.count} results`;
    },

    /** JSON of all three tuning objects; also written to the clipboard when allowed. */
    copyText() {
      const text = JSON.stringify({ input: tuning.input, game: tuning.game, view: tuning.view }, null, 2);
      const done = (ok) => (copyStatus.textContent = ok ? 'copied' : 'copy blocked: select the text below');
      if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(() => done(true), () => done(false));
      else done(false);
      return text;
    },

    /** Programmatic slider move (tests): same path as the UI. */
    setSlider(path, value) {
      const s = sliders.get(path);
      if (!s) throw new Error(`no slider for ${path}`);
      s.input.value = String(value);
      s.input.dispatchEvent(new Event('input'));
      return +s.input.value;
    },
    get sliderPaths() {
      return [...sliders.keys()];
    },

    /** Start the recorder on the camera source. Resolves `recorder.done` with {rec, jsonl, filename}. */
    startRecording({ script = scriptSel.value, download = true } = {}) {
      const source = getSource();
      if (source?.kind !== 'camera') throw new Error('recording needs the camera source');
      recorder = createRecorder({
        source,
        script,
        meta: { subject: subject.value, distance: distance.value, lighting: lighting.value },
        onPrompt: (text) => (prompt.textContent = text),
      });
      recorder.done.then((f) => {
        recStatus.textContent = `saved ${f.filename} (${f.rec.results.length} results, ${f.rec.cues.length} cues)`;
        if (download) recorder.download();
        setTimeout(() => (prompt.textContent = ''), 1500);
      });
      recorder.start();
      return recorder;
    },
    get recorder() {
      return recorder;
    },
    rebuildSliders: buildSliders,
    /** main.js calls this on every source switch, so no result is missed between draws */
    setSource: bind,
    dispose() {
      unsub?.();
      prompt.remove();
      root.textContent = '';
      root.hidden = true;
    },
  };
  return api;
}
