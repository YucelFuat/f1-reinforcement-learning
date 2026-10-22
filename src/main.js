// Uygulama: arayüz, ana döngü, kamera etkileşimi, kayıt/yükleme.

import { defaultConfig, TICK_RATE, OBS_SIZE, physicsPreset, physicsSummary, autoTimeLimit, fmtLap, COMPOUNDS, COMPOUND_IDS } from './config.js';
import { TRACK_DEFS, Track, randomTrackDef } from './track.js';
import { Trainer } from './trainer.js';
import { ParallelTrainer } from './parallel/ptrainer.js';
import { upgradeBrain } from './brain.js';
import { ALGOS } from './algos/index.js';
import { AutoTuner } from './autotune.js';
import { Renderer } from './render.js';
import { LineChart } from './charts.js';
import { NNViz } from './nnviz.js';
import { DevStats } from './devstats.js';
import { RUNNING, FINISHED, CRASHED } from './sim.js';
import { saveSession, loadSession, loadSessionInfo, clearSession, snapshotTrainer, restoreTrainer, applyConfig, showResumeBanner, hasIndexedDB } from './persist.js';
import { openExperimentManager } from './experiments-ui.js';
import { initPWA } from './pwa.js';

const $ = (id) => document.getElementById(id);
const cfg = defaultConfig();

// ---------- güvenli localStorage ----------
const store = {
  get(k, d = null) {
    try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; }
  },
  set(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; }
  },
};

// ---------- pistler ----------
let customTracks = store.get('rlrace.customTracks', []);
let randomDef = null;
function allTrackDefs() {
  const list = [...TRACK_DEFS, ...customTracks];
  if (randomDef) list.push(randomDef);
  return list;
}
function fillTrackSelect(selectId) {
  const sel = $('selTrack');
  sel.innerHTML = '';
  for (const d of allTrackDefs()) {
    const o = document.createElement('option');
    o.value = d.id;
    o.textContent = d.name;
    sel.appendChild(o);
  }
  if (selectId) sel.value = selectId;
}

// ---------- durum ----------
let trackDef = TRACK_DEFS[1];
let track = new Track(trackDef);
let trainer = null;
let running = true;
let speed = 1;
let renderOn = true;
let editing = false;
let acc = 0;
let wallSec = 0; // bu eğitimin gerçek (duvar saati) süresi, sn
const view = { follow: false, rays: true, heatmap: true, ghost: true, showDead: true, nn: true, selected: 0, autoSelect: true };

const renderer = new Renderer($('view'));
renderer.setTrack(track);
const devstats = new DevStats($('dev'));
const nnviz = new NNViz($('nnCanvas'));
const chartFit = new LineChart($('chartFit'), {
  series: [
    { key: 'best', label: 'En iyi', color: '#3987e5' },
    { key: 'avg', label: 'Ortalama', color: '#d95926' },
  ],
  yFormat: (v) => (Math.abs(v) >= 1000 ? (v / 1000).toFixed(1) + 'k' : v.toFixed(0)),
});
const chartFin = new LineChart($('chartFin'), {
  series: [
    { label: 'Bitiren', color: '#199e70', get: (h) => h.finishRate * 100 },
    { label: 'Ort. ilerleme', color: '#9085e9', get: (h) => Math.min(100, h.avgProgress * 100) },
  ],
  yFormat: (v) => v.toFixed(0) + '%',
  minY: 0,
  maxY: 100,
});
const idealOf = (h) => (h.sectors && h.sectors[0] && h.sectors[1] && h.sectors[2] ? h.sectors[0] + h.sectors[1] + h.sectors[2] : null);
const chartLap = new LineChart($('chartLap'), {
  series: [
    { key: 'bestLap', label: 'En iyi tur', color: '#c98500' },
    { label: 'İdeal (en iyi sektörler)', color: '#a371f7', get: idealOf },
  ],
  yFormat: (v) => v.toFixed(1) + 's',
});
let chartsDirty = true;
let lastChartDraw = 0;

// otomatik ayarlayıcı
const tuner = new AutoTuner(cfg);
let autoUiDirty = true;
tuner.onChange = (knob) => {
  // değişen kaydırıcıları yenile ve kısa süre vurgula
  if (knob.key.startsWith('reward.')) buildReward();
  else if ($('selAlgo').value === trainer.algo.name) buildAlgo();
  autoUiDirty = true;
  const sec = knob.key.startsWith('reward.') ? $('rewardBox') : $('algoBox');
  sec.classList.remove('flash');
  void sec.offsetWidth;
  sec.classList.add('flash');
};

// ---------- çok çekirdekli simülasyon (GA / ES / CMA-ES) ----------
// Tercih "Uygula ve yeniden başlat" ile geçerli olur. PPO / SAC her zaman tek çekirdekte (öğrenmeleri zaten ayrı işçide).
const multiChk = (() => {
  const el = $('chkMulti');
  const ok = ParallelTrainer.supported('ga');
  el.checked = ok && store.get('rlrace.multicore', true);
  el.disabled = !ok;
  el.parentElement.title = ok
    ? `GA / ES / CMA-ES araçları ${ParallelTrainer.defaultWorkers(1000)} işlemci çekirdeğine bölünür (PPO / SAC etkilenmez).`
    : 'Kullanılamıyor: sayfa node server.js ile (COOP/COEP başlıkları) açılmalı ve işlemcide 2+ çekirdek olmalı.';
  el.onchange = () => store.set('rlrace.multicore', el.checked);
  return el;
})();
function trainerLabel() {
  const w = trainer.workerCount ? ` · ${trainer.workerCount} çekirdek` : '';
  const race = cfg.rules.mode === 'race' ? ` · yarış (${trainer.sim.H}'li seriler)` : '';
  return trainer.algo.label + ` · ${trainer.sim.N} araç · ${track.name}${w}${race}`;
}

// ---------- tohum (seed): aynı tohum + aynı ayarlar = aynı eğitim ----------
const randomSeed = () => (Math.random() * 2 ** 31) >>> 0;
function seedFromInput() {
  const v = parseInt($('inpSeed').value, 10);
  return Number.isFinite(v) && v >= 0 ? v >>> 0 : randomSeed();
}

function newTrainer(seed) {
  if (seed == null) seed = seedFromInput();
  if (trainer) trainer.dispose();
  const algo = $('selAlgo').value;
  const cars = +$('selCars').value;
  const opts = { cfg, track, algo, carCount: cars, useWorker: true, seed };
  trainer = multiChk.checked && ParallelTrainer.supported(algo) ? new ParallelTrainer(opts) : new Trainer(opts);
  trainer.seed = seed; // deney kaydı / tekrar üretim için
  $('inpSeed').value = seed;
  wallSec = 0;
  trainer.on('generation', (entry) => {
    chartsDirty = true;
    view.autoSelect = true;
    tuner.onGeneration(trainer, entry);
    autoUiDirty = true;
  });
  tuner.reset();
  autoUiDirty = true;
  view.selected = 0;
  view.autoSelect = true;
  acc = 0;
  $('algoLabel').textContent = trainerLabel();
  $('btnEndGen').disabled = !trainer.isPopulation;
  chartsDirty = true;
}

