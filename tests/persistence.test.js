// Kalıcılık testleri:
//  • her algoritma (ALGOS): getState → yapılandırılmış klon → farklı tohumlu yeni örnek → setState → aynı sonraki aksiyonlar
//  • src/persist.js: snapshotTrainer / restoreTrainer gidiş-dönüşü, GA'da kaldığı yerden birebir devam,
//    uyumsuz kayıtlar, 1000 araçta hız, applyConfig, klonlanamayan değerler
import test from 'node:test';
import assert from 'node:assert/strict';
import { ALGOS } from '../src/algos/index.js';
import { Trainer } from '../src/trainer.js';
import { defaultConfig, autoTimeLimit } from '../src/config.js';
import { TRACK_DEFS } from '../src/track.js';
import {
  snapshotTrainer, restoreTrainer, applyConfig, sanitizeForClone, describeSessionInfo, timeAgo, SNAPSHOT_FORMAT,
} from '../src/persist.js';
import { builtinTrack, snapshotSim, restoreSim, sameArray, histKey, stateDiff } from './_helpers.js';

const track = builtinTrack('oval');
const ovalDef = TRACK_DEFS.find((d) => d.id === 'oval');
const CARS = 24;

// Hızlı test için küçük ağlar / kısa rollout (tools/algo-state-test.js ile aynı)
function makeCfg(algo) {
  const cfg = defaultConfig();
  cfg.rules.timeLimitSec = Math.min(30, autoTimeLimit(track));
  if (ALGOS[algo].defaults) cfg[algo] = structuredClone(ALGOS[algo].defaults);
  if (algo === 'sac') Object.assign(cfg.sac, { warmup: 500, gradSteps: 4, updateEvery: 16, hidden: [16, 16] });
  if (algo === 'ppoc') Object.assign(cfg.ppoc, { rollout: 8, maxBatch: 1024, minibatch: 256, hidden: [16, 16] });
  if (algo === 'ppo') Object.assign(cfg.ppo, { rollout: 16, maxBatch: 512, minibatch: 128, hidden: [16, 16] });
  return cfg;
}

for (const algo of Object.keys(ALGOS)) {
  test(`algoritma durumu gidiş-dönüş: ${algo} (getState → setState → aynı sonraki aksiyonlar)`, { timeout: 60000 }, () => {
    const A = new Trainer({ cfg: makeCfg(algo), track, algo, carCount: CARS, seed: 7 });
    assert.equal(typeof A.algo.getState, 'function', 'getState eksik');
    assert.equal(typeof A.algo.setState, 'function', 'setState eksik');
    const pop = A.isPopulation;
    let cap = null;
    // yakalama: nesil sonu (popülasyon) veya güncelleme anı (sürekli) → durum + simülasyon + RNG
    const take = () => ({ S: structuredClone(A.algo.getState()), rng: [A.rng.s, A.rng._spare], sim: snapshotSim(A.sim) });
    if (pop) A.on('generation', () => { if (!cap && A.generation > 3) cap = take(); });
    else {
      const orig = A.algo.onUpdate;
      A.algo.onUpdate = (st) => { orig(st); if (!cap && A.algo.updates >= 2) cap = take(); };
    }
    let guard = 0;
    while (!cap && guard++ < 200000) A.tick();
    assert.ok(cap, 'yakalama noktasına ulaşılamadı');

    const B = new Trainer({ cfg: makeCfg(algo), track, algo, carCount: CARS, seed: 99999 });
    // uyumsuz durum (farklı ağ boyutu / farklı algoritma) reddedilmeli
    const bad = structuredClone(cap.S);
    bad.sizes = [...bad.sizes.slice(0, -1), 99];
    assert.equal(B.algo.setState(bad), false, 'uyumsuz boyut kabul edilmemeli');
    assert.equal(B.algo.setState({ ...structuredClone(cap.S), algo: algo === 'ga' ? 'es' : 'ga' }), false, 'başka algoritmanın durumu kabul edilmemeli');
    assert.equal(B.algo.setState(structuredClone(cap.S)), true, 'setState true dönmeli');
    restoreSim(B.sim, cap.sim);
    B.rng.s = cap.rng[0];
    B.rng._spare = cap.rng[1];
    if (!pop) B.algo.onUpdate = () => {};

    let firstDiff = -1;
    const cmp = (n) => {
      if (firstDiff < 0 && (!sameArray(A.sim.actions, B.sim.actions) || !sameArray(A.sim.x, B.sim.x) || !sameArray(A.sim.fitness, B.sim.fitness))) firstDiff = n;
    };
    if (pop) {
      // nesil sonunda yakalandı (simülasyon sıfırlanmış) → bir nesil boyunca birlikte sür, sonraki durum da aynı olmalı
      const g0 = A.generation;
      let n = 0;
      while (A.generation === g0 && n < 5000) { A.tick(); B.tick(); cmp(n++); }
      assert.equal(firstDiff, -1, `aksiyonlar ${firstDiff}. adımda ayrıştı`);
      // (nesil numarası hariç: B'nin Trainer sayacı bu testte geri yüklenmedi)
      const noGen = (h) => ({ ...histKey(h), gen: 0 });
      assert.deepEqual(noGen(A.history.at(-1)), noGen(B.history.at(-1)));
      const d = stateDiff(A.algo.getState(), B.algo.getState());
      assert.equal(d, null, `sonraki nesil durumu farklı: ${d}`);
    } else {
      // sürekli algoritmalarda yakalama act() içinde oldu: A bu adımı tamamladı, B şimdi atar
      B.tick();
      cmp(0);
      const steps = algo === 'sac' ? makeCfg('sac').sac.updateEvery - 1 : 200; // SAC tekrar belleği kaydedilmez
      for (let n = 1; n <= steps; n++) { A.tick(); B.tick(); cmp(n); }
      assert.equal(firstDiff, -1, `aksiyonlar ${firstDiff}. adımda ayrıştı`);
      if (algo !== 'sac') {
        // bir sonraki güncellemeye kadar birlikte sür → ağırlıklar + Adam aynı olmalı
        const u0 = A.algo.updates;
        let n = 0;
        while (A.algo.updates === u0 && n++ < 20000) { A.tick(); B.tick(); cmp(1000 + n); }
        assert.equal(firstDiff, -1, `aksiyonlar ${firstDiff}. adımda ayrıştı`);
        const d = stateDiff(A.algo.getState(), B.algo.getState());
        assert.equal(d, null, `sonraki güncelleme sonrası durum farklı: ${d}`);
      }
    }
    A.dispose();
    B.dispose();
  });
}

