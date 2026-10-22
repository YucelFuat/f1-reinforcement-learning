// PPO ajanı (Actor-Critic). Tüm araçlar AYNI politikayı paylaşır ve her adımda deneyim toplar.
// Her adımın ödülü/cezası doğrudan o adımda seçilen aksiyona (inputa) atanır:
//   - çarpmadan hemen önceki aksiyonlar negatif avantaj alır → olasılıkları düşer
//   - hızlı ve temiz ilerleyen aksiyonlar pozitif avantaj alır → olasılıkları artar
// Avantaj, GAE(λ) ile hesaplanır; değer ağı (critic) taban çizgisi sağlar.

import { OBS_SIZE, DISCRETE_ACTIONS } from '../config.js';
import { paramCount, initParams, forward, maxWidth } from '../nn.js';
import { PPOLearner } from './ppo-core.js';
import { RUNNING } from '../sim.js';
import { sameSizes } from './rl-common.js';

const NA = DISCRETE_ACTIONS.length;

class SyncUpdater {
  constructor(sizesPi, sizesV, pi, v, lr, seed) {
    this.learner = new PPOLearner(sizesPi, sizesV, pi, v, lr, seed);
  }
  set(pi, v) {
    this.learner.setParams(pi, v);
  }
  state() {
    return this.learner.getState();
  }
  setState(s) {
    this.learner.setState(s);
  }
  update(batch, hp, cb, epoch) {
    const t0 = performance.now();
    const stats = this.learner.update(batch, hp);
    stats.ms = performance.now() - t0;
    cb(this.learner.pi, this.learner.v, stats, null, epoch);
  }
  dispose() {}
}

class WorkerUpdater {
  constructor(sizesPi, sizesV, pi, v, lr, seed) {
    this.w = new Worker(new URL('./ppo-worker.js', import.meta.url), { type: 'module' });
    this.cbs = []; // işçi mesajları sırayla işler → FIFO
    this.w.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'result') {
        const cb = this.cbs.shift();
        if (cb) cb(m.pi, m.v, m.stats, m.state, m.epoch);
      }
    };
    this.w.postMessage({ type: 'init', sizesPi, sizesV, pi, v, lr, seed });
  }
  set(pi, v) {
    this.w.postMessage({ type: 'set', pi, v });
  }
  state() {
    return null; // işçideki durum her güncellemeden sonra ana iş parçacığına gelir
  }
  setState(s) {
    this.w.postMessage({ type: 'state', state: s });
  }
  update(batch, hp, cb, epoch) {
    this.cbs.push(cb);
    this.w.postMessage({ type: 'update', batch, hp, epoch }, [batch.obs.buffer, batch.act.buffer, batch.logp.buffer, batch.adv.buffer, batch.ret.buffer]);
  }
  dispose() {
    this.w.terminate();
  }
}

export class PPOAgent {
  constructor(N, cfgAll, rng, opts = {}) {
    this.name = 'ppo';
    this.label = 'PPO (Actor-Critic)';
    this.kind = 'continuous';
    this.N = N;
    this.cfgAll = cfgAll;
    this.rng = rng;
    const h = cfgAll.ppo.hidden;
    this.sizes = [OBS_SIZE, ...h, NA];
    this.sizesV = [OBS_SIZE, ...h, 1];
    this.pi = new Float32Array(paramCount(this.sizes));
    this.v = new Float32Array(paramCount(this.sizesV));
    initParams(this.pi, 0, this.sizes, rng, 0.01); // başlangıçta neredeyse eşit olasılık
    initParams(this.v, 0, this.sizesV, rng, 1);
    const w = maxWidth(this.sizes);
    this.bufA = new Float32Array(w);
    this.bufB = new Float32Array(w);
    this.prob = new Float32Array(NA);
    this.lastAction = new Uint8Array(N);
    this.lastProbs = new Float32Array(N * NA);
    this._alloc();
    this.busy = false;
    this.updates = 0;
    this.lastStats = null;
    this.onUpdate = null;
    this.deterministic = false;
    const useWorker = opts.useWorker && typeof Worker !== 'undefined';
    const lr = cfgAll.ppo.lr;
    this.epoch = 0;
    this.learnerSeed = (rng.next() * 4294967296) >>> 0;
    this.updater = useWorker
      ? new WorkerUpdater(this.sizes, this.sizesV, this.pi, this.v, lr, this.learnerSeed)
      : new SyncUpdater(this.sizes, this.sizesV, this.pi, this.v, lr, this.learnerSeed);
    // getState() için öğrenicinin son bilinen durumu (işçi modunda her güncellemeden sonra yenilenir)
    this.learnerState = useWorker ? new PPOLearner(this.sizes, this.sizesV, this.pi, this.v, lr, this.learnerSeed).getState() : null;
  }

