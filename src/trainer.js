// Eğitim döngüsü: simülasyon + öğrenme algoritması + istatistikler.
// DOM kullanmaz; tarayıcıda ve Node (headless) ortamında çalışır.

import { Simulation, RUNNING, FINISHED } from './sim.js';
import { ALGOS } from './algos/index.js';
import { RNG } from './rng.js';
import { TICK_RATE, OBS_SIZE } from './config.js';
import { blockScore } from './autotune.js';

export const ALGORITHMS = Object.fromEntries(Object.entries(ALGOS).map(([k, v]) => [k, v.label]));

export class Trainer {
  constructor({ cfg, track, algo = 'ga', carCount = 200, seed, useWorker = false }) {
    this.cfg = cfg;
    this.track = track;
    this.algoName = algo;
    this.carCount = carCount;
    this.useWorker = useWorker;
    this.seed = seed ?? ((Math.random() * 1e9) | 0);
    this.rng = new RNG(this.seed);
    this.listeners = { generation: [] };
    this._build();
  }

  _build() {
    const def = ALGOS[this.algoName] || ALGOS.ga;
    if (def.defaults && !this.cfg[this.algoName]) this.cfg[this.algoName] = structuredClone(def.defaults);
    const N = Math.max(def.minN || 1, this.carCount);
    this.sim = new Simulation(this.track, N, this.cfg, this.rng);
    this.algo = def.create(N, this.cfg, this.rng, { useWorker: this.useWorker });
    if (this.algo.kind !== 'population') this.algo.onUpdate = (stats) => this._onPPOUpdate(stats);
    this.generation = 1;
    this.totalTicks = 0;
    this.history = [];
    this.bestEverFitness = -Infinity;
    this.bestEverLapTicks = 0;
    this.bestBrain = null;
    this.bestLapBrain = null; // en iyi süreyi yapan aracın beyni (kokpit tekrarı için)
    this.topLaps = [];        // en iyi 5 farklı sürüş (çoklu tekrar için)
    this.records = [];        // rekor geçmişi (tur karşılaştırma için), en yeni sonda
    this.bestSectors = [0, 0, 0]; // tick
    this.bestHeat = null;     // yarış modu: en hızlı kazananın serisi (seri tekrarı için)
    this.ghost = null;
    this.lastGen = null;
    // PPO bölüm istatistikleri
    this.episodes = 0;
    this.epWindow = []; // {ret, fin, lap, prog}
    this.epSinceUpdate = { count: 0, best: -Infinity, fin: 0, bestLap: 0 };
  }

  on(ev, fn) {
    (this.listeners[ev] ||= []).push(fn);
  }

  _emit(ev, data) {
    for (const fn of this.listeners[ev] || []) fn(data);
  }

  get isPopulation() {
    return this.algo.kind === 'population';
  }

  // Bir simülasyon adımı. Algoritma beklemedeyse false döner.
  tick() {
    const sim = this.sim;
    if (!this.algo.act(sim)) return false;
    sim.step();
    this.totalTicks++;
    if (this.isPopulation) {
      if (sim.alive <= 0 || sim.tick >= sim.timeLimitTicks) this.endGeneration();
    } else {
      this.algo.record(sim);
      const N = sim.N;
      for (let i = 0; i < N; i++) {
        if (!sim.done[i]) continue;
        this._recordEpisode(i);
        sim.respawnCar(i);
        sim.alive++;
        sim._obsFor(i);
      }
    }
    return true;
  }

  _recordEpisode(i) {
    const sim = this.sim;
    const fin = sim.status[i] === FINISHED;
    const ret = sim.fitness[i];
    // uçan başlangıçlı (pist ortasından) sürüşler tur rekoru sayılmaz
    const lap = fin && !sim.flying[i] ? sim.lapTicks[i] : 0;
    const prog = sim.bestProg[i] / (this.track.length * this.cfg.rules.laps);
    this.episodes++;
    this.epWindow.push({ ret, fin, lap, prog });
    if (this.epWindow.length > 200) this.epWindow.shift();
    const e = this.epSinceUpdate;
    e.count++;
    if (ret > e.best) e.best = ret;
    if (fin) e.fin++;
    if (lap) {
      if (!e.bestLap || lap < e.bestLap) e.bestLap = lap;
      this._offerLap(i, ret, lap);
    }
    if (ret > this.bestEverFitness) {
      this.bestEverFitness = ret;
      this.bestBrain = { ...this.algo.brainOf(i), meta: this._meta(ret, lap) };
    }
    if (i === 0) {
      this.ghost = sim.path;
      sim.path = [];
    }
    if (fin) sim.finished--; // PPO'da 'finished' anlık sayaçtır
  }

