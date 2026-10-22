// SAC – Soft Actor-Critic (sürekli aksiyon, politika dışı / off-policy).
// Tüm araçlar AYNI aktör ağını paylaşır; her karar anında deneyim (s, a, r, s', son) tekrar belleğine yazılır.
// Öğrenme bellekten rastgele örneklenen mini-batch'lerle yapılır → eski deneyimler tekrar tekrar kullanılır.
//   • aksiyon: a = tanh(μ(s) + σ(s)·ε), simülasyona a yazılır (sim 2 kazançla doyurur, GA/ES ile aynı)
//   • aksiyon tekrarı: politika her K adımda bir karar verir; ödül blok boyunca toplanır
//   • n-adımlı getiri: ödül n karar boyunca toplanıp sonra hedef Q ile önyüklenir (kredi daha hızlı yayılır)
//   • güncelleme oranı sabit: her `updateEvery` simülasyon adımında `gradSteps` gradyan adımı (varsayılan 64 × batch 128)
//     → tarayıcıda Web Worker'da çalışır; işçi yetişemezse simülasyon bekler (oran korunur), act() hafif kalır
//   • gözlem normalizasyonu ana iş parçacığında tutulur, beyin dışa aktarılırken ilk katmana gömülür
// Tekrar/dışa aktarma: gürültüsüz ortalama aksiyon tanh(μ(s)) (squash: true).

import { OBS_SIZE } from '../config.js';
import { paramCount, initParams, forward, maxWidth } from '../nn.js';
import { RUNNING } from '../sim.js';
import { SACLearner, SAC_LOGSTD_MIN, SAC_LOGSTD_MAX } from './sac-core.js';
import { RunningNorm, foldNorm, unfoldNorm, trimOutputs, isTruncated, sameSizes } from './rl-common.js';

const A = 2;
const NMAX = 16; // en büyük n (n-adımlı getiri)

class SyncUpdater {
  constructor(init) {
    this.learner = new SACLearner(init);
  }
  state() {
    return this.learner.getState();
  }
  setState(s) {
    this.learner.setState(s);
  }
  round(batch, steps, hp, norm, epoch, cb) {
    const t0 = performance.now();
    if (batch.n) this.learner.add(batch);
    const stats = this.learner.train(steps, hp, norm);
    stats.ms = performance.now() - t0;
    cb(stats.steps > 0 ? this.learner.getState() : null, stats, epoch);
  }
  dispose() {}
}

class WorkerUpdater {
  constructor(init) {
    this.w = new Worker(new URL('./sac-worker.js', import.meta.url), { type: 'module' });
    this.cbs = [];
    this.w.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'result') {
        const cb = this.cbs.shift();
        if (cb) cb(m.state, m.stats, m.epoch);
      }
    };
    this.w.onerror = (e) => console.error('SAC worker hatası', e.message || e);
    this.w.postMessage({ type: 'init', init });
  }
  state() {
    return null;
  }
  setState(s) {
    this.w.postMessage({ type: 'state', state: s });
  }
  round(batch, steps, hp, norm, epoch, cb) {
    this.cbs.push(cb);
    this.w.postMessage(
      { type: 'round', batch, steps, hp, norm, epoch },
      [batch.obs.buffer, batch.act.buffer, batch.rew.buffer, batch.next.buffer, batch.done.buffer, batch.gam.buffer],
    );
  }
  dispose() {
    this.w.terminate();
  }
}

