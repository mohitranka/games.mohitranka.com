// view/gloves.js — the player's first-person gloves (owner: TA). Children of the camera.
// Data sources (architecture §5.7):
//   frame.hands[h]  → x/y, depth (ext), fist vs open tint, lost-hand dim, early lead on punchPhase 'onset'
//   state.player    → guard snap, guard-broken drop, fatigue / gassed damping, knocked-down drop
//   events          → punch_thrown (extension for punches with no hand motion), blocks (jolt / bounce back)

import * as THREE from 'three';
import { tuning } from './tuning.js';

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const easeOut = (t) => 1 - (1 - t) ** 3;

function buildGlove(side) {
  const C = tuning.colors;
  const s = side === 'left' ? -1 : 1; // screen side
  const mat = new THREE.MeshLambertMaterial({ color: C.playerGlove, flatShading: true, transparent: true, opacity: 1 });
  const cuffMat = new THREE.MeshLambertMaterial({ color: C.playerCuff, flatShading: true, transparent: true, opacity: 1 });
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.056, 12, 9), mat);
  body.scale.set(1.05, 0.95, 1.3);
  body.position.z = -0.02;
  const knuckle = new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 7), mat);
  knuckle.scale.set(1.15, 0.9, 0.8);
  knuckle.position.set(0, 0.02, -0.07);
  const thumb = new THREE.Mesh(new THREE.SphereGeometry(0.026, 8, 6), mat);
  thumb.scale.set(1, 1, 1.6);
  thumb.position.set(-s * 0.055, -0.01, -0.035);
  const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.055, 0.075, 10), cuffMat);
  cuff.rotation.x = Math.PI / 2;
  cuff.position.z = 0.075;
  const stripe = new THREE.Mesh(new THREE.CylinderGeometry(0.0565, 0.0565, 0.014, 10), mat);
  stripe.rotation.x = Math.PI / 2;
  stripe.position.z = 0.075;
  // wrapped wrist + forearm running back and down out of frame, so the cuff never shows an end cap
  const armMat = new THREE.MeshLambertMaterial({
    color: C.playerArm, emissive: C.playerArm, emissiveIntensity: 0.25, transparent: true, opacity: 1,
  });
  // the glove is pitched so this runs down and out of the bottom of the frame
  const forearm = new THREE.Mesh(new THREE.CylinderGeometry(0.052, 0.044, 0.5, 10, 1, true), armMat);
  forearm.position.set(0, 0, 0.1 + 0.25);
  forearm.rotation.x = Math.PI / 2;
  g.add(body, knuckle, thumb, cuff, stripe, forearm);
  g.scale.setScalar(0.9);
  g.renderOrder = 20;
  for (const m of [body, knuckle, thumb, cuff, stripe, forearm]) m.renderOrder = 20;
  return { group: g, mat, cuffMat, armMat, knuckle, thumb, s, pos: new THREE.Vector3(s * 0.16, -0.2, -0.44), rot: new THREE.Euler(), opacity: 1, init: false };
}

