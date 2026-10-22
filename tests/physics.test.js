// Fizik testleri: son hız, DRS, fren mesafesi, lastik/yakıt/ERS, kayma/spin, araç-araç teması,
// bitiş ve tur süresi, başlangıç modları, tohum ile tekrar üretilebilirlik.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TICK_RATE, ERS, physicsPreset, COMPOUNDS } from '../src/config.js';
import { RUNNING, CRASHED, FINISHED } from '../src/sim.js';
import { Trainer } from '../src/trainer.js';
import { builtinTrack, straightTrack, makeCfg, makeSim, placeCar, ruleDriver, histKey } from './_helpers.js';

// Düzlükte tam gaz: en yüksek hız (km/s), DRS'in açık kaldığı adım sayısı
function topSpeed(drs, seconds = 40) {
  const track = straightTrack();
  const cfg = makeCfg(null, (c) => {
    c.physics = physicsPreset('f1');
    c.rules.timeLimitSec = 400;
    c.car.drs = drs;
  });
  const sim = makeSim(track, 1, cfg);
  let vmax = 0, drsTicks = 0;
  for (let k = 0; k < seconds * TICK_RATE; k++) {
    sim.actions[0] = 0;
    sim.actions[1] = 1;
    sim.step();
    assert.equal(sim.status[0], RUNNING, `araç düzlükte elendi (adım ${k})`);
    vmax = Math.max(vmax, sim.spd[0]);
    drsTicks += sim.drsOpen[0];
  }
  return { kmh: vmax * 3.6, drsTicks, sim };
}

test('test pisti: uzun düzlük, iki DRS bölgesi, araç pist yönünde başlar', () => {
  const t = straightTrack();
  assert.ok(t.lengthMeters > 12000, 'pist yeterince uzun olmalı');
  assert.equal(t.drsZones.length, 2);
  assert.ok(Math.abs(t.startAngle) < 0.01, `başlangıç yönü düz olmalı (${t.startAngle})`);
});

test("F1 fiziği: düzlükte son hız gerçekçi aralıkta (300–370 km/s), DRS son hızı artırır", () => {
  const off = topSpeed('off');
  assert.ok(off.kmh > 300 && off.kmh < 370, `DRS'siz son hız ${off.kmh.toFixed(1)} km/s`);
  assert.equal(off.drsTicks, 0);
  const on = topSpeed('zones');
  assert.ok(on.drsTicks > 0, 'DRS bölgede açılmalı');
  assert.ok(on.kmh > off.kmh + 5, `DRS ile ${on.kmh.toFixed(1)} km/s, DRS'siz ${off.kmh.toFixed(1)} km/s`);
  assert.ok(on.kmh < 390, `DRS ile son hız makul olmalı (${on.kmh.toFixed(1)})`);
});

test('300 km/s\'den tam fren: 70–160 m ve 2–4.5 sn içinde durur, lastik ısınır, ERS şarj olur', () => {
  const track = straightTrack();
  const cfg = makeCfg(null, (c) => {
    c.rules.timeLimitSec = 400;
    c.car.drs = 'off';
  });
  const sim = makeSim(track, 1, cfg);
  placeCar(sim, 0, 1000, 300 / 3.6);
  const x0 = sim.x[0], y0 = sim.y[0], T0 = sim.tyreT[0], soc0 = sim.soc[0];
  let n = 0, Tmax = T0;
  while (sim.spd[0] > 0.5 && n < 1200) {
    sim.actions[0] = 0;
    sim.actions[1] = -1;
    sim.step();
    n++;
    Tmax = Math.max(Tmax, sim.tyreT[0]);
    assert.equal(sim.status[0], RUNNING, 'frenlerken elenmemeli');
  }
  const dist = Math.hypot(sim.x[0] - x0, sim.y[0] - y0) * track.mpp;
  const sec = n / TICK_RATE;
  assert.ok(dist > 70 && dist < 160, `fren mesafesi ${dist.toFixed(1)} m`);
  assert.ok(sec > 2 && sec < 4.5, `fren süresi ${sec.toFixed(2)} sn`);
  assert.ok(Tmax > T0 + 2, `ağır frende lastik ısınmalı (${T0} → ${Tmax.toFixed(1)} °C)`);
  assert.ok(sim.soc[0] > soc0, 'frenden ERS şarjı olmalı');
  assert.ok(sim.lapHarv[0] <= ERS.harvestLapJ + 1, 'tur başına şarj sınırı aşılmamalı');
});