  get cfg() {
    return this.cfgAll.ppo;
  }

  _alloc() {
    const T = (this.T = Math.max(4, this.cfg.rollout | 0));
    const N = this.N;
    this.bObs = new Float32Array(T * N * OBS_SIZE);
    this.bAct = new Uint8Array(T * N);
    this.bLogp = new Float32Array(T * N);
    this.bVal = new Float32Array(T * N);
    this.bRew = new Float32Array(T * N);
    this.bDone = new Uint8Array(T * N);
    this.lastVal = new Float32Array(N);
    this.t = 0;
  }

  // Aksiyon seç. Önceki rollout dolu ve güncelleme hâlâ sürüyorsa false döner (simülasyon bekler).
  act(sim) {
    const N = this.N;
    if (this.t >= this.T) {
      if (this.busy) return false;
      this._launchUpdate(sim);
    }
    const { sizes, sizesV, pi, v, bufA, bufB, prob, rng } = this;
    const obs = sim.obs, acts = sim.actions;
    const t = this.t;
    for (let i = 0; i < N; i++) {
      if (sim.status[i] !== RUNNING) continue;
      const logits = forward(pi, 0, sizes, obs, i * OBS_SIZE, bufA, bufB, false);
      let mx = -Infinity;
      for (let k = 0; k < NA; k++) if (logits[k] > mx) mx = logits[k];
      let sum = 0;
      for (let k = 0; k < NA; k++) { prob[k] = Math.exp(logits[k] - mx); sum += prob[k]; }
      let a = 0;
      if (this.deterministic) {
        let best = -1;
        for (let k = 0; k < NA; k++) if (prob[k] > best) { best = prob[k]; a = k; }
      } else {
        let u = rng.next() * sum;
        a = NA - 1;
        for (let k = 0; k < NA; k++) { u -= prob[k]; if (u <= 0) { a = k; break; } }
      }
      for (let k = 0; k < NA; k++) this.lastProbs[i * NA + k] = prob[k] / sum;
      const val = forward(v, 0, sizesV, obs, i * OBS_SIZE, bufA, bufB, false)[0];
      const j = t * N + i;
      this.bObs.set(obs.subarray(i * OBS_SIZE, i * OBS_SIZE + OBS_SIZE), j * OBS_SIZE);
      this.bAct[j] = a;
      this.bLogp[j] = Math.log(Math.max(prob[a] / sum, 1e-10));
      this.bVal[j] = val;
      this.lastAction[i] = a;
      acts[2 * i] = DISCRETE_ACTIONS[a][0];
      acts[2 * i + 1] = DISCRETE_ACTIONS[a][1];
    }
    return true;
  }

  // Adımın ödüllerini ve bitiş bayraklarını kaydet
  record(sim) {
    const N = this.N, t = this.t, sc = this.cfg.rewardScale, clip = this.cfg.rewardClip;
    for (let i = 0; i < N; i++) {
      const j = t * N + i;
      // Büyük tek seferlik ödüller (bitirme + hız bonusu) critic'i dengesizleştirir → kırp
      let r = sim.reward[i] * sc;
      if (clip > 0) r = r > clip ? clip : r < -clip ? -clip : r;
      this.bRew[j] = r;
      this.bDone[j] = sim.done[i];
    }
    this.t++;
  }

