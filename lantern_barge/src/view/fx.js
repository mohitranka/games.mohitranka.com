// view/fx.js — hit-stop on the presentation clock, screen shake, camera kick, damage vignette and hit particles
// (owner: TA). Every effect is keyed to the SIM time of the event that started it and evaluated at the
// presentation time, so with the manual clock a frame is a pure function of state + event history (D4).

import * as THREE from 'three';
import { tuning } from './tuning.js';

const clamp01 = (x) => Math.max(0, Math.min(1, x));

/**
 * Presentation clock (architecture §3.8). presTime normally equals state.time + alpha·SIM_DT.
 * A hit-stop freezes it at the hit time for `dur`, then it catches back up to sim time within catchUpS.
 * The sim itself is never slowed.
 */
export function createPresentationClock() {
  let stop = null; // {t, dur}
  return {
    hitStop(t, dur) {
      if (!stop || t >= stop.t + stop.dur) stop = { t, dur };
      else stop.dur = Math.max(stop.dur, t - stop.t + dur * 0.5); // overlapping stops extend a little
    },
    reset() {
      stop = null;
    },
    /** @returns {{presTime:number, frozen:boolean, lag:number}} */
    resolve(simNow) {
      if (!stop) return { presTime: simNow, frozen: false, lag: 0 };
      const e = simNow - stop.t;
      const c = tuning.catchUpS;
      let lag = 0;
      let frozen = false;
      if (e < 0) lag = 0;
      else if (e < stop.dur) { lag = e; frozen = true; }
      else if (e < stop.dur + c) lag = stop.dur * (1 - (e - stop.dur) / c);
      else stop = null;
      return { presTime: simNow - lag, frozen, lag };
    },
  };
}

/** Screen shake (px, via camera.setViewOffset) and the forward camera kick. */
export function createShake() {
  const shakes = []; // {t, px, dur, seed}
  const kicks = []; // {t, px}
  return {
    shake(t, px, dur) {
      shakes.push({ t, px, dur, seed: Math.random() * 100 });
      if (shakes.length > 8) shakes.shift();
    },
    kick(t, px) {
      kicks.push({ t, px });
      if (kicks.length > 4) kicks.shift();
    },
    reset() {
      shakes.length = 0;
      kicks.length = 0;
    },
    /** @returns {{x:number, y:number, kick:number}} px offsets and kick metres */
    sample(now) {
      let x = 0;
      let y = 0;
      for (const s of shakes) {
        const a = now - s.t;
        if (a < 0 || a > s.dur) continue;
        const k = s.px * (1 - a / s.dur) ** 2;
        x += k * Math.sin(a * 71 + s.seed);
        y += k * Math.cos(a * 53 + s.seed * 1.7);
      }
      let kick = 0;
      for (const kk of kicks) {
        const a = now - kk.t;
        if (a < 0 || a > 0.2) continue;
        kick += kk.px * 0.01 * Math.sin(Math.PI * Math.min(1, a / 0.2)) * (a < 0.05 ? 1 : 1 - (a - 0.05) / 0.15);
      }
      return { x, y, kick };
    },
  };
}

/** Red damage vignette + a grey gassed haze, as two DOM layers inside #hud. */
export function createVignette(hudRoot) {
  const red = document.createElement('div');
  red.className = 'fx-vignette';
  const haze = document.createElement('div');
  haze.className = 'fx-haze';
  const flash = document.createElement('div');
  flash.className = 'fx-flash';
  hudRoot?.prepend(flash, haze, red);
  const hits = []; // {t, strength}
  let lastRed = -1;
  let lastHaze = -1;
  let lastFlash = -1;
  let flashT = -Infinity;
  let flashColor = '';
  return {
    hit(t, strength) {
      hits.push({ t, strength });
      if (hits.length > 6) hits.shift();
    },
    flash(t, color) {
      flashT = t;
      flashColor = color;
      flash.style.background = color;
    },
    reset() {
      hits.length = 0;
      flashT = -Infinity;
    },
    update(now, { lowHp, gassed, down }) {
      let v = 0;
      for (const h of hits) {
        const a = now - h.t;
        if (a >= 0 && a < tuning.vignetteS) v = Math.max(v, h.strength * (1 - a / tuning.vignetteS));
      }
      if (lowHp) v = Math.max(v, 0.28 + 0.1 * Math.sin(now * 5));
      if (down) v = Math.max(v, 0.55);
      v = Math.round(clamp01(v) * 100) / 100;
      if (v !== lastRed) { red.style.opacity = String(v); lastRed = v; }
      const hz = gassed ? 0.55 + 0.1 * Math.sin(now * 3) : down ? 0.5 : 0;
      const hzr = Math.round(hz * 100) / 100;
      if (hzr !== lastHaze) { haze.style.opacity = String(hzr); lastHaze = hzr; }
      const fa = now - flashT;
      const f = fa >= 0 && fa < 0.12 ? Math.round((1 - fa / 0.12) * 35) / 100 : 0;
      if (f !== lastFlash) { flash.style.opacity = String(f); lastFlash = f; }
    },
    get value() {
      return lastRed;
    },
    dispose() {
      red.remove();
      haze.remove();
      flash.remove();
    },
  };
}

/** Sparks and sweat: one Points draw call, ballistic paths evaluated from spawn time (no per-frame state). */
export function createParticles(glowTex, max = 96) {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(max * 3);
  const col = new Float32Array(max * 3);
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const mat = new THREE.PointsMaterial({
    size: 0.06, map: glowTex, vertexColors: true, transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.renderOrder = 5;
  const parts = []; // {t, p0, v, color, life}
  let next = 0;
  const c = new THREE.Color();
  return {
    points,
    /** Spray at `origin` (world), biased toward `dir`. */
    burst(t, origin, dir, count, color, speed = 2.2, life = 0.45) {
      c.setHex(color);
      for (let i = 0; i < count; i++) {
        const v = new THREE.Vector3(
          dir.x + (Math.random() - 0.5) * 1.6,
          dir.y + Math.random() * 1.1,
          dir.z + (Math.random() - 0.5) * 1.6,
        ).normalize().multiplyScalar(speed * (0.4 + Math.random() * 0.8));
        parts[next] = { t, p0: origin.clone(), v, r: c.r, g: c.g, b: c.b, life: life * (0.6 + Math.random() * 0.6) };
        next = (next + 1) % max;
      }
    },
    reset() {
      parts.length = 0;
      next = 0;
    },
    update(now) {
      for (let i = 0; i < max; i++) {
        const p = parts[i];
        const a = p ? now - p.t : -1;
        if (!p || a < 0 || a > p.life) {
          pos[i * 3 + 1] = -100;
          col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = 0;
          continue;
        }
        pos[i * 3] = p.p0.x + p.v.x * a;
        pos[i * 3 + 1] = p.p0.y + p.v.y * a - 4.9 * a * a;
        pos[i * 3 + 2] = p.p0.z + p.v.z * a;
        const k = 1 - a / p.life;
        col[i * 3] = p.r * k;
        col[i * 3 + 1] = p.g * k;
        col[i * 3 + 2] = p.b * k;
      }
      geo.attributes.position.needsUpdate = true;
      geo.attributes.color.needsUpdate = true;
    },
  };
}
