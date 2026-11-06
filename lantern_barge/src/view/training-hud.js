// view/training-hud.js — the D14 Training mode HUD (owner: TA). Lives inside #hud next to the fight HUD.
// Everything is shown in the ACTIVE input's form (P1): camera players see gestures, keyboard players see keys.
//   lesson card   explanation line, demo keycaps (keyboard; the camera demo is the ghost glove in gloves.js),
//                 rep counter with per-hand pips
//   feedback      tick + move + power, "That was a left hook…", near-miss reasons in plain words
//   meter         live per-hand signal vs threshold (camera) or key-press lamps (keyboard)
//   timing bar    the window and where the onset fell, "early by 120 ms"
//   mitt drill    the call ("Left straight!"), call n/10 and the 2.5 s call bar
//   overlay       the training menu with progress ticks + the selectors (punches on camera, keys on keyboard)
//   result card   accuracy, per-shot chips, most common mistake
// Reads state.training, training_* / near_miss events and the frame; never mutates them.

import { featuresOf } from './features.js';
import * as KM from '../shared/keymap.js';

const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
};
const pct = (x) => `${Math.round(Math.max(0, Math.min(1, x)) * 100)}%`;
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

export const MOVE_NAME = {
  guard: 'Guard', straight: 'Straight', hook: 'Hook', uppercut: 'Uppercut', body: 'Body shot', parry: 'Parry',
  rise: 'Getting up', slip: 'Slip', duck: 'Duck',
};

/** One-line explanation per lesson, camera form (game-design §15.2). */
const CAM_LINE = {
  guard: 'both fists up at your cheeks. Hold it for 2 s',
  straight: 'punch straight out at her, fist closed',
  hook: 'swing in from the side toward the middle, fist closed',
  uppercut: 'dip your fist low, then drive it up to her chin',
  body: 'a straight or hook with your fist low, at rib height',
  parry: 'as her jab comes in, swipe that side’s glove outward',
  rise: 'you’re down: hold your guard until the ring fills',
  slip: 'lean your head left or right as her jab comes',
  duck: 'drop your head under her Swing Bridge',
};

/** What a correct move looks like, for "That was a left hook. <hint>". */
const RIGHT_WAY = {
  straight: 'A straight goes straight out, toward her.',
  hook: 'A hook swings in toward the middle.',
  uppercut: 'An uppercut starts low and drives up.',
  body: 'Keep your fist low, at rib height.',
  guard: 'Hold both fists at your cheeks.',
  parry: 'Swipe outward, with the glove on her punching side.',
};

/** Near-miss reasons in plain words (game-design §15.3). */
export function nearMissText(nm) {
  const ratio = nm.threshold ? nm.value / nm.threshold : null;
  switch (nm.reason) {
    case 'fist_open': return 'Close your fist';
    case 'too_slow': return ratio ? `Faster: you reached ${Math.round(ratio * 100)}% of the speed needed` : 'Faster';
    case 'too_short': return 'Longer: follow through';
    case 'not_extended': return 'Reach further toward her';
    case 'wrong_direction': return nm.kind === 'parry' ? 'Parries push out' : 'Hooks swing in toward the middle';
    case 'too_vertical': return 'Keep it level';
    case 'too_sideways': return 'Keep it straight up';
    case 'not_low': return 'Lower: aim at the ribs';
    case 'not_in_pocket': return 'Start the uppercut lower';
    case 'both_hands': return 'One hand at a time';
    case 'locked_out': return 'Too soon after the last punch';
    case 'out_of_frame': return 'Keep your hands in view';
    case 'hand_out_of_zone': return `Bring your ${nm.hand ?? ''} fist up to your cheek`.replace('  ', ' ');
    case 'too_close': return 'Step back';
    case 'too_far': return 'Step closer';
    default: return nm.reason ? cap(nm.reason.replace(/_/g, ' ')) : '';
  }
}

/** Drill verdict + timing ("Hit: guard came up 90 ms late"). */
function timingText(rep) {
  if (Number.isFinite(rep.earlyMs) && rep.earlyMs > 0) return `early by ${Math.round(rep.earlyMs)} ms`;
  if (Number.isFinite(rep.lateMs) && rep.lateMs > 0) return `late by ${Math.round(rep.lateMs)} ms`;
  return '';
}

