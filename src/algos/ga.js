// Genetik Algoritma (Neuroevolution)
// Her araç kendi sinir ağına sahip. Nesil sonunda toplam ödül (fitness) ile sıralanır;
// en iyiler (elit) aynen kopyalanır, kalanlar turnuva seçimi + nöron bazlı çaprazlama + Gauss mutasyonu ile üretilir.

import { OBS_SIZE } from '../config.js';
import { paramCount, initParams, forward, maxWidth } from '../nn.js';
import { RUNNING } from '../sim.js';
import { sameSizes } from './rl-common.js';

export class GeneticAlgorithm {
  constructor(N, cfgAll, rng) {
    this.name = 'ga';
    this.label = 'Genetik Algoritma';
    this.kind = 'population';
    this.N = N;
    this.cfgAll = cfgAll;
    this.rng = rng;
    this.sizes = [OBS_SIZE, ...cfgAll.ga.hidden, 2];
    this.P = paramCount(this.sizes);
    this.params = new Float32Array(N * this.P);
    this.next = new Float32Array(N * this.P);
    for (let i = 0; i < N; i++) initParams(this.params, i * this.P, this.sizes, rng, 1);
    const w = maxWidth(this.sizes);
    this.bufA = new Float32Array(w);
    this.bufB = new Float32Array(w);
    this.mutStd = cfgAll.ga.mutStd;
    this.bestEver = -Infinity;
    this.stagnation = 0;
    this.outTanh = true;
  }

  get cfg() {
    return this.cfgAll.ga;
  }

  act(sim) {
    const { N, P, sizes, params, bufA, bufB } = this;
    const obs = sim.obs, acts = sim.actions, st = sim.status;
    for (let i = 0; i < N; i++) {
      if (st[i] !== RUNNING) continue;
      const out = forward(params, i * P, sizes, obs, i * OBS_SIZE, bufA, bufB, true);
      acts[2 * i] = out[0];
      acts[2 * i + 1] = out[1];
    }
    return true;
  }

  _tournament(pool) {
    let best = this.rng.int(pool);
    for (let k = 0; k < 2; k++) {
      const c = this.rng.int(pool);
      if (c < best) best = c;
    }
    return best;
  }

  endGeneration(fitness) {
    const { N, P, sizes, rng, params, next } = this;
    const cfg = this.cfg;
    const order = Array.from({ length: N }, (_, i) => i).sort((a, b) => fitness[b] - fitness[a]);
    const elites = Math.max(1, Math.round(N * cfg.eliteFrac));
    const pool = Math.max(2, Math.round(N * cfg.selectFrac));

    // uyarlamalı mutasyon: ilerleme durursa mutasyonu artır
    const best = fitness[order[0]];
    if (cfg.adaptive) {
      if (best > this.bestEver + Math.abs(this.bestEver) * 0.001 + 1e-6) {
        this.stagnation = 0;
        this.mutStd = Math.max(cfg.mutStd, this.mutStd * 0.9);
      } else {
        this.stagnation++;
        if (this.stagnation >= 12) this.mutStd = Math.min(cfg.mutStd * 1.5, this.mutStd * 1.08);
      }
    } else {
      this.mutStd = cfg.mutStd;
    }
    if (best > this.bestEver) this.bestEver = best;

    for (let j = 0; j < elites; j++) {
      next.set(params.subarray(order[j] * P, order[j] * P + P), j * P);
    }

    const L = sizes.length - 1;
    const mutRate = cfg.mutRate, mutStd = this.mutStd;
    for (let j = elites; j < N; j++) {
      const pa = order[this._tournament(pool)] * P;
      const pb = order[this._tournament(pool)] * P;
      const doX = rng.next() < cfg.crossover;
      const dst = j * P;
      // nöron bazlı çaprazlama: her nöronun giriş ağırlıkları + biası tek parça taşınır
      let k = 0;
      for (let l = 0; l < L; l++) {
        const nin = sizes[l], nout = sizes[l + 1];
        const bOff = k + nin * nout;
        for (let o = 0; o < nout; o++) {
          const src = doX && rng.next() < 0.5 ? pb : pa;
          const w = k + o * nin;
          for (let i = 0; i < nin; i++) next[dst + w + i] = params[src + w + i];
          next[dst + bOff + o] = params[src + bOff + o];
        }
        k = bOff + nout;
      }
      // mutasyon
      for (let g = 0; g < P; g++) {
        if (rng.next() < mutRate) next[dst + g] += rng.gauss() * mutStd;
      }
    }

    const tmp = this.params;
    this.params = this.next;
    this.next = tmp;
    return { mutStd: this.mutStd, stagnation: this.stagnation, elites };
  }

  brainOf(i) {
    return {
      algo: 'ga',
      sizes: this.sizes.slice(),
      params: this.params.slice(i * this.P, i * this.P + this.P),
      outTanh: true,
      discrete: false,
    };
  }

  // Dışarıdan yüklenen beyni tüm popülasyona tohumlar (0. araç birebir kopya, diğerleri mutasyonlu).
  // Yalnızca tanh çıkışlı beyinler (GA / ES / CMA-ES / SAC ortalaması); doğrusal çıkışlı PPO-sürekli beyni farklı davranır.
  seed(brain) {
    if (brain.discrete || !(brain.outTanh || brain.squash) || brain.sizes.join() !== this.sizes.join()) return false;
    for (let i = 0; i < this.N; i++) {
      this.params.set(brain.params, i * this.P);
      if (i > 0) {
        for (let g = 0; g < this.P; g++) {
          if (this.rng.next() < this.cfg.mutRate) this.params[i * this.P + g] += this.rng.gauss() * this.cfg.mutStd;
        }
      }
    }
    return true;
  }

  // Görselleştirme için ağ bilgisi
  netOf(i) {
    return { sizes: this.sizes, params: this.params, off: i * this.P, outTanh: true, outputLabels: ['Direksiyon', 'Gaz/Fren'] };
  }

  describe() {
    return `Mutasyon σ: ${this.mutStd.toFixed(3)} · Durgunluk: ${this.stagnation}`;
  }

  // ---- kalıcılık: tüm popülasyon + uyarlamalı mutasyon durumu ----
  getState() {
    return {
      algo: 'ga',
      v: 1,
      obsSize: OBS_SIZE,
      sizes: this.sizes.slice(),
      N: this.N,
      params: this.params.slice(),
      mutStd: this.mutStd,
      bestEver: this.bestEver,
      stagnation: this.stagnation,
    };
  }

  // Araç sayısı farklıysa: ilk min(N) birey alınır (nesil sonunda elitler başta durur), kalanlar mutasyonlu kopya
  setState(s) {
    if (!s || s.algo !== 'ga' || s.obsSize !== OBS_SIZE || !sameSizes(s.sizes, this.sizes)) return false;
    const P = this.P, n = Math.min(this.N, s.N | 0);
    if (n < 1 || s.params.length < n * P) return false;
    this.params.set(s.params.slice(0, n * P));
    const cfg = this.cfg;
    for (let i = n; i < this.N; i++) {
      this.params.copyWithin(i * P, (i % n) * P, (i % n) * P + P);
      for (let g = 0; g < P; g++) if (this.rng.next() < cfg.mutRate) this.params[i * P + g] += this.rng.gauss() * cfg.mutStd;
    }
    this.mutStd = s.mutStd;
    this.bestEver = s.bestEver == null ? -Infinity : s.bestEver;
    this.stagnation = s.stagnation | 0;
    return true;
  }
}
