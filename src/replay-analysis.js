// Tekrar analizi (DOM kullanmaz, Node'da da çalışır):
//   • tur / sektör / mini sektör süreleri ve mor-yeşil-sarı sınıflandırma
//   • karşılaştırma izleri: önceki rekor sürüşü, gerçek F1 referans turu, CSV içe aktarma, kendi en iyi turu
//   • mesafeye göre delta zaman (pozitif = odak araç daha yavaş)
//   • çoklu araç tekrarında sıralama, sollama ve temas olayları
// Mesafe birimi her yerde metredir; "absolute" eksen başlangıç çizgisinden itibaren (çok turda L, 2L, …),
// "periodic" izler tek bir turu [0, L] aralığında tanımlar ve her tura yeniden uygulanır.

import { TICK_RATE } from './config.js';
import { FRAME_STRIDE, FR } from './replay.js';
import { FINISHED, RUNNING } from './sim.js';

export const CMP_COLORS = { reference: '#ffd166', replay: '#c39bff', csv: '#ff9f43', lap: '#7ee787' };

// ---------- temel yardımcılar ----------

// İlk varış tablosu: mesafe kesin artan olacak şekilde (geri gitme / spin kısımları atlanır)
export function monoTable(dist, time, n = dist.length) {
  const d = [], t = [];
  let last = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = dist[i];
    if (!(v > last + 1e-6) || !isFinite(time[i])) continue;
    d.push(v);
    t.push(time[i]);
    last = v;
  }
  return { d: Float64Array.from(d), t: Float64Array.from(t) };
}

// Doğrusal ara değer; aralık dışında NaN (tol kadar taşmaya izin verilir)
export function interp(xs, ys, x, tol = 0) {
  const n = xs.length;
  if (!n || !(x >= xs[0] - tol) || !(x <= xs[n - 1] + tol)) return NaN;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[n - 1]) return ys[n - 1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (xs[m] <= x) lo = m;
    else hi = m;
  }
  const f = (x - xs[lo]) / (xs[hi] - xs[lo] || 1);
  return ys[lo] + (ys[hi] - ys[lo]) * f;
}

// Basamaklı (en yakın önceki) değer — vites, DRS gibi kanallar için
export function stepAt(xs, ys, x) {
  const n = xs.length;
  if (!n || !(x >= xs[0]) || !(x <= xs[n - 1])) return NaN;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (xs[m] <= x) lo = m;
    else hi = m;
  }
  return ys[lo];
}

// ---------- tur / sektör analizi ----------

// T: computeTelemetry çıktısı (dist m, time s). Her tur için sektör ve mini sektör süreleri.
// İlk tur, simülasyonla aynı şekilde kalkıştan (t = 0) ölçülür.
export function lapAnalysis(T, track, laps) {
  const L = track.lengthMeters;
  const sf = track.sectorFrac || [1 / 3, 2 / 3, 1];
  const NM = track.miniSectors || 24;
  const mt = monoTable(T.dist, T.tnp || T.time, T.n);
  const nd = mt.d.length;
  const maxD = nd ? mt.d[nd - 1] : 0;
  const tAt = (d) => interp(mt.d, mt.t, d, 0.6);
  const out = [];
  for (let k = 0; k < laps; k++) {
    const d0 = k * L;
    if (maxD < d0 + 1) break;
    const t0 = k === 0 ? 0 : tAt(d0);
    if (!isFinite(t0)) break;
    const bnd = (f) => tAt(d0 + f * L);
    const sectors = [];
    let prev = t0;
    for (let j = 0; j < 3; j++) {
      const b = bnd(sf[j]);
      sectors.push(isFinite(b) && isFinite(prev) ? b - prev : null);
      prev = b;
    }
    const minis = [];
    prev = t0;
    for (let m = 0; m < NM; m++) {
      const b = bnd((m + 1) / NM);
      minis.push(isFinite(b) && isFinite(prev) ? b - prev : null);
      prev = b;
    }
    const tEnd = bnd(1);
    out.push({
      lap: k + 1,
      t0,
      complete: isFinite(tEnd),
      time: isFinite(tEnd) ? tEnd - t0 : null,
      sectors,
      minis,
    });
  }
  return out;
}

