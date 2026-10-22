// En iyi sürüşün 3B tekrarı: kokpit (burun) kamerası, T-kamera, takip ve helikopter görünümleri.
// Çoklu tekrar: 'top5' (bağımsız araçlar, hayalet gibi) ve 'heat' (seri tekrarı: temas, sollama, sıralama kulesi).
// Hayaletler: gerçek F1 referans turu ve seçilen karşılaştırma. Telemetri analizi: sektörler, mini sektörler, delta zaman.
// Three.js yerel olarak vendor/ klasöründen yüklenir (internet gerekmez).

import * as THREE from '../vendor/three.module.min.js';
import { computeTelemetry, TelemetryPanel } from './telemetry.js';
import { buildExport, downloadBlob } from './exporter.js';
import { TICK_RATE, RAY_ANGLES_DEG, V_REF, fmtLap, COMPOUNDS, COMPOUND_IDS } from './config.js';
import { FRAME_STRIDE, FR } from './replay.js';
import { FINISHED, CRASHED } from './sim.js';
import { buildScenery } from './scenery.js';
import { createPostFX } from './postfx.js';
import { CarFactory, LIVERIES, loadCarModel } from './replay-car.js';
import {
  monoTable, interp, deltaSeries, raceTimeline, traceFromReference, traceFromTelemetry, traceFromOwnLap,
  traceFromCSV, traceLapRows, traceDistAtTime, parseLapCSV,
} from './replay-analysis.js';

// GLB modelini görüntüleyici modülü yüklenir yüklenmez indirmeye başla (sahne kurulurken hazır olsun)
loadCarModel();


let K = 0.22; // metre / piksel — pistin gerçek ölçeği (görüntüleyici açılınca ayarlanır)
const NRAY = RAY_ANGLES_DEG.length;

// ---------- doku üreticileri ----------
function canvasTex(w, h, draw, repeat = true) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function noise(g, w, h, n, colors, size = 2) {
  for (let i = 0; i < n; i++) {
    g.fillStyle = colors[(Math.random() * colors.length) | 0];
    g.fillRect(Math.random() * w, Math.random() * h, size * Math.random() + 0.5, size * Math.random() + 0.5);
  }
}

function asphaltTex() {
  return canvasTex(512, 512, (g, w, h) => {
    g.fillStyle = '#4a4d52';
    g.fillRect(0, 0, w, h);
    noise(g, w, h, 26000, ['#3f4246', '#55585d', '#45484c', '#5c5f63', '#393b3f'], 2);
    // lastik izi (yarış çizgisi)
    const grd = g.createLinearGradient(0, 0, w, 0);
    grd.addColorStop(0.25, 'rgba(20,20,22,0)');
    grd.addColorStop(0.5, 'rgba(20,20,22,0.28)');
    grd.addColorStop(0.75, 'rgba(20,20,22,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, w, h);
    // kenar çizgileri
    g.fillStyle = '#f2f2f2';
    g.fillRect(w * 0.012, 0, w * 0.022, h);
    g.fillRect(w * 0.966, 0, w * 0.022, h);
  });
}

function kerbTex() {
  return canvasTex(32, 128, (g, w, h) => {
    g.fillStyle = '#d42a2a';
    g.fillRect(0, 0, w, h / 2);
    g.fillStyle = '#f4f4f4';
    g.fillRect(0, h / 2, w, h / 2);
    g.fillStyle = 'rgba(0,0,0,0.12)';
    g.fillRect(0, 0, w * 0.15, h);
  });
}

function grassTex() {
  return canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = '#3f7a35';
    g.fillRect(0, 0, w, h);
    noise(g, w, h, 9000, ['#3a7231', '#478740', '#356a2d', '#4d8f45', '#2f6128'], 2.5);
  });
}

function gravelTex() {
  return canvasTex(128, 128, (g, w, h) => {
    g.fillStyle = '#b8a57e';
    g.fillRect(0, 0, w, h);
    noise(g, w, h, 5000, ['#a8946c', '#c9b892', '#9c8963', '#d4c49f'], 2);
  });
}

function wallTex() {
  return canvasTex(256, 64, (g, w, h) => {
    g.fillStyle = '#d9d9d6';
    g.fillRect(0, 0, w, h);
    noise(g, w, h, 1500, ['#cfcfcb', '#e3e3e0', '#c4c4c0'], 2);
    for (let x = 0; x < w; x += 64) {
      g.fillStyle = (x / 64) % 2 ? '#c62828' : '#fafafa';
      g.fillRect(x, 0, 64, h * 0.28);
    }
    g.fillStyle = 'rgba(0,0,0,0.15)';
    g.fillRect(0, h * 0.28, w, 2);
  });
}

function fenceTex() {
  return canvasTex(256, 128, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    g.strokeStyle = 'rgba(200,205,210,0.55)';
    g.lineWidth = 1.2;
    for (let x = -h; x < w; x += 9) {
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x + h, h); g.stroke();
      g.beginPath(); g.moveTo(x + h, 0); g.lineTo(x, h); g.stroke();
    }
    g.fillStyle = 'rgba(120,125,130,0.95)';
    g.fillRect(0, 0, 5, h); // direk
    g.fillRect(0, 0, w, 3);
    g.fillRect(0, h * 0.5, w, 2);
  });
}

function runoffTex() {
  return canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = '#3d4044';
    g.fillRect(0, 0, w, h);
    noise(g, w, h, 9000, ['#36393d', '#44474b', '#3a3d41'], 2);
    // boyalı kaçış alanı şeritleri
    g.fillStyle = 'rgba(40,110,190,0.55)';
    for (let y = 0; y < h; y += 64) g.fillRect(0, y, w, 26);
    g.fillStyle = 'rgba(200,40,40,0.5)';
    for (let y = 32; y < h; y += 64) g.fillRect(0, y, w, 10);
  });
}

function checkerTex(nx = 8, ny = 2) {
  return canvasTex(nx * 16, ny * 16, (g) => {
    for (let i = 0; i < nx; i++)
      for (let j = 0; j < ny; j++) {
        g.fillStyle = (i + j) % 2 ? '#111' : '#f5f5f5';
        g.fillRect(i * 16, j * 16, 16, 16);
      }
  }, false);
}

function crowdTex() {
  return canvasTex(256, 128, (g, w, h) => {
    g.fillStyle = '#2d3240';
    g.fillRect(0, 0, w, h);
    noise(g, w, h, 4000, ['#e53935', '#fdd835', '#1e88e5', '#ffffff', '#43a047', '#fb8c00', '#8e24aa', '#f5c6a5', '#6d4c41'], 3);
  });
}

function cloudTex() {
  const t = canvasTex(256, 128, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    for (let i = 0; i < 26; i++) {
      const x = w * (0.18 + Math.random() * 0.64), y = h * (0.45 + Math.random() * 0.25);
      const r = 18 + Math.random() * 34;
      const grd = g.createRadialGradient(x, y, 0, x, y, r);
      grd.addColorStop(0, 'rgba(255,255,255,0.9)');
      grd.addColorStop(0.6, 'rgba(245,248,252,0.45)');
      grd.addColorStop(1, 'rgba(235,240,248,0)');
      g.fillStyle = grd;
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
    }
    // alt kısmı hafif gölgeli
    g.globalCompositeOperation = 'source-atop';
    const sh = g.createLinearGradient(0, h * 0.4, 0, h);
    sh.addColorStop(0, 'rgba(0,0,0,0)');
    sh.addColorStop(1, 'rgba(120,130,150,0.35)');
    g.fillStyle = sh;
    g.fillRect(0, 0, w, h);
  }, false);
  return t;
}

