// Öğrenme duman testi (YAVAŞ, ~5–10 sn): GA sabit tohumla ovalde sınırlı nesil içinde bitirmeyi öğrenir
// ve zamanla tur süresi / bitirme oranı iyileşir. `npm run test:fast` bu testi atlar.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Trainer } from '../src/trainer.js';
import { TICK_RATE } from '../src/config.js';
import { builtinTrack, makeCfg, SLOW } from './_helpers.js';

const MAX_GENS = 40; // ilk bitiriş için üst sınır (tohum 1 ile şu an ~3. nesilde bitiriyor)

test('[yavaş] GA, ovalde sınırlı nesilde bitirmeyi öğrenir ve gelişir', SLOW, () => {
  const track = builtinTrack('oval');
  const tr = new Trainer({ cfg: makeCfg(track), track, algo: 'ga', carCount: 100, seed: 1 });
  let firstFinishGen = null;
  tr.on('generation', (e) => {
    if (firstFinishGen == null && e.finishers > 0) firstFinishGen = e.gen;
  });
  while (tr.generation <= MAX_GENS && firstFinishGen == null) tr.tick();
  assert.ok(firstFinishGen != null, `${MAX_GENS} nesilde hiçbir araç bitiremedi`);
  const firstLap = tr.bestEverLapTicks / TICK_RATE;

  // ilk bitirişten sonra 25 nesil daha
  const stop = tr.generation + 25;
  while (tr.generation < stop) tr.tick();
  const h = tr.history;
  const bestLap = tr.bestEverLapTicks / TICK_RATE;
  assert.ok(bestLap < firstLap, `tur süresi iyileşmeli (${firstLap.toFixed(2)} → ${bestLap.toFixed(2)} sn)`);
  const mean = (a) => a.reduce((s, e) => s + e.finishRate, 0) / a.length;
  const early = mean(h.slice(0, 5)), late = mean(h.slice(-5));
  assert.ok(late > early + 0.05, `bitirme oranı artmalı (%${(early * 100).toFixed(0)} → %${(late * 100).toFixed(0)})`);
  assert.ok(tr.idealLap && tr.idealLap <= bestLap + 1e-9, 'ideal tur (en iyi sektörler toplamı) en iyi turdan uzun olamaz');
});