test('snapshotTrainer: yapılandırılmış klonlanabilir, gerekli alanları içerir', () => {
  const cfg = makeCfg('ga');
  const tr = new Trainer({ cfg, track, algo: 'ga', carCount: CARS, seed: 5 });
  while (tr.generation <= 3) tr.tick();
  const snap = snapshotTrainer({ trainer: tr, cfg, trackDef: ovalDef, algoName: 'ga', carCount: CARS, seed: 5, extra: { wallSec: 12, fn: () => 1 } });
  const clone = structuredClone(snap); // IndexedDB de yapılandırılmış klon kullanır
  assert.equal(clone.format, SNAPSHOT_FORMAT);
  assert.equal(clone.version, 1);
  assert.equal(clone.algoName, 'ga');
  assert.equal(clone.seed, 5);
  assert.equal(clone.carCount, CARS);
  assert.equal(clone.trackDef.id, 'oval');
  assert.deepEqual(clone.trackDef.points, ovalDef.points);
  assert.equal(clone.trainer.generation, tr.generation);
  assert.equal(clone.trainer.history.length, tr.history.length);
  assert.ok(clone.algoState.params instanceof Float32Array, 'typed array korunmalı');
  assert.equal(clone.extra.wallSec, 12);
  assert.equal(clone.extra.fn, undefined, 'fonksiyonlar atılmalı');
  assert.ok(clone.info && clone.info.step === tr.generation && clone.info.kind === 'population');
  // anlık görüntü canlı nesnelerden bağımsız (eğitim sürerken değişmemeli)
  const p0 = snap.algoState.params[0];
  const h0 = snap.trainer.history.length;
  while (tr.generation <= 5) tr.tick();
  assert.equal(snap.algoState.params[0], p0);
  assert.equal(snap.trainer.history.length, h0);
  snap.cfg.physics.mu = 99;
  assert.notEqual(cfg.physics.mu, 99, 'cfg derin kopyalanmalı');
});

test('restoreTrainer (GA): nesil ortasında kaydedilen eğitim kaldığı yerden birebir aynı devam eder', { timeout: 60000 }, () => {
  const cfgA = makeCfg('ga');
  const A = new Trainer({ cfg: cfgA, track, algo: 'ga', carCount: 40, seed: 11 });
  while (A.generation < 4) A.tick();
  for (let k = 0; k < 100; k++) A.tick(); // 4. neslin ortası
  const snap = structuredClone(snapshotTrainer({ trainer: A, cfg: cfgA, trackDef: ovalDef, algoName: 'ga', carCount: 40, seed: 11 }));
  while (A.generation < 8) A.tick();

  const cfgB = applyConfig(defaultConfig(), snap.cfg);
  const B = new Trainer({ cfg: cfgB, track, algo: snap.algoName, carCount: snap.carCount, seed: 424242 });
  assert.equal(restoreTrainer(B, snap), true);
  assert.equal(B.generation, 4);
  assert.equal(B.history.length, 3);
  while (B.generation < 8) B.tick();
  assert.deepEqual(B.history.map(histKey), A.history.map(histKey));
  assert.equal(B.bestEverLapTicks, A.bestEverLapTicks);
  assert.ok(sameArray(B.algo.params, A.algo.params), 'popülasyon birebir aynı olmalı');
});

