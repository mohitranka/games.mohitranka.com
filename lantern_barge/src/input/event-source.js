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
  // P1b: timestamped histories so the keyboard guard can be read keyboardGuardDelayMs in the past
  const spaceHist = []; // {t, down}
  const punchHist = { left: [], right: [] }; // {t, until}
  const lastPunchAt = { left: -Infinity, right: -Infinity };
  const lastParryAt = { left: -Infinity, right: -Infinity }; // D12
  const lockoutUntil = { left: -Infinity, right: -Infinity }; // guard lockout: 250 ms, 350 ms after an uppercut (D11)
  const anim = { left: null, right: null }; // {type, t0}

  // injection state
  let overrideGuard = null; // 'none' | 'full' | null
  let overrideTrackingOk = null; // true | false | null (tests: simulate a camera stall, D10 auto-resume)
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
    return t < lockoutUntil[hand] - 1e-9;
  }

  const HIST_S = 5;
  const trim = (list, t) => {
    while (list.length > 1 && list[1].t < t - HIST_S) list.shift();
  };

  /** Keyboard guard at time t: Space held and neither hand locked out. With guard parity (P1a/P1b) both come from
   *  the histories read keyboardGuardDelayMs in the past, so a press, a release and a post-punch return all land late. */
  function keyboardGuardLevel(t) {
    if (!tuning.guardParity) {
      if (!keyGuard) return 'none';
      return HANDS.some((h) => lockedOut(h, t)) ? 'none' : 'full';
    }
    const at = t - tuning.keyboardGuardDelayMs / 1000;
    let down = false;
    for (const e of spaceHist) {
      if (e.t <= at + 1e-9) down = e.down;
      else break;
    }
    if (!down) return 'none';
    const locked = HANDS.some((h) => punchHist[h].some((p) => p.t <= at + 1e-9 && at < p.until - 1e-9));
    return locked ? 'none' : 'full';
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
        } else if (a.type === 'uppercut') {
          // D11: a short dip (~60 ms), then an up-and-forward arc to chin height, then back
          const u = (t - a.t0) / dur;
          const dip = u < 0.24 ? u / 0.24 : 1;
          const rise = u < 0.24 ? 0 : Math.sin((Math.PI * (u - 0.24)) / 0.76);
          hs.y += 0.05 * dip * (1 - rise) - 0.12 * rise;
          ext = 0.5 * rise;
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
      if (keyGuard) spaceHist.push({ t: nowS(), down: false });
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
      if (keyGuard) spaceHist.push({ t: nowS(), down: false });
      keyGuard = false;
    },
    /** @returns {boolean} false if ignored (refractory) */
    keyPunch(hand, punchType, target = 'head') {
      const t = nowS();
      if (t - lastPunchAt[hand] < tuning.refractoryMs / 1000) return false;
      lastPunchAt[hand] = t;
      if (tuning.guardParity) {
        // P1a/P1b: back at onset (keydown) + guardReturnMs, or + uppercutGuardReturnMs
        const back = punchType === 'uppercut' ? tuning.uppercutGuardReturnMs : tuning.guardReturnMs;
        lockoutUntil[hand] = t + back / 1000;
        punchHist[hand].push({ t, until: lockoutUntil[hand] });
        trim(punchHist[hand], t);
      } else {
        lockoutUntil[hand] = t + (punchType === 'uppercut' ? tuning.uppercutGuardLockoutMs : tuning.guardLockoutMs) / 1000;
      }
      anim[hand] = { type: punchType, t0: t };
      kbQueue.push({
        type: 'punch',
        id: nextId++,
        hand,
        punchType,
        target, // D12: Shift + F/J/D/K → 'body'
        power: tuning.keyboardPower,
        aim: { x: profile.hands[hand].center.x },
        tOnset: t,
        tCommit: t,
        inferred: false,
      });
      return true;
    },
    /** D12: A / ; tap → a parry input event at keydown time. Same 400 ms refractory as the camera swipe. */
    keyParry(hand) {
      const t = nowS();
      if (t - lastParryAt[hand] < tuning.parryRefractoryMs / 1000) return false;
      lastParryAt[hand] = t;
      kbQueue.push({ type: 'parry', id: nextId++, hand, tOnset: t, tCommit: t });
      return true;
    },
    setKeyGuard(down) {
      down = !!down;
      if (down !== keyGuard) {
        const t = nowS();
        spaceHist.push({ t, down });
        trim(spaceHist, t);
      }
      keyGuard = down;
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
        target: e.target ?? 'head', // D12
        power: e.power ?? 0.8,
        aim: e.aim ?? { x: e.aimX ?? 0.5 },
        tOnset: e.tOnset ?? tCommit,
        tCommit,
        inferred: e.inferred ?? false,
      };
      injQueue.push(ev);
      return ev;
    },
    /** D12 test injection: a parry input event (lands on the next sample(), like pushPunch). */
    pushParry(e = {}) {
      const tCommit = e.tCommit ?? nowS() - latencyMs / 1000;
      const ev = { type: 'parry', id: e.id ?? nextId++, hand: e.hand ?? 'left', tOnset: e.tOnset ?? tCommit, tCommit };
      injQueue.push(ev);
      return ev;
    },
    setGuard(level) {
      if (level !== null && level !== 'none' && level !== 'full') throw new Error(`inject.guard: bad level ${level}`);
      overrideGuard = level;
    },
    /** Override frame.tracking.ok (null releases). Simulates a camera loss for the auto-pause / auto-resume. */
    setTrackingOk(v) {
      overrideTrackingOk = v === null || v === undefined ? null : !!v;
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
      if (overrideTrackingOk !== null) frame.tracking = { ...frame.tracking, ok: overrideTrackingOk };
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