// ---------- kaydırıcı oluşturucu ----------
function slider(box, { label, obj, key, min, max, step, fmt = (v) => v, restart = false, help = '', onInput }) {
  const wrap = document.createElement('div');
  wrap.className = 'slider';
  const val = obj[key];
  wrap.innerHTML = `<div class="sl-top"><span>${label}${restart ? '<span class="restart" title="Yeniden başlatma gerekir">↻</span>' : ''}</span><b>${fmt(val)}</b></div>
    <input type="range" min="${min}" max="${max}" step="${step}" value="${val}">${help ? `<small>${help}</small>` : ''}`;
  const input = wrap.querySelector('input');
  const out = wrap.querySelector('b');
  input.addEventListener('input', () => {
    obj[key] = parseFloat(input.value);
    out.textContent = fmt(obj[key]);
    if (onInput) onInput(obj[key]);
  });
  box.appendChild(wrap);
  return wrap;
}
function select(box, { label, obj, key, options, help = '', onChange }) {
  const l = document.createElement('label');
  l.className = 'sel-row';
  l.innerHTML = `${label}<select>${options.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}</select>${help ? `<small>${help}</small>` : ''}`;
  const sel = l.querySelector('select');
  sel.value = String(obj[key]);
  sel.addEventListener('change', () => {
    obj[key] = sel.value;
    if (onChange) onChange(sel.value);
  });
  box.appendChild(l);
  return l;
}
function note(box, html, cls = 'hint') {
  const p = document.createElement('p');
  p.className = cls;
  p.innerHTML = html;
  box.appendChild(p);
  return p;
}
function checkbox(box, { label, obj, key, onChange }) {
  const l = document.createElement('label');
  l.className = 'checks';
  l.style.display = 'flex';
  l.style.gap = '7px';
  l.style.color = 'var(--text)';
  l.innerHTML = `<input type="checkbox" ${obj[key] ? 'checked' : ''}> ${label}`;
  l.querySelector('input').addEventListener('change', (e) => {
    obj[key] = e.target.checked;
    if (onChange) onChange(obj[key]);
  });
  box.appendChild(l);
}
function hiddenInput(box, obj) {
  const wrap = document.createElement('div');
  wrap.className = 'slider txt';
  wrap.innerHTML = `<div class="sl-top"><span>Gizli katmanlar <span class="restart">↻</span></span></div><input type="text" value="${obj.hidden.join(', ')}"><small>Örn: 16, 12 veya 32, 32</small>`;
  const inp = wrap.querySelector('input');
  inp.addEventListener('change', () => {
    const arr = inp.value.split(/[ ,;]+/).map((s) => parseInt(s, 10)).filter((n) => n > 0 && n <= 256);
    if (arr.length) obj.hidden = arr.slice(0, 4);
    inp.value = obj.hidden.join(', ');
  });
  box.appendChild(wrap);
}

const f0 = (v) => (+v).toFixed(0);
const f2 = (v) => (+v).toFixed(2);
const f3 = (v) => (+v).toFixed(3);

function buildRules() {
  const b = $('rulesBox');
  b.innerHTML = '';
  const R = cfg.rules;
  slider(b, { label: 'Tur sayısı', obj: R, key: 'laps', min: 1, max: 5, step: 1, fmt: f0 });
  slider(b, { label: 'Süre limiti (sn/tur)', obj: R, key: 'timeLimitSec', min: 15, max: 400, step: 5, fmt: f0, help: `Pist seçilince otomatik ayarlanır (${track.lengthMeters ? (track.lengthMeters / 1000).toFixed(2) + ' km' : ''}).` });
  slider(b, { label: 'Çarpma hakkı', obj: R, key: 'maxCrashes', min: 1, max: 20, step: 1, fmt: f0, help: '1 = ilk çarpmada elenir. Daha fazlası: araç durur, cezayı alır ve devam eder.' });
  slider(b, { label: 'Takılma süresi (sn)', obj: R, key: 'stallSec', min: 1, max: 10, step: 0.5, fmt: (v) => (+v).toFixed(1) });
  slider(b, { label: 'Başlangıç rastgeleliği', obj: R, key: 'startJitter', min: 0, max: 1, step: 0.05, fmt: f2, help: 'Daha genel (ezber olmayan) sürüş için artır.' });
  select(b, {
    label: 'Başlangıç noktası', obj: R, key: 'spawn',
    options: [['start', 'Start çizgisi (duran kalkış)'], ['mixed', 'Karışık (yarı start, yarı rastgele)'], ['random', 'Pistte rastgele nokta (uçan başlangıç)']],
    help: 'Rastgele noktadan, o noktaya uygun hızla başlayan araçlar pistin her bölümünü eşit sıklıkta görür → zor virajlar daha hızlı öğrenilir. Tur rekorları yalnızca start çizgisinden yapılan sürüşlerden sayılır.',
  });
  const raceHolder = { on: R.mode === 'race' };
  checkbox(b, {
    label: 'Yarış modu: araçlar birbirine çarpabilir, sollama ödülü', obj: raceHolder, key: 'on',
    onChange: (v) => {
      R.mode = v ? 'race' : 'solo';
      applyRaceChange();
      buildRules();
      buildReward();
    },
  });
  if (R.mode === 'race') {
    slider(b, {
      label: 'Seri (heat) başına araç', obj: R, key: 'heatSize', min: 2, max: 12, step: 1, fmt: f0,
      help: 'Araçlar bu büyüklükte serilere ayrılır; her seri gridden birlikte kalkar ve yalnızca kendi içinde etkileşir. Işın sensörleri diğer araçları da görür.',
      onInput: () => applyRaceChange(),
    });
  }
}
let raceTimer = 0;
function applyRaceChange() {
  clearTimeout(raceTimer);
  raceTimer = setTimeout(() => {
    if (!trainer) return;
    trainer.rebuildSim();
    renderer.setTrack(track);
    $('algoLabel').textContent = trainerLabel();
  }, 250);
}

function buildReward() {
  const b = $('rewardBox');
  b.innerHTML = '';
  const R = cfg.reward;
  slider(b, { label: 'İlerleme ödülü (tur başına)', obj: R, key: 'progress', min: 0, max: 3000, step: 50, fmt: f0 });
  slider(b, { label: 'Çarpma cezası', obj: R, key: 'crash', min: 0, max: 300, step: 5, fmt: f0, help: 'Hızlı çarpma daha çok ceza alır (×0.4 – ×1.0).' });
  slider(b, { label: 'Takılma / geri gitme cezası', obj: R, key: 'stall', min: 0, max: 300, step: 5, fmt: f0 });
  slider(b, { label: 'Zaman cezası (adım başına)', obj: R, key: 'timePenalty', min: 0, max: 0.5, step: 0.01, fmt: f2 });
  slider(b, { label: 'Bitirme ödülü', obj: R, key: 'finish', min: 0, max: 2000, step: 50, fmt: f0 });
  slider(b, { label: 'Hız bonusu (kazanılan sn başına)', obj: R, key: 'speedBonus', min: 0, max: 100, step: 1, fmt: f0, help: 'Aynı pisti daha kısa sürede bitiren daha çok ödül alır.' });
  if (cfg.rules.mode === 'race') {
    note(b, '<b>Yarış modu</b>', 'subhead');
    slider(b, { label: 'Sollama ödülü (geçilen araç başına)', obj: R, key: 'overtake', min: 0, max: 200, step: 5, fmt: f0, help: 'Geçilen araç aynı miktarda ceza alır.' });
    slider(b, { label: 'Temas cezası', obj: R, key: 'contact', min: 0, max: 300, step: 5, fmt: f0, help: 'Arkadan vuran tam, önde olan çeyrek ceza alır; hız farkı arttıkça büyür.' });
    slider(b, { label: 'Bitiriş sırası bonusu', obj: R, key: 'position', min: 0, max: 1000, step: 10, fmt: f0, help: 'Serinin birincisi tam bonus, sonuncusu 0.' });
  }
}