// Satırlar (sahip → tur listesi) için mor / yeşil / sarı renk sınıfları.
// rows: [{ owner, sectors:[3], minis:[NM], time }] — mor: tüm satırların en iyisi, yeşil: sahibinin en iyisi, sarı: daha yavaş.
export function classifyRows(rows) {
  const cols = (r) => [...r.sectors, r.time, ...r.minis];
  const nc = rows.length ? cols(rows[0]).length : 0;
  const best = new Array(nc).fill(Infinity);
  const own = new Map();
  for (const r of rows) {
    const c = cols(r);
    let ob = own.get(r.owner);
    if (!ob) own.set(r.owner, (ob = new Array(nc).fill(Infinity)));
    for (let j = 0; j < nc; j++) {
      const v = c[j];
      if (v == null || !isFinite(v)) continue;
      if (v < best[j]) best[j] = v;
      if (v < ob[j]) ob[j] = v;
    }
  }
  for (const r of rows) {
    const c = cols(r), ob = own.get(r.owner);
    const cls = c.map((v, j) => (v == null || !isFinite(v) ? '' : v <= best[j] + 1e-6 ? 'p' : v <= ob[j] + 1e-6 ? 'g' : 'y'));
    r.cls = { sectors: cls.slice(0, 3), time: cls[3], minis: cls.slice(4) };
  }
  return rows;
}

// Pit duraklarını zaman sıçramalarından bul
export function findPits(T, pitLossSec = 21) {
  const thr = Math.max(1, 0.5 * (pitLossSec || 0));
  const out = [];
  for (let i = 1; i < T.n; i++) {
    const jump = T.time[i] - T.time[i - 1];
    if (jump > thr) out.push({ i, loss: jump - 1 / TICK_RATE, compFrom: T.comp[i - 1], compTo: T.comp[i], lap: T.lap[i] });
  }
  return out;
}

// ---------- karşılaştırma izleri ----------
// İz biçimi: { kind, label, color, periodic, lapLen (m), lapTime, dist[], time[], speed[] km/h, thr[] 0-1, brake[] 0-1,
//              gear[], rpm[]?, drs[]?, x[]?, y[]?, ang[]? (konum varsa hayalet gerçek çizgide sürer) }

function f64(a, n) {
  const o = new Float64Array(n);
  for (let i = 0; i < n; i++) o[i] = +a[i];
  return o;
}

// Ham dizilerden (gerçek tur / CSV) iz oluşturur. Mesafe pistin uzunluğuna oranla eşlenir.
export function traceFromArrays(src, track, { kind = 'reference', label = 'Referans', color, lapDistM, lapTimeS, absolute = false } = {}) {
  const n = src.dist.length;
  if (n < 5) throw new Error('Yetersiz veri');
  const L = track.lengthMeters;
  const dRaw = f64(src.dist, n);
  const D = absolute ? L : lapDistM || dRaw[n - 1];
  const k = absolute ? 1 : L / D;
  const dist = new Float64Array(n);
  for (let i = 0; i < n; i++) dist[i] = dRaw[i] * k;
  const speed = f64(src.speed, n);
  // zaman: varsa ve düzgünse doğrudan; yoksa hızdan integral (5 m adımlı ham zaman 0.1 sn çözünürlüklü olabilir → pürüzsüz)
  let time = null;
  if (src.time && src.time.length === n) {
    const t = f64(src.time, n);
    let inc = 0, uniq = 0;
    for (let i = 1; i < n; i++) {
      if (t[i] >= t[i - 1]) inc++;
      if (t[i] > t[i - 1]) uniq++;
    }
    if (inc >= (n - 1) * 0.98 && uniq >= (n - 1) * 0.95) {
      time = new Float64Array(n);
      const t0 = t[0];
      let last = 0;
      for (let i = 0; i < n; i++) {
        last = Math.max(last, t[i] - t0);
        time[i] = last;
      }
    }
  }
  if (!time) {
    time = new Float64Array(n);
    for (let i = 1; i < n; i++) {
      const v = Math.max(1, ((speed[i - 1] + speed[i]) / 2) / 3.6);
      time[i] = time[i - 1] + (dRaw[i] - dRaw[i - 1]) / v;
    }
    // toplamı bilinen tur süresine ölçekle (son örnekten tur sonuna kalan kısım dahil)
    let total = lapTimeS;
    if (!total && src.time && src.time.length === n) total = +src.time[n - 1] - +src.time[0];
    if (total > 0) {
      const tail = Math.max(0, (lapDistM || dRaw[n - 1]) - dRaw[n - 1]) / Math.max(1, speed[n - 1] / 3.6);
      const sc = total / (time[n - 1] + tail);
      if (sc > 0.5 && sc < 2) for (let i = 0; i < n; i++) time[i] *= sc;
    }
  }
  const thr = new Float32Array(n), brake = new Float32Array(n), gear = new Float32Array(n);
  let thrMax = 0, brMax = 0;
  for (let i = 0; i < n; i++) {
    thrMax = Math.max(thrMax, +(src.thr?.[i] ?? 0) || 0);
    brMax = Math.max(brMax, +(src.brake?.[i] ?? 0) || 0);
  }
  const thrK = thrMax > 1.5 ? 0.01 : 1, brK = brMax > 1.5 ? 0.01 : 1;
  for (let i = 0; i < n; i++) {
    thr[i] = src.thr ? Math.max(0, Math.min(1, (+src.thr[i] || 0) * thrK)) : NaN;
    brake[i] = src.brake ? Math.max(0, Math.min(1, (+src.brake[i] || 0) * brK)) : NaN;
    gear[i] = src.gear ? +src.gear[i] || 0 : NaN;
  }
  const lastT = time[n - 1];
  const lapTime = lapTimeS || (absolute ? null : lastT + Math.max(0, (D - dRaw[n - 1]) / Math.max(1, speed[n - 1] / 3.6)));
  return {
    kind, label, color: color || CMP_COLORS[kind] || '#ffd166', periodic: !absolute, lapLen: L, lapTime,
    dist, time, speed: Float32Array.from(speed), thr, brake, gear,
    rpm: src.rpm ? Float32Array.from(src.rpm, Number) : null,
    drs: src.drs ? Float32Array.from(src.drs, (v) => (+v >= 10 ? 1 : +v > 0 && +v < 2 ? +v : 0)) : null,
    hasThr: !!src.thr, hasBrake: !!src.brake, hasGear: !!src.gear,
  };
}

