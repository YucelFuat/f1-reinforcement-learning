// Pist çevresi dekoru: seyircili tribünler, reklam panoları/afişler, pit binası + pit duvarı, görevli (marşal) kulübeleri,
// lastik bariyerleri, ışık/TV direkleri, reklam köprüleri ve (Austin için) gözlem kulesi.
// Performans: yapılar bölge başına tek birleştirilmiş geometri (köşe renkli ortak malzeme); seyirci, bayrak ve lastikler
// InstancedMesh. Toplam ≈ 30-45 çizim çağrısı. Tüm markalar uydurmadır (gerçek şirket adı/logo yok).
//
// Koordinatlar: dünya x = px·K, z = py·K (metre), y = yükseklik (m). Pist dizileri (cx, cy, tan) pikseldir.

const BRANDS = [
  { name: 'RL LAB', bg: ['#0d47a1', '#1976d2'], fg: '#ffffff', mark: 'ring' },
  { name: 'NEURO RACING', bg: ['#0f1418', '#1f2a33'], fg: '#00e5ff', mark: 'chevron' },
  { name: 'GRADIENT OIL', bg: ['#ff6f00', '#d50000'], fg: '#ffffff', mark: 'drop' },
  { name: 'TENSOR TYRES', bg: ['#ffd600', '#ffb300'], fg: '#111111', mark: 'grid' },
  { name: 'SOFTMAX AIR', bg: ['#ffffff', '#dbe9f6'], fg: '#0d47a1', mark: 'wing' },
  { name: 'REWARD ENERGY', bg: ['#1b5e20', '#43a047'], fg: '#ffffff', mark: 'bolt' },
  { name: 'POLICY MOTORS', bg: ['#a31515', '#d32f2f'], fg: '#ffffff', mark: 'chevron' },
  { name: 'EPOCH CHRONO', bg: ['#1c1c1c', '#3a4750'], fg: '#ffca28', mark: 'ring' },
];
const ATLAS_ROWS = 8;
const BANNER_M = 8; // atlas satırının temsil ettiği afiş uzunluğu (m)

