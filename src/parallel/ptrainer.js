// Çok çekirdekli eğitim (yalnızca popülasyon algoritmaları: GA / ES / CMA-ES).
//
// Ana iş parçacığı: öğrenme algoritması, nesil sonu (Trainer.endGeneration), istatistikler ve çizim.
// İşçiler (Web Worker): araçların ardışık parçalarını sürer (sinir ağı + fizik); her parça kendi küçük
// Simulation'ıdır (bkz. plan: yük dengesi). Yarış modunda parçalar tam serilerdir.
// Solo modda sonuçlar tek çekirdekli Trainer ile birebir aynıdır (aynı tohum → aynı nesil geçmişi).
// Tüm araç dizileri SharedArrayBuffer'dadır: ana iş parçacığındaki `this.sim` bunların tam boy görünümlerini
// kullanan normal bir Simulation'dır → çizici, HUD ve endGeneration hiçbir değişiklik olmadan çalışır.
//
// Gereksinim: crossOriginIsolated (sunucu COOP: same-origin + COEP: require-corp başlıklarını göndermeli).
// Ana döngü ASLA beklemez: trainer.tick() yerine her karede trainer.pump(n) çağrılır.

import { Trainer } from '../trainer.js';
import { Simulation } from '../sim.js';
import { ALGOS } from '../algos/index.js';
import { paramCount } from '../nn.js';

const SIM_CFG_KEYS = ['physics', 'car', 'rules', 'reward', 'sensors']; // sim.js'nin okuduğu ayarlar
const MIN_CARS_PER_WORKER = 24;  // daha az araç için ayrı çekirdek açmaya değmez
const MAX_DEFAULT_WORKERS = 8;
const SHARE_TRACK_BYTES = 64 * 1024; // bundan büyük pist dizileri (sdf, sgrid) işçilere kopyalanmaz, paylaşılır
const LEASE_MS = 300;            // sınırsız hızda izin süresi: ana döngü yenilemezse işçiler durur
const STARTUP_TIMEOUT_MS = 20000;

const hwThreads = () => (globalThis.navigator && navigator.hardwareConcurrency) || 1;

// Track örneğinin işçiye gönderilebilir kopyası (metotlar işçide Track.prototype'tan gelir).
const trackCache = new WeakMap();
function trackSnapshot(track) {
  let s = trackCache.get(track);
  if (s) return s;
  s = {};
  for (const k of Object.keys(track)) {
    if (k.startsWith('_')) continue; // önbellekler (hız profili vb.) işçide yeniden hesaplanır
    const v = track[k];
    if (typeof v === 'function' || typeof v === 'symbol') continue;
    if (v === null || typeof v !== 'object') {
      s[k] = v;
    } else if (ArrayBuffer.isView(v)) {
      if ('BYTES_PER_ELEMENT' in v && v.byteLength >= SHARE_TRACK_BYTES && !(v.buffer instanceof SharedArrayBuffer)) {
        const c = new v.constructor(new SharedArrayBuffer(v.byteLength), 0, v.length);
        c.set(v);
        s[k] = c;
      } else s[k] = v;
    } else {
      const p = Object.getPrototypeOf(v);
      if (!Array.isArray(v) && p !== Object.prototype && p !== null) continue; // sınıf örnekleri (çizim önbelleği vb.)
      try {
        structuredClone(v);
        s[k] = v;
      } catch { /* kopyalanamıyor: simülasyon için gerekmez */ }
    }
  }
  trackCache.set(track, s);
  return s;
}

export class ParallelTrainer extends Trainer {
  // Bu tarayıcıda ve bu algoritmayla çok çekirdekli mod kullanılabilir mi?
  static supported(algoName = 'ga') {
    try {
      return !!(
        globalThis.crossOriginIsolated &&
        typeof SharedArrayBuffer !== 'undefined' &&
        typeof Worker !== 'undefined' &&
        hwThreads() > 1 &&
        ALGOS[algoName] && ALGOS[algoName].kind === 'population'
      );
    } catch {
      return false;
    }
  }