export class SACAgent {
  constructor(N, cfgAll, rng, opts = {}) {
    this.name = 'sac';
    this.label = 'SAC (Soft Actor-Critic)';
    this.kind = 'continuous';
    this.N = N;
    this.cfgAll = cfgAll;
    this.rng = rng;
    const c = this.cfg;
    const h = c.hidden;
    const D = OBS_SIZE;
    this.sizes = [D, ...h, 2 * A];       // μ1, μ2, logσ1, logσ2
    this.sizesQ = [D + A, ...h, 1];
    this.actor = new Float32Array(paramCount(this.sizes));
    initParams(this.actor, 0, this.sizes, rng, 0.01);
    // logσ çıkışlarının biası: başlangıç keşif gürültüsü (σ = e^x, tanh öncesi)
    {
      const L = this.sizes.length - 1, nin = this.sizes[L - 1];
      let off = 0;
      for (let l = 0; l < L - 1; l++) off += this.sizes[l] * this.sizes[l + 1] + this.sizes[l + 1];
      for (let d = 0; d < A; d++) this.actor[off + nin * 2 * A + A + d] = c.initLogStd ?? -1;
    }
    const q1 = new Float32Array(paramCount(this.sizesQ));
    const q2 = new Float32Array(paramCount(this.sizesQ));
    initParams(q1, 0, this.sizesQ, rng, 1);
    initParams(q2, 0, this.sizesQ, rng, 1);
    const w = maxWidth(this.sizes);
    this.bufA = new Float32Array(w);
    this.bufB = new Float32Array(w);
    this.nrm = new Float32Array(D);
    this.norm = new RunningNorm(D);
    this.useObsNorm = !!c.obsNorm;
    this.mask = new Uint8Array(N);
    this.cur = new Float32Array(N * A);   // uygulanan aksiyon (tanh uzayı, [-1,1])
    this.open = new Uint8Array(N);
    this.pObs = new Float32Array(N * D);  // açık geçişin başlangıç gözlemi (ham)
    this.pAct = new Float32Array(N * A);
    this.racc = new Float64Array(N);
    // n-adımlı getiri için araç başına son kararların geçmişi (halka)
    this.hObs = new Float32Array(N * NMAX * D);
    this.hAct = new Float32Array(N * NMAX * A);
    this.hRew = new Float64Array(N * NMAX);
    this.hStart = new Uint8Array(N);
    this.hLen = new Uint8Array(N);
    this._stAlloc(N * Math.max(8, c.updateEvery | 0));
    this.k = 0;
    this.tickCount = 0;
    this.busy = false;
    this.updates = 0;
    this.epoch = 0;
    this.rounds = 0;
    this.added = 0;
    this.lastStats = null;
    this.onUpdate = null;
    this.deterministic = false;
    this.learnerSeed = (rng.next() * 4294967296) >>> 0;
    const init = {
      sizesA: this.sizes, sizesQ: this.sizesQ, actor: this.actor, q1, q2,
      lr: c.lr, alpha0: c.alpha0, seed: this.learnerSeed, capacity: c.bufferSize,
    };
    const useWorker = opts.useWorker && typeof Worker !== 'undefined';
    this.updater = useWorker ? new WorkerUpdater(init) : new SyncUpdater(init);
    this.learnerState = useWorker ? new SACLearner({ ...init, capacity: 1000 }).getState() : null;
  }

  get cfg() {
    return this.cfgAll.sac;
  }

  get K() {
    return Math.max(1, this.cfg.actionRepeat | 0);
  }

  // Eğitici pist/simülasyon değişince `algo.t = 0` yazar → yarım kalan geçişler (eski pistin gözlemi) atılır.
  // Tekrar belleğindeki eski deneyim korunur (gözlemler piste bağlı değildir).
  get t() {
    return this.tickCount;
  }

  set t(v) {
    if ((v | 0) === 0) {
      this.k = 0;
      this.open.fill(0);
      this.hLen.fill(0);
    }
  }

  get T() {
    return Math.max(1, this.cfg.updateEvery | 0);
  }

  // ---- aşama (staging) belleği: bir turda toplanan geçişler ----
  _stAlloc(cap) {
    const D = OBS_SIZE;
    this.stCap = cap;
    this.stObs = new Float32Array(cap * D);
    this.stNext = new Float32Array(cap * D);
    this.stAct = new Float32Array(cap * A);
    this.stRew = new Float32Array(cap);
    this.stDone = new Uint8Array(cap);
    this.stGam = new Float32Array(cap);
    this.stN = 0;
  }

  _stGrow() {
    const o = { obs: this.stObs, next: this.stNext, act: this.stAct, rew: this.stRew, done: this.stDone, gam: this.stGam, n: this.stN };
    this._stAlloc(this.stCap * 2);
    this.stObs.set(o.obs);
    this.stNext.set(o.next);
    this.stAct.set(o.act);
    this.stRew.set(o.rew);
    this.stDone.set(o.done);
    this.stGam.set(o.gam);
    this.stN = o.n;
  }

