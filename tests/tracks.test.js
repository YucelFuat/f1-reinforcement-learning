// Pist analizi testleri: tüm yerleşik pistler kurulur, virajlar bulunur, DRS bölgeleri, sektörler, yükseklik.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TRACK_DEFS, Track, randomTrackDef } from '../src/track.js';
import { builtinTrack } from './_helpers.js';

test('yerleşik pist listesi beklenen pistleri içerir', () => {
  const ids = TRACK_DEFS.map((d) => d.id);
  for (const id of ['oval', 'kidney', 'technical', 'gp', 'austin']) assert.ok(ids.includes(id), `${id} eksik`);
  assert.equal(new Set(ids).size, ids.length, 'pist kimlikleri benzersiz olmalı');
});

for (const def of TRACK_DEFS) {
  test(`pist kurulur ve tutarlıdır: ${def.id}`, () => {
    const t = builtinTrack(def.id);
    assert.equal(t.id, def.id);
    assert.ok(t.n > 100, 'merkez çizgisi örnek sayısı');
    assert.ok(t.lengthMeters > 500 && t.lengthMeters < 8000, `uzunluk ${t.lengthMeters.toFixed(0)} m`);
    if (def.lengthMeters) assert.ok(Math.abs(t.lengthMeters - def.lengthMeters) < 1, 'gerçek pistte uzunluk tanımla aynı');
    // merkez çizgisinin tamamı pist içinde, duvara uzaklık ≈ yarı genişlik
    let minSdf = Infinity;
    for (let i = 0; i < t.n; i++) minSdf = Math.min(minSdf, t.sdfAt(t.cx[i], t.cy[i]));
    assert.ok(minSdf > t.halfWidth * 0.6, `merkez çizgisi duvara çok yakın (${minSdf.toFixed(1)} px)`);
    // ilerleme ızgarası merkez çizgisinde yay uzunluğunu verir
    for (let i = 5; i < t.n - 5; i += 7) assert.ok(Math.abs(t.sAt(t.cx[i], t.cy[i]) - i * t.ds) < 3 * t.ds, `sAt hatası (örnek ${i})`);
    // virajlar
    assert.ok(t.corners.length >= 2, 'en az iki viraj');
    for (let k = 1; k < t.corners.length; k++) assert.ok(t.corners[k].i > t.corners[k - 1].i, 'virajlar pist sırasına göre');
    for (const c of t.corners) assert.ok(c.radius > 0 && c.radius < 350, `viraj yarıçapı ${c.radius}`);
    for (let i = 0; i < t.n; i += 11) assert.ok(t.ncDist[i] >= 0, 'sonraki viraja uzaklık negatif olamaz');
    // sektörler
    const [a, b, c] = t.sectorFrac;
    assert.ok(a > 0 && a < b && b < 1 && c === 1, `sektör oranları ${t.sectorFrac}`);
    if (def.sectors) assert.deepEqual([a, b], def.sectors);
    // DRS bölgeleri en çok 2, her biri ≥ 200 m
    assert.ok(t.drsZones.length <= 2);
    for (const z of t.drsZones) assert.ok(z.lengthM > 200, `DRS bölgesi ${z.lengthM} m`);
    // eğim dizisi sonlu
    for (let i = 0; i < t.n; i += 13) assert.ok(Number.isFinite(t.grade[i]));
  });
}

test('Austin (COTA): 5.513 km, iki DRS bölgesi, ~20 viraj, ~30 m yükseklik farkı', () => {
  const t = builtinTrack('austin');
  assert.ok(Math.abs(t.lengthMeters - 5513) < 1);
  assert.equal(t.drsZones.length, 2);
  const longest = Math.max(...t.drsZones.map((z) => z.lengthM));
  assert.ok(longest > 800, `en uzun DRS bölgesi (arka düzlük) ${longest.toFixed(0)} m`);
  assert.ok(t.corners.length >= 15 && t.corners.length <= 28, `${t.corners.length} viraj`);
  assert.ok(t.hasElevation);
  const range = Math.max(...t.elev) - Math.min(...t.elev);
  assert.ok(range > 20 && range < 40, `yükseklik farkı ${range.toFixed(1)} m`);
  // başlangıçtan T1'e tırmanış: ilk %12'de yükselir
  assert.ok(t.elevAt(0.12 * t.length) > t.elevAt(0) + 10, 'T1 tırmanışı');
  assert.equal(t.sectorFrac[2], 1);
});

test('kurgusal pistler kendisiyle kesişmez (validate)', () => {
  for (const id of ['oval', 'kidney', 'technical', 'gp']) assert.equal(builtinTrack(id).validate().ok, true, id);
});

test('rastgele pist: aynı tohum aynı pisti üretir, geçerli ve farklı tohum farklı', () => {
  const a = randomTrackDef(123), b = randomTrackDef(123), c = randomTrackDef(124);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a.points, c.points);
  assert.equal(new Track(a).validate().ok, true);
});

test('hız profili: virajda düzlükten yavaş, değerler pozitif ve sınırlı', () => {
  const t = builtinTrack('kidney');
  const P = { mass: 798, power: 750, cda: 1.45, cla: 4.4, mu: 1.72 };
  const v = t.speedProfile(P);
  assert.equal(v.length, t.n);
  const corner = t.corners[0];
  assert.ok(v[corner.i] < Math.max(...v));
  for (let i = 0; i < t.n; i += 9) assert.ok(v[i] > 0 && v[i] <= 100);
  assert.equal(t.speedProfile(P), v, 'aynı fizik için önbellekten dönmeli');
});
