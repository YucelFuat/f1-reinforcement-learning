// Web Worker yollarını Node'da sınar (tarayıcıdaki asıl çalışma biçimi): worker_threads üzerine küçük bir
// tarayıcı-Worker uyarlayıcısı kurulur, eğitici useWorker: true ile çalıştırılır.
// Denetlenenler: güncellemeler işçide ilerliyor mu, uçuştaki güncelleme sırasında getState/setState güvenli mi,
// işçiden gelen durumla başka bir işçili ajana devam edilebiliyor mu.
// Kullanım: node tools/algo-worker-test.js [--algos ppo,ppoc,sac] [--track oval] [--cars 64] [--updates 30]
import { Worker as NodeWorker } from 'worker_threads';
import { defaultConfig, autoTimeLimit } from '../src/config.js';
import { TRACK_DEFS, Track } from '../src/track.js';
import { Trainer } from '../src/trainer.js';
import { ALGOS } from '../src/algos/index.js';

globalThis.Worker = class {
  constructor(url) {
    const boot = [
      "import { parentPort } from 'worker_threads';",
      'globalThis.self = globalThis;',
      'self.postMessage = (m, t) => parentPort.postMessage(m, t);',
      "parentPort.on('message', (d) => self.onmessage && self.onmessage({ data: d }));",
      `await import(${JSON.stringify(url.href)});`,
    ].join('\n');
    this.w = new NodeWorker(new URL('data:text/javascript,' + encodeURIComponent(boot)));
    this.w.on('message', (d) => this.onmessage && this.onmessage({ data: d }));
    this.w.on('error', (e) => { console.error('İşçi hatası:', e); process.exitCode = 1; });
  }
  postMessage(m, t) { this.w.postMessage(m, t); }
  terminate() { this.w.terminate(); }
};

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const algos = (args.algos || 'ppo,ppoc,sac').split(',');
const track = new Track(TRACK_DEFS.find((t) => t.id === (args.track || 'oval')));
const cars = +(args.cars || 64);
const target = +(args.updates || 30);
const yieldNow = () => new Promise((r) => setImmediate(r));

function makeCfg(algo) {
  const cfg = defaultConfig();
  cfg.rules.timeLimitSec = autoTimeLimit(track);
  if (ALGOS[algo].defaults) cfg[algo] = structuredClone(ALGOS[algo].defaults);
  if (algo === 'sac') Object.assign(cfg.sac, { warmup: 3000, hidden: [32, 32] });
  return cfg;
}

async function drive(tr, until, onChunk) {
  let waits = 0, ticks = 0;
  const t0 = performance.now();
  while (!until()) {
    let n = 0;
    while (n < 500 && tr.tick()) n++;
    ticks += n;
    if (n < 500) waits++;
    if (onChunk) onChunk();
    await yieldNow();
    if (performance.now() - t0 > 240000) throw new Error('zaman aşımı');
  }
  return { waits, ticks, sec: (performance.now() - t0) / 1000 };
}

let fails = 0;
for (const algo of algos) {
  try {
    const cfg = makeCfg(algo);
    const tr = new Trainer({ cfg, track, algo, carCount: cars, seed: 3, useWorker: true });
    if (!tr.algo.updater || !tr.algo.updater.w) throw new Error('işçi kullanılmıyor');
    // uçuştaki güncellemeler sırasında getState çağır (otomatik kayıt benzetimi)
    let snaps = 0, midState = null;
    const r1 = await drive(tr, () => tr.algo.updates >= target, () => {
      if (tr.algo.busy) { midState = tr.algo.getState(); snaps++; }
    });
    const prog = tr.epWindow.reduce((s, e) => s + e.prog, 0) / Math.max(1, tr.epWindow.length);
    // güncelleme uçuştayken durumu geri yükle → eski sonuç yok sayılmalı, eğitim sürmeli
    const S = structuredClone(tr.algo.getState());
    while (!tr.algo.busy) tr.tick();
    if (!tr.algo.setState(structuredClone(midState || S))) throw new Error('setState (uçuşta) başarısız');
    const u1 = tr.algo.updates;
    await drive(tr, () => tr.algo.updates >= u1 + 3);
    // işçi durumu → yeni işçili eğiticiye aktar
    const tr2 = new Trainer({ cfg: makeCfg(algo), track, algo, carCount: cars, seed: 11, useWorker: true });
    if (!tr2.algo.setState(structuredClone(tr.algo.getState()))) throw new Error('setState (yeni eğitici) başarısız');
    const u2 = tr2.algo.updates;
    await drive(tr2, () => tr2.algo.updates >= u2 + 3);
    const b = tr2.algo.brainOf(0);
    if (!b.params.every(Number.isFinite)) throw new Error('beyin parametrelerinde NaN');
    console.log(`${algo.padEnd(5)} GEÇTİ · ${target} güncelleme ${r1.sec.toFixed(1)} s (${r1.ticks} adım, bekleme ${r1.waits}) · ort. ilerleme %${(prog * 100).toFixed(0)} · uçuşta getState ${snaps} kez · uçuşta setState + yeni işçiye aktarım sonrası eğitim sürdü (${tr2.algo.updates} güncelleme)`);
    tr.dispose();
    tr2.dispose();
  } catch (e) {
    fails++;
    console.log(`${algo} KALDI: ${e.stack || e}`);
  }
}
console.log(fails ? `${fails} hata` : 'İşçi testleri geçti');
process.exit(fails ? 1 : 0);
