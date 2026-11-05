// view/ring.js — the procedural set (owner: TA): a roped ring on a moored river barge at dusk.
// Sky gradient + sun, animated water, the far riverbank with a silhouetted crowd, the barge, ring, ropes,
// string lanterns and the lights. Everything is built from primitives; instancing keeps draw calls low.

import * as THREE from 'three';
import { tuning } from './tuning.js';

/** Soft round sprite used for lantern glows, telegraph glows and particles. */
export function makeGlowTexture(size = 64) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.25, 'rgba(255,255,255,0.6)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const SUN_DIR = new THREE.Vector3(-0.35, 0.07, -1).normalize();

function makeSky(C) {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      top: { value: new THREE.Color(C.skyTop) },
      mid: { value: new THREE.Color(C.skyMid) },
      horizon: { value: new THREE.Color(C.skyHorizon) },
      sun: { value: new THREE.Color(C.sun) },
      sunDir: { value: SUN_DIR },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 top, mid, horizon, sun, sunDir;
      varying vec3 vDir;
      void main() {
        float h = clamp(vDir.y, -0.2, 1.0);
        vec3 col = mix(horizon, mid, smoothstep(0.0, 0.18, h));
        col = mix(col, top, smoothstep(0.15, 0.6, h));
        if (h < 0.0) col = mix(horizon, mid * 0.6, smoothstep(0.0, -0.2, h));
        float s = max(dot(normalize(vDir), sunDir), 0.0);
        col += sun * (pow(s, 600.0) * 1.6 + pow(s, 24.0) * 0.35);
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  return new THREE.Mesh(new THREE.SphereGeometry(200, 24, 12), mat);
}

function makeWater(C) {
  const mat = new THREE.ShaderMaterial({
    fog: false,
    uniforms: {
      time: { value: 0 },
      water: { value: new THREE.Color(C.water) },
      horizon: { value: new THREE.Color(C.skyHorizon).lerp(new THREE.Color(C.skyMid), 0.35) },
      glint: { value: new THREE.Color(C.waterGlint) },
      sunDir: { value: SUN_DIR },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */ `
      uniform float time;
      uniform vec3 water, horizon, glint, sunDir;
      varying vec3 vWorld;
      void main() {
        vec2 p = vWorld.xz;
        float dist = length(p);
        float waves = sin(p.x * 1.7 + time * 0.9) * sin(p.y * 0.9 - time * 1.3) + sin(p.y * 3.1 + p.x * 0.4 + time * 2.0) * 0.5;
        vec2 dir = normalize(p);
        vec2 sd = normalize(sunDir.xz);
        float ang = 1.0 - dot(dir, sd);
        float streak = exp(-ang * 260.0) * smoothstep(-0.2, 1.3, waves) * smoothstep(4.0, 30.0, dist);
        vec3 col = mix(water, horizon, smoothstep(10.0, 140.0, dist));
        col *= 0.85 + 0.15 * waves;
        col += glint * streak * 1.2;
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(400, 400, 1, 1), mat);
  m.rotation.x = -Math.PI / 2;
  m.position.y = -0.95;
  return m;
}

function lambert(color, opts = {}) {
  return new THREE.MeshLambertMaterial({ color, flatShading: true, ...opts });
}

/** Far bank: a low ridge, trees, a foghorn tower and an instanced crowd silhouetted against the sunset. */
function makeBank(C, glowTex) {
  const g = new THREE.Group();
  const bankMat = lambert(C.bank);
  const ridge = new THREE.Mesh(new THREE.BoxGeometry(160, 1.4, 8), bankMat);
  ridge.position.set(0, -0.3, -34);
  g.add(ridge);

  // trees: instanced cones
  const treeGeo = new THREE.ConeGeometry(1.4, 5, 5);
  const trees = new THREE.InstancedMesh(treeGeo, lambert(C.crowd), 26);
  const m = new THREE.Matrix4();
  for (let i = 0; i < 26; i++) {
    const x = -70 + i * 5.6 + Math.sin(i * 7.1) * 1.8;
    const s = 0.8 + ((i * 37) % 10) / 14;
    if (Math.abs(x + 2) < 9) { // leave a gap behind the ring for the crowd
      m.makeScale(0, 0, 0);
    } else {
      m.compose(new THREE.Vector3(x, 2.0 * s, -36 - (i % 3)), new THREE.Quaternion(), new THREE.Vector3(s, s, s));
    }
    trees.setMatrixAt(i, m);
  }
  g.add(trees);

  // crowd: instanced capsules (heads + shoulders read as one blob at this distance)
  const crowdGeo = new THREE.CapsuleGeometry(0.28, 0.7, 2, 6);
  const N = 70;
  const crowd = new THREE.InstancedMesh(crowdGeo, lambert(C.crowd), N);
  for (let i = 0; i < N; i++) {
    const x = -22 + (i / N) * 44 + Math.sin(i * 12.9) * 0.4;
    const row = i % 2;
    const h = 0.9 + ((i * 53) % 7) / 18;
    m.compose(new THREE.Vector3(x, 0.45 + h * 0.5 + row * 0.25, -30.5 - row * 0.9), new THREE.Quaternion(), new THREE.Vector3(1, h, 1));
    crowd.setMatrixAt(i, m);
  }
  g.add(crowd);

  // foghorn tower with a red lamp (Anchor Drop's foghorn "comes from the riverbank")
  const tower = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.9, 7, 6), lambert(C.crowd));
  tower.position.set(18, 3.2, -33);
  g.add(tower);
  const horn = new THREE.Mesh(new THREE.ConeGeometry(0.7, 1.4, 6, 1, true), lambert(0x2a2238));
  horn.rotation.z = Math.PI / 2;
  horn.position.set(17.2, 6.4, -33);
  g.add(horn);

  // bank lights (one Points draw call)
  const pts = [];
  for (let i = 0; i < 18; i++) pts.push(-40 + i * 4.8 + Math.sin(i) * 1.2, 0.7 + (i % 3) * 0.4, -30.2);
  pts.push(18, 6.9, -32.6); // tower lamp
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const cols = [];
  for (let i = 0; i < 18; i++) cols.push(1, 0.72, 0.35);
  cols.push(1, 0.2, 0.15);
  geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  const lights = new THREE.Points(geo, new THREE.PointsMaterial({
    size: 1.6, map: glowTex, vertexColors: true, transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending, fog: false,
  }));
  g.add(lights);
  return { group: g, towerLampIndex: 18, lights };
}

/** Barge hull, deck, ring canvas, posts and ropes. */
function makeBarge(C) {
  const g = new THREE.Group();
  const hull = new THREE.Mesh(new THREE.BoxGeometry(9, 1.2, 15), lambert(C.hull));
  hull.position.set(0, -0.62, -2.5);
  g.add(hull);
  const deck = new THREE.Mesh(new THREE.BoxGeometry(8.6, 0.1, 14.6), lambert(C.deck));
  deck.position.set(0, -0.07, -2.5);
  g.add(deck);
  // gunwale rail
  const rail = new THREE.Mesh(new THREE.BoxGeometry(9.1, 0.25, 0.25), lambert(C.hull));
  rail.position.set(0, 0.05, -10);
  g.add(rail);

  // ring platform + canvas with a red apron
  const RING = 5.6;
  const cz = -1.0;
  const apron = new THREE.Mesh(new THREE.BoxGeometry(RING + 0.6, 0.32, RING + 0.6), lambert(C.canvasEdge));
  apron.position.set(0, -0.15, cz);
  g.add(apron);
  const canvas = new THREE.Mesh(new THREE.BoxGeometry(RING + 0.4, 0.04, RING + 0.4), lambert(C.canvas));
  canvas.position.set(0, 0.0, cz);
  g.add(canvas);

  // posts (instanced)
  const half = RING / 2;
  const corners = [[-half, cz - half], [half, cz - half], [-half, cz + half], [half, cz + half]];
  const posts = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.07, 0.08, 1.45, 6), lambert(C.post), 4);
  const m = new THREE.Matrix4();
  corners.forEach(([x, z], i) => {
    m.makeTranslation(x, 0.72, z);
    posts.setMatrixAt(i, m);
  });
  g.add(posts);

  // ropes: three heights on the back and both sides (front ropes are behind the player's eyes)
  const ropeGeo = new THREE.CylinderGeometry(0.022, 0.022, 1, 5);
  ropeGeo.rotateZ(Math.PI / 2); // along x
  const segs = [
    [[-half, cz - half], [half, cz - half]],
    [[-half, cz - half], [-half, cz + half]],
    [[half, cz - half], [half, cz + half]],
  ];
  const heights = [0.45, 0.82, 1.2];
  const ropes = new THREE.InstancedMesh(ropeGeo, lambert(C.rope), segs.length * heights.length);
  let i = 0;
  const q = new THREE.Quaternion();
  for (const [[x0, z0], [x1, z1]] of segs) {
    for (const h of heights) {
      const len = Math.hypot(x1 - x0, z1 - z0);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.atan2(z1 - z0, x1 - x0));
      m.compose(new THREE.Vector3((x0 + x1) / 2, h, (z0 + z1) / 2), q, new THREE.Vector3(len, 1, 1));
      ropes.setMatrixAt(i++, m);
    }
  }
  g.add(ropes);

  // mooring bollards + a coil of rope on deck for flavour
  const bollards = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.16, 0.2, 0.4, 6), lambert(0x2b2b30), 2);
  m.makeTranslation(-3.9, 0.15, -6.5); bollards.setMatrixAt(0, m);
  m.makeTranslation(3.9, 0.15, -7.5); bollards.setMatrixAt(1, m);
  g.add(bollards);
  // a coiled mooring line: three stacked rope rings, so it reads as rope rather than a plank
  const coil = new THREE.InstancedMesh(new THREE.TorusGeometry(0.3, 0.055, 6, 16), lambert(C.rope), 3);
  const qx = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
  for (let k = 0; k < 3; k++) {
    m.compose(new THREE.Vector3(-3.75 + k * 0.03, 0.03 + k * 0.1, -6.2), qx, new THREE.Vector3(1 - k * 0.12, 1 - k * 0.12, 1));
    coil.setMatrixAt(k, m);
  }
  g.add(coil);
  return g;
}

/** String lanterns overhead: sagging lines, instanced lanterns, additive glows. */
function makeLanterns(C, glowTex) {
  const g = new THREE.Group();
  const poleMat = lambert(C.post);
  const poles = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.06, 0.08, 3.8, 5), poleMat, 4);
  const m = new THREE.Matrix4();
  const P = [[-3.8, -5.5], [3.8, -5.5], [-3.8, 1.6], [3.8, 1.6]];
  P.forEach(([x, z], i) => { m.makeTranslation(x, 1.9, z); poles.setMatrixAt(i, m); });
  g.add(poles);

  const strings = [
    [[-3.8, 3.7, -5.5], [3.8, 3.7, 1.6]],
    [[3.8, 3.7, -5.5], [-3.8, 3.7, 1.6]],
    [[-3.8, 3.7, -5.5], [3.8, 3.7, -5.5]],
    [[-3.8, 3.7, -2.0], [3.8, 3.7, -2.0]],
  ];
  const linePts = [];
  const lanternPos = [];
  for (const [a, b] of strings) {
    const N = 14;
    let prev = null;
    for (let i = 0; i <= N; i++) {
      const u = i / N;
      const p = new THREE.Vector3().lerpVectors(new THREE.Vector3(...a), new THREE.Vector3(...b), u);
      p.y -= Math.sin(Math.PI * u) * 0.75; // sag
      if (prev) linePts.push(prev.x, prev.y, prev.z, p.x, p.y, p.z);
      prev = p;
      if (i > 0 && i < N && i % 2 === 1) lanternPos.push(p.clone().add(new THREE.Vector3(0, -0.12, 0)));
    }
  }
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(linePts, 3));
  g.add(new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({ color: 0x241a1a })));

  const lanterns = new THREE.InstancedMesh(new THREE.OctahedronGeometry(0.09, 0), new THREE.MeshBasicMaterial({ color: C.lantern }), lanternPos.length);
  lanternPos.forEach((p, i) => {
    m.compose(p, new THREE.Quaternion(), new THREE.Vector3(1, 1.4, 1));
    lanterns.setMatrixAt(i, m);
  });
  g.add(lanterns);

  const glowGeo = new THREE.BufferGeometry();
  glowGeo.setAttribute('position', new THREE.Float32BufferAttribute(lanternPos.flatMap((p) => [p.x, p.y, p.z]), 3));
  const glowMat = new THREE.PointsMaterial({
    size: 0.9, map: glowTex, color: C.lantern, transparent: true, opacity: 0.75, depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const glows = new THREE.Points(glowGeo, glowMat);
  g.add(glows);
  return { group: g, glowMat };
}

/**
 * @returns {{group:THREE.Group, update(t:number, foghorn:number):void}}
 *   foghorn 0..1 brightens the red lamp on the bank tower while an Anchor Drop is telegraphed.
 */
export function createRing(glowTex) {
  const C = tuning.colors;
  const group = new THREE.Group();
  const water = makeWater(C);
  group.add(makeSky(C), water);
  const bank = makeBank(C, glowTex);
  group.add(bank.group, makeBarge(C));
  const lan = makeLanterns(C, glowTex);
  group.add(lan.group);

  const lampColor = bank.lights.geometry.getAttribute('color');
  return {
    group,
    update(t, foghorn = 0) {
      water.material.uniforms.time.value = t;
      lan.glowMat.opacity = 0.7 + 0.06 * Math.sin(t * 7.3) + 0.04 * Math.sin(t * 13.1);
      const k = 0.35 + 0.65 * Math.min(1, foghorn);
      lampColor.setXYZ(bank.towerLampIndex, 1 * k + 0.2, 0.2 * k, 0.15 * k);
      lampColor.needsUpdate = true;
    },
  };
}

/** Scene lights: dusk hemisphere, a low sun behind Tamsin (rim), a warm lantern key and a cool fill. */
export function createLights() {
  const g = new THREE.Group();
  g.add(new THREE.HemisphereLight(0xffb48c, 0x2a1830, 1.1));
  const sun = new THREE.DirectionalLight(0xff9a55, 2.2);
  sun.position.set(-6, 3, -20);
  g.add(sun);
  const key = new THREE.PointLight(0xffc27a, 9, 0, 1.6);
  key.position.set(0.4, 3.3, -0.6);
  g.add(key);
  const fill = new THREE.DirectionalLight(0x8fa0ff, 0.55);
  fill.position.set(2, 2, 4);
  g.add(fill);
  return g;
}
