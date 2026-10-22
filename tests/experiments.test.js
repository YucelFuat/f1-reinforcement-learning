// Deney yöneticisi yardımcıları: ayar farkı, düzleştirme, JSON dışa/içe aktarma, kayıt normalleştirme, geçmiş hizalama.
// (IndexedDB işlemleri tarayıcıda çalışır; burada saf fonksiyonlar test edilir.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig } from '../src/config.js';
import {
  diffConfigs, flattenConfig, formatValue, runsToJSON, runsFromJSON, makeRunRecord, slimHistory, mergeHistories,
  runningBestLap, defaultRunName, safeFileName, RUNS_FORMAT,
} from '../src/experiments.js';

function run(over = {}, mut) {
  const cfg = defaultConfig();
  if (mut) mut(cfg);
  return { name: 'deney', algo: 'ga', algoLabel: 'Genetik Algoritma', trackId: 'oval', trackName: 'Oval', seed: 1, carCount: 200, cfg, history: [], ...over };
}

test('flattenConfig: iç içe ayarlar nokta yoluyla, yalnızca deneyin kendi algoritma bölümü', () => {
  const cfg = defaultConfig();
  const f = flattenConfig(cfg, 'ga');
  assert.equal(f['physics.mu'], cfg.physics.mu);
  assert.equal(f['rules.laps'], 1);
  assert.equal(f['reward.crash'], cfg.reward.crash);
  assert.deepEqual(f['algo.hidden'], [16, 12]);
  assert.equal(f['algo.mutStd'], cfg.ga.mutStd);
  assert.ok(!Object.keys(f).some((k) => k.startsWith('es.') || k.startsWith('ppo.') || k.startsWith('ga.')), 'diğer algoritma bölümleri olmamalı');
  const g = flattenConfig(cfg, 'ppo');
  assert.equal(g['algo.lr'], cfg.ppo.lr);
});

test('diffConfigs: yalnızca farklı ayarlar, bölüm sırasına göre, değerler deney sırasında', () => {
  const a = run({ name: 'A' });
  const b = run({ name: 'B', seed: 2 }, (c) => {
    c.physics.mu = 2.0;
    c.rules.laps = 3;
    c.ga.mutStd = 0.3;
    c.ga.hidden = [32, 32];
  });
  const c = run({ name: 'C' });
  const rows = diffConfigs([a, b, c]);
  const keys = rows.map((r) => r.key);
  assert.deepEqual(keys, ['meta.seed', 'physics.mu', 'rules.laps', 'algo.hidden', 'algo.mutStd']);
  const mu = rows.find((r) => r.key === 'physics.mu');
  assert.deepEqual(mu.values, [defaultConfig().physics.mu, 2.0, defaultConfig().physics.mu]);
  assert.equal(mu.sectionLabel, 'Fizik');
  assert.equal(mu.name, 'mu');
  assert.equal(rows.find((r) => r.key === 'meta.seed').name, 'Tohum');
  assert.deepEqual(rows.find((r) => r.key === 'algo.hidden').values, [[16, 12], [32, 32], [16, 12]]);
  // aynı ayarlar → fark yok
  assert.deepEqual(diffConfigs([run(), run()]), []);
});

test('diffConfigs: farklı algoritmalar ve eksik alanlar', () => {
  const a = run({ name: 'GA' });
  const b = run({ name: 'ES', algo: 'es', algoLabel: 'Evolution Strategies' });
  delete b.cfg.car.drs; // eski kayıt
  const rows = diffConfigs([a, b]);
  const keys = rows.map((r) => r.key);
  assert.ok(keys.includes('meta.algo'));
  assert.ok(keys.includes('car.drs'));
  assert.equal(rows.find((r) => r.key === 'car.drs').values[1], undefined);
  assert.ok(keys.includes('algo.mutStd') && keys.includes('algo.sigma'), 'her deneyin kendi algoritma ayarları karşılaştırılır');
  assert.deepEqual(diffConfigs([a, b], { includeMeta: false }).filter((r) => r.section === 'meta'), []);
});

test('formatValue: okunur değer biçimleri', () => {
  assert.equal(formatValue(true), 'açık');
  assert.equal(formatValue(false), 'kapalı');
  assert.equal(formatValue(undefined), '–');
  assert.equal(formatValue(750), '750');
  assert.equal(formatValue(1.7), '1.7');
  assert.equal(formatValue(0.0003), '0.0003');
  assert.equal(formatValue([16, 12]), '16, 12');
  assert.equal(formatValue('zones'), 'zones');
});