function shotName(shot) {
  if (!shot) return '';
  const type = shot.punchType === 'straight' ? 'straight' : shot.punchType;
  return `${cap(shot.hand)} ${type}${shot.target === 'body' ? ' to the body' : ''}`;
}

/** Keyboard key labels per move: punches and guard from the shared keymap, the rest from game-design §10. */
function keysFor(move, features) {
  const map = typeof KM.activeKeymap === 'function' ? KM.activeKeymap(features) : [];
  const byType = (t) => map.filter((b) => b.punchType === t).map((b) => ({ key: b.label, hand: b.hand }));
  const byAction = (a) => map.filter((b) => b.action === a).map((b) => ({ key: b.label, hand: b.hand }));
  const or = (a, b) => (a.length ? a : b);
  switch (move) {
    case 'straight': case 'hook': case 'uppercut': return byType(move);
    case 'guard': case 'rise': return or(byAction('guard'), [{ key: 'Space', hand: null }]);
    case 'body': return [{ key: 'Shift', hand: null }, ...byType('straight'), ...byType('hook')];
    case 'parry': return or(byAction('parry'), [{ key: 'A', hand: 'left' }, { key: ';', hand: 'right' }]);
    case 'slip': return or(byAction('slip'), [{ key: 'Q', hand: 'left' }, { key: 'P', hand: 'right' }]);
    case 'duck': return or(byAction('duck'), [{ key: 'Z', hand: null }, { key: '/', hand: null }]);
    default: return [];
  }
}

function keyLine(move, features) {
  const ks = keysFor(move, features);
  const k = (x) => `<kbd>${x.key}</kbd>${x.hand ? ` <span class="hand">(${x.hand})</span>` : ''}`;
  switch (move) {
    case 'guard': return `hold ${k(ks[0])} for 2 s`;
    case 'rise': return `you’re down: hold ${k(ks[0])} until the ring fills`;
    case 'body': return `hold <kbd>Shift</kbd> with ${ks.slice(1).map((x) => `<kbd>${x.key}</kbd>`).join(' / ')}`;
    case 'duck': return `hold ${ks.map((x) => `<kbd>${x.key}</kbd>`).join(' or ')} under her Swing Bridge`;
    case 'parry': return `tap ${ks.map(k).join(' / ')} as her jab comes, on her punching side`;
    case 'slip': return `hold ${ks.map(k).join(' / ')} as her jab comes`;
    default: return ks.map(k).join(' / ');
  }
}

/** Training navigation keys (D14 §15.5) from PD's TRAINING_KEYMAP in shared/keymap.js. */
function navKeys() {
  const k = KM.TRAINING_KEYMAP ?? {};
  return {
    next: k.next ?? 'Enter', overlay: k.menu ?? 'Esc', repeat: k.repeat ?? 'R', back: k.back ?? 'Backspace',
    match: k.startMatch ?? 'M', close: k.close ?? 'Esc',
  };
}

const ITEM_NAME = { lesson: 'Lesson', mitt: 'Mitt drill', defence: 'Defence drill', sparring: 'Free sparring', start_match: 'Start match' };

/** Kind of the current item ('lesson' | 'mitt' | 'defence' | 'sparring' | 'start_match') from PD's TrainingState. */
function itemKind(tr) {
  const it = tr.items?.[tr.index];
  if (it?.kind) return it.kind;
  return String(tr.item ?? '').split(':')[0];
}

/** The live meter signal for a lesson move, from frame.meter (camera). */
function meterSignal(hand, move) {
  if (!hand) return null;
  if (move === 'guard' || move === 'rise') {
    const g = hand.guard;
    return g ? { value: g.inZone ? 1 : 0, threshold: 0.5, reason: g.reason } : null;
  }
  return hand[move] ?? null;
}

const STEP_NAME = { guard: 'Guard her Swing Bridges', interrupt: 'Interrupt the Anchor Drop with a straight', parry: 'Parry her jabs', counter: 'Counter in the opening', slip_duck: 'Slip the jabs, duck the Swing Bridges' };