  // Bir karar adımı bitti (blok sonu veya bölüm sonu): geçmişe ekle, n adım biriktiyse en eskisini
  // n-adımlı geçiş olarak belleğe yaz:  R = Σ γ^k r_k ,  s' = n adım sonraki gözlem,  indirim γ^n
  _finishStep(sim, i, done) {
    const D = OBS_SIZE;
    const slot = i * NMAX + ((this.hStart[i] + this.hLen[i]) % NMAX);
    this.hObs.set(this.pObs.subarray(i * D, i * D + D), slot * D);
    this.hAct[slot * A] = this.pAct[i * A];
    this.hAct[slot * A + 1] = this.pAct[i * A + 1];
    this.hRew[slot] = this.racc[i];
    this.hLen[i]++;
    this.open[i] = 0;
    const n = Math.min(NMAX, Math.max(1, this.cfg.nStep | 0 || 1));
    if (done) {
      // süre limiti gerçek bir son değildir → önyükleme yapılsın (done = 0)
      const term = !isTruncated(sim, i);
      while (this.hLen[i] > 0) this._emit(sim, i, term);
    } else {
      while (this.hLen[i] >= n) this._emit(sim, i, false);
    }
  }

  _emit(sim, i, term) {
    if (this.stN >= this.stCap) this._stGrow();
    const D = OBS_SIZE, g = this.cfg.gamma, m = this.hLen[i], h0 = this.hStart[i];
    let R = 0, gk = 1;
    for (let k = 0; k < m; k++) {
      R += gk * this.hRew[i * NMAX + ((h0 + k) % NMAX)];
      gk *= g;
    }
    const slot = i * NMAX + h0, n = this.stN++;
    this.stObs.set(this.hObs.subarray(slot * D, slot * D + D), n * D);
    this.stNext.set(sim.obs.subarray(i * D, i * D + D), n * D); // bitişte: son hesaplanan gözlem
    this.stAct[n * A] = this.hAct[slot * A];
    this.stAct[n * A + 1] = this.hAct[slot * A + 1];
    this.stRew[n] = R;
    this.stDone[n] = term ? 1 : 0;
    this.stGam[n] = gk; // γ^m
    this.hStart[i] = (h0 + 1) % NMAX;
    this.hLen[i] = m - 1;
    this.added++;
  }

  // normalize gözlem → aksiyon (tanh uzayı)
  _policy(x, off, i) {
    const out = forward(this.actor, 0, this.sizes, x, off, this.bufA, this.bufB, false);
    for (let d = 0; d < A; d++) {
      let u = out[d];
      if (!this.deterministic) {
        let ls = out[2 + d];
        ls = ls < SAC_LOGSTD_MIN ? SAC_LOGSTD_MIN : ls > SAC_LOGSTD_MAX ? SAC_LOGSTD_MAX : ls;
        u += Math.exp(ls) * this.rng.gauss();
      }
      this.cur[i * A + d] = Math.tanh(u);
    }
  }

  act(sim) {
    const N = this.N, D = OBS_SIZE;
    if (this.tickCount >= Math.max(1, this.cfg.updateEvery | 0)) {
      if (this.busy) return false; // işçi önceki turu bitirmedi → güncelleme oranını korumak için bekle
      this._launchRound();
    }
    const obs = sim.obs, st = sim.status;
    if (this.k === 0) {
      if (this.useObsNorm) {
        for (let i = 0; i < N; i++) this.mask[i] = st[i] === RUNNING ? 1 : 0;
        this.norm.update(obs, 0, D, N, this.mask);
      }
      for (let i = 0; i < N; i++) {
        if (st[i] !== RUNNING) { this.open[i] = 0; continue; }
        this.norm.apply(obs, i * D, this.nrm, 0);
        this._policy(this.nrm, 0, i);
        this.pObs.set(obs.subarray(i * D, i * D + D), i * D);
        this.pAct[i * A] = this.cur[i * A];
        this.pAct[i * A + 1] = this.cur[i * A + 1];
        this.racc[i] = 0;
        this.open[i] = 1;
      }
    } else {
      // blok ortasında yeniden doğan araçlar: kaydedilmeyen aksiyon
      for (let i = 0; i < N; i++) {
        if (this.open[i] || st[i] !== RUNNING) continue;
        this.norm.apply(obs, i * D, this.nrm, 0);
        this._policy(this.nrm, 0, i);
      }
    }
    sim.actions.set(this.cur);
    return true;
  }

