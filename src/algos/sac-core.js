// SAC (Soft Actor-Critic) öğrenici çekirdeği + tekrar oynatma (replay) belleği.
//   aktör: s → [μ1, μ2, logσ1, logσ2],  a = tanh(μ + σ·ε)  (tanh ile sıkıştırılmış Gauss)
//   iki Q ağı (Q1, Q2) + yavaş izleyen hedef kopyaları (Polyak, τ); hedefte min(Q1', Q2') → aşırı iyimserliği azaltır
//   sıcaklık α otomatik: politika entropisi hedefin (−2) altına düşerse α artar (daha çok keşif)
// Hem ana iş parçacığında (Node/headless) hem Web Worker içinde çalışır; DOM kullanmaz.
// Belleğe ham gözlem yazılır; örneklenirken ana iş parçacığının gönderdiği normalizasyon (μ, 1/σ) uygulanır.

import { Adam } from '../nn.js';
import { RNG } from '../rng.js';
import { BatchMLP, adamState, adamLoad, clipNorm, LOG_2PI } from './mlp.js';

export const SAC_LOGSTD_MIN = -5, SAC_LOGSTD_MAX = 1;
const A = 2;

function softplus(x) {
  return x > 20 ? x : Math.log1p(Math.exp(x));
}
// log(1 − tanh²(u)) sayısal olarak kararlı biçimde
function logSech2(u) {
  return 2 * (Math.LN2 - u - softplus(-2 * u));
}

export class SACLearner {
  // init: { sizesA, sizesQ, actor, q1, q2, lr, alpha0, seed, capacity }
  constructor(init) {
    this.sizesA = init.sizesA.slice();
    this.sizesQ = init.sizesQ.slice();
    this.D = this.sizesA[0];
    this.actor = Float32Array.from(init.actor);
    this.q1 = Float32Array.from(init.q1);
    this.q2 = Float32Array.from(init.q2);
    this.q1t = this.q1.slice();
    this.q2t = this.q2.slice();
    this.logAlpha = Math.log(init.alpha0 ?? 0.2);
    const lr = init.lr ?? 3e-4;
    this.adamA = new Adam(this.actor.length, lr);
    this.adamQ1 = new Adam(this.q1.length, lr);
    this.adamQ2 = new Adam(this.q2.length, lr);
    this.adamAl = { m: 0, v: 0, t: 0 };
    this.gA = new Float32Array(this.actor.length);
    this.gQ1 = new Float32Array(this.q1.length);
    this.gQ2 = new Float32Array(this.q2.length);
    this.rng = new RNG((init.seed ?? 1) >>> 0);
    this.steps = 0;
    this.B = 0;
    this._allocBuffer(init.capacity ?? 200000);
  }

  _allocBuffer(cap) {
    const D = this.D;
    this.cap = Math.max(1000, cap | 0);
    this.bObs = new Float32Array(this.cap * D);
    this.bNext = new Float32Array(this.cap * D);
    this.bAct = new Float32Array(this.cap * A);
    this.bRew = new Float32Array(this.cap);
    this.bDone = new Uint8Array(this.cap);
    this.bGam = new Float32Array(this.cap); // geçişin indirimi (n-adımlı getiride γ^n)
    this.ptr = 0;
    this.size = 0;
  }

  _ensure(B) {
    if (this.B >= B) return;
    this.B = B;
    this.netA = new BatchMLP(this.sizesA, B);
    this.netQ1 = new BatchMLP(this.sizesQ, B);
    this.netQ2 = new BatchMLP(this.sizesQ, B);
    this.idx = new Int32Array(B);
    this.sN = new Float32Array(B * this.D); // normalize s
    this.y = new Float32Array(B);
    this.aPi = new Float32Array(B * A);
    this.eps = new Float32Array(B * A);
    this.lsd = new Float32Array(B * A);
    this.clamped = new Uint8Array(B * A);
    this.logp = new Float32Array(B);
  }