export function createTrainingHud(wrap) {
  const root = el('div', 'tr', `
    <div class="tr-card">
      <div class="tr-head"><span class="tr-kicker"></span><span class="tr-reps"></span></div>
      <h2 class="tr-title"></h2>
      <p class="tr-line"></p>
      <div class="tr-demo"></div>
      <div class="tr-pips"></div>
    </div>
    <div class="tr-call" hidden><div class="tr-call-n"></div><div class="tr-call-text"></div><div class="tr-call-bar"><i></i></div></div>
    <div class="tr-feedback"></div>
    <div class="tr-meter" hidden>
      <div class="m left"><i class="v"></i><i class="th"></i><span>L</span></div>
      <div class="m right"><i class="v"></i><i class="th"></i><span>R</span></div>
    </div>
    <div class="tr-timing" hidden><div class="bar"><i class="win"></i><i class="mark"></i></div><span></span></div>
    <div class="tr-tally" hidden></div>
    <div class="tr-nav"></div>
    <div class="tr-overlay" hidden></div>
    <div class="tr-result" hidden></div>`);
  root.hidden = true;
  wrap.appendChild(root);
  const $ = (q) => root.querySelector(q);
  const R = {
    card: $('.tr-card'), kicker: $('.tr-kicker'), reps: $('.tr-reps'), title: $('.tr-title'), line: $('.tr-line'),
    demo: $('.tr-demo'), pips: $('.tr-pips'), call: $('.tr-call'), callN: $('.tr-call-n'), callText: $('.tr-call-text'),
    callBar: $('.tr-call-bar i'), feedback: $('.tr-feedback'), meter: $('.tr-meter'), mL: $('.tr-meter .left'),
    mR: $('.tr-meter .right'), timing: $('.tr-timing'), tWin: $('.tr-timing .win'), tMark: $('.tr-timing .mark'),
    tText: $('.tr-timing span'), tally: $('.tr-tally'), nav: $('.tr-nav'), overlay: $('.tr-overlay'), result: $('.tr-result'),
  };
  const cache = new Map();
  const set = (k, fn, v) => {
    if (cache.get(k) === v) return;
    cache.set(k, v);
    fn(v);
  };

  let feedback = null; // {t, html, cls}
  let timing = null; // {t, earlyMs, lateMs, windowMs}
  let result = null; // training_result
  let callT = null; // when the current call started (for the call bar)
  let lastNearMiss = { left: null, right: null }; // {value, threshold, reason, t} (for too_slow %)
  const completed = new Set(); // BUG-012: item ids with a training_result this session (skipped items stay ·)

  function showFeedback(t, html, cls) {
    feedback = { t, html, cls };
  }

  return {
    /** @returns {string[]} responses (for the renderer's event coverage) */
    handle(e, state) {
      const t = e.t;
      switch (e.type) {
        case 'training_rep': {
          const handName = e.hand ? `${cap(e.hand)} ` : '';
          if (e.ok) {
            const name = e.move === 'body' || e.move === 'guard' || e.move === 'parry' || e.move === 'rise' || !e.hand
              ? MOVE_NAME[e.move] ?? cap(e.move ?? '') : `${handName}${e.move}`;
            const power = Number.isFinite(e.power) ? ` · power ${pct(e.power)}` : '';
            showFeedback(t, `<b class="tick">✓</b> ${name}${power}`, 'ok');
          } else if (e.got) {
            // a different move committed: "That was a left hook. A straight goes straight out, toward her."
            const want = state.training?.lesson ?? e.move;
            const gotName = e.got === 'body' ? 'body shot' : e.got;
            showFeedback(t, `That was a ${e.hand ? `${e.hand} ` : ''}<b>${gotName}</b>. ${RIGHT_WAY[want] ?? ''}`.trim(), 'wrong');
          } else if (e.reason) {
            const nm = lastNearMiss[e.hand] && lastNearMiss[e.hand].reason === e.reason ? lastNearMiss[e.hand] : {};
            const known = nearMissText({ reason: e.reason, kind: e.move, hand: e.hand, value: e.value ?? nm.value, threshold: e.threshold ?? nm.threshold });
            const tm = timingText(e);
            showFeedback(t, `${known}${tm ? `: ${tm}` : ''}`, 'miss');
          }
          if (Number.isFinite(e.earlyMs) || Number.isFinite(e.lateMs)) {
            timing = { t, earlyMs: e.earlyMs ?? 0, lateMs: e.lateMs ?? 0, windowMs: e.windowMs ?? 237 };
          }
          return ['feedback'];
        }
        case 'near_miss': // the input event, if it reaches the view (keeps value/threshold for the percentage)
          if (e.hand) lastNearMiss[e.hand] = { ...e };
          showFeedback(t, nearMissText(e), 'miss');
          return ['feedback'];
        case 'training_call':
          callT = t;
          return ['call'];
        case 'training_result':
          result = { ...e };
          if (e.item) completed.add(e.item);
          return ['result'];
        case 'training_item':
          feedback = timing = result = callT = null;
          return ['card'];
        default:
          return [];
      }
    },

    /** Near misses arrive as input events in sampled frames; renderer passes them through here. */
    noteNearMiss(nm) {
      if (nm?.hand) lastNearMiss[nm.hand] = { ...nm };
    },

    reset() {
      feedback = timing = result = callT = null;
      lastNearMiss = { left: null, right: null };
      completed.clear();
      cache.clear();
    },

    update(state, frame, camera) {
      const tr = state.training;
      const on = state.phase === 'training' && !!tr;
      set('on', (v) => { root.hidden = !v; }, on);
      if (!on) return;
      const now = state.time;
      const f = featuresOf(frame, state);
      const nav = navKeys();
      const kind = itemKind(tr);
      const move = kind === 'lesson' ? tr.lesson : null;
      const lessons = (tr.items ?? []).filter((i) => i.kind === 'lesson');
      const lessonPos = lessons.findIndex((i) => i.id === tr.item);

      // card
      const kicker = kind === 'lesson' ? `Lesson ${lessonPos + 1}${lessons.length ? ` of ${lessons.length}` : ''}` : ITEM_NAME[kind] ?? '';
      set('kicker', (v) => { R.kicker.textContent = v; }, kicker);
      set('title', (v) => { R.title.textContent = v; }, move ? MOVE_NAME[move] ?? cap(move) : ITEM_NAME[kind] ?? '');
      const line = move ? (camera ? CAM_LINE[move] ?? '' : keyLine(move, f)) : kind === 'mitt'
        ? (camera ? 'Throw the shot she calls. You have 2.5 s for each.' : 'Press the key for the shot she calls. You have 2.5 s for each.')
        : kind === 'defence' ? (tr.step ? `${STEP_NAME[tr.step] ?? cap(tr.step)}. Slow attacks, no damage.` : 'Slow attacks, no damage.')
          : kind === 'sparring' ? 'Round 1 rules, no damage, no clock. Stamina is on.' : '';
      set('line', (v) => { R.line.innerHTML = v; }, line);
      const demo = !move ? '' : camera ? '<span class="ghost-cap">Watch the ghost glove</span>'
        : `<span class="keys">${keysFor(move, f).map((k, i) => `<kbd class="glow" data-hand="${k.hand ?? ''}" style="animation-delay:${i * 0.6}s">${k.key}</kbd>`).join('')}</span>`;
      set('demo', (v) => { R.demo.innerHTML = v; }, demo);
      const needed = tr.needed ?? 0;
      const reps = tr.reps ?? 0;
      set('reps', (v) => { R.reps.textContent = v; }, needed ? `${Math.min(reps, needed)} / ${needed}` : '');
      const pips = needed ? Array.from({ length: needed }, (_, i) => `<i class="${i < reps ? 'on' : ''}"></i>`).join('') : '';
      const hands = tr.perHand && move && !['guard', 'rise', 'duck'].includes(move)
        ? `<span class="hands">L ${tr.perHand.left ?? 0} · R ${tr.perHand.right ?? 0}</span>` : '';
      const done = tr.complete ? '<span class="done">Done ✓</span>' : '';
      set('pips', (v) => { R.pips.innerHTML = v; }, pips + hands + done);
      set('cardHidden', (v) => { R.card.hidden = v; }, kind === 'start_match' || !!(result && kind !== 'lesson'));

      // mitt drill call (state.training.call {shot, until})
      const callOn = kind === 'mitt' && tr.call?.shot && !result;
      set('callHidden', (v) => { R.call.hidden = v; }, !callOn);
      if (callOn) {
        set('callN', (v) => { R.callN.textContent = v; }, `Call ${Math.min(reps + 1, needed || 10)} of ${needed || 10}`);
        set('callText', (v) => { R.callText.textContent = v; }, `${shotName(tr.call.shot)}!`);
        const until = Number.isFinite(tr.call.until) ? tr.call.until : now + 2.5;
        R.callBar.style.width = pct((until - now) / 2.5);
      }

      // feedback (fades after 2.5 s)
      const fbOn = feedback && !tr.overlay && now - feedback.t >= 0 && now - feedback.t < 2.5;
      set('fb', (v) => {
        R.feedback.className = `tr-feedback ${v ? feedback.cls : ''}`;
        R.feedback.innerHTML = v ? feedback.html : '';
      }, fbOn ? `${feedback.t}|${feedback.html}` : '');

      // live per-hand meter (frame.meter: camera signals vs thresholds; keyboard: the held key per hand)
      const meter = frame?.meter;
      const meterOn = !!meter && meter.kind === 'camera' && !!move && camera && !tr.overlay;
      set('meterHidden', (v) => { R.meter.hidden = v; }, !meterOn);
      if (meterOn) {
        for (const [side, node] of [['left', R.mL], ['right', R.mR]]) {
          const m = meterSignal(meter[side], move);
          node.classList.toggle('na', !m);
          if (!m) continue;
          const top = Math.max(m.threshold * 1.6, m.value, 1e-6);
          node.querySelector('.v').style.height = pct(m.value / top);
          node.querySelector('.th').style.bottom = pct(m.threshold / top);
          node.classList.toggle('over', m.value >= m.threshold);
        }
      }
      if (!camera && move) { // keyboard: the demo keys light while that hand's key is held
        for (const k of R.demo.querySelectorAll('kbd')) {
          const h = k.dataset.hand;
          const pressed = meter?.kind === 'keyboard'
            ? (h ? meter[h]?.pressed : meter.left?.pressed ?? meter.right?.pressed)
            : null;
          k.classList.toggle('pressed', !!pressed && (pressed === move || (move === 'rise' && pressed === 'guard')));
        }
      }

      // timing bar
      const tOn = timing && now - timing.t < 2.5;
      set('timingHidden', (v) => { R.timing.hidden = v; }, !tOn);
      if (tOn) {
        const span = timing.windowMs * 3;
        const off = timing.earlyMs > 0 ? -timing.earlyMs : timing.lateMs > 0 ? timing.windowMs + timing.lateMs : timing.windowMs / 2;
        R.tWin.style.left = pct(timing.windowMs / span);
        R.tWin.style.width = pct(timing.windowMs / span);
        R.tMark.style.left = pct((timing.windowMs + off) / span);
        R.tMark.className = `mark ${timing.earlyMs > 0 ? 'early' : timing.lateMs > 0 ? 'late' : 'in'}`;
        R.tText.textContent = timing.earlyMs > 0 ? `early by ${Math.round(timing.earlyMs)} ms` : timing.lateMs > 0 ? `late by ${Math.round(timing.lateMs)} ms` : 'in the window';
      }

      // sparring tally {hits, blocks, counters}
      const tal = tr.tally;
      set('tally', (v) => { R.tally.hidden = !v; R.tally.textContent = v; }, kind === 'sparring' && tal
        ? `Hits ${tal.hits ?? 0} · Blocks ${tal.blocks ?? 0} · Counters ${tal.counters ?? 0}` : '');

      // navigation hint line (active input form)
      const canNext = tr.complete || kind !== 'lesson';
      const navLine = tr.overlay || result ? '' : camera
        ? `${canNext ? '✊✊ Hold guard: next · ' : ''}✋✋ Open hands: menu`
        : `${canNext ? `<kbd>${nav.next}</kbd> next · ` : ''}<kbd>${nav.overlay}</kbd> menu`;
      set('nav', (v) => { R.nav.innerHTML = v; }, navLine);

      // result card
      const resOn = !!result && !tr.overlay;
      set('resHidden', (v) => { R.result.hidden = v; }, !resOn);
      if (resOn) set('res', (v) => { R.result.innerHTML = v; }, resultHTML(result, tr, camera, nav));

      // overlay: the training menu + selectors
      set('ovHidden', (v) => { R.overlay.hidden = v; }, !tr.overlay);
      if (tr.overlay) set('ov', (v) => { R.overlay.innerHTML = v; }, overlayHTML(tr, camera, nav, state, completed));
    },

    debug() {
      return {
        on: !root.hidden, title: R.title.textContent, line: R.line.textContent.replace(/\s+/g, ' ').trim(),
        reps: R.reps.textContent, feedback: R.feedback.textContent.replace(/\s+/g, ' ').trim(),
        call: R.call.hidden ? null : R.callText.textContent, meter: !R.meter.hidden, timing: R.timing.hidden ? null : R.tText.textContent,
        overlay: R.overlay.hidden ? null : [...R.overlay.querySelectorAll('li')].map((li) => li.textContent.replace(/\s+/g, ' ').trim()).join(' | '),
        result: R.result.hidden ? null : R.result.textContent.replace(/\s+/g, ' ').trim(),
        nav: R.nav.textContent.replace(/\s+/g, ' ').trim(), demo: R.demo.textContent.replace(/\s+/g, ' ').trim(),
        kicker: R.kicker.textContent, tally: R.tally.hidden ? null : R.tally.textContent,
      };
    },
  };
}