// src/tracks/reftel/*.json → iz
export function traceFromReference(ref, track) {
  const label = `Gerçek F1 · ${ref.driver || ''} ${ref.year || ''} ${ref.event || ''}`.replace(/\s+/g, ' ').trim();
  const tr = traceFromArrays(
    { dist: ref.dist, speed: ref.speed, thr: ref.throttle, brake: ref.brake, gear: ref.gear, rpm: ref.rpm, drs: ref.drs, time: ref.time },
    track,
    { kind: 'reference', label, lapDistM: ref.lapDistM, lapTimeS: ref.lapTimeS },
  );
  tr.lapTime = ref.lapTimeS || tr.lapTime;
  tr.source = ref.source || '';
  tr.short = `${(ref.driver || 'Referans').split(' ').pop()} ${ref.year || ''}`.trim();
  return tr;
}

// Başka bir tekrar (önceki rekor sürüşü vb.) → mutlak eksende iz
export function traceFromTelemetry(T, { label = 'Karşılaştırma', kind = 'replay', color } = {}) {
  return {
    kind, label, color: color || CMP_COLORS[kind], periodic: false, lapLen: null,
    lapTime: T.status0 === FINISHED ? T.summary?.surS ?? null : null,
    dist: Float64Array.from(T.dist), time: Float64Array.from(T.time), speed: T.speed, thr: T.thr, brake: T.brake,
    gear: Float32Array.from(T.gear), rpm: T.rpm, drs: T.drs, hasThr: true, hasBrake: true, hasGear: true, T,
  };
}

// Odak aracın kendi en iyi turu → tekrarlanan (periyodik) iz (konumlu: hayalet gerçek çizgide sürer)
export function traceFromOwnLap(T, lapInfo, L, color = CMP_COLORS.lap) {
  const d0 = (lapInfo.lap - 1) * L, d1 = d0 + L;
  const idx = [];
  for (let i = 0; i < T.n; i++) if (T.dist[i] >= d0 - 1 && T.dist[i] <= d1 + 1) idx.push(i);
  const pick = (a, f = (v) => v) => Float64Array.from(idx, (i) => f(a[i]));
  const tr = {
    kind: 'lap', label: `Kendi en iyi turu (Tur ${lapInfo.lap} · ${lapInfo.time.toFixed(3)} sn)`, color, periodic: true, lapLen: L,
    lapTime: lapInfo.time,
    dist: pick(T.dist, (v) => v - d0), time: pick(T.tnp || T.time, (v) => v - lapInfo.t0),
    speed: Float32Array.from(idx, (i) => T.speed[i]), thr: Float32Array.from(idx, (i) => T.thr[i]), brake: Float32Array.from(idx, (i) => T.brake[i]),
    gear: Float32Array.from(idx, (i) => T.gear[i]), x: pick(T.xPx), y: pick(T.yPx), ang: pick(T.ang),
    hasThr: true, hasBrake: true, hasGear: true,
  };
  return tr;
}