  // Varsayılan işçi sayısı: (mantıksal çekirdek − 1), en çok 8, işçi başına en az ~24 araç
  static defaultWorkers(carCount) {
    const byCars = Math.max(1, Math.floor(carCount / MIN_CARS_PER_WORKER));
    return Math.max(1, Math.min(hwThreads() - 1, MAX_DEFAULT_WORKERS, byCars));
  }

  // Araçları işçilere böl → işçi başına [[başlangıç, adet]…] (her parça ardışık araçlar).
  // Yük dengesi: popülasyonun başı sistematik olarak "ağır"dır (GA elitleri, ES/CMA-ES'te ortalama politika = en
  // uzun yaşayan araçlar). Bu yüzden ilk ~%10 küçük parçalar halinde işçilere sırayla dağıtılır, kalan araçlar
  // (istatistiksel olarak dengeli) her işçiye tek ardışık blok olarak verilir. GA, 8 işçi, ölçülen verim:
  // tek blok ~%66, 4'lü parçalar ~%84, bu düzen ~%88-90. Az parça = az sabit adım maliyeti ve işçiler arasında
  // önbellek satırı paylaşımı (false sharing) yalnızca küçük ön bölgede.
  // Yarış: tüm sınırlar seri (heat, H araç) sınırındadır; tek araçlı son seri komşu parçaya eklenir
  // (tek araçlı Simulation yarış modunu kapatırdı). frontCars: ön bölge parça boyu (0 = otomatik, 2 araç).
  static plan(N, H, K, frontCars = 0) {
    const units = Math.ceil(N / H); // seri sayısı (solo: araç sayısı)
    K = Math.max(1, Math.min(K, units));
    if (K === 1) return [[[0, N]]];
    const f = Math.max(1, Math.round((frontCars || 2) / H)); // ön bölge parça boyu (seri)
    let front = Math.ceil((units * 0.1) / (f * K)) * f * K;  // her işçiye eşit sayıda ön parça
    if (front > units) front = Math.floor(units / (f * K)) * f * K;
    const parts = []; // [başlangıç serisi, bitiş serisi, işçi]
    for (let u = 0, j = 0; u < front; u += f, j++) parts.push([u, u + f, j % K]);
    const R = units - front;
    for (let k = 0; k < K; k++) {
      const a = front + Math.floor((k * R) / K), b = front + Math.floor(((k + 1) * R) / K);
      if (b > a) parts.push([a, b, k]);
    }
    const chunks = parts.map(([a, b, k]) => ({ s: a * H, e: Math.min(N, b * H), k }));
    if (H > 1 && N > 1) {
      const last = chunks.find((c) => c.e === N);
      if (last.e - last.s < 2) {
        chunks.find((c) => c.e === last.s).e = N;
        chunks.splice(chunks.indexOf(last), 1);
      }
    }
    const out = Array.from({ length: K }, () => []);
    for (const c of chunks) out[c.k].push([c.s, c.e - c.s]);
    for (const w of out) w.sort((x, y) => x[0] - y[0]);
    return out.filter((w) => w.length);
  }

  // opts: Trainer seçenekleri + workers (0/boş = otomatik), sliceMs (işçi rapor aralığı, ms)
  constructor(opts = {}) {
    const seed = opts.seed ?? ((Math.random() * 1e9) | 0);
    super({ ...opts, seed });
    if (!this.isPopulation) {
      if (this.algo.dispose) this.algo.dispose();
      throw new Error('Çok çekirdekli mod yalnızca popülasyon algoritmalarında (GA / ES / CMA-ES) çalışır');
    }
    this.seed = seed;
    this.requestedWorkers = opts.workers | 0;
    this.chunkCars = opts.chunkCars | 0; // ön bölge parça boyu, 0 = otomatik (bkz. plan)
    this.sliceMs = opts.sliceMs || 12;
    this.workers = [];
    this.failure = null;
    this._fallback = false;
    this._disposed = false;
    this._seq = 0;        // nesil sırası (işçi raporları buna göre eşleşir)
    this._epoch = 0;      // işçi kurulum sayısı (RNG tohumu için)
    this._pending = null; // 'end' | 'restart': işçiler durunca yapılacak iş
    this._stopSent = false;
    this._lastTick = 0;
    this._ticksAcc = 0;
    this._cfgKey = '';
    this._loadT = performance.now();
    this._loads = [];
    this._readyDone = false;
    this._deferred = false;
    this.ready = new Promise((res) => (this._readyRes = res));
    this._watchAlgo();
    this.sim = this._makeSharedSim(this.track);
    this._setupWorkers();
  }