export function createGloves(camera) {
  const gloves = { left: buildGlove('left'), right: buildGlove('right') };
  camera.add(gloves.left.group, gloves.right.group);
  const anims = { left: null, right: null }; // punch_thrown {t, type, power}
  const bounce = { left: -Infinity, right: -Infinity }; // her guard blocked this hand's punch
  let blockJolt = -Infinity; // the player blocked her strike
  let rejected = { left: -Infinity, right: -Infinity };
  const target = new THREE.Vector3();
  let lastNow = null;
  const swipes = { left: null, right: null }; // D12 parry swipes {t, ok}
  let xMul = 1; // portrait screens pull the gloves in toward the centre so neither hangs off the edge

  return {
    setAspect(aspect) {
      xMul = Math.max(0.5, Math.min(1, aspect / 1.4));
    },
    debug() {
      return { left: gloves.left.group.position.toArray(), right: gloves.right.group.position.toArray(), opacity: gloves.left.opacity };
    },
    onEvent(e) {
      if (e.type === 'punch_thrown') anims[e.hand] = { t: e.t, type: e.punchType, power: e.power, body: e.target === 'body' };
      else if (e.type === 'parry' && e.hand) swipes[e.hand] = { t: e.t, ok: e.result === 'success' }; // D12
      else if (e.type === 'blocked' && e.by === 'player' && e.hand) bounce[e.hand] = e.t;
      else if (e.type === 'blocked' && e.by === 'opponent') blockJolt = e.t;
      else if (e.type === 'punch_rejected') rejected[e.hand] = e.t;
      else return false;
      return true;
    },
    reset() {
      anims.left = anims.right = null;
      swipes.left = swipes.right = null;
      bounce.left = bounce.right = blockJolt = -Infinity;
      rejected = { left: -Infinity, right: -Infinity };
    },
    /**
     * @param {import('../shared/types.js').GameState} state
     * @param {import('../shared/types.js').InputFrame} frame
     * @param {number} now presentation time
     */
    update(state, frame, now) {
      const G = tuning.glove;
      const p = state.player;
      const dt = lastNow === null ? 1 : Math.max(0, Math.min(1, now - lastNow));
      lastNow = now;
      const gassed = state.time < p.gassedUntil;
      const brokenAge = state.time < p.guardBrokenUntil ? now - (p.guardBrokenUntil - G.brokenS) : -1;
      const hurt = Number.isFinite(p.hurtUntil) && state.time < p.hurtUntil; // D12: heavy gloves
      const damp = (gassed ? G.gassedDamp : p.fatigued ? G.fatigueDamp : 1) * (hurt ? 0.6 : 1);
      const guardUp = p.guard === 'full';
      const visible = state.phase !== 'boot';

      for (const side of ['left', 'right']) {
        const gl = gloves[side];
        const h = frame?.hands?.[side];
        const s = gl.s;
        const present = !!h?.present;
        let x;
        let y;
        let ext = 0;
        if (present) {
          x = (h.x - 0.5) * G.xScale;
          y = Math.max(-0.21, Math.min(0.08, G.baseY - (h.y - 0.55) * G.yScale));
          ext = Number.isFinite(h.ext) ? h.ext : 0;
          if (h.punchPhase === 'onset') ext = Math.max(ext, 0.35); // lead before the punch is confirmed
        } else {
          x = s * 0.17;
          y = G.baseY - 0.07;
        }
        // event-driven extension (keyboard frames already animate ext; take the larger)
        const a = anims[side];
        let hookK = 0;
        let upK = 0; // D11 uppercut arc 0..1
        let dipK = 0; // D11 the short dip before it
        if (a) {
          const age = now - a.t;
          if (a.type === 'uppercut') {
            // 250 ms: a ~60 ms dip, then an up-and-forward arc to her chin height, then back (keyboard and camera)
            const U = G.uppercutS;
            if (age >= 0 && age < U) {
              // the arc below IS the uppercut: hold the hand's height/depth from the frame at where the glove was when
              // the punch registered, so keyboard frames (which synthesize their own dip/rise + ext pulse) and camera
              // tracking aren't counted twice
              if (a.y0 === undefined) a.y0 = gl.pos.y;
              y = a.y0;
              ext = 0;
              const dipS = 0.06;
              if (age < dipS) dipK = Math.sin((Math.PI / 2) * (age / dipS));
              else {
                const u = (age - dipS) / (U - dipS);
                upK = Math.sin(Math.PI * Math.min(1, u * 1.15));
                dipK = Math.max(0, 1 - u * 4);
              }
            }
          } else if (age >= 0 && age < G.punchAnimS) {
            const k = Math.sin(Math.PI * age / G.punchAnimS);
            if (a.type === 'hook') hookK = Math.max(hookK, k);
            else ext = Math.max(ext, k);
          }
        }
        if (guardUp && brokenAge < 0) {
          x = s * G.guardX;
          y = G.guardY;
        }
        ext *= damp;
        hookK *= damp;
        upK *= damp;

        target.set(
          (x * (1 - 0.6 * ext) - s * hookK * 0.18) * xMul,
          y + 0.05 * ext + 0.02 * hookK,
          G.baseZ - G.reach * ext - 0.12 * hookK,
        );
        // uppercut: dip down and in, then drive up (to her chin, about screen centre) and forward, knuckles up
        target.y += -0.06 * dipK + (0.14 - target.y * 0.6) * upK;
        target.z -= 0.2 * upK;
        target.x -= s * 0.05 * (upK + dipK) * xMul;
        let rx = 0.85 - 0.55 * ext + (guardUp ? 0.2 : 0) + 0.6 * upK + 0.25 * dipK; // knuckles up, forearm stays below the glove
        let ry = -s * 0.25 * (1 - ext) + s * 1.1 * hookK;
        let rz = -s * (guardUp ? 0.5 : 0.25);

        // D12 body shot: the same extension on a lower line
        if (a?.body && now - a.t >= 0 && now - a.t < G.punchAnimS) {
          const k = Math.sin(Math.PI * (now - a.t) / G.punchAnimS);
          target.y -= 0.11 * k;
          rx += 0.25 * k;
        }
        // D12 parry: the glove swipes outward (wide and quick); a whiff swings wider and comes back slower
        const sw = swipes[side];
        if (sw) {
          const dur = sw.ok ? 0.22 : 0.32;
          const age = now - sw.t;
          if (age >= 0 && age < dur) {
            const k = Math.sin(Math.PI * age / dur) * (sw.ok ? 1 : 1.35);
            target.x += s * 0.12 * k * xMul;
            target.z += 0.03 * k;
            rz += s * 0.7 * k;
          }
        }
        if (hurt) {
          target.y -= 0.035;
          target.y += 0.01 * Math.sin(now * 2.2 + (s > 0 ? 0.8 : 0));
        }
        if (gassed || p.fatigued) {
          target.y -= gassed ? 0.06 : 0.025;
          target.y += 0.008 * Math.sin(now * 4 + (s > 0 ? 1 : 0));
        }
        // her guard blocked this hand: snap back
        const bAge = now - bounce[side];
        if (bAge >= 0 && bAge < 0.2) target.z += 0.12 * Math.sin(Math.PI * bAge / 0.2);
        // the player blocked her strike: both gloves jolt toward the face
        const jAge = now - blockJolt;
        if (jAge >= 0 && jAge < G.blockJoltS) {
          const k = Math.sin(Math.PI * jAge / G.blockJoltS);
          target.z += 0.07 * k;
          target.y += 0.025 * k;
        }
        // rejected (gassed) punch: a feeble twitch
        const rAge = now - rejected[side];
        if (rAge >= 0 && rAge < 0.25) target.y -= 0.03 * Math.sin(Math.PI * rAge / 0.25);
        // guard broken: knocked outward and down, then recovers
        if (brokenAge >= 0) {
          const k = brokenAge < 0.08 ? easeOut(brokenAge / 0.08) : 1 - clamp01((brokenAge - 0.35) / 0.25);
          target.x += s * 0.14 * k;
          target.y -= 0.06 * k;
          target.z += 0.04 * k;
          rz += s * 0.9 * k;
          rx -= 0.6 * k;
        }
        if (p.down) {
          target.y -= 0.5;
          rz += s * 0.6;
        }
        if (!visible) target.y -= 0.6;

        // smoothing: punches and knocks snap, lost hands ease back over G.easeLost
        const fast = ext > 0.05 || (swipes[side] && now - swipes[side].t < 0.35) || hookK > 0.05 || upK > 0.02 || dipK > 0.02 || brokenAge >= 0 || jAge < G.blockJoltS || bAge < 0.2;
        const tau = fast ? 0.025 : present ? 0.05 : G.easeLost / 3;
        const k = !gl.init ? 1 : 1 - Math.exp(-dt / tau);
        gl.init = true;
        gl.pos.lerp(target, k);
        gl.rot.x += (rx - gl.rot.x) * k;
        gl.rot.y += (ry - gl.rot.y) * k;
        gl.rot.z += (rz - gl.rot.z) * k;
        gl.group.position.copy(gl.pos);
        gl.group.rotation.copy(gl.rot);

        // opacity: lost → dim; open hand → translucent and slightly opened
        const open = present && !h.fist;
        const op = !present ? G.lostOpacity : open ? G.openOpacity : 1;
        gl.opacity += (op - gl.opacity) * (!gl.init ? 1 : 1 - Math.exp(-dt / 0.06));
        gl.mat.opacity = gl.cuffMat.opacity = gl.armMat.opacity = gl.opacity;
        gl.mat.depthWrite = gl.opacity > 0.95;
        gl.knuckle.position.z = open ? -0.085 : -0.07;
        gl.knuckle.rotation.x = open ? -0.5 : 0;
        gl.thumb.position.x = (open ? -0.075 : -0.055) * s;
        gl.group.visible = visible;
      }
    },
  };
}