// İzin bir kanalının odak mesafe ekseninde (mutlak) değeri
export function traceValueAt(tr, chan, dAbs) {
  const arr = tr[chan];
  if (!arr) return NaN;
  let d = dAbs;
  if (tr.periodic) {
    const L = tr.lapLen;
    d = dAbs - Math.floor(dAbs / L) * L;
  }
  return chan === 'gear' || chan === 'drs' ? stepAt(tr.dist, arr, d) : interp(tr.dist, arr, d);
}

// Çok turlu odak için periyodik izi [0, laps·L] boyunca tekrarla (çizim için)
export function expandTrace(tr, laps, maxD) {
  if (!tr.periodic) return { x: tr.dist, speed: tr.speed, thr: tr.thr, brake: tr.brake, gear: tr.gear, n: tr.dist.length };
  const n = tr.dist.length, L = tr.lapLen;
  const reps = Math.max(1, Math.min(laps, Math.ceil(Math.max(maxD, 1) / L)));
  const N = n * reps;
  const x = new Float64Array(N), speed = new Float32Array(N), thr = new Float32Array(N), brake = new Float32Array(N), gear = new Float32Array(N);
  for (let k = 0; k < reps; k++) {
    for (let i = 0; i < n; i++) {
      const j = k * n + i;
      x[j] = tr.dist[i] + k * L;
      speed[j] = tr.speed[i];
      thr[j] = tr.thr[i];
      brake[j] = tr.brake[i];
      gear[j] = tr.gear[i];
    }
  }
  return { x, speed, thr, brake, gear, n: N };
}

// Delta zaman: odak − karşılaştırma, odak mesafesinde (pozitif = odak daha yavaş)
export function deltaSeries(T, tr, L, step = 5) {
  // periyodik (tur tur) karşılaştırmada pit kaybı dışarıda bırakılır; mutlak (yarış) karşılaştırmada dahildir
  const f = monoTable(T.dist, tr.periodic && T.tnp ? T.tnp : T.time, T.n);
  const c = monoTable(tr.dist, tr.time);
  const nf = f.d.length;
  if (nf < 2 || c.d.length < 2) return { x: new Float32Array(0), y: new Float32Array(0), n: 0 };
  const d0 = Math.max(0, f.d[0]), d1 = f.d[nf - 1];
  const xs = [], ys = [];
  const lapStart = new Map();
  for (let d = d0; d <= d1 + 1e-6; d += step) {
    let y;
    if (tr.periodic) {
      const k = Math.floor(d / L);
      let ls = lapStart.get(k);
      if (ls === undefined) {
        ls = k === 0 ? 0 : interp(f.d, f.t, k * L);
        lapStart.set(k, ls);
      }
      const dl = d - k * L;
      y = interp(f.d, f.t, d) - ls - interp(c.d, c.t, dl, 0.5);
    } else {
      y = interp(f.d, f.t, d) - interp(c.d, c.t, d, 0.5);
    }
    xs.push(d);
    ys.push(isFinite(y) ? y : NaN);
  }
  return { x: Float64Array.from(xs), y: Float32Array.from(ys), n: xs.length };
}

// Periyodik iz için tur/sektör/mini sektör satırı
export function traceLapRows(tr, track) {
  const sf = track.sectorFrac || [1 / 3, 2 / 3, 1];
  const NM = track.miniSectors || 24;
  const L = track.lengthMeters;
  const c = monoTable(tr.dist, tr.time);
  const end = tr.lapTime ?? c.t[c.t.length - 1];
  const tAt = (f) => (f >= 1 ? end : interp(c.d, c.t, f * L, 0.5));
  const sectors = [];
  let prev = 0;
  for (let j = 0; j < 3; j++) {
    const b = tAt(sf[j]);
    sectors.push(isFinite(b) ? b - prev : null);
    prev = b;
  }
  const minis = [];
  prev = 0;
  for (let m = 0; m < NM; m++) {
    const b = tAt((m + 1) / NM);
    minis.push(isFinite(b) && isFinite(prev) ? b - prev : null);
    prev = b;
  }
  return [{ lap: 1, t0: 0, complete: isFinite(end), time: isFinite(end) ? end : null, sectors, minis }];
}