  // Politikaları dışarıdan değiştiren çağrılar (beyin yükleme: algo.seed, oturumu sürdürme: algo.setState —
  // ör. persist.js restoreTrainer) işçilere otomatik yansısın: bu algoritma örneğinde sarmalanır.
  _watchAlgo() {
    const algo = this.algo;
    for (const m of ['seed', 'setState']) {
      const orig = algo[m];
      if (typeof orig !== 'function') continue;
      algo[m] = (...a) => {
        const ok = orig.apply(algo, a);
        if (ok && this.algo === algo) this.resyncPolicies();
        return ok;
      };
    }
  }

  // ---------- dışa açık durum ----------
  get workerCount() {
    return this._fallback || this._disposed ? 0 : this.workers.length;
  }

  get parallel() {
    return !this._fallback && !this._disposed;
  }

  // İşçilerden en az biri çalışıyor ya da son gönderilen mesajı henüz işlemedi
  get busy() {
    return this.parallel && !this._allIdle();
  }

  // Her işçinin araç parçaları [[başlangıç, adet]…]
  get slices() {
    return this.workers.map((w) => w.chunks.map((c) => c.slice()));
  }

  // İşçi başına doluluk (0-1), ~0.5 sn pencerede
  get workerLoads() {
    const now = performance.now();
    const dt = now - this._loadT;
    if (dt >= 500) {
      this._loads = this.workers.map((w) => {
        const v = Math.min(1, w.busyMs / dt);
        w.busyMs = 0;
        return v;
      });
      this._loadT = now;
    }
    return this._loads;
  }

  describeParallel() {
    if (this._fallback) return 'Tek çekirdek (işçiler başlatılamadı)';
    const l = this.workerLoads;
    const avg = l.length ? l.reduce((a, b) => a + b, 0) / l.length : 0;
    return `${this.workers.length} işçi · doluluk %${(avg * 100).toFixed(0)}`;
  }

  // ---------- ana döngü ----------
  // Engellemez: boştaki işçilere en çok maxTicks adım izni verir ve hemen döner (Infinity = olabildiğince hızlı).
  // Dönüş: son çağrıdan bu yana tamamlanan simülasyon adımı (geliştirici paneli için).
  // budgetMs yalnızca işçiler başlatılamazsa (tek çekirdeğe dönüş) kullanılır.
  pump(maxTicks = Infinity, budgetMs = 16) {
    if (this._disposed) return 0;
    if (this._fallback) return this._pumpSync(maxTicks, budgetMs);
    const now = performance.now();
    for (const w of this.workers) {
      if (!w.ready && now - w.spawnT > STARTUP_TIMEOUT_MS) {
        this._fail(new Error('Simülasyon işçileri zamanında başlamadı'));
        return this._pumpSync(maxTicks, budgetMs);
      }
    }
    this._syncCfg();
    const n = maxTicks === Infinity ? Infinity : Math.floor(maxTicks);
    if (n > 0 && !this._pending) {
      for (const w of this.workers) {
        if (w.seqRep === this._seq && w.done) continue; // nesli bitti, diğerlerini bekliyor
        this._send(w, n === Infinity ? { type: 'allow', n, lease: LEASE_MS } : { type: 'allow', n });
      }
    }
    const t = this._ticksAcc;
    this._ticksAcc = 0;
    return t;
  }

  // Uyumluluk: senkron tick() yoktur → bir adımlık izin verir ve "beklemede" (false) döner.
  // (İşçiler başlatılamadıysa normal tek çekirdekli tick çalışır.)
  tick() {
    if (this._fallback) return super.tick();
    this.pump(1);
    return false;
  }

