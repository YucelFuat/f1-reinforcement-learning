// Sürekli aksiyonlu PPO (Gauss politikası, Actor-Critic). Tüm araçlar AYNI politikayı paylaşır.
//   • aksiyon: u ~ N(μ(s), σ²), uygulanan = kırp(u, −1, 1)  (direksiyon, gaz/fren — "etkin" aralıkta)
//   • aksiyon tekrarı: politika her K adımda bir karar verir (60 Hz'de K=4 → 15 Hz); ödüller blok boyunca toplanır.
//     Böylece γ=0.99 yaklaşık 6-7 sn'lik bir ufka karşılık gelir (fren noktasını öğrenmek için gerekli).
//   • GAE(λ) avantajları, avantaj normalizasyonu, kırpılmış amaç, ayrı değer ağı
//   • gözlem normalizasyonu (kayan ortalama/std) — beyin dışa aktarılırken ilk katmana gömülür
//   • ödül normalizasyonu (indirimli getirinin kayan std'si ile bölme) + kırpma
// Güncellemeler tarayıcıda Web Worker'da, Node'da (headless) eşzamanlı çalışır.

import { OBS_SIZE } from '../config.js';
import { paramCount, initParams, forward, maxWidth } from '../nn.js';
import { RUNNING } from '../sim.js';
import { PPOContLearner } from './ppo-cont-core.js';
import { RunningNorm, RunningScalar, foldNorm, unfoldNorm, scaleOutputs, isTruncated, sameSizes, LOG_2PI } from './rl-common.js';

const A = 2; // direksiyon, gaz/fren
// Simülasyon aksiyonları 2 kazançla doyurur (sim.js ACTION_GAIN). Politika "etkin" aralıkta [-1,1] çalışır,
// simülasyona yarısı yazılır → etkin aksiyon = kırp(u). Beyin dışa aktarılırken çıkış katmanı da 0.5 ile ölçeklenir.
const SIM_SCALE = 0.5;

class SyncUpdater {
  constructor(init) {
    this.learner = new PPOContLearner(init.sizesPi, init.sizesV, init.pi, init.v, init.lr, init.seed);
  }
  state() {
    return this.learner.getState();
  }
  setState(s) {
    this.learner.setState(s);
  }
  update(batch, hp, epoch, cb) {
    const t0 = performance.now();
    const stats = this.learner.update(batch, hp);
    stats.ms = performance.now() - t0;
    cb(this.learner.getState(), stats, epoch);
  }
  dispose() {}
}

class WorkerUpdater {
  constructor(init) {
    this.w = new Worker(new URL('./ppo-cont-worker.js', import.meta.url), { type: 'module' });
    this.cbs = []; // işçi mesajları sırayla işler → FIFO
    this.w.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'result') {
        const cb = this.cbs.shift();
        if (cb) cb(m.state, m.stats, m.epoch);
      }
    };
    this.w.onerror = (e) => console.error('PPO-sürekli worker hatası', e.message || e);
    this.w.postMessage({ type: 'init', ...init });
  }
  state() {
    return null; // işçideki durum her güncellemeden sonra ana iş parçacığına gelir
  }
  setState(s) {
    this.w.postMessage({ type: 'state', state: s });
  }
  update(batch, hp, epoch, cb) {
    this.cbs.push(cb);
    this.w.postMessage({ type: 'update', batch, hp, epoch }, [batch.obs.buffer, batch.act.buffer, batch.logp.buffer, batch.adv.buffer, batch.ret.buffer]);
  }
  dispose() {
    this.w.terminate();
  }
}