  record(sim) {
    const N = this.N, rew = sim.reward, done = sim.done;
    for (let i = 0; i < N; i++) {
      if (!this.open[i]) continue;
      this.racc[i] += rew[i];
      if (done[i]) this._finishStep(sim, i, true);
    }
    this.k++;
    if (this.k >= this.K) {
      for (let i = 0; i < N; i++) if (this.open[i]) this._finishStep(sim, i, false);
      this.k = 0;
    }
    this.tickCount++;
  }

  _hp() {
    const c = this.cfg;
    return {
      batch: c.batch, lr: c.lr, alphaLr: c.lr, gamma: c.gamma, tau: c.tau, warmup: c.warmup,
      rewardScale: c.rewardScale, rewardClip: c.rewardClip, targetEntropy: c.targetEntropy, maxGradNorm: c.maxGradNorm,
    };
  }

  _launchRound() {
    const c = this.cfg, D = OBS_SIZE, n = this.stN;
    const batch = {
      n,
      obs: this.stObs.slice(0, n * D),
      next: this.stNext.slice(0, n * D),
      act: this.stAct.slice(0, n * A),
      rew: this.stRew.slice(0, n),
      done: this.stDone.slice(0, n),
      gam: this.stGam.slice(0, n),
    };
    this.stN = 0;
    this.tickCount = 0;
    this.rounds++;
    const norm = { mu: this.norm.mu.slice(), inv: this.norm.inv.slice() };
    this.busy = true;
    this.updater.round(batch, Math.max(0, c.gradSteps | 0), this._hp(), norm, this.epoch, (state, stats, epoch) => {
      if (epoch !== this.epoch) return; // bu arada durum yüklendi → eski sonucu yok say
      this.busy = false;
      this.bufferSize = stats.size;
      if (!state) return; // ısınma: henüz öğrenme yok
      this.actor.set(state.actor);
      this.learnerState = state;
      this.updates++;
      this.lastStats = stats;
      if (this.onUpdate) this.onUpdate(stats);
    });
  }

  // ---- beyin ----
  _exportParams() {
    const folded = foldNorm(this.actor, this.sizes, this.norm.mu, this.norm.inv);
    return trimOutputs(folded, this.sizes, A); // yalnızca μ çıkışları
  }

  brainOf() {
    const { params, sizes } = this._exportParams();
    return {
      algo: 'sac',
      sizes,
      params,
      outTanh: false,
      squash: true,
      discrete: false,
      obsNorm: { mean: Array.from(this.norm.mean), var: Array.from(this.norm.var), count: this.norm.count },
    };
  }

  // tanh çıkışlı beyinler (SAC ortalaması, GA, ES, CMA-ES) aktörün μ kısmına yüklenir; log σ ve Q ağları korunur
  seed(brain) {
    if (!brain || brain.discrete || !(brain.outTanh || brain.squash)) return false;
    const L = this.sizes.length - 1;
    const trimmed = [...this.sizes.slice(0, L), A];
    if (!sameSizes(brain.sizes, trimmed)) return false;
    if (brain.algo === 'sac' && brain.obsNorm && brain.obsNorm.mean && brain.obsNorm.mean.length === OBS_SIZE) {
      this.norm.setState({ n: OBS_SIZE, mean: brain.obsNorm.mean, var: brain.obsNorm.var, count: brain.obsNorm.count });
    }
    const p = unfoldNorm(Float32Array.from(brain.params), trimmed, this.norm.mu, this.norm.inv);
    // gizli katmanlar aynen; son katmanda μ satırları beyinden, logσ satırları mevcut aktörden
    const nin = this.sizes[L - 1];
    let off = 0;
    for (let l = 0; l < L - 1; l++) off += this.sizes[l] * this.sizes[l + 1] + this.sizes[l + 1];
    const actor = this.actor;
    actor.set(p.subarray(0, off), 0);
    actor.set(p.subarray(off, off + nin * A), off);
    actor[off + nin * 2 * A] = p[off + nin * A];
    actor[off + nin * 2 * A + 1] = p[off + nin * A + 1];
    const base = this.updater.state() || this.learnerState;
    const fresh = new SACLearner({ sizesA: this.sizes, sizesQ: this.sizesQ, actor, q1: base.q1, q2: base.q2, lr: this.cfg.lr, alpha0: Math.exp(base.logAlpha), seed: this.learnerSeed, capacity: 1000 }).getState();
    fresh.q1t = base.q1t.slice();
    fresh.q2t = base.q2t.slice();
    fresh.adamQ1 = base.adamQ1;
    fresh.adamQ2 = base.adamQ2;
    this._pushLearner(fresh);
    return true;
  }

