// Tekrar sahnesi araçları: Blender'da yapılmış GLB modeli (assets/f1car.glb) bir kez yüklenir, her araç için klonlanır.
//   • Renk düzeni (livery): gövde dokusundaki mavi/camgöbeği boya, gölgelendiricide hedef renklere eşlenir (doku kopyalanmaz)
//   • LOD: odak ve yakındaki araçlar GLB (~117 bin üçgen); uzaktakiler birleştirilmiş prosedürel araç (~8 çizim çağrısı)
//   • Hayalet: tek parça birleştirilmiş geometri, önce yalnız derinlik sonra yarı saydam renk (iç yüzeyler görünmez)
// GLB yüklenemezse (dosya yok / eski tarayıcı) prosedürel buildF1Car kullanılır.
// Model ekseni: burun −Z, +Y yukarı, zemin y = 0, metre.

import * as THREE from '../vendor/three.module.min.js';
import { GLTFLoader } from '../vendor/addons/loaders/GLTFLoader.js';
import { buildF1Car } from './f1car.js';

// Renk düzenleri: 0 = modelin özgün renkleri (mavi/camgöbeği). Tamamı uydurmadır.
export const LIVERIES = [
  { name: 'Mavi', base: '#1c57db', accent: '#22d3ee', original: true },
  { name: 'Kırmızı', base: '#c40d1e', accent: '#f2f2f2' },
  { name: 'Turuncu', base: '#ff7a00', accent: '#14233d' },
  { name: 'Yeşil', base: '#036b5c', accent: '#c6e000' },
  { name: 'Gümüş', base: '#a7b0ba', accent: '#00cdb8' },
  { name: 'Mor', base: '#4a1f86', accent: '#ffc400' },
  { name: 'Sarı', base: '#f2c200', accent: '#151515' },
  { name: 'Beyaz', base: '#e9ecef', accent: '#e10600' },
  { name: 'Lacivert', base: '#0b1f4d', accent: '#ff3d7f' },
  { name: 'Siyah', base: '#18191c', accent: '#d4af37' },
  { name: 'Pembe', base: '#f45ba8', accent: '#1b2a6b' },
  { name: 'Haki', base: '#3d5a3a', accent: '#f5f1e0' },
];

// Boya ayarı: ACES + pozlama 0.95 ile boyanın soluk görünmemesi için (vernik yansıması ve taban rengi)
const PAINT_TUNE = { colorMul: 0.9, envMapIntensity: 0.85, clearcoat: 0.55, clearcoatRoughness: 0.07 };
const PAINT_NAMES = ['paint_body', 'paint_sidepod', 'paint_fin', 'paint_blue', 'paint_cyan', 'paint_white'];
const TEX_PAINTS = ['paint_body', 'paint_sidepod', 'paint_fin'];

const MODEL_URL = new URL('../assets/f1car.glb', import.meta.url).href;
let modelPromise = null;

// GLB'yi bir kez yükler; sonuç (şablon sahne) önbellekte tutulur. Hata olursa null döner.
export function loadCarModel() {
  if (!modelPromise) {
    modelPromise = new Promise((resolve) => {
      const t0 = performance.now();
      new GLTFLoader().load(
        MODEL_URL,
        (gltf) => {
          try {
            resolve(prepTemplate(gltf.scene, performance.now() - t0));
          } catch (e) {
            console.warn('Araç modeli hazırlanamadı, prosedürel araç kullanılacak:', e);
            resolve(null);
          }
        },
        undefined,
        (err) => {
          console.warn('Araç modeli (assets/f1car.glb) yüklenemedi, prosedürel araç kullanılacak:', err?.message || err);
          modelPromise = null; // sonraki açılışta yeniden dene
          resolve(null);
        },
      );
    });
  }
  return modelPromise;
}

