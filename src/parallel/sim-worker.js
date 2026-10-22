// Çok çekirdekli simülasyon işçisi.
// Ana iş parçacığının SharedArrayBuffer'larındaki araç dizilerinden birkaç PARÇAYI (her biri ardışık araçlar)
// kendi çekirdeğinde sürer: sinir ağı ileri geçişi (popülasyon politikaları, tanh çıkış) + fizik adımı.
// Hangi parçanın hangi işçide olduğu ptrainer.js plan() ile belirlenir (yük dengesi: popülasyonun "ağır" başı
// küçük parçalarla dağıtılır). Her parça kendi küçük Simulation örneğidir; sonuçlar tek Simulation ile birebir aynı.
// Yarış modunda parçalar tam serilerden (heat) oluşur → seriler işçiler arasında bölünmez.
//
// Protokol (ana → işçi, her mesajda artan `id`):
//   init  {chunks:[[başlangıç, adet]…], N, arrays, track, cfg, seed, sliceMs, sync}  parçaları kur (paylaşımlı görünümler)
//   gen   {seq, spawn, sizes, outTanh, params, cfg}  yeni nesil: politikalar (parçaların sırasıyla) + parçaları sıfırla
//   allow {n, lease}  n adım izni (n = Infinity → `lease` ms boyunca sınırsız; ana döngü her kare yeniler)
//   stop  {}          izni sıfırla (nesli zorla bitirme / politikaları yeniden yükleme için bariyer)
//   cfg   {cfg}       fizik / kurallar / ödül / araç / sensör ayarları değişti
// İşçi → ana: rep {msg (işlenen son mesaj id), seq, idle, done, tick, alive, finished, crash, bs, path?, ticks, ms}
//             err {message, stack}

import { Simulation, RUNNING } from '../sim.js';
import { Track } from '../track.js';
import { RNG } from '../rng.js';
import { forward, maxWidth, paramCount } from '../nn.js';
import { OBS_SIZE } from '../config.js';

const NO_PATH = { length: 0, push() {} }; // 0 numaralı araç dışındaki parçalar iz biriktirmesin

let chunks = []; // { sim, start, pOff }
let cfg = null;
let sync = null; // Int32Array (SAB): Atomics ile bellek görünürlüğü (yazımlar → mesaj → okuma)
let params = null, sizes = null, P = 0, outTanh = true, bufA = null, bufB = null;
let seq = -1, lastMsg = 0;
let allow = 0, leaseEnd = 0;
let done = true;
let scheduled = false;
let pathSent = 0;
let sliceMs = 12;

// Kendi kendine devam: her dilimden sonra olay döngüsüne dönülür (gelen mesajlar işlenir), sonra sürülür.
// setTimeout(0) iç içe çağrıda ≥4 ms bekletir; MessageChannel beklemeden sıraya girer.
const loop = new MessageChannel();
loop.port1.onmessage = () => {
  scheduled = false;
  guard(work);
};
function schedule() {
  if (!scheduled) {
    scheduled = true;
    loop.port2.postMessage(0);
  }
}

function hasAllowance() {
  if (allow <= 0) return false;
  if (allow === Infinity && performance.now() > leaseEnd) {
    allow = 0; // ana döngü yenilemedi (duraklatıldı, kokpit açık, sekme gizli…)
    return false;
  }
  return true;
}

function canRun() {
  return chunks.length > 0 && !!params && !done && hasAllowance();
}

// Popülasyon politikası: her araç kendi ağıyla (ga.js / es.js / cmaes.js act() ile aynı)
function act(sim, pOff) {
  const n = sim.N, obs = sim.obs, acts = sim.actions, st = sim.status;
  for (let i = 0; i < n; i++) {
    if (st[i] !== RUNNING) continue;
    const out = forward(params, (pOff + i) * P, sizes, obs, i * OBS_SIZE, bufA, bufB, outTanh);
    acts[2 * i] = out[0];
    acts[2 * i + 1] = out[1];
  }
}

// Bir adım: bitmemiş her parça ilerler. Hepsi bittiyse false.
function stepAll(limit) {
  let any = false;
  for (let c = 0; c < chunks.length; c++) {
    const ch = chunks[c], sim = ch.sim;
    if (sim.alive <= 0 || sim.tick >= limit) continue;
    act(sim, ch.pOff);
    sim.step();
    any = true;
  }
  return any;
}

function work() {
  if (!canRun()) {
    report(0, 0);
    return;
  }
  const t0 = performance.now();
  const limit = chunks[0].sim.timeLimitTicks;
  let n = 0;
  while (hasAllowance()) {
    if (!stepAll(limit)) {
      done = true;
      break;
    }
    n++;
    allow--;
    if (performance.now() - t0 >= sliceMs) break;
  }
  if (!done && isDone()) done = true;
  report(n, performance.now() - t0);
  if (canRun()) schedule();
}

function isDone() {
  const limit = chunks[0].sim.timeLimitTicks;
  for (const ch of chunks) if (ch.sim.alive > 0 && ch.sim.tick < limit) return false;
  return true;
}

