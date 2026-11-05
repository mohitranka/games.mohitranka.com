// view/renderer.js — createRenderer(): three.js setup, the presentation clock and the per-frame update
// (owner: TA; API in architecture §3.8). The view reads GameState, events and the peeked InputFrame; it never
// mutates them. Hit-stop slows only the presentation clock; the sim always runs in real time (D4).

import * as THREE from 'three';
import { SIM_DT } from '../shared/constants.js';
import { tuning } from './tuning.js';
import { createRing, createLights, makeGlowTexture } from './ring.js';
import { createOpponentModel } from './opponent-model.js';
import { computeOpponentPose } from './opponent-anim.js';
import { createGloves } from './gloves.js';
import { createPresentationClock, createShake, createVignette, createParticles } from './fx.js';
import { createHud } from './hud.js';

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (x) => Math.max(0, Math.min(1, x));

/**
 * @param {{canvas:HTMLCanvasElement, hudRoot:HTMLElement|null}} opts
 * @returns {import('../shared/types.js').Renderer & {debug():object}}
 */
export function createRenderer({ canvas, hudRoot }) {
  const gl = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance',
    preserveDrawingBuffer: /[?&]test=1/.test(location.search) });
  gl.setPixelRatio(Math.min(window.devicePixelRatio || 1, tuning.pixelRatioMax));
  gl.outputColorSpace = THREE.SRGBColorSpace;
  gl.toneMapping = THREE.ACESFilmicToneMapping;
  gl.toneMappingExposure = 1.05;
  gl.shadowMap.enabled = false;

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(tuning.colors.fog, 18, 120);
  const camera = new THREE.PerspectiveCamera(tuning.fov, 16 / 9, 0.05, 400);
  scene.add(camera);

  const glowTex = makeGlowTexture();
  const ring = createRing(glowTex);
  scene.add(ring.group, createLights());
  const tamsin = createOpponentModel(glowTex);
  scene.add(tamsin.root);
  const gloves = createGloves(camera);
  const particles = createParticles(glowTex);
  scene.add(particles.points);

  // impact flash at her head
  const impact = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTex, color: 0xfff1c9, transparent: true, opacity: 0, depthWrite: false, depthTest: false,
    blending: THREE.AdditiveBlending,
  }));
  impact.renderOrder = 15;
  scene.add(impact);

  let send = () => {};
  const hud = createHud(hudRoot, (cmd) => send(cmd));
  const pres = createPresentationClock();
  const shake = createShake();
  const vignette = createVignette(hudRoot);

  const ctx = { lastHit: null, lastBlock: null, lastPunch: null };
  let impactT = -Infinity;
  let impactScale = 0.4;
  let lastSimTime = -1;
  let size = { w: 1280, h: 720 };
  let last = { presTime: 0, frozen: false, pose: null };
  const responses = {}; // event type → number of visual responses (tests)
  const fps = { frames: 0, t0: performance.now(), value: 0 };
  const _head = new THREE.Vector3();
  const _dir = new THREE.Vector3();
  const eye = new THREE.Vector3();
  const look = new THREE.Vector3();

  function note(type, what) {
    if (!what || (Array.isArray(what) && !what.length)) return;
    responses[type] = (responses[type] ?? 0) + 1;
  }

  function resetAll() {
    pres.reset();
    shake.reset();
    vignette.reset();
    particles.reset();
    gloves.reset();
    hud.reset();
    ctx.lastHit = ctx.lastBlock = ctx.lastPunch = null;
    impactT = -Infinity;
  }

  /** One-shot responses. Everything is keyed to the event's sim time `e.t`. */
  function onEvent(e, state) {
    const V = tuning;
    const got = [];
    switch (e.type) {
      case 'hit': {
        const p = clamp01(e.power ?? 0.6);
        const dur = e.counter || e.interrupt ? V.hitStopCounterS : lerp(V.hitStopS[0], V.hitStopS[1], p);
        pres.hitStop(e.t, dur);
        shake.kick(e.t, lerp(V.kickPx[0], V.kickPx[1], p));
        ctx.lastHit = { t: e.t, hand: e.hand, punchType: e.punchType };
        tamsin.headWorld(_head);
        _dir.set(e.hand === 'left' ? 1 : -1, 0.3, -1);
        particles.burst(e.t, _head, _dir, e.counter || e.interrupt ? 22 : 12, e.counter || e.interrupt ? 0xffd36b : 0xffe6c4, 2.4);
        particles.burst(e.t, _head, _dir, 8, 0x9fd6ff, 1.6, 0.6); // sweat
        impactT = e.t;
        impactScale = 0.35 + 0.35 * p + (e.counter || e.interrupt ? 0.3 : 0);
        got.push('hitstop', 'sparks');
        break;
      }
      case 'player_hit': {
        const tier = Math.max(1, Math.min(3, e.shakeTier ?? 1));
        shake.shake(e.t, V.shakePx[tier], V.shakeS[tier]);
        vignette.hit(e.t, 0.35 + 0.2 * tier);
        pres.hitStop(e.t, V.hitStopTakenS);
        got.push('shake', 'vignette');
        break;
      }
      case 'blocked':
        if (e.by === 'player') {
          ctx.lastBlock = { t: e.t, hand: e.hand };
          tamsin.gloveWorld(e.hand === 'left' ? 'right' : 'left', _head);
          particles.burst(e.t, _head, _dir.set(0, 0.5, 1), 6, 0xffffff, 1.2, 0.25);
        } else {
          shake.shake(e.t, 2 + (e.staminaCost ?? 0) / 8, 0.12);
          vignette.flash(e.t, 'rgba(255,255,255,0.6)');
        }
        got.push('jolt');
        break;
      case 'guard_broken':
        shake.shake(e.t, 10, 0.3);
        vignette.flash(e.t, 'rgba(255,60,40,0.8)');
        got.push('gloves-down');
        break;
      case 'strike':
        // impact frame: a short white pop on the screen edge, before the outcome lands
        vignette.flash(e.t, e.attack === 'anchor_drop' ? 'rgba(255,90,60,0.5)' : 'rgba(255,240,220,0.35)');
        got.push('pose', 'flash');
        break;
      case 'telegraph':
        got.push('pose', 'glow');
        break;
      case 'stagger':
      case 'opening':
      case 'getup':
      case 'knockdown':
        got.push('pose');
        if (e.type === 'knockdown') shake.shake(e.t, 6, 0.3);
        break;
      case 'punch_thrown':
        ctx.lastPunch = { t: e.t, hand: e.hand, punchType: e.punchType };
        break;
      case 'whiff':
        got.push('gloves');
        break;
      case 'gassed':
        got.push('haze');
        break;
      default:
        break;
    }
    if (gloves.onEvent(e)) got.push('gloves');
    got.push(...hud.handle(e, state));
    note(e.type, got);
  }

  function placeCamera(state, now, sh) {
    eye.set(...tuning.eye);
    look.set(...tuning.lookAt);
    // knocked down: the view drops and rolls; it rises again on the get-up
    const p = state.player;
    if (p.down) {
      const a = clamp01((now - p.down.since) / 0.5);
      const k = 1 - (1 - a) ** 2;
      eye.y -= 0.9 * k;
      eye.z += 0.25 * k;
      look.y -= 0.3 * k;
      camera.up.set(Math.sin(0.35 * k), Math.cos(0.35 * k), 0);
    } else {
      camera.up.set(0, 1, 0);
    }
    // subtle breathing sway; heavier when gassed
    const gassed = state.time < p.gassedUntil;
    const sway = gassed ? 0.012 : 0.004;
    eye.x += sway * Math.sin(now * 1.3);
    eye.y += sway * Math.sin(now * 2.6);
    eye.z -= sh.kick;
    camera.position.copy(eye);
    camera.lookAt(look);
  }

  const api = {
    /**
     * @param {import('../shared/types.js').GameState} state
     * @param {import('../shared/types.js').GameEvent[]} events
     * @param {import('../shared/types.js').InputFrame} input
     * @param {number} alpha
     */
    update(state, events, input, alpha = 0) {
      if (state.time < lastSimTime - 0.5) resetAll(); // sim reset
      lastSimTime = state.time;
      for (const e of events) onEvent(e, state);

      const simNow = state.time + clamp01(alpha) * SIM_DT;
      const { presTime, frozen } = pres.resolve(simNow);

      last.presTime = presTime;
      last.frozen = frozen;
      if (!frozen) {
        last.pose = computeOpponentPose(state, presTime, ctx);
        tamsin.setPose(last.pose);
        gloves.update(state, input, presTime);
      }
      const o = state.opponent;
      const foghorn = o.attack === 'anchor_drop' && o.state === 'telegraph' ? 1 : 0;
      ring.update(presTime, foghorn);
      particles.update(presTime);

      const ia = simNow - impactT;
      if (ia >= 0 && ia < 0.12) {
        tamsin.headWorld(_head);
        impact.position.copy(_head).add(_dir.set(0, 0, 0.15));
        impact.material.opacity = 1 - ia / 0.12;
        impact.scale.setScalar(impactScale * (1 + ia * 4));
      } else impact.material.opacity = 0;

      const sh = shake.sample(simNow);
      placeCamera(state, presTime, sh);
      if (sh.x || sh.y) camera.setViewOffset(size.w, size.h, sh.x, sh.y, size.w, size.h);
      else camera.clearViewOffset();

      vignette.update(simNow, {
        lowHp: state.player.lowHp, gassed: state.time < state.player.gassedUntil, down: !!state.player.down,
      });
      hud.update(state, input);
      gl.render(scene, camera);

      fps.frames += 1;
      const t = performance.now();
      if (t - fps.t0 >= 1000) {
        fps.value = (fps.frames * 1000) / (t - fps.t0);
        fps.frames = 0;
        fps.t0 = t;
      }
    },
    resize(w, h) {
      size = { w: Math.max(1, w), h: Math.max(1, h) };
      gl.setSize(size.w, size.h, false);
      camera.aspect = size.w / size.h;
      // keep Tamsin framed on tall/narrow screens
      camera.fov = camera.aspect < 1 ? tuning.fov + 18 * (1 - camera.aspect) : tuning.fov;
      camera.updateProjectionMatrix();
      gloves.setAspect(camera.aspect);
    },
    onCommand(fn) {
      send = typeof fn === 'function' ? fn : () => {};
    },
    stats() {
      return { fps: fps.value, drawCalls: gl.info.render.calls, triangles: gl.info.render.triangles };
    },
    /** Test/debug only: responses per event type and what the HUD is showing. */
    debug() {
      const p = last.pose;
      return {
        responses: { ...responses }, hud: hud.debug(), vignette: vignette.value, gloves: gloves.debug(),
        presTime: last.presTime, frozen: last.frozen,
        pose: p && { lHand: p.lHand, rHand: p.rHand, lGlow: p.lGlow.amount, rGlow: p.rGlow.amount, fall: p.fall, mitts: p.mitts },
      };
    },
    dispose() {
      hud.dispose();
      vignette.dispose();
      gl.dispose();
    },
  };

  const params = new URLSearchParams(location.search);
  if (params.get('test') === '1' || params.get('debug') === '1') {
    window.__view = window.__view ?? {};
    window.__view.renderer = api;
  }
  return api;
}
