// view/hud.js — the DOM HUD inside #hud (owner: TA). Reads state, the peeked InputFrame and events; never
// mutates either. Buttons send SimCommands through the renderer's onCommand callback.
//   top: player HP + stamina (left), round + timer (centre), Tamsin's HP (right), knockdown pips under each name
//   corners: one tracking pip per hand (grey = not seen, outline = open, filled = fist, gold = guard on)
//   centre: 3-2-1, FIGHT!, COUNTER!, GUARD BROKEN, knockdown label + count; small callouts below it
//   cards: practice, rest (with the step-back hint), result, calibration (skeleton, hint, meter), pause, reconnect

const HINTS = {
  show_both_fists: 'Show both fists to the camera',
  move_closer: 'Move a little closer',
  move_back: 'Move back a step',
  hold_guard: 'Raise your guard and hold it',
  hold_still: 'Hold still',
  throw_straight: 'Throw a straight, any hand',
  not_seen: "Can't see your hands",
  return_to_spot: 'Step back to your spot',
};
const STEP_TITLE = {
  framing: 'Find your spot',
  guard: 'Guard up',
  straights: 'Throw 3 straights',
  done: 'All set',
};
const HAND_LINKS = [
  [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
];
const PAUSED_SUB = 'Paused. Press P to resume';
const ATTACK_NAME = { rope_snap: 'Rope Snap', swing_bridge: 'Swing Bridge', anchor_drop: 'Anchor Drop' };

const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
};