  // İşçileri hemen durdur (isteğe bağlı; pump çağrılmazsa zaten LEASE_MS içinde dururlar)
  pause() {
    if (!this.parallel) return;
    for (const w of this.workers) this._send(w, { type: 'stop' });
  }

  forceEndGeneration() {
    if (this._fallback) return super.forceEndGeneration();
    this._barrier('end');
  }

  // Algoritmanın politikaları değişti: işçiler durunca bu nesil aynı başlangıç noktasından baştan sürülür.
  // loadBrain (→ algo.seed) ve algo.setState bunu kendiliğinden çağırır (bkz. _watchAlgo).
  // Ertelenir (en erken mikro görevde) → çağıranın hemen ardından yaptığı değişiklikler (ör. restoreTrainer'ın
  // kaydedilen başlangıç noktası ve RNG'si) dahil olur.
  resyncPolicies() {
    if (this.parallel) this._barrier('restart');
  }

  rebuildSim() {
    super.rebuildSim();
    if (!this.parallel) return;
    this.sim = this._makeSharedSim(this.track);
    this._setupWorkers();
  }

  setTrack(track) {
    super.setTrack(track);
    if (!this.parallel) return;
    this.sim = this._makeSharedSim(track);
    this._setupWorkers();
  }

  dispose() {
    this._disposed = true;
    for (const w of this.workers) w.worker.terminate();
    this.workers = [];
    super.dispose();
  }

  // ---------- iç işler ----------
  // Tüm araç dizileri (ve ısı haritası) SharedArrayBuffer'da. Ad → {sab, type, len} kaydı işçilere gider;
  // işçiler araç başına dizilerde kendi dilimlerinin görünümünü alır (bkz. sim-worker.js alloc).
  _makeSharedSim(track) {
    const arrays = {};
    const alloc = (name, T, len) => {
      const sab = new SharedArrayBuffer(Math.max(1, len) * T.BYTES_PER_ELEMENT);
      arrays[name] = { sab, type: T.name, len };
      return new T(sab, 0, len);
    };
    const sim = new Simulation(track, this.sim.N, this.cfg, this.rng, { alloc });
    this._arrays = arrays;
    return sim;
  }

  _spawnWorker(k) {
    const worker = new Worker(new URL('./sim-worker.js', import.meta.url), { type: 'module', name: `sim-isci-${k + 1}` });
    const w = {
      worker, k, sync: new Int32Array(new SharedArrayBuffer(4)), spawnT: performance.now(),
      sent: 0, lastMsg: 0, idle: false, ready: false, seqRep: -1, done: false,
      chunks: [], count: 0, tick: 0, alive: 0, finished: 0, crash: 0, bs: [0, 0, 0], busyMs: 0,
    };
    worker.onmessage = (e) => this._onMessage(w, e.data);
    worker.onerror = (e) => {
      if (e && e.preventDefault) e.preventDefault();
      this._fail(new Error(`Simülasyon işçisi #${k + 1} hata verdi: ${(e && e.message) || 'yüklenemedi'}`));
    };
    worker.onmessageerror = () => this._fail(new Error(`Simülasyon işçisi #${k + 1}: mesaj çözülemedi`));
    return w;
  }

  _send(w, msg, transfer) {
    msg.id = ++w.sent;
    Atomics.add(w.sync, 0, 1); // önceki paylaşımlı bellek yazımları işçide görünür olsun
    w.worker.postMessage(msg, transfer || []);
  }