  // tr: { n, obs (n×D), act (n×A), rew (n), next (n×D), done (n), gam (n) }
  add(tr) {
    const D = this.D;
    for (let k = 0; k < tr.n; k++) {
      const p = this.ptr;
      this.bObs.set(tr.obs.subarray(k * D, k * D + D), p * D);
      this.bNext.set(tr.next.subarray(k * D, k * D + D), p * D);
      this.bAct[p * A] = tr.act[k * A];
      this.bAct[p * A + 1] = tr.act[k * A + 1];
      this.bRew[p] = tr.rew[k];
      this.bDone[p] = tr.done[k];
      this.bGam[p] = tr.gam ? tr.gam[k] : 0.99;
      this.ptr = (p + 1) % this.cap;
      if (this.size < this.cap) this.size++;
    }
  }

  // Aktör çıkışından örnek: a = tanh(μ + σε), logπ(a|s). out: B×4 ([μ1, μ2, logσ1, logσ2])
  _samplePolicy(out, B, aOut, logpOut, keepGrad) {
    let ent = 0;
    for (let b = 0; b < B; b++) {
      let lp = 0;
      for (let d = 0; d < A; d++) {
        const mu = out[b * 4 + d];
        let ls = out[b * 4 + 2 + d];
        let cl = 0;
        if (ls < SAC_LOGSTD_MIN) { ls = SAC_LOGSTD_MIN; cl = 1; } else if (ls > SAC_LOGSTD_MAX) { ls = SAC_LOGSTD_MAX; cl = 1; }
        const e = this.rng.gauss();
        const u = mu + Math.exp(ls) * e;
        const a = Math.tanh(u);
        aOut[b * A + d] = a;
        lp += -0.5 * e * e - ls - 0.5 * LOG_2PI - logSech2(u);
        if (keepGrad) {
          this.eps[b * A + d] = e;
          this.lsd[b * A + d] = ls;
          this.clamped[b * A + d] = cl;
        }
      }
      logpOut[b] = lp;
      ent -= lp;
    }
    return ent / B;
  }

