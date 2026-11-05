// input/event-source.js — EventSource: keyboard input + test injection (architecture §3.2, D7). Owner: PD.
// As an InputSource it produces frames for keyboard play (or 'none' in ?test=1).
// decorate(frame) merges test injections into ANY source's frame (camera, replay or its own).
// Guard events: decorate() is the single place that emits {type:'guard'} input events, by comparing the
// final guard level with the previous decorated frame. Sources only set frame.guard.

import { createInputFrame, createCalibrationStatus } from '../shared/fixtures.js';
import { HANDS } from '../shared/constants.js';
import { tuning as defaultTuning, DEFAULT_PROFILE } from './tuning.js';

/** @typedef {import('../shared/types.js').InputFrame} InputFrame */
/** @typedef {import('../shared/types.js').PunchEvent} PunchEvent */

/**
 * @param {{clock: import('../shared/clock.js').Clock, tuning?: object, profile?: object}} opts
 */
export function createEventSource({ clock, tuning = defaultTuning, profile = DEFAULT_PROFILE }) {
  let kind = 'none'; // 'keyboard' once keyboard bindings are attached
  let seq = 0;
  let nextId = 1;

  const kbQueue = []; // keyboard punches (part of this source's own frames)
  const injQueue = []; // injected punches (merged into any frame by decorate)

  // keyboard state
  let keyGuard = false;
  const lastPunchAt = { left: -Infinity, right: -Infinity };
  const anim = { left: null, right: null }; // {type, t0}

  // injection state
  let overrideGuard = null; // 'none' | 'full' | null
  let latencyMs = 0;

  // guard-event bookkeeping (decorate)
  let lastLevel = 'none';
  let levelSince = 0;

  // calibration: no camera here, so a requested session completes immediately (D5a: keyboard skips calibration)
  let calib = createCalibrationStatus();

  function nowS() {
    return clock.now();
  }

  function takeDue(queue, t) {
    const due = [];
    for (let i = 0; i < queue.length; ) {
      if (queue[i].tCommit <= t + 1e-9) due.push(queue.splice(i, 1)[0]);
      else i++;
    }
    return due;
  }

  function lockedOut(hand, t) {
    return t - lastPunchAt[hand] < tuning.guardLockoutMs / 1000;
  }

  function keyboardGuardLevel(t) {
    if (!keyGuard) return 'none';
    return HANDS.some((h) => lockedOut(h, t)) ? 'none' : 'full';
  }

  // Synthesized gloves for keyboard play, so the view behaves the same as with a camera.
  function keyboardHands(frame, t) {
    const level = keyboardGuardLevel(t);
    for (const h of HANDS) {
      const hs = frame.hands[h];
      const p = profile.hands[h];
      hs.present = true;
      hs.fist = true;
      hs.openness = 0;
      hs.x = p.center.x;
      hs.y = p.center.y + (level === 'full' ? 0 : 0.12);
      let ext = 0;
      const a = anim[h];
      const dur = tuning.keyboardPunchAnimMs / 1000;
      if (a && t >= a.t0 && t - a.t0 < dur) {
        const s = Math.sin((Math.PI * (t - a.t0)) / dur);
        if (a.type === 'hook') {
          hs.x += (h === 'left' ? 1 : -1) * 0.2 * s; // toward the midline
          ext = 0.3 * s;
        } else {
          ext = s;
        }
      }
      hs.ext = ext;
      hs.kRatio = Math.exp(ext * Math.log(tuning.extFullRatio));
      hs.k = p.kGuard * hs.kRatio;
      hs.inGuardZone = level === 'full';
      hs.punchPhase = t - lastPunchAt[h] < tuning.refractoryMs / 1000 ? 'refractory' : 'idle';
    }
    frame.guard.level = level;
    frame.guard.raw = level === 'full';
    frame.guard.left = frame.guard.right = level === 'full';
  }

  function buildFrame(t, drain) {
    const frame = createInputFrame(t, kind);
    if (drain) frame.seq = ++seq;
    else frame.seq = seq;
    if (kind === 'keyboard') keyboardHands(frame, t);
    frame.calibration = { ...calib };
    if (drain) frame.events = takeDue(kbQueue, t).sort((a, b) => a.tCommit - b.tCommit);
    return frame;
  }

  const source = {
    get kind() {
      return kind;
    },
    profile,

    async start() {},
    stop() {
      kbQueue.length = 0;
      keyGuard = false;
    },

    /** @param {number} t sim seconds */
    sample(t) {
      return buildFrame(t, true);
    },
    peek(t) {
      return buildFrame(t, false);
    },

    beginCalibration(session) {
      calib = { ...createCalibrationStatus(), session, step: 'done', done: true };
    },
    cancelCalibration() {
      calib = createCalibrationStatus();
    },

    // ── keyboard (called by keyboard-source.js)
    attachKeyboard() {
      kind = 'keyboard';
    },
    detachKeyboard() {
      kind = 'none';
      keyGuard = false;
    },
    /** @returns {boolean} false if ignored (refractory) */
    keyPunch(hand, punchType) {
      const t = nowS();
      if (t - lastPunchAt[hand] < tuning.refractoryMs / 1000) return false;
      lastPunchAt[hand] = t;
      anim[hand] = { type: punchType, t0: t };
      kbQueue.push({
        type: 'punch',
        id: nextId++,
        hand,
        punchType,
        power: tuning.keyboardPower,
        aim: { x: profile.hands[hand].center.x },
        tOnset: t,
        tCommit: t,
        inferred: false,
      });
      return true;
    },
    setKeyGuard(down) {
      keyGuard = !!down;
    },

    // ── injection (test hook; works on top of any source)
    /** @param {Partial<PunchEvent> & {aimX?:number}} e */
    pushPunch(e = {}) {
      const tCommit = e.tCommit ?? nowS() - latencyMs / 1000;
      const ev = {
        type: 'punch',
        id: e.id ?? nextId++,
        hand: e.hand ?? 'left',
        punchType: e.punchType ?? 'straight',
        power: e.power ?? 0.8,
        aim: e.aim ?? { x: e.aimX ?? 0.5 },
        tOnset: e.tOnset ?? tCommit,
        tCommit,
        inferred: e.inferred ?? false,
      };
      injQueue.push(ev);
      return ev;
    },
    setGuard(level) {
      if (level !== null && level !== 'none' && level !== 'full') throw new Error(`inject.guard: bad level ${level}`);
      overrideGuard = level;
    },
    setLatency(ms) {
      latencyMs = Math.max(0, +ms || 0);
    },
    get latencyMs() {
      return latencyMs;
    },

    /**
     * Merge injections into a frame. drain=false (rendering) applies the guard override only.
     * @param {InputFrame} frame
     * @param {{drain?: boolean}} [opts]
     */
    decorate(frame, { drain = true } = {}) {
      if (overrideGuard !== null) {
        const full = overrideGuard === 'full';
        frame.guard = { ...frame.guard, level: overrideGuard, raw: full, left: full, right: full };
      }
      if (drain) {
        const due = takeDue(injQueue, frame.t);
        if (due.length) frame.events = [...frame.events, ...due].sort((a, b) => a.tCommit - b.tCommit);
        if (frame.guard.level !== lastLevel) {
          lastLevel = frame.guard.level;
          levelSince = frame.t;
          frame.events.push({ type: 'guard', level: lastLevel, t: frame.t });
        }
      }
      frame.guard.since = levelSince;
      return frame;
    },
  };
  return source;
}