export class PPOContAgent {
  constructor(N, cfgAll, rng, opts = {}) {
    this.name = 'ppoc';
    this.label = 'PPO (sürekli, Gauss)';
    this.kind = 'continuous';
    this.N = N;
    this.cfgAll = cfgAll;
    this.rng = rng;
    const c = this.cfg;
    const h = c.hidden;
    this.sizes = [OBS_SIZE, ...h, A];
    this.sizesV = [OBS_SIZE, ...h, 1];
    this.P = paramCount(this.sizes);
    this.pi = new Float32Array(this.P + A); // MLP + logσ
    initParams(this.pi, 0, this.sizes, rng, 0.01);
    for (let d = 0; d < A; d++) this.pi[this.P + d] = c.initLogStd;
    this.v = new Float32Array(paramCount(this.sizesV));
    initParams(this.v, 0, this.sizesV, rng, 1);
    const w = Math.max(maxWidth(this.sizes), maxWidth(this.sizesV));
    this.bufA = new Float32Array(w);
    this.bufB = new Float32Array(w);
    this.nrm = new Float32Array(OBS_SIZE);
    this.norm = new RunningNorm(OBS_SIZE);
    this.retNorm = new RunningScalar();
    this.useObsNorm = !!c.obsNorm;
    this.cur = new Float32Array(N * A);   // şu an uygulanan (etkin) aksiyonlar
    this.open = new Uint8Array(N);        // araç için açık (kaydedilen) bir geçiş var mı
    this.racc = new Float64Array(N);      // blok boyunca toplanan (ölçekli) ödül
    this.retAcc = new Float64Array(N);    // ödül normalizasyonu için indirimli getiri
    this.retBuf = new Float64Array(N);
    this.mask = new Uint8Array(N);
    this.lastVal = new Float32Array(N);
    this._alloc();
    this.k = 0; // blok içindeki adım (0 = karar anı)
    this.busy = false;
    this.updates = 0;
    this.epoch = 0;
    this.lastStats = null;
    this.onUpdate = null;
    this.deterministic = false;
    this.learnerSeed = (rng.next() * 4294967296) >>> 0;
    const init = { sizesPi: this.sizes, sizesV: this.sizesV, pi: this.pi, v: this.v, lr: c.lr, seed: this.learnerSeed };
    const useWorker = opts.useWorker && typeof Worker !== 'undefined';
    this.updater = useWorker ? new WorkerUpdater(init) : new SyncUpdater(init);
    // getState() için öğrenicinin son bilinen durumu (Adam momentleri dahil)
    this.learnerState = new PPOContLearner(this.sizes, this.sizesV, this.pi, this.v, c.lr, this.learnerSeed).getState();
  }

  get cfg() {
    return this.cfgAll.ppoc;
  }

  _alloc() {
    const T = (this.T = Math.max(4, this.cfg.rollout | 0));
    const N = this.N;
    this.bObs = new Float32Array(T * N * OBS_SIZE);
    this.bAct = new Float32Array(T * N * A);
    this.bLogp = new Float32Array(T * N);
    this.bVal = new Float32Array(T * N);
    this.bRew = new Float32Array(T * N);
    this.bDone = new Uint8Array(T * N);
    this.bValid = new Uint8Array(T * N);
    this.t = 0;
  }

  get K() {
    return Math.max(1, this.cfg.actionRepeat | 0);
  }

  // Rollout içindeki karar indeksi. Eğitici pist/simülasyon değişince `algo.t = 0` yazar →
  // yarım kalan rollout ve açık geçişler temizce atılır (eski pistin gözlemi yeni ödülle eşleşmesin).
  get t() {
    return this._t;
  }

  set t(v) {
    this._t = v | 0;
    if (this._t === 0 && this.open) {
      this.k = 0;
      this.open.fill(0);
      this.bValid.fill(0);
    }
  }

  _sigma(d) {
    return Math.exp(this.pi[this.P + d]);
  }

  // Normalize gözlem → politika ortalaması (bufA/bufB içinde döner)
  _mu(x, off) {
    return forward(this.pi, 0, this.sizes, x, off, this.bufA, this.bufB, false);
  }

  _value(x, off) {
    return forward(this.v, 0, this.sizesV, x, off, this.bufA, this.bufB, false)[0];
  }

  // Blok başı: tüm araçlar için karar ver ve kaydet
  _decide(sim) {
    const { N, T } = this;
    const t = this.t;
    const obs = sim.obs, st = sim.status, D = OBS_SIZE;
    if (this.useObsNorm) {
      const mask = this.mask;
      for (let i = 0; i < N; i++) mask[i] = st[i] === RUNNING ? 1 : 0;
      this.norm.update(obs, 0, D, N, mask);
    }
    const s0 = this._sigma(0), s1 = this._sigma(1);
    const logSig = this.pi[this.P] + this.pi[this.P + 1];
    for (let i = 0; i < N; i++) {
      const j = t * N + i;
      if (st[i] !== RUNNING || t >= T) {
        this.open[i] = 0;
        if (t < T) { this.bValid[j] = 0; this.bDone[j] = 1; this.bRew[j] = 0; this.bVal[j] = 0; }
        continue;
      }
      this.norm.apply(obs, i * D, this.bObs, j * D);
      const mu = this._mu(this.bObs, j * D);
      const m0 = mu[0], m1 = mu[1];
      let u0 = m0, u1 = m1;
      if (!this.deterministic) {
        u0 += s0 * this.rng.gauss();
        u1 += s1 * this.rng.gauss();
      }
      const z0 = (u0 - m0) / s0, z1 = (u1 - m1) / s1;
      this.bAct[j * A] = u0;
      this.bAct[j * A + 1] = u1;
      this.bLogp[j] = -0.5 * (z0 * z0 + z1 * z1) - logSig - A * 0.5 * LOG_2PI;
      this.bVal[j] = this._value(this.bObs, j * D);
      this.bRew[j] = 0;
      this.bDone[j] = 0;
      this.bValid[j] = 1;
      this.cur[i * A] = u0 > 1 ? 1 : u0 < -1 ? -1 : u0;
      this.cur[i * A + 1] = u1 > 1 ? 1 : u1 < -1 ? -1 : u1;
      this.open[i] = 1;
      this.racc[i] = 0;
    }
  }

