// Eğitimi kaldığı yerden sürdürmek için oturum kaydı (IndexedDB, veritabanı: 'rl-yaris-lab').
//
//   snapshotTrainer({ trainer, cfg, trackDef, algoName, carCount, seed, extra })  → yapılandırılmış-klonlanabilir nesne
//   restoreTrainer(trainer, snap)                                                 → algoritma durumu yüklendiyse true
//   saveSession(snap) / loadSession() / loadSessionInfo() / clearSession()
//   applyConfig(cfg, snap.cfg)       → canlı cfg nesnesini yerinde günceller (eksik yeni alanlar varsayılandan)
//   showResumeBanner(info)           → "Kaldığın yerden devam et" kartı; 'resume' | 'new' | 'delete' ile çözülür
//
// Kayıtta: ayarlar, pist tanımı (özel/rastgele pistler de geri gelsin diye), eğitim geçmişi, rekor beyinleri,
// algoritmanın tam durumu (algo.getState(): popülasyon / ağırlıklar / Adam momentleri / normalizasyon) ve RNG.
// Yarım kalan nesil (veya PPO rollout'u) kaydedilmez: devam edince o nesil baştan sürülür.
// Typed array'ler kopyalanarak saklanır (IndexedDB yapılandırılmış klonu destekler) → 1000 araçta bile birkaç ms.
//
// DOM yalnızca showResumeBanner içinde kullanılır; geri kalanı Node'da (testlerde) de çalışır.

import { defaultConfig, fmtLap, TICK_RATE } from './config.js';
import { ALGOS } from './algos/index.js';

export const DB_NAME = 'rl-yaris-lab';
export const DB_VERSION = 1;
export const SNAPSHOT_FORMAT = 'rl-yaris-oturum';
export const SNAPSHOT_VERSION = 1;
const SESSION_STORE = 'session';
const RUNS_STORE = 'runs';
const KEY_SESSION = 'current';
const KEY_INFO = 'current-info';

// ---------------------------------------------------------------- IndexedDB yardımcıları
let dbPromise = null;

export function hasIndexedDB() {
  return typeof indexedDB !== 'undefined' && indexedDB !== null;
}

// Ortak veritabanı (experiments.js de bunu kullanır): 'session' ve 'runs' depoları
export function openDB() {
  if (dbPromise) return dbPromise;
  if (!hasIndexedDB()) return Promise.reject(new Error('Bu tarayıcıda IndexedDB yok (veya gizli pencerede kapalı).'));
  dbPromise = new Promise((resolve, reject) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (e) {
      dbPromise = null;
      reject(e);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SESSION_STORE)) db.createObjectStore(SESSION_STORE);
      if (!db.objectStoreNames.contains(RUNS_STORE)) {
        const s = db.createObjectStore(RUNS_STORE, { keyPath: 'id', autoIncrement: true });
        s.createIndex('createdAt', 'createdAt');
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // başka bir sekme veritabanını yükseltirse bağlantıyı bırak
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      dbPromise = null;
      reject(req.error || new Error('Veritabanı açılamadı'));
    };
    req.onblocked = () => console.warn('IndexedDB yükseltmesi başka bir sekme tarafından engelleniyor.');
  });
  return dbPromise;
}

// Tek işlem (transaction): fn(store) bir istek döndürürse sonucu, işlem tamamlanınca çözülür
export async function withStore(storeName, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction(storeName, mode);
    } catch (e) {
      reject(e);
      return;
    }
    const store = tx.objectStore(storeName);
    let result;
    try {
      const r = fn(store);
      if (r && typeof r === 'object' && 'onsuccess' in r) r.onsuccess = () => (result = r.result);
    } catch (e) {
      try { tx.abort(); } catch { /* zaten bitti */ }
      reject(e);
      return;
    }
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error || new Error('IndexedDB işlemi başarısız'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB işlemi iptal edildi'));
  });
}

// Klonlanamayan değerleri (fonksiyon, sembol) at; typed array'ler aynen kalır
export function sanitizeForClone(v, seen = new WeakMap()) {
  if (v === null || v === undefined) return v;
  const t = typeof v;
  if (t === 'function' || t === 'symbol') return undefined;
  if (t !== 'object') return v;
  // SharedArrayBuffer (çok çekirdekli mod) IndexedDB'ye yazılamaz → normal kopyaya çevir
  if (ArrayBuffer.isView(v)) return typeof SharedArrayBuffer !== 'undefined' && v.buffer instanceof SharedArrayBuffer ? v.slice() : v;
  if (v instanceof ArrayBuffer || v instanceof Date || v instanceof RegExp) return v;
  if (seen.has(v)) return seen.get(v);
  if (Array.isArray(v)) {
    const out = [];
    seen.set(v, out);
    for (const x of v) out.push(sanitizeForClone(x, seen));
    return out;
  }
  if (typeof Node !== 'undefined' && v instanceof Node) return undefined;
  const out = {};
  seen.set(v, out);
  for (const [k, x] of Object.entries(v)) {
    const s = sanitizeForClone(x, seen);
    if (s !== undefined) out[k] = s;
  }
  return out;
}