  _pushLearner(st) {
    this.epoch++;
    this.busy = false;
    if (this.learnerState) this.learnerState = st;
    this.updater.setState(st);
    this.k = 0;
    this.open.fill(0);
    this.hLen.fill(0);
    this.stN = 0;
    this.tickCount = 0;
  }

  netOf() {
    const key = this.updates + ':' + this.norm.count;
    if (this._netKey !== key) {
      this._netKey = key;
      this._net = this._exportParams();
    }
    return { sizes: this._net.sizes, params: this._net.params, off: 0, outTanh: true, outputLabels: ['Direksiyon', 'Gaz/Fren'] };
  }

  describe() {
    const s = this.lastStats;
    const buf = `bellek ${((this.bufferSize ?? this.added) / 1000).toFixed(0)}k`;
    if (!s) return `Isınma: ${buf} / ${(this.cfg.warmup / 1000).toFixed(0)}k geçiş · henüz öğrenme yok`;
    return `Tur: ${this.updates} · α: ${s.alpha.toFixed(3)} · entropi: ${s.entropy.toFixed(2)} · Q: ${s.q.toFixed(2)} · Q-kayıp: ${s.qLoss.toFixed(3)} · ${buf} · ${s.ms.toFixed(0)} ms/${s.steps} adım`;
  }

  hudText() {
    return `Tur ${this.tickCount}/${this.cfg.updateEvery} adım · her ${this.K} adımda karar · ${this.cfg.gradSteps} gradyan adımı/tur`;
  }

  // ---- kalıcılık (tekrar belleği kaydedilmez) ----
  getState() {
    const ls = this.updater.state() || this.learnerState;
    const cp = (a) => ({ m: a.m.slice(), v: a.v.slice(), t: a.t });
    return {
      algo: 'sac',
      v: 1,
      obsSize: OBS_SIZE,
      sizes: this.sizes.slice(),
      sizesQ: this.sizesQ.slice(),
      learner: {
        actor: ls.actor.slice(), q1: ls.q1.slice(), q2: ls.q2.slice(), q1t: ls.q1t.slice(), q2t: ls.q2t.slice(),
        logAlpha: ls.logAlpha, adamA: cp(ls.adamA), adamQ1: cp(ls.adamQ1), adamQ2: cp(ls.adamQ2), adamAl: { ...ls.adamAl },
        rng: ls.rng, steps: ls.steps,
      },
      norm: this.norm.getState(),
      useObsNorm: this.useObsNorm,
      updates: this.updates,
      learnerSeed: this.learnerSeed,
    };
  }

  setState(s) {
    if (!s || s.algo !== 'sac' || s.obsSize !== OBS_SIZE) return false;
    if (!sameSizes(s.sizes, this.sizes) || !sameSizes(s.sizesQ, this.sizesQ)) return false;
    const L = s.learner;
    if (!L || L.actor.length !== this.actor.length) return false;
    this.norm.setState(s.norm);
    this.useObsNorm = !!s.useObsNorm;
    this.updates = s.updates | 0;
    this.learnerSeed = s.learnerSeed >>> 0;
    this.actor.set(L.actor);
    const f = (a) => Float32Array.from(a);
    const cp = (a) => ({ m: f(a.m), v: f(a.v), t: a.t });
    this._pushLearner({
      actor: f(L.actor), q1: f(L.q1), q2: f(L.q2), q1t: f(L.q1t), q2t: f(L.q2t), logAlpha: L.logAlpha,
      adamA: cp(L.adamA), adamQ1: cp(L.adamQ1), adamQ2: cp(L.adamQ2), adamAl: { ...L.adamAl }, rng: L.rng, steps: L.steps,
    });
    return true;
  }

  dispose() {
    this.updater.dispose();
  }
}

export const SAC_DEFAULTS = {
  hidden: [32, 32],
  actionRepeat: 4,
  gamma: 0.99,
  nStep: 3,
  lr: 0.001,
  tau: 0.02,
  batch: 128,
  bufferSize: 300000,
  updateEvery: 32,
  gradSteps: 64,
  warmup: 10000,
  alpha0: 0.02,
  initLogStd: -1,
  targetEntropy: -2,
  rewardScale: 0.1,
  rewardClip: 20,
  maxGradNorm: 10,
  obsNorm: 1,
};