  // Blok ortasında yeniden doğan araç: kaydedilmeyen bir aksiyon seç
  _freeAct(sim, i) {
    this.norm.apply(sim.obs, i * OBS_SIZE, this.nrm, 0);
    const mu = this._mu(this.nrm, 0);
    for (let d = 0; d < A; d++) {
      let u = mu[d];
      if (!this.deterministic) u += this._sigma(d) * this.rng.gauss();
      this.cur[i * A + d] = u > 1 ? 1 : u < -1 ? -1 : u;
    }
  }

  // Aksiyon seç. Rollout dolu ve önceki güncelleme sürüyorsa false (simülasyon bekler).
  act(sim) {
    const N = this.N;
    if (this.k === 0) {
      if (this.t >= this.T) {
        if (this.busy) return false;
        this._launchUpdate(sim);
      }
      this._decide(sim);
    } else {
      for (let i = 0; i < N; i++) if (!this.open[i] && sim.status[i] === RUNNING) this._freeAct(sim, i);
    }
    const acts = sim.actions, cur = this.cur;
    for (let i = 0; i < N * A; i++) acts[i] = cur[i] * SIM_SCALE;
    return true;
  }

  _close(sim, i, done) {
    const c = this.cfg;
    const j = this.t * this.N + i;
    let r = this.racc[i];
    if (c.rewardNorm) {
      this.retAcc[i] = this.retAcc[i] * c.gamma + r;
      r /= this.retNorm.std;
    }
    const clip = c.rewardClip;
    if (clip > 0) r = r > clip ? clip : r < -clip ? -clip : r;
    if (done && isTruncated(sim, i)) {
      // süre limiti: gerçek son değil → son durumun değeriyle önyükle
      this.norm.apply(sim.obs, i * OBS_SIZE, this.nrm, 0);
      r += c.gamma * this._value(this.nrm, 0);
    }
    this.bRew[j] = r;
    this.bDone[j] = done ? 1 : 0;
    this.open[i] = 0;
  }

  // Adımın ödüllerini topla; blok bitince geçişleri kapat
  record(sim) {
    const N = this.N, sc = this.cfg.rewardScale;
    const rew = sim.reward, done = sim.done;
    let nRet = 0;
    for (let i = 0; i < N; i++) {
      if (!this.open[i]) continue;
      this.racc[i] += rew[i] * sc;
      if (done[i]) {
        this._close(sim, i, true);
        this.retBuf[nRet++] = this.retAcc[i];
        this.retAcc[i] = 0;
      }
    }
    this.k++;
    if (this.k >= this.K) {
      for (let i = 0; i < N; i++) {
        if (!this.open[i]) continue;
        this._close(sim, i, false);
        this.retBuf[nRet++] = this.retAcc[i];
      }
      this.k = 0;
      this.t++;
    }
    if (nRet && this.cfg.rewardNorm) this.retNorm.update(this.retBuf, nRet);
  }