function report(ticks, ms) {
  const m = {
    type: 'rep', msg: lastMsg, seq, idle: !canRun(), done, ticks, ms,
    tick: 0, alive: 0, finished: 0, crash: 0, bs: [0, 0, 0],
  };
  const bs = m.bs;
  for (const ch of chunks) {
    const s = ch.sim;
    if (s.tick > m.tick) m.tick = s.tick;
    m.alive += s.alive;
    m.finished += s.finished;
    m.crash += s.crashEvents;
    for (let k = 0; k < 3; k++) if (s.bestSec[k] && (!bs[k] || s.bestSec[k] < bs[k])) bs[k] = s.bestSec[k];
    // 0 numaralı aracın izi (hayalet)
    if (ch.start === 0 && s.path.length > pathSent) {
      m.path = s.path.slice(pathSent);
      pathSent = s.path.length;
    }
  }
  if (sync) Atomics.add(sync, 0, 1);
  postMessage(m);
}

function applyCfg(c) {
  if (!c || !cfg) return;
  for (const k of Object.keys(c)) cfg[k] = c[k]; // her parçanın sim.cfg'si === cfg → bir sonraki adımda geçerli
}

function init(m) {
  const N = m.N, arrays = m.arrays;
  cfg = m.cfg;
  sliceMs = m.sliceMs || 12;
  // Pist: ana iş parçacığındaki Track örneğinin verisi (büyük ızgaralar paylaşımlı) + Track metotları.
  // Not: Object.assign(Object.create(...)) nesneyi yavaş (sözlük) moda düşürür; kopyanın prototipini değiştirmek hızlı tutar.
  const track = Object.setPrototypeOf(m.track, Track.prototype);
  chunks = [];
  let pOff = 0;
  m.chunks.forEach(([start, count], c) => {
    // Simulation'ın her dizisi için paylaşımlı görünüm: araç başına diziler parçaya göre, diğerleri (ısı haritası) tümüyle
    const alloc = (name, T, len) => {
      const a = arrays[name];
      if (!a) throw new Error(`Paylaşımlı dizi bulunamadı: ${name}`);
      if (a.type !== T.name) throw new Error(`Dizi tipi uyumsuz: ${name} (${a.type} ≠ ${T.name})`);
      if (len === a.len) return new T(a.sab, 0, len);
      const k = len / count;
      if (!Number.isInteger(k) || a.len !== N * k) throw new Error(`Dizi boyu uyumsuz: ${name} (${len} / ${a.len})`);
      return new T(a.sab, start * k * T.BYTES_PER_ELEMENT, len);
    };
    const sim = new Simulation(track, count, cfg, new RNG((m.seed + 7919 * c) >>> 0), { alloc, noReset: true });
    chunks.push({ sim, start, pOff });
    pOff += count;
  });
  params = null;
  seq = -1;
  done = true;
  allow = 0;
  pathSent = 0;
}

function gen(m) {
  if (!chunks.length) throw new Error('İşçi kurulmadan nesil geldi');
  applyCfg(m.cfg);
  sizes = m.sizes;
  outTanh = m.outTanh;
  P = paramCount(sizes);
  if (sizes[0] !== OBS_SIZE) throw new Error(`Ağ giriş boyu ${sizes[0]} ≠ gözlem boyu ${OBS_SIZE}`);
  const last = chunks[chunks.length - 1];
  if (m.params.length < (last.pOff + last.sim.N) * P) throw new Error('Politika parametreleri eksik');
  params = m.params;
  const w = maxWidth(sizes);
  if (!bufA || bufA.length < w) {
    bufA = new Float32Array(w);
    bufB = new Float32Array(w);
  }
  seq = m.seq;
  for (const ch of chunks) {
    ch.sim.resetAll(m.spawn);
    if (ch.start !== 0) ch.sim.path = NO_PATH;
  }
  pathSent = 0;
  done = false;
}

function guard(fn, arg) {
  try {
    fn(arg);
  } catch (err) {
    postMessage({ type: 'err', message: String((err && err.message) || err), stack: err && err.stack });
  }
}

function onMsg(m) {
  if (m.type === 'init') sync = m.sync;
  // ana iş parçacığının mesajdan önceki yazımları (nesil sıfırlama, ısı haritası) bu okumadan sonra görünür
  if (sync) Atomics.load(sync, 0);
  lastMsg = m.id;
  switch (m.type) {
    case 'init':
      init(m);
      break;
    case 'gen':
      gen(m);
      break;
    case 'allow':
      if (m.n === Infinity) {
        allow = Infinity;
        leaseEnd = performance.now() + (m.lease || 300);
      } else if (m.n > 0) {
        if (allow === Infinity) allow = 0;
        // birikmeyi sınırla: yavaş kalınırsa en çok ~2 karelik iş bekler
        allow = Math.min(allow + m.n, Math.max(2 * m.n, m.n + 4));
      }
      break;
    case 'stop':
      allow = 0;
      break;
    case 'cfg':
      applyCfg(m.cfg);
      break;
  }
  if (canRun()) schedule();
  else if (!scheduled) report(0, 0);
}

self.onmessage = (e) => guard(onMsg, e.data);
