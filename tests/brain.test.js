// Beyin sürüm yükseltme testi (src/brain.js): 15 girdili eski beyin 25 girdiye genişletildiğinde,
// yeni girdiler ne olursa olsun çıkışlar birebir aynı kalmalı.
import test from 'node:test';
import assert from 'node:assert/strict';
import { upgradeBrain } from '../src/brain.js';
import { forward, paramCount, initParams, maxWidth } from '../src/nn.js';
import { OBS_SIZE, OBS_SIZE_V1 } from '../src/config.js';
import { RNG } from '../src/rng.js';

const rng = new RNG(2024);
function randomParams(sizes, scale = 1) {
  const p = new Float32Array(paramCount(sizes));
  initParams(p, 0, sizes, rng, scale);
  // biaslar da sıfır olmasın
  for (let i = 0; i < p.length; i++) if (p[i] === 0) p[i] = rng.gauss() * 0.3;
  return p;
}
function run(params, sizes, input, outTanh) {
  const w = maxWidth(sizes);
  // forward ara belleği döndürür → yalnızca çıkış katmanı kadarını al
  return Array.from(forward(params, 0, sizes, input, 0, new Float32Array(w), new Float32Array(w), outTanh).subarray(0, sizes[sizes.length - 1]));
}
function randomObs(n) {
  const o = new Float32Array(n);
  for (let i = 0; i < n; i++) o[i] = rng.next() * 2 - 1;
  return o;
}

test('gözlem boyutları: eski 15, yeni 25', () => {
  assert.equal(OBS_SIZE_V1, 15);
  assert.equal(OBS_SIZE, 25);
});

test('GA/ES beyni (tanh çıkış): 15 → 25 girdi, yeni girdiler çıkışı değiştirmez', () => {
  const sizes = [15, 16, 12, 2];
  const old = { algo: 'ga', sizes, params: randomParams(sizes), outTanh: true, discrete: false };
  const snapshot = Float32Array.from(old.params);
  const up = upgradeBrain(old);
  assert.deepEqual(up.sizes, [25, 16, 12, 2]);
  assert.equal(up.upgradedFrom, 15);
  assert.equal(up.params.length, paramCount(up.sizes));
  assert.deepEqual(Array.from(old.params), Array.from(snapshot), 'eski beyin değişmemeli (kopya döner)');
  assert.deepEqual(old.sizes, [15, 16, 12, 2]);
  for (let trial = 0; trial < 50; trial++) {
    const o15 = randomObs(15);
    const o25 = new Float32Array(25);
    o25.set(o15);
    // yeni girdiler "herhangi bir şey": büyük, negatif, sıfır
    for (let i = 15; i < 25; i++) o25[i] = (rng.next() * 2 - 1) * (trial % 3 === 0 ? 1000 : 3);
    assert.deepEqual(run(up.params, up.sizes, o25, true), run(old.params, sizes, o15, true));
  }
});

test('PPO beyni: politika ve değer ağı birlikte yükseltilir', () => {
  const sizes = [15, 32, 32, 9], sizesV = [15, 32, 32, 1];
  const old = { algo: 'ppo', sizes, params: randomParams(sizes), sizesV, vparams: randomParams(sizesV), discrete: true, outTanh: false };
  const up = upgradeBrain(old);
  assert.deepEqual(up.sizes, [25, 32, 32, 9]);
  assert.deepEqual(up.sizesV, [25, 32, 32, 1]);
  for (let trial = 0; trial < 20; trial++) {
    const o15 = randomObs(15), o25 = new Float32Array(25);
    o25.set(o15);
    for (let i = 15; i < 25; i++) o25[i] = rng.gauss() * 50;
    assert.deepEqual(run(up.params, up.sizes, o25, false), run(old.params, sizes, o15, false));
    assert.deepEqual(run(up.vparams, up.sizesV, o25, false), run(old.vparams, sizesV, o15, false));
  }
});

test('SAC Q ağı: girdi = gözlem + 2 aksiyon; genişletme ortadan yapılır, aksiyon ağırlıkları korunur', () => {
  const sizes = [15, 8, 2], sizesQ = [17, 16, 1];
  const old = { algo: 'sac', sizes, params: randomParams(sizes), sizesQ, qparams: randomParams(sizesQ), squash: true };
  const up = upgradeBrain(old);
  assert.deepEqual(up.sizesQ, [27, 16, 1]);
  for (let trial = 0; trial < 20; trial++) {
    const o15 = randomObs(15), act = randomObs(2);
    const q17 = new Float32Array(17);
    q17.set(o15);
    q17.set(act, 15);
    const q27 = new Float32Array(27);
    q27.set(o15);
    for (let i = 15; i < 25; i++) q27[i] = rng.gauss() * 10;
    q27.set(act, 25);
    assert.deepEqual(run(up.qparams, up.sizesQ, q27, false), run(old.qparams, sizesQ, q17, false));
  }
});

test('güncel boyuttaki beyin aynen döner; boş girdi güvenli', () => {
  const sizes = [25, 8, 2];
  const b = { sizes, params: randomParams(sizes), outTanh: true };
  const up = upgradeBrain(b);
  assert.deepEqual(up.sizes, sizes);
  assert.equal(up.params, b.params);
  assert.equal(up.upgradedFrom, undefined);
  assert.equal(upgradeBrain(null), null);
});
