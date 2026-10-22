// Bir veya birden çok beyni pistte yeniden sürdürür ve her adımı kaydeder.
// GA/ES/CMA-ES deterministiktir → eğitimdeki rekor sürüşün birebir aynısı elde edilir.
// PPO/SAC olasılıksal olduğu için tekrar, en olası aksiyonla (deterministik) yapılır.
// Çoklu tekrar: 'solo' (araçlar birbirini görmez, hayalet gibi) veya 'race' (seri tekrarı: temas ve sollama).

import { Simulation, RUNNING } from './sim.js';
import { forward, maxWidth } from './nn.js';
import { OBS_SIZE, DISCRETE_ACTIONS, RAY_ANGLES_DEG, completeConfig, completePhysics } from './config.js';
import { RNG } from './rng.js';
import { upgradeBrain } from './brain.js';

// Kare düzeni (her adım):
export const FR = {
  x: 0, y: 1, ang: 2, spd: 3, steerCmd: 4, thr: 5, progress: 6, steerPos: 7, slip: 8,
  beta: 9, tyreT: 10, wear: 11, fuel: 12, soc: 13, drs: 14, ersKW: 15, time: 16, lap: 17, comp: 18, status: 19,
  rays: 20,
};
export const FRAME_STRIDE = FR.rays + RAY_ANGLES_DEG.length;

function brainConfig(cfg, brain) {
  const c = completeConfig(JSON.parse(JSON.stringify(cfg)));
  if (brain.physics) c.physics = completePhysics({ ...brain.physics });
  if (brain.car) c.car = { ...c.car, ...brain.car };
  if (brain.sensors) c.sensors = { ...c.sensors, ...brain.sensors };
  if (brain.rules) c.rules = { ...c.rules, ...brain.rules };
  c.rules.startJitter = 0;
  c.rules.spawn = 'start';
  if (brain.laps) c.rules.laps = brain.laps;
  return c;
}

function pushFrame(sim, i, out) {
  out.push(
    sim.x[i], sim.y[i], sim.ang[i], sim.spd[i], sim.actions[2 * i], sim.actions[2 * i + 1], sim.progress[i] - sim.goalOff[i], sim.steerPos[i], sim.slip[i],
    sim.beta[i], sim.tyreT[i], sim.wear[i], sim.fuel[i], sim.soc[i], sim.drsOpen[i], sim.ersKW[i], sim.ticks[i] / 60, sim.lapsDone[i], sim.comp[i], sim.status[i],
  );
  const b = i * OBS_SIZE;
  for (let r = 0; r < RAY_ANGLES_DEG.length; r++) out.push(sim.obs[b + r]);
}

function act(sim, i, brain, bufA, bufB) {
  const out = forward(brain.params, 0, brain.sizes, sim.obs, i * OBS_SIZE, bufA, bufB, brain.outTanh);
  if (brain.discrete) {
    let a = 0;
    for (let k = 1; k < brain.sizes[brain.sizes.length - 1]; k++) if (out[k] > out[a]) a = k;
    sim.actions[2 * i] = DISCRETE_ACTIONS[a][0];
    sim.actions[2 * i + 1] = DISCRETE_ACTIONS[a][1];
  } else {
    // squash: ağ çıkışı ham ortalamaysa (ör. Gauss politikası) tanh ile [-1,1]'e sıkıştır
    const a0 = brain.squash ? Math.tanh(out[0]) : out[0];
    const a1 = brain.squash ? Math.tanh(out[1]) : out[1];
    sim.actions[2 * i] = Math.max(-1, Math.min(1, a0));
    sim.actions[2 * i + 1] = Math.max(-1, Math.min(1, a1));
  }
}

// brains: beyin listesi. opts.race = true → aynı seride yarış (temas/sollama), aksi halde birbirinden bağımsız.
export function simulateBrains(track, cfg, brains, opts = {}) {
  const list = brains.map(upgradeBrain);
  const c = brainConfig(cfg, list[0]);
  c.rules.mode = opts.race && list.length > 1 ? 'race' : 'solo';
  c.rules.heatSize = list.length;
  const n = list.length;
  const sim = new Simulation(track, n, c, new RNG(opts.seed ?? 1));
  for (let i = 0; i < n; i++) {
    const b = list[i];
    if (b.start) sim.resetCar(i, b.start);
    else sim.resetCar(i, { x: track.startX, y: track.startY, a: track.startAngle, v: 0 });
    // her aracın kendi araç ayarı (lastik hamuru vb.)
    if (b.car && b.car.compound) {
      const k = ['soft', 'medium', 'hard'].indexOf(b.car.compound);
      if (k >= 0) sim.comp[i] = k;
    }
  }
  sim.computeObs();
  const w = Math.max(...list.map((b) => maxWidth(b.sizes)));
  const bufA = new Float32Array(w), bufB = new Float32Array(w);
  const frames = list.map(() => []);
  const ended = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) pushFrame(sim, i, frames[i]);
  const limit = sim.timeLimitTicks + 600;
  while (sim.alive > 0 && sim.tick < limit) {
    for (let i = 0; i < n; i++) if (sim.status[i] === RUNNING) act(sim, i, list[i], bufA, bufB);
    sim.step();
    for (let i = 0; i < n; i++) {
      if (ended[i] >= 0) continue;
      pushFrame(sim, i, frames[i]);
      if (sim.status[i] !== RUNNING) ended[i] = sim.tick;
    }
  }
  return list.map((b, i) => ({
    frames: Float32Array.from(frames[i]),
    count: frames[i].length / FRAME_STRIDE,
    status: sim.status[i],
    ticks: sim.ticks[i],
    lapTicks: sim.lapTicks[i],
    crashes: sim.crashes[i],
    spins: sim.spins[i],
    contacts: sim.contacts[i],
    overtakes: sim.overtakes[i],
    place: sim.place[i],
    goal: track.length * c.rules.laps,
    laps: c.rules.laps,
    discrete: !!b.discrete,
    algo: b.algo,
    meta: b.meta || null,
    obsSize: OBS_SIZE,
    stride: FRAME_STRIDE,
    car: { ...c.car, ...(b.car || {}) },
    label: b.label || null,
  }));
}

export function simulateBrain(track, cfg, brain) {
  return simulateBrains(track, cfg, [brain])[0];
}
