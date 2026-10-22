// sep-CMA-ES (ayrık / köşegen kovaryanslı CMA-ES, Ros & Hansen 2008)
// Tek bir ortalama ağırlık vektörü m, adım boyu σ ve köşegen kovaryans C vardır. Her araç
//   x_k = m + σ · √C ⊙ z_k ,  z_k ~ N(0, I)
// ile sürer. Nesil sonunda en iyi μ araç (ağırlıklı) ortalamayı kendine doğru çeker; evrim yolları (pσ, pc)
// adım boyunu ve her ağırlığın kendi arama ölçeğini (C) uyarlar. Tam CMA-ES'in n² kovaryansı yerine yalnızca
// köşegen tutulur → binlerce parametreli sinir ağlarında da hızlıdır; köşegen öğrenme hızı (n+2)/3 kat artırılır.
// 0 numaralı araç her zaman gürültüsüz ortalama m ile sürer (güncellemeye katılmaz).

import { OBS_SIZE } from '../config.js';
import { paramCount, initParams, forward, maxWidth } from '../nn.js';
import { RUNNING } from '../sim.js';
import { RNG } from '../rng.js';
import { sameSizes } from './rl-common.js';

export class SepCMAES {
  constructor(N, cfgAll, rng) {
    this.name = 'cmaes';
    this.label = 'sep-CMA-ES';
    this.kind = 'population';
    this.N = Math.max(3, N);
    this.cfgAll = cfgAll;
    this.rng = rng;
    const c = this.cfg;
    this.sizes = [OBS_SIZE, ...c.hidden, 2];
    const n = (this.P = paramCount(this.sizes));
    const init = new Float32Array(n);
    initParams(init, 0, this.sizes, rng, c.initOutScale ?? 1);
    this.mean = Float64Array.from(init);
    this.sigma = c.sigma0;
    this.C = new Float64Array(n).fill(1);
    this.ps = new Float64Array(n);
    this.pc = new Float64Array(n);
    this.gen = 0;
    this.lambda = this.N - 1; // 0. araç ortalamayı sürer
    this.z = new Float32Array(this.lambda * n);
    this.params = new Float32Array(this.N * n);
    this.zw = new Float64Array(n);
    this.zz = new Float64Array(n);
    const w = maxWidth(this.sizes);
    this.bufA = new Float32Array(w);
    this.bufB = new Float32Array(w);
    this.lastInfo = null;
    this._setup();
    this.sample();
  }

  get cfg() {
    return this.cfgAll.cmaes;
  }

  // Strateji sabitleri (Hansen'in CMA-ES öğreticisi; sep-CMA için c1, cμ × (n+2)/3)
  _setup() {
    const n = this.P, lam = this.lambda;
    const frac = Math.min(0.5, Math.max(0.05, this.cfg.muFrac ?? 0.5));
    const mu = (this.mu = Math.max(1, Math.floor(lam * frac)));
    this._muFrac = frac;
    const w = new Float64Array(mu);
    let s = 0;
    for (let i = 0; i < mu; i++) { w[i] = Math.log(mu + 0.5) - Math.log(i + 1); s += w[i]; }
    let s2 = 0;
    for (let i = 0; i < mu; i++) { w[i] /= s; s2 += w[i] * w[i]; }
    this.w = w;
    const mueff = (this.mueff = 1 / s2);
    this.cs = (mueff + 2) / (n + mueff + 5);
    this.ds = 1 + 2 * Math.max(0, Math.sqrt((mueff - 1) / (n + 1)) - 1) + this.cs;
    this.cc = (4 + mueff / n) / (n + 4 + (2 * mueff) / n);
    let c1 = 2 / ((n + 1.3) * (n + 1.3) + mueff);
    let cmu = Math.min(1 - c1, (2 * (mueff - 2 + 1 / mueff)) / ((n + 2) * (n + 2) + mueff));
    const f = (n + 2) / 3; // köşegen model: daha az serbestlik → daha hızlı öğrenme
    c1 = Math.min(1, c1 * f);
    cmu = Math.min(1 - c1, cmu * f);
    this.c1 = c1;
    this.cmu = cmu;
    this.chiN = Math.sqrt(n) * (1 - 1 / (4 * n) + 1 / (21 * n * n));
  }