function buildPhysics() {
  const b = $('physBox');
  b.innerHTML = '';
  const P = cfg.physics;
  const presets = document.createElement('div');
  presets.className = 'row2';
  presets.innerHTML = '<button class="primary" id="btnPhysF1" title="2024 dönemi F1 aracına en yakın değerler">Gerçek F1 fiziği</button><button id="btnPhysEasy" title="Daha çok tutuş, daha az güç: hızlı öğrenme">Kolay mod</button>';
  b.appendChild(presets);
  const sum = document.createElement('div');
  sum.className = 'phys-sum';
  b.appendChild(sum);
  const refresh = () => {
    const S = physicsSummary(P);
    sum.innerHTML = `Son hız <b>${S.vmaxKmh.toFixed(0)} km/s</b> · 300 km/s'den fren <b>${S.brake300.toFixed(1)} g</b><br>Hızlı virajda <b>${S.latFast.toFixed(1)} g</b> · yavaş virajda <b>${S.latSlow.toFixed(1)} g</b> · kalkış <b>${S.accel0.toFixed(1)} g</b>`;
  };
  const sl = (o) => {
    const w = slider(b, o);
    w.querySelector('input').addEventListener('input', () => {
      refresh();
        });
  };
  sl({ label: 'Motor gücü (kW)', obj: P, key: 'power', min: 200, max: 1000, step: 10, fmt: (v) => `${f0(v)} kW (${Math.round(v * 1.341)} hp)` });
  sl({ label: 'Kütle (kg, pilot dahil)', obj: P, key: 'mass', min: 600, max: 1200, step: 5, fmt: f0 });
  sl({ label: 'Sürükleme CdA (m²)', obj: P, key: 'cda', min: 0.6, max: 2.5, step: 0.05, fmt: f2, help: 'Son hızı belirler.' });
  sl({ label: 'Yere basma ClA (m²)', obj: P, key: 'cla', min: 0, max: 8, step: 0.1, fmt: f2, help: 'Hız arttıkça tutuşu artırır (hızlı virajlar, fren).' });
  sl({ label: 'Lastik tutuşu (μ)', obj: P, key: 'mu', min: 0.8, max: 2.6, step: 0.05, fmt: f2 });
  sl({ label: 'Ağırlık dağılımı (ön %)', obj: P, key: 'weightFront', min: 0.35, max: 0.6, step: 0.01, fmt: (v) => `%${Math.round(v * 100)}`, help: 'Arka ağırlıklı araç çıkışta iyi çeker ama arkası daha kolay kayar.' });
  sl({ label: 'Aero dengesi (ön %)', obj: P, key: 'aeroFront', min: 0.3, max: 0.6, step: 0.01, fmt: (v) => `%${Math.round(v * 100)}`, help: 'Ön yere basma artınca araç keskinleşir (oversteer), azalınca önden kayar (understeer).' });
  sl({ label: 'Ağırlık merkezi yüksekliği (m)', obj: P, key: 'cgHeight', min: 0.15, max: 0.6, step: 0.01, fmt: f2, help: 'Yüksek ağırlık merkezi = frende/gazda/virajda daha çok yük transferi.' });
  sl({ label: 'Lastik yük hassasiyeti', obj: P, key: 'loadSens', min: 0, max: 0.2, step: 0.01, fmt: f2, help: 'Yük arttıkça lastiğin μ değeri düşer; yük transferi toplam tutuşu azaltır.' });
  sl({ label: 'En küçük dönüş yarıçapı (m)', obj: P, key: 'minRadius', min: 4, max: 15, step: 0.5, fmt: (v) => (+v).toFixed(1) });
  sl({ label: 'Direksiyon hızı (kilit/sn)', obj: P, key: 'steerSpeed', min: 1, max: 12, step: 0.5, fmt: (v) => (+v).toFixed(1) });
  refresh();
  const apply = (name, msg) => {
    Object.assign(cfg.physics, physicsPreset(name));
    buildPhysics();
      toast(msg);
  };
  $('btnPhysF1').onclick = () => apply('f1', 'Gerçek F1 fiziği uygulandı (798 kg + yakıt, 750 kW, ~340 km/s, 5+ g, iki akslı model).');
  $('btnPhysEasy').onclick = () => apply('easy', 'Kolay mod: daha çok tutuş, daha az güç.');
}

// Lastik / yakıt / ERS / DRS / pit stratejisi
function buildCar() {
  const b = $('carBox');
  if (!b) return;
  b.innerHTML = '';
  const C = cfg.car;
  select(b, {
    label: 'Lastik hamuru', obj: C, key: 'compound', options: COMPOUND_IDS.map((id) => [id, COMPOUNDS[id].label]),
    help: 'Yumuşak: +%2.5 tutuş, hızlı aşınır, düşük sıcaklıkta çalışır. Sert: −%2.5 tutuş, uzun ömür, yüksek sıcaklık ister.',
  });
  checkbox(b, { label: 'Lastik sıcaklığı tutuşu etkilesin', obj: C, key: 'tyreTemp' });
  slider(b, { label: 'Başlangıç lastik sıcaklığı (°C)', obj: C, key: 'startTemp', min: 30, max: 120, step: 1, fmt: f0, help: 'İdeal pencere: yumuşak 95, orta 102, sert 110 °C (±25). Soğuk lastik ilk virajlarda kaydırır; kayma ve sert sürüş ısıtır.' });
  slider(b, { label: 'Pist sıcaklığı (°C)', obj: C, key: 'trackTemp', min: 10, max: 60, step: 1, fmt: f0 });
  checkbox(b, { label: 'Lastik aşınması', obj: C, key: 'wear' });
  slider(b, { label: 'Aşınma hızlandırıcı', obj: C, key: 'wearMul', min: 1, max: 30, step: 1, fmt: (v) => `×${f0(v)}`, help: 'Gerçekte orta hamur turda ≈ %2 aşınır. Kısa deneylerde strateji etkisini görmek için hızlandır. %75 sonrası tutuş hızla düşer.' });
  const fuelHolder = { auto: C.fuel === 'auto' };
  const autoKg = () => (track.lengthMeters / 1000) * C.fuelPerKm * cfg.rules.laps * 1.05 + 0.5;
  checkbox(b, {
    label: 'Yakıt: tur sayısına göre otomatik', obj: fuelHolder, key: 'auto',
    onChange: (v) => { C.fuel = v ? 'auto' : Math.round(autoKg() * 2) / 2; buildCar(); },
  });
  if (C.fuel !== 'auto') {
    slider(b, { label: 'Başlangıç yakıtı (kg)', obj: C, key: 'fuel', min: 0, max: 110, step: 0.5, fmt: (v) => `${(+v).toFixed(1)} kg`, help: 'Her 10 kg ≈ +%1.25 kütle. Yakıt biterse motor durur (yalnızca ERS kalır).' });
  } else {
    note(b, `Otomatik: ${autoKg().toFixed(1)} kg (≈ ${((track.lengthMeters / 1000) * C.fuelPerKm).toFixed(2)} kg/tur, en çok 100 kg/saat akış).`);
  }
  checkbox(b, { label: 'ERS (MGU-K 120 kW, 4 MJ batarya)', obj: C, key: 'ers' });
  note(b, 'Açıkken motor 630 kW + tam gazda 120 kW elektrik desteği verir; turda en çok 4 MJ kullanılır, frenlemede en çok 2 MJ şarj edilir. Kapalıyken 750 kW sabit güç.');
  select(b, {
    label: 'DRS', obj: C, key: 'drs',
    options: [['off', 'Kapalı'], ['zones', 'Bölgede serbest (sıralama turu gibi)'], ['race', 'Yarış kuralı: öndeki araca < 1 sn']],
    help: 'Açık kanat sürüklemeyi %15, arka yere basmayı %10 azaltır (≈ +10-15 km/s). Gaza basınca açılır, frene basınca kapanır.',
  });
  const z = track.drsZones || [];
  note(b, z.length ? `Bu pistte ${z.length} DRS bölgesi: ${z.map((q) => `${Math.round(q.s0 * track.mpp)}–${Math.round(q.s1 * track.mpp)} m`).join(', ')} (2B görünümde yeşil).` : 'Bu pistte DRS için yeterince uzun düzlük yok.');
  note(b, '<b>Pit stratejisi</b> (çok turlu yarış)', 'subhead');
  slider(b, { label: 'Pit turu (0 = pit yok)', obj: C, key: 'pitLap', min: 0, max: 10, step: 1, fmt: (v) => (+v ? `${f0(v)}. tur sonunda` : 'yok'), help: 'Tur sayısı (Simülasyon bölümü) bundan büyük olmalı.' });
  select(b, { label: 'Pitte takılacak hamur', obj: C, key: 'pitCompound', options: COMPOUND_IDS.map((id) => [id, COMPOUNDS[id].label]) });
  slider(b, { label: 'Pit kaybı (sn)', obj: C, key: 'pitLossSec', min: 10, max: 40, step: 0.5, fmt: (v) => `${(+v).toFixed(1)} sn` });
}