test('restoreTrainer (PPO): ağırlıklar, Adam durumu ve sayaçlar geri gelir', { timeout: 60000 }, () => {
  const cfg = makeCfg('ppo');
  const A = new Trainer({ cfg, track, algo: 'ppo', carCount: CARS, seed: 3 });
  while (A.algo.updates < 3) A.tick();
  const snap = structuredClone(snapshotTrainer({ trainer: A, cfg, trackDef: ovalDef, carCount: CARS, seed: 3 }));
  assert.equal(snap.info.kind, 'continuous');
  assert.equal(snap.info.step, 3);
  const B = new Trainer({ cfg: applyConfig(defaultConfig(), snap.cfg), track, algo: 'ppo', carCount: CARS, seed: 1 });
  assert.equal(restoreTrainer(B, snap), true);
  assert.equal(B.algo.updates, 3);
  assert.equal(B.generation, 4);
  assert.equal(B.episodes, A.episodes);
  assert.deepEqual(B.history.map(histKey), A.history.map(histKey));
  const sa = A.algo.getState(), sb = B.algo.getState();
  assert.ok(sameArray(sa.learner.pi, sb.learner.pi));
  assert.ok(sameArray(sa.learner.adamPi.m, sb.learner.adamPi.m));
  assert.equal(sa.learner.adamPi.t, sb.learner.adamPi.t);
});

test('restoreTrainer: uyumsuz kayıt → algoritma durumu yüklenmez (false), geçmiş/rekorlar yine gelir', () => {
  const cfg = makeCfg('ga');
  const A = new Trainer({ cfg, track, algo: 'ga', carCount: CARS, seed: 2 });
  while (A.generation <= 3) A.tick();
  const snap = structuredClone(snapshotTrainer({ trainer: A, cfg, trackDef: ovalDef }));
  // farklı algoritma
  const E = new Trainer({ cfg: makeCfg('es'), track, algo: 'es', carCount: CARS, seed: 2 });
  assert.equal(restoreTrainer(E, snap), false);
  assert.equal(E.history.length, A.history.length);
  // farklı ağ boyutu
  const cfg2 = makeCfg('ga');
  cfg2.ga.hidden = [8];
  const G = new Trainer({ cfg: cfg2, track, algo: 'ga', carCount: CARS, seed: 2 });
  assert.equal(restoreTrainer(G, snap), false);
  // bozuk kayıt
  assert.throws(() => restoreTrainer(G, { format: 'baska' }), /Geçersiz/);
});

test('1000 araçlık GA: anlık görüntü + klon hızlı (< 250 ms)', { timeout: 60000 }, () => {
  const cfg = makeCfg('ga');
  const tr = new Trainer({ cfg, track, algo: 'ga', carCount: 1000, seed: 9 });
  for (let k = 0; k < 30; k++) tr.tick();
  const t0 = performance.now();
  const snap = snapshotTrainer({ trainer: tr, cfg, trackDef: ovalDef });
  const clone = structuredClone(snap);
  const ms = performance.now() - t0;
  assert.equal(clone.algoState.params.length, tr.algo.params.length);
  assert.ok(ms < 250, `${ms.toFixed(1)} ms`);
});

test('applyConfig: canlı cfg nesnesi yerinde güncellenir, eksik yeni alanlar varsayılandan gelir', () => {
  const live = defaultConfig();
  const rulesRef = live;
  const old = defaultConfig();
  old.physics.mu = 2.0;
  delete old.car.drs; // eski kayıtta olmayan alan
  old.ga.hidden = [8, 8];
  old.sac = { lr: 0.002 }; // varsayılanı ALGOS'tan gelen bölüm
  applyConfig(live, old);
  assert.equal(live, rulesRef);
  assert.equal(live.physics.mu, 2.0);
  assert.equal(live.car.drs, defaultConfig().car.drs);
  assert.deepEqual(live.ga.hidden, [8, 8]);
  assert.equal(live.sac.lr, 0.002);
  assert.equal(live.sac.batch, ALGOS.sac.defaults.batch);
  old.ga.hidden.push(4);
  assert.deepEqual(live.ga.hidden, [8, 8], 'kaynakla bağ kalmamalı');
});

test('sanitizeForClone ve oturum özeti metni', () => {
  const o = { a: 1, f: () => 2, t: new Float32Array([1, 2]), n: { g: Symbol('x'), k: [1, () => 3] } };
  const s = sanitizeForClone(o);
  assert.deepEqual(Object.keys(s), ['a', 't', 'n']);
  assert.ok(s.t instanceof Float32Array);
  assert.deepEqual(s.n, { k: [1, undefined] });
  structuredClone(s);
  const now = Date.now();
  assert.equal(timeAgo(now - 5000, now), 'az önce');
  assert.equal(timeAgo(now - 12 * 60000, now), '12 dk önce');
  assert.equal(timeAgo(now - 3 * 3600000, now), '3 sa önce');
  const txt = describeSessionInfo({ algoLabel: 'Genetik', trackName: 'Oval', kind: 'population', step: 12, carCount: 200, bestLapSec: 61.5, savedAt: now });
  assert.match(txt, /Genetik · Oval · Nesil 12 · 200 araç · en iyi tur 1:01\.500/);
});