  // Araçları işçilere böl (yarışta seri sınırlarında) ve her işçiyi kur
  _setupWorkers() {
    const sim = this.sim, N = sim.N;
    const want = this.requestedWorkers > 0 ? this.requestedWorkers : ParallelTrainer.defaultWorkers(N);
    const plan = ParallelTrainer.plan(N, sim.H, want, this.chunkCars);
    const K = plan.length;
    while (this.workers.length > K) this.workers.pop().worker.terminate();
    while (this.workers.length < K) this.workers.push(this._spawnWorker(this.workers.length));
    this._epoch++;
    this._pending = null;
    this._stopSent = false;
    const track = trackSnapshot(sim.track);
    const cfg = this._cfgSnapshot();
    for (let k = 0; k < K; k++) {
      const w = this.workers[k];
      w.chunks = plan[k];
      w.count = w.chunks.reduce((a, c) => a + c[1], 0);
      w.crash = 0;
      w.seqRep = -1;
      this._send(w, {
        type: 'init', chunks: w.chunks, N, arrays: this._arrays, track, cfg, sync: w.sync, sliceMs: this.sliceMs,
        seed: (this.seed + 104729 * (k + 1) + 15485863 * this._epoch) >>> 0,
      });
    }
    this._broadcastGen();
  }

  _cfgPick() {
    const pick = {};
    for (const k of SIM_CFG_KEYS) if (this.cfg[k] !== undefined) pick[k] = this.cfg[k];
    return pick;
  }

  _cfgSnapshot() {
    const pick = this._cfgPick();
    this._cfgKey = JSON.stringify(pick);
    return structuredClone(pick);
  }

  // Arayüz kaydırıcıları cfg'yi canlı değiştirir → değişince işçilere gönder
  _syncCfg() {
    const pick = this._cfgPick();
    const key = JSON.stringify(pick);
    if (key === this._cfgKey) return;
    this._cfgKey = key;
    const snap = structuredClone(pick);
    for (const w of this.workers) this._send(w, { type: 'cfg', cfg: snap });
  }

  // Yeni nesil: ana simülasyonun seçtiği başlangıç + her aracın bu nesildeki politikası
  _broadcastGen() {
    if (!this.parallel || !this.workers.length) return;
    const sim = this.sim, algo = this.algo, N = sim.N;
    const b0 = algo.brainOf(0);
    const sizes = Array.from(b0.sizes);
    const P = paramCount(sizes);
    const outTanh = b0.outTanh !== false;
    const all = algo.params;
    // GA / ES / CMA-ES: params = N × P ardışık dizi (brainOf(i) bunun dilimi) → doğrudan kopyala
    const fast = all instanceof Float32Array && algo.P === P && all.length >= N * P;
    const cfg = this._cfgSnapshot();
    const spawn = { ...sim.spawnInfo };
    this._seq++;
    this._lastTick = sim.tick;
    for (const w of this.workers) {
      // işçinin parçalarındaki araçların politikaları, parça sırasıyla art arda
      const params = new Float32Array(w.count * P);
      let off = 0;
      for (const [s, c] of w.chunks) {
        if (fast) params.set(all.subarray(s * P, (s + c) * P), off * P);
        else for (let i = 0; i < c; i++) params.set((s + i === 0 ? b0 : algo.brainOf(s + i)).params, (off + i) * P);
        off += c;
      }
      w.done = false;
      w.tick = 0;
      w.alive = w.count;
      w.finished = 0;
      w.bs = [0, 0, 0];
      this._send(w, { type: 'gen', seq: this._seq, spawn, sizes, outTanh, params, cfg }, [params.buffer]);
    }
  }

  _onMessage(w, r) {
    if (!this.parallel) return;
    Atomics.load(w.sync, 0); // işçinin rapordan önceki yazımları artık görünür
    if (r.type === 'err') {
      this._fail(new Error(`Simülasyon işçisi #${w.k + 1}: ${r.message}`), r.stack);
      return;
    }
    if (r.type !== 'rep') return;
    w.lastMsg = r.msg;
    w.idle = r.idle;
    w.busyMs += r.ms;
    if (!w.ready) {
      w.ready = true;
      if (!this._readyDone && this.workers.every((x) => x.ready)) {
        this._readyDone = true;
        this._readyRes(true);
      }
    }
    if (r.seq === this._seq) {
      w.seqRep = r.seq;
      w.done = r.done;
      w.tick = r.tick;
      w.alive = r.alive;
      w.finished = r.finished;
      w.crash = r.crash;
      if (r.bs) w.bs = r.bs;
      if (r.path) {
        const p = this.sim.path;
        for (let i = 0; i < r.path.length; i++) p.push(r.path[i]);
      }
      this._aggregate();
    }
    if (this._pending) {
      if (this._allIdle()) this._runPending();
    } else if (this._genDone()) {
      this._finishGeneration();
    }
  }

