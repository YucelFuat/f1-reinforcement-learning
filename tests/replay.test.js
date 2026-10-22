// Tekrar (replay) belirlenimciliği: GA ile sabit tohumla eğitilen rekor beyin tek başına yeniden sürüldüğünde
// eğitimdeki tur süresinin birebir aynısını yapmalı (3B tekrar ve veri dışa aktarma buna dayanır).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Trainer } from '../src/trainer.js';
import { simulateBrain, simulateBrains, FRAME_STRIDE, FR } from '../src/replay.js';
import { FINISHED } from '../src/sim.js';
import { TICK_RATE } from '../src/config.js';
import { builtinTrack, makeCfg } from './_helpers.js';

const track = builtinTrack('oval');

function trainGA(seed, gens, cars = 60) {
  const cfg = makeCfg(track);
  const tr = new Trainer({ cfg, track, algo: 'ga', carCount: cars, seed });
  while (tr.generation <= gens) tr.tick();
  return { tr, cfg };
}

test('GA rekor beyni yeniden sürülünce aynı tur süresini yapar', { timeout: 60000 }, () => {
  const { tr, cfg } = trainGA(7, 8);
  assert.ok(tr.bestLapBrain, '8 nesilde en az bir araç bitirmeli');
  const b = tr.bestLapBrain;
  assert.equal(b.lapTicks, tr.bestEverLapTicks);
  const rep = simulateBrain(track, cfg, b);
  assert.equal(rep.status, FINISHED);
  assert.equal(rep.lapTicks, b.lapTicks, `tekrar ${rep.lapTicks} adım, eğitim ${b.lapTicks} adım`);
  assert.equal(rep.crashes, 0);
  // kareler: ilk kare başlangıç, son kare bitiş
  assert.equal(rep.stride, FRAME_STRIDE);
  assert.equal(rep.frames.length, rep.count * FRAME_STRIDE);
  const lastT = rep.frames[(rep.count - 1) * FRAME_STRIDE + FR.time];
  assert.ok(Math.abs(lastT - b.lapTicks / TICK_RATE) < 1e-3);
  // ilk 5 listesindeki her sürüş de birebir tekrar edilmeli
  assert.ok(tr.topLaps.length >= 1);
  for (const t of tr.topLaps) {
    const r = simulateBrain(track, cfg, t);
    assert.equal(r.lapTicks, t.lapTicks, `ilk 5: ${r.lapTicks} ≠ ${t.lapTicks}`);
  }
});

test('tekrar belirlenimci: aynı beyin iki kez sürülünce kareler birebir aynı', { timeout: 60000 }, () => {
  const { tr, cfg } = trainGA(42, 4, 40);
  const brain = tr.bestLapBrain || tr.bestBrain;
  assert.ok(brain);
  const a = simulateBrain(track, cfg, brain);
  const b = simulateBrain(track, cfg, brain);
  assert.equal(a.count, b.count);
  assert.deepEqual(Array.from(a.frames), Array.from(b.frames));
});

test('çoklu tekrar (solo): araçlar birbirini etkilemez, her biri tek başına sürüşüyle aynı', { timeout: 60000 }, () => {
  const { tr, cfg } = trainGA(7, 8);
  const brains = tr.topLaps.slice(0, 3);
  if (brains.length < 2) return; // tek sürüş varsa karşılaştırılacak bir şey yok
  const multi = simulateBrains(track, cfg, brains, { race: false });
  brains.forEach((b, i) => assert.equal(multi[i].lapTicks, simulateBrain(track, cfg, b).lapTicks));
});
