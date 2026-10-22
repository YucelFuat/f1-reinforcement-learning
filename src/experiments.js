// Deney yöneticisi – veri katmanı (IndexedDB 'rl-yaris-lab' veritabanının 'runs' deposu).
//
//   saveRun(run) → id     listRuns()     getRun(id)     deleteRun(id)     updateRun(id, değişiklik)
//   runsToJSON(runs) / runsFromJSON(metin)       → dosyaya aktarma (typed array ve ±Infinity korunur)
//   downloadRuns(runs, dosyaAdı) / importRunsFromFile(file)
//   diffConfigs(runs)    → seçilen deneyler arasında farklı olan ayarlar (fizik, araç, kurallar, ödül, algoritma…)
//   mergeHistories(runs, getter) → karşılaştırma grafikleri için nesil/güncelleme numarasına göre birleşik dizi
//
// Bir deney kaydı: { id, name, notes, createdAt, cfg, trackId, trackName, trackDef?, algo, algoLabel, seed, carCount,
//   history (sadeleştirilmiş), bestLapSec, idealLapSec, bestLapBrain, bestBrain?, wallSec, totalTicks, generations }

import { withStore, hasIndexedDB } from './persist.js';
import { ALGOS } from './algos/index.js';

export const RUNS_FORMAT = 'rl-yaris-deneyler';
export const RUNS_VERSION = 1;
const STORE = 'runs';

// Karşılaştırma için gereken geçmiş alanları (algoritmaya özgü 'extra' atılır → kayıt küçük kalır)
const HISTORY_KEYS = ['gen', 'best', 'avg', 'finishers', 'finishRate', 'bestLap', 'avgProgress', 'q', 'episodes', 'crashed', 'spins'];

export function slimHistory(history) {
  if (!Array.isArray(history)) return [];
  return history.map((h) => {
    const o = {};
    for (const k of HISTORY_KEYS) {
      const v = h[k];
      if (v !== undefined) o[k] = v;
    }
    if (Array.isArray(h.sectors)) o.sectors = h.sectors.slice(0, 3);
    return o;
  });
}

const cloneOrNull = (v) => (v == null ? null : structuredClone(v));

function finiteOrNull(v) {
  return typeof v === 'number' && isFinite(v) ? v : null;
}

// Girdi nesnesinden temiz, klonlanabilir bir kayıt oluşturur (saf fonksiyon; IndexedDB gerektirmez)
export function makeRunRecord(run) {
  if (!run || typeof run !== 'object') throw new Error('Deney verisi yok');
  const history = slimHistory(run.history);
  const last = history.length ? history[history.length - 1] : null;
  const rec = {
    name: String(run.name || '').trim() || defaultRunName(run),
    notes: String(run.notes || ''),
    createdAt: typeof run.createdAt === 'number' ? run.createdAt : Date.now(),
    cfg: cloneOrNull(run.cfg) || {},
    trackId: run.trackId ?? run.trackDef?.id ?? null,
    trackName: run.trackName ?? run.trackDef?.name ?? '',
    trackDef: cloneOrNull(run.trackDef),
    algo: run.algo || 'ga',
    algoLabel: run.algoLabel || ALGOS[run.algo]?.label || run.algo || '',
    seed: run.seed ?? null,
    carCount: run.carCount ?? null,
    history,
    bestLapSec: finiteOrNull(run.bestLapSec),
    idealLapSec: finiteOrNull(run.idealLapSec),
    bestLapBrain: cloneOrNull(run.bestLapBrain),
    bestBrain: cloneOrNull(run.bestBrain),
    wallSec: finiteOrNull(run.wallSec),
    totalTicks: run.totalTicks ?? null,
    generations: run.generations ?? (last ? last.gen : 0),
    finishRate: last && typeof last.finishRate === 'number' ? last.finishRate : null,
  };
  if (run.id != null) rec.id = run.id;
  return rec;
}