// Hayalet konumu: periyodik iz için tur başından bu yana geçen süre → mesafe
export function traceDistAtTime(tr, tau) {
  const n = tr.time.length;
  if (!n) return NaN;
  if (tau <= 0) return tr.dist[0];
  if (tau >= tr.time[n - 1]) return tr.dist[n - 1];
  return interp(tr.time, tr.dist, tau);
}

// ---------- CSV içe aktarma ----------

const TR_FOLD = { ı: 'i', İ: 'i', ş: 's', Ş: 's', ğ: 'g', Ğ: 'g', ü: 'u', Ü: 'u', ö: 'o', Ö: 'o', ç: 'c', Ç: 'c' };
function normName(s) {
  return String(s)
    .replace(/[ıİşŞğĞüÜöÖçÇ]/g, (c) => TR_FOLD[c])
    .toLowerCase()
    .replace(/\(([^)]*)\)|\[([^\]]*)\]/g, '_$1$2')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}
const ALIASES = {
  dist: ['distance', 'dist', 'mesafe', 'mesafe_m', 'distance_m', 'dist_m', 'lapdistance', 'lap_distance', 'tur_mesafesi', 'konum_m'],
  rel: ['relativedistance', 'relative_distance', 'goreli_mesafe'],
  speed: ['speed', 'hiz', 'hiz_kmh', 'hiz_km_h', 'hiz_km_s', 'speed_kmh', 'speed_km_h', 'v_kmh', 'velocity', 'surat'],
  speedMs: ['speed_ms', 'speed_m_s', 'hiz_ms', 'hiz_m_s', 'v_ms'],
  thr: ['throttle', 'gaz', 'gaz_yuzde', 'throttle_pct', 'throttle_percent', 'throttle_yuzde', 'gaz_pedali'],
  brake: ['brake', 'fren', 'fren_yuzde', 'brake_pct', 'brake_percent', 'fren_pedali'],
  gear: ['ngear', 'gear', 'vites', 'n_gear'],
  time: ['time', 'zaman', 'zaman_s', 'time_s', 'sure', 'sure_s', 'laptime_s', 'elapsed', 'gecen_sure'],
  rpm: ['rpm', 'devir', 'devir_rpm', 'n_rpm'],
  drs: ['drs'],
};

function splitLine(line, sep) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === sep) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

// "0 days 00:01:23.456000", "1:23.456", "01:02:03.5", "83.456" → saniye
export function parseTimeValue(s, decimalComma) {
  if (typeof s !== 'string') return +s;
  let v = s.trim();
  if (!v) return NaN;
  if (decimalComma) v = v.replace(',', '.');
  let m = v.match(/^(-?\d+)\s+days?\s+(\d+):(\d+):(\d+(?:\.\d+)?)$/i);
  if (m) return +m[1] * 86400 + +m[2] * 3600 + +m[3] * 60 + +m[4];
  m = v.match(/^(\d+):(\d+):(\d+(?:\.\d+)?)$/);
  if (m) return +m[1] * 3600 + +m[2] * 60 + +m[3];
  m = v.match(/^(\d+):(\d+(?:\.\d+)?)$/);
  if (m) return +m[1] * 60 + +m[2];
  return +v;
}

function parseNum(s, decimalComma) {
  if (s == null) return NaN;
  let v = String(s).trim();
  if (!v) return NaN;
  const low = v.toLowerCase();
  if (low === 'true' || low === 'evet' || low === 'yes' || low === 'on') return 1;
  if (low === 'false' || low === 'hayir' || low === 'hayır' || low === 'no' || low === 'off') return 0;
  if (decimalComma) v = v.includes(',') ? v.replace(/\./g, '').replace(',', '.') : v;
  return +v;
}