test('bir tur boyunca: lastik ısınır, aşınma artar, yakıt azalır, ERS şarjı [0, 4 MJ] içinde kalır', () => {
  const track = builtinTrack('oval');
  const cfg = makeCfg(track);
  const sim = makeSim(track, 1, cfg, 3);
  const T0 = sim.tyreT[0], F0 = sim.fuel[0];
  assert.equal(T0, cfg.car.startTemp);
  assert.equal(sim.soc[0], ERS.storeJ, 'duran başlangıçta batarya dolu');
  let Tmax = T0, wearPrev = 0, minSoc = Infinity, maxSoc = -Infinity, deployed = false;
  while (sim.status[0] === RUNNING) {
    ruleDriver(sim, 0);
    sim.step();
    Tmax = Math.max(Tmax, sim.tyreT[0]);
    assert.ok(sim.wear[0] >= wearPrev, 'aşınma azalmamalı');
    wearPrev = sim.wear[0];
    minSoc = Math.min(minSoc, sim.soc[0]);
    maxSoc = Math.max(maxSoc, sim.soc[0]);
    if (sim.ersKW[0] > 0) deployed = true;
  }
  assert.equal(sim.status[0], FINISHED, 'kural tabanlı sürücü ovali bitirmeli');
  assert.ok(Tmax > T0 + 5, `virajlarda lastik ısınmalı (${T0} → ${Tmax.toFixed(1)} °C)`);
  assert.ok(Tmax < 160, 'lastik sıcaklığı üst sınırı aşmamalı');
  assert.ok(sim.wear[0] > 0 && sim.wear[0] < 0.2, `bir turda aşınma ${sim.wear[0]}`);
  assert.ok(sim.fuel[0] < F0 && sim.fuel[0] >= 0, `yakıt ${F0.toFixed(3)} → ${sim.fuel[0].toFixed(3)} kg`);
  assert.ok(minSoc >= 0 && maxSoc <= ERS.storeJ, `ERS şarjı [${minSoc}, ${maxSoc}] J`);
  assert.ok(deployed, 'tam gazda ERS kullanılmalı');
});

test('aşınmış / soğuk lastik daha az tutar; yumuşak hamur ideal sıcaklıkta daha çok tutar', () => {
  const track = builtinTrack('oval');
  const sim = makeSim(track, 3, makeCfg(track));
  sim.tyreT[0] = COMPOUNDS.medium.topt;
  sim.tyreT[1] = COMPOUNDS.medium.topt;
  sim.wear[1] = 0.9;
  sim.tyreT[2] = 30;
  const g0 = sim._gripFactor(0), g1 = sim._gripFactor(1), g2 = sim._gripFactor(2);
  assert.ok(g1 < g0, 'aşınmış lastik daha az tutmalı');
  assert.ok(g2 < g0, 'soğuk lastik daha az tutmalı');
  sim.comp[0] = 0; // yumuşak
  sim.tyreT[0] = COMPOUNDS.soft.topt;
  assert.ok(sim._gripFactor(0) > g0);
});

test('yüksek hızda tam direksiyon: lastikler kayar, araç dönemez ve duvara gider', () => {
  const track = straightTrack();
  const sim = makeSim(track, 1, makeCfg(null, (c) => (c.rules.timeLimitSec = 400)));
  placeCar(sim, 0, 1000, 250 / 3.6);
  let maxSlip = 0, n = 0;
  const a0 = sim.ang[0];
  for (; n < 240 && sim.status[0] === RUNNING; n++) {
    sim.actions[0] = 1;
    sim.actions[1] = 0;
    sim.step();
    maxSlip = Math.max(maxSlip, sim.slip[0]);
  }
  assert.ok(maxSlip >= 0.9, `kayma oranı ${maxSlip.toFixed(2)}`);
  assert.equal(sim.status[0], CRASHED, 'tutuş sınırını aşan araç pistte kalamamalı');
  // komut edilen dönüş hızına (v / 7 m) ulaşamaz: 1 sn'de en çok birkaç radyan değil, çok daha az döner
  const turned = Math.abs(sim.ang[0] - a0);
  assert.ok(turned < 1.5, `gerçek dönüş ${turned.toFixed(2)} rad`);
});