  _allIdle() {
    for (const w of this.workers) if (!w.idle || w.lastMsg !== w.sent) return false;
    return true;
  }

  _genDone() {
    if (!this.workers.length) return false;
    for (const w of this.workers) if (w.seqRep !== this._seq || !w.done) return false;
    return true;
  }

  // İşçi özetlerinden ana simülasyonun sayaçları (HUD, nesil kaydı ve sektör rekorları bunları okur)
  _aggregate() {
    const sim = this.sim;
    let tick = 0, alive = 0, fin = 0, crash = 0, s0 = 0, s1 = 0, s2 = 0;
    for (const w of this.workers) {
      if (w.tick > tick) tick = w.tick;
      alive += w.alive;
      fin += w.finished;
      crash += w.crash;
      const b = w.bs;
      if (b[0] && (!s0 || b[0] < s0)) s0 = b[0];
      if (b[1] && (!s1 || b[1] < s1)) s1 = b[1];
      if (b[2] && (!s2 || b[2] < s2)) s2 = b[2];
    }
    sim.tick = tick;
    sim.alive = alive;
    sim.finished = fin;
    sim.crashEvents = crash;
    sim.bestSec[0] = s0;
    sim.bestSec[1] = s1;
    sim.bestSec[2] = s2;
    if (tick > this._lastTick) {
      const d = tick - this._lastTick;
      this.totalTicks += d;
      this._ticksAcc += d;
      this._lastTick = tick;
    }
  }

  // Tüm işçiler neslini bitirdi: normal nesil sonu (olay, geçmiş, rekorlar…) + yeni nesli dağıt
  _finishGeneration() {
    this._aggregate();
    this.endGeneration();
    this._broadcastGen();
  }

  // İşçileri durdur, hepsi durunca action ('end' | 'restart') uygula.
  // 'end' işçiler zaten boştaysa hemen (senkron) uygulanır; 'restart' en erken mikro görevde.
  _barrier(action) {
    if (!this.parallel) return;
    if (this._pending !== 'end') this._pending = action;
    if (this._allIdle()) {
      if (this._pending === 'end') this._runPending();
      else if (!this._deferred) {
        this._deferred = true;
        queueMicrotask(() => {
          this._deferred = false;
          if (this.parallel && this._pending && this._allIdle()) this._runPending();
        });
      }
      return;
    }
    if (!this._stopSent) {
      this._stopSent = true;
      for (const w of this.workers) this._send(w, { type: 'stop' });
    }
  }

  _runPending() {
    const a = this._pending;
    this._pending = null;
    this._stopSent = false;
    this._aggregate();
    if (a === 'end') this.endGeneration();
    else this.sim.resetAll(this.sim.spawnInfo); // aynı nesil, aynı başlangıç noktası
    this._broadcastGen();
  }

  _pumpSync(maxTicks, budgetMs) {
    let t = 0;
    const t0 = performance.now();
    while (t < maxTicks) {
      if (!super.tick()) break;
      t++;
      if ((t & 3) === 0 && performance.now() - t0 > budgetMs) break;
    }
    return t;
  }

  // İşçiler kullanılamıyor: tek çekirdekli çalışmaya dön (bu nesil baştan, paylaşımsız bellekte)
  _fail(err, stack) {
    if (this._fallback || this._disposed) return;
    console.warn('[Çok çekirdekli] Tek çekirdekli simülasyona dönülüyor:', err.message, stack || '');
    this.failure = err;
    for (const w of this.workers) w.worker.terminate();
    this.workers = [];
    this._fallback = true;
    this._pending = null;
    const old = this.sim;
    this.sim = new Simulation(this.track, old.N, this.cfg, this.rng);
    if (old.heat.length === this.sim.heat.length) this.sim.heat.set(old.heat);
    this._lastTick = 0;
    if (!this._readyDone) {
      this._readyDone = true;
      this._readyRes(false);
    }
  }
}
