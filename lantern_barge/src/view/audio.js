// view/audio.js — createAudio(): every sound is synthesized with Web Audio; no files (owner: TA; API §3.9).
// The AudioContext is created only in unlock(), which main.js calls from a #boot button click (a user
// gesture), so nothing plays before the player has interacted. handle() maps game events to voices.
//
// Telegraphs each have a distinct sound at wind-up start (GDD §6, §7):
//   rope_snap    rope-creak ticks + a bright glint ping
//   swing_bridge a low timber groan
//   anchor_drop  a foghorn from the riverbank + a crowd gasp

const clamp01 = (x) => Math.max(0, Math.min(1, x));

/** Which voice answers each event type (also used by tests to prove every event has an audio response). */
export const EVENT_VOICES = Object.freeze({
  phase: 'swoosh',
  round_start: 'bell×2',
  round_end: 'bell',
  match_end: 'bell×3+crowd',
  punch_thrown: 'whoosh',
  punch_rejected: 'dull-tick',
  hit: 'impact(+brass ding on counter)',
  player_hit: 'body-thud',
  blocked: 'leather-thud',
  whiff: 'air-swish',
  guard_broken: 'crack',
  telegraph: 'rope-creak | timber-groan | foghorn',
  strike: 'strike-whoosh',
  stagger: 'crowd-ooh',
  opening: 'shimmer',
  gassed: 'breath',
  knockdown: 'thud+crowd-roar',
  count: 'woodblock',
  getup: 'crowd-cheer',
  feint_cancel: 'glove-tap+hah', // D9
  cover: 'leather-creak', // D9
  pressure: 'shell-bark+jeer', // D9a (on:true only)
  guard_split: 'leather-clap+grunt', // D11
  parry: 'clack | soft-whoosh', // D12
  opponent_tired: 'her-breath', // D12
  player_hurt: 'daze', // D12 (plus the low-pass and heartbeat while hurt)
});

/**
 * The exact voices an event plays (D9 telegraph variants included). Pure, so tests can check the plan
 * without an unlocked AudioContext.
 * @returns {string[]}
 */
export function voicesFor(e, state) {
  switch (e.type) {
    case 'telegraph': {
      const v = [];
      // D12: an exhausted Tamsin draws a breath before each wind-up (a real first strike only)
      if (state?.opponent?.tired === 'exhausted' && !(e.comboIndex > 0)) v.push('her-breath');
      const follow = e.comboIndex > 0;
      if (follow && e.combo) {
        v.push('double-tick'); // chain cue: the full wind-up sound would be too slow for the gap
        if (e.attack === 'anchor_drop') v.push('foghorn'); // the foghorn still means "interrupt possible"
      } else if (follow) {
        v.push('jab-tick'); // Rope Snap jabs 2–3 of a single sequence
      } else {
        v.push(e.attack === 'rope_snap' ? 'rope-creak' : e.attack === 'swing_bridge' ? 'timber-groan' : 'foghorn');
        if (e.feint !== true) v.push('plant'); // real wind-ups only: heel drop + deck creak (feints sound the same otherwise)
      }
      if (e.afterFeint) v.push('gotcha');
      return v;
    }
    case 'feint_cancel': return ['glove-tap', 'hah'];
    case 'cover': return ['leather-creak'];
    case 'pressure': return e.on ? ['shell-bark', 'jeer'] : [];
    case 'hit': {
      // D11: a low rising whump for uppercuts; D12: a duller body thud + "oof" for body shots
      const v = e.target === 'body' ? ['body-dull', 'oof'] : [e.punchType === 'uppercut' ? 'whump' : EVENT_VOICES.hit];
      if (e.riposte) v.push('brass-ding');
      if (e.interrupt) v.push('cut-strike');
      return v;
    }
    case 'parry': return [e.result === 'success' ? 'clack' : 'soft-whoosh'];
    case 'opponent_tired': return e.level === 'fresh' ? [] : ['her-breath'];
    case 'player_hurt': return ['daze'];
    case 'count': return [e.who === 'player' ? 'woodblock-muffled' : 'woodblock'];
    case 'blocked': return [e.by === 'player' && e.punchType === 'uppercut' ? 'elbow-thud' : EVENT_VOICES.blocked];
    case 'guard_split': return ['leather-clap', 'grunt'];
    default: return EVENT_VOICES[e.type] ? [EVENT_VOICES[e.type]] : [];
  }
}

