// getState() → setState() gidiş-dönüş testi (tüm algoritmalar).
// A eğitilir; bir sınırda (nesil sonu / güncelleme anı) durum + simülasyon + RNG alınır. Farklı tohumla kurulan B'ye
// yüklenir; ikisi adım adım birlikte sürülür ve aksiyonlar, konumlar, fitness ve sonraki durum karşılaştırılır.
// Kullanım: node tools/algo-state-test.js [--algos ga,es,cmaes,ppo,ppoc,sac] [--track oval] [--cars 24]
import { defaultConfig, autoTimeLimit } from '../src/config.js';
import { TRACK_DEFS, Track } from '../src/track.js';
import { Trainer } from '../src/trainer.js';
import { ALGOS } from '../src/algos/index.js';

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const algos = (args.algos || 'ga,es,cmaes,ppo,ppoc,sac').split(',');
const track = new Track(TRACK_DEFS.find((t) => t.id === (args.track || 'oval')));
const cars = +(args.cars || 24);

function snapshotSim(sim) {
  const s = {};
  for (const [k, v] of Object.entries(sim)) {
    if (k === 'track' || k === 'cfg' || k === 'rng' || typeof v === 'function') continue;
    if (ArrayBuffer.isView(v)) s[k] = v.slice();
    else if (Array.isArray(v)) s[k] = v.slice();
    else if (v && typeof v === 'object') s[k] = structuredClone(v);
    else s[k] = v;
  }
  return s;
}
function restoreSim(sim, s) {
  for (const [k, v] of Object.entries(s)) {
    if (ArrayBuffer.isView(v)) sim[k].set(v);
    else if (Array.isArray(v)) sim[k] = v.slice();
    else if (v && typeof v === 'object') sim[k] = structuredClone(v);
    else sim[k] = v;
  }
}
function eqArr(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && !(Number.isNaN(a[i]) && Number.isNaN(b[i]))) return false;
  return true;
}
// iki durum nesnesini (iç içe typed array'ler) karşılaştır
function eqState(a, b, path = '') {
  if (ArrayBuffer.isView(a) || Array.isArray(a)) return eqArr(a, b) ? null : path;
  if (a && typeof a === 'object') {
    for (const k of Object.keys(a)) {
      const r = eqState(a[k], b?.[k], path + '.' + k);
      if (r) return r;
    }
    return null;
  }
  return a === b || (Number.isNaN(a) && Number.isNaN(b)) ? null : path;
}

function makeCfg(algo) {
  const cfg = defaultConfig();
  cfg.rules.timeLimitSec = Math.min(30, autoTimeLimit(track));
  if (ALGOS[algo].defaults) cfg[algo] = structuredClone(ALGOS[algo].defaults);
  if (algo === 'sac') Object.assign(cfg.sac, { warmup: 500, gradSteps: 4, updateEvery: 16, hidden: [16, 16] });
  if (algo === 'ppoc') Object.assign(cfg.ppoc, { rollout: 8, maxBatch: 1024, minibatch: 256, hidden: [16, 16] });
  if (algo === 'ppo') Object.assign(cfg.ppo, { rollout: 16, maxBatch: 512, minibatch: 128, hidden: [16, 16] });
  return cfg;
}