  _launchUpdate(sim) {
    const { N, T } = this;
    const c = this.cfg;
    const D = OBS_SIZE;
    for (let i = 0; i < N; i++) {
      if (sim.status[i] !== RUNNING) { this.lastVal[i] = 0; continue; }
      this.norm.apply(sim.obs, i * D, this.nrm, 0);
      this.lastVal[i] = this._value(this.nrm, 0);
    }
    const total = T * N;
    const adv = new Float32Array(total), ret = new Float32Array(total);
    const g = c.gamma, lam = c.lambda;
    for (let i = 0; i < N; i++) {
      let gae = 0;
      let nextV = this.lastVal[i];
      for (let t = T - 1; t >= 0; t--) {
        const j = t * N + i;
        const nonTerm = this.bDone[j] ? 0 : 1;
        const delta = this.bRew[j] + g * nextV * nonTerm - this.bVal[j];
        gae = delta + g * lam * nonTerm * gae;
        adv[j] = gae;
        ret[j] = gae + this.bVal[j];
        nextV = this.bVal[j];
      }
    }
    // geçerli örnekler + alt örnekleme (büyük popülasyonlarda güncellemeyi hızlı tutmak için)
    const valid = [];
    for (let j = 0; j < total; j++) if (this.bValid[j]) valid.push(j);
    const nv = valid.length;
    const B = Math.min(Math.max(64, c.maxBatch | 0), nv);
    for (let k = 0; k < B; k++) {
      const r = k + ((this.rng.next() * (nv - k)) | 0);
      const tmp = valid[k]; valid[k] = valid[r]; valid[r] = tmp;
    }
    const batch = {
      n: B,
      obs: new Float32Array(B * D),
      act: new Float32Array(B * A),
      logp: new Float32Array(B),
      adv: new Float32Array(B),
      ret: new Float32Array(B),
    };
    let mean = 0;
    for (let k = 0; k < B; k++) mean += adv[valid[k]];
    mean /= B || 1;
    let varr = 0;
    for (let k = 0; k < B; k++) { const d = adv[valid[k]] - mean; varr += d * d; }
    const std = Math.sqrt(varr / (B || 1)) + 1e-8;
    for (let k = 0; k < B; k++) {
      const j = valid[k];
      batch.obs.set(this.bObs.subarray(j * D, j * D + D), k * D);
      batch.act[k * A] = this.bAct[j * A];
      batch.act[k * A + 1] = this.bAct[j * A + 1];
      batch.logp[k] = this.bLogp[j];
      batch.adv[k] = (adv[j] - mean) / std;
      batch.ret[k] = ret[j];
    }
    this.t = 0;
    this.bValid.fill(0);
    if (B < 64) return; // neredeyse hiç veri yok (ör. tüm araçlar beklemede) → güncelleme yok
    this.busy = true;
    const hp = {
      lr: c.lr, clip: c.clip, epochs: c.epochs, minibatch: c.minibatch,
      entropy: c.entropy, vcoef: c.vcoef, maxGradNorm: c.maxGradNorm, targetKL: c.targetKL,
    };
    this.updater.update(batch, hp, this.epoch, (state, stats, epoch) => {
      if (epoch !== this.epoch) return; // bu arada durum yüklendi → eski sonucu yok say
      this.busy = false;
      this.pi.set(state.pi);
      this.v.set(state.v);
      this.learnerState = state;
      this.updates++;
      stats.retStd = c.rewardNorm ? this.retNorm.std : 1;
      this.lastStats = stats;
      if (this.onUpdate) this.onUpdate(stats);
    });
  }

  // ---- beyin (tekrar / dışa aktarma) ----
  // Ham gözlemle çalışan, etkin aksiyonu simülasyon ölçeğine çeviren eşdeğer ağ
  _exportParams() {
    const p = foldNorm(this.pi.subarray(0, this.P), this.sizes, this.norm.mu, this.norm.inv);
    return scaleOutputs(p, this.sizes, SIM_SCALE);
  }

  brainOf() {
    return {
      algo: 'ppoc',
      sizes: this.sizes.slice(),
      params: this._exportParams(),
      vparams: foldNorm(this.v, this.sizesV, this.norm.mu, this.norm.inv),
      sizesV: this.sizesV.slice(),
      outTanh: false,
      discrete: false,
      squash: false,
      logStd: [this.pi[this.P], this.pi[this.P + 1]],
      obsNorm: { mean: Array.from(this.norm.mean), var: Array.from(this.norm.var), count: this.norm.count },
    };
  }

  // Yalnızca doğrusal çıkışlı (ppoc) beyinler: tanh çıkışlı GA/ES/SAC beyinleri bu politikayla ifade edilemez
  seed(brain) {
    if (!brain || brain.discrete || brain.outTanh || brain.squash) return false;
    if (!sameSizes(brain.sizes, this.sizes)) return false;
    if (brain.obsNorm && brain.obsNorm.mean && brain.obsNorm.mean.length === OBS_SIZE) {
      this.norm.setState({ n: OBS_SIZE, mean: brain.obsNorm.mean, var: brain.obsNorm.var, count: brain.obsNorm.count });
    }
    const p = Float32Array.from(brain.params);
    scaleOutputs(p, this.sizes, 1 / SIM_SCALE);
    this.pi.set(unfoldNorm(p, this.sizes, this.norm.mu, this.norm.inv), 0);
    if (brain.logStd && brain.logStd.length === A) for (let d = 0; d < A; d++) this.pi[this.P + d] = brain.logStd[d];
    if (brain.vparams && sameSizes(brain.sizesV, this.sizesV)) this.v.set(unfoldNorm(brain.vparams, this.sizesV, this.norm.mu, this.norm.inv));
    const st = new PPOContLearner(this.sizes, this.sizesV, this.pi, this.v, this.cfg.lr, this.learnerSeed).getState();
    this._pushLearner(st);
    return true;
  }