test('makeRunRecord: geçmişi sadeleştirir, derin kopya alır, özet alanları doldurur', () => {
  const brain = { algo: 'ga', sizes: [25, 4, 2], params: new Float32Array([1, 2, 3]), outTanh: true };
  const history = [
    { gen: 1, best: 10, avg: 1, finishers: 0, finishRate: 0, bestLap: null, avgProgress: 0.1, extra: { mutStd: 0.1, big: new Float32Array(100) } },
    { gen: 2, best: 20, avg: 2, finishers: 3, finishRate: 0.15, bestLap: 31.5, avgProgress: 0.3, q: 0.4, sectors: [10, 11, 10.5] },
  ];
  const src = run({ history, bestLapBrain: brain, bestLapSec: 31.5, idealLapSec: 31, wallSec: 60, totalTicks: 5000, notes: 'not' });
  const rec = makeRunRecord(src);
  assert.equal(rec.history.length, 2);
  assert.equal(rec.history[0].extra, undefined, "algoritmaya özgü 'extra' atılmalı");
  assert.deepEqual(rec.history[1].sectors, [10, 11, 10.5]);
  assert.equal(rec.generations, 2);
  assert.equal(rec.finishRate, 0.15);
  assert.ok(rec.bestLapBrain.params instanceof Float32Array);
  src.cfg.physics.mu = 9;
  brain.params[0] = 99;
  assert.notEqual(rec.cfg.physics.mu, 9, 'cfg kopyalanmalı');
  assert.equal(rec.bestLapBrain.params[0], 1, 'beyin kopyalanmalı');
  assert.equal(rec.notes, 'not');
  assert.ok(typeof rec.createdAt === 'number');
  assert.ok(makeRunRecord({ ...run(), name: '' }).name.length > 3, 'boş ada varsayılan ad verilmeli');
  assert.throws(() => makeRunRecord(null));
});

test('runsToJSON / runsFromJSON: typed array, ±Infinity ve iç içe yapılar korunur', () => {
  const r = makeRunRecord(run({
    name: 'Gidiş-dönüş ş ğ ı',
    bestLapBrain: { algo: 'ga', sizes: [25, 2], params: new Float32Array([0.5, -1.25, 3]), outTanh: true, meta: { fitness: -Infinity } },
    history: [{ gen: 1, best: -Infinity, finishRate: 0, bestLap: null }],
  }));
  r.id = 17;
  const text = runsToJSON([r]);
  const o = JSON.parse(text);
  assert.equal(o.format, RUNS_FORMAT);
  assert.equal(o.version, 1);
  const back = runsFromJSON(text);
  assert.equal(back.length, 1);
  const b = back[0];
  assert.equal(b.id, undefined, 'içe aktarılan kayıt yeni kimlik almalı');
  assert.equal(b.name, 'Gidiş-dönüş ş ğ ı');
  assert.ok(b.bestLapBrain.params instanceof Float32Array);
  assert.deepEqual(Array.from(b.bestLapBrain.params), [0.5, -1.25, 3]);
  assert.equal(b.bestLapBrain.meta.fitness, -Infinity);
  assert.equal(b.history[0].best, -Infinity);
  assert.deepEqual(b.cfg, r.cfg);
  // tek deney nesnesi ve dizi de kabul edilir
  assert.equal(runsFromJSON(JSON.stringify(run())).length, 1);
  assert.equal(runsFromJSON(JSON.stringify([run(), run()])).length, 2);
  assert.throws(() => runsFromJSON('{bozuk'), /JSON/);
  assert.throws(() => runsFromJSON('{"format":"baska"}'), /deney/);
});

test('slimHistory ve mergeHistories: nesil numarasına göre hizalama, eksikler null', () => {
  const r1 = { history: slimHistory([{ gen: 1, bestLap: null }, { gen: 2, bestLap: 30 }, { gen: 3, bestLap: 31 }, { gen: 4, bestLap: 28 }]) };
  const r2 = { history: [{ gen: 3, bestLap: 40 }, { gen: 5, bestLap: 35 }] };
  assert.deepEqual(runningBestLap(r1.history), [null, 30, 30, 28]);
  const m = mergeHistories([r1, r2], runningBestLap);
  assert.deepEqual(m.map((e) => e.gen), [1, 2, 3, 4, 5]);
  assert.deepEqual(m.map((e) => e.v), [[null, null], [30, null], [30, 40], [28, null], [null, 35]]);
  assert.deepEqual(mergeHistories([{ history: [] }], runningBestLap), []);
});

test('varsayılan ad ve güvenli dosya adı', () => {
  const n = defaultRunName({ algo: 'ga', algoLabel: 'Genetik Algoritma (Neuroevolution)', trackName: 'Böbrek (Orta)', createdAt: new Date(2026, 9, 22, 14, 5).getTime() });
  assert.equal(n, 'Genetik · Böbrek (Orta) · 22.10 14:05');
  assert.equal(safeFileName('Böbrek / Şişli: ıIğ'), 'Bobrek_Sisli_iIg');
  assert.equal(safeFileName(''), 'deney');
});