let fails = 0;
for (const algo of algos) {
  const t0 = performance.now();
  const cfg = makeCfg(algo);
  const A = new Trainer({ cfg, track, algo, carCount: cars, seed: 7 });
  const pop = A.isPopulation;
  let cap = null;
  const take = () => ({ S: structuredClone(A.algo.getState()), rng: [A.rng.s, A.rng._spare], sim: snapshotSim(A.sim) });
  if (pop) {
    A.on('generation', () => { if (!cap && A.generation > 3) cap = take(); });
  } else {
    const orig = A.algo.onUpdate;
    A.algo.onUpdate = (st) => { orig(st); if (!cap && A.algo.updates >= 3) cap = take(); };
  }
  let guard = 0;
  while (!cap && guard++ < 200000) A.tick();
  if (!cap) { console.log(`${algo}: HATA — yakalama noktasına ulaşılamadı`); fails++; continue; }
  const getMs = (() => { const t = performance.now(); for (let k = 0; k < 20; k++) A.algo.getState(); return (performance.now() - t) / 20; })();
  const bytes = JSON.stringify(cap.S, (k, v) => (ArrayBuffer.isView(v) ? { n: v.length * v.BYTES_PER_ELEMENT } : v)).length;
  let sizeB = 0;
  (function walk(o) { if (ArrayBuffer.isView(o)) sizeB += o.byteLength; else if (o && typeof o === 'object') for (const v of Object.values(o)) walk(v); })(cap.S);

  const B = new Trainer({ cfg: makeCfg(algo), track, algo, carCount: cars, seed: 99999 });
  const ok = B.algo.setState(structuredClone(cap.S));
  if (!ok) { console.log(`${algo}: HATA — setState false döndü`); fails++; continue; }
  // setState'e uyumsuz durum verilince false dönmeli
  const bad = structuredClone(cap.S);
  bad.sizes = [...bad.sizes.slice(0, -1), 99];
  const badOk = B.algo.setState(bad);
  if (badOk) { console.log(`${algo}: HATA — uyumsuz durum kabul edildi`); fails++; }
  // B'yi A'nın yakalama anına getir: aynı durum, aynı simülasyon, aynı RNG
  if (badOk === false) B.algo.setState(structuredClone(cap.S));
  restoreSim(B.sim, cap.sim);
  B.rng.s = cap.rng[0];
  B.rng._spare = cap.rng[1];
  if (!pop) B.algo.onUpdate = () => {};

  // A, yakalama anındaki adımı zaten tamamladı (sürekli algoritmalarda yakalama act() içinde olur).
  // B bu adımı şimdi atar; sonra ikisi birlikte ilerler.
  let firstDiff = -1;
  const steps = pop ? null : algo === 'sac' ? cfg.sac.updateEvery - 1 : 400;
  const cmpTick = (n) => {
    if (!eqArr(A.sim.actions, B.sim.actions) || !eqArr(A.sim.x, B.sim.x) || !eqArr(A.sim.fitness, B.sim.fitness)) {
      if (firstDiff < 0) firstDiff = n;
    }
  };
  if (pop) {
    // nüfus algoritmaları: yakalama nesil sonunda (sim sıfırlanmış) → bir nesil boyunca birlikte sür
    const g0 = A.generation;
    let n = 0;
    while (A.generation === g0) { A.tick(); B.tick(); cmpTick(n++); }
    const sA = A.algo.getState(), sB = B.algo.getState();
    const d = eqState(sA, sB);
    const pass = firstDiff < 0 && !d;
    if (!pass) fails++;
    console.log(`${algo.padEnd(6)} ${pass ? 'GEÇTİ' : 'KALDI'} · ${n} adım (1 nesil) birebir${firstDiff >= 0 ? ` DEĞİL (ilk fark ${firstDiff})` : ''} · sonraki durum ${d ? 'FARKLI ' + d : 'aynı'} · getState ${getMs.toFixed(2)} ms, ${(sizeB / 1024).toFixed(0)} KB · ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  } else {
    B.tick();
    cmpTick(0);
    const u0 = A.algo.updates;
    for (let n = 1; n <= steps; n++) { A.tick(); B.tick(); cmpTick(n); }
    let extra = '';
    if (algo !== 'sac') {
      // bir sonraki güncellemeye kadar sür → parametreler + Adam aynı olmalı
      while (A.algo.updates === u0) { A.tick(); B.tick(); cmpTick(steps + 1); }
      const d = eqState(A.algo.getState(), B.algo.getState());
      extra = ` · sonraki güncelleme sonrası durum ${d ? 'FARKLI ' + d : 'aynı'}`;
      if (d) fails++;
    } else extra = ' (tekrar belleği kaydedilmez → sonraki turdan sonra ayrışması beklenir)';
    const pass = firstDiff < 0;
    if (!pass) fails++;
    console.log(`${algo.padEnd(6)} ${pass ? 'GEÇTİ' : 'KALDI'} · ${steps + 1} adım aksiyonlar birebir${firstDiff >= 0 ? ` DEĞİL (ilk fark ${firstDiff})` : ''}${extra} · getState ${getMs.toFixed(2)} ms, ${(sizeB / 1024).toFixed(0)} KB · ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  }
  A.dispose();
  B.dispose();
}
console.log(fails ? `${fails} hata` : 'Tüm testler geçti');
process.exit(fails ? 1 : 0);
