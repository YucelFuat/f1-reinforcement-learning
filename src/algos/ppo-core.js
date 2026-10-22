// PPO (Proximal Policy Optimization) öğrenici çekirdeği.
// Hem ana iş parçacığında (headless) hem de Web Worker içinde çalışır; DOM kullanmaz.

import { OBS_SIZE } from '../config.js';
import { paramCount, forwardCache, backward, makeActs, Adam, clipGrad } from '../nn.js';
import { RNG } from '../rng.js';
import { adamState, adamLoad } from './mlp.js';

export class PPOLearner {
  constructor(sizesPi, sizesV, pi, v, lr, seed = 12345) {
    this.sizesPi = sizesPi;
    this.sizesV = sizesV;
    this.pi = Float32Array.from(pi);
    this.v = Float32Array.from(v);
    this.gPi = new Float32Array(paramCount(sizesPi));
    this.gV = new Float32Array(paramCount(sizesV));
    this.adamPi = new Adam(this.gPi.length, lr);
    this.adamV = new Adam(this.gV.length, lr);
    this.actsPi = makeActs(sizesPi);
    this.actsV = makeActs(sizesV);
    this.dPi = makeActs(sizesPi);
    this.dV = makeActs(sizesV);
    this.prob = new Float32Array(sizesPi[sizesPi.length - 1]);
    this.dz = new Float32Array(sizesPi[sizesPi.length - 1]);
    this.dv = new Float32Array(1);
    this.rng = new RNG(seed >>> 0); // karıştırma için (durum kaydedilip birebir sürdürülebilsin)
  }

  setParams(pi, v) {
    this.pi.set(pi);
    if (v) this.v.set(v);
  }

  update(batch, hp) {
    const { obs, act, logp, adv, ret, n } = batch;
    const { sizesPi, sizesV, pi, v, gPi, gV, actsPi, actsV, dPi, dV, prob, dz, dv } = this;
    const A = sizesPi[sizesPi.length - 1];
    this.adamPi.lr = hp.lr;
    this.adamV.lr = hp.lr;
    const idx = new Int32Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    const mb = Math.max(64, Math.min(hp.minibatch, n));

    let sPol = 0, sVal = 0, sEnt = 0, sKl = 0, sClip = 0, cnt = 0, epochsDone = 0;
    for (let ep = 0; ep < hp.epochs; ep++) {
      // karıştır
      for (let i = n - 1; i > 0; i--) {
        const j = (this.rng.next() * (i + 1)) | 0;
        const t = idx[i]; idx[i] = idx[j]; idx[j] = t;
      }
      let epKl = 0, epCnt = 0;
      for (let start = 0; start < n; start += mb) {
        const m = Math.min(mb, n - start);
        gPi.fill(0);
        gV.fill(0);
        const inv = 1 / m;
        for (let q = 0; q < m; q++) {
          const j = idx[start + q];
          const logits = forwardCache(pi, 0, sizesPi, obs, j * OBS_SIZE, actsPi, false);
          let mx = -Infinity;
          for (let k = 0; k < A; k++) if (logits[k] > mx) mx = logits[k];
          let sum = 0;
          for (let k = 0; k < A; k++) { prob[k] = Math.exp(logits[k] - mx); sum += prob[k]; }
          let H = 0;
          for (let k = 0; k < A; k++) {
            prob[k] /= sum;
            if (prob[k] > 1e-10) H -= prob[k] * Math.log(prob[k]);
          }
          const a = act[j];
          const lpNew = Math.log(Math.max(prob[a], 1e-10));
          const ratio = Math.exp(lpNew - logp[j]);
          const Aj = adv[j];
          const clipped = (Aj > 0 && ratio > 1 + hp.clip) || (Aj < 0 && ratio < 1 - hp.clip);
          const g = clipped ? 0 : -ratio * Aj;
          if (clipped) sClip++;
          const unclippedObj = ratio * Aj;
          const clippedObj = Math.min(Math.max(ratio, 1 - hp.clip), 1 + hp.clip) * Aj;
          sPol += -Math.min(unclippedObj, clippedObj);
          sEnt += H;
          const kl = logp[j] - lpNew;
          sKl += kl;
          epKl += kl;
          epCnt++;
          for (let k = 0; k < A; k++) {
            const lp = Math.log(Math.max(prob[k], 1e-10));
            dz[k] = (g * ((k === a ? 1 : 0) - prob[k]) + hp.entropy * prob[k] * (lp + H)) * inv;
          }
          backward(pi, 0, sizesPi, actsPi, dz, gPi, dPi);

          const V = forwardCache(v, 0, sizesV, obs, j * OBS_SIZE, actsV, false)[0];
          const err = V - ret[j];
          sVal += err * err;
          dv[0] = 2 * hp.vcoef * err * inv;
          backward(v, 0, sizesV, actsV, dv, gV, dV);
          cnt++;
        }
        clipGrad(gPi, hp.maxGradNorm);
        clipGrad(gV, hp.maxGradNorm);
        this.adamPi.step(pi, gPi);
        this.adamV.step(v, gV);
      }
      epochsDone++;
      // politika çok fazla değiştiyse erken dur
      if (epCnt && epKl / epCnt > 0.03) break;
    }
    return {
      policyLoss: sPol / cnt,
      valueLoss: sVal / cnt,
      entropy: sEnt / cnt,
      kl: sKl / cnt,
      clipFrac: sClip / cnt,
      epochs: epochsDone,
      samples: n,
    };
  }

  getState() {
    return { pi: this.pi.slice(), v: this.v.slice(), adamPi: adamState(this.adamPi), adamV: adamState(this.adamV), rng: this.rng.s };
  }

  setState(s) {
    if (!s || s.pi.length !== this.pi.length || s.v.length !== this.v.length) return false;
    this.pi.set(s.pi);
    this.v.set(s.v);
    adamLoad(this.adamPi, s.adamPi);
    adamLoad(this.adamV, s.adamV);
    if (s.rng != null) { this.rng.s = s.rng >>> 0; this.rng._spare = null; }
    return true;
  }
}