function safeClone(v) {
  if (v == null) return v ?? null;
  try {
    return structuredClone(v);
  } catch {
    return structuredClone(sanitizeForClone(v));
  }
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !ArrayBuffer.isView(v);

// ---------------------------------------------------------------- anlık görüntü
export function snapshotTrainer({ trainer, cfg, trackDef, algoName, carCount, seed, extra = null } = {}) {
  if (!trainer) throw new Error('snapshotTrainer: trainer gerekli');
  const t = trainer;
  const c = cfg || t.cfg;
  const name = algoName || t.algoName;
  const def = trackDef || (t.track && typeof t.track.toJSON === 'function' ? t.track.toJSON() : null);

  let algoState = null;
  let algoStateError = null;
  if (t.algo && typeof t.algo.getState === 'function') {
    try {
      algoState = t.algo.getState(); // algoritmalar kopya döndürür
    } catch (e) {
      algoStateError = String((e && e.message) || e);
    }
  }
  const pop = t.algo && t.algo.kind === 'population';
  const idealLap = typeof t.idealLap === 'number' ? t.idealLap : null;
  const savedAt = Date.now();
  return {
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    savedAt,
    cfg: safeClone(c),
    trackDef: def ? safeClone(def) : null,
    trackId: def ? def.id : t.track?.id ?? null,
    trackName: t.track?.name ?? def?.name ?? '',
    algoName: name,
    algoLabel: t.algo?.label ?? name,
    carCount: carCount ?? t.carCount,
    seed: seed ?? t.seed ?? null,
    trainer: {
      generation: t.generation,
      totalTicks: t.totalTicks,
      // geçmiş girdileri eklendikten sonra değişmez → sığ kopya yeterli
      history: t.history.slice(),
      bestEverFitness: t.bestEverFitness,
      bestEverLapTicks: t.bestEverLapTicks,
      bestBrain: t.bestBrain,
      bestLapBrain: t.bestLapBrain,
      topLaps: t.topLaps.slice(),
      records: t.records.slice(),
      bestSectors: Array.from(t.bestSectors),
      bestHeat: t.bestHeat,
      episodes: t.episodes,
      epWindow: t.epWindow.slice(),
      ghost: Array.isArray(t.ghost) ? t.ghost.slice() : t.ghost ?? null,
    },
    algoState,
    algoStateError,
    rng: t.rng ? { s: t.rng.s >>> 0, spare: t.rng._spare ?? null } : null,
    spawnInfo: t.sim?.spawnInfo ? { s: t.sim.spawnInfo.s, flying: !!t.sim.spawnInfo.flying } : null,
    extra: extra == null ? null : safeClone(extra),
    // başlangıç kartı için küçük özet (tam kaydı yüklemeden gösterilir)
    info: {
      savedAt,
      trackName: t.track?.name ?? def?.name ?? '',
      algoName: name,
      algoLabel: t.algo?.label ?? name,
      kind: pop ? 'population' : 'continuous',
      step: pop ? t.generation : t.algo?.updates ?? 0,
      carCount: t.sim?.N ?? carCount ?? t.carCount,
      bestLapSec: t.bestEverLapTicks ? t.bestEverLapTicks / TICK_RATE : null,
      idealLapSec: idealLap,
      totalTicks: t.totalTicks,
    },
  };
}

export function restoreTrainer(trainer, snap, { restoreRng = true } = {}) {
  if (!trainer) throw new Error('restoreTrainer: trainer gerekli');
  if (!snap || snap.format !== SNAPSHOT_FORMAT) throw new Error('Geçersiz oturum kaydı');
  const T = snap.trainer || {};
  const t = trainer;
  const arr = (a) => (Array.isArray(a) ? a.slice() : []);
  t.history = arr(T.history);
  t.lastGen = t.history.length ? t.history[t.history.length - 1] : null;
  t.totalTicks = T.totalTicks || 0;
  t.bestEverFitness = typeof T.bestEverFitness === 'number' ? T.bestEverFitness : -Infinity;
  t.bestEverLapTicks = T.bestEverLapTicks || 0;
  t.bestBrain = T.bestBrain || null;
  t.bestLapBrain = T.bestLapBrain || null;
  t.topLaps = arr(T.topLaps);
  t.records = arr(T.records);
  t.bestSectors = Array.isArray(T.bestSectors) && T.bestSectors.length === 3 ? Array.from(T.bestSectors) : [0, 0, 0];
  t.bestHeat = T.bestHeat || null;
  t.episodes = T.episodes || 0;
  t.epWindow = arr(T.epWindow);
  t.ghost = T.ghost || null;

  let restored = false;
  if (snap.algoState && snap.algoName === t.algoName && t.algo && typeof t.algo.setState === 'function') {
    try {
      restored = t.algo.setState(snap.algoState) === true;
    } catch (e) {
      console.warn('Algoritma durumu yüklenemedi:', e);
      restored = false;
    }
  }
  if (t.algo && t.algo.kind === 'population') {
    t.generation = T.generation || 1;
    // kaydedilen neslin başlangıç noktasını kullan (rastgele başlangıçta aynı nokta)
    if (restored && snap.spawnInfo && t.sim && typeof t.sim.resetAll === 'function') t.sim.resetAll({ ...snap.spawnInfo });
  } else {
    t.generation = restored ? (t.algo.updates | 0) + 1 : 1;
  }
  // aynı RNG durumu → GA/ES/CMA-ES'te eğitim kaydedildiği andaki gibi birebir sürer
  if (restored && restoreRng && snap.rng && t.rng) {
    t.rng.s = snap.rng.s >>> 0;
    t.rng._spare = snap.rng.spare ?? null;
  }
  return restored;
}

// Canlı cfg nesnesini (main.js'te const) yerinde günceller. Kayıtta olmayan yeni alanlar varsayılandan gelir.
export function applyConfig(target, source) {
  if (!source) return target;
  const d = defaultConfig();
  for (const k of Object.keys(source)) {
    const v = source[k];
    if (isPlainObject(v)) {
      const base = d[k] || (ALGOS[k] && ALGOS[k].defaults) || {};
      target[k] = { ...structuredClone(base), ...safeClone(v) };
    } else {
      target[k] = safeClone(v);
    }
  }
  return target;
}

// ---------------------------------------------------------------- oturum deposu
export async function saveSession(snapshot) {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const info = snapshot && snapshot.info ? snapshot.info : null;
  const write = (snap) =>
    withStore(SESSION_STORE, 'readwrite', (s) => {
      s.put(snap, KEY_SESSION);
      return s.put(info ? { ...info } : null, KEY_INFO);
    });
  try {
    await write(snapshot);
  } catch (e) {
    if (e && e.name === 'DataCloneError') await write(sanitizeForClone(snapshot));
    else throw e;
  }
  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return { ms: t1 - t0, savedAt: snapshot.savedAt };
}

export async function loadSession() {
  if (!hasIndexedDB()) return null;
  const snap = await withStore(SESSION_STORE, 'readonly', (s) => s.get(KEY_SESSION));
  return snap && snap.format === SNAPSHOT_FORMAT ? snap : null;
}

export async function loadSessionInfo() {
  if (!hasIndexedDB()) return null;
  return (await withStore(SESSION_STORE, 'readonly', (s) => s.get(KEY_INFO))) || null;
}

export async function clearSession() {
  if (!hasIndexedDB()) return;
  await withStore(SESSION_STORE, 'readwrite', (s) => {
    s.delete(KEY_SESSION);
    return s.delete(KEY_INFO);
  });
}

// ---------------------------------------------------------------- "Kaldığın yerden devam et" kartı
export function timeAgo(ts, now = Date.now()) {
  const s = Math.max(0, (now - ts) / 1000);
  if (s < 60) return 'az önce';
  if (s < 3600) return `${Math.round(s / 60)} dk önce`;
  if (s < 86400) return `${Math.round(s / 3600)} sa önce`;
  const d = Math.round(s / 86400);
  return d === 1 ? 'dün' : `${d} gün önce`;
}

export function describeSessionInfo(info) {
  if (!info) return '';
  const parts = [];
  if (info.algoLabel) parts.push(info.algoLabel);
  if (info.trackName) parts.push(info.trackName);
  if (info.step != null) parts.push(`${info.kind === 'continuous' ? 'Güncelleme' : 'Nesil'} ${info.step}`);
  if (info.carCount) parts.push(`${info.carCount} araç`);
  if (info.bestLapSec) parts.push(`en iyi tur ${fmtLap(info.bestLapSec)}`);
  if (info.savedAt) parts.push(timeAgo(info.savedAt));
  return parts.join(' · ');
}

// Sonuç: 'resume' (devam et) | 'new' (yeni başla; kayıt bir sonraki otomatik kayıtta değişir) | 'delete' (kaydı sil)
export function showResumeBanner(info, { parent = document.body } = {}) {
  return new Promise((resolve) => {
    const el = document.createElement('div');
    el.className = 'rs-banner';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Kaldığın yerden devam et');
    el.innerHTML = `
      <div class="rs-icon" aria-hidden="true">↻</div>
      <div class="rs-text">
        <b>Kaldığın yerden devam et?</b>
        <span></span>
      </div>
      <div class="rs-actions">
        <button class="primary" data-a="resume">Devam et</button>
        <button data-a="new" title="Eski kayıt, yeni eğitimin ilk otomatik kaydında değiştirilir">Yeni başla</button>
        <button class="rs-del" data-a="delete" title="Kaydı kalıcı olarak sil">Kaydı sil</button>
      </div>`;
    el.querySelector('.rs-text span').textContent = describeSessionInfo(info);
    const done = (a) => {
      el.classList.add('rs-out');
      setTimeout(() => el.remove(), 180);
      resolve(a);
    };
    el.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-a]');
      if (b) done(b.dataset.a);
    });
    el.addEventListener('keydown', (e) => e.stopPropagation()); // kısayollar (Boşluk vb.) kartta çalışmasın
    parent.appendChild(el);
    setTimeout(() => el.querySelector('button.primary')?.focus(), 30);
  });
}
