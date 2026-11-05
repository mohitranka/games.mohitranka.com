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
});

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
  }

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
      noise({ t, a: 0.02, peak: 0.16, d: 0.12, f0: 400, f1: 1900, q: 1.5, pan });
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
    woodblock(t, n) {
      tone({ f0: 820 + n * 25, t, a: 0.001, peak: 0.3, d: 0.08, filter: { type: 'bandpass', f: 900 + n * 25, q: 3 } });
      noise({ t, peak: 0.12, d: 0.015, f0: 3000, q: 2 });
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
        if (e.comboIndex > 0) V.jabTick(t, herPan);
        else if (e.attack === 'rope_snap') V.ropeCreak(t, herPan);
        else if (e.attack === 'swing_bridge') V.timberGroan(t, herPan);
        else if (e.attack === 'anchor_drop') V.foghorn(t);
        break;
      case 'strike': V.strikeWhoosh(t, herPan); break;
      case 'hit':
        V.impact(t, e.power ?? 0.6, myPan);
        if (e.counter || e.interrupt) V.brassDing(t + 0.02);
        break;
      case 'player_hit': V.bodyThud(t, e.shakeTier ?? 1, herPan); break;
      case 'blocked': V.leather(t, e.by === 'player' ? myPan : herPan, e.by === 'player' ? 0.22 : 0.32); break;
      case 'whiff': V.swish(t, myPan); break;
      case 'punch_thrown': V.whoosh(t, myPan); break;
      case 'punch_rejected': V.dullTick(t, myPan); break;
      case 'guard_broken': V.crack(t); break;
      case 'stagger': V.crowd(t, 'ooh'); break;
      case 'opening': V.shimmer(t); break;
      case 'gassed': V.breath(t); break;
      case 'knockdown': V.bodyThud(t, 3, 0); V.crowd(t + 0.1, 'roar'); break;
      case 'count': V.woodblock(t, e.n ?? 1); break;
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
        master.connect(ac.destination);
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
      for (const e of events) {
        const voice = EVENT_VOICES[e.type];
        if (!voice) continue;
        responses[e.type] = (responses[e.type] ?? 0) + 1;
        log.push({ type: e.type, voice });
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
      return { responses: { ...responses }, log: log.slice(-20), state: ac?.state ?? 'locked', muted };
    },
  };

  const params = new URLSearchParams(location.search);
  if (params.get('test') === '1' || params.get('debug') === '1') {
    window.__view = window.__view ?? {};
    window.__view.audio = api;
  }
  return api;
}