function fmtClock(s) {
  const t = Math.max(0, Math.ceil(s - 1e-6));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

/**
 * @param {HTMLElement|null} root
 * @param {(cmd:object) => void} send
 */
export function createHud(root, send) {
  if (!root) {
    return { handle() { return false; }, update() {}, reset() {}, dispose() {}, debug: () => ({}) };
  }
  const wrap = el('div', 'hud');
  wrap.innerHTML = `
    <div class="hud-top">
      <div class="fighter player">
        <div class="name"><span>You</span><span class="kd"><i></i><i></i></span></div>
        <div class="bar hp"><div class="trail"></div><div class="fill"></div></div>
        <div class="bar sta"><div class="fill"></div><div class="cost"></div><span class="tag">Gassed</span></div>
      </div>
      <div class="clock"><div class="round">Round 1</div><div class="time">1:00</div></div>
      <div class="fighter opp">
        <div class="name"><span class="kd"><i></i><i></i></span><span class="full">Tamsin “Tugboat” Rourke</span><span class="short">Tamsin</span></div>
        <div class="bar hp"><div class="trail"></div><div class="fill"></div></div>
      </div>
    </div>
    <div class="hud-center"><div class="sub"></div><div class="big"></div></div>
    <div class="hud-callout"></div>
    <div class="hud-pip left"><i></i><span>L</span></div>
    <div class="hud-pip right"><span>R</span><i></i></div>
    <div class="hud-card" hidden></div>
    <div class="hud-calib" hidden>
      <h2></h2>
      <canvas width="320" height="240"></canvas>
      <p class="hint"></p>
      <div class="progress"><i></i></div>
      <div class="count"></div>
      <div class="meter" hidden><i class="val"></i><i class="thr"></i><span>Live punch speed</span></div>
      <button type="button" data-cmd="cancel">Cancel (Esc)</button>
    </div>
    <div class="hud-banner" hidden></div>`;
  root.appendChild(wrap);

  const $ = (sel) => wrap.querySelector(sel);
  const R = {
    top: $('.hud-top'),
    pHp: $('.player .hp .fill'), pTrail: $('.player .hp .trail'), pHpBar: $('.player .hp'),
    pSta: $('.player .sta .fill'), pStaBar: $('.player .sta'), pCost: $('.player .sta .cost'),
    pKd: wrap.querySelectorAll('.player .kd i'),
    oHp: $('.opp .hp .fill'), oTrail: $('.opp .hp .trail'),
    oKd: wrap.querySelectorAll('.opp .kd i'),
    round: $('.clock .round'), time: $('.clock .time'), clock: $('.clock'),
    center: $('.hud-center'), big: $('.hud-center .big'), sub: $('.hud-center .sub'),
    callout: $('.hud-callout'),
    pipL: $('.hud-pip.left'), pipR: $('.hud-pip.right'),
    card: $('.hud-card'), calib: $('.hud-calib'), banner: $('.hud-banner'),
    cH: $('.hud-calib h2'), cCanvas: $('.hud-calib canvas'), cHint: $('.hud-calib .hint'),
    cProg: $('.hud-calib .progress i'), cCount: $('.hud-calib .count'), cMeter: $('.hud-calib .meter'),
    cVal: $('.hud-calib .meter .val'), cThr: $('.hud-calib .meter .thr'),
  };
  const ctx2d = R.cCanvas.getContext('2d');

  wrap.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-cmd]');
    if (b) send({ type: b.dataset.cmd });
  });

  const cache = new Map();
  const set = (key, node, prop, value) => {
    if (cache.get(key) === value) return;
    cache.set(key, value);
    if (prop === 'text') node.textContent = value;
    else if (prop === 'html') node.innerHTML = value;
    else if (prop === 'class') node.className = value;
    else if (prop === 'hidden') node.hidden = value;
    else node.style[prop] = value;
  };

  let flash = null; // {t, text, sub, cls, dur}
  let callout = null; // {t, text, cls}
  let cost = null; // {t, from, to}
  const practiceLit = new Set();
  let cardKey = '';
  let lastCount = { key: '' };

  function setCenter(text, sub, cls, key) {
    if (cache.get('centerKey') === key) return;
    cache.set('centerKey', key);
    R.center.className = `hud-center ${cls}`;
    R.sub.textContent = sub;
    // a fresh node restarts the pop animation
    const big = el('div', 'big', '');
    big.textContent = text;
    R.big.replaceWith(big);
    R.big = big;
  }

  function practiceCard(state, frame) {
    const kb = frame?.source === 'keyboard';
    return `
      <h2>Practice</h2>
      <p class="lede">Tamsin holds the mitts. Nothing hurts yet.</p>
      <div class="chips">
        <span data-chip="straight">Straight</span><span data-chip="hook">Hook</span><span data-chip="guard">Guard</span>
      </div>
      <p class="safety">Punch the air, not the screen.</p>
      ${kb ? '<p class="keys"><kbd>F</kbd>/<kbd>J</kbd> straights · <kbd>D</kbd>/<kbd>K</kbd> hooks · hold <kbd>Space</kbd> to guard</p>' : ''}
      <div class="row"><span class="timer"></span><button type="button" data-cmd="skip_practice">Start the fight (Enter)</button></div>`;
  }

  function restCard(state) {
    const n = state.round.n;
    return `
      <h2>End of round ${n}</h2>
      <p class="lede">Rest. Shake out your arms and breathe.</p>
      <div class="score">
        <div><b>${Math.round(state.player.hp)}</b><span>Your HP</span></div>
        <div><b>${Math.round(state.player.points)}</b><span>Your points</span></div>
        <div><b>${Math.round(state.opponent.points)}</b><span>Tamsin's points</span></div>
        <div><b>${Math.round(state.opponent.hp)}</b><span>Tamsin's HP</span></div>
      </div>
      <p class="spot" hidden>Step back to your spot</p>
      <p class="next">Round ${Math.min(n + 1, state.round.of)} of ${state.round.of} starts <span class="rest-left"></span></p>`;
  }

  function resultCard(state) {
    const { winner, method } = state.result;
    const won = winner === 'player';
    const s = state.player.stats;
    const how = method === 'ko' ? 'by knockout' : 'on points';
    return `
      <h2 class="${won ? 'win' : 'loss'}">${won ? 'You win' : 'Tamsin wins'}</h2>
      <p class="lede">${how}${won ? '' : '. “Mind the wake!”'}</p>
      <div class="score">
        <div><b>${Math.round(state.player.points)}</b><span>Your points</span></div>
        <div><b>${Math.round(state.opponent.points)}</b><span>Tamsin's points</span></div>
        <div><b>${s.landed}/${s.thrown}</b><span>Landed</span></div>
        <div><b>${s.counters + s.interrupts}</b><span>Counters</span></div>
      </div>
      <div class="row"><button type="button" data-cmd="restart">Rematch (Enter)</button></div>`;
  }

  function drawSkeleton(cal) {
    const c = ctx2d;
    const W = R.cCanvas.width;
    const H = R.cCanvas.height;
    c.clearRect(0, 0, W, H);
    c.strokeStyle = 'rgba(255,214,140,0.45)';
    c.setLineDash([6, 6]);
    c.lineWidth = 2;
    c.strokeRect(W * 0.18, H * 0.2, W * 0.64, H * 0.62);
    c.setLineDash([]);
    const lm = cal.landmarks;
    if (!lm) {
      c.fillStyle = 'rgba(232,226,212,0.5)';
      c.font = '14px system-ui, sans-serif';
      c.textAlign = 'center';
      c.fillText('Waiting for your hands…', W / 2, H / 2);
      return;
    }
    for (const [side, color] of [['left', '#ffb347'], ['right', '#7fd1ff']]) {
      const pts = lm[side];
      if (!pts?.length) continue;
      c.strokeStyle = color;
      c.lineWidth = 3;
      c.beginPath();
      for (const [a, b] of HAND_LINKS) {
        if (!pts[a] || !pts[b]) continue;
        c.moveTo(pts[a][0] * W, pts[a][1] * H);
        c.lineTo(pts[b][0] * W, pts[b][1] * H);
      }
      c.stroke();
      c.fillStyle = '#fff';
      for (const p of pts) {
        c.beginPath();
        c.arc(p[0] * W, p[1] * H, 2.5, 0, Math.PI * 2);
        c.fill();
      }
    }
  }

  function updateCalib(cal) {
    set('calibH', R.cH, 'text', STEP_TITLE[cal.step] ?? 'Calibration');
    set('calibHint', R.cHint, 'text', cal.hint ? HINTS[cal.hint] ?? cal.hint : '');
    set('calibProg', R.cProg, 'width', `${Math.round((cal.progress ?? 0) * 100)}%`);
    const dots = cal.target ? Array.from({ length: cal.target }, (_, i) => `<i class="${i < cal.count ? 'on' : ''}"></i>`).join('') : '';
    set('calibCount', R.cCount, 'html', dots);
    const m = cal.meter;
    set('calibMeterHidden', R.cMeter, 'hidden', !m);
    if (m) {
      const scale = Math.max(m.threshold * 1.6, m.value, 1e-6);
      set('calibVal', R.cVal, 'width', `${Math.round((m.value / scale) * 100)}%`);
      set('calibThr', R.cThr, 'left', `${Math.round((m.threshold / scale) * 100)}%`);
      set('calibValCls', R.cVal, 'class', `val${m.value >= m.threshold ? ' over' : ''}`);
    }
    drawSkeleton(cal);
  }

  return {
    /** @returns {string[]} names of the responses produced for this event */
    handle(e, state) {
      const t = e.t;
      const out = [];
      switch (e.type) {
        case 'hit':
          if (e.interrupt) { flash = { t, text: 'COUNTER!', sub: 'Anchor Drop stopped', cls: 'counter', dur: 1.0 }; out.push('flash'); }
          else if (e.counter) { flash = { t, text: 'COUNTER!', sub: '', cls: 'counter', dur: 0.8 }; out.push('flash'); }
          out.push('bar');
          break;
        case 'guard_broken':
          flash = { t, text: 'GUARD BROKEN', sub: '', cls: 'broken', dur: 0.9 };
          out.push('flash');
          break;
        case 'round_start':
          flash = { t, text: 'FIGHT!', sub: `Round ${e.n}`, cls: 'fight', dur: 0.7 };
          out.push('flash');
          break;
        case 'round_end':
          out.push('card'); // the rest / result card replaces the fight HUD centre
          break;
        case 'knockdown':
          flash = { t, text: 'KNOCKDOWN', sub: e.who === 'player' ? 'You are down' : 'Tamsin is down', cls: 'kd', dur: 0.6 };
          out.push('flash');
          break;
        case 'count':
          out.push('count');
          break;
        case 'getup':
          callout = { t, text: e.who === 'player' ? 'Back on your feet' : 'She is up', cls: '' };
          out.push('callout');
          break;
        case 'blocked':
          if (e.by === 'opponent') {
            callout = { t, text: `Blocked  −${e.staminaCost} stamina`, cls: 'block' };
            cost = { t, from: state.player.stamina, to: state.player.stamina + e.staminaCost };
          } else {
            callout = { t, text: 'She blocked it', cls: 'muted' };
          }
          out.push('callout');
          break;
        case 'whiff':
          callout = { t, text: 'Miss', cls: 'muted' };
          out.push('callout');
          break;
        case 'gassed':
          callout = { t, text: 'Gassed! Guard up and breathe', cls: 'warn' };
          out.push('callout');
          break;
        case 'punch_rejected':
          callout = { t, text: 'Too tired to punch', cls: 'warn' };
          out.push('callout');
          break;
        case 'stagger':
          if (!e.interrupt) { callout = { t, text: 'Staggered', cls: '' }; out.push('callout'); }
          break;
        case 'opening':
          callout = { t, text: 'Opening! Counter now', cls: 'open' };
          out.push('callout');
          break;
        case 'telegraph':
          if (e.comboIndex === 0 || e.comboIndex === undefined) out.push('pose');
          break;
        case 'punch_thrown':
          if (state.phase === 'practice') { practiceLit.add(e.punchType); out.push('chip'); }
          break;
        case 'phase':
          if (e.to === 'practice') practiceLit.clear();
          out.push('card');
          break;
        case 'match_end':
          out.push('card');
          break;
        default:
          break;
      }
      return out;
    },

    reset() {
      flash = callout = cost = null;
      cache.clear();
      cardKey = '';
    },

    /**
     * @param {import('../shared/types.js').GameState} state
     * @param {import('../shared/types.js').InputFrame} frame
     */
    update(state, frame) {
      const now = state.time;
      const p = state.player;
      const o = state.opponent;
      const phase = state.phase;

      // bars
      const pct = (v, m) => `${Math.max(0, Math.min(100, (v / m) * 100)).toFixed(1)}%`;
      set('pHp', R.pHp, 'width', pct(p.hp, p.maxHp));
      set('pTrail', R.pTrail, 'width', pct(p.hp, p.maxHp));
      set('oHp', R.oHp, 'width', pct(o.hp, o.maxHp));
      set('oTrail', R.oTrail, 'width', pct(o.hp, o.maxHp));
      set('pSta', R.pSta, 'width', pct(p.stamina, p.maxStamina));
      const gassed = now < p.gassedUntil;
      set('pHpCls', R.pHpBar, 'class', `bar hp${p.lowHp ? ' low' : ''}`);
      set('pStaCls', R.pStaBar, 'class', `bar sta${p.fatigued ? ' fatigued' : ''}${gassed ? ' gassed' : ''}`);
      if (cost && now - cost.t < 0.6) {
        set('costL', R.pCost, 'left', pct(cost.from, p.maxStamina));
        set('costW', R.pCost, 'width', pct(Math.min(p.maxStamina, cost.to) - cost.from, p.maxStamina));
        set('costOp', R.pCost, 'opacity', '1');
      } else set('costOp', R.pCost, 'opacity', '0');
      R.pKd.forEach((i, n) => set(`pkd${n}`, i, 'class', n < p.knockdowns ? 'on' : ''));
      R.oKd.forEach((i, n) => set(`okd${n}`, i, 'class', n < o.knockdowns ? 'on' : ''));

      // clock
      const r = state.round;
      set('round', R.round, 'text', phase === 'practice' ? 'Practice' : `Round ${r.n} of ${r.of}`);
      const clockS = phase === 'practice' ? state.practice?.timeLeft ?? 0 : r.timeLeft;
      set('time', R.time, 'text', fmtClock(clockS));
      set('clockCls', R.clock, 'class', `clock${r.timeLeft <= 10 && r.clockRunning ? ' urgent' : ''}${!r.clockRunning && phase === 'fight' ? ' stopped' : ''}`);

      // tracking pips
      for (const [side, node] of [['left', R.pipL], ['right', R.pipR]]) {
        const h = frame?.hands?.[side];
        const guard = frame?.guard?.[side] && frame?.guard?.level === 'full';
        const cls = !h?.present ? 'none' : guard ? 'guard' : h.fist ? 'fist' : 'open';
        set(`pip-${side}`, node, 'class', `hud-pip ${side} ${cls}`);
      }

      // centre text: knockdown count > pre-round countdown > timed flash
      const down = p.down ? 'player' : o.down ? 'opponent' : null;
      if (down && phase !== 'match_end') { // the result card takes over after a KO
        const d = state[down].down;
        const ko = state[down].knockdowns >= 2;
        const label = down === 'player' ? (ko ? 'You are down. Second knockdown' : 'You are down') : (ko ? 'Tamsin is down. Second knockdown' : 'Tamsin is down');
        const paused = state.paused;
        if (d.count > 0) {
          setCenter(String(d.count), paused ? PAUSED_SUB : label, `count ${down}`, `down-${down}-${d.count}-${paused}`);
        } else { // GDD §7: "KNOCKDOWN" until the count starts
          setCenter('KNOCKDOWN', paused ? PAUSED_SUB : label, 'kd', `down-${down}-0-${paused}`);
        }
      } else if (phase === 'fight' && r.countdown !== null && r.countdown > 0) {
        const paused = state.paused;
        setCenter(String(r.countdown), paused ? PAUSED_SUB : `Round ${r.n}`, 'countdown', `cd-${r.n}-${r.countdown}-${paused}`);
      } else if (state.paused && phase !== 'boot') {
        setCenter('Paused', 'Press P to resume', 'paused', 'paused');
      } else if (flash && now - flash.t >= 0 && now - flash.t < flash.dur) {
        setCenter(flash.text, flash.sub, flash.cls, `flash-${flash.t}-${flash.text}`);
      } else {
        setCenter('', '', '', 'none');
      }

      // callout
      if (callout && now - callout.t >= 0 && now - callout.t < 1.1) {
        if (cache.get('calloutKey') !== callout.t + callout.text) {
          cache.set('calloutKey', callout.t + callout.text);
          const c = el('div', `hud-callout show ${callout.cls}`);
          c.textContent = callout.text;
          R.callout.replaceWith(c);
          R.callout = c;
        }
      } else if (cache.get('calloutKey') !== 'none') {
        cache.set('calloutKey', 'none');
        R.callout.className = 'hud-callout';
      }

      // cards
      let key = '';
      if (phase === 'practice') key = `practice-${frame?.source}`;
      else if (phase === 'round_end') key = `rest-${r.n}-${Math.round(p.hp)}-${Math.round(o.hp)}`;
      else if (phase === 'match_end') key = `result-${state.result.winner}-${state.result.method}`;
      if (key !== cardKey) {
        cardKey = key;
        R.card.hidden = !key;
        R.card.className = `hud-card ${key.split('-')[0]}`;
        R.card.innerHTML = !key ? '' : phase === 'practice' ? practiceCard(state, frame) : phase === 'round_end' ? restCard(state) : resultCard(state);
      }
      if (phase === 'practice') {
        const timer = R.card.querySelector('.timer');
        if (timer) timer.textContent = `${Math.ceil(state.practice?.timeLeft ?? 0)} s`;
        if (p.guard === 'full' || frame?.guard?.level === 'full') practiceLit.add('guard');
        for (const chip of R.card.querySelectorAll('[data-chip]')) chip.classList.toggle('lit', practiceLit.has(chip.dataset.chip));
      } else if (phase === 'round_end') {
        const spot = R.card.querySelector('.spot');
        if (spot) spot.hidden = frame?.spot?.hint !== 'return_to_spot';
        // round.restLeft is filled by the real sim; it may be null (e.g. the stub), then the line just says "soon"
        const left = R.card.querySelector('.rest-left');
        const rl = state.round.restLeft;
        if (left) left.textContent = Number.isFinite(rl) ? `in ${Math.max(0, Math.ceil(rl - 1e-6))} s` : 'soon';
      }

      // calibration HUD
      const calOn = phase === 'calibration';
      set('calibHidden', R.calib, 'hidden', !calOn);
      if (calOn && frame?.calibration) updateCalib(frame.calibration);

      // reconnect banner (camera only)
      const lost = frame?.tracking?.ok === false && frame?.source === 'camera';
      set('bannerHidden', R.banner, 'hidden', !lost);
      if (lost) set('banner', R.banner, 'text', 'Camera lost. Reconnecting…');
    },

    /** For tests: what the HUD is showing right now. */
    debug() {
      return {
        center: R.big.textContent, sub: R.sub.textContent, callout: R.callout.textContent,
        card: cardKey, calib: !R.calib.hidden,
      };
    },

    dispose() {
      wrap.remove();
    },
  };
}

export { ATTACK_NAME };