export function defaultRunName(run) {
  const d = new Date(run?.createdAt || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  const algo = (run && (run.algoLabel || ALGOS[run.algo]?.label || run.algo)) || 'Deney';
  const short = algo.split(/[ (–-]/)[0];
  return `${short} · ${run?.trackName || run?.trackId || ''} · ${p(d.getDate())}.${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ---------------------------------------------------------------- IndexedDB
export async function saveRun(run) {
  const rec = makeRunRecord(run);
  delete rec.id; // her kayıt yeni kimlik alır
  return withStore(STORE, 'readwrite', (s) => s.add(rec));
}

export async function listRuns() {
  if (!hasIndexedDB()) return [];
  const all = (await withStore(STORE, 'readonly', (s) => s.getAll())) || [];
  return all.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

export async function getRun(id) {
  return (await withStore(STORE, 'readonly', (s) => s.get(id))) || null;
}

export async function deleteRun(id) {
  await withStore(STORE, 'readwrite', (s) => s.delete(id));
}

export async function updateRun(id, patch) {
  const cur = await getRun(id);
  if (!cur) throw new Error('Deney bulunamadı');
  const next = { ...cur, ...patch, id };
  await withStore(STORE, 'readwrite', (s) => s.put(next));
  return next;
}

// ---------------------------------------------------------------- JSON dışa / içe aktarma
// typed array → { $ta: 'Float32Array', v: [...] },  ±Infinity / NaN → { $num: 'Infinity' }
function replacer(key, value) {
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) return { $ta: value.constructor.name, v: Array.from(value) };
  if (typeof value === 'number' && !isFinite(value)) return { $num: String(value) };
  return value;
}
const TA = { Float32Array, Float64Array, Int8Array, Int16Array, Int32Array, Uint8Array, Uint16Array, Uint32Array, Uint8ClampedArray };
function reviver(key, value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (typeof value.$ta === 'string' && Array.isArray(value.v) && TA[value.$ta]) return TA[value.$ta].from(value.v);
    if (typeof value.$num === 'string' && Object.keys(value).length === 1) return Number(value.$num);
  }
  return value;
}

export function runsToJSON(runs) {
  return JSON.stringify({ format: RUNS_FORMAT, version: RUNS_VERSION, exportedAt: new Date().toISOString(), runs }, replacer);
}

// Dosya içeriğinden deney listesi (kimliksiz). Tek deney nesnesi ya da dizi de kabul edilir.
export function runsFromJSON(text) {
  let o;
  try {
    o = JSON.parse(text, reviver);
  } catch {
    throw new Error('Dosya geçerli bir JSON değil');
  }
  let list;
  if (o && o.format === RUNS_FORMAT && Array.isArray(o.runs)) list = o.runs;
  else if (Array.isArray(o)) list = o;
  else if (o && typeof o === 'object' && o.cfg && Array.isArray(o.history)) list = [o];
  else throw new Error('Bu dosya bir deney dışa aktarımı değil');
  return list.map((r) => {
    const rec = makeRunRecord(r);
    delete rec.id;
    return rec;
  });
}

export function downloadText(text, filename, type = 'application/json') {
  const blob = new Blob([text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(a.href);
  }, 4000);
}

export function safeFileName(s) {
  return String(s || 'deney')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ı/g, 'i').replace(/İ/g, 'I')
    .replace(/[^\w.-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 60) || 'deney';
}

export function downloadRuns(runs, filename) {
  const name = filename || (runs.length === 1 ? `deney-${safeFileName(runs[0].name)}.json` : `deneyler-${runs.length}-${new Date().toISOString().slice(0, 10)}.json`);
  downloadText(runsToJSON(runs), name);
}

export async function importRunsFromFile(file) {
  const runs = runsFromJSON(await file.text());
  const ids = [];
  for (const r of runs) ids.push(await saveRun(r));
  return ids;
}

// ---------------------------------------------------------------- ayar farkları
export const SECTION_LABELS = {
  meta: 'Genel',
  physics: 'Fizik',
  car: 'Araç',
  rules: 'Kurallar',
  reward: 'Ödül / Ceza',
  sensors: 'Sensörler',
  algo: 'Algoritma',
};

// cfg → { 'physics.mu': 1.72, ..., 'algo.lr': 0.03 }. Algoritma bölümlerinden yalnızca deneyin kendi algoritması alınır.
export function flattenConfig(cfg, algo) {
  const out = {};
  const walk = (obj, prefix) => {
    for (const [k, v] of Object.entries(obj || {})) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === 'object' && !Array.isArray(v) && !ArrayBuffer.isView(v)) walk(v, key);
      else out[key] = ArrayBuffer.isView(v) ? Array.from(v) : v;
    }
  };
  for (const [sec, v] of Object.entries(cfg || {})) {
    if (ALGOS[sec]) {
      if (sec === algo) walk(v, 'algo');
      continue;
    }
    if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, sec);
    else out[sec] = v;
  }
  return out;
}

function valueKey(v) {
  if (v === undefined) return '∅';
  if (typeof v === 'number' && Number.isNaN(v)) return 'NaN';
  return JSON.stringify(v);
}

// Seçilen deneyler arasında farklı olan ayarlar: [{ key, section, sectionLabel, name, values: [...] }]
// opts.includeMeta: algoritma / pist / tohum / araç sayısı satırları da (farklıysa) eklenir
export function diffConfigs(runs, { includeMeta = true } = {}) {
  const flats = runs.map((r) => flattenConfig(r.cfg, r.algo));
  if (includeMeta) {
    runs.forEach((r, i) => {
      flats[i]['meta.algo'] = r.algoLabel || r.algo;
      flats[i]['meta.track'] = r.trackName || r.trackId;
      flats[i]['meta.seed'] = r.seed ?? null;
      flats[i]['meta.carCount'] = r.carCount ?? null;
    });
  }
  const keys = new Set();
  for (const f of flats) for (const k of Object.keys(f)) keys.add(k);
  const order = ['meta', 'physics', 'car', 'rules', 'reward', 'sensors', 'algo'];
  const secIdx = (k) => {
    const i = order.indexOf(k.split('.')[0]);
    return i < 0 ? order.length : i;
  };
  const metaNames = { algo: 'Algoritma', track: 'Pist', seed: 'Tohum', carCount: 'Araç sayısı' };
  const rows = [];
  for (const key of [...keys].sort((a, b) => secIdx(a) - secIdx(b) || a.localeCompare(b))) {
    const values = flats.map((f) => f[key]);
    const first = valueKey(values[0]);
    if (values.every((v) => valueKey(v) === first)) continue;
    const section = key.includes('.') ? key.split('.')[0] : 'diğer';
    const name = key.includes('.') ? key.slice(section.length + 1) : key;
    rows.push({
      key,
      section,
      sectionLabel: SECTION_LABELS[section] || section,
      name: section === 'meta' ? metaNames[name] || name : name,
      values,
    });
  }
  return rows;
}

export function formatValue(v) {
  if (v === undefined || v === null) return '–';
  if (typeof v === 'boolean') return v ? 'açık' : 'kapalı';
  if (typeof v === 'number') {
    if (!isFinite(v)) return String(v);
    if (Number.isInteger(v)) return String(v);
    const a = Math.abs(v);
    return a >= 100 ? v.toFixed(1) : a >= 1 ? v.toFixed(3).replace(/\.?0+$/, '') : v.toPrecision(3).replace(/\.?0+$/, '');
  }
  if (Array.isArray(v)) return v.join(', ');
  return String(v);
}

// ---------------------------------------------------------------- karşılaştırma verisi
// Deney geçmişlerini nesil/güncelleme numarasına göre hizalar.
// seriesOf(history) → her geçmiş girdisi için bir değer dizisi. Sonuç: [{ gen, v: [run0Değeri, run1Değeri, ...] }]
export function mergeHistories(runs, seriesOf) {
  let lo = Infinity, hi = -Infinity;
  const maps = runs.map((r) => {
    const m = new Map();
    const hist = r.history || [];
    const vals = seriesOf(hist);
    hist.forEach((h, i) => {
      const g = h.gen;
      if (typeof g !== 'number' || !isFinite(g)) return;
      lo = Math.min(lo, g);
      hi = Math.max(hi, g);
      const v = vals[i];
      m.set(g, v == null || !isFinite(v) ? null : v);
    });
    return m;
  });
  if (!isFinite(lo)) return [];
  const out = [];
  for (let g = lo; g <= hi; g++) out.push({ gen: g, v: maps.map((m) => (m.has(g) ? m.get(g) : null)) });
  return out;
}

// o ana kadarki en iyi tur süresi (sn), geçmiş boyunca
export function runningBestLap(history) {
  let best = null;
  return history.map((h) => {
    if (typeof h.bestLap === 'number' && h.bestLap > 0 && (best == null || h.bestLap < best)) best = h.bestLap;
    return best;
  });
}