test('yavaş virajda tam gaz + tam direksiyon: arka kayar (güç ile savrulma, β büyür)', () => {
  const track = straightTrack();
  const sim = makeSim(track, 1, makeCfg(null, (c) => (c.rules.timeLimitSec = 400)));
  placeCar(sim, 0, 1000, 60 / 3.6);
  let maxBeta = 0;
  for (let n = 0; n < 120 && sim.status[0] === RUNNING; n++) {
    sim.actions[0] = 1;
    sim.actions[1] = 1;
    sim.step();
    maxBeta = Math.max(maxBeta, Math.abs(sim.beta[0]));
  }
  assert.ok(maxBeta > 0.2, `kayma açısı β = ${maxBeta.toFixed(2)} rad`);
});

test('spin: kayma açısı sınırı aşılınca spin sayılır ve araç çarpmış sayılır', () => {
  const track = straightTrack();
  const sim = makeSim(track, 1, makeCfg(null, (c) => (c.rules.timeLimitSec = 400)));
  placeCar(sim, 0, 1000, 120 / 3.6);
  sim.beta[0] = 0.7; // SPIN_BETA (0.55 rad) üstü (adım içindeki toparlanmadan sonra da)
  sim.actions[0] = 0;
  sim.actions[1] = 0;
  sim.step();
  assert.equal(sim.spins[0], 1);
  assert.equal(sim.crashes[0], 1);
  assert.equal(sim.status[0], CRASHED);
  assert.ok(sim.fitness[0] < 0, 'spin cezalandırılmalı');
});

test('yarış modu: arkadan vuran araç yavaşlar ve ceza alır, öndeki daha az ceza alır', () => {
  const track = straightTrack();
  const mk = (mode) => {
    const cfg = makeCfg(null, (c) => {
      c.rules.timeLimitSec = 400;
      c.rules.mode = mode;
      c.rules.heatSize = 2;
      c.rules.maxCrashes = 5;
      c.car.drs = 'off';
    });
    const sim = makeSim(track, 2, cfg);
    // 0: önde 40 m/s, 1: tam 4 m geride 48 m/s (ızgaradaki gibi geride başlayanın goalOff'u var)
    placeCar(sim, 0, 1000, 40);
    const a = sim.ang[0], back = 4 / track.mpp;
    sim.resetCar(1, { x: sim.x[0] - Math.cos(a) * back, y: sim.y[0] - Math.sin(a) * back, a, v: 48, flying: true, goalOff: back });
    sim.computeObs();
    return sim;
  };
  const solo = mk('solo');
  const race = mk('race');
  assert.ok(race.race, 'yarış modu açık olmalı');
  for (const s of [solo, race]) {
    s.actions.fill(0);
    s.step();
  }
  assert.equal(solo.contacts[1], 0, 'solo modda araçlar birbirinden geçer');
  assert.ok(race.contacts[1] >= 1 && race.contacts[0] >= 1, 'temas sayılmalı');
  assert.ok(race.spd[1] < solo.spd[1] - 3, `arkadaki yavaşlamalı (yarış ${race.spd[1].toFixed(1)} / solo ${solo.spd[1].toFixed(1)} m/s)`);
  assert.ok(race.spd[1] <= race.spd[0] + 1e-3, 'arkadaki öndekinin hızını aşmamalı');
  const penBack = solo.fitness[1] - race.fitness[1];
  const penFront = solo.fitness[0] - race.fitness[0];
  assert.ok(penBack > 20, `arkadakinin cezası ${penBack.toFixed(1)}`);
  assert.ok(penFront > 0 && penFront < penBack, `öndekinin cezası ${penFront.toFixed(1)} (arkadakinden az)`);
});