  // steps gradyan adımı. norm: { mu, inv } (gözlem normalizasyonu). Bellek warmup'tan küçükse adım atılmaz.
  train(steps, hp, norm) {
    const out = { steps: 0, qLoss: 0, piLoss: 0, alpha: Math.exp(this.logAlpha), entropy: 0, q: 0, size: this.size };
    if (this.size < Math.max(hp.batch, hp.warmup | 0) || steps <= 0) return out;
    const B = Math.max(16, hp.batch | 0);
    this._ensure(B);
    const { D, netA, netQ1, netQ2, idx, sN, y, aPi, logp } = this;
    const Dq = D + A;
    const mu = norm.mu, inv = norm.inv;
    const tau = hp.tau, rs = hp.rewardScale, rc = hp.rewardClip;
    const tgtEnt = hp.targetEntropy;
    this.adamA.lr = hp.lr;
    this.adamQ1.lr = hp.lr;
    this.adamQ2.lr = hp.lr;
    const invB = 1 / B;
    let sQ = 0, sPi = 0, sEnt = 0, sQv = 0;
    for (let st = 0; st < steps; st++) {
      // --- örnekle + normalize et ---
      const xA = netA.input;
      for (let b = 0; b < B; b++) {
        const j = (idx[b] = (this.rng.next() * this.size) | 0);
        const o = j * D;
        for (let k = 0; k < D; k++) {
          sN[b * D + k] = (this.bObs[o + k] - mu[k]) * inv[k];
          xA[b * D + k] = (this.bNext[o + k] - mu[k]) * inv[k];
        }
      }
      const alpha = Math.exp(this.logAlpha);
      // --- hedef: y = R + γⁿ(1−d)(min Q'(s',a') − α logπ(a'|s'))  (n-adımlı getiri) ---
      const outN = netA.forward(this.actor, B);
      this._samplePolicy(outN, B, aPi, logp, false);
      const x1 = netQ1.input, x2 = netQ2.input;
      for (let b = 0; b < B; b++) {
        for (let k = 0; k < D; k++) x1[b * Dq + k] = xA[b * D + k];
        x1[b * Dq + D] = aPi[b * A];
        x1[b * Dq + D + 1] = aPi[b * A + 1];
      }
      x2.set(x1.subarray(0, B * Dq));
      const t1 = netQ1.forward(this.q1t, B), t2 = netQ2.forward(this.q2t, B);
      for (let b = 0; b < B; b++) {
        const j = idx[b];
        let r = this.bRew[j] * rs;
        if (rc > 0) r = r > rc ? rc : r < -rc ? -rc : r;
        const qn = t1[b] < t2[b] ? t1[b] : t2[b];
        y[b] = r + (this.bDone[j] ? 0 : this.bGam[j] * (qn - alpha * logp[b]));
      }
      // --- eleştirmenler (critic) ---
      for (let b = 0; b < B; b++) {
        const j = idx[b];
        for (let k = 0; k < D; k++) x1[b * Dq + k] = sN[b * D + k];
        x1[b * Dq + D] = this.bAct[j * A];
        x1[b * Dq + D + 1] = this.bAct[j * A + 1];
      }
      x2.set(x1.subarray(0, B * Dq));
      const Q1 = netQ1.forward(this.q1, B);
      const d1 = netQ1.dOut;
      for (let b = 0; b < B; b++) {
        const e = Q1[b] - y[b];
        sQ += e * e;
        sQv += Q1[b];
        d1[b] = 2 * e * invB;
      }
      this.gQ1.fill(0);
      netQ1.backward(this.q1, B, this.gQ1);
      const Q2 = netQ2.forward(this.q2, B);
      const d2 = netQ2.dOut;
      for (let b = 0; b < B; b++) {
        const e = Q2[b] - y[b];
        sQ += e * e;
        d2[b] = 2 * e * invB;
      }
      this.gQ2.fill(0);
      netQ2.backward(this.q2, B, this.gQ2);
      clipNorm(this.gQ1, hp.maxGradNorm);
      clipNorm(this.gQ2, hp.maxGradNorm);
      this.adamQ1.step(this.q1, this.gQ1);
      this.adamQ2.step(this.q2, this.gQ2);

      // --- aktör: min_θ E[α logπ(a|s) − min Q(s,a)],  a = tanh(μ + σε) (yeniden parametreleme) ---
      for (let b = 0; b < B * D; b++) xA[b] = sN[b];
      const outS = netA.forward(this.actor, B);
      sEnt += this._samplePolicy(outS, B, aPi, logp, true);
      for (let b = 0; b < B; b++) {
        for (let k = 0; k < D; k++) x1[b * Dq + k] = sN[b * D + k];
        x1[b * Dq + D] = aPi[b * A];
        x1[b * Dq + D + 1] = aPi[b * A + 1];
      }
      x2.set(x1.subarray(0, B * Dq));
      const P1 = netQ1.forward(this.q1, B), P2 = netQ2.forward(this.q2, B);
      for (let b = 0; b < B; b++) {
        const use1 = P1[b] <= P2[b];
        netQ1.dOut[b] = use1 ? -invB : 0;
        netQ2.dOut[b] = use1 ? 0 : -invB;
        sPi += alpha * logp[b] - (use1 ? P1[b] : P2[b]);
      }
      netQ1.backward(this.q1, B, null, true);
      netQ2.backward(this.q2, B, null, true);
      const g1 = netQ1.dIn, g2 = netQ2.dIn, dA = netA.dOut;
      const aB = alpha * invB;
      for (let b = 0; b < B; b++) {
        for (let d = 0; d < A; d++) {
          const a = aPi[b * A + d];
          const dLda = g1[b * Dq + D + d] + g2[b * Dq + D + d]; // −(1/B)·∂minQ/∂a
          const dLdu = dLda * (1 - a * a) + aB * 2 * a;          // + α·∂logπ/∂u  (−log(1−tanh²u) terimi)
          dA[b * 4 + d] = dLdu;
          const se = Math.exp(this.lsd[b * A + d]) * this.eps[b * A + d];
          dA[b * 4 + 2 + d] = this.clamped[b * A + d] ? 0 : dLdu * se - aB; // ∂logπ/∂logσ = −1 (doğrudan)
        }
      }
      this.gA.fill(0);
      netA.backward(this.actor, B, this.gA);
      clipNorm(this.gA, hp.maxGradNorm);
      this.adamA.step(this.actor, this.gA);

      // --- sıcaklık α: kayıp = −logα · (logπ + H_hedef) ---
      let gAl = 0;
      for (let b = 0; b < B; b++) gAl -= logp[b] + tgtEnt;
      gAl *= invB;
      const s = this.adamAl;
      s.t++;
      s.m = 0.9 * s.m + 0.1 * gAl;
      s.v = 0.999 * s.v + 0.001 * gAl * gAl;
      const mh = s.m / (1 - Math.pow(0.9, s.t)), vh = s.v / (1 - Math.pow(0.999, s.t));
      this.logAlpha -= (hp.alphaLr ?? hp.lr) * mh / (Math.sqrt(vh) + 1e-8);
      if (this.logAlpha < -12) this.logAlpha = -12;
      else if (this.logAlpha > 2) this.logAlpha = 2;

      // --- hedef ağlar (Polyak) ---
      const q1 = this.q1, q2 = this.q2, q1t = this.q1t, q2t = this.q2t;
      const kt = 1 - tau;
      for (let k = 0; k < q1.length; k++) {
        q1t[k] = kt * q1t[k] + tau * q1[k];
        q2t[k] = kt * q2t[k] + tau * q2[k];
      }
      this.steps++;
    }
    out.steps = steps;
    out.qLoss = sQ / (2 * steps * B);
    out.piLoss = sPi / (steps * B);
    out.entropy = sEnt / steps;
    out.q = sQv / (steps * B);
    out.alpha = Math.exp(this.logAlpha);
    out.size = this.size;
    return out;
  }

