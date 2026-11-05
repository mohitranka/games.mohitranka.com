// view/opponent-model.js — Tamsin "Tugboat" Rourke, built procedurally from primitives (owner: TA).
// An original design: a barge pilot built like a cargo winch. Broad shoulders and traps, short thick arms with
// rope-burn bands on the forearms, a navy crop top with a rope stripe, oilskin-yellow trunks, a copper braid,
// battered brass gloves.
//
// Rig: base (on the canvas, +z faces the player) → upper (pivot at the hips: lean/twist/roll) → head.
// Arms and legs are solved each frame with two-bone IK from pose targets given in BASE space, so a strike
// lands where the pose says even when the torso leans. Her LEFT is +x (screen right, she faces the camera).

import * as THREE from 'three';
import { tuning } from './tuning.js';

const UP = new THREE.Vector3(0, 1, 0);
// Pose heights are authored for a 0.93 m hip; Tamsin is short-legged and stocky, so the rig sits DROP lower.
// Strike contact targets compensate (opponent-anim.js aims them at the player's eyes).
export const DROP = 0.12;
const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _m = new THREE.Matrix4();

function lambert(color, opts = {}) {
  return new THREE.MeshLambertMaterial({ color, flatShading: true, ...opts });
}

/** Unit cylinder along +y centred on the origin, so a limb can be stretched between two points. */
function limbGeo(r0, r1, seg = 6) {
  return new THREE.CylinderGeometry(r1, r0, 1, seg, 1);
}

/** Place a unit limb mesh between points a and b (same parent space). */
function placeLimb(mesh, a, b) {
  _v.subVectors(b, a);
  const len = _v.length() || 1e-4;
  mesh.position.addVectors(a, b).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(UP, _v.divideScalar(len));
  mesh.scale.set(1, len, 1);
}

/** Two-bone IK. Returns the elbow/knee position in `out`. pole: preferred bend direction. */
function solveIK(S, T, a, b, pole, out) {
  const d = _v.subVectors(T, S);
  let len = d.length();
  const maxLen = (a + b) * 0.999;
  if (len > maxLen) {
    d.multiplyScalar(maxLen / len);
    T.copy(S).add(d);
    len = maxLen;
  }
  len = Math.max(len, Math.abs(a - b) + 1e-3);
  const dir = d.normalize();
  const cosA = THREE.MathUtils.clamp((a * a + len * len - b * b) / (2 * a * len), -1, 1);
  const sinA = Math.sqrt(1 - cosA * cosA);
  const perp = _w.copy(pole).addScaledVector(dir, -pole.dot(dir));
  if (perp.lengthSq() < 1e-8) perp.set(0, -1, 0).addScaledVector(dir, dir.y);
  perp.normalize();
  out.copy(S).addScaledVector(dir, a * cosA).addScaledVector(perp, a * sinA);
  return out;
}

/**
 * @param {THREE.Texture} glowTex
 */