test('bitiş algılama ve tur süresi: bitiren aracın süresi, ödülü ve durumu tutarlı', () => {
  const track = builtinTrack('oval');
  const cfg = makeCfg(track);
  const sim = makeSim(track, 1, cfg, 3);
  let last = 0;
  while (sim.status[0] === RUNNING) {
    ruleDriver(sim, 0);
    sim.step();
    if (sim.status[0] === RUNNING) last = sim.progress[0];
  }
  assert.equal(sim.status[0], FINISHED);
  assert.equal(sim.finished, 1);
  assert.equal(sim.alive, 0);
  assert.equal(sim.lapsDone[0], 1);
  assert.equal(sim.lapTicks[0], sim.ticks[0], 'tur süresi bitiş anındaki adım sayısı');
  assert.equal(sim.bestLapT[0], sim.lapTicks[0], 'duran başlangıçta en iyi tur = tur süresi');
  assert.ok(sim.progress[0] >= track.length && last < track.length, 'bitiş, tam tur tamamlanınca algılanmalı');
  const sec = sim.lapTicks[0] / TICK_RATE;
  const avgKmh = (track.lengthMeters / sec) * 3.6;
  assert.ok(avgKmh > 60 && avgKmh < 300, `ortalama hız ${avgKmh.toFixed(0)} km/s (${sec.toFixed(2)} sn)`);
  const secSum = sim.secTimes[0] + sim.secTimes[1] + sim.secTimes[2];
  assert.ok(Math.abs(secSum - sim.lapTicks[0]) <= 1, `sektör toplamı ${secSum} ≈ tur ${sim.lapTicks[0]}`);
  assert.ok(sim.fitness[0] > cfg.reward.finish, 'bitirme ödülü eklenmeli');
});

test("başlangıç modları: 'start' tüm araçlar start çizgisinde duruyor, 'random' pistte uçan başlangıç", () => {
  const track = builtinTrack('kidney');
  const s1 = makeSim(track, 8, makeCfg(track, (c) => (c.rules.spawn = 'start')), 5);
  for (let i = 0; i < 8; i++) {
    assert.equal(s1.x[i], Math.fround(track.startX));
    assert.equal(s1.y[i], Math.fround(track.startY));
    assert.equal(s1.spd[i], 0);
    assert.equal(s1.flying[i], 0);
  }
  assert.equal(s1.spawnInfo.flying, false);

  const s2 = makeSim(track, 8, makeCfg(track, (c) => (c.rules.spawn = 'random')), 5);
  const spots = new Set();
  for (let g = 0; g < 5; g++) {
    if (g) s2.resetAll();
    assert.equal(s2.spawnInfo.flying, true);
    spots.add(Math.round(s2.spawnInfo.s));
    for (let i = 0; i < 8; i++) {
      assert.equal(s2.flying[i], 1);
      assert.ok(s2.spd[i] > 0, 'uçan başlangıçta araç hızlı olmalı');
      assert.equal(s2.x[i], s2.x[0], 'popülasyonda tüm araçlar aynı noktadan başlar');
      assert.ok(track.sdfAt(s2.x[i], s2.y[i]) > 0, 'başlangıç pist içinde olmalı');
      assert.equal(s2.soc[i], ERS.storeJ * 0.75);
    }
  }
  assert.ok(spots.size >= 4, 'her nesil farklı bir noktadan başlamalı');
  // tek araç yeniden doğma (PPO/SAC)
  s2.respawnCar(3);
  assert.equal(s2.flying[3], 1);
  assert.ok(s2.spd[3] > 0);
});

test('aynı tohum ⇒ birebir aynı eğitim; farklı tohum ⇒ farklı', () => {
  const track = builtinTrack('oval');
  const run = (seed) => {
    const tr = new Trainer({ cfg: makeCfg(track), track, algo: 'ga', carCount: 40, seed });
    while (tr.generation <= 4) tr.tick();
    return tr;
  };
  const a = run(42), b = run(42), c = run(43);
  assert.deepEqual(a.history.map(histKey), b.history.map(histKey));
  assert.equal(a.totalTicks, b.totalTicks);
  assert.deepEqual(Array.from(a.algo.params), Array.from(b.algo.params));
  assert.deepEqual(Array.from(a.sim.x), Array.from(b.sim.x));
  assert.notDeepEqual(Array.from(a.algo.params), Array.from(c.algo.params));
});
