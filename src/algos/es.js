// Evolution Strategies (OpenAI-ES, antitetik örnekleme + sıra dönüşümü + Adam)
// Tek bir "merkez" ağırlık vektörü θ vardır. Her araç θ ± σ·ε ile sürer.
// Nesil sonunda: daha çok ödül alan gürültü yönlerine doğru θ güncellenir (ödül-ağırlıklı gradyan tahmini).
// 0 numaralı araç her zaman gürültüsüz θ ile sürer (ortalama politika).

import { OBS_SIZE } from '../config.js';
import { paramCount, initParams, forward, maxWidth, Adam } from '../nn.js';
import { RUNNING } from '../sim.js';
import { RNG } from '../rng.js';
import { sameSizes } from './rl-common.js';
import { adamState, adamLoad } from './mlp.js';

export class EvolutionStrategy {
  constructor(N, cfgAll, rng) {
    this.name = 'es';
    this.label = 'Evolution Strategies';
    this.kind = 'population';
    this.N = Math.max(3, N);
    this.cfgAll = cfgAll;
    this.rng = rng;
    this.sizes = [OBS_SIZE, ...cfgAll.es.hidden, 2];
    this.P = paramCount(this.sizes);
    this.theta = new Float32Array(this.P);
    initParams(this.theta, 0, this.sizes, rng, 0); // çıkış katmanı sıfır: tüm yönler eşit şansla denenir
    this.pairs = Math.floor((N - 1) / 2);
    this.eps = new Float32Array(this.pairs * this.P);
    this.params = new Float32Array(N * this.P);
    this.grad = new Float32Array(this.P);
    this.adam = new Adam(this.P, cfgAll.es.lr);
    const w = maxWidth(this.sizes);
    this.bufA = new Float32Array(w);
    this.bufB = new Float32Array(w);
    this.lastGradNorm = 0;
    this.sample();
  }

  get cfg() {
    return this.cfgAll.es;
  }

  // Gürültü her nesil için ayrı bir tohumdan üretilir → durum küçük kalır, aynı nesil yeniden üretilebilir
  sample(seed = null, sigmaArg = null) {
    const { P, theta, eps, params } = this;
    this.noiseSeed = seed ?? (this.rng.next() * 4294967296) >>> 0;
    const rng = new RNG(this.noiseSeed);
    const sigma = (this.sigmaUsed = sigmaArg ?? this.cfg.sigma);
    for (let k = 0; k < eps.length; k++) eps[k] = rng.gauss();
    params.set(theta, 0);
    for (let k = 0; k < this.pairs; k++) {
      const a = (1 + 2 * k) * P, b = (2 + 2 * k) * P, e = k * P;
      for (let g = 0; g < P; g++) {
        const d = sigma * eps[e + g];
        params[a + g] = theta[g] + d;
        params[b + g] = theta[g] - d;
      }
    }
    for (let i = 1 + 2 * this.pairs; i < this.N; i++) params.set(theta, i * P);
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

  endGeneration(fitness) {
    const { P, pairs, eps, grad, theta } = this;
    const cfg = this.cfg;
    const n = pairs * 2;
    // sıra dönüşümü: [-0.5, 0.5]
    const idx = [];
    for (let i = 1; i <= n; i++) idx.push(i);
    idx.sort((a, b) => fitness[a] - fitness[b]);
    const util = new Float32Array(this.N);
    for (let r = 0; r < n; r++) util[idx[r]] = n > 1 ? r / (n - 1) - 0.5 : 0;

    grad.fill(0);
    for (let k = 0; k < pairs; k++) {
      const w = util[1 + 2 * k] - util[2 + 2 * k];
      if (w === 0) continue;
      const e = k * P;
      for (let g = 0; g < P; g++) grad[g] += w * eps[e + g];
    }
    let norm = 0;
    const scale = 1 / (n * (this.sigmaUsed ?? cfg.sigma));
    for (let g = 0; g < P; g++) {
      // Adam küçültme yapar; biz ödülü büyütmek istiyoruz → işaret ters
      grad[g] = -grad[g] * scale + cfg.wd * theta[g];
      norm += grad[g] * grad[g];
    }
    this.lastGradNorm = Math.sqrt(norm);
    this.adam.lr = cfg.lr;
    this.adam.step(theta, grad);
    this.sample();
    return { gradNorm: this.lastGradNorm };
  }

  brainOf(i) {
    return {
      algo: 'es',
      sizes: this.sizes.slice(),
      params: this.params.slice(i * this.P, i * this.P + this.P),
      outTanh: true,
      discrete: false,
    };
  }

  // Yalnızca tanh çıkışlı beyinler (GA / ES / CMA-ES / SAC ortalaması)
  seed(brain) {
    if (brain.discrete || !(brain.outTanh || brain.squash) || brain.sizes.join() !== this.sizes.join()) return false;
    this.theta.set(brain.params);
    this.adam = new Adam(this.P, this.cfg.lr);
    this.sample();
    return true;
  }

  netOf(i) {
    return { sizes: this.sizes, params: this.params, off: i * this.P, outTanh: true, outputLabels: ['Direksiyon', 'Gaz/Fren'] };
  }

  describe() {
    return `σ: ${this.cfg.sigma} · lr: ${this.cfg.lr} · |∇|: ${this.lastGradNorm.toFixed(3)}`;
  }

  // ---- kalıcılık: θ + Adam momentleri + bu neslin gürültü tohumu ----
  getState() {
    return {
      algo: 'es',
      v: 1,
      obsSize: OBS_SIZE,
      sizes: this.sizes.slice(),
      N: this.N,
      theta: this.theta.slice(),
      adam: adamState(this.adam),
      noiseSeed: this.noiseSeed,
      sigmaUsed: this.sigmaUsed,
      lastGradNorm: this.lastGradNorm,
    };
  }

  setState(s) {
    if (!s || s.algo !== 'es' || s.obsSize !== OBS_SIZE || !sameSizes(s.sizes, this.sizes)) return false;
    if (s.theta.length !== this.P) return false;
    this.theta.set(s.theta);
    adamLoad(this.adam, { m: Float32Array.from(s.adam.m), v: Float32Array.from(s.adam.v), t: s.adam.t });
    this.lastGradNorm = s.lastGradNorm || 0;
    const sameN = s.N === this.N;
    // aynı araç sayısı → bu nesli birebir yeniden üret (σ o nesilde kullanılan değer)
    if (sameN && s.sigmaUsed != null) this.sample(s.noiseSeed, s.sigmaUsed);
    else this.sample();
    return true;
  }
}