  // Bu neslin örneklerini üret (her nesil için ayrı tohum → durum küçük kalır, aynı popülasyon yeniden üretilebilir)
  sample(seed = null) {
    this.sampleSeed = seed ?? (this.rng.next() * 4294967296) >>> 0;
    const r = new RNG(this.sampleSeed);
    const { P, z, params, mean, C, lambda } = this;
    for (let k = 0; k < z.length; k++) z[k] = r.gauss();
    const sigma = this.sigma;
    for (let g = 0; g < P; g++) params[g] = mean[g];
    const sd = this.zz; // geçici: σ·√C
    for (let g = 0; g < P; g++) sd[g] = sigma * Math.sqrt(C[g]);
    for (let k = 0; k < lambda; k++) {
      const o = (k + 1) * P, zo = k * P;
      for (let g = 0; g < P; g++) params[o + g] = mean[g] + sd[g] * z[zo + g];
    }
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
    if ((this.cfg.muFrac ?? 0.5) !== this._muFrac) this._setup();
    const { P, lambda, mu, w, z, mean, C, ps, pc, zw, zz } = this;
    // örnekleri (araç 1..N-1) fitness'a göre sırala (büyük = iyi)
    const order = new Int32Array(lambda);
    for (let k = 0; k < lambda; k++) order[k] = k;
    order.sort((a, b) => fitness[b + 1] - fitness[a + 1]);

    // ağırlıklı rekombinasyon: zw = Σ w_r z_r ,  zz = Σ w_r z_r²  (rank-μ güncellemesi için)
    zw.fill(0);
    zz.fill(0);
    for (let r = 0; r < mu; r++) {
      const wr = w[r], o = order[r] * P;
      for (let g = 0; g < P; g++) {
        const v = z[o + g];
        zw[g] += wr * v;
        zz[g] += wr * v * v;
      }
    }
    const { cs, ds, cc, c1, cmu, mueff, chiN } = this;
    const sigma = this.sigma;
    // ortalama ve σ evrim yolu (C^{-1/2}·yw = zw köşegen modelde)
    const kps = Math.sqrt(cs * (2 - cs) * mueff);
    let psn = 0;
    for (let g = 0; g < P; g++) {
      ps[g] = (1 - cs) * ps[g] + kps * zw[g];
      psn += ps[g] * ps[g];
    }
    psn = Math.sqrt(psn);
    const gen1 = this.gen + 1;
    const hs = psn / Math.sqrt(1 - Math.pow(1 - cs, 2 * gen1)) / chiN < 1.4 + 2 / (P + 1) ? 1 : 0;
    const kpc = hs * Math.sqrt(cc * (2 - cc) * mueff);
    const a = 1 - c1 - cmu + (1 - hs) * c1 * cc * (2 - cc);
    let cMin = Infinity, cMax = 0;
    for (let g = 0; g < P; g++) {
      const sc = Math.sqrt(C[g]);
      const yw = sc * zw[g];
      mean[g] += sigma * yw;
      pc[g] = (1 - cc) * pc[g] + kpc * yw;
      // C ← a·C + c1·pc² + cμ·Σ w_r y_r²   (y_r² = C·z_r²)
      let cg = a * C[g] + c1 * pc[g] * pc[g] + cmu * C[g] * zz[g];
      if (!(cg > 1e-20)) cg = 1e-20;
      C[g] = cg;
      if (cg < cMin) cMin = cg;
      if (cg > cMax) cMax = cg;
    }
    let ns = sigma * Math.exp((cs / ds) * (psn / chiN - 1));
    if (!isFinite(ns)) ns = sigma;
    const sMin = this.cfg.sigmaMin ?? 1e-4;
    this.sigma = Math.min(5, Math.max(sMin, ns));
    this.gen = gen1;
    this.sample();
    this.lastInfo = {
      sigma: this.sigma,
      axisRatio: Math.sqrt(cMax / cMin),
      psNorm: psn / chiN,
      meanFitness: fitness[0],
      bestFitness: fitness[order[0] + 1],
    };
    return this.lastInfo;
  }

  brainOf(i) {
    return {
      algo: 'cmaes',
      sizes: this.sizes.slice(),
      params: this.params.slice(i * this.P, i * this.P + this.P),
      outTanh: true,
      discrete: false,
    };
  }

  // tanh çıkışlı beyinler (GA / ES / CMA-ES / SAC ortalaması) ortalama olarak yüklenir, arama daraltılır
  seed(brain) {
    if (!brain || brain.discrete || !(brain.outTanh || brain.squash)) return false;
    if (!sameSizes(brain.sizes, this.sizes)) return false;
    for (let g = 0; g < this.P; g++) this.mean[g] = brain.params[g];
    this.sigma = this.cfg.sigma0 * 0.5;
    this.C.fill(1);
    this.ps.fill(0);
    this.pc.fill(0);
    this.gen = 0;
    this.sample();
    return true;
  }

  netOf(i) {
    return { sizes: this.sizes, params: this.params, off: i * this.P, outTanh: true, outputLabels: ['Direksiyon', 'Gaz/Fren'] };
  }

  describe() {
    const s = this.lastInfo;
    const base = `σ: ${this.sigma.toFixed(4)} · μ/λ: ${this.mu}/${this.lambda} · μeff: ${this.mueff.toFixed(1)}`;
    return s ? `${base} · eksen oranı: ${s.axisRatio.toFixed(2)} · |pσ|/E: ${s.psNorm.toFixed(2)}` : base;
  }

  // ---- kalıcılık ----
  getState() {
    return {
      algo: 'cmaes',
      v: 1,
      obsSize: OBS_SIZE,
      sizes: this.sizes.slice(),
      N: this.N,
      mean: this.mean.slice(),
      sigma: this.sigma,
      C: this.C.slice(),
      ps: this.ps.slice(),
      pc: this.pc.slice(),
      gen: this.gen,
      sampleSeed: this.sampleSeed,
    };
  }

  setState(s) {
    if (!s || s.algo !== 'cmaes' || s.obsSize !== OBS_SIZE || !sameSizes(s.sizes, this.sizes)) return false;
    if (s.mean.length !== this.P) return false;
    this.mean.set(s.mean);
    this.sigma = s.sigma;
    this.C.set(s.C);
    this.ps.set(s.ps);
    this.pc.set(s.pc);
    this.gen = s.gen;
    // aynı araç sayısı → bu neslin popülasyonu birebir yeniden üretilir
    this.sample(s.N === this.N ? s.sampleSeed : null);
    return true;
  }
}

export const CMAES_DEFAULTS = {
  hidden: [16, 12],
  sigma0: 0.1,
  muFrac: 0.1,
  sigmaMin: 0.0001,
  initOutScale: 1,
};