export function createAudio() {
  /** @type {AudioContext|null} */
  let ac = null;
  let master = null;
  let noiseBuf = null;
  let muted = false;
  let volume = 0.8;
  const log = []; // recent {type, voice} (tests / debug)
  const responses = {};
  let ambience = null;

  function out(pan = 0) {
    if (!ac) return null;
    if (pan && ac.createStereoPanner) {
      const p = ac.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, pan));
      p.connect(master);
      return p;
    }
    return master;
  }

  function env(g, t, a, peak, d, sustain = 0) {
    g.gain.cancelScheduledValues(t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + a);
    if (sustain > 0) g.gain.setValueAtTime(Math.max(0.0002, peak), t + a + sustain);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + sustain + d);
  }

  function tone({ type = 'sine', f0, f1 = f0, t = ac.currentTime, a = 0.005, peak = 0.3, d = 0.2, sustain = 0, pan = 0, detune = 0, filter = null }) {
    const o = ac.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + a + sustain + d);
    o.detune.value = detune;
    const g = ac.createGain();
    env(g, t, a, peak, d, sustain);
    let node = o;
    if (filter) {
      const bq = ac.createBiquadFilter();
      bq.type = filter.type;
      bq.frequency.value = filter.f;
      bq.Q.value = filter.q ?? 1;
      node.connect(bq);
      node = bq;
    }
    node.connect(g);
    g.connect(out(pan));
    o.start(t);
    o.stop(t + a + sustain + d + 0.05);
    return o;
  }

  function noise({ t = ac.currentTime, a = 0.003, peak = 0.3, d = 0.1, sustain = 0, type = 'bandpass', f0 = 1000, f1 = f0, q = 1, pan = 0 }) {
    const src = ac.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    const bq = ac.createBiquadFilter();
    bq.type = type;
    bq.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) bq.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + a + sustain + d);
    bq.Q.value = q;
    const g = ac.createGain();
    env(g, t, a, peak, d, sustain);
    src.connect(bq).connect(g).connect(out(pan));
    src.start(t, Math.random() * 1.5);
    src.stop(t + a + sustain + d + 0.05);
    return { src, g };
  }

  let strikeVoice = null; // the latest strike whoosh, so a late interrupt can cut it (BUG-009)
  let muffle = null; // D12 master low-pass (hurt / the player's own count)
  const hurtFx = { cutoff: 20000, lastBeat: -Infinity, beats: 0 };

  // ── voices
  const V = {
    bell(t, n = 1, f = 640, gain = 0.25) {
      for (let i = 0; i < n; i++) {
        const tt = t + i * 0.32;
        for (const [m, g] of [[1, 1], [2.76, 0.45], [5.4, 0.22], [8.93, 0.1]]) {
          tone({ f0: f * m, t: tt, a: 0.002, peak: gain * g, d: 1.4 / Math.sqrt(m) });
        }
      }
    },
    brassDing(t) {
      for (const [m, g] of [[1, 1], [2.4, 0.5], [3.9, 0.25]]) tone({ f0: 1180 * m, t, a: 0.002, peak: 0.18 * g, d: 0.6 / Math.sqrt(m) });
    },
    ropeCreak(t, pan) {
      for (let i = 0; i < 3; i++) noise({ t: t + i * 0.045, peak: 0.22, d: 0.03, f0: 2200 + i * 300, q: 8, pan });
      tone({ type: 'sawtooth', f0: 260, f1: 190, t, a: 0.01, peak: 0.06, d: 0.18, pan, filter: { type: 'bandpass', f: 900, q: 4 } });
      tone({ f0: 2640, t: t + 0.02, a: 0.002, peak: 0.12, d: 0.12, pan }); // glint ping
    },
    jabTick(t, pan) {
      noise({ t, peak: 0.15, d: 0.03, f0: 2600, q: 8, pan });
    },
    timberGroan(t, pan) {
      tone({ type: 'sawtooth', f0: 96, f1: 66, t, a: 0.04, peak: 0.22, sustain: 0.25, d: 0.3, pan, filter: { type: 'lowpass', f: 520, q: 8 } });
      tone({ type: 'sawtooth', f0: 143, f1: 101, t: t + 0.03, a: 0.05, peak: 0.08, sustain: 0.2, d: 0.3, pan, detune: 8, filter: { type: 'lowpass', f: 700, q: 4 } });
      noise({ t, a: 0.05, peak: 0.07, d: 0.4, f0: 380, f1: 260, q: 6, pan });
    },
    foghorn(t) {
      for (const [f, g, dt] of [[98, 0.22, 0], [98.7, 0.16, 0], [147, 0.1, 6]]) {
        tone({ type: 'sawtooth', f0: f, t, a: 0.09, peak: g, sustain: 0.75, d: 0.35, detune: dt, filter: { type: 'lowpass', f: 650, q: 1.5 } });
      }
      noise({ t: t + 0.05, a: 0.25, peak: 0.05, d: 0.35, f0: 900, f1: 1300, q: 1.2 }); // crowd gasp
    },
    swoosh(t, peak = 0.05) {
      noise({ t, a: 0.03, peak, d: 0.2, f0: 500, f1: 1600, q: 1.2 });
    },
    whoosh(t, pan, peak = 0.06) {
      noise({ t, a: 0.01, peak, d: 0.1, type: 'highpass', f0: 1800, f1: 3500, q: 0.7, pan });
    },
    strikeWhoosh(t, pan) {
      strikeVoice = { t, ...noise({ t, a: 0.02, peak: 0.16, d: 0.12, f0: 400, f1: 1900, q: 1.5, pan }) };
    },
    cutStrike() { // the interrupt landed while her swing was still sounding: choke it off
      if (!strikeVoice || ac.currentTime - strikeVoice.t > 0.3) return;
      const now = ac.currentTime;
      strikeVoice.g.gain.cancelScheduledValues(now);
      strikeVoice.g.gain.setTargetAtTime(0.0001, now, 0.008);
      strikeVoice = null;
    },
    impact(t, power, pan) {
      const p = clamp01(power);
      tone({ f0: 120 + 80 * p, f1: 45, t, a: 0.002, peak: 0.35 + 0.4 * p, d: 0.14 + 0.06 * p, pan });
      noise({ t, peak: 0.25 + 0.3 * p, d: 0.05, type: 'lowpass', f0: 2200 + 2500 * p, q: 0.7, pan });
    },
    bodyThud(t, tier, pan) {
      tone({ f0: 95, f1: 32, t, a: 0.003, peak: 0.4 + 0.15 * tier, d: 0.2 + 0.05 * tier, pan });
      noise({ t, peak: 0.25 + 0.1 * tier, d: 0.08 + 0.03 * tier, type: 'lowpass', f0: 900, q: 0.7, pan });
    },
    leather(t, pan, peak = 0.3) {
      noise({ t, peak, d: 0.07, type: 'lowpass', f0: 950, q: 1, pan });
      tone({ f0: 190, f1: 120, t, a: 0.002, peak: peak * 0.7, d: 0.08, pan });
    },
    swish(t, pan) {
      noise({ t, a: 0.02, peak: 0.08, d: 0.17, f0: 1300, f1: 450, q: 2, pan });
    },
    crack(t) {
      noise({ t, peak: 0.4, d: 0.09, type: 'highpass', f0: 1500, q: 0.8 });
      tone({ type: 'square', f0: 320, f1: 70, t, a: 0.002, peak: 0.12, d: 0.25, filter: { type: 'lowpass', f: 1400 } });
    },
    crowd(t, kind) {
      if (kind === 'ooh') noise({ t, a: 0.12, peak: 0.08, d: 0.5, f0: 520, f1: 340, q: 3 });
      else if (kind === 'roar') noise({ t, a: 0.3, peak: 0.14, sustain: 0.6, d: 1.0, f0: 700, f1: 900, q: 0.8 });
      else noise({ t, a: 0.25, peak: 0.1, sustain: 0.3, d: 0.8, f0: 900, f1: 1200, q: 0.9 }); // cheer
    },
    shimmer(t) {
      tone({ f0: 1320, t, a: 0.01, peak: 0.05, d: 0.25 });
      tone({ f0: 1760, t: t + 0.05, a: 0.01, peak: 0.04, d: 0.25 });
    },
    breath(t) {
      noise({ t, a: 0.12, peak: 0.08, d: 0.3, f0: 650, q: 1.5 });
      noise({ t: t + 0.55, a: 0.12, peak: 0.06, d: 0.3, f0: 550, q: 1.5 });
    },
    dullTick(t, pan) {
      tone({ f0: 160, f1: 110, t, a: 0.002, peak: 0.12, d: 0.06, pan });
    },
    /** A voiced syllable: a sawtooth glottal source through two vowel formants, optional breathy onset. */
    vowel(t, { f0, f1 = f0, formants, dur, peak = 0.12, breath = 0, pan = 0 }) {
      const o = ac.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(f1, t + dur);
      const g = ac.createGain();
      env(g, t, 0.015, peak, dur);
      for (const [f, q, w] of formants) {
        const bq = ac.createBiquadFilter();
        bq.type = 'bandpass';
        bq.frequency.value = f;
        bq.Q.value = q;
        const wg = ac.createGain();
        wg.gain.value = w;
        o.connect(bq).connect(wg).connect(g);
      }
      g.connect(out(pan));
      o.start(t);
      o.stop(t + dur + 0.1);
      if (breath) noise({ t: t - 0.03, a: 0.005, peak: breath, d: 0.05, f0: 1600, q: 0.8, pan });
    },
    hah(t, pan) { // the scoff after a feint
      V.vowel(t + 0.04, { f0: 235, f1: 165, formants: [[820, 6, 1.4], [1250, 8, 0.9], [2600, 6, 0.3]], dur: 0.2, peak: 0.16, breath: 0.12, pan });
    },
    gotcha(t, pan) { // "Gotcha!" on a punish telegraph
      V.vowel(t, { f0: 215, f1: 205, formants: [[460, 7, 1.4], [820, 8, 0.8]], dur: 0.11, peak: 0.13, pan }); // go
      noise({ t: t + 0.13, peak: 0.12, d: 0.012, type: 'highpass', f0: 3200, q: 0.7, pan }); // t
      noise({ t: t + 0.15, a: 0.01, peak: 0.1, d: 0.06, f0: 3300, q: 2, pan }); // ch
      V.vowel(t + 0.19, { f0: 240, f1: 175, formants: [[800, 6, 1.4], [1250, 8, 0.9]], dur: 0.16, peak: 0.14, pan }); // a
    },
    whump(t, power, pan) { // D11 uppercut landing: low and rising, under the hook's impact
      const p = clamp01(power);
      tone({ f0: 52, f1: 118, t, a: 0.004, peak: 0.42 + 0.35 * p, d: 0.16, pan });
      tone({ f0: 80, f1: 150, t: t + 0.01, a: 0.004, peak: 0.12, d: 0.1, pan });
      noise({ t, peak: 0.2 + 0.2 * p, d: 0.06, type: 'lowpass', f0: 700, f1: 1400, q: 0.8, pan });
    },
    elbowThud(t, pan) { // uppercut stopped by a tuck / cover: bone-dull, no leather slap
      tone({ f0: 115, f1: 68, t, a: 0.002, peak: 0.34, d: 0.11, pan });
      noise({ t, peak: 0.16, d: 0.05, type: 'lowpass', f0: 420, q: 1.2, pan });
    },
    leatherClap(t) { // the split: both gloves knocked apart
      noise({ t, peak: 0.42, d: 0.05, type: 'bandpass', f0: 1700, q: 0.9 });
      noise({ t: t + 0.012, peak: 0.2, d: 0.08, type: 'lowpass', f0: 900, q: 1 });
    },
    grunt(t) { // a short, low, voiced "uhh"
      V.vowel(t, { f0: 175, f1: 135, formants: [[600, 6, 1.3], [1000, 8, 0.7]], dur: 0.16, peak: 0.13, breath: 0.08 });
    },
    shellBark(t) { // "Come out of that shell!" — five quick syllables with a taunting rise on "shell"
      const syl = [
        [0.0, 0.1, 210, 200, [[640, 7, 1.3], [1190, 8, 0.8]]], // come
        [0.12, 0.13, 225, 205, [[760, 6, 1.3], [1100, 8, 0.8]]], // out
        [0.27, 0.07, 200, 195, [[500, 7, 1.2], [1500, 8, 0.6]]], // of
        [0.36, 0.11, 230, 215, [[700, 6, 1.3], [1700, 8, 0.7]]], // that
        [0.56, 0.26, 260, 175, [[560, 6, 1.3], [1850, 8, 0.8]]], // shell
      ];
      for (const [dt, dur, f0, f1, formants] of syl) V.vowel(t + dt, { f0, f1, formants, dur, peak: 0.13 });
      noise({ t: t + 0.36, peak: 0.05, d: 0.02, f0: 4200, q: 3 }); // th
      noise({ t: t + 0.48, a: 0.02, peak: 0.1, d: 0.07, f0: 3600, q: 2 }); // sh
    },
    jeer(t) { // a crowd boo from the bank: detuned low voices through an "oo" formant
      for (const [f, dt] of [[132, -12], [151, 7], [168, -5], [189, 11]]) {
        tone({ type: 'sawtooth', f0: f, f1: f * 0.88, t: t + 0.7, a: 0.25, peak: 0.035, sustain: 0.6, d: 0.6, detune: dt, filter: { type: 'bandpass', f: 330, q: 3 } });
      }
      noise({ t: t + 0.7, a: 0.3, peak: 0.05, sustain: 0.5, d: 0.6, f0: 520, f1: 420, q: 1.5 });
    },
    plant(t, pan) { // heel drop + deck-board creak
      tone({ f0: 80, f1: 45, t, a: 0.003, peak: 0.32, d: 0.09, pan });
      tone({ type: 'sawtooth', f0: 175, f1: 128, t: t + 0.025, a: 0.01, peak: 0.08, d: 0.2, pan, filter: { type: 'bandpass', f: 680, q: 10 } });
      noise({ t: t + 0.03, peak: 0.05, d: 0.12, f0: 1150, f1: 900, q: 12, pan });
    },
    doubleTick(t, pan) { // combo chain cue
      for (const dt of [0, 0.065]) {
        noise({ t: t + dt, peak: 0.2, d: 0.025, f0: 2900, q: 9, pan });
        tone({ f0: 1900, t: t + dt, a: 0.001, peak: 0.07, d: 0.04, pan });
      }
    },
    gloveTap(t, pan) {
      for (const dt of [0, 0.045]) noise({ t: t + dt, peak: 0.24, d: 0.04, type: 'lowpass', f0: 1400, q: 1, pan });
    },
    leatherCreak(t) {
      for (let i = 0; i < 6; i++) noise({ t: t + i * 0.028, peak: 0.07 * (1 - i * 0.12), d: 0.03, f0: 430 + i * 25, q: 7 });
      tone({ type: 'sawtooth', f0: 112, f1: 96, t, a: 0.02, peak: 0.05, d: 0.22, filter: { type: 'bandpass', f: 520, q: 12 } });
    },
    woodblock(t, n, muffled = false) {
      if (muffled) { // through the canvas and a ringing head
        tone({ f0: 520 + n * 18, t, a: 0.004, peak: 0.26, d: 0.18, filter: { type: 'lowpass', f: 600, q: 1 } });
        return;
      }
      tone({ f0: 820 + n * 25, t, a: 0.001, peak: 0.3, d: 0.08, filter: { type: 'bandpass', f: 900 + n * 25, q: 3 } });
      noise({ t, peak: 0.12, d: 0.015, f0: 3000, q: 2 });
    },
    bodyDull(t, power, pan) { // D12: lower and duller than a head impact
      const p = clamp01(power);
      tone({ f0: 95, f1: 55, t, a: 0.003, peak: 0.36 + 0.3 * p, d: 0.16, pan });
      noise({ t, peak: 0.18 + 0.15 * p, d: 0.06, type: 'lowpass', f0: 600, q: 0.8, pan });
    },
    oof(t) { // the wind knocked out of her
      V.vowel(t, { f0: 190, f1: 150, formants: [[330, 7, 1.3], [870, 8, 0.6]], dur: 0.14, peak: 0.12, breath: 0.1 });
    },
    clack(t, pan) { // D12 parry: a sharp leather clack
      noise({ t, peak: 0.45, d: 0.035, type: 'bandpass', f0: 2600, q: 1.5, pan });
      tone({ f0: 1400, f1: 900, t, a: 0.001, peak: 0.12, d: 0.05, pan });
    },
    softWhoosh(t, pan) {
      noise({ t, a: 0.03, peak: 0.05, d: 0.2, f0: 700, f1: 1500, q: 1, pan });
    },
    herBreath(t, pan) { // D12: a heavy in-breath
      noise({ t, a: 0.18, peak: 0.07, d: 0.25, f0: 900, f1: 1300, q: 1.2, pan });
    },
    daze(t) { // D12 hurt onset: a dull ring
      tone({ f0: 440, t, a: 0.01, peak: 0.04, d: 0.9 });
      tone({ f0: 446, t, a: 0.01, peak: 0.04, d: 0.9 });
    },
    heartbeat(t) {
      tone({ f0: 62, f1: 45, t, a: 0.004, peak: 0.32, d: 0.12 });
      tone({ f0: 58, f1: 42, t: t + 0.18, a: 0.004, peak: 0.22, d: 0.12 });
    },
  };

  function startAmbience() {
    if (ambience || !ac) return;
    // river: lowpassed noise with a slow swell; crowd: a quiet bandpassed murmur
    const mk = (f, q, type, gain) => {
      const src = ac.createBufferSource();
      src.buffer = noiseBuf;
      src.loop = true;
      const bq = ac.createBiquadFilter();
      bq.type = type;
      bq.frequency.value = f;
      bq.Q.value = q;
      const g = ac.createGain();
      g.gain.value = gain;
      const lfo = ac.createOscillator();
      lfo.frequency.value = 0.17 + Math.random() * 0.1;
      const lg = ac.createGain();
      lg.gain.value = gain * 0.6;
      lfo.connect(lg).connect(g.gain);
      src.connect(bq).connect(g).connect(master);
      src.start();
      lfo.start();
      return [src, lfo];
    };
    ambience = [...mk(320, 0.6, 'lowpass', 0.05), ...mk(520, 1.2, 'bandpass', 0.018)];
  }

  function play(e, state) {
    const t = ac.currentTime + 0.005;
    // her left is screen right
    const herPan = e.side === 'left' ? 0.4 : e.side === 'right' ? -0.4 : 0;
    const myPan = e.hand === 'left' ? -0.3 : e.hand === 'right' ? 0.3 : 0;
    switch (e.type) {
      case 'telegraph':
      case 'feint_cancel':
      case 'cover':
      case 'opponent_tired':
      case 'pressure': {
        const VOICE = {
          'rope-creak': () => V.ropeCreak(t, herPan),
          'timber-groan': () => V.timberGroan(t, herPan),
          foghorn: () => V.foghorn(t),
          'jab-tick': () => V.jabTick(t, herPan),
          'double-tick': () => V.doubleTick(t, herPan),
          plant: () => V.plant(t + 0.01, -herPan * 0.5), // her rear foot
          gotcha: () => V.gotcha(t + 0.06, herPan),
          'glove-tap': () => V.gloveTap(t, herPan),
          hah: () => V.hah(t + 0.03, 0),
          'leather-creak': () => V.leatherCreak(t),
          'shell-bark': () => V.shellBark(t + 0.05),
          jeer: () => V.jeer(t),
          'her-breath': () => V.herBreath(t, herPan),
        };
        for (const v of voicesFor(e, state)) VOICE[v]?.();
        break;
      }
      case 'strike': V.strikeWhoosh(t, herPan); break;
      case 'hit':
        if (e.interrupt) V.cutStrike();
        if (e.target === 'body') { V.bodyDull(t, e.power ?? 0.6, myPan); V.oof(t + 0.05); }
        else if (e.punchType === 'uppercut') V.whump(t, e.power ?? 0.6, myPan);
        else V.impact(t, e.power ?? 0.6, myPan);
        if (e.counter || e.interrupt || e.riposte) V.brassDing(t + 0.02);
        break;
      case 'player_hit': V.bodyThud(t, e.shakeTier ?? 1, herPan); break;
      case 'blocked':
        if (e.by === 'player' && e.punchType === 'uppercut') V.elbowThud(t, myPan);
        else V.leather(t, e.by === 'player' ? myPan : herPan, e.by === 'player' ? 0.22 : 0.32);
        break;
      case 'guard_split': V.leatherClap(t); V.grunt(t + 0.07); break;
      case 'whiff': V.swish(t, myPan); break;
      case 'punch_thrown': V.whoosh(t, myPan); break;
      case 'punch_rejected': V.dullTick(t, myPan); break;
      case 'guard_broken': V.crack(t); break;
      case 'stagger': V.crowd(t, 'ooh'); break;
      case 'opening': V.shimmer(t); break;
      case 'gassed': V.breath(t); break;
      case 'knockdown': V.bodyThud(t, 3, 0); V.crowd(t + 0.1, 'roar'); break;
      case 'count':
        if (e.who === 'player') V.woodblock(t, e.n ?? 1, true); // heard from the canvas: muffled
        else V.woodblock(t, e.n ?? 1);
        break;
      case 'parry':
        if (e.result === 'success') V.clack(t, myPan);
        else V.softWhoosh(t, myPan);
        break;
      case 'player_hurt': V.daze(t); break;
      case 'getup': V.crowd(t, 'cheer'); break;
      case 'round_start': V.bell(t, 2); break;
      case 'round_end': V.bell(t, 1); break;
      case 'match_end': V.bell(t, 3); V.crowd(t + 0.2, 'roar'); break;
      case 'phase': V.swoosh(t); break;
      default: break;
    }
  }

  const api = {
    async unlock() {
      if (!ac) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        ac = new AC();
        master = ac.createGain();
        master.gain.value = muted ? 0 : volume;
        // D12: everything goes through a low-pass that closes to ~800 Hz while the player is hurt
        muffle = ac.createBiquadFilter();
        muffle.type = 'lowpass';
        muffle.frequency.value = 20000;
        master.connect(muffle).connect(ac.destination);
        const len = ac.sampleRate * 2;
        noiseBuf = ac.createBuffer(1, len, ac.sampleRate);
        const d = noiseBuf.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      }
      if (ac.state !== 'running') await ac.resume();
      startAmbience();
    },
    /**
     * @param {import('../shared/types.js').GameEvent[]} events
     * @param {import('../shared/types.js').GameState} state
     */
    handle(events, state) {
      // D12 hurt (and the player's own count): muffled world + heartbeat. Driven by state, once per call.
      const hurt = !!state && Number.isFinite(state.player?.hurtUntil) && state.time < state.player.hurtUntil;
      const down = !!state?.player?.down;
      const cutoff = hurt ? 800 : down ? 1400 : 20000;
      if (cutoff !== hurtFx.cutoff) {
        hurtFx.cutoff = cutoff;
        if (muffle) muffle.frequency.setTargetAtTime(cutoff, ac.currentTime, 0.05);
      }
      if (hurt && state.time - hurtFx.lastBeat >= 0.8) {
        hurtFx.lastBeat = state.time;
        hurtFx.beats += 1;
        if (ac && ac.state === 'running' && !muted) V.heartbeat(ac.currentTime + 0.01);
      }
      for (const e of events) {
        const voice = EVENT_VOICES[e.type];
        if (!voice) continue;
        responses[e.type] = (responses[e.type] ?? 0) + 1;
        log.push({ type: e.type, voice, voices: voicesFor(e, state) });
        if (log.length > 200) log.shift();
        // nothing plays until the player's gesture has unlocked the context
        if (!ac || ac.state !== 'running' || muted) continue;
        try {
          play(e, state);
        } catch (err) {
          console.warn('[audio] voice failed:', e.type, err?.message ?? err);
        }
      }
    },
    setMuted(m) {
      muted = !!m;
      if (master) master.gain.setTargetAtTime(muted ? 0 : volume, ac.currentTime, 0.02);
    },
    setVolume(v) {
      volume = clamp01(+v || 0);
      if (master && !muted) master.gain.setTargetAtTime(volume, ac.currentTime, 0.02);
    },
    dispose() {
      ambience?.forEach((n) => { try { n.stop(); } catch { /* already stopped */ } });
      ambience = null;
      ac?.close();
      ac = null;
    },
    /** Test/debug only. */
    debug() {
      return { responses: { ...responses }, log: log.slice(-20), state: ac?.state ?? 'locked', muted, cutoff: hurtFx.cutoff, beats: hurtFx.beats };
    },
  };

  const params = new URLSearchParams(location.search);
  if (params.get('test') === '1' || params.get('debug') === '1') {
    window.__view = window.__view ?? {};
    window.__view.audio = api;
  }
  return api;
}