// Bir tur telemetrisi CSV'si: en az mesafe (m) + hız (km/s) sütunları. Ayırıcı , ; veya sekme; ondalık virgül desteklenir.
// '#' ile başlayan satırlar üst bilgi: "# surucu: VER" gibi.
export function parseLapCSV(text, fileName = '') {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/);
  const meta = {};
  const rows = [];
  for (const raw of lines) {
    const t = raw.trim();
    if (!t) continue;
    if (t.startsWith('#')) {
      const m = t.slice(1).match(/^\s*([^:=]+?)\s*[:=]\s*(.*)$/);
      if (m) meta[normName(m[1])] = m[2].trim();
      continue;
    }
    rows.push(raw);
  }
  if (rows.length < 3) throw new Error('CSV boş ya da çok kısa.');
  const head = rows[0];
  const cnt = (ch) => head.split(ch).length - 1;
  const sep = cnt('\t') > 0 && cnt('\t') >= cnt(';') && cnt('\t') >= cnt(',') ? '\t' : cnt(';') > 0 && cnt(';') >= cnt(',') ? ';' : ',';
  const names = splitLine(head, sep).map(normName);
  // ondalık virgül: ayırıcı virgül değilse ve sayılarda "12,5" biçimi varsa
  let decimalComma = false;
  if (sep !== ',') {
    for (let i = 1; i < Math.min(rows.length, 30); i++) if (/(^|[^\d])\d+,\d+([^\d]|$)/.test(rows[i])) { decimalComma = true; break; }
  }
  const col = {};
  for (const [key, al] of Object.entries(ALIASES)) {
    let idx = names.findIndex((n) => al.includes(n));
    if (idx < 0) idx = names.findIndex((n) => al.some((a) => n.startsWith(a + '_')));
    if (idx >= 0) col[key] = idx;
  }
  if (col.dist == null && col.rel != null) col.dist = col.rel;
  if (col.speed == null && col.speedMs != null) col.speed = col.speedMs;
  if (col.dist == null || col.speed == null) {
    throw new Error(`CSV'de mesafe ve hız sütunları bulunamadı. Bulunan başlıklar: ${names.join(', ')}. Beklenen ör.: Distance/mesafe_m ve Speed/hiz_kmh.`);
  }
  const relative = col.dist === col.rel;
  const speedK = col.speed === col.speedMs ? 3.6 : 1;
  const recs = [];
  for (let i = 1; i < rows.length; i++) {
    const c = splitLine(rows[i], sep);
    const d = parseNum(c[col.dist], decimalComma);
    const v = parseNum(c[col.speed], decimalComma) * speedK;
    if (!isFinite(d) || !isFinite(v)) continue;
    recs.push({
      d, v,
      thr: col.thr != null ? parseNum(c[col.thr], decimalComma) : NaN,
      br: col.brake != null ? parseNum(c[col.brake], decimalComma) : NaN,
      g: col.gear != null ? parseNum(c[col.gear], decimalComma) : NaN,
      t: col.time != null ? parseTimeValue(c[col.time], decimalComma) : NaN,
      rpm: col.rpm != null ? parseNum(c[col.rpm], decimalComma) : NaN,
      drs: col.drs != null ? parseNum(c[col.drs], decimalComma) : NaN,
    });
  }
  const kept = recs.filter((r) => r.d >= 0).sort((a, b) => a.d - b.d);
  const uniq = [];
  for (const r of kept) if (!uniq.length || r.d > uniq[uniq.length - 1].d + 1e-6) uniq.push(r);
  if (uniq.length < 20) throw new Error('CSV en az 20 geçerli satır içermeli (mesafe ≥ 0).');
  const has = (k) => uniq.some((r) => isFinite(r[k]));
  const arr = (k) => uniq.map((r) => (isFinite(r[k]) ? r[k] : 0));
  const out = {
    meta,
    fileName,
    relative,
    dist: arr('d'),
    speed: arr('v'),
    thr: has('thr') ? arr('thr') : null,
    brake: has('br') ? arr('br') : null,
    gear: has('g') ? arr('g') : null,
    time: has('t') ? arr('t') : null,
    rpm: has('rpm') ? arr('rpm') : null,
    drs: has('drs') ? arr('drs') : null,
    columns: Object.fromEntries(Object.entries(col).map(([k, i]) => [k, names[i]])),
    separator: sep,
    decimalComma,
  };
  const lt = meta.tur_suresi_s || meta.lap_time_s || meta.laptime;
  out.lapTimeS = lt ? parseTimeValue(String(lt).replace(',', '.'), false) : null;
  const ld = meta.tur_mesafesi_m || meta.lap_distance_m;
  out.lapDistM = ld ? +String(ld).replace(',', '.') : null;
  const who = [meta.surucu || meta.driver, meta.yil || meta.year, meta.etkinlik || meta.event].filter(Boolean).join(' ');
  out.label = who ? `CSV · ${who}` : `CSV · ${fileName || 'içe aktarılan tur'}`;
  return out;
}