function prepTemplate(scene, ms) {
  const mats = new Map();
  let tris = 0;
  scene.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    o.receiveShadow = true;
    o.geometry.userData.keep = true;
    tris += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      mats.set(m.name, m);
      m.userData.keep = true;
      for (const k of ['map', 'normalMap', 'emissiveMap', 'roughnessMap', 'metalnessMap', 'clearcoatMap', 'clearcoatNormalMap']) {
        if (m[k]) {
          m[k].userData.keep = true;
          m[k].anisotropy = 8;
        }
      }
    }
  });
  for (const name of PAINT_NAMES) {
    const m = mats.get(name);
    if (!m) continue;
    m.color.multiplyScalar(PAINT_TUNE.colorMul);
    m.envMapIntensity = PAINT_TUNE.envMapIntensity;
    if (m.clearcoat != null) {
      m.clearcoat = PAINT_TUNE.clearcoat;
      m.clearcoatRoughness = PAINT_TUNE.clearcoatRoughness;
    }
  }
  // ayna camı: ortam haritasının yeşil zemin yarısını yansıtıp "yeşil kutu" gibi görünmesin
  const mirror = mats.get('mirror_glass');
  if (mirror) {
    mirror.color.set(0x56636f);
    mirror.metalness = 1;
    mirror.roughness = 0.18;
    mirror.envMapIntensity = 0.7;
  }
  const need = ['steer_FL', 'steer_FR', 'wheel_FL', 'wheel_FR', 'wheel_RL', 'wheel_RR', 'helmet', 'steering_wheel'];
  const missing = need.filter((n) => !scene.getObjectByName(n));
  if (missing.length) throw new Error('GLB düğümleri eksik: ' + missing.join(', '));
  return { scene, mats, tris: Math.round(tris), loadMs: Math.round(ms), ghostGeo: null };
}

// ---------- renk eşleme gölgelendiricisi ----------
// Doğrusal uzayda: mavi taban (g/b ≈ 0.13) ve camgöbeği vurgu (g/b ≈ 0.76) ayrılır; parlaklık oranı korunur
// (kenar gölgelemesi, çizgiler ve beyaz/karbon kısımlar bozulmaz).
const RECOLOR_GLSL = /* glsl */ `
uniform vec3 lvBase;
uniform vec3 lvAccent;
vec3 lvRecolor(vec3 c) {
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  float sat = mx > 1e-4 ? (mx - mn) / mx : 0.0;
  float blueish = step(c.r, c.b) * step(c.g, c.b * 1.05);
  float w = smoothstep(0.45, 0.8, sat) * blueish;
  if (w <= 0.0) return c;
  float wa = smoothstep(0.3, 0.56, c.g / max(c.b, 1e-4));
  float lum = mx / mix(0.71, 0.855, wa);
  vec3 tgt = mix(lvBase, lvAccent, wa) * min(lum, 1.25);
  return mix(c, tgt, w);
}
`;

function recolorMaterial(src, livery) {
  const m = src.clone();
  m.userData = { liveried: true };
  // m.color (PAINT_TUNE.colorMul ile ayarlı) eşlenen renkle de çarpılır
  const uBase = { value: new THREE.Color(livery.base) };
  const uAccent = { value: new THREE.Color(livery.accent) };
  m.onBeforeCompile = (sh) => {
    sh.uniforms.lvBase = uBase;
    sh.uniforms.lvAccent = uAccent;
    sh.fragmentShader = RECOLOR_GLSL + sh.fragmentShader.replace(
      '#include <map_fragment>',
      `#ifdef USE_MAP
        vec4 sampledDiffuseColor = texture2D( map, vMapUv );
        sampledDiffuseColor.rgb = lvRecolor( sampledDiffuseColor.rgb );
        diffuseColor *= sampledDiffuseColor;
      #endif`,
    );
  };
  m.customProgramCacheKey = () => 'livery-recolor';
  return m;
}