  _onPPOUpdate(stats) {
    const w = this.epWindow;
    const n = w.length || 1;
    const avg = w.reduce((s, e) => s + e.ret, 0) / n;
    const finRate = w.filter((e) => e.fin).length / n;
    const avgProg = w.reduce((s, e) => s + e.prog, 0) / n;
    const e = this.epSinceUpdate;
    const entry = {
      gen: this.algo.updates,
      best: e.count ? e.best : (this.history.at(-1)?.best ?? 0),
      avg,
      finishers: e.fin,
      finishRate: finRate,
      bestLap: e.bestLap ? e.bestLap / TICK_RATE : null,
      avgProgress: avgProg,
      episodes: this.episodes,
      extra: stats,
    };
    this.history.push(entry);
    if (this.history.length > 3000) this.history.splice(0, this.history.length - 3000);
    this._mergeSectors(entry);
    this.lastGen = entry;
    this.generation = this.algo.updates + 1;
    this.epSinceUpdate = { count: 0, best: -Infinity, fin: 0, bestLap: 0 };
    this._emit('generation', entry);
  }

  _lapBrain(i, fitness, lapTicks) {
    const sim = this.sim;
    const sec = [sim.secTimes[i * 3], sim.secTimes[i * 3 + 1], sim.secTimes[i * 3 + 2]];
    return {
      ...this.algo.brainOf(i),
      meta: { ...this._meta(fitness, lapTicks), sectors: sec.map((t) => t / TICK_RATE), bestLapSec: sim.bestLapT[i] ? sim.bestLapT[i] / TICK_RATE : null },
      start: { x: sim.startX[i], y: sim.startY[i], a: sim.startA[i], v: sim.startV[i], flying: !!sim.flying[i], goalOff: sim.goalOff[i] },
      laps: this.cfg.rules.laps,
      // tekrar birebir aynı olsun diye o anki fizik, araç ve kurallar saklanır
      physics: { ...this.cfg.physics },
      car: { ...this.cfg.car },
      rules: { ...this.cfg.rules, mode: 'solo' },
      sensors: { ...this.cfg.sensors },
    };
  }

  // Bitiren bir aracın süresini rekor / ilk 5 listelerine teklif et
  _offerLap(i, fitness, lap) {
    const isRecord = !this.bestEverLapTicks || lap < this.bestEverLapTicks;
    const top = this.topLaps;
    const enters = top.length < 5 || lap < top[top.length - 1].lapTicks;
    if (!isRecord && !enters) return;
    if (top.some((t) => t.lapTicks === lap)) {
      if (!isRecord) return;
    }
    const b = this._lapBrain(i, fitness, lap);
    b.lapTicks = lap;
    // yarış modunda sürüş trafiğe göre öğrenildi → tekrarı kendi serisiyle birlikte yapılır
    if (this.sim.race && this.isPopulation) b.heat = this._heatSnapshot(i);
    if (isRecord) {
      this.bestEverLapTicks = lap;
      this.bestLapBrain = b;
      this.records.push(b);
      if (this.records.length > 12) this.records.shift();
    }
    if (enters && !top.some((t) => t.lapTicks === lap)) {
      top.push(b);
      top.sort((a, c) => a.lapTicks - c.lapTicks);
      if (top.length > 5) top.length = 5;
    }
  }

  _mergeSectors(entry) {
    const bs = this.sim.bestSec;
    entry.sectors = [bs[0] / TICK_RATE || null, bs[1] / TICK_RATE || null, bs[2] / TICK_RATE || null];
    for (let k = 0; k < 3; k++) {
      if (bs[k] && (!this.bestSectors[k] || bs[k] < this.bestSectors[k])) this.bestSectors[k] = bs[k];
    }
    if (!this.isPopulation) bs.fill(0);
  }

  // Sektör en iyilerinin toplamı (teorik en iyi tur, sn)
  get idealLap() {
    const b = this.bestSectors;
    return b[0] && b[1] && b[2] ? (b[0] + b[1] + b[2]) / TICK_RATE : null;
  }

  _meta(fitness, lapTicks) {
    return {
      fitness,
      lapSec: lapTicks ? lapTicks / TICK_RATE : null,
      track: this.track.name,
      trackId: this.track.id,
      generation: this.generation,
      date: new Date().toISOString(),
    };
  }

