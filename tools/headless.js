// Tarayıcısız (headless) eğitim: en yüksek hızda eğitir ve en iyi beyni JSON olarak kaydeder.
// Kullanım:  node tools/headless.js --algo ga --cars 300 --track kidney --gens 40 --out brain.json
//            node tools/headless.js --algo ppo --cars 200 --track oval --updates 150
// Ek seçenekler: --spawn start|mixed|random  --mode solo|race  --heat 6  --compound soft|medium|hard
//                --tyre 0|1  --wear 0|1  --ers 0|1  --drs off|zones|race  --pit 0  --seed 1
import fs from 'fs';
import { defaultConfig, TICK_RATE, autoTimeLimit, physicsPreset } from '../src/config.js';
import { TRACK_DEFS, Track, randomTrackDef } from '../src/track.js';
import { Trainer } from '../src/trainer.js';

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const algo = args.algo || 'ga';
const cars = +(args.cars || 200);
const trackId = args.track || 'oval';
const gens = +(args.gens || 30);
const updates = +(args.updates || 100);
const seed = +(args.seed || 1);
const def = trackId.startsWith('random') ? randomTrackDef(+(trackId.split('-')[1] || 1)) : TRACK_DEFS.find((t) => t.id === trackId);
if (!def) { console.error('Pist bulunamadı:', trackId); process.exit(1); }

const cfg = defaultConfig();
if (args.laps) cfg.rules.laps = +args.laps;
if (args.crashes) cfg.rules.maxCrashes = +args.crashes;
const track = new Track(def);
cfg.rules.timeLimitSec = autoTimeLimit(track);
if (args.physics) cfg.physics = physicsPreset(args.physics);
if (args.spawn) cfg.rules.spawn = args.spawn;
if (args.mode) cfg.rules.mode = args.mode;
if (args.heat) cfg.rules.heatSize = +args.heat;
if (args.compound) cfg.car.compound = args.compound;
if (args.tyre) cfg.car.tyreTemp = args.tyre === '1';
if (args.wear) cfg.car.wear = args.wear === '1';
if (args.ers) cfg.car.ers = args.ers === '1';
if (args.drs) cfg.car.drs = args.drs;
if (args.pit) cfg.car.pitLap = +args.pit;
const tr = new Trainer({ cfg, track, algo, carCount: cars, seed });

const t0 = performance.now();
let lastT = t0, lastTicks = 0;
tr.on('generation', (g) => {
  const now = performance.now();
  const tps = ((tr.totalTicks - lastTicks) / ((now - lastT) / 1000));
  lastT = now; lastTicks = tr.totalTicks;
  const lap = g.bestLap ? g.bestLap.toFixed(2) + 's' : '-';
  const bestLap = tr.bestEverLapTicks ? (tr.bestEverLapTicks / TICK_RATE).toFixed(2) + 's' : '-';
  const extra = (g.spins ? ` spin ${g.spins}` : '') + (g.contacts != null ? ` temas ${g.contacts} sollama ${g.overtakes}` : '') + (g.flying ? ' (uçan)' : '');
  if (tr.isPopulation || g.gen % 5 === 0)
    console.log(`#${String(g.gen).padStart(4)} best ${g.best.toFixed(0).padStart(6)} avg ${g.avg.toFixed(0).padStart(6)} fin ${String(g.finishers).padStart(4)} (${(g.finishRate * 100).toFixed(0)}%) prog ${(g.avgProgress * 100).toFixed(0)}% lap ${lap} best ${bestLap}${extra} | ${(tps * cars / 1e6).toFixed(2)}M car-steps/s ${tr.algo.describe()}`);
});

const limit = !tr.isPopulation ? () => tr.algo.updates >= updates : () => tr.generation > gens;
while (!limit()) tr.tick();
console.log(`Toplam ${((performance.now() - t0) / 1000).toFixed(1)} s, ${tr.totalTicks} adım`);
if (tr.idealLap) console.log(`En iyi sektörler: ${tr.bestSectors.map((t) => (t / TICK_RATE).toFixed(2)).join(' / ')}  ideal tur ${tr.idealLap.toFixed(2)} s`);
if (tr.topLaps.length) console.log(`İlk 5: ${tr.topLaps.map((b) => (b.lapTicks / TICK_RATE).toFixed(2)).join(', ')}`);
if (args.out && tr.bestBrain) {
  const b = tr.bestBrain;
  const out = { format: 'rl-race-brain', version: 1, ...b, params: Array.from(b.params), vparams: b.vparams ? Array.from(b.vparams) : undefined };
  fs.writeFileSync(args.out, JSON.stringify(out));
  console.log('Kaydedildi:', args.out);
}