// ---------- geometri birleştirme ----------
const _m4 = new THREE.Matrix4(), _inv = new THREE.Matrix4(), _n3 = new THREE.Matrix3(), _v = new THREE.Vector3();
function mergeMeshes(root, { byMaterial = true, uv = true } = {}) {
  root.updateMatrixWorld(true);
  _inv.copy(root.matrixWorld).invert();
  const groups = new Map();
  root.traverse((o) => {
    if (!o.isMesh || !o.visible) return;
    const mat = Array.isArray(o.material) ? o.material[0] : o.material;
    const key = byMaterial ? mat : 'all';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ geo: o.geometry, m: new THREE.Matrix4().multiplyMatrices(_inv, o.matrixWorld) });
  });
  const out = [];
  for (const [mat, list] of groups) {
    let nv = 0, ni = 0;
    for (const { geo } of list) {
      nv += geo.attributes.position.count;
      ni += geo.index ? geo.index.count : geo.attributes.position.count;
    }
    const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), uvs = uv ? new Float32Array(nv * 2) : null;
    const idx = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
    let vo = 0, io = 0;
    for (const { geo, m } of list) {
      const P = geo.attributes.position, N = geo.attributes.normal, U = geo.attributes.uv;
      _n3.getNormalMatrix(m);
      for (let i = 0; i < P.count; i++) {
        _v.fromBufferAttribute(P, i).applyMatrix4(m);
        pos[(vo + i) * 3] = _v.x; pos[(vo + i) * 3 + 1] = _v.y; pos[(vo + i) * 3 + 2] = _v.z;
        if (N) {
          _v.fromBufferAttribute(N, i).applyMatrix3(_n3).normalize();
          nor[(vo + i) * 3] = _v.x; nor[(vo + i) * 3 + 1] = _v.y; nor[(vo + i) * 3 + 2] = _v.z;
        }
        if (uvs && U) { uvs[(vo + i) * 2] = U.getX(i); uvs[(vo + i) * 2 + 1] = U.getY(i); }
      }
      if (geo.index) for (let k = 0; k < geo.index.count; k++) idx[io++] = geo.index.getX(k) + vo;
      else for (let k = 0; k < P.count; k++) idx[io++] = k + vo;
      vo += P.count;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    if (uvs) g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeBoundingSphere();
    out.push({ geo: g, mat });
  }
  return out;
}

function disposeTree(obj) {
  obj.traverse((o) => {
    if (o.geometry && !o.geometry.userData.keep) o.geometry.dispose();
    if (o.material) {
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (m.userData.keep) continue;
        for (const k of ['map', 'normalMap', 'emissiveMap']) if (m[k] && !m[k].userData.keep) m[k].dispose();
        m.dispose();
      }
    }
  });
}

// ---------- araç örneği ----------
export class CarInstance {
  constructor({ hi, parts, lo, livery, kind }) {
    this.root = new THREE.Group();
    this.hi = hi;
    this.lo = lo;
    this.parts = parts; // { fronts[], wheels[], steering, helmet }
    this.livery = livery;
    this.kind = kind; // 'glb' | 'procedural'
    this.root.add(hi);
    if (lo) {
      this.root.add(lo);
      lo.visible = false;
    }
    this.level = 0;
    this.opacity = 1;
    this.materials = new Set();
    this.root.traverse((o) => {
      if (o.material) for (const m of Array.isArray(o.material) ? o.material : [o.material]) this.materials.add(m);
    });
    for (const m of this.materials) m.userData.baseOpacity = m.opacity;
  }
  setLevel(l) {
    if (!this.lo) l = 0;
    if (l === this.level) return;
    this.level = l;
    this.hi.visible = l === 0;
    this.lo.visible = l === 1;
  }
  animate(steer, spin) {
    const p = this.parts;
    for (const f of p.fronts) f.rotation.y = -steer * 0.38;
    if (p.steering) p.steering.rotation.z = -steer * 1.4;
    for (const w of p.wheels) w.rotation.x = spin;
  }
  setHelmet(v) {
    if (this.parts.helmet) this.parts.helmet.visible = v;
  }
  // 1 = katı, < 1 yarı saydam (yakın kamera / üst üste binen araçlar), 0 = gizli
  setOpacity(o) {
    o = Math.max(0, Math.min(1, o));
    if (Math.abs(o - this.opacity) < 0.01 && !(o === 1 && this.opacity !== 1)) return;
    const was = this.opacity < 0.999;
    this.opacity = o;
    const tr = o < 0.999;
    this.root.visible = o > 0.02;
    for (const m of this.materials) {
      m.opacity = (m.userData.baseOpacity ?? 1) * o;
      if (tr !== was) {
        m.transparent = tr || !!m.userData.wasTransparent;
        m.depthWrite = !tr;
        m.needsUpdate = true;
      }
    }
  }
  dispose() {
    disposeTree(this.root);
  }
}