export function createOpponentModel(glowTex) {
  const C = tuning.colors;
  const skin = lambert(C.skin);
  const top = lambert(C.top);
  const trunks = lambert(C.trunks);
  const band = lambert(C.trunksBand);
  const hair = lambert(C.hair);
  const burn = lambert(C.ropeBurn);
  const boots = lambert(C.boots);
  const dark = new THREE.MeshBasicMaterial({ color: 0x1a1210 });

  const base = new THREE.Group();
  base.name = 'tamsin';
  const upper = new THREE.Group();
  base.add(upper);

  // ── torso (upper-local, origin at the hips)
  const hips = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.21, 0.26, 7), trunks);
  hips.scale.set(1.15, 1, 0.8);
  hips.position.y = -0.04;
  upper.add(hips);
  const waist = new THREE.Mesh(new THREE.CylinderGeometry(0.205, 0.205, 0.06, 7), band);
  waist.scale.set(1.15, 1, 0.82);
  waist.position.y = 0.11;
  upper.add(waist);
  const belly = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.19, 0.16, 7), skin);
  belly.scale.set(1.12, 1, 0.78);
  belly.position.y = 0.21;
  upper.add(belly);
  const chest = new THREE.Mesh(new THREE.CylinderGeometry(0.33, 0.22, 0.3, 7), top);
  chest.scale.set(1.12, 1, 0.68);
  chest.position.y = 0.43;
  upper.add(chest);
  const stripe = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.255, 0.035, 7), lambert(C.topStripe));
  stripe.scale.set(1.13, 1, 0.7);
  stripe.position.y = 0.35;
  upper.add(stripe);
  const traps = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.34, 0.14, 7), skin);
  traps.scale.set(1.15, 1, 0.62);
  traps.position.y = 0.62;
  upper.add(traps);
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.1, 0.12, 6), skin);
  neck.position.y = 0.7;
  upper.add(neck);

  // ── head (pivot at the neck)
  const head = new THREE.Group();
  head.position.y = 0.74;
  upper.add(head);
  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.115, 10, 8), skin);
  skull.scale.set(0.95, 1.08, 1);
  skull.position.y = 0.12;
  head.add(skull);
  const jaw = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.08, 0.13), skin);
  jaw.position.set(0, 0.055, 0.03);
  head.add(jaw);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.022, 0.05, 4), skin);
  nose.rotation.x = Math.PI / 2;
  nose.position.set(0, 0.11, 0.12);
  head.add(nose);
  for (const s of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.014, 5, 4), dark);
    eye.position.set(s * 0.04, 0.135, 0.1);
    head.add(eye);
    const brow = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.012, 0.02), hair);
    brow.position.set(s * 0.042, 0.16, 0.105);
    brow.rotation.z = s * -0.18;
    head.add(brow);
    const ear = new THREE.Mesh(new THREE.SphereGeometry(0.025, 5, 4), skin);
    ear.scale.set(0.5, 1, 0.8);
    ear.position.set(s * 0.11, 0.12, 0);
    head.add(ear);
  }
  const mouth = new THREE.Mesh(new THREE.BoxGeometry(0.045, 0.008, 0.01), dark);
  mouth.position.set(0, 0.07, 0.095);
  head.add(mouth);
  // copper hair: a tight cap swept back + a thick braid over her left shoulder
  const cap = new THREE.Mesh(new THREE.SphereGeometry(0.122, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.55), hair);
  cap.scale.set(0.98, 1.05, 1.06);
  cap.position.set(0, 0.13, -0.012);
  cap.rotation.x = -0.35;
  head.add(cap);
  const braid = new THREE.Group();
  head.add(braid);
  const braidPts = [[0.03, 0.12, -0.12], [0.08, 0.05, -0.13], [0.13, -0.02, -0.1], [0.17, -0.09, -0.05], [0.19, -0.16, 0.0], [0.2, -0.22, 0.04]];
  braidPts.forEach(([x, y, z], i) => {
    const b = new THREE.Mesh(new THREE.SphereGeometry(0.036 - i * 0.003, 6, 5), hair);
    b.scale.set(1, 1.35, 1);
    b.position.set(x, y, z);
    braid.add(b);
  });
  const tie = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.02, 6), lambert(C.topStripe));
  tie.position.set(0.2, -0.25, 0.05);
  braid.add(tie);

  // ── arms (upper-local), short and thick
  const UA = 0.26;
  const FA = 0.25;
  const arms = {};
  for (const side of ['left', 'right']) {
    const s = side === 'left' ? 1 : -1;
    const shoulder = new THREE.Vector3(s * 0.34, 0.56, 0.0);
    const delt = new THREE.Mesh(new THREE.SphereGeometry(0.098, 8, 6), skin);
    delt.position.copy(shoulder);
    upper.add(delt);
    const upperArm = new THREE.Mesh(limbGeo(0.088, 0.072), skin);
    const foreArm = new THREE.Mesh(limbGeo(0.07, 0.056), skin);
    upper.add(upperArm, foreArm);
    const burnBand = new THREE.Mesh(new THREE.CylinderGeometry(0.066, 0.066, 0.05, 6), burn);
    upper.add(burnBand);
    const gloveMat = lambert(C.oppGlove, { emissive: new THREE.Color(0x000000) });
    const glove = new THREE.Group();
    const fist = new THREE.Mesh(new THREE.SphereGeometry(0.085, 9, 7), gloveMat);
    fist.scale.set(1, 1.1, 1.2);
    fist.position.y = 0.06;
    const thumb = new THREE.Mesh(new THREE.SphereGeometry(0.035, 6, 5), gloveMat);
    thumb.position.set(-s * 0.06, 0.035, 0.04);
    const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.065, 0.06, 7), lambert(0x6b4a22));
    cuff.position.y = -0.02;
    // practice mitt pad (visible only with state.opponent.mitts)
    const pad = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.05, 14), lambert(C.mittPad));
    pad.rotation.x = Math.PI / 2;
    pad.position.set(0, 0.08, 0.075);
    pad.visible = false;
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTex, color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, depthTest: false,
      blending: THREE.AdditiveBlending,
    }));
    glow.position.y = 0.07;
    glow.scale.setScalar(0.5);
    glow.renderOrder = 10;
    glove.add(fist, thumb, cuff, pad, glow);
    upper.add(glove);
    arms[side] = { s, shoulder, upperArm, foreArm, burnBand, glove, gloveMat, pad, glow, fist, elbow: new THREE.Vector3(), target: new THREE.Vector3() };
  }

  // ── legs (base-local; hips follow `upper`)
  const TH = 0.41;
  const SH = 0.4;
  const legs = {};
  for (const side of ['left', 'right']) {
    const s = side === 'left' ? 1 : -1;
    const thigh = new THREE.Mesh(limbGeo(0.12, 0.09), skin);
    const shin = new THREE.Mesh(limbGeo(0.085, 0.065), skin);
    const boot = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.13, 0.24), boots);
    const legTrunk = new THREE.Mesh(limbGeo(0.14, 0.125), trunks);
    base.add(thigh, shin, boot, legTrunk);
    legs[side] = { s, thigh, shin, boot, legTrunk, knee: new THREE.Vector3(), hip: new THREE.Vector3(), foot: new THREE.Vector3() };
  }

  // opening shimmer (gold, at the chin) and the hit-flash sprite (both driven by the renderer)
  const shimmer = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTex, color: 0xffd36b, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  shimmer.position.set(0, 0.08, 0.16);
  shimmer.scale.setScalar(0.45);
  head.add(shimmer);

  const S = new THREE.Vector3();
  const T = new THREE.Vector3();
  const pole = new THREE.Vector3();
  const upperInv = new THREE.Matrix4();

  /**
   * Apply a pose (see opponent-anim.js). Hand targets are in BASE space.
   * @param {ReturnType<import('./opponent-anim.js').neutralPose>} p
   */
  function setPose(p) {
    base.position.set(p.x, p.y, tuning.oppZ + p.z);
    base.rotation.set(p.fall, p.yaw, 0, 'YXZ');
    upper.position.set(0, p.hipY - DROP, 0);
    upper.rotation.set(p.lean, p.twist, p.roll, 'YXZ');
    head.rotation.set(p.headPitch, p.headYaw, p.headRoll, 'YXZ');
    base.updateMatrixWorld(true);
    upperInv.copy(upper.matrix).invert();

    for (const side of ['left', 'right']) {
      const a = arms[side];
      const hp = side === 'left' ? p.lHand : p.rHand;
      T.set(hp[0], hp[1] - DROP, hp[2]).applyMatrix4(upperInv); // base → upper-local
      S.copy(a.shoulder);
      const pl = side === 'left' ? p.lPole : p.rPole;
      pole.set(pl[0], pl[1], pl[2]).applyMatrix4(_m.extractRotation(upperInv));
      solveIK(S, T, UA, FA, pole, a.elbow);
      placeLimb(a.upperArm, S, a.elbow);
      placeLimb(a.foreArm, a.elbow, T);
      a.burnBand.position.lerpVectors(a.elbow, T, 0.55);
      a.burnBand.quaternion.copy(a.foreArm.quaternion);
      a.glove.position.copy(T);
      // glove points along the forearm, knuckles forward
      a.glove.quaternion.copy(a.foreArm.quaternion);
      const mitt = !!p.mitts;
      a.pad.visible = mitt;
      a.gloveMat.color.setHex(mitt ? C.mitt : C.oppGlove);
      if (mitt) {
        // pads face the player: aim the glove's +z at the camera-ish direction
        a.glove.quaternion.setFromEuler(new THREE.Euler(-0.15, 0, a.s * 0.2));
      }
      const g = side === 'left' ? p.lGlow : p.rGlow;
      a.glow.material.color.setHex(g.color);
      a.glow.material.opacity = Math.min(1, g.amount);
      const gs = g.size ?? 1;
      a.glow.scale.setScalar(gs * (0.2 + 0.45 * g.amount) + g.pop * 0.5);
      a.gloveMat.emissive.setHex(g.color).multiplyScalar(0.55 * Math.min(1, g.amount));
    }

    // legs: hips from the upper transform, feet planted in base space
    for (const side of ['left', 'right']) {
      const L = legs[side];
      L.hip.set(L.s * 0.12, -0.08, 0).applyMatrix4(upper.matrix);
      const f = side === 'left' ? p.lFoot : p.rFoot;
      L.foot.set(f[0], f[1], f[2]);
      pole.set(L.s * 0.25, 0, 1);
      solveIK(L.hip, L.foot, TH, SH, pole, L.knee);
      placeLimb(L.thigh, L.hip, L.knee);
      placeLimb(L.shin, L.knee, L.foot);
      // trunk leg covers the top of the thigh
      _v.lerpVectors(L.hip, L.knee, 0.45);
      placeLimb(L.legTrunk, L.hip, _v);
      L.boot.position.set(L.foot.x, L.foot.y + 0.0, L.foot.z + 0.04);
      L.boot.rotation.set(0, 0, 0);
    }
    shimmer.material.opacity = p.shimmer;
  }

  /** World position of the head (for hit sparks). */
  function headWorld(out) {
    return out.setFromMatrixPosition(skull.matrixWorld);
  }
  function gloveWorld(side, out) {
    return out.setFromMatrixPosition(arms[side].glove.matrixWorld);
  }

  /** World position of a foot (dust for the D9 back-foot plant). */
  function footWorld(side, out) {
    return out.copy(legs[side].foot).applyMatrix4(base.matrixWorld);
  }

  return { root: base, setPose, headWorld, gloveWorld, footWorld };
}
