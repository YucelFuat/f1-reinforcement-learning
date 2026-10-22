// Testler için ortak yardımcılar (test dosyası değildir: adı *.test.js ile bitmez).
import { defaultConfig, autoTimeLimit, OBS, OBS_SIZE } from '../src/config.js';
import { Track, TRACK_DEFS } from '../src/track.js';
import { Simulation } from '../src/sim.js';
import { RNG } from '../src/rng.js';

// RL_FAST=1 (npm run test:fast) → yavaş testler atlanır
export const SLOW = process.env.RL_FAST ? { skip: 'yavaş test (RL_FAST=1 ile atlandı)', timeout: 60000 } : { timeout: 60000 };

const trackCache = new Map();
export function builtinTrack(id) {
  if (!trackCache.has(id)) {
    const def = TRACK_DEFS.find((d) => d.id === id);
    if (!def) throw new Error('Pist yok: ' + id);
    trackCache.set(id, new Track(def));
  }
  return trackCache.get(id);
}

// Fizik testleri için uzun düzlüklü stadyum pist: iki ~5.9 km düzlük, 270 m yarıçaplı virajlar.
// Başlangıç noktası alt düzlüğün içinde (x = 500 px) → araç dümdüz hızlanır.
export function straightTrackDef() {
  const L = 4000, R = 180, pts = [];
  for (let x = 500; x <= L; x += 500) pts.push([x, 0]);
  for (let k = 1; k < 8; k++) {
    const a = -Math.PI / 2 + (k * Math.PI) / 8;
    pts.push([L + R * Math.cos(a), R + R * Math.sin(a)]);
  }
  for (let x = L; x >= 0; x -= 500) pts.push([x, 2 * R]);
  for (let k = 1; k < 8; k++) {
    const a = Math.PI / 2 + (k * Math.PI) / 8;
    pts.push([R * Math.cos(a), R + R * Math.sin(a)]);
  }
  pts.push([0, 0]);
  return { id: 'test-duzluk', name: 'Test düzlüğü', halfWidth: 15, points: pts, mpp: 1.5 };
}
let straight = null;
export function straightTrack() {
  return (straight ||= new Track(straightTrackDef()));
}

export function makeCfg(track, mut) {
  const cfg = defaultConfig();
  cfg.rules.timeLimitSec = track ? autoTimeLimit(track) : 60;
  if (mut) mut(cfg);
  return cfg;
}

export function makeSim(track, n, cfg, seed = 1) {
  return new Simulation(track, n, cfg, new RNG(seed));
}

// Aracı pistin s (metre) noktasına, pist yönünde v (m/s) hızla koy
export function placeCar(sim, i, sMeters, v, extra = {}) {
  const t = sim.track;
  const idx = t.idxAt(sMeters / t.mpp);
  sim.resetCar(i, { x: t.cx[idx], y: t.cy[idx], a: t.tan[idx], v, flying: true, ...extra });
  sim.computeObs();
}

// Kural tabanlı basit sürücü: yön hatası + ileri bakış + yanal konumla direksiyon, hız profiline göre gaz/fren.
// (Ağ çıkışları sim içinde 2 ile çarpılıp kırpıldığı için komutlar /2 yazılır.)
export function ruleDriver(sim, i, k = 0.8) {
  const o = i * OBS_SIZE, t = sim.track;
  const head = sim.obs[o + OBS.heading] * Math.PI;
  const look = sim.obs[o + OBS.look] * Math.PI;
  const lat = sim.obs[o + OBS.lateral];
  const steer = 2.5 * head + 1.2 * look - 0.8 * lat;
  const prof = t.speedProfile(sim.cfg.physics);
  const target = prof[t.idxAt(sim.lastS[i] + 40 / t.mpp)] * k;
  const v = sim.spd[i];
  const thr = v < target ? 1 : v > target * 1.05 ? -1 : 0.2;
  sim.actions[2 * i] = Math.max(-1, Math.min(1, steer)) / 2;
  sim.actions[2 * i + 1] = thr / 2;
}

// Simülasyonun tüm durumunu kopyala / geri yükle (aynı başlangıç noktasından iki eğitimi birlikte sürmek için)
export function snapshotSim(sim) {
  const s = {};
  for (const [k, v] of Object.entries(sim)) {
    if (k === 'track' || k === 'cfg' || k === 'rng' || k === '_alloc' || typeof v === 'function') continue;
    if (ArrayBuffer.isView(v)) s[k] = v.slice();
    else if (Array.isArray(v)) s[k] = v.slice();
    else if (v && typeof v === 'object') s[k] = structuredClone(v);
    else s[k] = v;
  }
  return s;
}
export function restoreSim(sim, s) {
  for (const [k, v] of Object.entries(s)) {
    if (ArrayBuffer.isView(v)) sim[k].set(v);
    else if (Array.isArray(v)) sim[k] = v.slice();
    else if (v && typeof v === 'object') sim[k] = structuredClone(v);
    else sim[k] = v;
  }
}

export function sameArray(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && !(Number.isNaN(a[i]) && Number.isNaN(b[i]))) return false;
  return true;
}

// İki durum nesnesini (iç içe typed array'ler dahil) karşılaştırır. Aynıysa null, değilse ilk farklı yolu döndürür.
export function stateDiff(a, b, path = '') {
  if (ArrayBuffer.isView(a) || Array.isArray(a)) {
    if (!b || typeof b.length !== 'number') return path || '(kök)';
    return sameArray(a, b) ? null : path || '(kök)';
  }
  if (a && typeof a === 'object') {
    if (!b || typeof b !== 'object') return path || '(kök)';
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const r = stateDiff(a[k], b[k], path + '.' + k);
      if (r) return r;
    }
    return null;
  }
  return a === b || (Number.isNaN(a) && Number.isNaN(b)) ? null : path || '(kök)';
}

// Geçmiş girdisinden karşılaştırılabilir özet (algoritmaya özgü 'extra' hariç)
export const histKey = (h) => ({ gen: h.gen, best: h.best, avg: h.avg, finishers: h.finishers, bestLap: h.bestLap, avgProgress: h.avgProgress });