// Hayalet araç: yalnız derinlik + yarı saydam renk (iki çizim çağrısı)
export class GhostInstance {
  constructor(geo, color, opacity = 0.42) {
    this.root = new THREE.Group();
    const c = new THREE.Color(color);
    this.depthMat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: true, transparent: true, opacity: 0 });
    this.colMat = new THREE.MeshStandardMaterial({
      color: c, emissive: c, emissiveIntensity: 0.45, roughness: 0.35, metalness: 0.1,
      transparent: true, opacity, depthWrite: false, depthFunc: THREE.LessEqualDepth,
    });
    const d = new THREE.Mesh(geo, this.depthMat);
    d.renderOrder = 20;
    const m = new THREE.Mesh(geo, this.colMat);
    m.renderOrder = 21;
    this.root.add(d, m);
    this.root.userData.ghost = true;
    this.baseOpacity = opacity;
  }
  setOpacity(o) {
    this.colMat.opacity = this.baseOpacity * o;
    this.root.visible = o > 0.02;
  }
  dispose() {
    this.depthMat.dispose();
    this.colMat.dispose();
  }
}

export class CarFactory {
  // model: loadCarModel() sonucu (null → prosedürel)
  constructor({ envMap = null, model = null } = {}) {
    this.envMap = envMap;
    this.model = model;
    this._ghostGeo = null;
  }

  get usesGLB() {
    return !!this.model;
  }

  _glbClone(livery) {
    const T = this.model;
    const obj = T.scene.clone(true);
    const map = new Map();
    const swap = (m) => {
      if (!map.has(m)) {
        let c;
        if (!livery.original && TEX_PAINTS.includes(m.name)) c = recolorMaterial(m, livery);
        else {
          c = m.clone();
          c.userData = {};
          if (!livery.original && m.name === 'paint_blue') c.color.set(livery.base).multiplyScalar(PAINT_TUNE.colorMul);
          if (!livery.original && m.name === 'paint_cyan') c.color.set(livery.accent).multiplyScalar(PAINT_TUNE.colorMul);
        }
        c.userData.wasTransparent = m.transparent;
        map.set(m, c);
      }
      return map.get(m);
    };
    obj.traverse((o) => {
      if (o.isMesh) o.material = Array.isArray(o.material) ? o.material.map(swap) : swap(o.material);
    });
    const g = (n) => obj.getObjectByName(n);
    const parts = {
      fronts: [g('steer_FL'), g('steer_FR')],
      wheels: [g('wheel_FL'), g('wheel_FR'), g('wheel_RL'), g('wheel_RR')],
      steering: g('steering_wheel'),
      helmet: g('helmet'),
    };
    return { obj, parts };
  }

  _procedural(livery) {
    const c = buildF1Car({ envMap: this.envMap, livery: { base: livery.base, accent: livery.accent, accent2: '#ffffff' } });
    return { obj: c.car, parts: { fronts: c.front, wheels: c.wheels, steering: c.wheelPivot, helmet: c.helmet } };
  }

  // Uzak LOD: prosedürel aracı malzemeye göre birleştir (tekerlek/direksiyon animasyonu yok)
  _lowLOD(livery) {
    const src = this._procedural(livery);
    const g = new THREE.Group();
    for (const { geo, mat } of mergeMeshes(src.obj)) {
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = true;
      m.receiveShadow = false;
      g.add(m);
    }
    // birleştirilmiş kopyalar yeni geometri; kaynak geometrileri bırak (malzeme/dokular paylaşılıyor)
    src.obj.traverse((o) => o.geometry && o.geometry.dispose());
    return g;
  }

  // lod: true → uzak seviye de üretilir
  make(livery = LIVERIES[0], { lod = true } = {}) {
    let hi, parts, kind;
    if (this.model) {
      ({ obj: hi, parts } = this._glbClone(livery));
      kind = 'glb';
    } else {
      ({ obj: hi, parts } = this._procedural(livery));
      kind = 'procedural';
    }
    const lo = lod ? this._lowLOD(livery) : null;
    return new CarInstance({ hi, parts, lo, livery, kind });
  }

  ghost(color, opacity) {
    if (!this._ghostGeo) {
      let src;
      if (this.model) src = this.model.scene;
      else src = this._procedural(LIVERIES[0]).obj;
      const parts = mergeMeshes(src, { byMaterial: false, uv: false });
      this._ghostGeo = parts[0].geo;
      if (!this.model) src.traverse((o) => o.geometry && o.geometry.dispose());
    }
    return new GhostInstance(this._ghostGeo, color, opacity);
  }

  dispose() {
    if (this._ghostGeo) this._ghostGeo.dispose();
  }
}