  // Bellek hariç tüm öğrenme durumu
  getState() {
    return {
      actor: this.actor.slice(),
      q1: this.q1.slice(), q2: this.q2.slice(), q1t: this.q1t.slice(), q2t: this.q2t.slice(),
      logAlpha: this.logAlpha,
      adamA: adamState(this.adamA), adamQ1: adamState(this.adamQ1), adamQ2: adamState(this.adamQ2),
      adamAl: { ...this.adamAl },
      rng: this.rng.s,
      steps: this.steps,
    };
  }

  setState(s) {
    if (!s || s.actor.length !== this.actor.length || s.q1.length !== this.q1.length) return false;
    this.actor.set(s.actor);
    this.q1.set(s.q1);
    this.q2.set(s.q2);
    this.q1t.set(s.q1t);
    this.q2t.set(s.q2t);
    this.logAlpha = s.logAlpha;
    adamLoad(this.adamA, s.adamA);
    adamLoad(this.adamQ1, s.adamQ1);
    adamLoad(this.adamQ2, s.adamQ2);
    this.adamAl = { ...s.adamAl };
    if (s.rng != null) { this.rng.s = s.rng >>> 0; this.rng._spare = null; }
    this.steps = s.steps | 0;
    return true;
  }

  setCapacity(cap) {
    if ((cap | 0) !== this.cap) this._allocBuffer(cap);
  }
}

// Aktör parametrelerinin [D, ..., 4] düzeninde sayısı vb. için yardımcı yok; ajan nn.js paramCount kullanır.
export const SAC_ACT_DIM = A;
