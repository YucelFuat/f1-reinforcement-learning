// Sürekli aksiyonlu PPO öğrenici çekirdeği (Gauss politikası).
//   politika: μ(s) = MLP(s) (doğrusal çıkış), σ = exp(logσ) — aksiyon boyutu başına öğrenilen, duruma bağlı değil
//   değer ağı: V(s) = ayrı MLP
// Kırpılmış amaç (clipped surrogate), değer kaybı (MSE), entropi bonusu, gradyan normu kırpma, KL ile erken durma.
// Hem ana iş parçacığında (Node/headless) hem Web Worker içinde çalışır; DOM kullanmaz.

import { Adam } from '../nn.js';
import { RNG } from '../rng.js';
import { BatchMLP, adamState, adamLoad, clipNorm, LOG_2PI } from './mlp.js';

export const LOGSTD_MIN = -4, LOGSTD_MAX = 1;

export class PPOContLearner {
  // pi: [MLP parametreleri..., logσ (A adet)]
  constructor(sizesPi, sizesV, pi, v, lr, seed = 1) {
    this.sizesPi = sizesPi.slice();
    this.sizesV = sizesV.slice();
    this.A = sizesPi[sizesPi.length - 1];
    this.mb = 0;
    this.netPi = null;
    this.netV = null;
    this.pi = Float32Array.from(pi);
    this.v = Float32Array.from(v);
    this.Ppi = this.pi.length - this.A; // MLP kısmı
    this.gPi = new Float32Array(this.pi.length);
    this.gV = new Float32Array(this.v.length);
    this.adamPi = new Adam(this.pi.length, lr);
    this.adamV = new Adam(this.v.length, lr);
    this.rng = new RNG(seed >>> 0);
  }

  _ensure(mb) {
    if (this.netPi && this.mb >= mb) return;
    this.mb = mb;
    this.netPi = new BatchMLP(this.sizesPi, mb);
    this.netV = new BatchMLP(this.sizesV, mb);
  }

  setParams(pi, v) {
    this.pi.set(pi);
    if (v) this.v.set(v);
  }