const SHIRTS = ['#e53935', '#fb8c00', '#fdd835', '#43a047', '#1e88e5', '#3949ab', '#8e24aa', '#f5f5f5', '#212121', '#00acc1', '#d81b60', '#6d4c41', '#90a4ae', '#ff7043', '#c0ca33'];
const SEATS = ['#1565c0', '#c62828', '#2e7d32', '#f9a825', '#6a1b9a', '#00838f', '#ef6c00', '#455a64'];
const TEAMS = ['#d32f2f', '#ff8f00', '#00897b', '#1e88e5', '#212121', '#7cb342', '#5e35b1', '#ec407a', '#f5f5f5', '#0d47a1'];
const FLAGS = ['#e53935', '#fdd835', '#1e88e5', '#ffffff', '#43a047', '#fb8c00', '#212121', '#8e24aa', '#00bcd4'];

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function angDiff(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

export function buildScenery(ctx) {
  const { THREE, scene, track: t, K, terrainH } = ctx;
  const freeAt = ctx.freeAt || (() => true);
  const envMap = ctx.envMap || null;
  const maxAniso = ctx.maxAniso || 8;
  let HI = (ctx.quality ?? 'high') === 'high'; // 'medium' (ve diğerleri): yarı seyirci, gölge yok
  const n = t.n;
  const dsM = t.ds * K;
  const hwM = t.halfWidth * K;
  const WALL = hwM + 12; // duvar ofseti (m) — cockpit.js ile aynı
  const rnd = mulberry32(hashStr(String(t.id || 'pist')));
  const pick = (arr) => arr[Math.floor(rnd() * arr.length) % arr.length];

  const root = new THREE.Group();
  root.name = 'scenery';
  scene.add(root);
  const ownTextures = [];
  const UP = new THREE.Vector3(0, 1, 0);

  // ---------- pist yardımcıları ----------
  const wrapK = (k) => ((Math.round(k) % n) + n) % n;
  const kOfM = (m) => Math.round(m / dsM);
  const PX = (k) => t.cx[k] * K;
  const PZ = (k) => t.cy[k] * K;
  const EL = (k) => t.elev[k];
  const tng = (k) => [Math.cos(t.tan[k]), Math.sin(t.tan[k])];
  const nrm = (k, side) => [-Math.sin(t.tan[k]) * side, Math.cos(t.tan[k]) * side];
  const offPt = (k, side, o) => {
    const [nx, nz] = nrm(k, side);
    return [PX(k) + nx * o, PZ(k) + nz * o];
  };
  const groundAt = (x, z) => terrainH(x / K, z / K);
  // cockpit.js safeOffset ile aynı kural: duvar/afiş bu ofsette çizilebilir mi?
  const offsetValid = (k, side, oM) => {
    const o = oM / K;
    const nx = -Math.sin(t.tan[k]) * side, ny = Math.cos(t.tan[k]) * side;
    const x = t.cx[k] + nx * o, y = t.cy[k] + ny * o;
    return t.halfWidth - t.sdfAt(x, y) >= o * 0.93;
  };

  // Merkez çizgisine gerçek uzaklık (m). Pist.sdf ızgarası yalnız ~hw+36 px'e kadar doğru olduğundan kendi ızgaramız.
  const CELL = 12;
  const grid = new Map();
  for (let i = 0; i < n; i++) {
    const key = Math.floor(PX(i) / CELL) * 100003 + Math.floor(PZ(i) / CELL);
    let a = grid.get(key);
    if (!a) grid.set(key, (a = []));
    a.push(i);
  }
  function nearest(x, z, maxR) {
    const r = Math.ceil(maxR / CELL);
    const gx = Math.floor(x / CELL), gz = Math.floor(z / CELL);
    let best = maxR * maxR, bk = -1;
    for (let a = -r; a <= r; a++)
      for (let b = -r; b <= r; b++) {
        const arr = grid.get((gx + a) * 100003 + gz + b);
        if (!arr) continue;
        for (const i of arr) {
          const dx = PX(i) - x, dz = PZ(i) - z;
          const d = dx * dx + dz * dz;
          if (d < best) {
            best = d;
            bk = i;
          }
        }
      }
    return { d: Math.sqrt(best), k: bk };
  }
  // kesin kontrol kendi mesafemizle; cockpit freeAt (≈1.5 m hücreli SDF) yalnız kaba doğrulama (1.2 m pay)
  const clearOK = (x, z, minM) => nearest(x, z, minM + 0.5).d >= minM && freeAt(x / K, z / K, (minM - 1.2) / K);
  // dönüş miktarı (±w metre penceresinde yön değişimi, radyan)
  const turnAt = (k, wM = 50) => {
    const w = kOfM(wM);
    return angDiff(t.tan[wrapK(k + w)], t.tan[wrapK(k - w)]);
  };
  // pist poligonunun içinde mi (iç saha)?
  function insideLoop(x, z) {
    let c = false;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = PX(i), zi = PZ(i), xj = PX(j), zj = PZ(j);
      if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
    }
    return c;
  }

  // ---------- yerleşim (dikdörtgen ayak izleri, SAT çakışma testi) ----------
  const occupied = [];
  const mkRect = (cx, cz, ux, uz, hu, hv) => ({ cx, cz, ux, uz, vx: -uz, vz: ux, hu, hv });
  function rectOverlap(a, b, pad = 0) {
    const dx = b.cx - a.cx, dz = b.cz - a.cz;
    for (const [x, z] of [[a.ux, a.uz], [a.vx, a.vz], [b.ux, b.uz], [b.vx, b.vz]]) {
      const ra = a.hu * Math.abs(a.ux * x + a.uz * z) + a.hv * Math.abs(a.vx * x + a.vz * z);
      const rb = b.hu * Math.abs(b.ux * x + b.uz * z) + b.hv * Math.abs(b.vx * x + b.vz * z);
      if (Math.abs(dx * x + dz * z) > ra + rb + pad) return false;
    }
    return true;
  }
  function rectSamples(r, step = 3) {
    const pts = [];
    const nu = Math.max(1, Math.ceil((2 * r.hu) / step)), nv = Math.max(1, Math.ceil((2 * r.hv) / step));
    for (let i = 0; i <= nu; i++)
      for (let j = 0; j <= nv; j++) {
        const a = -r.hu + (2 * r.hu * i) / nu, b = -r.hv + (2 * r.hv * j) / nv;
        pts.push([r.cx + r.ux * a + r.vx * b, r.cz + r.uz * a + r.vz * b]);
      }
    return pts;
  }
  function rectFree(r, minM, pad = 0.3) {
    for (const o of occupied) if (rectOverlap(r, o, pad)) return false;
    for (const [x, z] of rectSamples(r)) if (!clearOK(x, z, minM)) return false;
    return true;
  }
  function rectGround(r) {
    let mn = Infinity, mx = -Infinity;
    for (const [x, z] of rectSamples(r, Math.max(r.hu, r.hv) / 2)) {
      const h = groundAt(x, z);
      mn = Math.min(mn, h);
      mx = Math.max(mx, h);
    }
    return { mn, mx };
  }

  // ---------- geometri toplayıcı (tek çizim çağrısı için birleştirme) ----------
  const _v = new THREE.Vector3(), _n = new THREE.Vector3(), _m3 = new THREE.Matrix3(), _c = new THREE.Color();
  class Batch {
    constructor(uv = false) {
      this.p = [];
      this.nm = [];
      this.c = [];
      this.uv = uv ? [] : null;
      this.ix = [];
    }
    get empty() {
      return this.ix.length === 0;
    }
    add(geo, m4, color) {
      const pos = geo.attributes.position, nor = geo.attributes.normal, uv = geo.attributes.uv;
      const base = this.p.length / 3;
      _m3.getNormalMatrix(m4);
      _c.set(color);
      for (let i = 0; i < pos.count; i++) {
        _v.fromBufferAttribute(pos, i).applyMatrix4(m4);
        this.p.push(_v.x, _v.y, _v.z);
        _n.fromBufferAttribute(nor, i).applyMatrix3(_m3).normalize();
        this.nm.push(_n.x, _n.y, _n.z);
        this.c.push(_c.r, _c.g, _c.b);
        if (this.uv) this.uv.push(uv ? uv.getX(i) : 0, uv ? uv.getY(i) : 0);
      }
      if (geo.index) for (let i = 0; i < geo.index.count; i++) this.ix.push(base + geo.index.getX(i));
      else for (let i = 0; i < pos.count; i++) this.ix.push(base + i);
    }
    // dörtgen (a,b,c,d sırayla); ön yüz `want` normaline bakacak şekilde sarılır.
    // `shadeN` verilirse ışıklandırma için bu normal kullanılır (ör. çatı altını aydınlık göstermek için).
    quad(a, b, c, d, color, want, uvs = null, shadeN = null) {
      const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      let nx = e1[1] * e2[2] - e1[2] * e2[1], ny = e1[2] * e2[0] - e1[0] * e2[2], nz = e1[0] * e2[1] - e1[1] * e2[0];
      const L = Math.hypot(nx, ny, nz) || 1;
      nx /= L; ny /= L; nz /= L;
      let P = [a, b, c, d], U = uvs;
      if (nx * want[0] + ny * want[1] + nz * want[2] < 0) {
        P = [a, d, c, b];
        if (uvs) U = [uvs[0], uvs[3], uvs[2], uvs[1]];
        nx = -nx; ny = -ny; nz = -nz;
      }
      const base = this.p.length / 3;
      _c.set(color);
      if (shadeN) [nx, ny, nz] = shadeN;
      for (let i = 0; i < 4; i++) {
        this.p.push(P[i][0], P[i][1], P[i][2]);
        this.nm.push(nx, ny, nz);
        this.c.push(_c.r, _c.g, _c.b);
        if (this.uv) this.uv.push(U ? U[i][0] : 0, U ? U[i][1] : 0);
      }
      this.ix.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    build() {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nm, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
      if (this.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
      g.setIndex(this.ix);
      g.computeBoundingSphere();
      return g;
    }
  }
  const tmpGeos = []; // yalnız birleştirme için kullanılan geçici geometriler (inşa sonunda atılır)
  const cg = (...args) => {
    const g = new THREE.CylinderGeometry(...args);
    tmpGeos.push(g);
    return g;
  };
  const unitBox = new THREE.BoxGeometry(1, 1, 1);
  const unitCyl = new THREE.CylinderGeometry(1, 1, 1, 8, 1, false);
  const thinCyl = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true);
  const _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _p = new THREE.Vector3(), _e = new THREE.Euler();
  const _lm = new THREE.Matrix4(), _wm = new THREE.Matrix4();
  // yerel çerçeve: X = pist boyunca, Y = yukarı, Z = pistten dışarı (n). Sağ elli taban.
  function frame(ox, oy, oz, nx, nz) {
    const m = new THREE.Matrix4();
    m.makeBasis(new THREE.Vector3(nz, 0, -nx), UP, new THREE.Vector3(nx, 0, nz));
    m.setPosition(ox, oy, oz);
    return m;
  }
  const local = (F, x, y, z) => _v.set(x, y, z).applyMatrix4(F).toArray();
  function box(batch, F, x, y, z, w, h, d, color, rx = 0, ry = 0) {
    _e.set(rx, ry, 0);
    _lm.compose(_p.set(x, y, z), _q.setFromEuler(_e), _s.set(w, h, d));
    batch.add(unitBox, _wm.multiplyMatrices(F, _lm), color);
  }
  function cylY(batch, x, y0, z, r, y1, color, geo = unitCyl) {
    _lm.compose(_p.set(x, (y0 + y1) / 2, z), _q.identity(), _s.set(r, y1 - y0, r));
    batch.add(geo, _lm, color);
  }
  function tube(batch, a, b, r, color, geo = thinCyl) {
    const d = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const len = d.length();
    _q.setFromUnitVectors(UP, d.divideScalar(len));
    _lm.compose(_p.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2), _q, _s.set(r, len, r));
    batch.add(geo, _lm, color);
  }

  // ---------- dokular ----------
  function canvasTex(w, h, draw) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    draw(c.getContext('2d'), w, h);
    const tx = new THREE.CanvasTexture(c);
    tx.colorSpace = THREE.SRGBColorSpace;
    tx.anisotropy = maxAniso;
    ownTextures.push(tx);
    return tx;
  }
  function drawMark(g, kind, x, y, s, col) {
    g.save();
    g.fillStyle = col;
    g.strokeStyle = col;
    g.lineWidth = s * 0.16;
    g.beginPath();
    if (kind === 'ring') {
      g.arc(x, y, s * 0.42, 0, Math.PI * 2);
      g.stroke();
      g.beginPath();
      g.arc(x, y, s * 0.16, 0, Math.PI * 2);
      g.fill();
    } else if (kind === 'chevron') {
      for (let i = 0; i < 2; i++) {
        const o = i * s * 0.32 - s * 0.16;
        g.moveTo(x - s * 0.3 + o, y - s * 0.4);
        g.lineTo(x + s * 0.1 + o, y);
        g.lineTo(x - s * 0.3 + o, y + s * 0.4);
      }
      g.stroke();
    } else if (kind === 'drop') {
      g.moveTo(x, y - s * 0.48);
      g.quadraticCurveTo(x + s * 0.42, y + s * 0.05, x, y + s * 0.42);
      g.quadraticCurveTo(x - s * 0.42, y + s * 0.05, x, y - s * 0.48);
      g.fill();
    } else if (kind === 'grid') {
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) if ((i + j) % 2 === 0) g.fillRect(x - s * 0.42 + i * s * 0.28, y - s * 0.42 + j * s * 0.28, s * 0.26, s * 0.26);
    } else if (kind === 'wing') {
      g.moveTo(x - s * 0.5, y + s * 0.2);
      g.quadraticCurveTo(x, y - s * 0.6, x + s * 0.5, y - s * 0.3);
      g.quadraticCurveTo(x, y - s * 0.05, x - s * 0.5, y + s * 0.2);
      g.fill();
    } else if (kind === 'bolt') {
      g.moveTo(x + s * 0.1, y - s * 0.5);
      g.lineTo(x - s * 0.3, y + s * 0.06);
      g.lineTo(x, y + s * 0.06);
      g.lineTo(x - s * 0.1, y + s * 0.5);
      g.lineTo(x + s * 0.3, y - s * 0.08);
      g.lineTo(x, y - s * 0.08);
      g.closePath();
      g.fill();
    }
    g.restore();
  }
  const atlas = canvasTex(1024, 1024, (g, w, h) => {
    const rh = h / ATLAS_ROWS;
    BRANDS.forEach((b, r) => {
      const y0 = r * rh;
      const grd = g.createLinearGradient(0, y0, 0, y0 + rh);
      grd.addColorStop(0, b.bg[0]);
      grd.addColorStop(1, b.bg[1]);
      g.fillStyle = grd;
      g.fillRect(0, y0, w, rh);
      g.fillStyle = 'rgba(255,255,255,0.10)';
      g.fillRect(0, y0 + 6, w, 4);
      let size = 82;
      const font = (s) => `900 ${s}px "Arial Black", "Helvetica Neue", Arial, sans-serif`;
      g.font = font(size);
      while (g.measureText(b.name).width > 700 && size > 30) g.font = font((size -= 2));
      const tw = g.measureText(b.name).width;
      g.fillStyle = b.fg;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(b.name, w / 2 + 30, y0 + rh / 2 + 3);
      drawMark(g, b.mark, w / 2 - tw / 2 - 40, y0 + rh / 2, rh * 0.62, b.fg);
    });
  });
  atlas.wrapS = THREE.RepeatWrapping;
  const rowV = (r) => [1 - (r + 1) / ATLAS_ROWS + 4 / 1024, 1 - r / ATLAS_ROWS - 4 / 1024];

  // pit binası cephesi: alt kat 10 garaj (takım renkleri), üst kat cam (misafir salonu)
  const facadeTex = canvasTex(2048, 512, (g, w, h) => {
    g.fillStyle = '#d7dadd';
    g.fillRect(0, 0, w, h);
    // üst kat cam bandı
    const gy0 = h * 0.08, gy1 = h * 0.44;
    const glass = g.createLinearGradient(0, gy0, 0, gy1);
    glass.addColorStop(0, '#5d7f9e');
    glass.addColorStop(0.5, '#2b4660');
    glass.addColorStop(1, '#1b2c3d');
    g.fillStyle = glass;
    g.fillRect(0, gy0, w, gy1 - gy0);
    g.fillStyle = 'rgba(255,255,255,0.18)';
    for (let x = 0; x < w; x += 160) g.fillRect(x + 20, gy0, 40, gy1 - gy0);
    g.fillStyle = '#9aa3aa';
    for (let x = 0; x < w; x += 64) g.fillRect(x, gy0, 5, gy1 - gy0);
    g.fillStyle = '#eceff1';
    g.fillRect(0, gy1, w, h * 0.06);
    // garajlar
    const gw = w / 10;
    for (let i = 0; i < 10; i++) {
      const x0 = i * gw;
      g.fillStyle = TEAMS[i];
      g.fillRect(x0 + 6, h * 0.53, gw - 12, h * 0.07);
      g.fillStyle = '#26292c';
      g.fillRect(x0 + 14, h * 0.61, gw - 28, h * 0.39);
      const inner = g.createLinearGradient(0, h * 0.61, 0, h);
      inner.addColorStop(0, 'rgba(255,255,255,0.10)');
      inner.addColorStop(1, 'rgba(255,255,255,0.0)');
      g.fillStyle = inner;
      g.fillRect(x0 + 14, h * 0.61, gw - 28, h * 0.39);
      g.fillStyle = TEAMS[i];
      g.globalAlpha = 0.55;
      g.fillRect(x0 + 30, h * 0.66, gw - 60, h * 0.05);
      g.globalAlpha = 1;
      g.fillStyle = '#b0b5b9';
      g.fillRect(x0, h * 0.53, 6, h * 0.47);
    }
  });
  facadeTex.wrapS = THREE.RepeatWrapping;

  // ---------- malzemeler ----------
  const timeU = { value: 0 };
  const mats = {
    struct: new THREE.MeshLambertMaterial({ vertexColors: true }),
    metal: new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.55, roughness: 0.42, envMap }),
    glass: new THREE.MeshStandardMaterial({ color: 0x29405a, metalness: 0.9, roughness: 0.1, envMap }),
    boards: new THREE.MeshLambertMaterial({ map: atlas, emissive: 0xffffff, emissiveMap: atlas, emissiveIntensity: 0.3 }),
    facade: new THREE.MeshStandardMaterial({ map: facadeTex, roughness: 0.42, metalness: 0.2, envMap }),
    canopy: new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.4, roughness: 0.45, side: THREE.DoubleSide, envMap }),
    crowd: new THREE.MeshLambertMaterial({ color: 0xffffff }),
    flag: new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }),
    tyre: new THREE.MeshLambertMaterial({ color: 0x1c1c1c }),
  };
  // seyirci: gövde = örnek rengi (tişört), baş = örnek numarasından ten rengi/şapka; bazıları zıplar
  mats.crowd.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = timeU;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aPart;\nuniform float uTime;\nfloat cHash(float n){ return fract(sin(n) * 43758.5453); }')
      .replace(
        '#include <color_vertex>',
        `#include <color_vertex>
        float cId = float(gl_InstanceID);
        float cH1 = cHash(cId * 1.37 + 0.11);
        float cH2 = cHash(cId * 2.71 + 0.37);
        #ifdef USE_INSTANCING_COLOR
          vec3 cSkin = mix(vec3(0.70, 0.46, 0.33), vec3(0.17, 0.09, 0.05), cH2 * cH2);
          vec3 cHead = mix(cSkin, instanceColor.rgb * 0.8, step(0.82, cHash(cId * 5.13 + 0.7)));
          vColor.rgb = mix(vColor.rgb, cHead, aPart);
        #endif`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        transformed.y += step(0.88, cH1) * max(0.0, sin(uTime * (5.0 + 3.0 * cH2) + cH1 * 40.0)) * 0.14;`,
      );
  };
  mats.flag.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = timeU;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aWave;\nuniform float uTime;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        float fPh = fract(sin(float(gl_InstanceID) * 7.13) * 43758.5453) * 6.2832;
        transformed.z += sin(uTime * 6.5 + position.x * 5.5 + fPh) * 0.11 * aWave;
        transformed.y -= 0.05 * aWave * aWave;`,
      );
  };

  // ---------- örnek geometrileri ----------
  const personGeo = (() => {
    const b = new Batch();
    const body = new THREE.CylinderGeometry(0.3, 0.26, 0.6, 4, 1, false);
    body.rotateY(Math.PI / 4);
    b.add(body, new THREE.Matrix4().compose(new THREE.Vector3(0, 0.3, 0), new THREE.Quaternion(), new THREE.Vector3(1, 1, 0.62)), 0xffffff);
    const nBody = b.p.length / 3;
    const head = new THREE.OctahedronGeometry(0.125, 0);
    b.add(head, new THREE.Matrix4().compose(new THREE.Vector3(0, 0.74, 0), new THREE.Quaternion(), new THREE.Vector3(1, 1.2, 1)), 0xffffff);
    body.dispose();
    head.dispose();
    const g = b.build();
    g.deleteAttribute('color');
    const part = new Float32Array(g.attributes.position.count);
    for (let i = nBody; i < part.length; i++) part[i] = 1;
    g.setAttribute('aPart', new THREE.BufferAttribute(part, 1));
    return g;
  })();
  const flagGeo = (() => {
    const b = new Batch();
    b.add(unitBox, new THREE.Matrix4().compose(new THREE.Vector3(0, 0.95, 0), new THREE.Quaternion(), new THREE.Vector3(0.035, 1.9, 0.035)), 0x3a3a3a);
    const nPole = b.p.length / 3;
    const cloth = new THREE.PlaneGeometry(1.0, 0.62, 6, 1);
    b.add(cloth, new THREE.Matrix4().makeTranslation(0.5, 1.58, 0), 0xffffff);
    cloth.dispose();
    const g = b.build();
    const w = new Float32Array(g.attributes.position.count);
    const pos = g.attributes.position;
    for (let i = nPole; i < w.length; i++) w[i] = Math.max(0, pos.getX(i)) / 1.0;
    g.setAttribute('aWave', new THREE.BufferAttribute(w, 1));
    return g;
  })();
  const tyreGeo = new THREE.CylinderGeometry(0.31, 0.31, 0.95, 10, 1, false);

  // ---------- bölgeler ----------
  const sites = [];
  function newSite(name) {
    const s = { name, struct: new Batch(), metal: new Batch(), glass: new Batch(), canopy: new Batch(), facade: new Batch(true), crowd: [], pts: [], meshes: [] };
    sites.push(s);
    return s;
  }
  const boards = new Batch(true); // tüm reklam yüzeyleri (tek çizim)
  const flagsRec = []; // { m: Matrix4, c: Color }
  const tyresRec = [];
  const stats = { modules: 0, people: 0, flags: 0, tyres: 0, posts: 0, poles: 0, bridges: 0, banners: 0, at: { bridges: [], cornerStands: [], tyres: [], posts: [] } };
  const coverage = { 1: new Uint8Array(n), [-1]: new Uint8Array(n) }; // afiş kapsama işaretleri
  const markCover = (k0, k1, side) => {
    for (let k = k0; k <= k1; k++) coverage[side][wrapK(k)] = 1;
  };
  const addFlag = (x, y, z, rotY, scale, color) => {
    const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(UP, rotY), new THREE.Vector3(scale, scale, scale));
    flagsRec.push({ m, c: new THREE.Color(color) });
  };

  // afiş şeridi: pist boyunca ofsette, [y0, y1] yüksekliklerinde, piste bakan; marka satırı `row`
  function bannerStrip(kStart, kEnd, side, oM, y0, y1, row, batch = boards) {
    const step = Math.max(1, Math.round(1.6 / dsM));
    const [v0, v1] = rowV(row);
    let s = 0, prev = null;
    for (let kk = kStart; kk < kEnd; kk += step) {
      const ka = wrapK(kk), kb = wrapK(Math.min(kk + step, kEnd));
      const [ax, az] = offPt(ka, side, oM), [bx, bz] = offPt(kb, side, oM);
      const seg = Math.hypot(bx - ax, bz - az);
      const ua = (side > 0 ? -s : s) / BANNER_M, ub = (side > 0 ? -(s + seg) : s + seg) / BANNER_M;
      const [nx, nz] = nrm(ka, side);
      batch.quad([ax, EL(ka) + y0, az], [bx, EL(kb) + y0, bz], [bx, EL(kb) + y1, bz], [ax, EL(ka) + y1, az], 0xffffff, [-nx, 0, -nz], [[ua, v0], [ub, v0], [ub, v1], [ua, v1]]);
      s += seg;
      prev = kb;
    }
    return prev;
  }

  // ---------- tribün modülü ----------
  // k: pist indisi, side: ±1, o: { L, rows, front, rd, rise, hb, roof, seat }
  function standModule(site, k, side, o) {
    const [nx, nz] = nrm(k, side);
    const ox = PX(k) + nx * o.front, oz = PZ(k) + nz * o.front, oy = EL(k);
    const R = o.rows, rd = o.rd, rise = o.rise, L = o.L;
    const D = R * rd + 1.9;
    const over = o.roof ? 1.6 : 0;
    const rect = mkRect(ox + nx * (D / 2 - over / 2), oz + nz * (D / 2 - over / 2), nz, -nx, L / 2, D / 2 + over / 2);
    if (!rectFree(rect, WALL + 1.0)) return null;
    const gr = rectGround(rect);
    const yb = Math.min(gr.mn, oy - 2.5) - oy - 0.8;
    const F = frame(ox, oy, oz, nx, nz);
    const concrete = o.roof ? 0xc4c4bf : 0x9aa0a6;
    // basamaklı gövde (profil kesiti boyuna uzatılır)
    const sh = new THREE.Shape();
    const yAt = (r) => o.hb + r * rise;
    sh.moveTo(0, yb);
    sh.lineTo(0, yAt(0));
    for (let r = 0; r < R; r++) {
      sh.lineTo((r + 1) * rd, yAt(r));
      if (r < R - 1) sh.lineTo((r + 1) * rd, yAt(r + 1));
    }
    const yTop = yAt(R - 1);
    sh.lineTo(R * rd + 1.6, yTop);
    sh.lineTo(R * rd + 1.6, yTop + 1.1);
    sh.lineTo(D, yTop + 1.1);
    sh.lineTo(D, yb);
    sh.lineTo(0, yb);
    const ex = new THREE.ExtrudeGeometry(sh, { depth: L, bevelEnabled: false, steps: 1, curveSegments: 1 });
    const map = new THREE.Matrix4().set(0, 0, -1, L / 2, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1);
    site.struct.add(ex, new THREE.Matrix4().multiplyMatrices(F, map), concrete);
    ex.dispose();
    // ön korkuluk + koltuk sıraları
    box(site.struct, F, 0, yAt(0) + 0.5, 0.1, L, 1.0, 0.2, o.roof ? 0xe8e8e4 : 0xb0b6bb);
    for (let r = 0; r < R; r++) box(site.struct, F, 0, yAt(r) + 0.2, r * rd + rd * 0.68, L - 0.5, 0.4, 0.34, o.seat);
    // merdiven yolları (açık renk şerit)
    {
      const dy = yTop - yAt(0), dz = (R - 1) * rd;
      for (const sx of [-L / 2 + 0.55, L / 2 - 0.55]) box(site.struct, F, sx, (yAt(0) + yTop) / 2 - 0.05, rd * 0.5 + dz / 2, 0.9, 0.3, Math.hypot(dy, dz) + rd, 0xdedbd2, -Math.atan2(dy, dz));
    }
    if (o.roof) {
      const yRB = yTop + 4.6, yRF = yTop + 5.6;
      const z0 = -over, z1 = D + 0.2;
      const len = Math.hypot(z1 - z0, yRF - yRB);
      box(site.struct, F, 0, (yRF + yRB) / 2 + 0.2, (z0 + z1) / 2, L + 0.2, 0.35, len, 0xeef1f3, Math.atan2(yRF - yRB, z1 - z0));
      // çatı altı: gerçekte yansıyan ışıkla açık gri görünür; aşağı bakan normal yerine piste dönük normal ile aydınlat
      {
        const yU = (z) => yRB + ((yRF - yRB) * (z1 - z)) / (z1 - z0) + 0.0;
        const sn = new THREE.Vector3(-nx * 0.35, 1, -nz * 0.35).normalize().toArray();
        site.struct.quad(local(F, -L / 2, yU(z0) - 0.01, z0), local(F, L / 2, yU(z0) - 0.01, z0), local(F, L / 2, yU(z1) - 0.01, z1), local(F, -L / 2, yU(z1) - 0.01, z1), 0x8e959b, [0, -1, 0], null, sn);
      }
      // arka kaplama ve kolonlar
      box(site.struct, F, 0, (yTop + 1.1 + yRB) / 2, D - 0.15, L, yRB - yTop - 1.1, 0.3, 0xa7adb2);
      for (const cx of [-L / 2 + 0.3, L / 2 - 0.3]) {
        box(site.metal, F, cx, (yTop + yRF) / 2, 0.2, 0.28, yRF - yTop + 0.3, 0.28, 0x8d969e);
        box(site.metal, F, cx, (yAt(0) + yTop) / 2, 0.2, 0.28, yTop - yAt(0), 0.28, 0x8d969e);
      }
      // çatı alnında reklam panosu (piste bakar)
      const row = o.brand ?? Math.floor(rnd() * BRANDS.length);
      const [v0, v1] = rowV(row);
      const a = local(F, L / 2, yRF - 0.75, z0 - 0.05), b = local(F, -L / 2, yRF - 0.75, z0 - 0.05);
      const c = local(F, -L / 2, yRF + 0.55, z0 - 0.05), d = local(F, L / 2, yRF + 0.55, z0 - 0.05);
      const uMax = L / (BANNER_M * 1.3);
      boards.quad(a, b, c, d, 0xffffff, [-nx, 0, -nz], [[0, v0], [uMax, v0], [uMax, v1], [0, v1]]);
      stats.banners++;
      // çatıda büyük bayrak (her iki modülde bir)
      if (rnd() < 0.5) {
        const p = local(F, (rnd() - 0.5) * L * 0.8, yRB + 0.3, D - 0.6);
        addFlag(p[0], p[1], p[2], Math.atan2(nx, nz) + (rnd() - 0.5) * 0.6, 2.8, pick(FLAGS));
      }
    } else {
      // açık (geçici) tribün: arka çit ve iskele dikmeleri
      box(site.metal, F, 0, yTop + 1.6, D - 0.05, L, 1.0, 0.08, 0x9e9e9e);
      for (let i = 0; i <= 4; i++) {
        const cx = -L / 2 + (i * L) / 4;
        box(site.metal, F, cx, (yb + yTop) / 2, D - 0.05, 0.22, yTop - yb, 0.22, 0x7f8a93);
      }
    }
    // seyirciler
    const dens = o.density ?? 0.88;
    const shade = o.roof ? 0.78 : 1;
    const groupShirt = rnd() < 0.5 ? pick(SHIRTS) : null;
    for (let r = 0; r < R; r++) {
      const y = yAt(r) + 0.38;
      const z = r * rd + rd * 0.52;
      for (let x = -L / 2 + 0.75; x <= L / 2 - 0.75; x += 0.6) {
        if (rnd() > dens) continue;
        const xx = x + (rnd() - 0.5) * 0.12;
        const p = local(F, xx, y, z);
        const s = 0.92 + rnd() * 0.18;
        const m = new THREE.Matrix4().compose(new THREE.Vector3(p[0], p[1], p[2]), new THREE.Quaternion().setFromAxisAngle(UP, Math.atan2(nx, nz) + Math.PI + (rnd() - 0.5) * 0.5), new THREE.Vector3(s, s, s));
        const col = new THREE.Color(groupShirt && rnd() < 0.35 ? groupShirt : pick(SHIRTS)).multiplyScalar(shade * (0.82 + rnd() * 0.3));
        site.crowd.push({ m, c: col });
        if (rnd() < 0.03) addFlag(p[0], p[1] + 0.25, p[2], Math.atan2(nx, nz) + (rnd() - 0.5) * 0.9, 1, pick(FLAGS));
      }
    }
    occupied.push(rect);
    site.pts.push([ox + nx * D * 0.5, oy + 6, oz + nz * D * 0.5]);
    stats.modules++;
    const half = kOfM(L / 2 + 1);
    markCover(k - half, k + half, side);
    return { rect, F, ox, oz };
  }

  // ardışık tribün modülleri: [k0, k1] aralığında, `side` tarafında
  function standRow(site, k0, k1, side, o, maxModules = 99) {
    let last = null, count = 0;
    const stepK = Math.max(1, kOfM(1.5));
    for (let k = k0; k <= k1 && count < maxModules; k += stepK) {
      const kk = wrapK(k);
      const [x, z] = offPt(kk, side, o.front);
      if (last && Math.hypot(x - last[0], z - last[1]) < o.L + 0.6) continue;
      const res = standModule(site, kk, side, o);
      if (res) {
        last = [x, z];
        count++;
      }
    }
    return count;
  }

  // ---------- ana düzlük ----------
  let kA = 0, kB = 0;
  const dev = (k) => Math.abs(angDiff(t.tan[wrapK(k)], t.tan[0]));
  while (kA > -kOfM(800) && dev(kA - 1) < 0.15) kA--;
  while (kB < kOfM(1000) && dev(kB + 1) < 0.15) kB++;
  const straightLen = (kB - kA) * dsM;

  // ---------- pit kompleksi ----------
  const PIT = { lane0: WALL + 0.1, lane1: WALL + 14, bld0: WALL + 14.6, bld1: WALL + 33, h: 11.5 };
  let pitSide = 0, pitK0 = 0, pitK1 = 0;
  {
    const bandFree = (k, side) => [PIT.lane0 + 1.5, (PIT.lane1 + PIT.bld0) / 2, PIT.bld1 + 7.5].every((o) => {
      const [x, z] = offPt(wrapK(k), side, o);
      return clearOK(x, z, WALL + 0.5);
    });
    const lo = kA + kOfM(18), hi = kB - kOfM(60);
    let best = null;
    for (const side of [1, -1]) {
      // pit hattına uygun en uzun kesintisiz aralık
      let runS = null;
      const runs = [];
      for (let k = lo; k <= hi + 1; k++) {
        const ok = k <= hi && bandFree(k, side);
        if (ok && runS === null) runS = k;
        if (!ok && runS !== null) {
          runs.push([runS, k - 1]);
          runS = null;
        }
      }
      for (const [a, b] of runs) {
        const len = (b - a) * dsM;
        const has0 = a <= 0 && b >= 0;
        const score = len + (has0 ? 400 : 0) + (insideLoop(...offPt(0, side, 40)) ? 0 : 30);
        if (len >= 110 && (!best || score > best.score)) best = { side, a, b, score };
      }
    }
    if (best) {
      pitSide = best.side;
      const maxLen = kOfM(Math.min(420, Math.max(160, straightLen * 0.62)));
      pitK0 = Math.max(best.a, -kOfM(150));
      pitK1 = Math.min(best.b, pitK0 + maxLen);
      if (pitK1 - pitK0 < kOfM(110)) pitSide = 0;
    }
  }
  if (pitSide) {
    const site = newSite('pit');
    const side = pitSide;
    const ks = [];
    const st = Math.max(1, kOfM(2));
    for (let k = pitK0; k < pitK1; k += st) ks.push(wrapK(k));
    ks.push(wrapK(pitK1));
    const pts = (o) => ks.map((k) => offPt(k, side, o));
    // süpürülmüş kutu: iç [oA] → dış [oB] ofsetleri, alt/üst yükseklik
    const sweep = (batch, oA, oB, yBot, yTop, colTop, colSide, faces = 'tfbc') => {
      const A = pts(oA), B = pts(oB);
      for (let i = 0; i < ks.length - 1; i++) {
        const [nx, nz] = nrm(ks[i], side);
        const a0 = [A[i][0], yBot(i, oA), A[i][1]], a1 = [A[i + 1][0], yBot(i + 1, oA), A[i + 1][1]];
        const b0 = [B[i][0], yBot(i, oB), B[i][1]], b1 = [B[i + 1][0], yBot(i + 1, oB), B[i + 1][1]];
        const at0 = [A[i][0], yTop(i), A[i][1]], at1 = [A[i + 1][0], yTop(i + 1), A[i + 1][1]];
        const bt0 = [B[i][0], yTop(i), B[i][1]], bt1 = [B[i + 1][0], yTop(i + 1), B[i + 1][1]];
        if (faces.includes('t')) batch.quad(at0, bt0, bt1, at1, colTop, [0, 1, 0]);
        if (faces.includes('f')) batch.quad(a0, a1, at1, at0, colSide, [-nx, 0, -nz]);
        if (faces.includes('b')) batch.quad(b0, b1, bt1, bt0, colSide, [nx, 0, nz]);
      }
      if (faces.includes('c')) {
        for (const [i, dir] of [[0, -1], [ks.length - 1, 1]]) {
          const [tx, tz] = tng(ks[i]);
          batch.quad([A[i][0], yBot(i, oA), A[i][1]], [B[i][0], yBot(i, oB), B[i][1]], [B[i][0], yTop(i), B[i][1]], [A[i][0], yTop(i), A[i][1]], colSide, [tx * dir, 0, tz * dir]);
        }
      }
    };
    const ground = (i, o) => {
      const [x, z] = offPt(ks[i], side, o);
      return Math.min(groundAt(x, z), EL(ks[i]) - 2.5) - 0.6;
    };
    // pit yolu tabliyesi (pist seviyesinde) + beyaz çizgi
    sweep(site.struct, PIT.lane0, PIT.lane1, ground, (i) => EL(ks[i]) + 0.03, 0x45484c, 0x8f918c);
    sweep(site.struct, PIT.lane0 + 6.6, PIT.lane0 + 6.85, (i) => EL(ks[i]) + 0.035, (i) => EL(ks[i]) + 0.045, 0xf2f2f2, 0xf2f2f2, 't');
    sweep(site.struct, PIT.lane1 - 0.3, PIT.lane1 + 0.6, (i) => EL(ks[i]) + 0.03, (i) => EL(ks[i]) + 0.16, 0xe0e0e0, 0xbdbdbd, 'tf');
    // garaj binası
    sweep(site.struct, PIT.bld0, PIT.bld1, ground, (i) => EL(ks[i]) + PIT.h, 0x9ea4a9, 0xcfd2d4, 'tbc');
    // cephe (doku): pit yolu tarafı ve padok tarafı (garajlar iki yana da açılır)
    for (const [oF, dir] of [[PIT.bld0 - 0.03, -1], [PIT.bld1 + 0.03, 1]]) {
      const A = pts(oF);
      let s = 0;
      for (let i = 0; i < ks.length - 1; i++) {
        const seg = Math.hypot(A[i + 1][0] - A[i][0], A[i + 1][1] - A[i][1]);
        const [nx, nz] = nrm(ks[i], side);
        const sg = side * -dir;
        const ua = (sg > 0 ? -s : s) / 130, ub = (sg > 0 ? -(s + seg) : s + seg) / 130;
        site.facade.quad([A[i][0], EL(ks[i]) + 0.03, A[i][1]], [A[i + 1][0], EL(ks[i + 1]) + 0.03, A[i + 1][1]], [A[i + 1][0], EL(ks[i + 1]) + PIT.h - 0.1, A[i + 1][1]], [A[i][0], EL(ks[i]) + PIT.h - 0.1, A[i][1]], 0xffffff, [nx * dir, 0, nz * dir], [[ua, 0], [ub, 0], [ub, 1], [ua, 1]]);
        s += seg;
      }
    }
    // padok tarafında zemin (bina arkasında yürüme alanı)
    sweep(site.struct, PIT.bld1, PIT.bld1 + 7, ground, (i) => EL(ks[i]) + 0.02, 0xb7b2a6, 0x8f918c, 'tb');
    // çatı saçağı + alnında reklam bandı
    sweep(site.struct, PIT.bld0 - 3.2, PIT.bld0 + 0.2, (i) => EL(ks[i]) + PIT.h - 0.45, (i) => EL(ks[i]) + PIT.h + 0.05, 0xf4f6f7, 0xe3e6e8);
    {
      let k = pitK0;
      let row = 0;
      while (k < pitK1 - kOfM(10)) {
        const kEnd = Math.min(pitK1, k + kOfM(24));
        bannerStrip(k, kEnd, side, PIT.bld0 - 3.25, PIT.h - 0.45 + 0.05, PIT.h + 1.25, row++ % BRANDS.length);
        stats.banners++;
        k = kEnd + kOfM(1);
      }
    }
    // pit duvarı ekip standları (pit yolu tarafında)
    for (let k = pitK0 + kOfM(14); k < pitK1 - kOfM(8); k += kOfM(26)) {
      const kk = wrapK(k);
      const [nx, nz] = nrm(kk, side);
      const [x, z] = offPt(kk, side, WALL + 1.25);
      const F = frame(x, EL(kk), z, nx, nz);
      const team = TEAMS[Math.floor(rnd() * TEAMS.length)];
      box(site.struct, F, 0, 0.55, 0, 8, 1.1, 1.8, 0x5f656b);
      box(site.struct, F, 0, 1.5, -0.55, 7.6, 0.8, 0.12, 0x1d2329);
      box(site.struct, F, 0, 2.55, 0.1, 8.6, 0.16, 2.6, team);
      for (const cx of [-3.9, 3.9]) box(site.metal, F, cx, 1.6, 0.8, 0.12, 2.0, 0.12, 0x9aa3ab);
    }
    // yarış kontrol kulesi (binanın başında)
    {
      const kk = wrapK(pitK0 - kOfM(9));
      const [nx, nz] = nrm(kk, side);
      const [x, z] = offPt(kk, side, (PIT.bld0 + PIT.bld1) / 2);
      const rect = mkRect(x, z, nz, -nx, 8, (PIT.bld1 - PIT.bld0) / 2);
      if (rectFree(rect, WALL + 0.5)) {
        const F = frame(x, EL(kk), z, nx, nz);
        const g = rectGround(rect);
        const yb = Math.min(g.mn, EL(kk) - 2.5) - EL(kk) - 0.6;
        const Hc = 24;
        box(site.struct, F, 0, (yb + Hc - 4.5) / 2, 0, 14, Hc - 4.5 - yb, PIT.bld1 - PIT.bld0, 0xd5d8da);
        box(site.glass, F, 0, Hc - 2.5, 0, 14.6, 4, PIT.bld1 - PIT.bld0 + 0.6, 0xffffff);
        box(site.struct, F, 0, Hc - 0.2, 0, 16, 0.6, PIT.bld1 - PIT.bld0 + 2, 0xf0f2f3);
        const [v0, v1] = rowV(0);
        const a = local(F, 7.3, Hc - 6.8, -(PIT.bld1 - PIT.bld0) / 2 - 0.05), b = local(F, -7.3, Hc - 6.8, -(PIT.bld1 - PIT.bld0) / 2 - 0.05);
        const c = local(F, -7.3, Hc - 5.0, -(PIT.bld1 - PIT.bld0) / 2 - 0.05), d = local(F, 7.3, Hc - 5.0, -(PIT.bld1 - PIT.bld0) / 2 - 0.05);
        boards.quad(a, b, c, d, 0xffffff, [-nx, 0, -nz], [[0, v0], [1, v0], [1, v1], [0, v1]]);
        occupied.push(rect);
        site.pts.push([x, EL(kk) + 12, z]);
      }
    }
    // yer kaplama dikdörtgenleri (ağaçlar/diğer yapılar girmesin)
    const chunk = kOfM(30);
    for (let k = pitK0; k < pitK1; k += chunk) {
      const ka = wrapK(k), kb = wrapK(Math.min(pitK1, k + chunk));
      const mid = (PIT.lane0 + PIT.bld1 + 7) / 2;
      const [ax, az] = offPt(ka, side, mid), [bx, bz] = offPt(kb, side, mid);
      const len = Math.hypot(bx - ax, bz - az) || 1;
      occupied.push(mkRect((ax + bx) / 2, (az + bz) / 2, (bx - ax) / len, (bz - az) / len, len / 2 + 1, (PIT.bld1 + 7 - PIT.lane0) / 2 + 0.5));
      site.pts.push([(ax + bx) / 2, EL(ka) + 6, (az + bz) / 2]);
    }
    markCover(pitK0, pitK1, side);
  }

  // ---------- Austin: gözlem kulesi (T12–T15 iç sahası) ----------
  if (t.id === 'austin') buildTower();
  function buildTower() {
    // T12..T15 bölgesinin ağırlık merkezi (pist uzunluğunun ~%69-%79'u)
    const kS = Math.round(n * 0.692), kE = Math.round(n * 0.785);
    let cx = 0, cz = 0, cnt = 0;
    for (let k = kS; k <= kE; k++) {
      cx += PX(k);
      cz += PZ(k);
      cnt++;
    }
    cx /= cnt;
    cz /= cnt;
    let best = null;
    for (let dx = -260; dx <= 260; dx += 5)
      for (let dz = -260; dz <= 260; dz += 5) {
        const x = cx + dx, z = cz + dz;
        const d = nearest(x, z, 140).d;
        if (d < WALL + 18) continue;
        if (!freeAt(x / K, z / K, (WALL + 18) / K)) continue;
        const score = Math.min(d, WALL + 48) - 0.22 * Math.hypot(dx, dz);
        if (!best || score > best.score) best = { x, z, d, score };
      }
    if (!best) return;
    const site = newSite('tower');
    const { x, z } = best;
    const Rc = Math.max(10, Math.min(26, best.d - WALL - 6)); // kanopi yarıçapı
    let gmin = Infinity, gmax = -Infinity;
    for (let a = 0; a < 12; a++)
      for (const r of [0, Rc * 0.5, Rc + 2]) {
        const h = groundAt(x + Math.cos(a * 0.5236) * r, z + Math.sin(a * 0.5236) * r);
        gmin = Math.min(gmin, h);
        gmax = Math.max(gmax, h);
      }
    const g0 = gmax + 0.12; // meydan zemini
    // kanopi yönü: en açık taraf
    let bestA = 0, bestD = -1;
    for (let a = 0; a < 16; a++) {
      const ang = (a / 16) * Math.PI * 2;
      const d = nearest(x + Math.cos(ang) * (Rc + 10), z + Math.sin(ang) * (Rc + 10), 120).d;
      if (d > bestD) {
        bestD = d;
        bestA = ang;
      }
    }
    // meydan
    cylY(site.struct, x, gmin - 0.6, z, Rc + 4, g0, 0xcfc8bb, cg(1, 1, 1, 28));
    cylY(site.struct, x, g0, z, 9.5, g0 + 0.5, 0x9e9e9e, cg(1, 1, 1, 20));
    const H = 77, deck = 66;
    // çekirdek (asansör kulesi)
    cylY(site.struct, x, g0, z, 2.1, deck + 4.2, 0xe6e6e2, cg(1, 1, 1, 14, 1, true));
    // kırmızı çelik "peçe": iki yönde bükülmüş borular → hiperboloid kafes
    const RED = 0xc62828;
    const N = 24, RB = 8.2, RT = 6.6, TW = 1.9;
    // f oranındaki yükseklikte peçenin yarıçapı (düz boru → hiperboloid)
    const rAt = (f) => Math.hypot((1 - f) * RB + f * RT * Math.cos(TW), f * RT * Math.sin(TW));
    for (const tw of [1, -1])
      for (let i = 0; i < N; i++) {
        const a0 = (i / N) * Math.PI * 2;
        const a1 = a0 + tw * TW;
        tube(site.metal, [x + Math.cos(a0) * RB, g0 + 0.5, z + Math.sin(a0) * RB], [x + Math.cos(a1) * RT, g0 + deck - 0.4, z + Math.sin(a1) * RT], 0.2, RED);
      }
    // halkalar (borulara değecek yarıçapta)
    for (const f of [0.3, 0.62]) cylY(site.metal, x, g0 + 0.5 + f * (deck - 0.9), z, rAt(f) + 0.12, g0 + 0.9 + f * (deck - 0.9), 0xb71c1c, cg(1, 1, 1, 24, 1, true));
    // gözlem diski: döşeme, cam bant, çatı, tepe direği
    cylY(site.struct, x, g0 + deck - 0.6, z, 10, g0 + deck, 0xf2f2f2, cg(1, 1, 1, 32));
    cylY(site.glass, x, g0 + deck, z, 9.2, g0 + deck + 3.2, 0xffffff, cg(1, 1, 1, 32, 1, true));
    cylY(site.struct, x, g0 + deck + 3.2, z, 10.6, g0 + deck + 4.0, 0xf5f5f5, cg(1, 1, 1, 32));
    cylY(site.metal, x, g0 + deck + 4.0, z, 3.2, g0 + deck + 5.4, RED, cg(0.4, 1, 1, 16));
    cylY(site.metal, x, g0 + deck + 5.4, z, 0.25, g0 + H, 0xd0d0d0, cg(0.4, 1, 1, 6));
    // tabanda süpürülen kırmızı kanopi: borular + aralarında örtü
    const NC = 30, SEG = 12, spread = 1.35;
    const curves = [];
    for (let i = 0; i < NC; i++) {
      const f = i / (NC - 1);
      const ang = bestA + (f - 0.5) * 2 * spread;
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const r0 = rAt((26 - 0.5) / (deck - 0.9)) + 0.25;
      const p0 = new THREE.Vector3(x + ca * r0, g0 + 26, z + sa * r0);
      const p1 = new THREE.Vector3(x + ca * (Rc * 0.45), g0 + 27.5, z + sa * (Rc * 0.45));
      const p2 = new THREE.Vector3(x + ca * Rc * 0.95, g0 + 12, z + sa * Rc * 0.95);
      const p3 = new THREE.Vector3(x + ca * Rc, g0 + 0.2, z + sa * Rc);
      const curve = new THREE.CubicBezierCurve3(p0, p1, p2, p3);
      curves.push(curve.getPoints(SEG));
      const tg = new THREE.TubeGeometry(curve, SEG, 0.17, 5, false);
      site.metal.add(tg, new THREE.Matrix4(), RED);
      tg.dispose();
    }
    for (let i = 0; i < NC - 1; i++)
      for (let j = 0; j < SEG - 4; j++) {
        const a = curves[i][j], b = curves[i + 1][j], c = curves[i + 1][j + 1], d = curves[i][j + 1];
        site.canopy.quad(a.toArray(), b.toArray(), c.toArray(), d.toArray(), j % 2 ? 0xd32f2f : 0xc62828, [0, 1, 0]);
      }
    // sahne
    {
      const sx = x + Math.cos(bestA) * Rc * 0.55, sz = z + Math.sin(bestA) * Rc * 0.55;
      const F = frame(sx, g0, sz, Math.cos(bestA), Math.sin(bestA));
      box(site.struct, F, 0, 0.6, 0, 16, 1.2, 9, 0x3a3f44);
    }
    occupied.push(mkRect(x, z, 1, 0, Rc + 4, Rc + 4));
    site.pts.push([x, g0 + 30, z], [x, g0 + H, z]);
    stats.tower = { x: +x.toFixed(1), z: +z.toFixed(1), clearance: +best.d.toFixed(1), canopy: +Rc.toFixed(1) };
  }

  // ---------- ana tribün (pitin karşısı) + düzlük boyunca ek tribünler ----------
  {
    const site = newSite('main-stands');
    const o = { L: 24, rows: 15, rd: 0.85, rise: 0.47, hb: 2.4, front: WALL + 3.2, roof: true, seat: pick(SEATS) };
    const other = pitSide ? -pitSide : 1;
    const a0 = Math.max(kA + kOfM(20), -kOfM(90)), a1 = Math.min(kB - kOfM(70), a0 + kOfM(Math.min(320, straightLen * 0.6)));
    standRow(site, a0, a1, other, o);
    if (pitSide) standRow(site, pitK1 + kOfM(14), kB - kOfM(60), pitSide, { ...o, seat: pick(SEATS), rows: 12 }, 5);
    else standRow(site, a0, a1, -other, { ...o, seat: pick(SEATS) });
  }

  // ---------- büyük virajlar: dış tarafta tribünler ----------
  const corners = [];
  {
    const W = kOfM(50);
    for (let k = 0; k < n; k++) {
      const a = Math.abs(turnAt(k));
      if (a < 1.0) continue;
      let peak = true;
      for (let j = -W; j <= W && peak; j += 2) if (Math.abs(turnAt(wrapK(k + j))) > a) peak = false;
      if (peak) corners.push({ k, turn: turnAt(k), mag: a });
    }
    corners.sort((p, q) => q.mag - p.mag);
    // eşit tepe değerli komşu indisler aynı viraj sayılır
    const arcK = (a, b) => Math.min(Math.abs(a - b), n - Math.abs(a - b));
    for (let i = corners.length - 1; i > 0; i--) if (corners.slice(0, i).some((c) => arcK(c.k, corners[i].k) < W * 1.5)) corners.splice(i, 1);
  }
  {
    const chosen = [];
    const arc = (a, b) => Math.min(Math.abs(a - b), n - Math.abs(a - b)) * dsM;
    for (const c of corners) {
      if (chosen.length >= 3) break;
      if (chosen.some((o) => arc(o.k, c.k) < 350)) continue;
      const side = c.turn > 0 ? -1 : 1; // virajın dışı
      const site = newSite('corner-' + c.k);
      const o = { L: 20, rows: 11, rd: 0.82, rise: 0.5, hb: 1.7, front: WALL + 4.5, roof: false, seat: pick(SEATS), density: 0.85 };
      const placed = standRow(site, c.k - kOfM(80), c.k + kOfM(80), side, o, 8);
      if (placed >= 2) {
        chosen.push(c);
        stats.at.cornerStands.push(Math.round(c.k * dsM));
      }
    }
  }

  // ---------- reklam köprüleri (uzun düzlüklerde, pistin üstünden) ----------
  {
    const site = newSite('bridges');
    const straightAt = (k) => Math.abs(turnAt(k, 60)) < 0.1;
    const runs = [];
    let s0 = null;
    for (let k = 0; k <= n; k++) {
      const ok = k < n && straightAt(k);
      if (ok && s0 === null) s0 = k;
      if (!ok && s0 !== null) {
        runs.push([s0, k - 1]);
        s0 = null;
      }
    }
    const inMain = (k) => {
      const kk = k > n / 2 ? k - n : k;
      return kk >= kA - kOfM(80) && kk <= kB + kOfM(40);
    };
    runs.sort((a, b) => b[1] - b[0] - (a[1] - a[0]));
    let built = 0;
    for (const [a, b] of runs) {
      if (built >= 2 || (b - a) * dsM < Math.max(120, Math.min(220, t.lengthMeters * 0.12))) break;
      for (const f of [0.38, 0.55, 0.7]) {
        const k = wrapK(a + (b - a) * f);
        if (inMain(k)) continue;
        const span = WALL + 3.4;
        const [tx, tz] = tng(k);
        const posts = [1, -1].map((s) => offPt(k, s, span));
        const rects = posts.map(([x, z]) => mkRect(x, z, tx, tz, 1.6, 1.6));
        if (!rects.every((r) => rectFree(r, WALL + 0.8))) continue;
        const [nx, nz] = nrm(k, 1);
        const F = frame(PX(k), EL(k), PZ(k), nx, nz); // X = pist boyunca(±), Z = karşıya
        const top = 8.6, bot = 7.0;
        for (const i of [0, 1]) {
          const [x, z] = posts[i];
          const gy = Math.min(groundAt(x, z), EL(k) - 2) - 0.5;
          for (const dx of [-0.9, 0.9]) {
            const p = [x + tx * dx, z + tz * dx];
            cylY(site.metal, p[0], gy, p[1], 0.32, EL(k) + top + 0.6, 0x9aa3ab);
          }
        }
        box(site.struct, F, 0, (top + bot) / 2, 0, 2.4, top - bot, span * 2 + 2.6, 0x37474f);
        box(site.metal, F, 0, top + 0.6, 0, 2.2, 0.08, span * 2 + 2.6, 0xb0bec5);
        // her iki yüzde reklam
        for (const face of [-1, 1]) {
          const row = Math.floor(rnd() * BRANDS.length);
          const [v0, v1] = rowV(row);
          const xF = face * 1.23;
          const zz = span + 1.2;
          const a1 = local(F, xF, bot + 0.1, -zz), b1 = local(F, xF, bot + 0.1, zz), c1 = local(F, xF, top - 0.1, zz), d1 = local(F, xF, top - 0.1, -zz);
          const uLen = (2 * zz) / (BANNER_M * 1.6);
          // yüz normali: face=-1 → gelen araçlara (−T) bakar
          const want = [tx * face, 0, tz * face];
          const flip = face < 0 ? 1 : -1;
          boards.quad(a1, b1, c1, d1, 0xffffff, want, [[0, v0], [uLen * flip, v0], [uLen * flip, v1], [0, v1]]);
        }
        rects.forEach((r) => occupied.push(r));
        site.pts.push([PX(k), EL(k) + 8, PZ(k)]);
        stats.bridges++;
        stats.at.bridges.push(Math.round(k * dsM));
        built++;
        break;
      }
    }
  }

  // ---------- görevli kulübeleri, ışık / TV direkleri ----------
  {
    const site = newSite('trackside');
    const stepPost = kOfM(t.lengthMeters > 2500 ? 290 : 200);
    for (let k = kOfM(120); k < n - kOfM(60); k += stepPost) {
      const kk = wrapK(k);
      const tr = turnAt(kk);
      const sides = Math.abs(tr) > 0.2 ? [tr > 0 ? -1 : 1, tr > 0 ? 1 : -1] : [1, -1];
      for (const side of sides) {
        const [nx, nz] = nrm(kk, side);
        const [x, z] = offPt(kk, side, WALL + 2.4);
        const rect = mkRect(x, z, nz, -nx, 1.4, 1.4);
        if (!rectFree(rect, WALL + 0.9)) continue;
        const F = frame(x, EL(kk), z, nx, nz);
        const gy = Math.min(groundAt(x, z), EL(kk) - 2) - EL(kk) - 0.5;
        box(site.struct, F, 0, gy / 2, 0, 2.6, -gy, 2.6, 0x8e8e8a);
        box(site.struct, F, 0, 1.15, 0, 2.3, 2.3, 2.3, 0xf3f3f0);
        box(site.struct, F, 0, 1.75, 0, 2.36, 0.35, 2.36, 0xff6d00);
        box(site.struct, F, 0, 1.35, -1.17, 1.9, 0.6, 0.04, 0x1f262c);
        box(site.struct, F, 0, 2.38, 0, 2.9, 0.16, 2.9, 0x55595d);
        const p = local(F, 1.1, 0, -1.2);
        addFlag(p[0], p[1], p[2], Math.atan2(nx, nz) + 0.3, 1.25, rnd() < 0.7 ? '#ffd600' : '#2e7d32');
        occupied.push(rect);
        site.pts.push([x, EL(kk) + 2, z]);
        stats.posts++;
        stats.at.posts.push(Math.round(kk * dsM));
        break;
      }
    }
    const stepPole = kOfM(t.lengthMeters > 2500 ? 230 : 150);
    let tv = 0;
    for (let k = kOfM(60); k < n - kOfM(30); k += stepPole) {
      const kk = wrapK(k);
      const tr = turnAt(kk);
      const side = Math.abs(tr) > 0.2 ? (tr > 0 ? -1 : 1) : tv % 2 ? 1 : -1;
      for (const sd of [side, -side]) {
        const [nx, nz] = nrm(kk, sd);
        const [x, z] = offPt(kk, sd, WALL + 5);
        const rect = mkRect(x, z, nz, -nx, 1.5, 1.5);
        if (!rectFree(rect, WALL + 1)) continue;
        const gy = Math.min(groundAt(x, z), EL(kk) - 1.8) - 0.4;
        const Hp = EL(kk) + (Math.abs(tr) > 0.6 ? 14 : 18);
        cylY(site.metal, x, gy, z, 0.24, Hp, 0x9aa3ab);
        const F = frame(x, Hp, z, nx, nz);
        if (Math.abs(tr) > 0.6) {
          // TV kamera platformu
          box(site.metal, F, 0, 0, 0, 2.6, 0.18, 2.6, 0x78848c);
          box(site.metal, F, 0, 0.55, 1.25, 2.6, 0.9, 0.06, 0x9aa3ab);
          box(site.struct, F, 0.3, 0.75, -0.2, 0.45, 0.5, 1.0, 0x263238);
          box(site.struct, F, 0.3, 0.75, -0.8, 0.28, 0.28, 0.3, 0x111111);
          box(site.struct, F, -0.6, 0.55, 0.3, 0.5, 0.9, 0.35, pick(SHIRTS));
          tv++;
        } else {
          // projektör başlığı
          box(site.metal, F, 0, 0.4, 0, 4.6, 0.25, 0.25, 0x9aa3ab);
          for (let i = 0; i < 6; i++) {
            const cx = -2.1 + i * 0.84;
            box(site.metal, F, cx, 0.95, -0.12, 0.62, 0.62, 0.3, 0x5d666e, 0.25);
            box(site.struct, F, cx, 0.95, -0.29, 0.52, 0.52, 0.02, 0xf5f3e6, 0.25);
          }
        }
        occupied.push(rect);
        site.pts.push([x, Hp, z]);
        stats.poles++;
        tv++;
        break;
      }
    }
  }

  // ---------- en keskin virajlarda lastik bariyerleri (dış taraf, duvarın önü) ----------
  {
    const site = newSite('tyres');
    const sharp = corners.slice(0, 4);
    for (const c of sharp) {
      const side = c.turn > 0 ? -1 : 1;
      stats.at.tyres.push(Math.round(c.k * dsM));
      for (const oM of [WALL - 0.42, WALL - 1.05]) {
        // ofset eğrisi boyunca her 0.64 m'de bir lastik yığını (örnekler arası doğrusal ara değer)
        let last = null, need = 0;
        for (let k = c.k - kOfM(30); k <= c.k + kOfM(55); k++) {
          const kk = wrapK(k);
          if (!offsetValid(kk, side, WALL)) {
            last = null;
            continue;
          }
          const [x, z] = offPt(kk, side, oM);
          const y = EL(kk) - 0.05 + 0.475;
          if (!last) {
            tyresRec.push(new THREE.Matrix4().makeTranslation(x, y, z));
            need = 0.64;
          } else {
            const seg = Math.hypot(x - last[0], z - last[1]);
            let d = need;
            while (d <= seg) {
              const f = d / seg;
              tyresRec.push(new THREE.Matrix4().makeTranslation(last[0] + (x - last[0]) * f, last[2] + (y - last[2]) * f, last[1] + (z - last[1]) * f));
              d += 0.64;
            }
            need = d - seg;
          }
          last = [x, z, y];
        }
      }
      // önde konveyör bant (kırmızı-beyaz şeritli)
      let segI = 0;
      const st = Math.max(1, kOfM(1.6));
      for (let k = c.k - kOfM(30); k < c.k + kOfM(55); k += st) {
        const ka = wrapK(k), kb = wrapK(k + st);
        if (!offsetValid(ka, side, WALL) || !offsetValid(kb, side, WALL)) continue;
        const oM = WALL - 1.42;
        const [ax, az] = offPt(ka, side, oM), [bx, bz] = offPt(kb, side, oM);
        const [nx, nz] = nrm(ka, side);
        site.struct.quad([ax, EL(ka) - 0.05, az], [bx, EL(kb) - 0.05, bz], [bx, EL(kb) + 0.95, bz], [ax, EL(ka) + 0.95, az], segI++ % 2 ? 0xf2f2f2 : 0xd32f2f, [-nx, 0, -nz]);
        site.struct.quad([ax, EL(ka) + 0.95, az], [bx, EL(kb) + 0.95, bz], ...(() => {
          const [cx2, cz2] = offPt(kb, side, WALL - 0.1), [dx2, dz2] = offPt(ka, side, WALL - 0.1);
          return [[cx2, EL(kb) + 0.95, cz2], [dx2, EL(ka) + 0.95, dz2]];
        })(), 0x2a2a2a, [0, 1, 0]);
      }
      markCover(c.k - kOfM(30), c.k + kOfM(55), side);
    }
    stats.tyres = tyresRec.length;
  }

  // ---------- çit afişleri ----------
  {
    // frenleme bölgeleri (virajdan önce) ve ana düzlük
    for (const c of corners) {
      for (const side of [1, -1]) if (rnd() < 0.7) markCover(c.k - kOfM(170), c.k - kOfM(15), side);
    }
    markCover(kA, kB, 1);
    markCover(kA, kB, -1);
    const bannerLen = 16, gap = 1.2;
    for (const side of [1, -1]) {
      const cov = coverage[side];
      let k = 0;
      while (k < n) {
        if (!cov[k] || !offsetValid(k, side, WALL)) {
          k++;
          continue;
        }
        // geçerli ve işaretli kesintisiz aralığı afişlere böl
        let kEnd = k;
        let len = 0;
        while (kEnd + 1 < n && cov[kEnd + 1] && offsetValid(kEnd + 1, side, WALL) && len < bannerLen) {
          kEnd++;
          len += dsM;
        }
        if (len > 4) {
          bannerStrip(k, kEnd, side, WALL - 0.04, 1.12, 2.02, Math.floor(rnd() * BRANDS.length));
          stats.banners++;
        }
        k = kEnd + Math.max(1, kOfM(gap));
      }
    }
  }

  // ---------- örnekli ağlar ve bölge ağlarının oluşturulması ----------
  const crowdGroups = [];
  const shadowMeshes = [];
  const shuffle = (arr) => {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  };
  for (const s of sites) {
    const add = (batch, mat, cast) => {
      if (batch.empty) return;
      const m = new THREE.Mesh(batch.build(), mat);
      m.name = s.name;
      m.castShadow = cast;
      m.receiveShadow = cast;
      root.add(m);
      s.meshes.push(m);
      if (cast) shadowMeshes.push(m);
    };
    add(s.struct, mats.struct, true);
    add(s.metal, mats.metal, true);
    add(s.glass, mats.glass, false);
    add(s.canopy, mats.canopy, true);
    add(s.facade, mats.facade, false);
    if (s.crowd.length) {
      shuffle(s.crowd);
      const im = new THREE.InstancedMesh(personGeo, mats.crowd, s.crowd.length);
      s.crowd.forEach((p, i) => {
        im.setMatrixAt(i, p.m);
        im.setColorAt(i, p.c);
      });
      im.instanceMatrix.needsUpdate = true;
      im.instanceColor.needsUpdate = true;
      im.computeBoundingSphere();
      im.name = s.name + '-crowd';
      root.add(im);
      const c = new THREE.Vector3();
      for (const p of s.pts) c.add(new THREE.Vector3(...p));
      c.divideScalar(s.pts.length || 1);
      crowdGroups.push({ mesh: im, total: s.crowd.length, center: c, radius: im.boundingSphere.radius });
      stats.people += s.crowd.length;
    }
  }
  if (!boards.empty) {
    const m = new THREE.Mesh(boards.build(), mats.boards);
    m.name = 'boards';
    root.add(m);
  }
  let flagMesh = null;
  if (flagsRec.length) {
    shuffle(flagsRec);
    flagMesh = new THREE.InstancedMesh(flagGeo, mats.flag, flagsRec.length);
    flagsRec.forEach((f, i) => {
      flagMesh.setMatrixAt(i, f.m);
      flagMesh.setColorAt(i, f.c);
    });
    flagMesh.computeBoundingSphere();
    flagMesh.name = 'flags';
    root.add(flagMesh);
    stats.flags = flagsRec.length;
  }
  if (tyresRec.length) {
    const im = new THREE.InstancedMesh(tyreGeo, mats.tyre, tyresRec.length);
    tyresRec.forEach((m, i) => im.setMatrixAt(i, m));
    im.computeBoundingSphere();
    im.name = 'tyres';
    root.add(im);
  }

  for (const g of tmpGeos) g.dispose();

  function applyQuality() {
    for (const g of crowdGroups) g.mesh.count = HI ? g.total : Math.ceil(g.total * 0.5);
    if (flagMesh) flagMesh.count = HI ? flagsRec.length : Math.ceil(flagsRec.length * 0.5);
    for (const m of shadowMeshes) {
      m.castShadow = HI;
      m.receiveShadow = HI;
    }
  }
  applyQuality();

  const camPos = new THREE.Vector3();
  return {
    root,
    stats,
    // ağaç vb. yerleşimler için: (px, py) noktası bir yapının ayak izinde mi?
    isOccupied(xPx, yPx, padPx = 0) {
      const x = xPx * K, z = yPx * K, pad = padPx * K;
      for (const r of occupied) {
        const dx = x - r.cx, dz = z - r.cz;
        if (Math.abs(dx * r.ux + dz * r.uz) <= r.hu + pad && Math.abs(dx * r.vx + dz * r.vz) <= r.hv + pad) return true;
      }
      return false;
    },
    setQuality(q) {
      HI = q === 'high';
      applyQuality();
    },
    update(dt, camera) {
      timeU.value += dt;
      if (!camera) return;
      camera.getWorldPosition(camPos);
      const lod = HI ? 650 : 420; // bu mesafeden uzaktaki seyirciler piksel altıdır → çizme
      for (const g of crowdGroups) g.mesh.visible = camPos.distanceTo(g.center) < g.radius + lod;
    },
    dispose() {
      scene.remove(root);
      root.traverse((o) => {
        if (o.geometry && o.geometry !== personGeo && o.geometry !== flagGeo && o.geometry !== tyreGeo) o.geometry.dispose();
        if (o.isInstancedMesh) o.dispose();
      });
      for (const g of [personGeo, flagGeo, tyreGeo, unitBox, unitCyl, thinCyl]) g.dispose();
      for (const m of Object.values(mats)) m.dispose();
      for (const tx of ownTextures) tx.dispose();
    },
  };
}