  _pushLearner(st) {
    this.epoch++;
    this.busy = false;
    this.learnerState = st;
    this.updater.setState(st);
    this.t = 0;
    this.k = 0;
    this.open.fill(0);
    this.bValid.fill(0);
  }

  netOf() {
    // görselleştirme ham gözlemle çalışır → normalizasyon gömülü kopya (etkin aksiyon ölçeğinde)
    const key = this.updates + ':' + this.norm.count;
    if (this._netKey !== key) {
      this._netKey = key;
      this._netParams = foldNorm(this.pi.subarray(0, this.P), this.sizes, this.norm.mu, this.norm.inv);
    }
    return { sizes: this.sizes, params: this._netParams, off: 0, outTanh: false, outputLabels: ['Direksiyon μ', 'Gaz/Fren μ'] };
  }

  describe() {
    const s = this.lastStats;
    const sd = `σ: ${this._sigma(0).toFixed(2)}/${this._sigma(1).toFixed(2)}`;
    if (!s) return `Güncelleme: ${this.updates} · ${sd} · ilk rollout toplanıyor…`;
    return `Güncelleme: ${this.updates} · ${sd} · KL: ${s.kl.toFixed(4)} · kırpma: %${(s.clipFrac * 100).toFixed(0)} · V-kayıp: ${s.valueLoss.toFixed(3)} · ${s.ms.toFixed(0)} ms`;
  }

  hudText() {
    return `Rollout ${this.t}/${this.T} karar (her ${this.K} adımda bir)`;
  }

  // ---- kalıcılık ----
  getState() {
    const ls = this.updater.state() || this.learnerState;
    return {
      algo: 'ppoc',
      v: 1,
      obsSize: OBS_SIZE,
      sizes: this.sizes.slice(),
      sizesV: this.sizesV.slice(),
      learner: {
        pi: ls.pi.slice(), v: ls.v.slice(),
        adamPi: { m: ls.adamPi.m.slice(), v: ls.adamPi.v.slice(), t: ls.adamPi.t },
        adamV: { m: ls.adamV.m.slice(), v: ls.adamV.v.slice(), t: ls.adamV.t },
        rng: ls.rng,
      },
      norm: this.norm.getState(),
      retNorm: this.retNorm.getState(),
      retAcc: this.retAcc.slice(), // araç başına indirimli getiri (ödül normalizasyonu)
      useObsNorm: this.useObsNorm,
      updates: this.updates,
      learnerSeed: this.learnerSeed,
    };
  }

  setState(s) {
    if (!s || s.algo !== 'ppoc' || s.obsSize !== OBS_SIZE) return false;
    if (!sameSizes(s.sizes, this.sizes) || !sameSizes(s.sizesV, this.sizesV)) return false;
    if (!s.learner || s.learner.pi.length !== this.pi.length || s.learner.v.length !== this.v.length) return false;
    this.norm.setState(s.norm);
    this.retNorm.setState(s.retNorm);
    this.useObsNorm = !!s.useObsNorm;
    this.pi.set(s.learner.pi);
    this.v.set(s.learner.v);
    this.updates = s.updates | 0;
    this.learnerSeed = s.learnerSeed >>> 0;
    if (s.retAcc && s.retAcc.length === this.N) this.retAcc.set(s.retAcc);
    else this.retAcc.fill(0);
    this._pushLearner({
      pi: Float32Array.from(s.learner.pi), v: Float32Array.from(s.learner.v),
      adamPi: { m: Float32Array.from(s.learner.adamPi.m), v: Float32Array.from(s.learner.adamPi.v), t: s.learner.adamPi.t },
      adamV: { m: Float32Array.from(s.learner.adamV.m), v: Float32Array.from(s.learner.adamV.v), t: s.learner.adamV.t },
      rng: s.learner.rng,
    });
    return true;
  }

  dispose() {
    this.updater.dispose();
  }
}

export const PPOC_DEFAULTS = {
  hidden: [32, 32],
  actionRepeat: 4,
  rollout: 32,
  gamma: 0.99,
  lambda: 0.95,
  lr: 0.0003,
  clip: 0.2,
  epochs: 4,
  minibatch: 1024,
  maxBatch: 4096,
  entropy: 0,
  vcoef: 0.5,
  maxGradNorm: 0.5,
  targetKL: 0.03,
  initLogStd: -0.5,
  rewardScale: 0.01,
  rewardNorm: 1,
  rewardClip: 10,
  obsNorm: 1,
};