function glowTex() {
  return canvasTex(128, 128, (g, w) => {
    const grd = g.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
    grd.addColorStop(0, 'rgba(255,255,240,1)');
    grd.addColorStop(0.15, 'rgba(255,250,220,0.9)');
    grd.addColorStop(0.4, 'rgba(255,240,200,0.25)');
    grd.addColorStop(1, 'rgba(255,240,200,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, w, w);
  }, false);
}

// ---------- yardımcılar ----------


// ---------- motor sesi (Web Audio ile sentezlenir, ses dosyası yok) ----------
class EngineAudio {
  constructor() {
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = (this.ctx = new AC());
    this.volume = 0.6;
    this.muted = false;
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    this.master.connect(comp);
    comp.connect(ctx.destination);

    // motor: üç harmonik + bozulma + alçak geçiren filtre
    this.engGain = ctx.createGain();
    this.engGain.gain.value = 0.2;
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) {
      const x = (i / 1023) * 2 - 1;
      curve[i] = Math.tanh(x * 3.2);
    }
    shaper.curve = curve;
    this.lp = ctx.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.lp.Q.value = 1.4;
    this.lp.frequency.value = 1200;
    const mix = ctx.createGain();
    mix.gain.value = 0.5;
    this.oscs = [];
    for (const [type, mul, g] of [['sawtooth', 1, 0.5], ['square', 0.5, 0.4], ['sawtooth', 0.25, 0.25], ['triangle', 2, 0.12]]) {
      const o = ctx.createOscillator();
      o.type = type;
      const og = ctx.createGain();
      og.gain.value = g;
      o.connect(og);
      og.connect(mix);
      o.start();
      this.oscs.push({ o, mul });
    }
    // hafif titreşim (yanma darbeleri hissi)
    this.lfo = ctx.createOscillator();
    this.lfo.type = 'sine';
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.18;
    this.lfo.connect(lfoGain);
    lfoGain.connect(mix.gain);
    this.lfo.start();
    mix.connect(shaper);
    shaper.connect(this.lp);
    this.lp.connect(this.engGain);
    this.engGain.connect(this.master);

    // gürültü kaynağı: lastik sesi ve rüzgar
    const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    noise.loop = true;
    noise.start();
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2300;
    bp.Q.value = 9;
    this.squeal = ctx.createGain();
    this.squeal.gain.value = 0;
    noise.connect(bp);
    bp.connect(this.squeal);
    this.squeal.connect(this.master);
    const wl = ctx.createBiquadFilter();
    wl.type = 'lowpass';
    wl.frequency.value = 700;
    this.wind = ctx.createGain();
    this.wind.gain.value = 0;
    noise.connect(wl);
    wl.connect(this.wind);
    this.wind.connect(this.master);
    // gaz kesince turbo/egzoz patlamaları için
    this.lastThr = 0;
  }

  update({ rpm, throttle, speed, slip, active, rate }) {
    const ctx = this.ctx;
    if (ctx.state === 'suspended') ctx.resume();
    const t = ctx.currentTime;
    const f = (rpm / 60) * 3; // V6 ateşleme frekansı: devir/dk ÷ 60 × 3 (11.000 d/dk ≈ 550 Hz)
    for (const { o, mul } of this.oscs) o.frequency.setTargetAtTime(f * mul, t, 0.025);
    this.lfo.frequency.setTargetAtTime(f / 4, t, 0.05);
    const on = Math.max(0, throttle);
    this.lp.frequency.setTargetAtTime(500 + 3800 * on + rpm * 0.12, t, 0.05);
    this.engGain.gain.setTargetAtTime(0.1 + 0.32 * on + (rpm / 12000) * 0.08, t, 0.04);
    this.squeal.gain.setTargetAtTime(Math.min(0.35, slip * 1.2) * (speed > 5 ? 1 : 0), t, 0.05);
    const sn = Math.min(1.2, speed / 95);
    this.wind.gain.setTargetAtTime(0.25 * sn * sn, t, 0.1);
    const vol = active && !this.muted ? this.volume * (rate < 1 ? 0.6 : 1) : 0;
    this.master.gain.setTargetAtTime(vol, t, active ? 0.08 : 0.15);
    this.lastThr = throttle;
  }

  close() {
    try { this.ctx.close(); } catch { /* yok */ }
  }
}
function lerpAngle(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

// Merkez çizgisinden sapan şerit. Dar virajlarda iç tarafta kendini kesmesin diye
// ofset, gerçek mesafe alanına (SDF) göre kırpılır.
function safeOffset(track, k, side, off) {
  const nx = -Math.sin(track.tan[k]) * side, ny = Math.cos(track.tan[k]) * side;
  const ok = (o) => {
    const x = track.cx[k] + nx * o, y = track.cy[k] + ny * o;
    const dist = track.halfWidth - track.sdfAt(x, y);
    return dist >= o * 0.93;
  };
  if (ok(off)) return { o: off, valid: true };
  let lo = 0, hi = off;
  for (let it = 0; it < 10; it++) {
    const mid = (lo + hi) / 2;
    if (ok(mid)) lo = mid;
    else hi = mid;
  }
  return { o: lo, valid: false };
}

function ribbon(track, side, offA, offB, vPerM, y, yOuter = null) {
  const n = track.n;
  const pos = new Float32Array((n + 1) * 6);
  const uv = new Float32Array((n + 1) * 4);
  const nor = new Float32Array((n + 1) * 6);
  for (let i = 0; i <= n; i++) {
    const k = i % n;
    const nx = -Math.sin(track.tan[k]) * side, ny = Math.cos(track.tan[k]) * side;
    const a = offA <= track.halfWidth ? offA : safeOffset(track, k, side, offA).o;
    const b = offB <= track.halfWidth ? offB : safeOffset(track, k, side, offB).o;
    const e = track.elev[k];
    pos.set([(track.cx[k] + nx * a) * K, e + y, (track.cy[k] + ny * a) * K, (track.cx[k] + nx * b) * K, e + (yOuter ?? y), (track.cy[k] + ny * b) * K], i * 6);
    const v = i * track.ds * K * vPerM;
    uv.set([0, v, 1, v], i * 4);
    nor.set([0, 1, 0, 0, 1, 0], i * 6);
  }
  const idx = [];
  for (let i = 0; i < n; i++) {
    const a = 2 * i, b = a + 1, c = a + 2, d = a + 3;
    idx.push(a, b, c, b, d, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setIndex(idx);
  return g;
}

function wallGeometry(track, side, off, height, base = -0.4) {
  const n = track.n;
  const pos = [], uv = [], idx = [];
  let prevValid = false;
  for (let i = 0; i <= n; i++) {
    const k = i % n;
    const r = safeOffset(track, k, side, off);
    const nx = -Math.sin(track.tan[k]) * side, ny = Math.cos(track.tan[k]) * side;
    const x = (track.cx[k] + nx * off) * K, z = (track.cy[k] + ny * off) * K;
    const u = (i * track.ds * K) / 8;
    const e = track.elev[k];
    pos.push(x, e + base, z, x, e + height, z);
    uv.push(u, base < 0 ? -0.4 : 0, u, 1);
    if (i > 0 && r.valid && prevValid) {
      const a = 2 * (i - 1), b = a + 1, c = a + 2, d = a + 3;
      idx.push(a, c, b, b, c, d);
    }
    prevValid = r.valid;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// ---------- görüntüleyici ----------
const CAM_ORDER = [0, 1, 2, 3, 5, 4];
const QUALITIES = ['high', 'medium', 'low'];
const Q_LABEL = { high: 'Yüksek', medium: 'Orta', low: 'Düşük' };
const MODE_LABEL = {
  single: '',
  top5: 'Çoklu tekrar · araçlar birbirinden bağımsız (hayalet gibi, temas yok)',
  heat: 'Seri tekrarı · araçlar etkileşir (temas, sollama)',
};
const STATUS_SHORT = { [FINISHED]: 'Bitirdi', [CRASHED]: 'Çarptı', 3: 'Elendi', 0: 'Sürüyor' };
const LOD_NEAR = 38; // m: bundan yakın araçlar tam ayrıntılı (GLB)

function fmtShort(sec) {
  if (sec == null || !isFinite(sec)) return '–';
  const m = Math.floor(sec / 60);
  const r = sec - m * 60;
  return m ? `${m}:${r < 10 ? '0' : ''}${r.toFixed(1)}` : r.toFixed(1);
}
const sgn = (v, d = 3) => (v == null || !isFinite(v) ? '–' : (v > 0 ? '+' : v < 0 ? '−' : '±') + Math.abs(v).toFixed(d));
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const compOf = (k) => COMPOUNDS[COMPOUND_IDS[k] || 'medium'];

// Kenar yumuşatmalı 0-1 geçiş
function ramp(v) {
  const u = clamp01(v);
  return u * u * (3 - 2 * u);
}

export class CockpitViewer {
  // Yeni sözleşme: { track, cfg, title, onClose, replays, mode: 'single'|'top5'|'heat', focus?, extra }
  //   replays[0] varsayılan odak araçtır (kamera, HUD, telemetri, motor sesi); focus ile başka bir indeks seçilebilir.
  // Eski çağrı ({ replay }) de desteklenir.
  constructor({ track, cfg, replay, replays, mode, focus = 0, title, onClose, extra = {} }) {
    this.track = track;
    this.cfg = cfg;
    this.title = title || 'Tekrar';
    this.extra = extra || {};
    this.onClose = onClose;
    K = track.mpp;
    const list = (Array.isArray(replays) && replays.length ? replays : [replay]).filter(Boolean);
    if (!list.length) throw new Error('Tekrar verisi yok');
    this.multi = list.length > 1;
    this.mode = this.multi ? (mode === 'heat' ? 'heat' : 'top5') : 'single';
    this.cars = list.map((rep, i) => this._makeCarRecord(rep, i));
    this.focus = Math.max(0, Math.min(list.length - 1, focus | 0));
    this.rep = this.cars[this.focus].rep; // geriye uyumluluk
    this.tel = this.cars[this.focus].T;
    this.maxCount = Math.max(...list.map((r) => r.count));
    this.timeline = this.multi ? raceTimeline(list, track, { contacts: this.mode === 'heat' }) : null;
    this.t = 0;
    this.playing = true;
    this.rate = 1;
    this.camMode = 0; // 0 kokpit, 1 burun, 2 T-kamera, 3 takip, 5 yan, 4 helikopter
    this.showRays = false;
    this.ghostsOn = true;
    this.labelsOn = true;
    this.quality = ['high', 'medium', 'low'].includes(this.extra.quality) ? this.extra.quality : 'medium';
    this.cmpId = 'none';
    this.cmp = null;
    this.csvTraces = [];
    this.ghosts = [];
    this.disposables = [];
    this._hudTick = 0;
    this._evIdx = 0;
    this._feedItems = [];
    this.stats = { fps: 0, frameMs: 0, calls: 0, tris: 0, model: 'yükleniyor' };
    this._v = new THREE.Vector3();
    this._v2 = new THREE.Vector3();
    this.refTrace = null;
    if (this.extra.reference) {
      try {
        this.refTrace = traceFromReference(this.extra.reference, track);
      } catch (e) {
        console.warn('Referans tur okunamadı:', e);
      }
    }
    ensureReplayCss();
    this._buildDom(this.title);
    this._buildScene();
    try {
      this.audio = new EngineAudio();
    } catch (e) {
      console.warn('Ses başlatılamadı', e);
      this.audio = null;
    }
    this._modelReady = false;
    this._waitStart = performance.now();
    loadCarModel().then((model) => this._onModel(model));
    this._refDelta = this.refTrace ? deltaSeries(this._focusT, this.refTrace, track.lengthMeters) : null;
    this._rebuildGhosts();
    this._last = performance.now();
    this._fpsT0 = this._last;
    this._fpsN = 0;
    this._raf = requestAnimationFrame((t) => this._loop(t));
    this._onKey = (e) => this._key(e);
    window.addEventListener('keydown', this._onKey, true);
    this._onResize = () => this._resize();
    window.addEventListener('resize', this._onResize);
    this._resize();
    window.__cockpit = this;
  }

  get _focusCar() {
    return this.cars[this.focus];
  }
  get _focusT() {
    return this.cars[this.focus].T;
  }

  _makeCarRecord(rep, i) {
    const T = computeTelemetry(rep, this.track);
    const livery = LIVERIES[i % LIVERIES.length];
    const fin = rep.status === FINISHED;
    const sec = fin ? rep.lapTicks / TICK_RATE : null;
    let name;
    if (this.mode === 'heat') name = rep.label || `Araç ${i + 1}`;
    else if (this.mode === 'top5') name = rep.label || `Sürüş ${i + 1}`;
    else name = rep.label || 'Bu sürüş';
    const tag = this.mode === 'top5' ? `#${i + 1} · ${fin ? fmtShort(sec) : STATUS_SHORT[rep.status] || ''}` : name;
    return { rep, T, idx: i, livery, color: livery.base, name, tag, sec, mono: monoTable(T.dist, T.time, T.n), st: {}, inst: null, s: null };
  }

  // ----- DOM / HUD -----
  _resultText(rep) {
    return rep.status === FINISHED
      ? `Bitirdi · ${fmtLap(rep.lapTicks / TICK_RATE)}${rep.laps > 1 ? ` · ${rep.laps} tur` : ''}`
      : rep.status === CRASHED
        ? 'Tekrar sürüşünde çarptı'
        : 'Süre doldu / elendi';
  }

  _buildDom(title) {
    const rep = this._focusCar.rep;
    const multi = this.multi;
    const root = (this.root = document.createElement('div'));
    root.className = `cockpit rp-mode-${this.mode}`;
    const sub = multi ? `${MODE_LABEL[this.mode]} · ${this.cars.length} araç` : this._resultText(rep);
    root.innerHTML = `
      <canvas class="ck-canvas"></canvas>
      <div class="rp-tags"></div>
      <div class="ck-top">
        <div class="ck-title"><b>${esc(title)}</b><span class="rp-res">${esc(sub)}${rep.discrete ? ' · PPO: en olası aksiyonla sürüldü' : ''}</span></div>
        <div class="rp-topr">
          <div class="rp-pos" ${multi ? '' : 'hidden'}><div><b class="rp-p">P1</b><span class="rp-pn">/${this.cars.length}</span></div><small class="rp-gap"></small><small class="rp-cnt"></small></div>
          <div class="ck-timer"><div class="ck-lbl">Süre</div><div class="ck-time">0.00</div><div class="ck-sub"></div></div>
        </div>
      </div>
      <div class="rp-sectors"></div>
      <div class="rp-feed"></div>
      <div class="rp-pit" hidden></div>
      <canvas class="ck-map" width="220" height="220"></canvas>
      <div class="rp-tower" ${multi ? '' : 'hidden'}></div>
      <div class="ck-dash">
        <div class="rp-sys">
          <div class="rp-tyre"><b class="cmp-badge">M</b><div><span class="rp-tt">–</span><small class="rp-tw">aşınma –</small></div></div>
          <div class="rp-bar rp-wear"><i></i></div>
          <div class="rp-row"><span>Yakıt</span><b class="rp-fuel">–</b></div>
          <div class="rp-row"><span>ERS</span><b class="rp-ersk">–</b></div>
          <div class="rp-bar rp-ers"><i></i></div>
          <div class="rp-drs">DRS</div>
        </div>
        <div class="ck-pedal"><i class="ck-brake"></i><span>Fren</span></div>
        <div class="ck-center">
          <div class="ck-leds">${'<i></i>'.repeat(15)}</div>
          <div class="ck-speed">0</div><div class="ck-unit">km/s</div>
          <div class="ck-gear">V 1</div><div class="ck-rpm"></div>
          <div class="ck-steer"><i></i></div>
          <div class="ck-ai">Yapay zekâ girdisi: <span class="ck-in"></span></div>
        </div>
        <div class="ck-pedal"><i class="ck-thr"></i><span>Gaz</span></div>
      </div>
      <div class="ck-bar">
        <button data-a="play">⏸</button>
        <button data-a="restart" title="Baştan (R)">↺</button>
        <input type="range" class="ck-seek" min="0" max="${this.maxCount - 1}" step="1" value="0">
        <div class="ck-seg ck-rate">
          <button data-r="0.25">0.25x</button><button data-r="0.5">0.5x</button><button data-r="1" class="on">1x</button><button data-r="2">2x</button>
        </div>
        <div class="ck-seg ck-cam">
          <button data-c="0" class="on">Kokpit</button><button data-c="1">Burun</button><button data-c="2">T-Kamera</button><button data-c="3">Takip</button><button data-c="5">Yan</button><button data-c="4">Helikopter</button>
        </div>
        ${multi ? '<div class="ck-seg rp-focus"><button data-f="-1" title="Önceki araç ( [ )">◀</button><span class="rp-fname"></span><button data-f="1" title="Sonraki araç ( ] ) · 1-9: doğrudan seç">▶</button></div>' : ''}
        <select class="rp-cmp" title="Karşılaştırma: telemetri üst üste + delta zaman + hayalet (K)"></select>
        <button data-a="ghost" class="on" title="Hayalet araçlar (H)">Hayalet</button>
        ${multi ? '<button data-a="labels" class="on" title="Araç etiketleri (L)">Etiketler</button>' : ''}
        <button data-a="tele" title="Telemetri grafikleri (T)">Telemetri</button>
        <button data-a="export" title="Tüm verileri ZIP olarak indir (D)">⬇ Verileri indir</button>
        <button data-a="quality" title="Grafik kalitesi: Yüksek / Orta / Düşük (G)">Grafik: ${Q_LABEL[this.quality]}</button>
        <button data-a="rays" title="Sensör ışınları (S)">Sensörler</button>
        <button data-a="sound" class="on" title="Motor sesi (M)">Ses: Açık</button>
        <input type="range" class="ck-vol" min="0" max="1" step="0.05" value="0.6" title="Ses düzeyi">
        <button data-a="close" class="ck-close" title="Kapat ve eğitime dön (Esc)">✕ Eğitime dön</button>
      </div>
      <input type="file" class="rp-file" accept=".csv,text/csv,text/plain" hidden>
      <div class="ck-end" hidden></div>
      <div class="ck-tele" hidden></div>
      <div class="rp-loading">Araç modeli yükleniyor…</div>
      <div class="ck-help">C: kamera · Boşluk: duraklat · ←/→: sar · K: karşılaştır · H: hayalet${multi ? ' · 1-9 / [ ]: odak araç · L: etiketler' : ''} · G: grafik · T: telemetri · Esc: çıkış</div>`;
    document.body.appendChild(root);
    this.$ = (s) => root.querySelector(s);
    this.canvas = this.$('.ck-canvas');
    this.mapCanvas = this.$('.ck-map');
    this.tagsEl = this.$('.rp-tags');
    root.querySelector('.ck-bar').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const a = b.dataset.a;
      if (a === 'play') this._togglePlay();
      else if (a === 'restart') this._seek(0, true);
      else if (a === 'close') this.close();
      else if (a === 'rays') this._toggleRays();
      else if (a === 'sound') this._toggleSound();
      else if (a === 'tele') this._toggleTele();
      else if (a === 'export') this._export();
      else if (a === 'quality') this._toggleQuality();
      else if (a === 'ghost') this._toggleGhosts();
      else if (a === 'labels') this._toggleLabels();
      else if (b.dataset.r) this._setRate(+b.dataset.r);
      else if (b.dataset.c) this._setCam(+b.dataset.c);
      else if (b.dataset.f) this._setFocus((this.focus + +b.dataset.f + this.cars.length) % this.cars.length);
    });
    this.leds = [...root.querySelectorAll('.ck-leds i')];
    this.teleRoot = this.$('.ck-tele');
    const fc = this._focusCar;
    this.panel = new TelemetryPanel(this.teleRoot, fc.T, {
      onSeek: (i) => this._seek(i, false),
      track: this.track,
      name: fc.name,
      color: fc.color,
      others: this.multi ? this.cars.map((c) => ({ T: c.T, name: c.name, color: c.color })) : [],
    });
    this.teleRoot.addEventListener('tl-close', () => this._toggleTele(false));
    this.$('.ck-vol').addEventListener('input', (e) => {
      if (this.audio) this.audio.volume = +e.target.value;
    });
    const seek = this.$('.ck-seek');
    seek.addEventListener('input', () => this._seek(+seek.value, false));
    const sel = this.$('.rp-cmp');
    sel.addEventListener('change', () => {
      sel.blur(); // kısayol tuşları yeniden görüntüleyiciye gitsin
      this._selectCompare(sel.value);
    });
    this.$('.rp-file').addEventListener('change', (e) => this._onCsvFile(e));
    this.$('.rp-tower').addEventListener('click', (e) => {
      const r = e.target.closest('[data-car]');
      if (r) this._setFocus(+r.dataset.car);
    });
    this._buildCmpOptions();
    this._updateFocusUi();
    this._prepMap();
    // alt çubuk satır sayısı değişince (pencere genişliği, stil dosyası yüklenmesi) paneller yeniden konumlanır
    if (window.ResizeObserver) {
      this._barRO = new ResizeObserver(() => this._layoutBar());
      this._barRO.observe(root.querySelector('.ck-bar'));
    }
  }

  _buildCmpOptions() {
    const sel = this.$('.rp-cmp');
    const T = this._focusT;
    const o = [['none', 'Karşılaştırma: yok']];
    if (this.refTrace) o.push(['ref', `Gerçek F1 referansı (${this.refTrace.short} · ${fmtLap(this.refTrace.lapTime)})`]);
    if (T.laps > 1 && T.bestLap) o.push(['own', `Kendi en iyi turu (Tur ${T.bestLap.lap})`]);
    for (const opt of this.extra.compareOptions || []) o.push(['opt:' + opt.id, opt.label]);
    this.csvTraces.forEach((tr, k) => o.push(['csv:' + k, tr.label]));
    o.push(['csvload', 'CSV içe aktar…']);
    sel.innerHTML = o.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('');
    sel.value = o.some(([v]) => v === this.cmpId) ? this.cmpId : 'none';
  }

  _updateFocusUi() {
    const c = this._focusCar;
    const fn = this.$('.rp-fname');
    if (fn) fn.innerHTML = `<i style="background:${c.color}"></i>${esc(c.name)}`;
    if (this.multi) this.$('.rp-res').textContent = `${MODE_LABEL[this.mode]} · odak: ${c.name} · ${this._resultText(c.rep)}`;
  }

  _togglePlay() {
    if (!this.playing && this.t >= this.maxCount - 1) this.t = 0;
    this.playing = !this.playing;
    this.$('[data-a=play]').textContent = this.playing ? '⏸' : '▶';
    this.$('.ck-end').hidden = true;
  }
  _seek(i, play) {
    this.t = Math.max(0, Math.min(this.maxCount - 1, i));
    this.$('.ck-end').hidden = true;
    if (play) {
      this.playing = true;
      this.$('[data-a=play]').textContent = '⏸';
    }
    this._snap = true;
    this._resetEvents();
  }
  _setRate(r) {
    this.rate = r;
    for (const b of this.root.querySelectorAll('.ck-rate button')) b.classList.toggle('on', +b.dataset.r === r);
  }
  _setCam(c) {
    this.camMode = c;
    for (const b of this.root.querySelectorAll('.ck-cam button')) b.classList.toggle('on', +b.dataset.c === c);
    this._attachCamera();
    this._snap = true;
  }
  _setFocus(i) {
    if (i === this.focus || i < 0 || i >= this.cars.length) return;
    this.cars[this.focus].inst?.setHelmet(true);
    this.focus = i;
    const c = this._focusCar;
    this.rep = c.rep;
    this.tel = c.T;
    this._attachCamera();
    this._snap = true;
    if (this.cmp) {
      if (this.cmpId === 'own') {
        this._buildCmpOptions();
        this._selectCompare(c.T.laps > 1 && c.T.bestLap ? 'own' : 'none');
      } else this.cmp.delta = this.cmp.deltaFn(c.T);
    }
    if (this.refTrace) this._refDelta = deltaSeries(c.T, this.refTrace, this.track.lengthMeters);
    this.panel.setFocus(c.T, c.name, c.color);
    this._buildCmpOptions();
    this._updateFocusUi();
    this._rebuildGhosts();
    this._feed(`Odak: ${c.name}`);
  }
  _toggleSound() {
    if (!this.audio) return;
    this.audio.muted = !this.audio.muted;
    const b = this.$('[data-a=sound]');
    b.textContent = this.audio.muted ? 'Ses: Kapalı' : 'Ses: Açık';
    b.classList.toggle('on', !this.audio.muted);
  }
  _toggleTele(force) {
    const show = force ?? this.teleRoot.hidden;
    this.teleRoot.hidden = !show;
    this.$('[data-a=tele]').classList.toggle('on', show);
    this.root.classList.toggle('tele-open', show);
    if (show) {
      this.panel.layoutKey = '';
      this.panel.draw(this._focusIndex());
    }
  }
  _toggleGhosts() {
    this.ghostsOn = !this.ghostsOn;
    this.$('[data-a=ghost]').classList.toggle('on', this.ghostsOn);
  }
  _toggleLabels() {
    this.labelsOn = !this.labelsOn;
    this.$('[data-a=labels]')?.classList.toggle('on', this.labelsOn);
  }
  _toggleQuality() {
    this.setQuality(QUALITIES[(QUALITIES.indexOf(this.quality) + 1) % QUALITIES.length]);
  }
  _toggleRays() {
    this.showRays = !this.showRays;
    this.$('[data-a=rays]').classList.toggle('on', this.showRays);
    this.rays.visible = this.showRays;
  }
  _key(e) {
    if (e.target && e.target.matches && e.target.matches('select, input[type=text]')) {
      if (e.key === 'Escape') e.target.blur();
      return;
    }
    const k = e.key.toLowerCase();
    let used = true;
    if (e.key === 'Escape') this.close();
    else if (e.key === ' ') this._togglePlay();
    else if (k === 'c') this._setCam(CAM_ORDER[(CAM_ORDER.indexOf(this.camMode) + 1) % CAM_ORDER.length]);
    else if (k === 's') this._toggleRays();
    else if (k === 'm') this._toggleSound();
    else if (k === 't') this._toggleTele();
    else if (k === 'd') this._export();
    else if (k === 'g') this._toggleQuality();
    else if (k === 'h') this._toggleGhosts();
    else if (k === 'l' && this.multi) this._toggleLabels();
    else if (k === 'k') this._cycleCompare();
    else if (k === 'r') this._seek(0, true);
    else if (k === '[' && this.multi) this._setFocus((this.focus - 1 + this.cars.length) % this.cars.length);
    else if (k === ']' && this.multi) this._setFocus((this.focus + 1) % this.cars.length);
    else if (this.multi && k >= '1' && k <= '9' && +k <= this.cars.length) this._setFocus(+k - 1);
    else if (e.key === 'ArrowRight') this._seek(this.t + TICK_RATE * 2, false);
    else if (e.key === 'ArrowLeft') this._seek(this.t - TICK_RATE * 2, false);
    else used = false;
    if (used) e.preventDefault();
    e.stopPropagation();
  }

  // ----- karşılaştırma -----
  _cycleCompare() {
    const sel = this.$('.rp-cmp');
    const vals = [...sel.options].map((o) => o.value).filter((v) => v !== 'csvload');
    const next = vals[(vals.indexOf(this.cmpId) + 1) % vals.length];
    this._selectCompare(next);
  }

  async _selectCompare(val) {
    const sel = this.$('.rp-cmp');
    if (val === 'csvload') {
      sel.value = this.cmpId;
      this.$('.rp-file').click();
      return;
    }
    this.cmpId = val;
    sel.value = val;
    const track = this.track;
    let cmp = null;
    try {
      if (val === 'ref') cmp = { id: val, trace: this.refTrace };
      else if (val === 'own') {
        const T = this._focusT;
        if (!T.bestLap) throw new Error('Tamamlanmış tur yok');
        cmp = { id: val, trace: traceFromOwnLap(T, T.bestLap, track.lengthMeters) };
        cmp.trace.short = `Tur ${T.bestLap.lap}`;
      } else if (val.startsWith('opt:')) {
        const opt = (this.extra.compareOptions || []).find((o) => 'opt:' + o.id === val);
        if (!opt) throw new Error('Seçenek bulunamadı');
        sel.disabled = true;
        this._feed(`Yükleniyor: ${opt.label}`);
        const res = await opt.load();
        sel.disabled = false;
        if (this.closed || this.cmpId !== val) return;
        if (res && res.kind === 'replay' && res.replay) {
          const T2 = computeTelemetry(res.replay, track);
          cmp = { id: val, trace: traceFromTelemetry(T2, { label: opt.label }), rep: res.replay };
          cmp.trace.short = opt.short || 'Karş.';
        } else if (res && res.kind === 'reference' && res.ref) {
          cmp = { id: val, trace: traceFromReference(res.ref, track) };
        } else throw new Error('Geçersiz karşılaştırma verisi');
      } else if (val.startsWith('csv:')) {
        cmp = { id: val, trace: this.csvTraces[+val.slice(4)] };
      }
    } catch (e) {
      console.error(e);
      sel.disabled = false;
      this._feed('Karşılaştırma açılamadı: ' + e.message, 'bad');
      this.cmpId = 'none';
      sel.value = 'none';
      cmp = null;
    }
    this._applyCompare(cmp);
  }

  _applyCompare(cmp) {
    const L = this.track.lengthMeters;
    if (cmp) {
      cmp.deltaFn = (T) => deltaSeries(T, cmp.trace, L);
      cmp.delta = cmp.deltaFn(this._focusT);
      cmp.lapRows = cmp.trace.periodic ? traceLapRows(cmp.trace, this.track) : cmp.trace.T?.analysis || [];
    }
    this.cmp = cmp;
    this.panel.setComparison(cmp ? { trace: cmp.trace, delta: cmp.delta, deltaFn: cmp.deltaFn } : null);
    this._rebuildGhosts();
    if (cmp && this.teleRoot.hidden) this._toggleTele(true);
  }

  async _onCsvFile(e) {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const buf = new Uint8Array(await f.arrayBuffer());
      let text;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
      } catch {
        text = new TextDecoder('windows-1254').decode(buf); // Türkçe Excel
      }
      const parsed = parseLapCSV(text, f.name);
      const tr = traceFromCSV(parsed, this.track);
      this.csvTraces.push(tr);
      this._buildCmpOptions();
      this._feed(`CSV yüklendi: ${parsed.dist.length} satır · sütunlar: ${Object.values(parsed.columns).join(', ')}${tr.periodic ? '' : ' (çok turlu: mutlak mesafe)'}`);
      await this._selectCompare('csv:' + (this.csvTraces.length - 1));
    } catch (err) {
      console.warn(err);
      this._feed('CSV okunamadı: ' + err.message, 'bad');
    }
  }

  // Test ve otomasyon için: CSV metnini doğrudan içe aktar
  async importCsvText(text, name = 'import.csv') {
    const parsed = parseLapCSV(text, name);
    const tr = traceFromCSV(parsed, this.track);
    this.csvTraces.push(tr);
    this._buildCmpOptions();
    await this._selectCompare('csv:' + (this.csvTraces.length - 1));
    return tr;
  }

  // ----- hayaletler -----
  _rebuildGhosts() {
    for (const g of this.ghosts) {
      this.scene?.remove(g.inst.root);
      g.inst.dispose();
      g.tag?.remove();
    }
    this.ghosts = [];
    if (!this.factory) return;
    const add = (spec) => {
      const inst = this.factory.ghost(spec.color, spec.opacity ?? 0.4);
      this.scene.add(inst.root);
      const tag = document.createElement('div');
      tag.className = 'rp-tag ghost';
      tag.style.setProperty('--c', spec.color);
      this.tagsEl.appendChild(tag);
      this.ghosts.push({ ...spec, inst, tag, st: {} });
    };
    if (this.refTrace) add({ id: 'ref', kind: 'periodic', trace: this.refTrace, color: this.refTrace.color, name: `Gerçek F1 · ${this.refTrace.short}`, delta: () => this._refDelta });
    const c = this.cmp;
    if (c && c.id !== 'ref') {
      if (c.rep) add({ id: 'cmp', kind: 'replay', rep: c.rep, color: c.trace.color, name: c.trace.label, delta: () => c.delta });
      else add({ id: 'cmp', kind: 'periodic', trace: c.trace, color: c.trace.color, name: c.trace.label, delta: () => c.delta });
    }
  }

  // Odak aracın pit kaybı çıkarılmış zamanı ve içinde bulunduğu turun başlangıcı
  _focusLapClock(fi) {
    const T = this._focusT, L = this.track.lengthMeters;
    const d = T.dist[fi];
    const lapIdx = Math.max(0, Math.min(T.laps - 1, Math.floor(Math.max(0, d) / L)));
    const lap = T.analysis[lapIdx];
    const t0 = lapIdx === 0 || !lap ? 0 : lap.t0;
    let tnp = T.tnp[fi];
    // odak araç bitirdiyse saat işlemeye devam eder (hayalet turunu tamamlayabilsin)
    const over = this.t - (T.n - 1);
    if (over > 0) tnp += over / TICK_RATE;
    return { tau: tnp - t0, lapIdx };
  }

  _updateGhosts(dt) {
    const tr = this.track;
    for (const g of this.ghosts) {
      let x, y, ang, ok = true;
      if (g.kind === 'replay') {
        const s = this._sampleRep(g.rep, this.t);
        x = s.x; y = s.y; ang = s.ang;
      } else {
        const fi = this._focusIndex();
        const { tau } = this._focusLapClock(fi);
        const d = traceDistAtTime(g.trace, tau);
        if (!isFinite(d)) ok = false;
        else if (g.trace.x) {
          const tt = g.trace.time, n = tt.length;
          const tc = Math.max(0, Math.min(tt[n - 1], tau));
          let lo = 0, hi = n - 1;
          while (hi - lo > 1) { const m = (lo + hi) >> 1; if (tt[m] <= tc) lo = m; else hi = m; }
          const f = (tc - tt[lo]) / (tt[hi] - tt[lo] || 1);
          x = g.trace.x[lo] + (g.trace.x[hi] - g.trace.x[lo]) * f;
          y = g.trace.y[lo] + (g.trace.y[hi] - g.trace.y[lo]) * f;
          ang = lerpAngle(g.trace.ang[lo], g.trace.ang[hi], f);
        } else {
          const p = this._centrelineAt(d / K);
          x = p.x; y = p.y; ang = p.ang;
        }
      }
      const st = g.st;
      g.visible = ok && this.ghostsOn;
      if (!g.visible) {
        g.inst.root.visible = false;
        continue;
      }
      const el = this._elevAt(x, y);
      if (this._snap || st.y == null) {
        st.y = el.h;
        st.pitch = Math.atan(el.grade);
      } else {
        st.y += (el.h - st.y) * Math.min(1, dt * 20);
        st.pitch += (Math.atan(el.grade) - st.pitch) * Math.min(1, dt * 8);
      }
      const yawT = -ang - Math.PI / 2;
      st.yaw = st.yaw == null || this._snap ? yawT : lerpAngle(st.yaw, yawT, Math.min(1, dt * 18));
      g.inst.root.position.set(x * K, st.y, y * K);
      g.inst.root.rotation.set(st.pitch, st.yaw, 0, 'YXZ');
    }
  }

  // Merkez çizgisi üzerinde yay uzunluğu (px) → konum ve yön
  _centrelineAt(sPx) {
    const t = this.track;
    const L = t.length;
    let s = ((sPx % L) + L) % L;
    const f0 = s / t.ds;
    const k = Math.floor(f0) % t.n, k2 = (k + 1) % t.n, f = f0 - Math.floor(f0);
    return {
      x: t.cx[k] + (t.cx[k2] - t.cx[k]) * f,
      y: t.cy[k] + (t.cy[k2] - t.cy[k]) * f,
      ang: lerpAngle(t.tan[k], t.tan[k2], f),
      k,
    };
  }

  _prepMap() {
    const t = this.track, b = t.bounds;
    const W = this.mapCanvas.width, H = this.mapCanvas.height;
    const sc = Math.min((W - 20) / b.w, (H - 20) / b.h);
    this.mapTf = (x, y) => [10 + (x - b.minX) * sc + ((W - 20) - b.w * sc) / 2, 10 + (y - b.minY) * sc + ((H - 20) - b.h * sc) / 2];
    const off = document.createElement('canvas');
    off.width = W;
    off.height = H;
    const g = off.getContext('2d');
    g.lineJoin = 'round';
    g.beginPath();
    for (let i = 0; i <= t.n; i++) {
      const [x, y] = this.mapTf(t.cx[i % t.n], t.cy[i % t.n]);
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.strokeStyle = 'rgba(255,255,255,0.85)';
    g.lineWidth = 5;
    g.stroke();
    g.strokeStyle = '#30343b';
    g.lineWidth = 3;
    g.stroke();
    // DRS bölgeleri
    g.strokeStyle = 'rgba(0,230,118,0.75)';
    g.lineWidth = 3;
    for (const z of t.drsZones || []) {
      g.beginPath();
      const k0 = Math.floor(z.s0 / t.ds), k1 = Math.floor(z.s1 / t.ds);
      const len = (k1 - k0 + t.n) % t.n;
      for (let j = 0; j <= len; j++) {
        const k = (k0 + j) % t.n;
        const [x, y] = this.mapTf(t.cx[k], t.cy[k]);
        if (j === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.stroke();
    }
    // sektör sınırları
    const sf = t.sectorFrac || [];
    g.fillStyle = '#ffd166';
    for (const f of sf.slice(0, 2)) {
      const k = Math.floor((f * t.n) % t.n);
      const [x, y] = this.mapTf(t.cx[k], t.cy[k]);
      g.fillRect(x - 2, y - 2, 4, 4);
    }
    const [sx, sy] = this.mapTf(t.cx[0], t.cy[0]);
    g.fillStyle = '#fff';
    g.fillRect(sx - 3, sy - 3, 6, 6);
    this.mapBase = off;
  }

  _drawMap() {
    const g = this.mapCanvas.getContext('2d');
    const W = this.mapCanvas.width, H = this.mapCanvas.height;
    g.clearRect(0, 0, W, H);
    g.drawImage(this.mapBase, 0, 0);
    const fc = this._focusCar;
    const F = fc.rep.frames, S = FRAME_STRIDE;
    const i = this._focusIndex();
    g.beginPath();
    for (let k = 0; k <= i; k += 4) {
      const [x, y] = this.mapTf(F[k * S], F[k * S + 1]);
      if (k === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.strokeStyle = '#00e5ff';
    g.lineWidth = 2;
    g.stroke();
    for (const gh of this.ghosts) {
      if (!gh.visible) continue;
      const p = gh.inst.root.position;
      const [x, y] = this.mapTf(p.x / K, p.z / K);
      g.strokeStyle = gh.color;
      g.lineWidth = 2;
      g.beginPath();
      g.arc(x, y, 4.5, 0, Math.PI * 2);
      g.stroke();
    }
    for (let c = this.cars.length - 1; c >= 0; c--) {
      const car = this.cars[c];
      if (!car.s || car === fc) continue;
      const [x, y] = this.mapTf(car.s.x, car.s.y);
      g.fillStyle = car.color;
      g.globalAlpha = car.inst?.root.visible === false ? 0.3 : 1;
      g.beginPath();
      g.arc(x, y, 3.6, 0, Math.PI * 2);
      g.fill();
      g.globalAlpha = 1;
    }
    if (fc.s) {
      const [x, y] = this.mapTf(fc.s.x, fc.s.y);
      g.fillStyle = '#ff4081';
      g.beginPath();
      g.arc(x, y, 5, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = '#fff';
      g.lineWidth = 1.5;
      g.stroke();
    }
  }

  // ----- sahne -----
  _buildScene() {
    const track = this.track;
    const r = (this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, powerPreference: 'high-performance', logarithmicDepthBuffer: true }));
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 0.95;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.info.autoReset = false;
    const maxAniso = r.capabilities.getMaxAnisotropy();
    this.maxAniso = maxAniso;

    K = track.mpp;
    const M = (m) => m / K; // metre → piksel
    this.M = M;
    const scene = (this.scene = new THREE.Scene());
    const horizon = new THREE.Color(0xcfe2f3);
    scene.fog = new THREE.Fog(horizon, 300, 3200);
    scene.background = horizon;

    const b = track.bounds;
    const cx = (b.minX + b.w / 2) * K, cz = (b.minY + b.h / 2) * K;
    this.center = new THREE.Vector3(cx, 0, cz);

    // gökyüzü kubbesi (dikey renk geçişli) + aynı gökyüzünden üretilen ortam yansıması (boya, karbon, metal)
    this.sunDir = new THREE.Vector3(-0.45, 0.62, -0.48).normalize();
    const makeSky = (radius) => new THREE.Mesh(
      new THREE.SphereGeometry(radius, 48, 24),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        uniforms: {
          top: { value: new THREE.Color(0x1d5fc4) },
          mid: { value: new THREE.Color(0x6fa6e6) },
          bottom: { value: horizon.clone() },
          sun: { value: this.sunDir.clone() },
        },
        vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
        fragmentShader:
          'uniform vec3 top; uniform vec3 mid; uniform vec3 bottom; uniform vec3 sun; varying vec3 vP; void main(){ float h = vP.y; vec3 c = h > 0.1 ? mix(mid, top, smoothstep(0.1, 0.75, h)) : mix(bottom, mid, smoothstep(-0.03, 0.1, h)); float d = max(dot(normalize(vP), sun), 0.0); c += vec3(1.0, 0.92, 0.75) * (pow(d, 900.0) * 6.0 + pow(d, 12.0) * 0.18); gl_FragColor = vec4(c, 1.0); }',
      }),
    );
    const sky = makeSky(5200);
    sky.position.copy(this.center);
    scene.add(sky);
    this.sky = sky;
    const pmrem = new THREE.PMREMGenerator(r);
    const envScene = new THREE.Scene();
    envScene.add(makeSky(800));
    const groundEnv = new THREE.Mesh(new THREE.CircleGeometry(700, 32), new THREE.MeshBasicMaterial({ color: 0x4d6b41 }));
    groundEnv.rotation.x = -Math.PI / 2;
    groundEnv.position.y = -5;
    envScene.add(groundEnv);
    this.envRT = pmrem.fromScene(envScene, 0.02);
    scene.environment = this.envRT.texture;
    pmrem.dispose();
    envScene.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });

    // ışıklar
    scene.add(new THREE.HemisphereLight(0xdcecff, 0x4b6a3c, 0.6));
    const sun = (this.sun = new THREE.DirectionalLight(0xfff0d8, 2.6));
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = -16; sc.right = 16; sc.top = 16; sc.bottom = -16; sc.near = 1; sc.far = 140;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.02;
    scene.add(sun);
    scene.add(sun.target);

    // zemin: pistin yüksekliğini takip eden arazi. Uzak ova EN ALT seviyede durur ve arazinin kenarı ona iner:
    // hiçbir zemin parçası pistin üstüne çıkamaz.
    this._prepTerrain();
    const gt = grassTex();
    gt.anisotropy = maxAniso;
    const pad = M(650);
    const tw = (b.w + pad * 2) * K, th = (b.h + pad * 2) * K;
    this.terrainRect = { x0: cx - tw / 2, x1: cx + tw / 2, z0: cz - th / 2, z1: cz + th / 2 };
    const seg = 180;
    const tg = new THREE.PlaneGeometry(tw, th, seg, seg);
    tg.rotateX(-Math.PI / 2);
    const tp = tg.attributes.position;
    for (let i = 0; i < tp.count; i++) {
      const x = tp.getX(i) + cx, z = tp.getZ(i) + cz;
      tp.setXYZ(i, x, this.terrainH(x / K, z / K), z);
    }
    tg.computeVertexNormals();
    gt.repeat.set(tw / 7, th / 7);
    const terrain = new THREE.Mesh(tg, new THREE.MeshLambertMaterial({ map: gt }));
    terrain.receiveShadow = true;
    scene.add(terrain);
    const gt2 = grassTex();
    gt2.repeat.set(1400, 1400);
    const far = new THREE.Mesh(new THREE.PlaneGeometry(14000, 14000), new THREE.MeshLambertMaterial({ map: gt2 }));
    far.rotation.x = -Math.PI / 2;
    far.position.set(cx, this.floorY - 0.05, cz);
    scene.add(far);

    const hw = track.halfWidth;
    const mat = (o) => {
      const m = new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0, ...o });
      if (m.map) m.map.anisotropy = maxAniso;
      return m;
    };
    // kaçış alanı: önce boyalı asfalt, sonra çakıl
    const runoffMat = mat({ map: runoffTex(), side: THREE.DoubleSide, roughness: 0.9 });
    const gravel = gravelTex();
    const gravelMat = mat({ map: gravel, side: THREE.DoubleSide });
    for (const s of [1, -1]) {
      const ro = new THREE.Mesh(ribbon(track, s, hw + M(1.0), hw + M(5.5), 1 / 9, -0.04), runoffMat);
      ro.receiveShadow = true;
      scene.add(ro);
      const m = new THREE.Mesh(ribbon(track, s, hw + M(5.4), hw + M(12.5), 1 / 6, -0.05), gravelMat);
      m.receiveShadow = true;
      scene.add(m);
    }
    // set yamaçları: pist kenarından araziye inen çimen şerit (pist havada asılı görünmesin)
    const skirtTex = grassTex();
    skirtTex.repeat.set(2, 1);
    const skirtMat = new THREE.MeshLambertMaterial({ map: skirtTex, side: THREE.DoubleSide });
    for (const s of [1, -1]) {
      const m = new THREE.Mesh(ribbon(track, s, hw + M(12.4), hw + M(24), 1 / 8, -0.06, -2.2), skirtMat);
      m.receiveShadow = true;
      scene.add(m);
    }
    // asfalt
    const asph = mat({ map: asphaltTex(), side: THREE.DoubleSide, roughness: 0.85 });
    const road = new THREE.Mesh(ribbon(track, 1, -hw, hw, 1 / 14, 0.0), asph);
    road.receiveShadow = true;
    scene.add(road);
    // kerbler
    const kerbMat = mat({ map: kerbTex(), side: THREE.DoubleSide, roughness: 0.6 });
    for (const s of [1, -1]) {
      const m = new THREE.Mesh(ribbon(track, s, hw - M(0.25), hw + M(1.6), 1 / 3, 0.035, 0.09), kerbMat);
      m.receiveShadow = true;
      scene.add(m);
    }
    // bariyer duvarları
    const wt = wallTex();
    const wallMat = mat({ map: wt, side: THREE.DoubleSide, roughness: 0.8 });
    for (const s of [1, -1]) {
      const w = new THREE.Mesh(wallGeometry(track, s, hw + M(12), 1.05), wallMat);
      w.castShadow = false;
      w.receiveShadow = true;
      scene.add(w);
    }
    // seyirci güvenlik çiti (duvarın üstünde)
    const ft = fenceTex();
    ft.anisotropy = maxAniso;
    const fenceMat = new THREE.MeshStandardMaterial({ map: ft, transparent: true, alphaTest: 0.25, side: THREE.DoubleSide, roughness: 0.6, metalness: 0.4, depthWrite: true });
    for (const s of [1, -1]) {
      const f = new THREE.Mesh(wallGeometry(track, s, hw + M(12.2), 3.6, 1.0), fenceMat);
      scene.add(f);
    }
    // start/finiş çizgisi + köprü
    const sx = track.cx[0] * K, sz = track.cy[0] * K, sa = track.tan[0];
    const line = new THREE.Mesh(new THREE.PlaneGeometry(1.4, hw * 2 * K), new THREE.MeshStandardMaterial({ map: checkerTex(2, 16), roughness: 0.8 }));
    line.rotation.x = -Math.PI / 2;
    line.rotation.z = -sa;
    line.position.set(sx, track.elev[0] + 0.045, sz);
    scene.add(line);
    const gantry = new THREE.Group();
    const postMat = new THREE.MeshStandardMaterial({ color: 0x9e9e9e, metalness: 0.6, roughness: 0.4 });
    const span = (hw + M(13)) * K;
    for (const s of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.5, 7.5, 0.5), postMat);
      post.position.set(0, 3.75, s * span);
      post.castShadow = true;
      gantry.add(post);
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.4, span * 2 + 0.5), new THREE.MeshStandardMaterial({ map: checkerTex(16, 2), roughness: 0.6 }));
    beam.material.map.rotation = Math.PI / 2;
    beam.position.set(0, 7.2, 0);
    gantry.add(beam);
    for (let k = -2; k <= 2; k++) {
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.18, 10, 8), new THREE.MeshBasicMaterial({ color: 0x00e676 }));
      lamp.position.set(-0.62, 6.4, k * 0.55);
      gantry.add(lamp);
    }
    gantry.position.set(sx, track.elev[0], sz);
    gantry.rotation.y = -sa;
    scene.add(gantry);

    // pist çevresi: tribünler, pit binası, afişler, köprüler… (scenery.js); hata olursa basit tribünler
    try {
      this.scenery = buildScenery({
        THREE, scene, track, K, M,
        terrainH: (x, y) => this.terrainH(x, y),
        freeAt: (x, y, d) => this._freeAt(x, y, d),
        envMap: this.envRT.texture,
        quality: this.quality === 'high' ? 'high' : 'medium',
        maxAniso,
      });
    } catch (e) {
      console.warn('Pist çevresi oluşturulamadı, basit tribünler kullanılıyor:', e);
      this.scenery = null;
      this._buildStands();
    }
    this._buildTrees();
    this._buildHills();
    this._buildClouds();

    // araçlar: GLB yüklenene kadar prosedürel (yükleme bitince değiştirilir)
    this.factory = new CarFactory({ envMap: this.envRT.texture, model: null });
    for (const c of this.cars) this._spawnCar(c);

    // sensör ışınları
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(NRAY * 6), 3));
    rg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(NRAY * 6), 3));
    this.rays = new THREE.LineSegments(rg, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9, depthTest: false }));
    this.rays.visible = false;
    this.rays.renderOrder = 10;
    this.rays.frustumCulled = false;
    scene.add(this.rays);

    this.camera = new THREE.PerspectiveCamera(72, 1, 0.06, 12000);
    this.setQuality(this.quality);
    this.postfx = null;
    try {
      this.postfx = createPostFX(this.renderer, this.scene, this.camera, { quality: this.quality === 'low' ? 'off' : this.quality });
    } catch (e) {
      console.warn('Son işleme devre dışı:', e);
      this.postfx = null;
    }
    this.camPos = new THREE.Vector3();
    this.camLook = new THREE.Vector3();
    this._attachCamera();
    this._snap = true;
  }

  _spawnCar(c) {
    if (c.inst) {
      this.scene.remove(c.inst.root);
      c.inst.dispose();
    }
    c.inst = this.factory.make(c.livery, { lod: this.multi });
    this.scene.add(c.inst.root);
    c.st = {};
    if (!c.tagEl && this.multi) {
      c.tagEl = document.createElement('div');
      c.tagEl.className = 'rp-tag';
      c.tagEl.style.setProperty('--c', c.color);
      this.tagsEl.appendChild(c.tagEl);
    }
  }

  _onModel(model) {
    if (this.closed) return;
    this._modelReady = true;
    this.$('.rp-loading').hidden = true;
    this.stats.model = model ? `GLB (${model.tris.toLocaleString('tr-TR')} üçgen, ${model.loadMs} ms)` : 'prosedürel';
    if (!model) return;
    this.factory.model = model;
    this.factory._ghostGeo?.dispose();
    this.factory._ghostGeo = null;
    for (const c of this.cars) this._spawnCar(c);
    this._rebuildGhosts();
    this._attachCamera();
    this._snap = true;
  }

  _attachCamera() {
    const cam = this.camera;
    if (cam.parent) cam.parent.remove(cam);
    const car = this._focusCar.inst;
    for (const c of this.cars) c.inst?.setHelmet(true);
    if (this.camMode === 0) {
      car.root.add(cam);
      cam.position.set(0, 0.97, 0.02);
      this.camPitch = -0.06;
      car.setHelmet(false);
    } else if (this.camMode === 1) {
      car.root.add(cam);
      cam.position.set(0, 0.58, -2.05); // burun kamerası: ön aksın önünde, burnun üstünde
      this.camPitch = -0.1;
    } else if (this.camMode === 2) {
      car.root.add(cam);
      cam.position.set(0, 1.42, 0.55);
      this.camPitch = -0.07;
    } else {
      this.scene.add(cam);
    }
  }

  _prepTerrain() {
    const t = this.track;
    const step = 3;
    const xs = [], ys = [], es = [];
    for (let i = 0; i < t.n; i += step) {
      xs.push(t.cx[i]);
      ys.push(t.cy[i]);
      es.push(t.elev[i]);
    }
    this.tpX = Float32Array.from(xs);
    this.tpY = Float32Array.from(ys);
    this.tpE = Float32Array.from(es);
    let sum = 0, mn = Infinity;
    for (let i = 0; i < t.n; i++) {
      sum += t.elev[i];
      mn = Math.min(mn, t.elev[i]);
    }
    this.baseElev = sum / t.n;
    // her şeyin altında kalan zemin seviyesi (uzak ova)
    this.floorY = mn - 2.5;
  }

  // Arazi yüksekliği (m). Pistin çevresinde, yakındaki pist bölümlerinin EN ALÇAK olanının altında kalır;
  // pistten uzaklaştıkça hafifçe yükselip tepeler oluşturur, arazi sınırına yaklaşınca uzak ova seviyesine iner.
  terrainH(x, y) {
    const X = this.tpX, Y = this.tpY, E = this.tpE;
    let best = Infinity;
    for (let i = 0; i < X.length; i++) {
      const dx = X[i] - x, dy = Y[i] - y;
      const d = dx * dx + dy * dy;
      if (d < best) best = d;
    }
    const dmin = Math.sqrt(best);
    const reach = dmin + 60 / K;
    const r2 = reach * reach;
    let eMin = Infinity;
    for (let i = 0; i < X.length; i++) {
      const dx = X[i] - x, dy = Y[i] - y;
      if (dx * dx + dy * dy <= r2 && E[i] < eMin) eMin = E[i];
    }
    const e = eMin - 1.8;
    const dm = dmin * K;
    const near = this.track.halfWidth * K + 32;
    let h = e;
    if (dm > near) {
      let u = Math.min(1, (dm - near) / 300);
      u = u * u * (3 - 2 * u);
      const hill = Math.min(this.baseElev - 1.8, e + (dm - near) * 0.08);
      h = e * (1 - u) + Math.max(e, hill) * u;
    }
    // arazi kenarında uzak ova seviyesine in
    const R = this.terrainRect;
    if (R) {
      const wx = x * K, wz = y * K;
      const de = Math.min(wx - R.x0, R.x1 - wx, wz - R.z0, R.z1 - wz);
      if (de < 220) {
        const u = Math.max(0, de) / 220;
        h = this.floorY + (h - this.floorY) * u * u * (3 - 2 * u);
      }
    }
    return Math.max(this.floorY, h);
  }

  // q: 'high' | 'medium' | 'low' (low = son işleme kapalı)
  setQuality(q) {
    if (q === 'off') q = 'low';
    if (!QUALITIES.includes(q)) q = 'medium';
    this.quality = q;
    const r = this.renderer;
    const dpr = window.devicePixelRatio || 1;
    r.setPixelRatio(q === 'high' ? Math.min(dpr, 1.5) : q === 'medium' ? Math.min(dpr, 1.25) : 1);
    const size = q === 'low' ? 1024 : 2048;
    if (this.sun.shadow.mapSize.x !== size) {
      this.sun.shadow.mapSize.set(size, size);
      if (this.sun.shadow.map) {
        this.sun.shadow.map.dispose();
        this.sun.shadow.map = null;
      }
    }
    this.scenery?.setQuality(q === 'high' ? 'high' : 'medium');
    this.postfx?.setQuality(q === 'low' ? 'off' : q);
    const b = this.$ && this.$('[data-a=quality]');
    if (b) b.textContent = `Grafik: ${Q_LABEL[q]}`;
    this._resize?.();
  }

  _freeAt(x, y, minDist) {
    const t = this.track;
    const d = t.halfWidth - t.sdfAt(x, y);
    return d >= minDist;
  }

  // Yedek: scenery.js çalışmazsa basit tribünler
  _buildStands() {
    const t = this.track;
    const hw = t.halfWidth;
    const crowd = new THREE.MeshStandardMaterial({ map: crowdTex(), roughness: 0.9 });
    const concrete = new THREE.MeshStandardMaterial({ color: 0xbdbdbd, roughness: 0.9 });
    const roofMat = new THREE.MeshStandardMaterial({ color: 0xeceff1, roughness: 0.5, metalness: 0.3 });
    const M = this.M;
    const segLen = M(25); // px
    const placeAt = (s0, s1) => {
      let bestSide = 0, bestScore = -1;
      for (const side of [1, -1]) {
        let score = 0;
        for (let s = s0; s < s1; s += segLen) {
          const k = Math.floor((((s % t.length) + t.length) % t.length) / t.ds);
          const nx = -Math.sin(t.tan[k]) * side, ny = Math.cos(t.tan[k]) * side;
          if (this._freeAt(t.cx[k] + nx * (hw + M(19)), t.cy[k] + ny * (hw + M(19)), hw + M(16))) score++;
        }
        if (score > bestScore) { bestScore = score; bestSide = side; }
      }
      for (let s = s0; s < s1; s += segLen) {
        const k = Math.floor((((s % t.length) + t.length) % t.length) / t.ds);
        const side = bestSide;
        const nx = -Math.sin(t.tan[k]) * side, ny = Math.cos(t.tan[k]) * side;
        const ox = t.cx[k] + nx * (hw + M(19)), oy = t.cy[k] + ny * (hw + M(19));
        if (!this._freeAt(ox, oy, hw + M(16))) continue;
        if (!this._freeAt(t.cx[k] + nx * (hw + M(28)), t.cy[k] + ny * (hw + M(28)), hw + M(24))) continue;
        const g = new THREE.Group();
        const L = segLen * K * 0.98;
        for (let tier = 0; tier < 5; tier++) {
          const m = new THREE.Mesh(new THREE.BoxGeometry(L, 0.9, 1.5), crowd);
          m.position.set(0, 0.45 + tier * 0.9, tier * 1.5);
          g.add(m);
        }
        const back = new THREE.Mesh(new THREE.BoxGeometry(L, 6, 0.4), concrete);
        back.position.set(0, 3, 7.4);
        g.add(back);
        const roof = new THREE.Mesh(new THREE.BoxGeometry(L, 0.15, 8.5), roofMat);
        roof.position.set(0, 8.2, 3.6);
        roof.rotation.x = 0.06;
        g.add(roof);
        g.position.set(ox * K, t.elev[k] - 0.05, oy * K);
        g.rotation.y = -Math.atan2(ny, nx) + Math.PI / 2;
        this.scene.add(g);
      }
    };
    placeAt(-t.length * 0.06, t.length * 0.07);
  }

  _buildTrees() {
    const t = this.track, b = t.bounds;
    const count = 900;
    const trunkGeo = new THREE.CylinderGeometry(0.25, 0.35, 2.4, 6);
    const leafGeo = new THREE.ConeGeometry(2.2, 6.5, 7);
    const roundGeo = new THREE.IcosahedronGeometry(2.6, 0);
    const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshLambertMaterial({ color: 0x5d4037 }), count);
    const leaves = new THREE.InstancedMesh(leafGeo, new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true }), count);
    const rounds = new THREE.InstancedMesh(roundGeo, new THREE.MeshLambertMaterial({ color: 0xffffff, flatShading: true }), count);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sv = new THREE.Vector3(), pv = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const col = new THREE.Color();
    let n = 0, nc = 0, nr = 0, tries = 0;
    const pad = this.M(520);
    while (n < count && tries < count * 20) {
      tries++;
      const x = b.minX - pad + Math.random() * (b.w + pad * 2);
      const y = b.minY - pad + Math.random() * (b.h + pad * 2);
      if (!this._freeAt(x, y, t.halfWidth + this.M(24))) continue;
      if (this.scenery?.isOccupied(x, y, this.M(3))) continue;
      const gy = this.terrainH(x, y);
      const s = 0.7 + Math.random() * 0.9;
      q.setFromAxisAngle(up, Math.random() * Math.PI * 2);
      pv.set(x * K, gy + 1.2 * s, y * K);
      sv.set(s, s, s);
      m.compose(pv, q, sv);
      trunks.setMatrixAt(n, m);
      if (Math.random() < 0.5) {
        pv.set(x * K, gy + (2.4 + 3.2) * s, y * K);
        m.compose(pv, q, sv);
        leaves.setMatrixAt(nc, m);
        leaves.setColorAt(nc, col.setHSL(0.27 + Math.random() * 0.08, 0.45, 0.22 + Math.random() * 0.1));
        nc++;
      } else {
        pv.set(x * K, gy + (2.4 + 1.9) * s, y * K);
        m.compose(pv, q, sv);
        rounds.setMatrixAt(nr, m);
        rounds.setColorAt(nr, col.setHSL(0.22 + Math.random() * 0.1, 0.5, 0.26 + Math.random() * 0.1));
        nr++;
      }
      n++;
    }
    trunks.count = n;
    leaves.count = nc;
    rounds.count = nr;
    for (const im of [trunks, leaves, rounds]) {
      im.castShadow = false;
      im.computeBoundingSphere();
      this.scene.add(im);
    }
  }

  _buildHills() {
    const seg = 96, R = 2300;
    const pos = [];
    const idx = [];
    const heights = [];
    for (let i = 0; i < seg; i++) heights.push(60 + Math.random() * 190 + 80 * Math.sin(i * 0.37));
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const h = heights[i % seg];
      const x = this.center.x + Math.cos(a) * R, z = this.center.z + Math.sin(a) * R;
      pos.push(x, this.floorY - 1, z, x, this.floorY + h, z);
    }
    for (let i = 0; i < seg; i++) {
      const a = 2 * i;
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    const hills = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: 0x6f8f86, side: THREE.DoubleSide, flatShading: true }));
    this.scene.add(hills);
  }

  _buildClouds() {
    this.clouds = [];
    const texs = [cloudTex(), cloudTex(), cloudTex()];
    for (let i = 0; i < 46; i++) {
      const mat = new THREE.SpriteMaterial({ map: texs[i % 3], fog: false, depthWrite: false, transparent: true, opacity: 0.75 + Math.random() * 0.25 });
      const s = new THREE.Sprite(mat);
      const a = Math.random() * Math.PI * 2, d = 200 + Math.random() * 2200;
      s.position.set(this.center.x + Math.cos(a) * d, this.baseElev + 160 + Math.random() * 260, this.center.z + Math.sin(a) * d);
      const w = 220 + Math.random() * 420;
      s.scale.set(w, w * 0.45, 1);
      this.scene.add(s);
      this.clouds.push(s);
    }
  }

  _resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.postfx?.setSize();
    this._vw = w;
    this._vh = h;
    this._layoutBar();
  }

  // alt çubuğun yüksekliği (satır sayısı pencere genişliğine bağlı) → panel konumları
  _layoutBar() {
    const bar = this.root?.querySelector('.ck-bar');
    if (bar) this.root.style.setProperty('--barh', bar.offsetHeight + 'px');
  }

  // ----- oynatma -----
  _focusIndex() {
    return Math.max(0, Math.min(this._focusCar.rep.count - 1, Math.floor(this.t)));
  }

  // Bir tekrarın t anındaki durumu (kareler arası ara değerli). Bitiren araç son kareden sonra yavaşlayarak pist boyunca süzülür.
  _sampleRep(rep, t) {
    const F = rep.frames, S = FRAME_STRIDE;
    const n = rep.count;
    const tc = Math.max(0, Math.min(n - 1, t));
    const i = Math.floor(tc);
    const j = Math.min(n - 1, i + 1);
    const f = tc - i;
    const a = i * S, b = j * S;
    const s = {
      i,
      x: F[a] + (F[b] - F[a]) * f,
      y: F[a + 1] + (F[b + 1] - F[a + 1]) * f,
      ang: lerpAngle(F[a + 2], F[b + 2], f),
      spd: F[a + 3] + (F[b + 3] - F[a + 3]) * f, // m/s
      steer: F[b + 4],
      thr: F[b + 5],
      prog: F[a + 6] + (F[b + 6] - F[a + 6]) * f,
      steerPos: F[a + 7] + (F[b + 7] - F[a + 7]) * f,
      slip: F[b + 8],
      rayOff: b + FR.rays,
      o: b,
      over: Math.max(0, t - (n - 1)),
      coasting: false,
    };
    if (s.over > 0 && rep.status === FINISHED) this._coast(s);
    return s;
  }

  _coast(s) {
    const tr = this.track;
    const tau = s.over / TICK_RATE, tcst = 4.5;
    const v0 = s.spd;
    const ex = v0 * tcst * (1 - Math.exp(-tau / tcst)); // m
    const L = tr.length;
    const s0 = ((s.prog % L) + L) % L;
    const k0 = Math.floor(s0 / tr.ds) % tr.n;
    const nx = -Math.sin(tr.tan[k0]), ny = Math.cos(tr.tan[k0]);
    const lat = (s.x - tr.cx[k0]) * nx + (s.y - tr.cy[k0]) * ny;
    const p = this._centrelineAt(s0 + ex / K);
    const lat1 = lat * Math.exp(-tau / 2.5);
    const nx1 = -Math.sin(p.ang), ny1 = Math.cos(p.ang);
    s.x = p.x + nx1 * lat1;
    s.y = p.y + ny1 * lat1;
    s.ang = lerpAngle(s.ang, p.ang, Math.min(1, tau * 1.5));
    s.spd = v0 * Math.exp(-tau / tcst);
    s.thr = 0;
    s.steer = 0;
    s.steerPos = 0;
    s.slip = 0;
    s.coasting = true;
  }

  // pist üzerindeki konumun yüksekliği ve eğimi
  _elevAt(x, y) {
    const t = this.track;
    const sAt = t.sAt(x, y);
    let i = Math.floor(sAt / t.ds) % t.n;
    if (i < 0) i += t.n;
    return { h: t.elev[i], grade: t.grade[i] };
  }

  // Vites ve devir: telemetriden (aynı değerler grafiklerde de görünür)
  _gearRpm(T, t) {
    const i = Math.max(0, Math.min(T.n - 1, Math.floor(t)));
    const j = Math.min(T.n - 1, i + 1), f = Math.max(0, Math.min(1, t - i));
    const rpm = T.gear[i] === T.gear[j] ? T.rpm[i] + (T.rpm[j] - T.rpm[i]) * f : T.rpm[i];
    return { gear: T.gear[i], rpm };
  }

  _updateCar(c, dt) {
    const st = c.st;
    const s = (c.s = this._sampleRep(c.rep, this.t));
    const px = s.x * K, pz = s.y * K;
    const el = this._elevAt(s.x, s.y);
    if (this._snap || st.carY == null) {
      st.carY = el.h;
      st.pitch = Math.atan(el.grade);
    } else {
      st.carY += (el.h - st.carY) * Math.min(1, dt * 20);
      st.pitch += (Math.atan(el.grade) - st.pitch) * Math.min(1, dt * 8);
    }
    const yawTarget = -s.ang - Math.PI / 2;
    if (st.yaw == null || this._snap) st.yaw = yawTarget;
    else st.yaw = lerpAngle(st.yaw, yawTarget, Math.min(1, dt * 18));
    const root = c.inst.root;
    root.position.set(px, st.carY, pz);
    // yanal ivmeyle hafif yatış
    const yawRate = st.prevYaw != null && dt > 0 ? lerpAngle(0, yawTarget - st.prevYaw, 1) / Math.max(dt, 1e-3) : 0;
    st.prevYaw = yawTarget;
    st.roll = (st.roll || 0) + (Math.max(-0.05, Math.min(0.05, -yawRate * s.spd * 0.0006)) - (st.roll || 0)) * Math.min(1, dt * 6);
    root.rotation.set(st.pitch, st.yaw, st.roll * 0.4, 'YXZ');
    st.steerVis = (st.steerVis || 0) + (s.steerPos - (st.steerVis || 0)) * Math.min(1, dt * 20);
    st.spin = (st.spin || 0) - (s.spd * this.rate * (this.playing ? 1 : 0) * dt) / 0.36;
    c.inst.animate(st.steerVis, st.spin);
  }

  _loop(now) {
    if (this.closed) return;
    const dt = Math.max(0, Math.min(0.1, (now - this._last) / 1000));
    this._last = now;
    const waiting = !this._modelReady && now - this._waitStart < 6000;
    if (!this._modelReady && !waiting && !this._waitWarned) {
      this._waitWarned = true;
      this.$('.rp-loading').hidden = true;
    }
    if (this.playing && !waiting) {
      this.t += dt * TICK_RATE * this.rate;
      if (this.t >= this.maxCount - 1) {
        this.t = this.maxCount - 1;
        this.playing = false;
        this.$('[data-a=play]').textContent = '▶';
        this._showEnd();
      }
    }
    const fc = this._focusCar;
    const fi = this._focusIndex();
    this.$('.ck-seek').value = String(Math.floor(this.t));

    // araçlar
    for (const c of this.cars) this._updateCar(c, dt);
    const s = fc.s;
    const px = s.x * K, pz = s.y * K, py = fc.st.carY;

    // gölge kamerası odak aracı takip eder
    this.sun.position.set(px, py, pz).addScaledVector(this.sunDir, 60);
    this.sun.target.position.set(px, py, pz);

    // kamera
    const yawAng = -fc.st.yaw - Math.PI / 2; // görsel yön (yumuşatılmış)
    const fwd = new THREE.Vector3(Math.cos(yawAng), 0, Math.sin(yawAng));
    const speedN = Math.min(1.1, s.spd / V_REF);
    const cam = this.camera;
    const baseFov = this.camMode <= 2 ? 72 : 60;
    cam.fov += (baseFov + speedN * 10 - cam.fov) * Math.min(1, dt * 3);
    cam.updateProjectionMatrix();
    if (this.camMode <= 2) {
      const shake = speedN > 0.6 && this.playing ? (Math.random() - 0.5) * 0.004 * speedN : 0;
      cam.rotation.set(this.camPitch + shake, 0, -(fc.st.roll || 0) * 0.8);
    } else {
      let want, look;
      if (this.camMode === 3) {
        want = new THREE.Vector3(px, py + 2.2, pz).addScaledVector(fwd, -7.2);
        look = new THREE.Vector3(px, py + 0.8, pz).addScaledVector(fwd, 6);
      } else if (this.camMode === 5) {
        // yan kamera: aracın sağından, hafif önden (yayın kamerası gibi)
        const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
        want = new THREE.Vector3(px, py + 1.3, pz).addScaledVector(right, 6.5).addScaledVector(fwd, 2.2);
        look = new THREE.Vector3(px, py + 0.45, pz).addScaledVector(fwd, 0.4);
      } else {
        want = new THREE.Vector3(px, py + 60, pz).addScaledVector(fwd, -50);
        look = new THREE.Vector3(px, py, pz).addScaledVector(fwd, 14);
      }
      if (this._snap) {
        this.camPos.copy(want);
        this.camLook.copy(look);
      } else {
        const k = Math.min(1, dt * (this.camMode === 3 ? 6 : this.camMode === 5 ? 9 : 2.5));
        this.camPos.lerp(want, k);
        this.camLook.lerp(look, k);
      }
      cam.position.copy(this.camPos);
      cam.lookAt(this.camLook);
    }
    cam.updateMatrixWorld();
    const camW = cam.getWorldPosition(this._v);

    // LOD ve saydamlık (kameraya / odak araca çok yakın araçlar soluklaşır)
    for (const c of this.cars) {
      const isF = c === fc;
      const rp = c.inst.root.position;
      const dCam = camW.distanceTo(rp);
      c.inst.setLevel(isF || dCam < LOD_NEAR ? 0 : 1);
      let o = 1;
      if (!isF) {
        if (this.camMode <= 2) o = Math.min(o, ramp((dCam - 2.4) / 3.5));
        if (this.mode === 'top5') o = Math.min(o, 0.22 + 0.78 * ramp((rp.distanceTo(fc.inst.root.position) - 3) / 6));
        if (c.s.coasting) o *= 1 - ramp((c.s.over / TICK_RATE - 5) / 2.5);
      }
      c.inst.setOpacity(o);
    }
    this._updateGhosts(dt);
    const fpos = fc.inst.root.position;
    for (const g of this.ghosts) {
      if (!g.visible) continue;
      const gp = g.inst.root.position;
      // kameraya ya da odak araca çok yakın hayalet soluklaşır (üst üste binince titreşim olmasın)
      g.inst.setOpacity(Math.min(ramp((camW.distanceTo(gp) - 2) / 5), ramp((gp.distanceTo(fpos) - 1.2) / 3.5)));
    }

    // sensör ışınları
    if (this.showRays) {
      const pa = this.rays.geometry.attributes.position.array;
      const ca = this.rays.geometry.attributes.color.array;
      const maxRay = this.cfg.sensors.maxRay / K; // px
      const c = new THREE.Color();
      const F = fc.rep.frames;
      for (let r = 0; r < NRAY; r++) {
        const d = F[s.rayOff + r];
        const ra = s.ang + (RAY_ANGLES_DEG[r] * Math.PI) / 180;
        const exPx = s.x + Math.cos(ra) * d * maxRay, eyPx = s.y + Math.sin(ra) * d * maxRay;
        const eh = this._elevAt(exPx, eyPx).h;
        pa.set([px, py + 0.5, pz, exPx * K, eh + 0.5, eyPx * K], r * 6);
        c.setHSL((d * 120) / 360, 0.9, 0.55);
        ca.set([c.r, c.g, c.b, c.r, c.g, c.b], r * 6);
      }
      this.rays.geometry.attributes.position.needsUpdate = true;
      this.rays.geometry.attributes.color.needsUpdate = true;
    }

    // bulutlar süzülür
    for (const c of this.clouds) {
      c.position.x += dt * 4;
      if (c.position.x > this.center.x + 2600) c.position.x -= 5200;
    }
    this._snap = false;

    this.scenery?.update(dt, cam);
    this.renderer.info.reset();
    const blurN = this.playing && this.camMode <= 3 ? speedN * Math.min(1, this.rate) : 0;
    if (this.postfx) this.postfx.render(dt, blurN);
    else this.renderer.render(this.scene, cam);

    const gr = this._gearRpm(fc.T, Math.min(this.t, fc.T.n - 1));
    if (s.coasting) gr.rpm = Math.max(4200, gr.rpm * Math.exp(-s.over / TICK_RATE / 3));
    if (!this.teleRoot.hidden) this.panel.draw(fi);
    if (this.audio) {
      this.audio.update({
        rpm: gr.rpm,
        throttle: s.thr,
        speed: s.spd,
        slip: s.slip,
        active: this.playing && (this.t < fc.rep.count - 1 || (s.coasting && s.spd > 8)),
        rate: this.rate,
      });
    }
    this._hud(s, s.spd * 3.6, gr, fi);
    this._updateTags(cam);
    this._events();
    this._stats(now);
    this._raf = requestAnimationFrame((t) => this._loop(t));
  }

  _stats(now) {
    this._fpsN++;
    const el = now - this._fpsT0;
    if (el >= 1000) {
      const info = this.renderer.info.render;
      this.stats.fps = (this._fpsN * 1000) / el;
      this.stats.frameMs = el / this._fpsN;
      this.stats.calls = info.calls;
      this.stats.tris = info.triangles;
      this._fpsN = 0;
      this._fpsT0 = now;
    }
  }

  // Araç ve hayalet etiketleri (ekran izdüşümü)
  _updateTags(cam) {
    const W = this._vw || window.innerWidth, H = this._vh || window.innerHeight;
    const v = this._v2;
    const camW = cam.getWorldPosition(this._v);
    const place = (el, obj, text, show, y = 1.45) => {
      if (!el) return;
      if (!show) {
        if (el.style.display !== 'none') el.style.display = 'none';
        return;
      }
      v.copy(obj.position);
      v.y += y;
      const dist = camW.distanceTo(v);
      v.project(cam);
      if (v.z > 1 || v.z < -1 || Math.abs(v.x) > 1.2 || Math.abs(v.y) > 1.2 || dist > 900) {
        if (el.style.display !== 'none') el.style.display = 'none';
        return;
      }
      if (el.style.display === 'none') el.style.display = '';
      if (el._txt !== text) {
        el.innerHTML = text;
        el._txt = text;
      }
      el.style.transform = `translate(${((v.x * 0.5 + 0.5) * W).toFixed(1)}px, ${((-v.y * 0.5 + 0.5) * H).toFixed(1)}px) translate(-50%, -100%)`;
      el.style.opacity = dist > 400 ? '0.7' : '1';
    };
    const k = this.timeline ? Math.min(this.timeline.K - 1, Math.floor(this.t)) : 0;
    for (const c of this.cars) {
      if (!c.tagEl) continue;
      const isF = c === this._focusCar;
      const show = this.labelsOn && c.inst.root.visible && !(isF && this.camMode <= 2);
      let text;
      if (this.mode === 'heat') text = `<b>P${this.timeline.pos[k * this.timeline.N + c.idx]}</b> ${esc(c.name)}`;
      else text = `<b>${esc(c.tag.split(' · ')[0])}</b> ${esc(c.tag.split(' · ').slice(1).join(' · '))}`;
      c.tagEl.classList.toggle('focus', isF);
      place(c.tagEl, c.inst.root, text, show);
    }
    for (const g of this.ghosts) {
      let text = esc(g.name.replace(/^Gerçek F1 · /, 'Gerçek · '));
      const dl = g.delta && g.delta();
      if (dl && dl.n) {
        const d = this._focusT.dist[this._focusIndex()];
        const val = interp(dl.x, dl.y, d);
        if (isFinite(val)) text += ` <em class="${val > 0 ? 'slow' : 'fast'}">Δ ${sgn(val, 2)}</em>`;
      }
      place(g.tag, g.inst.root, text, this.labelsOn && g.visible && g.inst.root.visible, 1.35);
    }
  }

  _hud(s, kmh, gr, fi) {
    const fc = this._focusCar, T = fc.T;
    this.$('.ck-speed').textContent = Math.round(kmh);
    this.$('.ck-gear').textContent = s.spd < 0.3 ? 'N' : 'V ' + gr.gear;
    this.$('.ck-rpm').textContent = `${Math.round(gr.rpm / 100) * 100} d/dk`;
    // vites ışıkları
    const leds = this.leds;
    const lit = Math.max(0, Math.min(leds.length, Math.round(((gr.rpm - 9000) / 2900) * leds.length)));
    const flash = gr.rpm > 11850 && Math.floor(performance.now() / 80) % 2 === 0;
    for (let k = 0; k < leds.length; k++) leds[k].className = k < lit ? (flash ? 'on blue' : 'on') : '';
    this.$('.ck-thr').style.height = `${Math.max(0, s.thr) * 100}%`;
    this.$('.ck-brake').style.height = `${Math.max(0, -s.thr) * 100}%`;
    this.$('.ck-steer i').style.transform = `translateX(${(fc.st.steerVis || 0) * 50}px)`;
    this.$('.ck-in').textContent = s.coasting
      ? 'tur bitti · soğuma'
      : `direksiyon ${s.steer >= 0 ? '+' : ''}${s.steer.toFixed(2)} · gaz ${s.thr >= 0 ? '+' : ''}${s.thr.toFixed(2)}${s.slip > 0.05 ? ' · KAYMA' : ''}`;
    const tNow = T.time[fi] + (s.over > 0 ? s.over / TICK_RATE : 0);
    this.$('.ck-time').textContent = fmtLap(fc.rep.status === FINISHED && s.over > 0 ? fc.rep.lapTicks / TICK_RATE : tNow);
    if (this._hudTick++ % 4 !== 0 && !this._snapHud) return; // ayrıntılar ~15 Hz
    this._snapHud = false;
    const L = this.track.lengthMeters;
    const rep = fc.rep;
    const lapIdx = Math.max(0, Math.min(rep.laps - 1, Math.floor(Math.max(0, T.dist[fi]) / L)));
    const lapsDone = T.analysis.filter((l, k) => l.complete && k < lapIdx);
    const lastLap = lapsDone.length ? lapsDone[lapsDone.length - 1] : null;
    let bestSoFar = null;
    for (const l of lapsDone) if (!bestSoFar || l.time < bestSoFar.time) bestSoFar = l;
    const elev = this.track.hasElevation ? ` · ${(fc.st.carY + this.track.elevBase).toFixed(1)} m` : '';
    const pct = Math.max(0, Math.min(100, (s.prog / rep.goal) * 100));
    let sub = `Tur ${Math.min(rep.laps, lapIdx + 1)}/${rep.laps} · %${pct.toFixed(0)}${elev}`;
    if (rep.laps > 1 && lastLap) sub += ` · Son ${fmtLap(lastLap.time)}${bestSoFar && bestSoFar !== lastLap ? ` · En iyi ${fmtLap(bestSoFar.time)}` : ''}`;
    else if (rep.status === FINISHED && rep.laps === 1) sub += ` · Rekor ${fmtLap(rep.lapTicks / TICK_RATE)}`;
    this.$('.ck-sub').textContent = sub;
    this._hudSys(T, fi, s);
    this._hudSectors(T, fi, lapIdx);
    if (this.multi) this._hudRace();
    this._drawMap();
  }

  // Lastik / yakıt / ERS / DRS / pit
  _hudSys(T, fi, s) {
    const c = compOf(T.comp[fi]);
    const tt = T.tyreT[fi];
    const badge = this.$('.cmp-badge');
    badge.textContent = c.short;
    badge.style.setProperty('--c', c.color);
    badge.title = c.label;
    const dT = tt - c.topt;
    const tEl = this.$('.rp-tt');
    tEl.textContent = `${tt.toFixed(0)} °C`;
    tEl.className = 'rp-tt ' + (dT < -15 ? 'cold' : dT > 15 ? 'hot' : 'ok');
    this.$('.rp-tw').textContent = `aşınma %${(T.wear[fi] * 100).toFixed(1)}`;
    this.$('.rp-wear i').style.width = `${Math.min(100, T.wear[fi] * 100 * 4)}%`;
    this.$('.rp-fuel').textContent = `${T.fuel[fi].toFixed(2)} kg`;
    const kw = s.coasting ? 0 : T.ersKW[fi];
    const ek = this.$('.rp-ersk');
    ek.textContent = `%${(T.soc[fi] * 100).toFixed(0)} · ${kw > 0.5 ? '+' : ''}${kw.toFixed(0)} kW`;
    ek.className = 'rp-ersk ' + (kw > 1 ? 'dep' : kw < -1 ? 'har' : '');
    const eb = this.$('.rp-ers i');
    eb.style.width = `${(T.soc[fi] * 100).toFixed(1)}%`;
    eb.className = kw > 1 ? 'dep' : kw < -1 ? 'har' : '';
    // DRS: açık / bölgede (kapalı) / kapalı
    const tr = this.track;
    const sAt = tr.sAt(s.x, s.y);
    const zone = tr.drsZoneAt ? tr.drsZoneAt[Math.max(0, Math.floor(sAt / tr.ds) % tr.n)] : -1;
    const drs = this.$('.rp-drs');
    const open = !s.coasting && T.drs[fi];
    drs.className = 'rp-drs ' + (open ? 'open' : zone >= 0 ? 'zone' : '');
    drs.textContent = open ? 'DRS AÇIK' : zone >= 0 ? 'DRS bölgesi' : 'DRS';
    // pit bildirimi
    const pit = T.pits.find((p) => fi >= p.i && fi < p.i + 4.5 * TICK_RATE);
    const pe = this.$('.rp-pit');
    if (pit) {
      pe.hidden = false;
      pe.innerHTML = `<b>PİT DURAĞI</b> +${pit.loss.toFixed(1)} sn · <span class="cmp-badge" style="--c:${compOf(pit.compFrom).color}">${compOf(pit.compFrom).short}</span> → <span class="cmp-badge" style="--c:${compOf(pit.compTo).color}">${compOf(pit.compTo).short}</span> ${compOf(pit.compTo).label}`;
    } else pe.hidden = true;
  }

  // Canlı sektör süreleri: kendi en iyisine ve (varsa) referansa göre fark, mor/yeşil/sarı
  _hudSectors(T, fi, lapIdx) {
    const el = this.$('.rp-sectors');
    const lap = T.analysis[lapIdx];
    const tr = this.track, L = tr.lengthMeters, sf = tr.sectorFrac;
    const d = T.dist[fi];
    const tnp = T.tnp[fi] + (this.t > T.n - 1 ? (this.t - (T.n - 1)) / TICK_RATE : 0);
    // karşılaştırma sektörleri: seçili periyodik iz > gerçek referans
    let refRow = null, refName = '';
    if (this.cmp && this.cmp.lapRows && this.cmp.lapRows.length) {
      refRow = this.cmp.lapRows[0];
      refName = this.cmp.trace.short || 'Karş.';
    } else if (this.refTrace) {
      if (!this._refRows) this._refRows = traceLapRows(this.refTrace, tr);
      refRow = this._refRows[0];
      refName = this.refTrace.short;
    }
    // en iyiler: odak aracın şu ana kadarki tamamlanmış sektörleri; tüm araçlar + referans (mor için)
    const own = [Infinity, Infinity, Infinity], all = [Infinity, Infinity, Infinity];
    for (const c of this.cars) {
      for (const l of c.T.analysis) {
        l.sectors.forEach((v, j) => {
          if (v == null) return;
          if (v < all[j]) all[j] = v;
        });
      }
    }
    if (refRow) refRow.sectors.forEach((v, j) => v != null && v < all[j] && (all[j] = v));
    let h = '';
    for (let j = 0; j < 3; j++) {
      const b0 = lapIdx * L + (j === 0 ? 0 : sf[j - 1] * L), b1 = lapIdx * L + sf[j] * L;
      // bu sektörden önceki turlardaki kendi en iyisi
      for (let k = 0; k < lapIdx; k++) {
        const v = T.analysis[k]?.sectors[j];
        if (v != null && v < own[j]) own[j] = v;
      }
      let txt = '–', cls = 'na', dl = '';
      if (lap && d >= b1 - 0.5 && lap.sectors[j] != null) {
        const v = lap.sectors[j];
        txt = v.toFixed(3);
        cls = v <= all[j] + 1e-6 ? 'p' : v <= own[j] + 1e-6 ? 'g' : 'y';
        if (refRow && refRow.sectors[j] != null) dl = `${refName} ${sgn(v - refRow.sectors[j], 2)}`;
        else if (isFinite(own[j])) dl = `KE ${sgn(v - own[j], 2)}`;
      } else if (lap && d >= b0 - 0.5) {
        const start = lap.t0 + lap.sectors.slice(0, j).reduce((a, v) => a + (v || 0), 0);
        txt = Math.max(0, tnp - start).toFixed(1);
        cls = 'run';
      }
      h += `<div class="sec ${cls}"><span>S${j + 1}</span><b>${txt}</b><small>${dl}</small></div>`;
    }
    if (el._h !== h) {
      el.innerHTML = h;
      el._h = h;
    }
  }

  // Sıralama kulesi ve odak aracın konumu / farkı / sayaçlar
  _hudRace() {
    const tl = this.timeline;
    const k = Math.min(tl.K - 1, Math.floor(this.t));
    const N = tl.N;
    const order = [];
    for (let i = 0; i < N; i++) order[tl.pos[k * N + i] - 1] = i;
    const fc = this._focusCar;
    const gapTo = (a, b) => {
      // a aracının b'ye göre zaman farkı (pozitif: a geride)
      const A = this.cars[a], B = this.cars[b];
      const ia = Math.min(A.T.n - 1, k), d = A.T.dist[ia];
      if (A.rep.status === FINISHED && k >= A.T.n - 1 && B.rep.status === FINISHED && k >= B.T.n - 1) return A.sec - B.sec;
      const tB = interp(B.mono.d, B.mono.t, d);
      return isFinite(tB) ? A.T.time[ia] - tB : NaN;
    };
    const lead = order[0];
    let h = '';
    order.forEach((ci, p) => {
      const c = this.cars[ci];
      const done = k >= c.T.n - 1;
      let right;
      if (done && c.rep.status !== FINISHED) right = STATUS_SHORT[c.rep.status] || 'DNF';
      else if (p === 0) right = done && c.rep.status === FINISHED ? fmtShort(c.sec) : 'Lider';
      else {
        const g = gapTo(ci, lead);
        right = isFinite(g) ? `+${g.toFixed(g < 10 ? 2 : 1)}` : '–';
      }
      h += `<div class="tw-row${ci === this.focus ? ' focus' : ''}${done && c.rep.status !== FINISHED ? ' out' : ''}" data-car="${ci}"><b>${p + 1}</b><i style="background:${c.color}"></i><span>${esc(c.name)}</span><em>${right}</em></div>`;
    });
    const tw = this.$('.rp-tower');
    const head = `<div class="tw-head">${this.mode === 'heat' ? 'Seri sıralaması' : 'Sanal sıralama'} <small>${fmtShort(fc.T.time[Math.min(fc.T.n - 1, k)])}</small></div>`;
    if (tw._h !== head + h) {
      tw.innerHTML = head + h;
      tw._h = head + h;
    }
    // odak: konum, öndeki araçla fark, sayaçlar
    const pos = tl.pos[k * N + this.focus];
    this.$('.rp-p').textContent = `P${pos}`;
    let gap = '';
    if (pos > 1) {
      const ahead = order[pos - 2];
      const g = gapTo(this.focus, ahead);
      gap = isFinite(g) ? `öndeki ${this.cars[ahead].name}: +${g.toFixed(2)} sn` : '';
    } else if (N > 1) {
      const g = gapTo(order[1], this.focus);
      gap = isFinite(g) ? `arkadaki ${this.cars[order[1]].name}: −${g.toFixed(2)} sn` : 'Lider';
    }
    this.$('.rp-gap').textContent = gap;
    if (this.mode === 'heat') {
      let ov = 0, lost = 0, ct = 0;
      for (const e of tl.events) {
        if (e.k > k) break;
        if (e.type === 'overtake') {
          if (e.win === this.focus) ov++;
          else if (e.lose === this.focus) lost++;
        } else if (e.a === this.focus || e.b === this.focus) ct++;
      }
      this.$('.rp-cnt').textContent = `Sollama ${ov} · geçilen ${lost} · temas ${ct}`;
    } else this.$('.rp-cnt').textContent = '';
  }

  _resetEvents() {
    if (!this.timeline) return;
    const k = Math.floor(this.t);
    const ev = this.timeline.events;
    let i = 0;
    while (i < ev.length && ev[i].k <= k) i++;
    this._evIdx = i;
  }

  // Seri olayları (sollama / temas) akışa düşer
  _events() {
    // akış öğelerinin süresi
    const now = performance.now();
    if (this._feedItems.length && this._feedItems[0].until < now) {
      while (this._feedItems.length && this._feedItems[0].until < now) this._feedItems.shift().el.remove();
    }
    if (!this.timeline || this.mode !== 'heat') return;
    const k = Math.floor(this.t);
    const ev = this.timeline.events;
    while (this._evIdx < ev.length && ev[this._evIdx].k <= k) {
      const e = ev[this._evIdx++];
      if (!this.playing || k - e.k > 30) continue;
      const nm = (i) => `<i style="background:${this.cars[i].color}"></i>${esc(this.cars[i].name)}`;
      const inv = e.type === 'overtake' ? e.win === this.focus || e.lose === this.focus : e.a === this.focus || e.b === this.focus;
      if (e.type === 'overtake') this._feed(`SOLLAMA ${nm(e.win)} → ${nm(e.lose)}`, inv ? 'ov me' : 'ov', true);
      else this._feed(`TEMAS ${nm(e.a)} ↔ ${nm(e.b)}`, inv ? 'ct me' : 'ct', true);
    }
  }

  _feed(msg, cls = '', html = false) {
    const box = this.$('.rp-feed');
    if (!box) return;
    const el = document.createElement('div');
    el.className = 'rp-fi ' + cls;
    if (html) el.innerHTML = msg;
    else el.textContent = msg;
    box.appendChild(el);
    this._feedItems.push({ el, until: performance.now() + (cls.includes('bad') ? 6000 : 3500) });
    while (this._feedItems.length > 4) this._feedItems.shift().el.remove();
  }

  _showEnd() {
    const end = this.$('.ck-end');
    end.hidden = false;
    const fc = this._focusCar, rep = fc.rep;
    if (!this.multi) {
      end.innerHTML =
        rep.status === FINISHED
          ? `<b>Bitiş!</b><span>${fmtLap(rep.lapTicks / TICK_RATE)} · ${rep.laps} tur</span><small>Tekrar izlemek için ↺ ya da R</small>`
          : `<b>${rep.status === CRASHED ? 'Çarptı' : 'Elendi'}</b><span>%${((rep.frames[(rep.count - 1) * FRAME_STRIDE + FR.progress] / rep.goal) * 100).toFixed(0)} ilerleme</span><small>Daha fazla eğitimle bu sürüş gelişecek</small>`;
      return;
    }
    const tl = this.timeline, k = tl.K - 1, N = tl.N;
    const order = [];
    for (let i = 0; i < N; i++) order[tl.pos[k * N + i] - 1] = i;
    const winner = this.cars[order[0]];
    const rows = order.map((ci, p) => {
      const c = this.cars[ci], r = c.rep;
      const res = r.status === FINISHED ? fmtLap(c.sec) + (p > 0 && winner.sec ? ` <small>+${(c.sec - winner.sec).toFixed(3)}</small>` : '') : STATUS_SHORT[r.status];
      const extra = this.mode === 'heat' ? `<small>net sollama ${r.overtakes > 0 ? '+' : ''}${r.overtakes} · temas ${r.contacts}</small>` : '';
      return `<li class="${ci === this.focus ? 'focus' : ''}"><b>${p + 1}</b><i style="background:${c.color}"></i><span>${esc(c.name)}</span><em>${res}</em>${extra}</li>`;
    }).join('');
    end.innerHTML = `<b>${this.mode === 'heat' ? 'Seri bitti' : 'Tekrar bitti'}</b><ol class="rp-final">${rows}</ol><small>Tekrar izlemek için ↺ ya da R · araca tıklayarak odakla</small>`;
    end.querySelectorAll('li').forEach((li, p) => (li.onclick = () => this._setFocus(order[p])));
  }

  _export() {
    const btn = this.$('[data-a=export]');
    btn.disabled = true;
    btn.textContent = 'Hazırlanıyor…';
    setTimeout(() => {
      try {
        // anlık 3B kare + tam sürüş çizgili harita
        if (this.postfx) this.postfx.render(0, 0);
        else this.renderer.render(this.scene, this.camera);
        const frame = this.canvas.toDataURL('image/png');
        this._drawMap();
        const ex = this.extra;
        const fc = this._focusCar;
        const blob = buildExport({
          T: fc.T,
          panel: this.panel,
          title: this.title,
          meta: { ...(ex.meta || {}), tekrarModu: this.mode, odakArac: fc.name },
          history: ex.history || [],
          tunerLog: ex.tunerLog || [],
          brain: ex.brain || null,
          mapCanvas: this.mapCanvas,
          frameDataURL: frame,
          track: this.track,
          mode: this.mode,
          focusName: fc.name,
          cars: this.multi ? this.cars.map((c) => ({ name: c.name, livery: c.livery.name, rep: c.rep, T: c.T })) : null,
          sectorRows: this.panel.sectorRows(),
          cmp: this.cmp ? { trace: this.cmp.trace, delta: this.cmp.delta } : null,
          events: this.timeline && this.mode === 'heat' ? this.timeline.events.map((e) => ({ ...e, names: e.type === 'overtake' ? [this.cars[e.win].name, this.cars[e.lose].name] : [this.cars[e.a].name, this.cars[e.b].name] })) : null,
        });
        const trm = { ğ: 'g', ü: 'u', ş: 's', ö: 'o', ç: 'c', ı: 'i', İ: 'i', Ğ: 'g', Ü: 'u', Ş: 's', Ö: 'o', Ç: 'c' };
        const safe = (ex.meta?.pist || this.track.name || 'pist').toString().replace(/[ğüşöçıİĞÜŞÖÇ]/g, (c) => trm[c]).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        downloadBlob(blob, `replay-${safe}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.zip`);
        this._lastExport = blob;
      } catch (e) {
        console.error(e);
        alert('İndirme hazırlanamadı: ' + e.message);
      } finally {
        btn.disabled = false;
        btn.textContent = '⬇ Verileri indir';
      }
    }, 30);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    cancelAnimationFrame(this._raf);
    if (this.audio) this.audio.close();
    window.removeEventListener('keydown', this._onKey, true);
    window.removeEventListener('resize', this._onResize);
    this._barRO?.disconnect();
    try {
      this.postfx?.dispose();
      this.scenery?.dispose();
      for (const g of this.ghosts) g.inst.dispose();
      for (const c of this.cars) c.inst?.dispose();
      this.factory?.dispose();
    } catch (e) {
      console.warn(e);
    }
    this.scene.traverse((o) => {
      if (o.geometry && !o.geometry.userData?.keep) o.geometry.dispose();
      if (o.material) {
        const ms = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of ms) {
          if (m.userData?.keep) continue;
          if (m.map && !m.map.userData?.keep) m.map.dispose();
          m.dispose();
        }
      }
    });
    this.envRT?.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss?.();
    this.root.remove();
    if (window.__cockpit === this) window.__cockpit = null;
    if (this.onClose) this.onClose();
  }
}

// styles-replay.css index.html'e bağlanmamışsa kendimiz ekleriz
function ensureReplayCss() {
  if (document.querySelector('link[href*="styles-replay.css"]')) return;
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = new URL('../styles-replay.css', import.meta.url).href;
  document.head.appendChild(l);
}