function buildAlgo() {
  const b = $('algoBox');
  b.innerHTML = '';
  const a = $('selAlgo').value;
  if (a === 'ga') {
    const G = cfg.ga;
    hiddenInput(b, G);
    slider(b, { label: 'Elit oranı', obj: G, key: 'eliteFrac', min: 0.01, max: 0.3, step: 0.01, fmt: f2, help: 'En iyiler değişmeden bir sonraki nesle geçer.' });
    slider(b, { label: 'Ebeveyn havuzu', obj: G, key: 'selectFrac', min: 0.05, max: 0.6, step: 0.01, fmt: f2 });
    slider(b, { label: 'Mutasyon oranı', obj: G, key: 'mutRate', min: 0.01, max: 0.5, step: 0.01, fmt: f2 });
    slider(b, { label: 'Mutasyon gücü (σ)', obj: G, key: 'mutStd', min: 0.02, max: 1, step: 0.01, fmt: f2 });
    slider(b, { label: 'Çaprazlama olasılığı', obj: G, key: 'crossover', min: 0, max: 1, step: 0.05, fmt: f2 });
    checkbox(b, { label: 'Uyarlamalı mutasyon (takılınca artır)', obj: G, key: 'adaptive' });
  } else if (a === 'es') {
    const E = cfg.es;
    hiddenInput(b, E);
    slider(b, { label: 'Gürültü (σ)', obj: E, key: 'sigma', min: 0.01, max: 0.5, step: 0.01, fmt: f2 });
    slider(b, { label: 'Öğrenme hızı', obj: E, key: 'lr', min: 0.001, max: 0.2, step: 0.001, fmt: f3 });
    slider(b, { label: 'Ağırlık sönümü', obj: E, key: 'wd', min: 0, max: 0.05, step: 0.001, fmt: f3 });
  } else if (a !== 'ppo') {
    // kayıt dosyasından (src/algos/index.js) gelen genel ayar arayüzü
    const def = ALGOS[a];
    if (def?.defaults && !cfg[a]) cfg[a] = structuredClone(def.defaults);
    const C = cfg[a];
    if (C?.hidden) hiddenInput(b, C);
    for (const u of def?.ui || []) {
      const dec = u.step >= 1 ? 0 : Math.min(5, Math.ceil(-Math.log10(u.step)));
      slider(b, { label: u.label, obj: C, key: u.key, min: u.min, max: u.max, step: u.step, restart: u.restart, help: u.help, fmt: (v) => (+v).toFixed(dec) });
    }
    if (def?.kind === 'continuous') {
      const holder = { det: trainer?.algo?.deterministic || false };
      checkbox(b, {
        label: 'Deterministik sürüş (gürültüsüz ortalama aksiyon)', obj: holder, key: 'det',
        onChange: (v) => { if (trainer && trainer.algo.name === a) trainer.algo.deterministic = v; },
      });
    }
    if (def?.description) {
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = def.description;
      b.appendChild(p);
    }
  } else {
    const Q = cfg.ppo;
    hiddenInput(b, Q);
    slider(b, { label: 'Rollout uzunluğu (adım)', obj: Q, key: 'rollout', min: 8, max: 128, step: 8, fmt: f0, restart: true });
    slider(b, { label: 'Öğrenme hızı', obj: Q, key: 'lr', min: 0.0001, max: 0.003, step: 0.0001, fmt: (v) => (+v).toFixed(4) });
    slider(b, { label: 'Entropi katsayısı (keşif)', obj: Q, key: 'entropy', min: 0, max: 0.05, step: 0.001, fmt: f3 });
    slider(b, { label: 'PPO kırpma (ε)', obj: Q, key: 'clip', min: 0.05, max: 0.4, step: 0.01, fmt: f2 });
    slider(b, { label: 'Epoch', obj: Q, key: 'epochs', min: 1, max: 8, step: 1, fmt: f0 });
    slider(b, { label: 'İndirim (γ)', obj: Q, key: 'gamma', min: 0.9, max: 0.999, step: 0.001, fmt: f3 });
    slider(b, { label: 'GAE (λ)', obj: Q, key: 'lambda', min: 0.8, max: 1, step: 0.01, fmt: f2 });
    slider(b, { label: 'Ödül kırpma (ölçekli)', obj: Q, key: 'rewardClip', min: 0, max: 20, step: 0.5, fmt: (v) => (+v ? (+v).toFixed(1) : 'kapalı'), help: 'Bitirme + hız bonusu gibi büyük tek seferlik ödülleri sınırlar; PPO\'yu kararlı tutar.' });
    slider(b, { label: 'Güncelleme başına örnek', obj: Q, key: 'maxBatch', min: 512, max: 8192, step: 512, fmt: f0 });
    const holder = { det: trainer?.algo?.deterministic || false };
    checkbox(b, {
      label: 'Deterministik sürüş (en olası aksiyon)', obj: holder, key: 'det',
      onChange: (v) => { if (trainer && trainer.algo.name === 'ppo') trainer.algo.deterministic = v; },
    });
  }
}

// ---------- yardımcılar ----------
let toastTimer = 0;
function toast(msg, err = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast' + (err ? ' err' : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3500);
}

function applyAutoTimeLimit() {
  cfg.rules.timeLimitSec = autoTimeLimit(track);
  buildRules();
}

function setTrack(def, keepBrains = true) {
  trackDef = def;
  track = new Track(def);
  applyAutoTimeLimit();
  renderer.setTrack(track);
  if (trainer && keepBrains) trainer.setTrack(track);
  else newTrainer();
  tuner.reset();
  autoUiDirty = true;
  buildCar();
  $('algoLabel').textContent = trainerLabel();
}

function setRunning(on) {
  running = on;
  if (!on && trainer && trainer.pause) trainer.pause();
  $('btnPlay').textContent = on ? '⏸ Duraklat' : '▶ Başlat';
}

function setSpeed(s) {
  speed = s === 'max' ? 'max' : +s;
  acc = 0;
  for (const b of $('speedSeg').querySelectorAll('button')) b.classList.toggle('on', b.dataset.speed === String(s));
}

function fmtTime(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  return (h ? h + 's ' : '') + String(m).padStart(2, '0') + 'd ' + String(s).padStart(2, '0') + 'sn';
}

// ---------- panel güncellemeleri ----------
function updateHud() {
  const sim = trainer.sim;
  const pop = trainer.isPopulation;
  let leaderProg = 0;
  for (let i = 0; i < sim.N; i++) if (sim.status[i] === RUNNING) leaderProg = Math.max(leaderProg, sim.bestProg[i]);
  const goal = track.length * cfg.rules.laps;
  let crashed = 0;
  if (pop) for (let i = 0; i < sim.N; i++) if (sim.status[i] === CRASHED) crashed++;
  const hud = $('hud');
  if (pop) {
    const sp = sim.spawnInfo || {};
    const spawnTxt = sp.flying ? `Uçan başlangıç: pistin ${Math.round(sp.s * track.mpp)}. metresi` : 'Start çizgisinden';
    hud.innerHTML = `<div class="sub">Nesil</div><div class="big">${trainer.generation}</div>
      <div class="sub">Yarışan ${sim.alive} / ${sim.N} · Bitiren ${sim.finished} · Çarpan ${crashed}</div>
      <div class="sub">Süre ${(sim.tick / TICK_RATE).toFixed(1)} / ${(sim.timeLimitTicks / TICK_RATE).toFixed(0)} sn · ${spawnTxt}</div>
      ${sim.race ? `<div class="sub">Yarış: ${Math.ceil(sim.N / sim.H)} seri × ${sim.H} araç</div>` : ''}
      <div class="bar"><i style="width:${Math.min(100, (leaderProg / goal) * 100).toFixed(1)}%"></i></div>`;
  } else {
    const w = trainer.epWindow;
    const fr = w.length ? (w.filter((e) => e.fin).length / w.length) * 100 : 0;
    hud.innerHTML = `<div class="sub">Güncelleme (${trainer.algo.name.toUpperCase()})</div><div class="big">${trainer.algo.updates}</div>
      <div class="sub">Bölüm: ${trainer.episodes.toLocaleString('tr-TR')} · Son ${w.length} bölümde bitirme %${fr.toFixed(0)}</div>
      <div class="sub">${trainer.algo.hudText ? trainer.algo.hudText() : `Rollout ${trainer.algo.t}/${trainer.algo.T}`}${trainer.algo.busy ? ' · öğreniyor…' : ''}</div>
      <div class="bar"><i style="width:${Math.min(100, (leaderProg / goal) * 100).toFixed(1)}%"></i></div>`;
  }
}

function stat(label, value, wide = false) {
  return `<div class="stat${wide ? ' wide' : ''}"><span>${label}</span><b>${value}</b></div>`;
}

function updateAuto() {
  if (!autoUiDirty) return;
  autoUiDirty = false;
  $('autoStatus').innerHTML = `<b>${tuner.status()}</b><span>Kabul ${tuner.accepted} · Geri alınan ${tuner.rejected}</span>`;
  $('autoLog').innerHTML = tuner.log
    .slice(0, 12)
    .map((l) => `<li class="${l.kind}">${l.msg}</li>`)
    .join('') || '<li class="info">Henüz müdahale yok.</li>';
}

function updateStats() {
  updateAuto();
  const sim = trainer.sim;
  const g = trainer.lastGen;
  const pop = trainer.isPopulation;
  const bestLap = trainer.bestEverLapTicks ? fmtLap(trainer.bestEverLapTicks / TICK_RATE) : '–';
  let html = '';
  html += stat(pop ? 'Nesil' : 'Güncelleme', pop ? trainer.generation : trainer.algo.updates);
  html += stat('Araç', sim.N);
  html += stat('Tüm zamanların en iyi turu', bestLap);
  html += stat('Son nesil en iyi tur', g && g.bestLap ? fmtLap(g.bestLap) : '–');
  html += stat('En iyi ödül', isFinite(trainer.bestEverFitness) ? trainer.bestEverFitness.toFixed(0) : '–');
  html += stat('Son nesil bitiren', g ? `${g.finishers} (%${(g.finishRate * 100).toFixed(0)})` : '–');
  if (track.realRecord) html += stat('Gerçek dünya referansı', `${track.realRecord.time} <small>${track.realRecord.note}</small>`, true);
  html += stat('Simüle edilen süre', fmtTime(trainer.totalTicks / TICK_RATE), true);
  $('stats').innerHTML = html;
  updateAnalysis();
  $('algoDesc').textContent = trainer.algo.describe();
}

