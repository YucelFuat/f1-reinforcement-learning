// Prosedürel, yüksek detaylı F1 aracı (2022+ dönemi oranları). Birim: metre. İleri yön: -Z, yer: y = 0.
// Dingil mesafesi ~3.6 m, iz genişliği ~2.0 m, 18" jantlar, toplam uzunluk ~5.6 m.

import * as THREE from '../vendor/three.module.min.js';

// ---------- dokular ----------
function tex(w, h, draw, repeat = false) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

function carbonTex() {
  return tex(64, 64, (g, w, h) => {
    g.fillStyle = '#16181c';
    g.fillRect(0, 0, w, h);
    const s = 8;
    for (let y = 0; y < h; y += s) {
      for (let x = 0; x < w; x += s) {
        const odd = ((x + y) / s) % 2;
        const grd = odd ? g.createLinearGradient(x, y, x + s, y) : g.createLinearGradient(x, y, x, y + s);
        grd.addColorStop(0, '#24272d');
        grd.addColorStop(0.5, '#33373f');
        grd.addColorStop(1, '#1c1e23');
        g.fillStyle = grd;
        g.fillRect(x + 0.5, y + 0.5, s - 1, s - 1);
      }
    }
  }, true);
}

// Gövde boyası: u = kesit çevresi (0.25 ≈ üst orta), v = boy (0 burun → 1 arka)
function liveryTex(base, accent, accent2) {
  return tex(512, 512, (g, w, h) => {
    const grd = g.createLinearGradient(0, 0, 0, h);
    grd.addColorStop(0, base);
    grd.addColorStop(1, shade(base, -0.25));
    g.fillStyle = grd;
    g.fillRect(0, 0, w, h);
    // üstte boylu boyunca şerit
    g.fillStyle = accent;
    g.fillRect(w * 0.235, 0, w * 0.03, h);
    g.fillStyle = accent2;
    g.fillRect(w * 0.22, 0, w * 0.008, h);
    g.fillRect(w * 0.272, 0, w * 0.008, h);
    // yanlarda çapraz kesim
    g.fillStyle = accent;
    g.beginPath();
    g.moveTo(0, h * 0.42);
    g.lineTo(w * 0.12, h * 0.35);
    g.lineTo(w * 0.12, h * 0.55);
    g.lineTo(0, h * 0.62);
    g.fill();
    g.beginPath();
    g.moveTo(w, h * 0.42);
    g.lineTo(w * 0.88, h * 0.35);
    g.lineTo(w * 0.88, h * 0.55);
    g.lineTo(w, h * 0.62);
    g.fill();
    // alt kısım karbon görünümlü koyu
    g.fillStyle = 'rgba(18,20,24,0.9)';
    g.fillRect(w * 0.62, 0, w * 0.26, h);
  });
}

function shade(hex, f) {
  const c = new THREE.Color(hex);
  c.offsetHSL(0, 0, f * 0.5);
  return '#' + c.getHexString();
}

// Lastik: u = çevre, v = kesit profili (0 iç yan → 1 dış yan)
function tyreTex(compound) {
  return tex(1024, 128, (g, w, h) => {
    g.fillStyle = '#1b1b1d';
    g.fillRect(0, 0, w, h);
    // hafif doku
    for (let i = 0; i < 3000; i++) {
      g.fillStyle = Math.random() < 0.5 ? 'rgba(255,255,255,0.025)' : 'rgba(0,0,0,0.15)';
      g.fillRect(Math.random() * w, Math.random() * h, 2, 2);
    }
    // sırt (yuvarlanma yüzeyi) daha mat ve kauçuk izli
    g.fillStyle = 'rgba(60,58,55,0.35)';
    g.fillRect(0, h * 0.3, w, h * 0.4);
    // yanak: hamur rengi halka + yazı benzeri işaretler (marka yok)
    for (const [v0, v1] of [[0.08, 0.14], [0.86, 0.92]]) {
      g.fillStyle = compound;
      g.fillRect(0, h * v0, w, h * (v1 - v0));
    }
    g.fillStyle = 'rgba(235,235,235,0.85)';
    for (let k = 0; k < 4; k++) {
      const x0 = (k / 4) * w + w * 0.03;
      for (const vy of [0.18, 0.76]) {
        for (let j = 0; j < 9; j++) g.fillRect(x0 + j * 14, h * vy, 9, h * 0.06);
      }
    }
  });
}