/** The most common recent mistake, in words, from state.training.results (newest last). */
function commonMistake(results) {
  const counts = new Map();
  for (const r of results ?? []) {
    if (r.ok) continue;
    const k = r.got ? `${r.move ? `${MOVE_NAME[r.move] ?? r.move} thrown as a ` : ''}${r.got}` : r.reason ? nearMissText({ reason: r.reason, kind: r.move, hand: r.hand }) : null;
    if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  let best = null;
  for (const [k, n] of counts) if (!best || n > best[1]) best = [k, n];
  return best ? best[0] : null;
}

function resultHTML(r, tr, camera, nav) {
  const per = r.perMove ? Object.entries(r.perMove) : [];
  const chips = per.map(([m, sc]) => `<span class="${sc >= 0.8 ? 'ok' : 'miss'}">${sc >= 0.8 ? '✓' : '✕'} ${MOVE_NAME[m] ?? cap(m)} ${pct(sc)}</span>`).join('');
  const mistake = commonMistake(tr?.results);
  const ok = tr?.score ? ` · ${tr.score.ok} of ${tr.score.of}` : '';
  const kindName = ITEM_NAME[String(r.item ?? '').split(':')[0]] ?? 'Result';
  const next = camera ? '✊✊ Hold guard: next · ✋✋ Open hands: menu' : `<kbd>${nav.next}</kbd> next · <kbd>${nav.overlay}</kbd> menu (<kbd>${nav.repeat}</kbd> repeat)`;
  return `
    <h2>${kindName}</h2>
    <p class="tr-score"><b>${pct(r.score ?? 0)}</b> accuracy${ok}</p>
    ${chips ? `<div class="shots">${chips}</div>` : ''}
    ${mistake ? `<p class="mistake">Most common mistake: ${mistake}</p>` : ''}
    <p class="tr-res-nav">${next}</p>`;
}

function overlayHTML(tr, camera, nav, state, completed) {
  const mastered = new Set(state.mastered ?? []);
  const rows = (tr.items ?? []).map((it, i) => {
    const name = it.kind === 'lesson' ? MOVE_NAME[it.move] ?? cap(it.move) : ITEM_NAME[it.kind] ?? it.id;
    const isM = it.kind === 'lesson' && mastered.has(it.move);
    // ✓ only for an item that produced a training_result this session (BUG-012); skipped items stay ·
    const mark = isM ? '<b class="mastered">★</b>' : completed.has(it.id) ? '<b class="done">✓</b>' : '<b class="todo">·</b>';
    return `<li class="${i === tr.index ? 'current' : ''}">${mark} <span>${name}</span>${isM ? ' <em>mastered</em>' : ''}</li>`;
  }).join('');
  const sel = camera
    ? `<li><b>Right straight</b> repeat</li><li><b>Left straight</b> back</li><li><b>Either hook</b> start match</li><li><b>✊✊ Hold guard</b> close</li>`
    : `<li><kbd>${nav.repeat}</kbd> repeat</li><li><kbd>${nav.back}</kbd> back</li><li><kbd>${nav.match}</kbd> start match</li><li><kbd>${nav.close}</kbd> close</li>`;
  return `<h2>Training</h2><ol class="tr-menu">${rows}</ol><ul class="tr-sel">${sel}</ul>`;
}