// CSV verisi → iz. Göreli mesafe (0-1) veya pistten çok uzun (çok turlu dışa aktarım) ise mutlak eksen kullanılır.
export function traceFromCSV(parsed, track) {
  const L = track.lengthMeters;
  let dist = parsed.dist;
  if (parsed.relative || dist[dist.length - 1] <= 1.01) dist = dist.map((v) => v * L);
  const span = dist[dist.length - 1];
  const absolute = span > L * 1.8; // çok turlu dışa aktarım (ör. bu uygulamanın telemetri.csv'si)
  const tr = traceFromArrays(
    { dist, speed: parsed.speed, thr: parsed.thr, brake: parsed.brake, gear: parsed.gear, time: parsed.time, rpm: parsed.rpm, drs: parsed.drs },
    track,
    { kind: 'csv', label: parsed.label, lapDistM: parsed.relative ? L : parsed.lapDistM || null, lapTimeS: parsed.lapTimeS || null, absolute },
  );
  tr.short = parsed.meta.surucu || parsed.meta.driver || 'CSV';
  return tr;
}

// ---------- çoklu araç: sıralama ve olaylar ----------

const CAR_LEN = 5.4, CAR_WID = 1.95;

// replays: simulateBrains çıktısı. Her adım için sıralama (pos[k*N+i], 1 = lider), sollama ve temas olayları.
export function raceTimeline(replays, track, { contacts = true } = {}) {
  const N = replays.length, S = FRAME_STRIDE, mpp = track.mpp;
  const K = Math.max(...replays.map((r) => r.count));
  const pos = new Uint8Array(K * N);
  const events = [];
  const order = new Int32Array(N);
  const key = new Float64Array(N);
  const prevAhead = new Int8Array(N * N).fill(-1);
  const inContact = new Uint8Array(N * N);
  for (let k = 0; k < K; k++) {
    for (let i = 0; i < N; i++) {
      const r = replays[i];
      const F = r.frames;
      if (k < r.count) {
        const st = F[k * S + FR.status];
        key[i] = st === FINISHED ? 1e9 - (r.place || 0) * 1e3 - F[k * S + FR.time] : F[k * S + FR.progress];
      } else {
        const last = (r.count - 1) * S;
        key[i] = r.status === FINISHED ? 1e9 - (r.place || 0) * 1e3 - F[last + FR.time] : -1e6 + F[last + FR.progress];
      }
      order[i] = i;
    }
    const ord = Array.from(order).sort((a, b) => key[b] - key[a]);
    for (let p = 0; p < N; p++) pos[k * N + ord[p]] = p + 1;
    // sollama: ikisi de koşarken sıra değişimi
    for (let i = 0; i < N; i++) {
      const ri = replays[i];
      const runI = k < ri.count && ri.frames[k * S + FR.status] === RUNNING;
      for (let j = i + 1; j < N; j++) {
        const rj = replays[j];
        const runJ = k < rj.count && rj.frames[k * S + FR.status] === RUNNING;
        const a = key[i] > key[j] ? 1 : 0;
        const pa = prevAhead[i * N + j];
        if (runI && runJ && pa >= 0 && pa !== a && k > 0) events.push({ k, type: 'overtake', win: a ? i : j, lose: a ? j : i });
        prevAhead[i * N + j] = a;
        if (!contacts) continue;
        if (!runI || !runJ) {
          inContact[i * N + j] = 0;
          continue;
        }
        const Fi = ri.frames, Fj = rj.frames, oi = k * S, oj = k * S;
        const dx = (Fj[oj] - Fi[oi]) * mpp, dy = (Fj[oj + 1] - Fi[oi + 1]) * mpp;
        let hit = false;
        if (dx * dx + dy * dy < CAR_LEN * CAR_LEN) {
          const ai = Fi[oi + FR.ang], c = Math.cos(ai), s = Math.sin(ai);
          const lx = dx * c + dy * s, ly = -dx * s + dy * c;
          hit = (lx / CAR_LEN) ** 2 + (ly / CAR_WID) ** 2 < 1.05;
        }
        if (hit && !inContact[i * N + j]) events.push({ k, type: 'contact', a: i, b: j });
        inContact[i * N + j] = hit ? 1 : 0;
      }
    }
  }
  return { K, N, pos, events };
}