function rimCoverTex() {
  return tex(256, 256, (g, w) => {
    const c = w / 2;
    const grd = g.createRadialGradient(c, c, 4, c, c, c);
    grd.addColorStop(0, '#d0d4d9');
    grd.addColorStop(0.18, '#3a3f46');
    grd.addColorStop(0.7, '#23262b');
    grd.addColorStop(0.92, '#5f656d');
    grd.addColorStop(1, '#9aa1a9');
    g.fillStyle = grd;
    g.beginPath();
    g.arc(c, c, c, 0, Math.PI * 2);
    g.fill();
    // dönüşün fark edilmesi için 5 kollu desen
    g.strokeStyle = 'rgba(0,229,255,0.55)';
    g.lineWidth = 7;
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * Math.PI * 2;
      g.beginPath();
      g.moveTo(c + Math.cos(a) * 30, c + Math.sin(a) * 30);
      g.lineTo(c + Math.cos(a + 0.4) * 105, c + Math.sin(a + 0.4) * 105);
      g.stroke();
    }
    g.fillStyle = '#c62828';
    g.beginPath();
    g.arc(c, c, 16, 0, Math.PI * 2);
    g.fill();
  });
}

// ---------- geometri yardımcıları ----------
// Kesitlerden gövde örer. sec: {z, w (yarı genişlik), yb (alt), yt (üst), x (merkez), n (köşe yuvarlaklığı)}
function loft(sections, seg = 28, capStart = true, capEnd = true) {
  const pos = [], uv = [], idx = [];
  const rows = sections.length;
  for (let r = 0; r < rows; r++) {
    const s = sections[r];
    const n = s.n ?? 3.2;
    const cy = (s.yb + s.yt) / 2, hy = (s.yt - s.yb) / 2;
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const c = Math.cos(a), sn = Math.sin(a);
      const px = Math.sign(c) * Math.pow(Math.abs(c), 2 / n) * s.w + (s.x || 0);
      const py = Math.sign(sn) * Math.pow(Math.abs(sn), 2 / n) * hy + cy;
      pos.push(px, py, s.z);
      uv.push(i / seg, r / (rows - 1));
    }
  }
  const W = seg + 1;
  for (let r = 0; r < rows - 1; r++) {
    for (let i = 0; i < seg; i++) {
      const a = r * W + i, b = a + 1, c = a + W, d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const addCap = (r, flip) => {
    const s = sections[r];
    const center = pos.length / 3;
    pos.push(s.x || 0, (s.yb + s.yt) / 2, s.z);
    uv.push(0.5, r / (rows - 1));
    for (let i = 0; i < seg; i++) {
      const a = r * W + i, b = a + 1;
      if (flip) idx.push(center, b, a);
      else idx.push(center, a, b);
    }
  };
  if (capStart) addCap(0, true);
  if (capEnd) addCap(rows - 1, false);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// Kanat profili (YZ düzleminde), X boyunca 'span' kadar
function wingElement(span, chord, thick, camber = 0.15) {
  const sh = new THREE.Shape();
  const N = 14;
  const top = [], bot = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const z = t * chord;
    const yt = thick * (1.2 * Math.sqrt(t) - 1.0 * t - 0.25 * t * t + 0.1 * t * t * t) * 1.6;
    const yc = camber * chord * 4 * t * (1 - t) * 0.25;
    top.push([z, yc + Math.max(0.002, yt)]);
    bot.push([z, yc - Math.max(0.002, yt) * 0.5]);
  }
  sh.moveTo(top[0][0], top[0][1]);
  for (const p of top) sh.lineTo(p[0], p[1]);
  for (let i = bot.length - 1; i >= 0; i--) sh.lineTo(bot[i][0], bot[i][1]);
  const g = new THREE.ExtrudeGeometry(sh, { depth: span, bevelEnabled: false, steps: 1, curveSegments: 4 });
  // şekil (z,y) düzleminde: Extrude X=şekil x → bizim z; Y → y; derinlik Z → bizim x
  g.rotateY(-Math.PI / 2);
  g.translate(span / 2, 0, 0);
  g.computeVertexNormals();
  return g;
}

function plate(shapePts, thickness) {
  const sh = new THREE.Shape();
  sh.moveTo(shapePts[0][0], shapePts[0][1]);
  for (const p of shapePts.slice(1)) sh.lineTo(p[0], p[1]);
  const g = new THREE.ExtrudeGeometry(sh, { depth: thickness, bevelEnabled: true, bevelThickness: 0.004, bevelSize: 0.004, bevelSegments: 1 });
  // şekil (z,y) → X kalınlık
  g.rotateY(-Math.PI / 2);
  g.translate(thickness / 2, 0, 0);
  g.computeVertexNormals();
  return g;
}

function rod(p1, p2, r, mat) {
  const a = new THREE.Vector3(...p1), b = new THREE.Vector3(...p2);
  const len = a.distanceTo(b);
  const g = new THREE.CylinderGeometry(r, r, len, 8);
  const m = new THREE.Mesh(g, mat);
  m.position.copy(a).add(b).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
  m.castShadow = true;
  return m;
}

function tyreGeometry(radius, rimR, width) {
  const pts = [];
  const hw = width / 2;
  const prof = [
    [rimR, -hw + 0.01], [rimR + 0.01, -hw], [radius - 0.05, -hw - 0.004], [radius - 0.02, -hw + 0.02],
    [radius - 0.004, -hw + 0.05], [radius, -hw + 0.09], [radius, hw - 0.09], [radius - 0.004, hw - 0.05],
    [radius - 0.02, hw - 0.02], [radius - 0.05, hw + 0.004], [rimR + 0.01, hw], [rimR, hw - 0.01],
  ];
  for (const [r, y] of prof) pts.push(new THREE.Vector2(r, y));
  const g = new THREE.LatheGeometry(pts, 56);
  g.rotateZ(Math.PI / 2); // eksen X boyunca
  g.computeVertexNormals();
  return g;
}

// ---------- araç ----------
export function buildF1Car(opts = {}) {
  const livery = opts.livery || { base: '#1a56db', accent: '#22d3ee', accent2: '#ffffff' };
  const env = opts.envMap || null;
  const car = new THREE.Group();

  const paint = new THREE.MeshPhysicalMaterial({
    map: liveryTex(livery.base, livery.accent, livery.accent2),
    metalness: 0.0, roughness: 0.42, clearcoat: 1, clearcoatRoughness: 0.06, envMap: env, envMapIntensity: 0.45,
  });
  const paintPlain = new THREE.MeshPhysicalMaterial({ color: livery.base, metalness: 0.0, roughness: 0.42, clearcoat: 1, clearcoatRoughness: 0.06, envMap: env, envMapIntensity: 0.45 });
  const accentMat = new THREE.MeshPhysicalMaterial({ color: livery.accent, metalness: 0.2, roughness: 0.35, clearcoat: 0.8, envMap: env });
  const ct = carbonTex();
  ct.repeat.set(6, 6);
  const carbon = new THREE.MeshPhysicalMaterial({ map: ct, color: 0xffffff, metalness: 0.1, roughness: 0.45, clearcoat: 0.6, clearcoatRoughness: 0.15, envMap: env, envMapIntensity: 0.5 });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x08090b, roughness: 0.8 });
  const metal = new THREE.MeshStandardMaterial({ color: 0xb8bec6, metalness: 0.95, roughness: 0.22, envMap: env });
  const mirrorMat = new THREE.MeshStandardMaterial({ color: 0xdfe8f2, metalness: 1, roughness: 0.05, envMap: env });

  const add = (geo, mat, x = 0, y = 0, z = 0, parent = car) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  };

  // --- monokok + burun + motor kapağı (tek parça lofted gövde) ---
  const body = [
    { z: -2.72, w: 0.045, yb: 0.17, yt: 0.24, n: 2.4 },
    { z: -2.5, w: 0.1, yb: 0.15, yt: 0.31 },
    { z: -2.1, w: 0.16, yb: 0.15, yt: 0.4 },
    { z: -1.65, w: 0.21, yb: 0.16, yt: 0.49 },
    { z: -1.15, w: 0.29, yb: 0.13, yt: 0.58 },
    { z: -0.7, w: 0.36, yb: 0.08, yt: 0.64 },
    { z: -0.25, w: 0.4, yb: 0.06, yt: 0.66 },
    { z: 0.3, w: 0.42, yb: 0.06, yt: 0.74 },
    { z: 0.62, w: 0.33, yb: 0.08, yt: 0.95, n: 2.6 },
    { z: 1.1, w: 0.26, yb: 0.1, yt: 0.88 },
    { z: 1.6, w: 0.18, yb: 0.13, yt: 0.7 },
    { z: 2.05, w: 0.12, yb: 0.17, yt: 0.54 },
    { z: 2.4, w: 0.08, yb: 0.22, yt: 0.44, n: 2.4 },
  ];
  add(loft(body, 36), paint);
  // kokpit açıklığı (koyu iç) + koltuk sırtı
  const opening = new THREE.Mesh(new THREE.CircleGeometry(1, 32), darkMat);
  opening.scale.set(0.27, 0.5, 1);
  opening.rotation.x = -Math.PI / 2;
  opening.position.set(0, 0.665, -0.12);
  car.add(opening);
  // hava girişi (roll hoop)
  const intake = add(new THREE.CircleGeometry(1, 24), darkMat, 0, 0.86, 0.43);
  intake.scale.set(0.14, 0.09, 1);
  intake.rotation.x = -0.25;
  intake.rotation.y = Math.PI;
  // köpek balığı yüzgeci
  add(plate([[0.7, 0.9], [2.1, 0.62], [2.25, 0.62], [2.2, 0.8], [0.9, 0.97]], 0.012), paint);

  // --- yan kutular (sidepod) ---
  for (const s of [-1, 1]) {
    const pod = [
      { z: -0.55, w: 0.2, yb: 0.2, yt: 0.6, x: s * 0.58, n: 3 },
      { z: -0.25, w: 0.27, yb: 0.12, yt: 0.64, x: s * 0.6 },
      { z: 0.35, w: 0.27, yb: 0.1, yt: 0.6, x: s * 0.58 },
      { z: 1.0, w: 0.2, yb: 0.12, yt: 0.47, x: s * 0.5 },
      { z: 1.6, w: 0.09, yb: 0.16, yt: 0.33, x: s * 0.33 },
    ];
    add(loft(pod, 28), paint);
    // giriş ağzı
    const mouth = add(new THREE.PlaneGeometry(0.34, 0.3), darkMat, s * 0.6, 0.43, -0.56);
    mouth.rotation.y = Math.PI;
    // yan dikey kanatçık
    add(plate([[-0.75, 0.12], [-0.55, 0.12], [-0.55, 0.62], [-0.75, 0.5]], 0.012), carbon, s * 0.86, 0, 0);
  }

  // --- zemin (floor) + difüzör ---
  const floorShape = new THREE.Shape();
  const fpts = [[-0.32, -1.25], [0.32, -1.25], [0.8, -0.65], [0.86, 0.9], [0.62, 1.55], [0.55, 2.2], [-0.55, 2.2], [-0.62, 1.55], [-0.86, 0.9], [-0.8, -0.65]];
  floorShape.moveTo(fpts[0][0], fpts[0][1]);
  for (const p of fpts.slice(1)) floorShape.lineTo(p[0], p[1]);
  const fg = new THREE.ExtrudeGeometry(floorShape, { depth: 0.025, bevelEnabled: false });
  fg.rotateX(Math.PI / 2);
  add(fg, carbon, 0, 0.075, 0);
  const diff = add(new THREE.PlaneGeometry(1.08, 0.5, 1, 1), carbon, 0, 0.13, 2.4);
  diff.rotation.x = -Math.PI / 2 + 0.35;
  for (const s of [-1, 1]) add(plate([[1.55, 0.05], [2.2, 0.05], [2.55, 0.32], [1.7, 0.16]], 0.01), carbon, s * 0.6, 0, 0);

  // --- ön kanat ---
  const fw = new THREE.Group();
  fw.position.set(0, 0.07, -2.98);
  car.add(fw);
  const fwMain = new THREE.Mesh(wingElement(1.95, 0.3, 0.016, 0.22), carbon);
  fwMain.castShadow = true;
  fw.add(fwMain);
  for (let k = 1; k <= 3; k++) {
    const el = new THREE.Mesh(wingElement(1.95 - k * 0.1, 0.15 - k * 0.012, 0.01, 0.3), k === 2 ? accentMat : paintPlain);
    el.position.set(0, 0.02 + k * 0.03, 0.16 + k * 0.06);
    el.rotation.x = -0.12 - k * 0.1;
    el.castShadow = true;
    fw.add(el);
  }
  for (const s of [-1, 1]) {
    const ep = new THREE.Mesh(plate([[-0.06, -0.01], [0.48, -0.01], [0.5, 0.2], [0.3, 0.3], [0.0, 0.22]], 0.012), carbon);
    ep.position.set(s * 0.985, 0, 0);
    ep.castShadow = true;
    fw.add(ep);
  }
  // burun direkleri
  for (const s of [-1, 1]) add(new THREE.BoxGeometry(0.015, 0.12, 0.2), carbon, s * 0.07, 0.15, -2.7);

  // --- arka kanat ---
  const rw = new THREE.Group();
  rw.position.set(0, 0.86, 2.48);
  car.add(rw);
  const rwMain = new THREE.Mesh(wingElement(0.96, 0.3, 0.035, 0.28), carbon);
  rwMain.castShadow = true;
  rw.add(rwMain);
  const flap = new THREE.Mesh(wingElement(0.96, 0.2, 0.02, 0.3), paintPlain);
  flap.position.set(0, 0.13, 0.2);
  flap.rotation.x = -0.45;
  flap.castShadow = true;
  rw.add(flap);
  for (const s of [-1, 1]) {
    const ep = new THREE.Mesh(plate([[0.0, -0.42], [0.5, -0.32], [0.52, 0.2], [0.3, 0.26], [0.02, 0.16]], 0.012), paint);
    ep.position.set(s * 0.49, 0, 0);
    ep.castShadow = true;
    rw.add(ep);
  }
  // kuğu boynu taşıyıcı + kiriş kanat
  add(plate([[2.1, 0.45], [2.35, 0.45], [2.55, 0.88], [2.45, 0.9]], 0.02), carbon);
  const beam = new THREE.Mesh(wingElement(0.8, 0.18, 0.02, 0.2), carbon);
  beam.position.set(0, 0.4, 2.45);
  beam.castShadow = true;
  car.add(beam);
  // yağmur ışığı
  add(new THREE.BoxGeometry(0.12, 0.04, 0.02), new THREE.MeshBasicMaterial({ color: 0xff2020 }), 0, 0.33, 2.62);

  // --- halo ---
  const haloPts = [
    [-0.33, 0.7, 0.36], [-0.34, 0.93, 0.16], [-0.3, 1.02, -0.08], [-0.17, 1.05, -0.27], [0, 1.06, -0.33],
    [0.17, 1.05, -0.27], [0.3, 1.02, -0.08], [0.34, 0.93, 0.16], [0.33, 0.7, 0.36],
  ].map((p) => new THREE.Vector3(...p));
  const haloCurve = new THREE.CatmullRomCurve3(haloPts);
  add(new THREE.TubeGeometry(haloCurve, 60, 0.026, 10, false), carbon);
  const pillar = new THREE.CatmullRomCurve3([new THREE.Vector3(0, 1.06, -0.33), new THREE.Vector3(0, 0.88, -0.45), new THREE.Vector3(0, 0.68, -0.6)]);
  add(new THREE.TubeGeometry(pillar, 16, 0.017, 8, false), carbon);

  // --- pilot ---
  const helmet = new THREE.Group();
  helmet.position.set(0, 0.84, 0.12);
  car.add(helmet);
  const hm = new THREE.Mesh(new THREE.SphereGeometry(0.15, 28, 20), new THREE.MeshPhysicalMaterial({ color: 0xffd600, roughness: 0.25, clearcoat: 1, envMap: env }));
  hm.scale.set(1, 1, 1.15);
  hm.castShadow = true;
  helmet.add(hm);
  const visor = new THREE.Mesh(new THREE.SphereGeometry(0.152, 24, 10, -Math.PI / 2 - 0.9, 1.8, 1.25, 0.45), new THREE.MeshStandardMaterial({ color: 0x111111, metalness: 0.9, roughness: 0.05, envMap: env }));
  visor.scale.set(1, 1, 1.15);
  helmet.add(visor);
  // omuz/HANS
  add(new THREE.TorusGeometry(0.16, 0.04, 8, 20, Math.PI), darkMat, 0, 0.7, 0.12).rotation.x = Math.PI / 2;

  // --- direksiyon ---
  const wheelPivot = new THREE.Group();
  wheelPivot.position.set(0, 0.65, -0.36);
  wheelPivot.rotation.x = -0.35;
  car.add(wheelPivot);
  const swShape = new THREE.Shape();
  swShape.moveTo(-0.13, -0.06);
  swShape.lineTo(0.13, -0.06);
  swShape.quadraticCurveTo(0.16, 0.0, 0.12, 0.07);
  swShape.lineTo(-0.12, 0.07);
  swShape.quadraticCurveTo(-0.16, 0.0, -0.13, -0.06);
  const sw = new THREE.Mesh(new THREE.ExtrudeGeometry(swShape, { depth: 0.03, bevelEnabled: true, bevelSize: 0.006, bevelThickness: 0.006, bevelSegments: 2 }), carbon);
  sw.position.z = -0.015;
  wheelPivot.add(sw);
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.1, 0.05), new THREE.MeshBasicMaterial({ color: 0x00e676 }));
  screen.position.set(0, 0.01, 0.02);
  wheelPivot.add(screen);
  for (const s of [-1, 1]) {
    const grip = new THREE.Mesh(new THREE.CapsuleGeometry(0.022, 0.1, 4, 8), new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.9 }));
    grip.position.set(s * 0.15, -0.005, 0);
    wheelPivot.add(grip);
  }

  // --- aynalar ---
  for (const s of [-1, 1]) {
    add(new THREE.CylinderGeometry(0.008, 0.008, 0.1, 6), carbon, s * 0.43, 0.77, -0.5).rotation.z = s * 1.0;
    const housing = add(new THREE.BoxGeometry(0.14, 0.06, 0.05), paintPlain, s * 0.5, 0.79, -0.5);
    housing.geometry.translate(0, 0, 0);
    const glass = add(new THREE.PlaneGeometry(0.12, 0.045), mirrorMat, s * 0.5, 0.79, -0.474);
    glass.rotation.y = 0;
  }

  // --- tekerlekler ---
  const wheels = [];
  const front = [];
  const comp = opts.compound || '#e53935';
  const tyreMatF = new THREE.MeshStandardMaterial({ map: tyreTex(comp), roughness: 0.82, metalness: 0, envMap: env, envMapIntensity: 0.3 });
  const coverTex = rimCoverTex();
  const coverMat = new THREE.MeshStandardMaterial({ map: coverTex, metalness: 0.7, roughness: 0.3, envMap: env });
  const defs = [
    { x: -0.81, z: -1.75, front: true, w: 0.3 },
    { x: 0.81, z: -1.75, front: true, w: 0.3 },
    { x: -0.79, z: 1.85, front: false, w: 0.39 },
    { x: 0.79, z: 1.85, front: false, w: 0.39 },
  ];
  const R = 0.36, rimR = 0.235;
  for (const d of defs) {
    const steerG = new THREE.Group();
    steerG.position.set(d.x, R, d.z);
    car.add(steerG);
    const spin = new THREE.Group();
    steerG.add(spin);
    const tyre = new THREE.Mesh(tyreGeometry(R, rimR, d.w), tyreMatF);
    tyre.castShadow = true;
    tyre.receiveShadow = true;
    spin.add(tyre);
    // jant kapakları (dış ve iç)
    for (const side of [-1, 1]) {
      const cov = new THREE.Mesh(new THREE.CircleGeometry(rimR, 40), coverMat);
      cov.position.x = side * (d.w / 2 - 0.012);
      cov.rotation.y = side * Math.PI / 2;
      spin.add(cov);
    }
    const lip = new THREE.Mesh(new THREE.TorusGeometry(rimR, 0.012, 8, 40), metal);
    lip.rotation.y = Math.PI / 2;
    lip.position.x = Math.sign(d.x) * (d.w / 2 - 0.01);
    spin.add(lip);
    wheels.push(spin);
    if (d.front) front.push(steerG);
    // fren kanalı
    const duct = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.14, 0.12, 16), carbon);
    duct.rotation.z = Math.PI / 2;
    duct.position.x = -Math.sign(d.x) * (d.w / 2 + 0.05);
    steerG.add(duct);
  }
  // süspansiyon (salıncaklar + itme çubukları)
  const susp = (zc, xIn, xOut, yLo, yHi) => {
    for (const s of [-1, 1]) {
      car.add(rod([s * xIn, yLo, zc - 0.18], [s * xOut, R - 0.12, zc], 0.016, carbon));
      car.add(rod([s * xIn, yLo, zc + 0.22], [s * xOut, R - 0.12, zc], 0.016, carbon));
      car.add(rod([s * xIn, yHi, zc - 0.15], [s * xOut, R + 0.12, zc], 0.014, carbon));
      car.add(rod([s * xIn, yHi, zc + 0.2], [s * xOut, R + 0.12, zc], 0.014, carbon));
      car.add(rod([s * (xIn + 0.05), yHi + 0.05, zc + 0.05], [s * xOut, R - 0.1, zc + 0.02], 0.012, metal));
    }
  };
  susp(-1.75, 0.16, 0.66, 0.24, 0.42);
  susp(1.85, 0.12, 0.62, 0.26, 0.44);

  car.traverse((o) => {
    if (o.isMesh) o.castShadow = true;
  });
  return { car, wheels, front, wheelPivot, helmet };
}