  // batch: { n, obs (n×D, normalize edilmiş), act (n×A, kırpılmamış örnek u), logp, adv (normalize), ret }
  update(batch, hp) {
    const { obs, act, logp, adv, ret, n } = batch;
    const { sizesPi, A, pi, v, gPi, gV, Ppi } = this;
    const D = sizesPi[0];
    const mbSize = Math.min(Math.max(32, hp.minibatch | 0 || 512), n);
    this._ensure(mbSize);
    const netPi = this.netPi, netV = this.netV;
    this.adamPi.lr = hp.lr;
    this.adamV.lr = hp.lr;
    const idx = new Int32Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    const sig = new Float64Array(A), isig2 = new Float64Array(A);
    const targetKL = hp.targetKL || 0;

    let sPol = 0, sVal = 0, sKl = 0, sClip = 0, cnt = 0, epochsDone = 0, steps = 0, stop = false, gnorm = 0;
    for (let ep = 0; ep < hp.epochs && !stop; ep++) {
      for (let i = n - 1; i > 0; i--) {
        const j = (this.rng.next() * (i + 1)) | 0;
        const t = idx[i]; idx[i] = idx[j]; idx[j] = t;
      }
      // yalnızca tam mini-batch'ler (kalan birkaç örnek bir sonraki karıştırmada kullanılır)
      for (let start = 0; start + mbSize <= n; start += mbSize) {
        const m = mbSize;
        // girdileri kopyala
        const xin = netPi.input, vin = netV.input;
        for (let q = 0; q < m; q++) {
          const j = idx[start + q];
          for (let k = 0; k < D; k++) {
            const x = obs[j * D + k];
            xin[q * D + k] = x;
            vin[q * D + k] = x;
          }
        }
        for (let d = 0; d < A; d++) {
          const ls = pi[Ppi + d];
          sig[d] = Math.exp(ls);
          isig2[d] = 1 / (sig[d] * sig[d]);
        }
        let logSigSum = 0;
        for (let d = 0; d < A; d++) logSigSum += pi[Ppi + d];
        const mu = netPi.forward(pi, m);
        const dmu = netPi.dOut;
        gPi.fill(0);
        gV.fill(0);
        const inv = 1 / m;
        let mbKl = 0;
        for (let q = 0; q < m; q++) {
          const j = idx[start + q];
          let lp = -logSigSum - 0.5 * A * LOG_2PI;
          for (let d = 0; d < A; d++) {
            const z = act[j * A + d] - mu[q * A + d];
            lp -= 0.5 * z * z * isig2[d];
          }
          const lr = lp - logp[j];
          const ratio = Math.exp(lr);
          const Aj = adv[j];
          const clipped = (Aj > 0 && ratio > 1 + hp.clip) || (Aj < 0 && ratio < 1 - hp.clip);
          if (clipped) sClip++;
          const surr = Math.min(ratio * Aj, Math.min(Math.max(ratio, 1 - hp.clip), 1 + hp.clip) * Aj);
          sPol -= surr;
          const kl = ratio - 1 - lr; // k3 tahmincisi (≥ 0)
          sKl += kl;
          mbKl += kl;
          // dL/dlogπ
          const g = clipped ? 0 : -ratio * Aj * inv;
          for (let d = 0; d < A; d++) {
            const z = act[j * A + d] - mu[q * A + d];
            dmu[q * A + d] = g * z * isig2[d]; // dlogπ/dμ = (u−μ)/σ²
            gPi[Ppi + d] += g * (z * z * isig2[d] - 1); // dlogπ/dlogσ = (u−μ)²/σ² − 1
          }
          cnt++;
        }
        netPi.backward(pi, m, gPi);
        // entropi bonusu: H = Σ logσ + sabit → kayıp −c·H
        for (let d = 0; d < A; d++) gPi[Ppi + d] -= hp.entropy;

        const V = netV.forward(v, m);
        const dv = netV.dOut;
        for (let q = 0; q < m; q++) {
          const j = idx[start + q];
          const err = V[q] - ret[j];
          sVal += err * err;
          dv[q] = 2 * hp.vcoef * err * inv;
        }
        netV.backward(v, m, gV);
        gnorm = clipNorm(gPi, hp.maxGradNorm);
        clipNorm(gV, hp.maxGradNorm);
        this.adamPi.step(pi, gPi);
        this.adamV.step(v, gV);
        for (let d = 0; d < A; d++) {
          const ls = pi[Ppi + d];
          pi[Ppi + d] = ls < LOGSTD_MIN ? LOGSTD_MIN : ls > LOGSTD_MAX ? LOGSTD_MAX : ls;
        }
        steps++;
        if (targetKL > 0 && mbKl / m > 1.5 * targetKL) { stop = true; break; }
      }
      epochsDone++;
    }
    const std = [];
    for (let d = 0; d < A; d++) std.push(Math.exp(pi[Ppi + d]));
    return {
      policyLoss: sPol / Math.max(1, cnt),
      valueLoss: sVal / Math.max(1, cnt),
      kl: sKl / Math.max(1, cnt),
      clipFrac: sClip / Math.max(1, cnt),
      epochs: epochsDone,
      steps,
      samples: n,
      gradNorm: gnorm,
      std,
      earlyStop: stop,
    };
  }

  getState() {
    return {
      pi: this.pi.slice(),
      v: this.v.slice(),
      adamPi: adamState(this.adamPi),
      adamV: adamState(this.adamV),
      rng: this.rng.s,
    };
  }

  setState(s) {
    if (!s || s.pi.length !== this.pi.length || s.v.length !== this.v.length) return false;
    this.pi.set(s.pi);
    this.v.set(s.v);
    adamLoad(this.adamPi, s.adamPi);
    adamLoad(this.adamV, s.adamV);
    if (s.rng != null) {
      this.rng.s = s.rng >>> 0;
      this.rng._spare = null;
    }
    return true;
  }
}