// Sektörler, ideal tur, ilk 5, yarış istatistikleri
function updateAnalysis() {
  const el = $('analysis');
  if (!el) return;
  const bs = trainer.bestSectors || [0, 0, 0];
  const g = trainer.lastGen;
  const sec = (t) => (t ? (t / TICK_RATE).toFixed(2) : '–');
  let html = '<h3>Analiz</h3><table class="sec-table"><tr><th></th><th>S1</th><th>S2</th><th>S3</th><th>İdeal tur</th></tr>';
  html += `<tr><td>En iyi</td><td>${sec(bs[0])}</td><td>${sec(bs[1])}</td><td>${sec(bs[2])}</td><td><b>${trainer.idealLap ? fmtLap(trainer.idealLap) : '–'}</b></td></tr>`;
  if (g && g.sectors) {
    const gs = g.sectors;
    const cls = (k) => (gs[k] && bs[k] && Math.abs(gs[k] * TICK_RATE - bs[k]) < 0.5 ? ' class="purple"' : '');
    html += `<tr><td>Son ${trainer.isPopulation ? 'nesil' : 'güncelleme'}</td>${[0, 1, 2].map((k) => `<td${cls(k)}>${gs[k] ? gs[k].toFixed(2) : '–'}</td>`).join('')}<td>${idealOf(g) ? fmtLap(idealOf(g)) : '–'}</td></tr>`;
  }
  html += '</table>';
  html += '<p class="hint">Sektörler pistin 3 eşit bölümüdür (start çizgisinden sayılır). İdeal tur = en iyi üç sektörün toplamı: aynı beyin her sektörde en iyisini yapsa ulaşacağı süre.</p>';
  const top = trainer.topLaps || [];
  if (top.length) {
    html += `<div class="top5"><b>En iyi ${top.length} farklı sürüş</b><ol>${top.map((b) => `<li>${fmtLap(b.lapTicks / TICK_RATE)}<small>${b.meta?.generation != null ? ` · ${trainer.isPopulation ? 'nesil' : 'güncelleme'} ${b.meta.generation}` : ''}</small></li>`).join('')}</ol></div>`;
  }
  if (g && (g.spins || g.contacts != null)) {
    html += `<div class="race-stats">${g.spins ? `Son nesilde spin: <b>${g.spins}</b>` : ''}${g.contacts != null ? ` · Temas: <b>${Math.round(g.contacts)}</b> · Sollama: <b>${g.overtakes}</b>` : ''}</div>`;
  }
  el.innerHTML = html;
  $('btnCockpitTop5').disabled = top.length < 2;
  $('btnCockpitHeat').disabled = !trainer.bestHeat;
}

function statusText(s) {
  return s === RUNNING ? 'Yarışıyor' : s === FINISHED ? 'Bitirdi' : s === CRASHED ? 'Çarptı' : 'Elendi';
}

function updateSelected() {
  const sim = trainer.sim;
  const i = view.selected;
  if (i < 0 || i >= sim.N) {
    $('selInfo').textContent = '';
    return;
  }
  const kmh = Math.round(sim.spd[i] * 3.6);
  const prog = (sim.bestProg[i] / (track.length * cfg.rules.laps)) * 100;
  const tag = i === 0 && trainer.isPopulation ? (trainer.algo.name === 'ga' ? ' · önceki şampiyon' : ' · ortalama politika θ') : '';
  const cp = COMPOUNDS[COMPOUND_IDS[sim.comp[i]]] || COMPOUNDS.medium;
  const sys = ` · ${cp.short} ${sim.tyreT[i].toFixed(0)}°C %${(sim.wear[i] * 100).toFixed(0)} aşınma · yakıt ${sim.fuel[i].toFixed(1)} kg · ERS %${((sim.soc[i] / 4e6) * 100).toFixed(0)}${sim.drsOpen[i] ? ' · DRS' : ''}${Math.abs(sim.beta[i]) > 0.05 ? ` · kayma ${(sim.beta[i] * 57.3).toFixed(0)}°` : ''}`;
  const race = sim.race ? ` · seri ${Math.floor(i / sim.H) + 1}${sim.place[i] ? ` · ${sim.place[i]}.` : ''} · sollama ${sim.overtakes[i]} · temas ${sim.contacts[i]}` : '';
  $('selInfo').textContent = `· #${i}${tag} · ${statusText(sim.status[i])} · ${kmh} km/s · %${prog.toFixed(0)} · ödül ${sim.fitness[i].toFixed(0)} · çarpma ${sim.crashes[i]}${sys}${race}`;
  if (view.nn) nnviz.draw(trainer.algo.netOf(i), sim.obs, i * OBS_SIZE);
}

// ---------- ana döngü ----------
let lastFrame = performance.now();
let frameNo = 0;
function frame(now) {
  if (cockpitOpen) {
    lastFrame = now;
    requestAnimationFrame(frame);
    return;
  }
  const dt = Math.min(250, now - lastFrame);
  lastFrame = now;
  frameNo++;
  const t0 = performance.now();
  let ticks = 0;
  if (running && !editing) {
    wallSec += dt / 1000;
    let n;
    let budget;
    if (speed === 'max') {
      n = Infinity;
      budget = renderOn ? 30 : 48;
    } else {
      acc += (dt / 1000) * TICK_RATE * speed;
      n = Math.floor(acc);
      acc -= n;
      if (acc > 4) acc = 0;
      budget = renderOn ? 16 : 40;
    }
    if (trainer.pump) {
      ticks = trainer.pump(n, budget); // engellemez; dönüş: son karedan bu yana işçilerin tamamladığı adım
    } else {
      while (ticks < n) {
        if (!trainer.tick()) break;
        ticks++;
        if ((ticks & 3) === 0 && performance.now() - t0 > budget) break;
      }
    }
  }
  const t1 = performance.now();

  if (view.autoSelect && frameNo % 10 === 0) view.selected = trainer.leaderIndex();

  if (renderOn) renderer.draw(trainer, view);
  else if (frameNo % 30 === 1) {
    const c = renderer.ctx;
    renderer.resize();
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = '#0f1512';
    c.fillRect(0, 0, renderer.canvas.width, renderer.canvas.height);
    c.fillStyle = '#8b949e';
    c.font = `${16 * renderer.dpr}px system-ui`;
    c.textAlign = 'center';
    c.fillText('Çizim kapalı — tüm işlemci gücü eğitimde', renderer.canvas.width / 2, renderer.canvas.height / 2);
  }
  const t2 = performance.now();

  if (frameNo % 6 === 0) updateHud();
  if (frameNo % 15 === 0) updateStats();
  if (frameNo % 6 === 3) updateSelected();
  if (chartsDirty && now - lastChartDraw > 300) {
    chartsDirty = false;
    lastChartDraw = now;
    chartFit.draw(trainer.history);
    chartFin.draw(trainer.history);
    chartLap.draw(trainer.history);
  }
  const t3 = performance.now();
  devstats.record({ t: now, dt, sim: t1 - t0, render: t2 - t1, ui: t3 - t2, ticks, cars: trainer.sim.N });
  devstats.render({
    canvasW: renderer.canvas.width,
    canvasH: renderer.canvas.height,
    dpr: renderer.dpr,
    workers: trainer.describeParallel ? trainer.describeParallel() : null,
    ppoMs: !trainer.isPopulation && trainer.algo.lastStats && trainer.algo.lastStats.ms != null ? trainer.algo.lastStats.ms : null,
  });
  requestAnimationFrame(frame);
}