  _launchUpdate(sim) {
    const { N, T, cfg } = this;
    const { sizesV, v, bufA, bufB } = this;
    // önyükleme (bootstrap) değeri: son gözlemin değeri
    for (let i = 0; i < N; i++) {
      this.lastVal[i] = forward(v, 0, sizesV, sim.obs, i * OBS_SIZE, bufA, bufB, false)[0];
    }
    // GAE
    const total = T * N;
    const adv = new Float32Array(total), ret = new Float32Array(total);
    const g = cfg.gamma, lam = cfg.lambda;
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
    // alt örnekleme (büyük popülasyonlarda güncellemeyi hızlı tutmak için)
    const B = Math.min(cfg.maxBatch, total);
    const pick = new Int32Array(total);
    for (let k = 0; k < total; k++) pick[k] = k;
    for (let k = 0; k < B; k++) {
      const r = k + ((this.rng.next() * (total - k)) | 0);
      const tmp = pick[k]; pick[k] = pick[r]; pick[r] = tmp;
    }
    const batch = {
      n: B,
      obs: new Float32Array(B * OBS_SIZE),
      act: new Uint8Array(B),
      logp: new Float32Array(B),
      adv: new Float32Array(B),
      ret: new Float32Array(B),
    };
    let mean = 0;
    for (let k = 0; k < B; k++) mean += adv[pick[k]];
    mean /= B;
    let varr = 0;
    for (let k = 0; k < B; k++) { const d = adv[pick[k]] - mean; varr += d * d; }
    const std = Math.sqrt(varr / B) + 1e-8;
    for (let k = 0; k < B; k++) {
      const j = pick[k];
      batch.obs.set(this.bObs.subarray(j * OBS_SIZE, j * OBS_SIZE + OBS_SIZE), k * OBS_SIZE);
      batch.act[k] = this.bAct[j];
      batch.logp[k] = this.bLogp[j];
      batch.adv[k] = (adv[j] - mean) / std;
      batch.ret[k] = ret[j];
    }
    this.t = 0;
    this.busy = true;
    const hp = {
      lr: cfg.lr, clip: cfg.clip, epochs: cfg.epochs, minibatch: cfg.minibatch,
      entropy: cfg.entropy, vcoef: cfg.vcoef, maxGradNorm: cfg.maxGradNorm,
    };
    this.updater.update(batch, hp, (pi, vv, stats, state, epoch) => {
      if (epoch !== this.epoch) return; // bu arada durum yüklendi → eski sonucu yok say
      this.pi.set(pi);
      this.v.set(vv);
      if (state) this.learnerState = state;
      this.busy = false;
      this.updates++;
      this.lastStats = stats;
      if (this.onUpdate) this.onUpdate(stats);
    }, this.epoch);
  }

  brainOf() {
    return { algo: 'ppo', sizes: this.sizes.slice(), params: this.pi.slice(), vparams: this.v.slice(), sizesV: this.sizesV.slice(), outTanh: false, discrete: true };
  }

  seed(brain) {
    if (!brain.discrete || brain.sizes.join() !== this.sizes.join()) return false;
    this.pi.set(brain.params);
    if (brain.vparams && brain.vparams.length === this.v.length) this.v.set(brain.vparams);
    this.updater.set(this.pi, this.v);
    // sürmekte olan güncellemenin (eski ağırlıklı) sonucu yüklenen beyni ezmesin
    this.epoch++;
    this.busy = false;
    if (this.learnerState) this.learnerState = { ...this.learnerState, pi: this.pi.slice(), v: this.v.slice() };
    this.t = 0;
    return true;
  }

  netOf() {
    return {
      sizes: this.sizes, params: this.pi, off: 0, outTanh: false, softmax: true,
      outputLabels: ['↖ gaz', '↑ gaz', '↗ gaz', '← boş', '· boş', '→ boş', '↙ fren', '↓ fren', '↘ fren'],
    };
  }

  describe() {
    const s = this.lastStats;
    if (!s) return `Güncelleme: ${this.updates} · ilk rollout toplanıyor…`;
    return `Güncelleme: ${this.updates} · Entropi: ${s.entropy.toFixed(3)} · KL: ${s.kl.toFixed(4)} · V-kayıp: ${s.valueLoss.toFixed(3)} · ${s.ms.toFixed(0)} ms`;
  }

  // ---- kalıcılık: politika + değer ağı + Adam momentleri (yarım kalan rollout kaydedilmez) ----
  getState() {
    const ls = this.updater.state() || this.learnerState;
    return {
      algo: 'ppo',
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
      updates: this.updates,
      learnerSeed: this.learnerSeed,
    };
  }

  setState(s) {
    if (!s || s.algo !== 'ppo' || s.obsSize !== OBS_SIZE) return false;
    if (!sameSizes(s.sizes, this.sizes) || !sameSizes(s.sizesV, this.sizesV)) return false;
    const L = s.learner;
    if (!L || L.pi.length !== this.pi.length || L.v.length !== this.v.length) return false;
    const f = (a) => Float32Array.from(a);
    const st = {
      pi: f(L.pi), v: f(L.v),
      adamPi: { m: f(L.adamPi.m), v: f(L.adamPi.v), t: L.adamPi.t },
      adamV: { m: f(L.adamV.m), v: f(L.adamV.v), t: L.adamV.t },
      rng: L.rng,
    };
    this.pi.set(st.pi);
    this.v.set(st.v);
    this.updates = s.updates | 0;
    this.learnerSeed = s.learnerSeed >>> 0;
    this.epoch++;
    this.busy = false;
    if (this.learnerState) this.learnerState = st;
    this.updater.setState(st);
    this.t = 0;
    return true;
  }

  dispose() {
    this.updater.dispose();
  }
}