  endGeneration() {
    const sim = this.sim;
    const N = sim.N;
    const fit = sim.fitness;
    let bestI = 0, sum = 0, fin = 0, bestLap = 0, bestLapI = -1, progSum = 0, crashed = 0, spins = 0, contacts = 0, overtakes = 0;
    const flyingGen = !!sim.spawnInfo.flying;
    const lapsSorted = [];
    for (let i = 0; i < N; i++) {
      if (fit[i] > fit[bestI]) bestI = i;
      sum += fit[i];
      progSum += sim.bestProg[i];
      spins += sim.spins[i];
      contacts += sim.contacts[i];
      if (sim.overtakes[i] > 0) overtakes += sim.overtakes[i];
      if (sim.status[i] === FINISHED) {
        fin++;
        if (!flyingGen) {
          lapsSorted.push(i);
          if (!bestLap || sim.lapTicks[i] < bestLap) { bestLap = sim.lapTicks[i]; bestLapI = i; }
        }
      } else if (sim.status[i] === 1) crashed++;
    }
    const best = fit[bestI];
    if (best > this.bestEverFitness) {
      this.bestEverFitness = best;
      this.bestBrain = { ...this.algo.brainOf(bestI), meta: this._meta(best, sim.lapTicks[bestI]) };
    }
    if (bestLap) {
      const prevBest = this.bestEverLapTicks;
      lapsSorted.sort((a, b) => sim.lapTicks[a] - sim.lapTicks[b]);
      for (const i of lapsSorted.slice(0, 5)) this._offerLap(i, fit[i], sim.lapTicks[i]);
      if (sim.race && (!prevBest || bestLap < prevBest || !this.bestHeat)) this.bestHeat = this._heatSnapshot(bestLapI);
    }
    this.ghost = sim.path;

    // ödülden bağımsız nesil skoru (otomatik ayar bunu karşılaştırır)
    const goalPx = this.track.length * this.cfg.rules.laps;
    const progs = new Float32Array(N), laps = [];
    for (let i = 0; i < N; i++) {
      progs[i] = sim.bestProg[i] / goalPx;
      if (sim.status[i] === FINISHED) laps.push(sim.lapTicks[i]);
    }
    const q = blockScore(progs, laps, sim.timeLimitTicks);

    const info = this.algo.endGeneration(fit);
    const entry = {
      gen: this.generation,
      best,
      avg: sum / N,
      finishers: fin,
      finishRate: fin / N,
      crashed,
      bestLap: bestLap ? bestLap / TICK_RATE : null,
      avgProgress: progSum / N / (this.track.length * this.cfg.rules.laps),
      ticks: sim.tick,
      q,
      flying: flyingGen,
      spins,
      contacts: sim.race ? contacts / 2 : undefined,
      overtakes: sim.race ? overtakes : undefined,
      extra: info,
    };
    this._mergeSectors(entry);
    this.history.push(entry);
    if (this.history.length > 3000) this.history.splice(0, this.history.length - 3000);
    this.lastGen = entry;
    sim.decayHeat(0.8);
    sim.resetAll();
    this.generation++;
    this._emit('generation', entry);
  }

  // Yarış modu: bir serinin tüm beyinleri ve grid (seri tekrarı için)
  _heatSnapshot(winner) {
    const sim = this.sim;
    const [a, b] = sim.heatRange(winner);
    const cars = [];
    for (let i = a; i < b; i++) {
      cars.push({
        ...this._lapBrain(i, sim.fitness[i], sim.status[i] === FINISHED ? sim.lapTicks[i] : 0),
        place: sim.place[i],
        status: sim.status[i],
      });
    }
    return { cars, winner: winner - a, generation: this.generation, rules: { ...this.cfg.rules } };
  }

  // Kurallar (yarış modu/seri boyu) değişince simülasyonu yeniden kur
  rebuildSim() {
    const N = this.sim.N;
    this.sim = new Simulation(this.track, N, this.cfg, this.rng);
    if (!this.isPopulation) this.algo.t = 0;
  }

  // Popülasyon algoritmalarında nesli hemen bitir
  forceEndGeneration() {
    if (this.isPopulation) this.endGeneration();
  }

  // Şu an en önde (en yüksek anlık ödül) giden çalışan araç
  leaderIndex() {
    const sim = this.sim;
    let best = -1, bi = 0;
    for (let i = 0; i < sim.N; i++) {
      if (sim.status[i] !== RUNNING) continue;
      if (sim.fitness[i] > best || best === -1) { best = sim.fitness[i]; bi = i; }
    }
    return bi;
  }

  loadBrain(brain) {
    return this.algo.seed(brain);
  }

  setTrack(track) {
    this.track = track;
    const N = this.sim.N;
    this.sim = new Simulation(track, N, this.cfg, this.rng);
    if (!this.isPopulation) {
      this.algo.t = 0;
    }
    this.ghost = null;
    // süreler/ödüller pistler arasında karşılaştırılamaz → rekorları sıfırla (beyinler korunur)
    this.bestEverLapTicks = 0;
    this.bestLapBrain = null;
    this.bestEverFitness = -Infinity;
    this.bestBrain = null;
    this.topLaps = [];
    this.records = [];
    this.bestSectors = [0, 0, 0];
    this.bestHeat = null;
  }

  dispose() {
    if (this.algo.dispose) this.algo.dispose();
  }

  get obsSize() {
    return OBS_SIZE;
  }
}