// ---------- kamera etkileşimi ----------
const cv = $('view');
let drag = null;
cv.addEventListener('mousedown', (e) => {
  drag = { x: e.clientX, y: e.clientY, moved: false };
});
window.addEventListener('mousemove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (!drag.moved && Math.hypot(dx, dy) > 4) {
    drag.moved = true;
    cv.classList.add('dragging');
  }
  if (drag.moved) {
    renderer.panBy(dx, dy);
    drag.x = e.clientX;
    drag.y = e.clientY;
    view.follow = false;
    $('chkFollow').checked = false;
  }
});
window.addEventListener('mouseup', (e) => {
  if (!drag) return;
  const wasClick = !drag.moved;
  drag = null;
  cv.classList.remove('dragging');
  if (!wasClick) return;
  const r = cv.getBoundingClientRect();
  const [wx, wy] = renderer.screenToWorld(e.clientX - r.left, e.clientY - r.top);
  if (editing) {
    renderer.editPoints.push([wx, wy]);
    $('edMsg').textContent = `${renderer.editPoints.length} nokta`;
    return;
  }
  const sim = trainer.sim;
  let best = -1, bd = (24 / renderer.cam.zoom) ** 2;
  for (let i = 0; i < sim.N; i++) {
    if (!view.showDead && sim.status[i] !== RUNNING && sim.status[i] !== FINISHED) continue;
    const d = (sim.x[i] - wx) ** 2 + (sim.y[i] - wy) ** 2;
    if (d < bd) { bd = d; best = i; }
  }
  if (best >= 0) {
    view.selected = best;
    view.autoSelect = false;
  } else {
    view.autoSelect = true;
  }
  updateSelected();
});
cv.addEventListener('wheel', (e) => {
  e.preventDefault();
  const r = cv.getBoundingClientRect();
  renderer.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
}, { passive: false });

// ---------- düğmeler ----------
$('btnPlay').onclick = () => setRunning(!running);
$('btnEndGen').onclick = () => trainer.forceEndGeneration();
$('btnReset').onclick = () => {
  newTrainer(randomSeed());
  toast('Öğrenme sıfırlandı — rastgele beyinlerle yeniden başlıyor.');
};
$('btnApply').onclick = () => {
  newTrainer();
  toast(`${trainer.algo.label} · ${trainer.sim.N} araç ile yeniden başlatıldı.`);
};
$('btnSeedRnd').onclick = () => {
  $('inpSeed').value = randomSeed();
  toast('Yeni tohum bir sonraki "Uygula ve yeniden başlat"ta kullanılacak.');
};
$('speedSeg').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) setSpeed(b.dataset.speed);
});
$('btnRender').onclick = () => {
  renderOn = !renderOn;
  $('btnRender').textContent = renderOn ? 'Çizim: Açık' : 'Çizim: Kapalı';
};
$('btnDev').onclick = () => {
  $('dev').hidden = !$('dev').hidden;
};
$('selAlgo').onchange = () => buildAlgo();
$('selTrack').onchange = () => {
  const def = allTrackDefs().find((d) => d.id === $('selTrack').value);
  if (def) {
    setTrack(def, true);
    toast(`Pist: ${def.name} (beyinler korundu)`);
  }
};
$('btnRandomTrack').onclick = () => {
  randomDef = randomTrackDef((Math.random() * 1e6) | 0);
  fillTrackSelect(randomDef.id);
  setTrack(randomDef, true);
  toast(`${randomDef.name} oluşturuldu.`);
};
$('btnFit').onclick = () => renderer.fit();

const bindChk = (id, key, fn) => {
  $(id).checked = view[key];
  $(id).onchange = (e) => {
    view[key] = e.target.checked;
    if (fn) fn(view[key]);
  };
};
bindChk('chkRays', 'rays');
bindChk('chkFollow', 'follow');
bindChk('chkHeat', 'heatmap');
bindChk('chkGhost', 'ghost');
bindChk('chkDead', 'showDead');
bindChk('chkNN', 'nn');
$('chkAuto').onchange = (e) => {
  tuner.enabled = e.target.checked;
  if (!tuner.enabled && tuner.trial) {
    // açık bir deneme varsa eski değere dön
    const t = tuner.trial;
    tuner._apply(trainer, t.knob, t.old);
    tuner._push(`Otomatik ayar kapatıldı, deneme geri alındı: ${t.knob.label}`, 'fail');
    tuner.onChange(t.knob);
    tuner.trial = null;
    tuner.state = 'observe';
  }
  autoUiDirty = true;
};
$('chkIso').onchange = (e) => renderer.setIso(e.target.checked);

// ---------- pist editörü ----------
let wasRunning = false;
let devWasOpen = false;
$('btnEditTrack').onclick = () => {
  editing = true;
  wasRunning = running;
  setRunning(false);
  $('chkIso').checked = false;
  renderer.setIso(false);
  renderer.editPoints = [];
  renderer.editWidth = +$('edWidth').value;
  $('editor').hidden = false;
  $('edMsg').textContent = '';
  devWasOpen = !$('dev').hidden;
  $('dev').hidden = true;
  $('hud').hidden = true;
  cv.classList.add('editing');
};
function endEdit() {
  editing = false;
  renderer.editPoints = null;
  $('editor').hidden = true;
  $('hud').hidden = false;
  if (devWasOpen) $('dev').hidden = false;
  cv.classList.remove('editing');
  setRunning(wasRunning);
}
$('edWidth').oninput = () => {
  $('edWidthV').textContent = $('edWidth').value;
  renderer.editWidth = +$('edWidth').value;
};
$('edUndo').onclick = () => {
  renderer.editPoints.pop();
  $('edMsg').textContent = `${renderer.editPoints.length} nokta`;
};
$('edCancel').onclick = endEdit;
$('edDone').onclick = () => {
  const pts = renderer.editPoints;
  if (pts.length < 6) {
    $('edMsg').textContent = 'En az 6 nokta gerekli.';
    return;
  }
  const def = { id: 'custom-' + Date.now(), name: `Özel pist ${customTracks.length + 1}`, halfWidth: +$('edWidth').value, points: pts.map((p) => [Math.round(p[0]), Math.round(p[1])]) };
  const t = new Track(def);
  const v = t.validate();
  if (!v.ok) {
    $('edMsg').textContent = v.minGap < v.need
      ? `Pistin iki bölümü birbirine çok yakın (${v.minGap.toFixed(0)} px, en az ${v.need} px olmalı). Noktaları açın.`
      : `Bir viraj çok keskin (yarıçap ${v.minRadius.toFixed(0)} px, en az ${def.halfWidth}). Noktaları yayın.`;
    return;
  }
  customTracks.push(def);
  store.set('rlrace.customTracks', customTracks);
  fillTrackSelect(def.id);
  endEdit();
  setTrack(def, true);
  toast(`${def.name} oluşturuldu (${(t.length / 1000).toFixed(1)}k px).`);
};

