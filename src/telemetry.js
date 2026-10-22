// Replay telemetrisi: kare verilerinden kanalları hesaplar ve mesafeye göre grafiklerini çizer.
// Sekmeler: Sürüş (hız, pedallar, vites, devir, direksiyon, G, kayma + karşılaştırma ve delta zaman),
//           Sistemler (lastik sıcaklığı/aşınması, yakıt, ERS, DRS, kayma açısı β),
//           Sektörler (S1/S2/S3, mini sektörler, turlar — mor/yeşil/sarı renk kodu).

import { TICK_RATE, GRAVITY, fmtLap, COMPOUNDS, COMPOUND_IDS, ERS } from './config.js';
import { FRAME_STRIDE, FR } from './replay.js';
import { FINISHED, CRASHED } from './sim.js';
import { lapAnalysis, findPits, classifyRows, traceLapRows, expandTrace, traceValueAt, interp } from './replay-analysis.js';

// km/s cinsinden her vitesin üst sınırı (8 ileri), yaklaşık 12.000 d/dk'da vites atılır
export const GEAR_TOPS = [100, 135, 168, 200, 232, 264, 298, 345];

function wrap(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

function smooth(arr, w) {
  const n = arr.length, out = new Float32Array(n);
  let sum = 0;
  const q = [];
  for (let i = 0; i < n; i++) {
    q.push(arr[i]);
    sum += arr[i];
    if (q.length > 2 * w + 1) sum -= q.shift();
    out[Math.max(0, i - w)] = sum / q.length;
  }
  for (let i = Math.max(0, n - w); i < n; i++) out[i] = arr[i];
  return out;
}

export function computeTelemetry(rep, track, opts = {}) {
  const F = rep.frames, S = rep.stride || FRAME_STRIDE, n = rep.count;
  const mpp = track.mpp;
  const f32 = () => new Float32Array(n);
  const T = {
    n,
    t: f32(), time: f32(), dist: f32(), x: f32(), y: f32(), xPx: f32(), yPx: f32(), ang: f32(),
    speed: f32(), thr: f32(), brake: f32(),
    gear: new Uint8Array(n), rpm: f32(),
    steerCmd: f32(), steerPos: f32(),
    latG: f32(), longG: f32(), slip: f32(), elev: f32(),
    beta: f32(), tyreT: f32(), wear: f32(), fuel: f32(), soc: f32(), ersKW: f32(), drs: new Uint8Array(n),
    lap: new Uint16Array(n), comp: new Uint8Array(n), status: new Uint8Array(n),
    rays: [],
  };
  const latRaw = new Float32Array(n), longRaw = new Float32Array(n);
  let gear = 1;
  for (let i = 0; i < n; i++) {
    const o = i * S;
    T.time[i] = F[o + FR.time];
    T.t[i] = T.time[i];
    T.xPx[i] = F[o];
    T.yPx[i] = F[o + 1];
    T.ang[i] = F[o + FR.ang];
    T.x[i] = F[o] * mpp;
    T.y[i] = F[o + 1] * mpp;
    T.dist[i] = F[o + FR.progress] * mpp;
    const v = F[o + FR.spd];
    T.speed[i] = v * 3.6;
    const th = F[o + FR.thr];
    T.thr[i] = Math.max(0, th);
    T.brake[i] = Math.max(0, -th);
    T.steerCmd[i] = F[o + FR.steerCmd];
    T.steerPos[i] = F[o + FR.steerPos];
    T.slip[i] = F[o + FR.slip];
    T.beta[i] = (F[o + FR.beta] * 180) / Math.PI;
    T.tyreT[i] = F[o + FR.tyreT];
    T.wear[i] = F[o + FR.wear];
    T.fuel[i] = F[o + FR.fuel];
    T.soc[i] = F[o + FR.soc] / ERS.storeJ;
    T.ersKW[i] = F[o + FR.ersKW];
    T.drs[i] = F[o + FR.drs] > 0.5 ? 1 : 0;
    T.lap[i] = F[o + FR.lap];
    T.comp[i] = F[o + FR.comp];
    T.status[i] = F[o + FR.status];
    const sAt = track.sAt(F[o], F[o + 1]);
    let k = Math.floor(sAt / track.ds) % track.n;
    if (k < 0) k += track.n;
    T.elev[i] = track.elev[k] + (track.elevBase || 0);
    // vites (histerezisli) ve devir
    const kmh = T.speed[i];
    while (gear < 8 && kmh > GEAR_TOPS[gear - 1] * 0.985) gear++;
    while (gear > 1 && kmh < GEAR_TOPS[gear - 2] * 0.8) gear--;
    T.gear[i] = kmh < 1 ? 1 : gear;
    T.rpm[i] = Math.max(4200, Math.min(12100, (kmh / GEAR_TOPS[gear - 1]) * 12000));
    if (i > 0) {
      const p = (i - 1) * S;
      if (F[o + FR.time] - F[p + FR.time] > 0.5) {
        // pit: zaman sıçraması → türev anlamsız
        longRaw[i] = longRaw[i - 1];
        latRaw[i] = latRaw[i - 1];
      } else {
        const dv = v - F[p + FR.spd];
        longRaw[i] = (dv * TICK_RATE) / GRAVITY;
        const yawRate = wrap(F[o + 2] - F[p + 2]) * TICK_RATE;
        latRaw[i] = (v * yawRate) / GRAVITY;
      }
    }
  }
  T.latG = smooth(latRaw, 4);
  T.longG = smooth(longRaw, 4);
  for (let r = 0; r < 9; r++) {
    const a = new Float32Array(n);
    for (let i = 0; i < n; i++) a[i] = F[i * S + FR.rays + r];
    T.rays.push(a);
  }
  T.laps = rep.laps || 1;
  T.L = track.lengthMeters;
  T.hasElevation = !!track.hasElevation;
  T.label = opts.label || rep.label || null;
  T.status0 = rep.status;
  T.pits = findPits(T, rep.car?.pitLossSec ?? opts.pitLossSec ?? 21);
  // pit kaybı çıkarılmış zaman: tur/sektör süreleri simülasyondaki gibi pit kaybını içermez (pit ayrıca gösterilir)
  T.tnp = Float32Array.from(T.time);
  for (const p of T.pits) for (let i = p.i; i < n; i++) T.tnp[i] -= p.loss;
  T.analysis = lapAnalysis(T, track, T.laps);
  let best = null;
  for (const l of T.analysis) if (l.complete && (!best || l.time < best.time)) best = l;
  T.bestLap = best;
  T.summary = summarize(T, rep);
  return T;
}

function summarize(T, rep) {
  const n = T.n;
  let vmax = 0, full = 0, brake = 0, shifts = 0, latMax = 0, decelMax = 0, slipT = 0;
  let tMax = 0, betaMax = 0, drsT = 0, ersUse = 0, ersHarv = 0;
  for (let i = 0; i < n; i++) {
    vmax = Math.max(vmax, T.speed[i]);
    if (T.thr[i] > 0.95) full++;
    if (T.brake[i] > 0.05) brake++;
    if (i > 0 && T.gear[i] !== T.gear[i - 1]) shifts++;
    latMax = Math.max(latMax, Math.abs(T.latG[i]));
    decelMax = Math.max(decelMax, -T.longG[i]);
    if (T.slip[i] > 0.05) slipT++;
    tMax = Math.max(tMax, T.tyreT[i]);
    betaMax = Math.max(betaMax, Math.abs(T.beta[i]));
    if (T.drs[i]) drsT++;
    const e = (T.ersKW[i] * 1000) / TICK_RATE;
    if (e > 0) ersUse += e;
    else ersHarv -= e;
  }
  const dur = Math.max(0, T.time[n - 1] - T.time[0]);
  const dist = Math.max(0, T.dist[n - 1]);
  const lapTimes = T.analysis.map((l) => l.time);
  return {
    sonuc: rep.status === FINISHED ? 'Bitirdi' : rep.status === CRASHED ? 'Çarptı' : 'Bitiremedi',
    surS: rep.status === FINISHED ? rep.lapTicks / TICK_RATE : dur,
    mesafeM: dist,
    enYuksekHizKmh: vmax,
    ortalamaHizKmh: dur > 0 ? (dist / dur) * 3.6 : 0,
    tamGazYuzde: (full / n) * 100,
    frenYuzde: (brake / n) * 100,
    vitesDegisimi: shifts,
    maksYanalG: latMax,
    maksFrenG: decelMax,
    kaymaYuzde: (slipT / n) * 100,
    maksLastikSicakligiC: tMax,
    sonLastikAsinmaYuzde: T.wear[n - 1] * 100,
    kullanilanYakitKg: Math.max(0, T.fuel[0] - T.fuel[n - 1]),
    ersKullanimMJ: ersUse / 1e6,
    ersSarjMJ: ersHarv / 1e6,
    drsAcikS: drsT / TICK_RATE,
    maksKaymaAcisiDerece: betaMax,
    pitSayisi: T.pits.length,
    turSureleriS: lapTimes,
    enIyiTurS: T.bestLap ? T.bestLap.time : null,
  };
}

const compOf = (k) => COMPOUNDS[COMPOUND_IDS[k] || 'medium'];

// ---------- grafik satırları ----------
function driveRows(T, C, ex, names) {
  const rows = [];
  if (C) {
    rows.push({
      title: `Fark: ${names.focus} − ${C.trace.short || 'karşılaştırma'}`, unit: 'sn (+ yavaş)', delta: true, sym: true,
      series: [{ x: C.delta.x, n: C.delta.n, d: C.delta.y, c: '#e6edf3', name: 'Δ' }],
    });
  }
  const cs = (key, extra = {}) => (C && ex && C.trace['has' + key[0].toUpperCase() + key.slice(1)] !== false && ex[key]
    ? [{ x: ex.x, n: ex.n, d: ex[key], c: C.trace.color, name: C.trace.short || 'Karş.', dash: true, ...extra }]
    : []);
  rows.push({ title: 'Hız', unit: 'km/s', series: [{ d: T.speed, c: '#00d4ff', name: names.focus }, ...cs('speed')], min: 0 });
  rows.push({
    title: 'Gaz / Fren', unit: '%',
    series: [{ d: T.thr, c: '#3fb950', name: 'Gaz', k: 100 }, { d: T.brake, c: '#f85149', name: 'Fren', k: 100 },
      ...cs('thr', { k: 100, c: '#a5f3b4', name: 'Gaz (karş.)' }), ...cs('brake', { k: 100, c: '#ffb3ad', name: 'Fren (karş.)' })],
    min: 0, max: 100,
  });
  rows.push({ title: 'Vites', unit: '', series: [{ d: T.gear, c: '#e3b341', name: names.focus }, ...cs('gear')], min: 1, max: 8, step: true });
  rows.push({ title: 'Devir', unit: 'd/dk', series: [{ d: T.rpm, c: '#d2a8ff', name: 'Devir' }], min: 4000, max: 12500 });
  rows.push({ title: 'Direksiyon', unit: '', series: [{ d: T.steerCmd, c: 'rgba(200,200,200,0.45)', name: 'Komut' }, { d: T.steerPos, c: '#ffd166', name: 'Gerçek' }], min: -1, max: 1 });
  rows.push({ title: 'G kuvveti', unit: 'g', series: [{ d: T.latG, c: '#a371f7', name: 'Yanal' }, { d: T.longG, c: '#ff9f43', name: 'Boylamsal' }], sym: true });
  rows.push({ title: 'Kayma', unit: '%', series: [{ d: T.slip, c: '#ff6b6b', name: 'Kayma', k: 100 }], min: 0, max: 100 });
  if (T.hasElevation) rows.push({ title: 'Rakım', unit: 'm', series: [{ d: T.elev, c: '#7ee787', name: 'Rakım' }] });
  return rows;
}

function sysRows(T, C, ex) {
  const comps = [...new Set(Array.from(T.comp))];
  const refDrs = C && C.trace.drs ? expandDrs(C.trace, T) : null;
  return [
    {
      title: 'Lastik sıcaklığı', unit: '°C', series: [{ d: T.tyreT, c: '#ff7b72', name: 'Sıcaklık' }],
      refLines: comps.map((k) => ({ v: compOf(k).topt, c: compOf(k).color, label: `ideal ${compOf(k).short}` })),
    },
    { title: 'Lastik aşınması', unit: '%', series: [{ d: T.wear, c: '#e3b341', name: 'Aşınma', k: 100 }], min: 0 },
    { title: 'Yakıt', unit: 'kg', series: [{ d: T.fuel, c: '#79c0ff', name: 'Yakıt' }], min: 0 },
    { title: 'ERS batarya', unit: '%', series: [{ d: T.soc, c: '#3fb950', name: 'Şarj', k: 100 }], min: 0, max: 100 },
    { title: 'ERS güç', unit: 'kW (+ kullanım / − şarj)', series: [{ d: T.ersKW, c: '#d2a8ff', name: 'ERS' }], sym: true },
    {
      title: 'DRS', unit: 'açık', step: true, min: 0, max: 1.15,
      series: [{ d: T.drs, c: '#00e676', name: 'DRS' }, ...(refDrs ? [{ x: refDrs.x, n: refDrs.n, d: refDrs.d, c: C.trace.color, name: C.trace.short || 'Karş.', dash: true, k: 1.08 }] : [])],
    },
    { title: 'Kayma açısı β', unit: '°', series: [{ d: T.beta, c: '#ff6b6b', name: 'β' }], sym: true },
  ];
}

function expandDrs(tr, T) {
  if (!tr.periodic) return { x: tr.dist, d: tr.drs, n: tr.dist.length };
  const n = tr.dist.length, L = tr.lapLen;
  const reps = Math.max(1, Math.min(T.laps, Math.ceil(Math.max(T.dist[T.n - 1], 1) / L)));
  const x = new Float64Array(n * reps), d = new Float32Array(n * reps);
  for (let k = 0; k < reps; k++) for (let i = 0; i < n; i++) { x[k * n + i] = tr.dist[i] + k * L; d[k * n + i] = tr.drs[i]; }
  return { x, d, n: n * reps };
}

const TABS = [['drive', 'Sürüş'], ['sys', 'Sistemler'], ['sec', 'Sektörler']];

function stat(k, v) {
  return `<div><span>${k}</span><b>${v}</b></div>`;
}
const sgn = (v, d = 3) => (v == null || !isFinite(v) ? '–' : (v > 0 ? '+' : v < 0 ? '−' : '±') + Math.abs(v).toFixed(d));
const fmtS = (v) => (v == null || !isFinite(v) ? '–' : v < 60 ? v.toFixed(3) : fmtLap(v));
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export class TelemetryPanel {
  // opts: { onSeek(i), track, name, color, others: [{ T, name, color }], onTab }
  constructor(root, T, opts = {}) {
    this.T = T;
    this.onSeek = opts.onSeek || (() => {});
    this.track = opts.track || null;
    this.focusName = opts.name || 'Bu sürüş';
    this.focusColor = opts.color || '#00d4ff';
    this.others = opts.others || [];
    this.cmp = null;
    this.tab = 'drive';
    this.root = root;
    root.innerHTML = `
      <div class="tl-head"><b>Telemetri</b><span class="tl-who"></span>
        <div class="tl-tabs">${TABS.map(([k, l]) => `<button data-tab="${k}" class="${k === 'drive' ? 'on' : ''}">${l}</button>`).join('')}</div>
        <button class="tl-x" title="Kapat (T)">✕</button></div>
      <div class="tl-cmp" hidden></div>
      <div class="tl-sum"></div>
      <div class="tl-wrap"><canvas class="tl-base"></canvas><canvas class="tl-over"></canvas><div class="tl-tip" hidden></div></div>
      <div class="tl-sec" hidden></div>
      <div class="tl-foot">x ekseni: mesafe (m) · tıkla: o ana git</div>`;
    this.base = root.querySelector('.tl-base');
    this.over = root.querySelector('.tl-over');
    this.tip = root.querySelector('.tl-tip');
    this.wrapEl = root.querySelector('.tl-wrap');
    this.secEl = root.querySelector('.tl-sec');
    this.hoverX = null;
    root.querySelector('.tl-x').onclick = () => root.dispatchEvent(new CustomEvent('tl-close'));
    root.querySelector('.tl-tabs').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-tab]');
      if (b) this.setTab(b.dataset.tab);
    });
    this.over.addEventListener('mousemove', (e) => {
      const r = this.over.getBoundingClientRect();
      this.hoverX = e.clientX - r.left;
      this.hoverY = e.clientY - r.top;
    });
    this.over.addEventListener('mouseleave', () => {
      this.hoverX = null;
      this.tip.hidden = true;
    });
    this.over.addEventListener('click', (e) => {
      const r = this.over.getBoundingClientRect();
      const i = this._indexAt(e.clientX - r.left);
      if (i >= 0) this.onSeek(i);
    });
    this.secEl.addEventListener('click', (e) => {
      const c = e.target.closest('[data-d]');
      if (c) {
        const i = this._indexAtDist(+c.dataset.d);
        if (i >= 0) this.onSeek(i);
      }
    });
    this.layoutKey = '';
    this._refresh();
  }

  // ----- dış API -----
  setFocus(T, name, color) {
    this.T = T;
    if (name) this.focusName = name;
    if (color) this.focusColor = color;
    if (this.cmp) this.cmp = { ...this.cmp, delta: this.cmp.deltaFn ? this.cmp.deltaFn(T) : this.cmp.delta };
    this._refresh();
  }
  setOthers(list) {
    this.others = list || [];
    if (this.tab === 'sec') this._renderSectors();
  }
  // cmp: { trace, delta, deltaFn(T)? } ya da null
  setComparison(cmp) {
    this.cmp = cmp;
    this._refresh();
  }
  setTab(tab) {
    this.tab = tab;
    for (const b of this.root.querySelectorAll('.tl-tabs button')) b.classList.toggle('on', b.dataset.tab === tab);
    this._refresh();
  }

  _refresh() {
    const T = this.T, C = this.cmp;
    this._ex = C ? expandTrace(C.trace, T.laps, T.dist[T.n - 1]) : null;
    const names = { focus: this.focusName };
    this.rows = this.tab === 'sys' ? sysRows(T, C, this._ex) : driveRows(T, C, this._ex, names);
    this.root.querySelector('.tl-who').innerHTML = `<i style="background:${this.focusColor}"></i>${esc(this.focusName)}`;
    // karşılaştırma şeridi
    const cEl = this.root.querySelector('.tl-cmp');
    if (C) {
      const lastD = C.delta.n ? lastFinite(C.delta.y) : null;
      cEl.hidden = false;
      cEl.innerHTML = `<i style="background:${C.trace.color}"></i><span>${esc(C.trace.label)}</span>` +
        `${C.trace.lapTime ? `<b>${fmtLap(C.trace.lapTime)}</b>` : ''}` +
        `${lastD != null ? `<em class="${lastD > 0 ? 'slow' : 'fast'}">Δ ${sgn(lastD, 2)} sn</em>` : ''}`;
    } else cEl.hidden = true;
    // özet
    const s = T.summary;
    const sum = this.root.querySelector('.tl-sum');
    if (this.tab === 'sys') {
      sum.innerHTML =
        stat('Maks lastik sıc.', s.maksLastikSicakligiC.toFixed(0) + ' °C') + stat('Son aşınma', '%' + s.sonLastikAsinmaYuzde.toFixed(1)) +
        stat('Yakıt kullanımı', s.kullanilanYakitKg.toFixed(2) + ' kg') + stat('ERS kullanım', s.ersKullanimMJ.toFixed(2) + ' MJ') +
        stat('ERS şarj', s.ersSarjMJ.toFixed(2) + ' MJ') + stat('DRS açık', s.drsAcikS.toFixed(1) + ' sn') +
        stat('Maks β', s.maksKaymaAcisiDerece.toFixed(1) + '°') + stat('Pit', s.pitSayisi);
    } else {
      sum.innerHTML =
        stat('Süre', fmtLap(s.surS)) + stat('En yüksek hız', s.enYuksekHizKmh.toFixed(0) + ' km/s') +
        stat('Ort. hız', s.ortalamaHizKmh.toFixed(0) + ' km/s') + stat('Tam gaz', '%' + s.tamGazYuzde.toFixed(0)) +
        stat('Frende', '%' + s.frenYuzde.toFixed(0)) + stat(T.laps > 1 ? 'En iyi tur' : 'Vites değişimi', T.laps > 1 ? fmtLap(s.enIyiTurS) : s.vitesDegisimi) +
        stat('Maks yanal', s.maksYanalG.toFixed(1) + ' g') + stat('Maks fren', s.maksFrenG.toFixed(1) + ' g');
    }
    const secTab = this.tab === 'sec';
    this.wrapEl.hidden = secTab;
    this.secEl.hidden = !secTab;
    this.root.querySelector('.tl-foot').hidden = secTab;
    sum.hidden = secTab;
    if (secTab) this._renderSectors();
    this.layoutKey = '';
    if (!this.root.hidden && !secTab) this.draw(this._lastI || 0);
  }

  // ----- sektör tablosu -----
  sectorRows() {
    const T = this.T, track = this.track;
    const rows = [];
    const add = (owner, name, color, laps, focus = false) => {
      for (const l of laps) {
        rows.push({ owner, name: laps.length > 1 || T.laps > 1 ? `${name} · Tur ${l.lap}` : name, color, lap: l.lap, focus, ...l, sectors: l.sectors.slice(), minis: l.minis.slice() });
      }
    };
    add('F', this.focusName, this.focusColor, T.analysis, true);
    for (const [k, o] of this.others.entries()) if (o.T !== T) add('O' + k, o.name, o.color, o.T.analysis);
    if (this.cmp && track) {
      const tr = this.cmp.trace;
      const laps = tr.periodic ? traceLapRows(tr, track) : tr.T ? tr.T.analysis : [];
      add('C', tr.label, tr.color, laps);
    }
    return classifyRows(rows);
  }

  _renderSectors() {
    if (!this.track) {
      this.secEl.innerHTML = '<p class="tl-note">Sektör bilgisi yok.</p>';
      return;
    }
    const rows = this.sectorRows();
    const T = this.T, L = this.track.lengthMeters, NM = this.track.miniSectors || 24;
    const bestT = Math.min(...rows.map((r) => (r.time != null ? r.time : Infinity)));
    const sw = (c) => `<i class="sw" style="background:${c}"></i>`;
    const cell = (v, cls, dAttr = '') => `<td class="${cls || ''}"${dAttr}>${fmtS(v)}</td>`;
    const sf = this.track.sectorFrac;
    let h = `<h4>Sektör süreleri <small>pist ${(L / 1000).toFixed(3)} km · S1 ${(sf[0] * L).toFixed(0)} m · S2 ${(sf[1] * L).toFixed(0)} m</small></h4>
      <table class="tl-st"><thead><tr><th></th><th>S1</th><th>S2</th><th>S3</th><th>Tur</th><th>Δ</th></tr></thead><tbody>`;
    for (const r of rows) {
      const d0 = (r.lap - 1) * L;
      const da = (f) => (r.focus ? ` data-d="${(d0 + f * L).toFixed(1)}"` : '');
      h += `<tr class="${r.focus ? 'focus' : ''}"><th${da(0)}>${sw(r.color)}${esc(r.name)}${r.complete ? '' : ' <small>(yarım)</small>'}</th>` +
        cell(r.sectors[0], r.cls.sectors[0], da(0)) + cell(r.sectors[1], r.cls.sectors[1], da(sf[0])) + cell(r.sectors[2], r.cls.sectors[2], da(sf[1])) +
        cell(r.time, r.cls.time) + `<td class="dl">${r.time != null && isFinite(bestT) ? (r.time - bestT < 1e-6 ? '—' : sgn(r.time - bestT)) : ''}</td></tr>`;
    }
    h += '</tbody></table>';
    h += `<h4>Mini sektörler <small>${NM} eşit parça · her biri ${(L / NM).toFixed(0)} m</small></h4><div class="tl-ms">`;
    for (const r of rows) {
      const d0 = (r.lap - 1) * L;
      h += `<div class="ms-row${r.focus ? ' focus' : ''}"><span>${sw(r.color)}${esc(r.name)}</span><div class="ms-cells">`;
      for (let m = 0; m < NM; m++) {
        const v = r.minis[m];
        h += `<i class="${r.cls.minis[m] || 'na'}" title="Mini sektör ${m + 1}: ${fmtS(v)} sn"${r.focus ? ` data-d="${(d0 + (m / NM) * L).toFixed(1)}"` : ''}></i>`;
      }
      h += '</div></div>';
    }
    h += '</div>';
    if (T.laps > 1) {
      const best = T.bestLap;
      h += `<h4>Turlar <small>en iyi ve son tur karşılaştırması</small></h4><table class="tl-st tl-laps"><thead><tr><th>Tur</th><th>Süre</th><th>Δ en iyi</th><th>Lastik</th><th>Pit</th></tr></thead><tbody>`;
      for (const l of T.analysis) {
        const i0 = this._indexAtDist((l.lap - 1) * L + 1);
        const c = compOf(T.comp[Math.max(0, i0)]);
        const pit = T.pits.find((p) => p.lap === l.lap);
        h += `<tr class="${best && l.lap === best.lap ? 'best' : ''}"><th data-d="${((l.lap - 1) * L).toFixed(1)}">Tur ${l.lap}</th><td>${fmtS(l.time)}</td>` +
          `<td>${best && l.time != null ? (l.lap === best.lap ? 'en iyi' : sgn(l.time - best.time)) : '–'}</td>` +
          `<td><b class="cmp-badge" style="--c:${c.color}">${c.short}</b></td><td>${pit ? `+${pit.loss.toFixed(1)} sn → ${compOf(pit.compTo).short}` : ''}</td></tr>`;
      }
      h += '</tbody></table>';
      const last = [...T.analysis].reverse().find((l) => l.complete);
      if (best && last && last.lap !== best.lap) {
        h += `<p class="tl-note">Son tam tur (Tur ${last.lap}) en iyi turdan (Tur ${best.lap}) ${sgn(last.time - best.time)} sn farklı. ` +
          `Sektörler: ${last.sectors.map((s, j) => `S${j + 1} ${sgn(s - best.sectors[j])}`).join(' · ')}. ` +
          'Karşılaştırma listesinden "Kendi en iyi turu"nu seçerek tur tur delta grafiğini görebilirsin.</p>';
      }
    }
    h += '<p class="tl-legend"><i class="p"></i> en hızlı (mor) <i class="g"></i> kendi en iyisi (yeşil) <i class="y"></i> daha yavaş (sarı)</p>';
    this.secEl.innerHTML = h;
  }

  // ----- grafikler -----
  _layout() {
    const wrapEl = this.wrapEl;
    // satır başına en az 44 px; sığmazsa alan kaydırılır
    const w = wrapEl.clientWidth, h = Math.max(wrapEl.clientHeight, this.rows.length * 44 + 18);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const key = `${w}x${h}@${dpr}#${this.rows.length}`;
    if (key === this.layoutKey) return false;
    this.layoutKey = key;
    for (const c of [this.base, this.over]) {
      c.width = Math.max(1, Math.round(w * dpr));
      c.height = Math.max(1, Math.round(h * dpr));
      c.style.width = w + 'px';
      c.style.height = h + 'px';
    }
    this.W = w;
    this.H = h;
    this.dpr = dpr;
    this.padL = 46;
    this.padR = 8;
    this.rowH = (h - 18) / this.rows.length;
    this._axis();
    return true;
  }

  _axis() {
    const d = this.T.dist;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < this.T.n; i++) {
      if (d[i] < lo) lo = d[i];
      if (d[i] > hi) hi = d[i];
    }
    this.dLo = Math.min(0, lo);
    this.dHi = Math.max(hi, this.dLo + 1);
  }

  _xOf(dist) {
    return this.padL + ((dist - this.dLo) / (this.dHi - this.dLo)) * (this.W - this.padL - this.padR);
  }

  _indexAtDist(dist) {
    const T = this.T;
    let best = -1, bd = Infinity;
    for (let i = 0; i < T.n; i++) {
      const dd = Math.abs(T.dist[i] - dist);
      if (dd < bd) { bd = dd; best = i; }
    }
    return best;
  }

  _indexAt(px) {
    return this._indexAtDist(this.dLo + ((px - this.padL) / (this.W - this.padL - this.padR)) * (this.dHi - this.dLo));
  }

  _drawBase(ctx, W, H, rows, rowH, padL, padR) {
    const T = this.T;
    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, W, H);
    ctx.font = '10px system-ui, sans-serif';
    const plotW = Math.max(1, Math.floor(W - padL - padR));
    rows.forEach((row, ri) => {
      const y0 = ri * rowH, h = rowH - 6;
      // ölçek
      let lo = row.min, hi = row.max;
      if (lo == null || hi == null) {
        let a = Infinity, b = -Infinity;
        for (const s of row.series) {
          const n = s.n ?? T.n;
          for (let i = 0; i < n; i++) {
            const x = s.x ? s.x[i] : T.dist[i];
            if (x < this.dLo || x > this.dHi) continue;
            const v = s.d[i] * (s.k || 1);
            if (!isFinite(v)) continue;
            if (v < a) a = v;
            if (v > b) b = v;
          }
        }
        for (const r of row.refLines || []) { a = Math.min(a, r.v); b = Math.max(b, r.v); }
        if (!isFinite(a)) { a = 0; b = 1; }
        if (row.sym) { const m = Math.max(Math.abs(a), Math.abs(b), row.delta ? 0.05 : 0.5); a = -m; b = m; }
        if (lo == null) lo = a;
        if (hi == null) hi = b;
      }
      if (hi - lo < 1e-6) hi = lo + 1;
      row._lo = lo; row._hi = hi; row._y0 = y0; row._h = h;
      const Y = (v) => y0 + 2 + h - ((Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo)) * h;
      ctx.fillStyle = row.delta ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.03)';
      ctx.fillRect(padL, y0 + 2, W - padL - padR, h);
      if (row.sym || (lo < 0 && hi > 0)) {
        ctx.strokeStyle = 'rgba(255,255,255,0.14)';
        ctx.beginPath(); ctx.moveTo(padL, Y(0)); ctx.lineTo(W - padR, Y(0)); ctx.stroke();
      }
      (row.refLines || []).forEach((r, ri) => {
        ctx.strokeStyle = r.c;
        ctx.globalAlpha = 0.55;
        ctx.setLineDash([2, 3]);
        ctx.beginPath(); ctx.moveTo(padL, Y(r.v)); ctx.lineTo(W - padR, Y(r.v)); ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
        ctx.fillStyle = r.c;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'bottom';
        ctx.fillText(r.label, W - padR - 2 - ri * 52, Y(r.v) - 1);
      });
      ctx.fillStyle = '#c9d1d9';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      const ttl = row.title + (row.unit ? ` (${row.unit})` : '');
      ctx.fillText(ttl, padL + 4, y0 + 4);
      let lx = padL + 4 + ctx.measureText(ttl).width + 10;
      if (row.series.length > 1) for (const s of row.series) {
        ctx.fillStyle = s.c;
        ctx.fillRect(lx, y0 + 7, 8, 3);
        ctx.fillStyle = '#8b949e';
        ctx.fillText(s.name, lx + 11, y0 + 4);
        lx += 16 + ctx.measureText(s.name).width;
      }
      ctx.fillStyle = '#6e7681';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      const f = (v) => (Math.abs(v) >= 1000 ? (v / 1000).toFixed(1) + 'k' : Math.abs(v) < 10 && v % 1 ? v.toFixed(Math.abs(v) < 1 ? 2 : 1) : v.toFixed(0));
      ctx.fillText(f(hi), padL - 4, y0 + 7);
      ctx.fillText(f(lo), padL - 4, y0 + h - 2);
      // veriler: piksel başına min/maks zarfı (sivri değerler kaybolmaz)
      for (const s of row.series) {
        const mn = new Float32Array(plotW).fill(Infinity), mx = new Float32Array(plotW).fill(-Infinity);
        const n = s.n ?? T.n;
        for (let i = 0; i < n; i++) {
          const x = s.x ? s.x[i] : T.dist[i];
          const px = Math.floor(this._xOf(x) - padL);
          if (px < 0 || px >= plotW) continue;
          const v = s.d[i] * (s.k || 1);
          if (!isFinite(v)) continue;
          if (v < mn[px]) mn[px] = v;
          if (v > mx[px]) mx[px] = v;
        }
        if (row.delta) this._fillDelta(ctx, mn, mx, Y, padL, plotW, y0 + 2, h);
        ctx.strokeStyle = s.c;
        ctx.lineWidth = s.dash ? 1.2 : 1.4;
        ctx.setLineDash(s.dash ? [4, 3] : []);
        ctx.beginPath();
        let started = false, prevY = 0, gap = 0;
        for (let x = 0; x < plotW; x++) {
          if (mn[x] === Infinity) { gap++; continue; }
          const a = Y(mx[x]), b = Y(mn[x]);
          if (!started || gap > 6) { ctx.moveTo(padL + x, a); started = true; }
          else if (row.step) { ctx.lineTo(padL + x, prevY); ctx.lineTo(padL + x, a); }
          else ctx.lineTo(padL + x, a);
          if (b - a > 1) ctx.lineTo(padL + x, b);
          prevY = b;
          gap = 0;
        }
        ctx.stroke();
        ctx.setLineDash([]);
      }
    });
    // tur ve sektör sınırları
    if (this.track) {
      const L = this.track.lengthMeters, sf = this.track.sectorFrac;
      ctx.font = '9px system-ui, sans-serif';
      for (let k = 0; k < this.T.laps; k++) {
        for (let j = 0; j < 3; j++) {
          const d = k * L + (j === 0 ? 0 : sf[j - 1] * L);
          if (d < this.dLo || d > this.dHi) continue;
          const x = this._xOf(d);
          ctx.strokeStyle = j === 0 ? 'rgba(255,255,255,0.28)' : 'rgba(255,209,102,0.22)';
          ctx.setLineDash(j === 0 ? [] : [3, 4]);
          ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H - 14); ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = j === 0 ? 'rgba(255,255,255,0.55)' : 'rgba(255,209,102,0.6)';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'bottom';
          ctx.fillText(j === 0 ? (this.T.laps > 1 ? `T${k + 1}` : 'S1') : `S${j + 1}`, x + 2, H - 14);
        }
      }
    }
    // mesafe ekseni
    ctx.font = '10px system-ui, sans-serif';
    ctx.fillStyle = '#6e7681';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    const span = this.dHi - this.dLo;
    const step = span > 12000 ? 2000 : span > 4000 ? 1000 : span > 1500 ? 500 : span > 600 ? 200 : 100;
    for (let d = Math.ceil(this.dLo / step) * step; d <= this.dHi; d += step) {
      const x = this._xOf(d);
      ctx.fillText(d >= 1000 ? (d / 1000).toFixed(1) + ' km' : d + ' m', x, H - 3);
      ctx.strokeStyle = 'rgba(255,255,255,0.05)';
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H - 14); ctx.stroke();
    }
  }

  // Delta alanı: sıfırın üstü (odak daha yavaş) kırmızı, altı (daha hızlı) yeşil
  _fillDelta(ctx, mn, mx, Y, padL, plotW, top, h) {
    const yz = Y(0);
    for (const [clipTop, clipH, col] of [[top, yz - top, 'rgba(248,81,73,0.32)'], [yz, top + h - yz, 'rgba(63,185,80,0.32)']]) {
      if (clipH <= 0) continue;
      ctx.save();
      ctx.beginPath();
      ctx.rect(padL, clipTop, plotW, clipH);
      ctx.clip();
      ctx.fillStyle = col;
      ctx.beginPath();
      let open = false, lastX = 0;
      for (let x = 0; x < plotW; x++) {
        if (mn[x] === Infinity) continue;
        const y = Y((mn[x] + mx[x]) / 2);
        if (!open) { ctx.moveTo(padL + x, yz); open = true; }
        ctx.lineTo(padL + x, y);
        lastX = x;
      }
      if (open) {
        ctx.lineTo(padL + lastX, yz);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    }
  }

  _valueAt(row, s, cur, dCur) {
    if (!s.x) return s.d[cur] * (s.k || 1);
    if (row.step) {
      // basamak: en yakın önceki örnek
      let lo = 0, hi = (s.n ?? s.x.length) - 1;
      if (!(dCur >= s.x[0]) || !(dCur <= s.x[hi])) return NaN;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (s.x[m] <= dCur) lo = m; else hi = m; }
      return s.d[lo] * (s.k || 1);
    }
    return interp(s.x, s.d, dCur) * (s.k || 1);
  }

  draw(i) {
    this._lastI = i;
    if (this.root.hidden || this.tab === 'sec') return;
    if (this._layout()) {
      const ctx = this.base.getContext('2d');
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      this._drawBase(ctx, this.W, this.H, this.rows, this.rowH, this.padL, this.padR);
    }
    const ctx = this.over.getContext('2d');
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.W, this.H);
    const T = this.T;
    const cur = Math.max(0, Math.min(T.n - 1, Math.round(i)));
    const dCur = T.dist[cur];
    const x = this._xOf(dCur);
    ctx.strokeStyle = '#ff4081';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, this.H - 14); ctx.stroke();
    // mevcut değer noktaları
    for (const row of this.rows) {
      for (const s of row.series) {
        const v = this._valueAt(row, s, cur, dCur);
        if (!isFinite(v)) continue;
        const y = row._y0 + 2 + row._h - ((Math.max(row._lo, Math.min(row._hi, v)) - row._lo) / (row._hi - row._lo)) * row._h;
        ctx.fillStyle = s.c;
        ctx.beginPath(); ctx.arc(x, y, s.dash ? 2.5 : 3, 0, Math.PI * 2); ctx.fill();
        if (row.delta) {
          ctx.font = 'bold 11px system-ui, sans-serif';
          ctx.fillStyle = v > 0 ? '#ff7b72' : '#7ee787';
          ctx.textAlign = x > this.W - 70 ? 'right' : 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(`${sgn(v)} sn`, x + (x > this.W - 70 ? -6 : 6), Math.max(row._y0 + 12, Math.min(row._y0 + row._h - 6, y)));
        }
      }
    }
    // üzerine gelince değerler
    if (this.hoverX != null && this.hoverX >= this.padL) {
      const hi = this._indexAt(this.hoverX);
      if (hi >= 0) {
        const hx = this._xOf(T.dist[hi]);
        ctx.strokeStyle = 'rgba(255,255,255,0.45)';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(hx, 0); ctx.lineTo(hx, this.H - 14); ctx.stroke();
        const lines = this._tipLines(hi);
        this.tip.innerHTML = lines.join('<br>');
        this.tip.hidden = false;
        const tw = 240;
        this.tip.style.left = Math.min(this.W - tw - 4, hx + 10) + 'px';
        this.tip.style.top = Math.max(0, Math.min(this.H - 22 * lines.length, (this.hoverY || 0) - 40)) + 'px';
      }
    }
  }

  _tipLines(hi) {
    const T = this.T, C = this.cmp, d = T.dist[hi];
    const lines = [`${d.toFixed(0)} m · ${fmtLap(T.t[hi])}${T.laps > 1 ? ` · Tur ${Math.min(T.laps, T.lap[hi] + 1)}` : ''}`];
    if (this.tab === 'sys') {
      const c = compOf(T.comp[hi]);
      lines.push(
        `Lastik ${T.tyreT[hi].toFixed(0)} °C (${c.short}, ideal ${c.topt}) · aşınma %${(T.wear[hi] * 100).toFixed(1)}`,
        `Yakıt ${T.fuel[hi].toFixed(2)} kg · ERS %${(T.soc[hi] * 100).toFixed(0)} · ${T.ersKW[hi] >= 0 ? '+' : ''}${T.ersKW[hi].toFixed(0)} kW`,
        `DRS ${T.drs[hi] ? 'AÇIK' : 'kapalı'} · β ${T.beta[hi].toFixed(1)}°`,
      );
    } else {
      lines.push(
        `Hız ${T.speed[hi].toFixed(0)} km/s · V${T.gear[hi]} · ${Math.round(T.rpm[hi] / 100) * 100} d/dk`,
        `Gaz %${(T.thr[hi] * 100).toFixed(0)} · Fren %${(T.brake[hi] * 100).toFixed(0)}`,
        `Direksiyon ${T.steerPos[hi].toFixed(2)} · Kayma %${(T.slip[hi] * 100).toFixed(0)}`,
        `Yanal ${T.latG[hi].toFixed(2)} g · Boylamsal ${T.longG[hi].toFixed(2)} g`,
      );
      if (T.hasElevation) lines.push(`Rakım ${T.elev[hi].toFixed(1)} m`);
    }
    if (C) {
      const tr = C.trace;
      const v = traceValueAt(tr, 'speed', d), th = traceValueAt(tr, 'thr', d), br = traceValueAt(tr, 'brake', d), g = traceValueAt(tr, 'gear', d);
      const dl = interp(C.delta.x, C.delta.y, d);
      lines.push(`<span style="color:${tr.color}">${esc(tr.short || 'Karş.')}: ${isFinite(v) ? v.toFixed(0) + ' km/s' : '–'}${isFinite(g) && g > 0 ? ' · V' + g : ''}` +
        `${isFinite(th) ? ' · Gaz %' + (th * 100).toFixed(0) : ''}${isFinite(br) ? ' · Fren %' + (br * 100).toFixed(0) : ''}</span>`);
      if (isFinite(dl)) lines.push(`<b style="color:${dl > 0 ? '#ff7b72' : '#7ee787'}">Δ ${sgn(dl)} sn</b>`);
    }
    return lines;
  }

  // Başlık + özet + tüm grafiklerin (sürüş + sistemler) tek bir PNG'si
  toPNG(title) {
    const T = this.T;
    const rows = [...driveRows(T, this.cmp, this.cmp ? expandTrace(this.cmp.trace, T.laps, T.dist[T.n - 1]) : null, { focus: this.focusName }), ...sysRows(T, this.cmp, null)];
    const W = 1600, rowH = 110;
    const headH = 128, H = headH + rows.length * rowH + 24;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#0d1117';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#e6edf3';
    ctx.font = 'bold 22px system-ui, sans-serif';
    ctx.fillText(title, 20, 34);
    const s = T.summary;
    ctx.font = '15px system-ui, sans-serif';
    ctx.fillStyle = '#8b949e';
    ctx.fillText(`${s.sonuc} · Süre ${fmtLap(s.surS)} · En yüksek ${s.enYuksekHizKmh.toFixed(0)} km/s · Ortalama ${s.ortalamaHizKmh.toFixed(0)} km/s · Tam gaz %${s.tamGazYuzde.toFixed(0)} · Fren %${s.frenYuzde.toFixed(0)}`, 20, 62);
    ctx.fillText(`Vites değişimi ${s.vitesDegisimi} · Maks yanal ${s.maksYanalG.toFixed(2)} g · Maks fren ${s.maksFrenG.toFixed(2)} g · Kayma %${s.kaymaYuzde.toFixed(0)} · Mesafe ${s.mesafeM.toFixed(0)} m · Maks lastik ${s.maksLastikSicakligiC.toFixed(0)} °C · Yakıt ${s.kullanilanYakitKg.toFixed(2)} kg · ERS ${s.ersKullanimMJ.toFixed(2)} MJ`, 20, 84);
    const secTxt = T.analysis.map((l) => `Tur ${l.lap}: ${l.sectors.map((v, j) => `S${j + 1} ${fmtS(v)}`).join(' · ')} · ${fmtS(l.time)}`).join('   |   ');
    ctx.fillText(secTxt + (this.cmp ? `   ‖   Karşılaştırma: ${this.cmp.trace.label}` : ''), 20, 106);
    if (this.dLo == null) this._axis();
    ctx.save();
    ctx.translate(0, headH);
    const saved = [this.W, this.padL, this.padR];
    this.W = W;
    this.padL = 60;
    this.padR = 20;
    this._drawBase(ctx, W, rows.length * rowH + 24, rows, rowH, this.padL, this.padR);
    [this.W, this.padL, this.padR] = saved;
    ctx.restore();
    this.layoutKey = '';
    return c.toDataURL('image/png');
  }
}

function lastFinite(a) {
  for (let i = a.length - 1; i >= 0; i--) if (isFinite(a[i])) return a[i];
  return null;
}
