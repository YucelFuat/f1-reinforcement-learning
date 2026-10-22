// Algoritma karşılaştırma aracı (headless). Bir algoritmayı belirli bir pistte eğitir, ilerlemeyi yazdırır ve
// sonunda tek satırlık bir özet (JSON) verir.
// Kullanım:
//   node tools/algo-bench.js --algo cmaes --cars 300 --track kidney --gens 40
//   node tools/algo-bench.js --algo ppoc  --cars 128 --track kidney --updates 300 --minutes 5
//   node tools/algo-bench.js --algo sac   --cars 128 --track oval --updates 400 --set gradSteps=32,lr=0.0005
// Seçenekler: --seed S  --every K (kaç güncellemede/nesilde bir satır)  --set a=b,c=d (cfg[algo] üzerine yaz)
//             --spawn start|mixed|random  --physics f1|easy  --quiet 1
import { defaultConfig, TICK_RATE, autoTimeLimit, physicsPreset } from '../src/config.js';
import { TRACK_DEFS, Track, randomTrackDef } from '../src/track.js';
import { Trainer } from '../src/trainer.js';
import { ALGOS } from '../src/algos/index.js';

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const algo = args.algo || 'cmaes';
const cars = +(args.cars || 128);
const trackId = args.track || 'oval';
const seed = +(args.seed || 1);
const isPop = ALGOS[algo]?.kind === 'population';
const gens = +(args.gens || 40);
const updates = +(args.updates || 300);
const minutes = +(args.minutes || 0);
const every = +(args.every || (isPop ? 1 : 10));
const quiet = args.quiet === '1';

const def = trackId.startsWith('random') ? randomTrackDef(+(trackId.split('-')[1] || 1)) : TRACK_DEFS.find((t) => t.id === trackId);
if (!def) { console.error('Pist bulunamadı:', trackId); process.exit(1); }
if (!ALGOS[algo]) { console.error('Algoritma bulunamadı:', algo); process.exit(1); }

const cfg = defaultConfig();
const track = new Track(def);
cfg.rules.timeLimitSec = autoTimeLimit(track);
if (args.physics) cfg.physics = physicsPreset(args.physics);
if (args.spawn) cfg.rules.spawn = args.spawn;
if (ALGOS[algo].defaults && !cfg[algo]) cfg[algo] = structuredClone(ALGOS[algo].defaults);
if (args.set) {
  for (const kv of args.set.split(',')) {
    const [k, v] = kv.split('=');
    if (k === 'hidden') cfg[algo].hidden = v.split('x').map(Number);
    else cfg[algo][k] = +v;
  }
}

const tr = new Trainer({ cfg, track, algo, carCount: cars, seed });
const t0 = performance.now();
let firstFinish = null, firstFinishSec = null;
let updMs = 0, updN = 0;
const progHist = [];
tr.on('generation', (g) => {
  const el = (performance.now() - t0) / 1000;
  if (g.finishers > 0 && firstFinish == null) { firstFinish = g.gen; firstFinishSec = el; }
  progHist.push(g.avgProgress);
  if (g.extra && g.extra.ms != null) { updMs += g.extra.ms; updN++; }
  let maxProg = g.avgProgress;
  if (!isPop) maxProg = tr.epWindow.reduce((m, e) => Math.max(m, e.prog), 0);
  if (!quiet && (g.gen % every === 0 || g.gen === 1)) {
    const lap = g.bestLap ? g.bestLap.toFixed(2) + 's' : '-';
    const bl = tr.bestEverLapTicks ? (tr.bestEverLapTicks / TICK_RATE).toFixed(2) + 's' : '-';
    console.log(`#${String(g.gen).padStart(4)} ${el.toFixed(0).padStart(4)}s best ${g.best.toFixed(0).padStart(6)} avg ${g.avg.toFixed(0).padStart(6)} fin ${String(g.finishers).padStart(4)} prog ${(g.avgProgress * 100).toFixed(1)}% max ${(maxProg * 100).toFixed(0)}% lap ${lap} best ${bl} | ${tr.algo.describe()}`);
  }
});

const limit = isPop ? () => tr.generation > gens : () => tr.algo.updates >= updates;
let lastCheck = performance.now();
while (!limit()) {
  tr.tick();
  if (minutes > 0 && tr.totalTicks % 64 === 0) {
    const now = performance.now();
    if (now - lastCheck > 1000) {
      lastCheck = now;
      if ((now - t0) / 60000 >= minutes) { console.log('Süre doldu.'); break; }
    }
  }
}
const total = (performance.now() - t0) / 1000;
const last = progHist.slice(-10);
const summary = {
  algo, track: trackId, cars: tr.sim.N, seed,
  units: isPop ? tr.generation - 1 : tr.algo.updates,
  totalSec: +total.toFixed(1),
  ticks: tr.totalTicks,
  firstFinish, firstFinishSec: firstFinishSec != null ? +firstFinishSec.toFixed(1) : null,
  bestLap: tr.bestEverLapTicks ? +(tr.bestEverLapTicks / TICK_RATE).toFixed(2) : null,
  finalProg: last.length ? +((last.reduce((a, b) => a + b, 0) / last.length) * 100).toFixed(1) : null,
  maxProg: progHist.length ? +(Math.max(...progHist) * 100).toFixed(1) : null,
  lastFinishRate: tr.lastGen ? +(tr.lastGen.finishRate * 100).toFixed(1) : null,
  msPerUpdate: updN ? +(updMs / updN).toFixed(1) : null,
  secPerUnit: +(total / Math.max(1, isPop ? tr.generation - 1 : tr.algo.updates)).toFixed(3),
};
console.log('ÖZET ' + JSON.stringify(summary));
tr.dispose();