// ---------- kayıt / yükleme ----------
function serializeBrain(b) {
  return {
    format: 'rl-race-brain', version: 1, ...b,
    params: Array.from(b.params),
    vparams: b.vparams ? Array.from(b.vparams) : undefined,
    qparams: b.qparams ? Array.from(b.qparams) : undefined,
  };
}
function deserializeBrain(o) {
  if (!o || o.format !== 'rl-race-brain' || !Array.isArray(o.params) || !Array.isArray(o.sizes)) throw new Error('Geçersiz beyin dosyası');
  if (o.sizes[0] > OBS_SIZE) throw new Error('Gözlem boyutu uyumsuz (daha yeni bir sürümün beyni)');
  const f = (a) => (Array.isArray(a) ? Float32Array.from(a) : undefined);
  // eski sürümlerin 15 girdili beyinleri 25 girdiye yükseltilir (yeni girdilere 0 ağırlık → aynı davranış)
  return upgradeBrain({ ...o, params: Float32Array.from(o.params), vparams: f(o.vparams), qparams: f(o.qparams) });
}
function applyBrain(brain) {
  brain = upgradeBrain(brain);
  let algo = trainer.algo.name;
  let restarted = false;
  const tanhBrain = !brain.discrete && !!(brain.outTanh || brain.squash);
  const accepts = (a) => (a === 'ppo' ? !!brain.discrete : a === 'ppoc' ? !brain.discrete && !tanhBrain : tanhBrain);
  if (!accepts(algo)) {
    algo = ALGOS[brain.algo] && accepts(brain.algo) ? brain.algo : brain.discrete ? 'ppo' : tanhBrain ? 'ga' : 'ppoc';
    restarted = true;
  }
  if (!cfg[algo] && ALGOS[algo].defaults) cfg[algo] = structuredClone(ALGOS[algo].defaults);
  const hid = brain.sizes.slice(1, -1);
  if (cfg[algo].hidden && cfg[algo].hidden.join() !== hid.join()) { cfg[algo].hidden = hid; restarted = true; }
  if (restarted) {
    $('selAlgo').value = algo;
    buildAlgo();
    newTrainer();
  }
  if (!trainer.loadBrain(brain)) throw new Error('Beyin bu algoritmaya yüklenemedi');
  const m = brain.meta;
  toast(`Beyin yüklendi${m ? ` (ödül ${m.fitness?.toFixed(0)}, ${m.lapSec ? m.lapSec.toFixed(2) + ' sn, ' : ''}${m.track || ''})` : ''}${restarted ? ' — algoritma/ağ ayarları buna göre değiştirildi' : ''}.`);
}
$('btnSave').onclick = () => {
  if (!trainer.bestBrain) return toast('Henüz kaydedilecek beyin yok (ilk nesil bitmedi).', true);
  const key = trainer.bestBrain.discrete ? 'rlrace.brain.ppo' : 'rlrace.brain.evo';
  if (store.set(key, serializeBrain(trainer.bestBrain))) toast('En iyi beyin tarayıcıya kaydedildi.');
  else toast('Kaydedilemedi (tarayıcı depolaması kapalı).', true);
};
$('btnLoad').onclick = () => {
  const key = trainer.algo.name === 'ppo' ? 'rlrace.brain.ppo' : 'rlrace.brain.evo';
  // not: sürekli PPO / SAC beyinleri 'evo' anahtarına kaydedilir; applyBrain uygun algoritmaya geçer
  const o = store.get(key) || store.get(key === 'rlrace.brain.ppo' ? 'rlrace.brain.evo' : 'rlrace.brain.ppo');
  if (!o) return toast('Tarayıcıda kayıtlı beyin bulunamadı.', true);
  try { applyBrain(deserializeBrain(o)); } catch (err) { toast(err.message, true); }
};
$('btnExport').onclick = () => {
  if (!trainer.bestBrain) return toast('Henüz dışa aktarılacak beyin yok.', true);
  const blob = new Blob([JSON.stringify(serializeBrain(trainer.bestBrain))], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `beyin-${trainer.algo.name}-${track.id}-nesil${trainer.generation}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
};
$('btnImport').onclick = () => $('fileImport').click();
$('fileImport').onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try { applyBrain(deserializeBrain(JSON.parse(await f.text()))); } catch (err) { toast('Yüklenemedi: ' + err.message, true); }
};

// ---------- oturum kaydı: kaldığın yerden devam ----------
let autosaveOn = false; // başlangıç kartı yanıtlanana kadar eski kaydın üzerine yazılmaz
let lastSavedTicks = -1;
let saving = false;
function currentSnapshot() {
  return snapshotTrainer({
    trainer, cfg, trackDef, algoName: trainer.algoName, carCount: +$('selCars').value, seed: trainer.seed,
    extra: { wallSec, tunerEnabled: tuner.enabled },
  });
}
async function autosave(force = false) {
  if (!autosaveOn || !trainer || saving || editing) return;
  if (!force && (trainer.totalTicks === 0 || trainer.totalTicks === lastSavedTicks)) return;
  saving = true;
  try {
    lastSavedTicks = trainer.totalTicks;
    await saveSession(currentSnapshot());
  } catch (err) {
    console.warn('Otomatik kayıt yapılamadı:', err);
  } finally {
    saving = false;
  }
}
setInterval(() => autosave(), 30000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') autosave();
});
window.addEventListener('pagehide', () => autosave());

function ensureCarOption(n) {
  const sel = $('selCars');
  if (![...sel.options].some((o) => +o.value === +n)) {
    const o = document.createElement('option');
    o.textContent = String(n);
    sel.appendChild(o);
  }
  sel.value = String(n);
}

// Kayıttaki / deneydeki ayarlar + pist + algoritma + tohumla yeni eğitim kur
function rebuildFrom({ cfgSrc, def, algo, cars, seed }) {
  applyConfig(cfg, cfgSrc);
  if (def) {
    const known = allTrackDefs().find((d) => d.id === def.id);
    if (!known) {
      if (String(def.id).startsWith('custom-')) {
        customTracks.push(def);
        store.set('rlrace.customTracks', customTracks);
      } else randomDef = def;
    }
    trackDef = known || def;
    track = new Track(trackDef);
    renderer.setTrack(track);
    fillTrackSelect(trackDef.id);
  }
  if (algo && ALGOS[algo]) $('selAlgo').value = algo;
  if (cars) ensureCarOption(cars);
  buildRules();
  buildReward();
  buildPhysics();
  buildCar();
  buildAlgo();
  newTrainer(seed ?? undefined);
  tuner.reset();
  renderer.fit();
  chartsDirty = true;
  autoUiDirty = true;
}

function resumeSession(snap) {
  rebuildFrom({ cfgSrc: snap.cfg, def: snap.trackDef, algo: snap.algoName, cars: snap.carCount, seed: snap.seed });
  const ok = restoreTrainer(trainer, snap);
  wallSec = snap.extra?.wallSec || 0;
  if (snap.extra && snap.extra.tunerEnabled != null) {
    tuner.enabled = snap.extra.tunerEnabled;
    $('chkAuto').checked = tuner.enabled;
  }
  lastSavedTicks = trainer.totalTicks;
  $('algoLabel').textContent = trainerLabel();
  toast(ok
    ? `Kaldığın yerden devam ediliyor: ${trainer.isPopulation ? 'Nesil ' + trainer.generation : 'Güncelleme ' + trainer.algo.updates}.`
    : 'Kayıt yüklendi ama algoritma durumu bu sürümle uyumsuz: beyinler sıfırdan başlıyor (geçmiş ve rekorlar korundu).', !ok);
}

async function checkSavedSession() {
  if (!hasIndexedDB()) return;
  let info = null;
  try { info = await loadSessionInfo(); } catch (err) { console.warn('Oturum kaydı okunamadı:', err); }
  if (!info) {
    autosaveOn = true;
    return;
  }
  const wasRunning = running;
  setRunning(false);
  const choice = await showResumeBanner(info);
  if (choice === 'resume') {
    try {
      const snap = await loadSession();
      if (snap) resumeSession(snap);
      else toast('Kayıt okunamadı.', true);
    } catch (err) {
      console.error(err);
      toast('Kayıt yüklenemedi: ' + err.message, true);
    }
    setRunning(true);
  } else {
    if (choice === 'delete') {
      await clearSession().catch(() => {});
      toast('Kayıt silindi.');
    }
    setRunning(wasRunning);
  }
  autosaveOn = true;
}

$('btnSessionSave').onclick = async () => {
  autosaveOn = true;
  await autosave(true);
  toast('Oturum kaydedildi. Açılışta kaldığın yerden devam edebilirsin.');
};
$('btnSessionClear').onclick = async () => {
  try {
    await clearSession();
    autosaveOn = false; // "Oturumu kaydet" ile yeniden açılır
    toast('Oturum kaydı silindi. Bu oturumda otomatik kayıt kapalı.');
  } catch (err) {
    toast('Silinemedi: ' + err.message, true);
  }
};

// ---------- deney yöneticisi ----------
function currentRun() {
  if (!trainer) return null;
  return {
    cfg, trackId: track.id, trackName: track.name, trackDef,
    algo: trainer.algoName, algoLabel: trainer.algo.label, seed: trainer.seed, carCount: trainer.sim.N,
    history: trainer.history,
    bestLapSec: trainer.bestEverLapTicks ? trainer.bestEverLapTicks / TICK_RATE : null,
    idealLapSec: trainer.idealLap,
    bestLapBrain: trainer.bestLapBrain,
    bestBrain: trainer.bestBrain,
    wallSec,
    totalTicks: trainer.totalTicks,
    generations: trainer.isPopulation ? trainer.generation - 1 : trainer.algo.updates,
  };
}
function openExperiments() {
  openExperimentManager({
    getCurrent: currentRun,
    onLoadBrain: (brain) => {
      try { applyBrain(brain); } catch (err) { toast(err.message, true); }
    },
    onApplyConfig: (runCfg, run) => {
      rebuildFrom({
        cfgSrc: runCfg,
        def: run.trackDef || allTrackDefs().find((d) => d.id === run.trackId) || null,
        algo: run.algo, cars: run.carCount, seed: run.seed ?? undefined,
      });
      toast(`"${run.name}" ayarlarıyla yeniden başlatıldı (tohum ${trainer.seed}).`);
    },
  });
}
$('btnExperiments').onclick = openExperiments;

// ---------- masaüstü uygulaması (PWA) ----------
const pwa = initPWA({ installButton: $('btnInstall') });

// ---------- 3B kokpit tekrarı ----------
let cockpitOpen = false;
// mode: 'single' (en hızlı tur) | 'top5' (ilk 5 sürüş, bağımsız) | 'heat' (yarış modunda en iyi seri)
async function openCockpit(mode = 'single') {
  if (cockpitOpen || editing) return;
  if (typeof mode !== 'string') mode = 'single';
  const brain = trainer.bestLapBrain || trainer.bestBrain;
  if (!brain) return toast('Henüz izlenecek bir sürüş yok, ilk neslin bitmesini bekle.', true);
  if (mode === 'top5' && trainer.topLaps.length < 2) { toast('İlk 5 için en az iki bitiren sürüş gerekli — en iyi sürüş açılıyor.'); mode = 'single'; }
  if (mode === 'heat' && !trainer.bestHeat) { toast('Seri tekrarı için "Yarış modu" açıkken eğitim gerekli — en iyi sürüş açılıyor.'); mode = 'single'; }
  const wasRunning = running;
  setRunning(false);
  cockpitOpen = true;
  const loading = document.createElement('div');
  loading.className = 'cockpit-loading';
  loading.textContent = '3B sahne hazırlanıyor…';
  document.body.appendChild(loading);
  try {
    const [{ simulateBrains }, { CockpitViewer }, { REF_TELEMETRY }] = await Promise.all([
      import('./replay.js'), import('./cockpit.js'), import('./tracks/reftel/index.js'),
    ]);
    const m = brain.meta || {};
    const genTxt = (b) => (b.meta?.generation != null ? `${trainer.isPopulation ? 'Nesil' : 'Güncelleme'} ${b.meta.generation}` : '');
    let replays, focus = 0, title, focusBrain = brain;
    if (mode === 'top5') {
      const list = trainer.topLaps.slice(0, 5);
      replays = simulateBrains(track, cfg, list, { race: false });
      replays.forEach((r, i) => (r.label = genTxt(list[i]) || `Sürüş ${i + 1}`));
      title = `İlk ${list.length} sürüş · ${trainer.algo.label} · ${track.name}`;
    } else if (mode === 'heat') {
      const h = trainer.bestHeat;
      replays = simulateBrains(track, cfg, h.cars, { race: true });
      replays.forEach((r, i) => (r.label = `Araç ${i + 1}`));
      focus = h.winner || 0;
      focusBrain = h.cars[focus];
      title = `Seri tekrarı · ${h.cars.length} araç · ${track.name} · ${trainer.isPopulation ? 'Nesil' : 'Güncelleme'} ${h.generation}`;
    } else if (brain.heat) {
      // yarış modunda yapılan rekor: kendi serisiyle (trafikle) birlikte tekrar
      const h = brain.heat;
      mode = 'heat';
      replays = simulateBrains(track, cfg, h.cars, { race: true });
      replays.forEach((r, i) => (r.label = `Araç ${i + 1}`));
      focus = h.winner || 0;
      title = `En hızlı tur (serisiyle birlikte) · ${trainer.algo.label} · ${track.name}${m.generation ? ` · ${genTxt(brain)}` : ''}`;
    } else {
      replays = simulateBrains(track, cfg, [brain]);
      const kind = trainer.bestLapBrain ? 'En hızlı tur' : 'En yüksek ödüllü sürüş (henüz bitiren yok)';
      title = `${kind} · ${trainer.algo.label} · ${track.name}${m.generation ? ` · ${genTxt(brain)}` : ''}`;
    }
    // karşılaştırma: önceki rekorlar + ilk 5'teki diğer sürüşler (seçilince simüle edilir)
    const seen = new Set([focusBrain]);
    const cands = [...trainer.records.slice().reverse(), ...trainer.topLaps].filter((b) => b && b.lapTicks && !seen.has(b) && seen.add(b));
    const compareOptions = cands.slice(0, 8).map((b, k) => ({
      id: 'b' + k,
      label: `${trainer.records.includes(b) ? 'Önceki rekor' : 'İlk 5'} · ${fmtLap(b.lapTicks / TICK_RATE)}${genTxt(b) ? ` (${genTxt(b)})` : ''}`,
      short: fmtLap(b.lapTicks / TICK_RATE),
      load: async () => ({ kind: 'replay', replay: simulateBrains(track, cfg, [b])[0] }),
    }));
    let reference = null;
    if (REF_TELEMETRY[track.id]) {
      try { reference = await (await fetch(REF_TELEMETRY[track.id])).json(); } catch (e) { console.warn('Referans tur yüklenemedi:', e); }
    }
    new CockpitViewer({
      track, cfg, title, replays, mode, focus,
      extra: {
        history: trainer.history.slice(),
        tunerLog: tuner.log.slice(),
        brain: focusBrain,
        reference,
        compareOptions,
        meta: {
          pist: track.name,
          pistUzunlukM: Math.round(track.lengthMeters),
          algoritma: trainer.algo.label,
          aracSayisi: trainer.sim.N,
          tohum: trainer.seed,
          nesilVeyaGuncelleme: m.generation ?? null,
          tumZamanlarinEnIyiTurS: trainer.bestEverLapTicks ? trainer.bestEverLapTicks / TICK_RATE : null,
          idealTurS: trainer.idealLap,
          enIyiSektorlerS: trainer.bestSectors.map((t) => (t ? t / TICK_RATE : null)),
          gercekDunyaReferansi: track.realRecord || null,
          fizik: { ...(focusBrain.physics || cfg.physics) },
          aracSistemleri: { ...(focusBrain.car || cfg.car) },
          kurallar: { ...(focusBrain.rules || cfg.rules) },
          odulCeza: { ...cfg.reward },
          algoritmaAyarlari: { ...cfg[trainer.algo.name] },
          otomatikAyar: { acik: tuner.enabled, kabul: tuner.accepted, geriAlinan: tuner.rejected },
        },
      },
      onClose: () => {
        cockpitOpen = false;
        setRunning(wasRunning);
        if (wasRunning) toast('Eğitim kaldığı yerden devam ediyor.');
      },
    });
  } catch (err) {
    console.error(err);
    cockpitOpen = false;
    setRunning(wasRunning);
    toast('3B görünüm açılamadı: ' + err.message, true);
  } finally {
    loading.remove();
  }
}
$('btnCockpit').onclick = () => openCockpit('single');
$('btnCockpitTop5').onclick = () => openCockpit('top5');
$('btnCockpitHeat').onclick = () => openCockpit('heat');

// ---------- klavye ----------
window.addEventListener('keydown', (e) => {
  if (cockpitOpen) return;
  if (e.target.matches('input[type=text], select')) return;
  const k = e.key.toLowerCase();
  if (e.key === ' ') { e.preventDefault(); setRunning(!running); }
  else if (e.key === 'F3' || e.key === '`') { e.preventDefault(); $('dev').hidden = !$('dev').hidden; }
  else if (k >= '1' && k <= '6') setSpeed(['1', '2', '5', '10', '25', 'max'][+k - 1]);
  else if (k === 'i') { $('chkIso').checked = !$('chkIso').checked; renderer.setIso($('chkIso').checked); }
  else if (k === 'r') { view.rays = !view.rays; $('chkRays').checked = view.rays; }
  else if (k === 'f') { view.follow = !view.follow; $('chkFollow').checked = view.follow; }
  else if (k === 'h') { view.heatmap = !view.heatmap; $('chkHeat').checked = view.heatmap; }
  else if (k === 'n') trainer.forceEndGeneration();
  else if (k === 'v') openCockpit(e.shiftKey ? 'top5' : 'single');
  else if (k === 'b') openCockpit('heat');
  else if (k === 'e') openExperiments();
});

window.addEventListener('resize', () => renderer.resize());

// ---------- başlat ----------
$('selAlgo').innerHTML = Object.entries(ALGOS).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('');
fillTrackSelect(trackDef.id);
cfg.rules.timeLimitSec = autoTimeLimit(track);
buildRules();
buildReward();
buildPhysics();
buildCar();
buildAlgo();
$('inpSeed').value = randomSeed();
newTrainer();
setRunning(true);
renderer.resize();
renderer.fit();
requestAnimationFrame(frame);
checkSavedSession();

// Test / hata ayıklama kancası
window.__app = {
  get trainer() { return trainer; },
  get frames() { return frameNo; },
  setSpeed,
  setIso: (on) => { $('chkIso').checked = on; renderer.setIso(on); },
  openCockpit,
  get cockpitOpen() { return cockpitOpen; },
  setTrackById: (id) => { $('selTrack').value = id; $('selTrack').onchange(); },
  view,
  renderer,
  autosave: () => autosave(true),
  openExperiments,
  get pwa() { return pwa; },
  get wallSec() { return wallSec; },
};
