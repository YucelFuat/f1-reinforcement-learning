// Araç fiziği, sensörler ve ödül/ceza hesabı.
// Performans için tüm araç verisi "Structure of Arrays" (typed array) biçiminde tutulur.
//
// Fizik: iki akslı nokta-kütle modeli
//   • ağırlık ve aero dengesi, boylamsal yük transferi (fren → ön, gaz → arka), yanal yük transferi
//   • lastik yük hassasiyeti, ön/arka aks için ayrı sürtünme çemberi
//   • önden kayma (understeer) ve arkadan kayma (oversteer, kayma açısı β, spin)
//   • lastik sıcaklığı, aşınma, hamur; yakıt kütlesi ve tüketimi; ERS (MGU-K) ve DRS
// Yarış modu: aynı serideki (heat) araçlar birbirini ışınlarla görür, çarpışabilir, sollayabilir.

import {
  RAY_ANGLES_DEG, OBS, OBS_SIZE, TICK_RATE, GRAVITY, AIR_DENSITY, V_REF, LOOKAHEAD_M,
  COMPOUNDS, COMPOUND_IDS, ERS, DRS, FUEL_FLOW_KGS, defaultCar,
} from './config.js';

export const RUNNING = 0, CRASHED = 1, FINISHED = 2, TIMEOUT = 3;

const RAY_COS = RAY_ANGLES_DEG.map((d) => Math.cos((d * Math.PI) / 180));
const RAY_SIN = RAY_ANGLES_DEG.map((d) => Math.sin((d * Math.PI) / 180));
const NRAY = RAY_ANGLES_DEG.length;
const NLOOK = LOOKAHEAD_M.length;
const PI = Math.PI, TWO_PI = Math.PI * 2;
const ACTION_GAIN = 2;
const WHEELBASE = 3.6, TRACKW = 1.6; // m
const SPIN_BETA = 0.55; // rad (~31°): bu kayma açısını aşan araç spin atar
const CAR_LEN = 5.4, CAR_WID = 1.95; // m (araçlar arası temas elipsi)
const GRID_GAP = 8; // m, yarış gridinde sıralar arası
const COMP_TABLE = COMPOUND_IDS.map((id) => COMPOUNDS[id]);

function wrapAngle(a) {
  a = (a + PI) % TWO_PI;
  if (a < 0) a += TWO_PI;
  return a - PI;
}

export function compoundIndex(id) {
  const k = COMPOUND_IDS.indexOf(id);
  return k < 0 ? 1 : k;
}

export class Simulation {
  // opts.alloc(name, Type, length): isteğe bağlı bellek ayırıcı. Çok çekirdekli modda araç dizileri
  // SharedArrayBuffer üzerindeki görünümlerdir (ana iş parçacığı çizer, işçiler adım atar).
  constructor(track, count, cfg, rng, opts = {}) {
    this.track = track;
    this.N = count;
    this.cfg = cfg;
    if (!cfg.car) cfg.car = defaultCar();
    this.rng = rng;
    const N = count;
    const alloc = opts.alloc || ((name, T, len) => new T(len));
    this._alloc = alloc;
    const F32 = (name, k = 1) => alloc(name, Float32Array, N * k);
    const U8 = (name, k = 1) => alloc(name, Uint8Array, N * k);
    const I32 = (name, k = 1) => alloc(name, Int32Array, N * k);
    const U16 = (name) => alloc(name, Uint16Array, N);
    this.x = F32('x');
    this.y = F32('y');
    this.ang = F32('ang');
    this.spd = F32('spd');           // m/s
    this.steerPos = F32('steerPos'); // gerçek direksiyon konumu (servo gecikmeli)
    this.slip = F32('slip');         // 0-1: lastiklerin tutuş sınırını aşma oranı (kayma)
    this.beta = F32('beta');         // rad: kayma açısı (burun ile gidiş yönü arasındaki fark)
    this.aLongPrev = F32('aLongPrev'); // m/s² (yük transferi için önceki ivme)
    this.aLatPrev = F32('aLatPrev');
    this.tyreT = F32('tyreT');       // °C
    this.wear = F32('wear');         // 0-1
    this.comp = U8('comp');
    this.fuel = F32('fuel');         // kg
    this.soc = F32('soc');           // J (ERS batarya)
    this.lapDep = F32('lapDep');     // J bu turda bataryadan kullanılan
    this.lapHarv = F32('lapHarv');   // J bu turda frenden şarj
    this.ersKW = F32('ersKW');       // anlık ERS gücü (+ kullanım, − şarj)
    this.drsOpen = U8('drsOpen');
    this.drsElig = U8('drsElig');
    this.inZone = alloc('inZone', Int8Array, N);
    this.lat = F32('lat');           // px, pist ortasına göre yanal konum
    this.aheadGap = F32('aheadGap'); // m (yarış: öndeki araca), 1e4 = yok
    this.status = U8('status');
    this.progress = F32('progress');
    this.bestProg = F32('bestProg');
    this.lastS = F32('lastS');
    this.goalOff = F32('goalOff');   // px: gridde başlangıç çizgisinin gerisinde başlayanların ek mesafesi
    this.flying = U8('flying');      // 1 = uçan başlangıç (pistin ortasından) → tur rekoru sayılmaz
    this.ticks = I32('ticks');
    this.stall = I32('stall');
    this.crashes = U16('crashes');
    this.spins = U16('spins');
    this.contacts = U16('contacts');
    this.overtakes = alloc('overtakes', Int16Array, N);
    this.place = U8('place');
    this.fitness = alloc('fitness', Float64Array, N);
    this.lapTicks = I32('lapTicks');
    this.lapsDone = U16('lapsDone');
    this.lapStart = I32('lapStart');
    this.bestLapT = I32('bestLapT');
    this.secNext = U8('secNext');
    this.secT0 = I32('secT0');
    this.secTimes = I32('secTimes', 3);
    this.pitted = U8('pitted');
    this.prevX = F32('prevX');
    this.prevY = F32('prevY');
    this.fresh = U8('fresh');
    this.reward = F32('reward');
    this.done = U8('done');
    this.actions = F32('actions', 2);
    this.startX = F32('startX');
    this.startY = F32('startY');
    this.startA = F32('startA');
    this.startV = F32('startV');
    this.obs = F32('obs', OBS_SIZE);
    this.tick = 0;
    this.alive = N;
    this.finished = 0;
    this.crashEvents = 0;
    this.bestSec = new Int32Array(3); // bu koşudaki en iyi sektör süreleri (tick, 0 = yok)
    this.spawnInfo = { s: 0, flying: false };

    // yarış serileri
    this._setupHeats();

    // Çarpma ısı haritası
    this.heatCell = 14;
    const b = track.bounds;
    this.heatW = Math.ceil(b.w / this.heatCell) + 1;
    this.heatH = Math.ceil(b.h / this.heatCell) + 1;
    this.heat = this._alloc('heat', Float32Array, this.heatW * this.heatH); // paylaşımlı (araç başına değil)
    this.heatVersion = 0;

    // 0 numaralı aracın izi (önceki şampiyon / ortalama politika)
    this.path = [];

    if (!opts.noReset) this.resetAll();
  }

  // Simülasyonun kullandığı tüm araç başına dizilerin adı → [tip, araç başına eleman] (çok çekirdekli mod için)
  static arraySpec(cfg) {
    const H = cfg.rules.mode === 'race' ? Math.max(2, Math.min(12, cfg.rules.heatSize | 0 || 6)) : 1;
    const f = Float32Array, u8 = Uint8Array, i32 = Int32Array, u16 = Uint16Array;
    return {
      x: [f, 1], y: [f, 1], ang: [f, 1], spd: [f, 1], steerPos: [f, 1], slip: [f, 1], beta: [f, 1], aLongPrev: [f, 1], aLatPrev: [f, 1],
      tyreT: [f, 1], wear: [f, 1], comp: [u8, 1], fuel: [f, 1], soc: [f, 1], lapDep: [f, 1], lapHarv: [f, 1], ersKW: [f, 1],
      drsOpen: [u8, 1], drsElig: [u8, 1], inZone: [Int8Array, 1], lat: [f, 1], aheadGap: [f, 1], status: [u8, 1], progress: [f, 1],
      bestProg: [f, 1], lastS: [f, 1], goalOff: [f, 1], flying: [u8, 1], ticks: [i32, 1], stall: [i32, 1], crashes: [u16, 1],
      spins: [u16, 1], contacts: [u16, 1], overtakes: [Int16Array, 1], place: [u8, 1], fitness: [Float64Array, 1], lapTicks: [i32, 1],
      lapsDone: [u16, 1], lapStart: [i32, 1], bestLapT: [i32, 1], secNext: [u8, 1], secT0: [i32, 1], secTimes: [i32, 3], pitted: [u8, 1],
      prevX: [f, 1], prevY: [f, 1], fresh: [u8, 1], reward: [f, 1], done: [u8, 1], actions: [f, 2], startX: [f, 1], startY: [f, 1],
      startA: [f, 1], startV: [f, 1], obs: [f, OBS_SIZE], order: [u8, H],
    };
  }

  _setupHeats() {
    const r = this.cfg.rules;
    this.race = r.mode === 'race' && this.N > 1;
    this.H = this.race ? Math.max(2, Math.min(12, r.heatSize | 0 || 6)) : 1;
    this.order = this._alloc('order', Uint8Array, this.N * this.H); // order[i*H + k] = 1: i, serideki k. araçtan önde
    this.heatFinished = new Uint8Array(Math.ceil(this.N / this.H));
  }

  get timeLimitTicks() {
    const r = this.cfg.rules, c = this.cfg.car;
    let sec = r.timeLimitSec * r.laps;
    if (c && c.pitLap > 0 && c.pitLap < r.laps) sec += c.pitLossSec;
    if (this.race) sec += 3;
    return Math.round(sec * TICK_RATE);
  }

  heatRange(i) {
    const a = Math.floor(i / this.H) * this.H;
    return [a, Math.min(this.N, a + this.H)];
  }

  // Bu nesil için başlangıç noktası seç (popülasyon algoritmaları: tüm araçlar aynı noktadan)
  pickSpawn() {
    const mode = this.cfg.rules.spawn || 'start';
    let flying = false;
    if (mode === 'random') flying = true;
    else if (mode === 'mixed') flying = this.rng.next() < 0.5;
    const s = flying ? this.rng.next() * this.track.length : 0;
    return { s, flying };
  }

  resetAll(spawn = null) {
    this.spawnInfo = spawn || this.pickSpawn();
    for (let i = 0; i < this.N; i++) this.resetCar(i, null, this.spawnInfo);
    this.tick = 0;
    this.alive = this.N;
    this.finished = 0;
    this.heatFinished.fill(0);
    this.bestSec.fill(0);
    this.path = [];
    this.computeObs();
  }

  // Tek araç için uçan başlangıç / grid / start çizgisi. pose = {x,y,a,v,flying} (tekrar için)
  resetCar(i, pose = null, spawn = null) {
    const t = this.track, cfg = this.cfg, C = cfg.car;
    const j = cfg.rules.startJitter;
    let sx, sy, sa, sv = 0, flying = false, goalOff = 0;
    if (pose) {
      sx = pose.x; sy = pose.y; sa = pose.a; sv = pose.v || 0; flying = !!pose.flying; goalOff = pose.goalOff || 0;
    } else {
      const sp = spawn || this.spawnInfo;
      flying = !!sp.flying;
      let s = sp.s;
      let latPx = 0;
      if (this.race) {
        const k = i % this.H; // grid sırası
        const back = (k * GRID_GAP) / t.mpp;
        s -= back;
        goalOff = back;
        latPx = (k % 2 ? 1 : -1) * t.halfWidth * 0.38;
      }
      s = ((s % t.length) + t.length) % t.length;
      const idx = t.idxAt(s);
      const ta = t.tan[idx];
      sx = t.cx[idx] - Math.sin(ta) * latPx;
      sy = t.cy[idx] + Math.cos(ta) * latPx;
      sa = ta;
      if (flying) sv = t.speedProfile(cfg.physics)[idx] * 0.8;
      if (j > 0) {
        const lat = (this.rng.next() * 2 - 1) * j * t.halfWidth * 0.5;
        sx += -Math.sin(sa) * lat;
        sy += Math.cos(sa) * lat;
        sa += (this.rng.next() * 2 - 1) * j * 0.3;
      }
    }
    this.startX[i] = sx;
    this.startY[i] = sy;
    this.startA[i] = sa;
    this.startV[i] = sv;
    this.goalOff[i] = goalOff;
    this.flying[i] = flying ? 1 : 0;
    this.x[i] = sx;
    this.y[i] = sy;
    this.prevX[i] = sx;
    this.prevY[i] = sy;
    this.ang[i] = sa;
    this.spd[i] = sv;
    this.steerPos[i] = 0;
    this.slip[i] = 0;
    this.beta[i] = 0;
    this.aLongPrev[i] = 0;
    this.aLatPrev[i] = 0;
    const ci = compoundIndex(C.compound);
    this.comp[i] = ci;
    this.tyreT[i] = flying ? COMP_TABLE[ci].topt - 4 : C.startTemp;
    this.wear[i] = 0;
    this.fuel[i] = this.startFuel();
    this.soc[i] = flying ? ERS.storeJ * 0.75 : ERS.storeJ;
    this.lapDep[i] = 0;
    this.lapHarv[i] = 0;
    this.ersKW[i] = 0;
    this.drsOpen[i] = 0;
    this.drsElig[i] = 0;
    this.inZone[i] = -1;
    this.aheadGap[i] = 1e4;
    this.status[i] = RUNNING;
    this.progress[i] = 0;
    this.bestProg[i] = 0;
    this.lastS[i] = t.sAt(sx, sy);
    this.ticks[i] = 0;
    this.stall[i] = 0;
    this.crashes[i] = 0;
    this.spins[i] = 0;
    this.contacts[i] = 0;
    this.overtakes[i] = 0;
    this.place[i] = 0;
    this.fitness[i] = 0;
    this.lapTicks[i] = 0;
    this.lapsDone[i] = 0;
    this.lapStart[i] = 0;
    this.bestLapT[i] = 0;
    this.secNext[i] = 0;
    this.secT0[i] = 0;
    this.secTimes[i * 3] = this.secTimes[i * 3 + 1] = this.secTimes[i * 3 + 2] = 0;
    this.pitted[i] = 0;
    this.reward[i] = 0;
    this.done[i] = 0;
    this.fresh[i] = 1;
  }

  startFuel() {
    const C = this.cfg.car;
    if (C.fuel !== 'auto' && isFinite(+C.fuel)) return Math.max(0, +C.fuel);
    return (this.track.lengthMeters / 1000) * C.fuelPerKm * this.cfg.rules.laps * 1.05 + 0.5;
  }

  // Sürekli algoritmalar (PPO/SAC) için tek aracı yeniden başlat
  respawnCar(i) {
    const mode = this.cfg.rules.spawn || 'start';
    let flying = mode === 'random' || (mode === 'mixed' && this.rng.next() < 0.5);
    let s = flying ? this.rng.next() * this.track.length : 0;
    if (this.race) {
      // yarış: serideki en arkadaki çalışan aracın 25 m gerisinden uçan başlangıç
      const [a, b] = this.heatRange(i);
      let minP = Infinity, minS = 0;
      for (let k = a; k < b; k++) {
        if (k === i || this.status[k] !== RUNNING) continue;
        const rp = this.progress[k] - this.goalOff[k];
        if (rp < minP) { minP = rp; minS = this.lastS[k]; }
      }
      if (minP < Infinity) {
        flying = true;
        s = minS - 25 / this.track.mpp;
        const idx = this.track.idxAt(s);
        const ta = this.track.tan[idx];
        const latPx = (this.rng.next() * 2 - 1) * this.track.halfWidth * 0.4;
        this.resetCar(i, {
          x: this.track.cx[idx] - Math.sin(ta) * latPx,
          y: this.track.cy[idx] + Math.cos(ta) * latPx,
          a: ta, v: this.track.speedProfile(this.cfg.physics)[idx] * 0.75, flying: true,
        });
        return;
      }
    }
    // start çizgisi (yarışta grid sırası korunur) veya rastgele uçan başlangıç
    this.resetCar(i, null, { s, flying });
  }

  // Tek bir araç için gözlemi hesaplar
  _obsFor(i) {
    const t = this.track;
    const sdf = t.sdf, gw = t.gw, gh = t.gh, ox = t.ox, oy = t.oy, inv = t.inv;
    const maxRay = this.cfg.sensors.maxRay / t.mpp; // px
    const px = this.x[i], py = this.y[i], a = this.ang[i];
    const ca = Math.cos(a), sa = Math.sin(a);
    const base = i * OBS_SIZE;
    const obs = this.obs;
    for (let r = 0; r < NRAY; r++) {
      const c = ca * RAY_COS[r] - sa * RAY_SIN[r];
      const s = sa * RAY_COS[r] + ca * RAY_SIN[r];
      let d = 0;
      for (let it = 0; it < 48; it++) {
        const fx = (px + c * d - ox) * inv, fy = (py + s * d - oy) * inv;
        let v = -500;
        if (fx >= 0 && fy >= 0 && fx < gw && fy < gh) v = sdf[(fy | 0) * gw + (fx | 0)];
        if (v < 1.5) break;
        d += v > 2 ? v : 2;
        if (d >= maxRay) { d = maxRay; break; }
      }
      obs[base + r] = d / maxRay;
    }
    const s = this.lastS[i];
    const idx = t.idxAt(s);
    const tn = t.tan[idx];
    obs[base + OBS.speed] = this.spd[i] / V_REF;
    obs[base + OBS.heading] = wrapAngle(tn - a) / PI;
    for (let k = 0; k < NLOOK; k++) {
      obs[base + OBS.look + k] = wrapAngle(t.tangentAt(s + LOOKAHEAD_M[k] / t.mpp) - a) / PI;
    }
    // yanal konum (işaretli)
    const lat = (px - t.cx[idx]) * -Math.sin(tn) + (py - t.cy[idx]) * Math.cos(tn);
    this.lat[i] = lat;
    obs[base + OBS.lateral] = lat / t.halfWidth;
    const nd = t.ncDist[idx];
    obs[base + OBS.cornerDist] = nd >= 400 ? 1 : nd / 400;
    const kk = t.ncK[idx] * 30;
    obs[base + OBS.cornerSharp] = kk > 1 ? 1 : kk < -1 ? -1 : kk;
    const gr = t.grade[idx] * 10;
    obs[base + OBS.grade] = gr > 1 ? 1 : gr < -1 ? -1 : gr;
    obs[base + OBS.beta] = this.beta[i] / SPIN_BETA;
    obs[base + OBS.grip] = (this._gripFactor(i) - 0.85) / 0.15;
    obs[base + OBS.drs] = this.drsOpen[i];
    obs[base + OBS.ers] = this.soc[i] / ERS.storeJ;
    obs[base + OBS.gap] = 1;
    obs[base + OBS.gapLat] = 0;
    if (this.race) this._raceObs(i, base, px, py, ca, sa, maxRay);
  }

  // yarış: ışınlar diğer araçları da görür + öndeki araç bilgisi
  _raceObs(i, base, px, py, ca, sa, maxRay) {
    const t = this.track, obs = this.obs;
    const [h0, h1] = this.heatRange(i);
    const R = 1.25 / t.mpp, R2 = R * R;
    const myP = this.progress[i] - this.goalOff[i];
    let gapBest = 150 / t.mpp, gapJ = -1;
    for (let j = h0; j < h1; j++) {
      if (j === i || this.status[j] !== RUNNING) continue;
      const dx = this.x[j] - px, dy = this.y[j] - py;
      const d2 = dx * dx + dy * dy;
      if (d2 < maxRay * maxRay) {
        for (let r = 0; r < NRAY; r++) {
          const c = ca * RAY_COS[r] - sa * RAY_SIN[r];
          const s = sa * RAY_COS[r] + ca * RAY_SIN[r];
          const proj = dx * c + dy * s;
          if (proj <= 0) continue;
          const perp2 = d2 - proj * proj;
          if (perp2 >= R2) continue;
          const hit = (proj - Math.sqrt(R2 - perp2)) / maxRay;
          if (hit < obs[base + r]) obs[base + r] = hit > 0 ? hit : 0;
        }
      }
      const dp = this.progress[j] - this.goalOff[j] - myP;
      if (dp > 0 && dp < gapBest) { gapBest = dp; gapJ = j; }
    }
    if (gapJ >= 0) {
      this.aheadGap[i] = gapBest * t.mpp;
      obs[base + OBS.gap] = (gapBest * t.mpp) / 150;
      obs[base + OBS.gapLat] = (this.lat[gapJ] - this.lat[i]) / (2 * t.halfWidth);
    } else this.aheadGap[i] = 1e4;
  }

  _gripFactor(i) {
    const C = this.cfg.car;
    const cp = COMP_TABLE[this.comp[i]];
    let f = cp.mu;
    if (C.tyreTemp) {
      const d = (this.tyreT[i] - cp.topt) / 25;
      f *= Math.max(0.85, 1 - 0.08 * d * d);
    }
    if (C.wear) {
      const w = this.wear[i];
      const c = w > 0.75 ? w - 0.75 : 0;
      f *= 1 - 0.07 * w - 1.2 * c * c;
    }
    return f;
  }

  computeObs() {
    for (let i = 0; i < this.N; i++) if (this.status[i] === RUNNING) this._obsFor(i);
  }

  // Tüm araçları bir adım ilerletir. Aksiyonlar this.actions içinde: [direksiyon, gaz] ∈ [-1,1]
  step() {
    const t = this.track, cfg = this.cfg;
    const P = cfg.physics, R = cfg.reward, rules = cfg.rules, C = cfg.car;
    const sdf = t.sdf, sg = t.sgrid, gw = t.gw, gh = t.gh, ox = t.ox, oy = t.oy, inv = t.inv;
    const L = t.length, halfL = L / 2;
    const progK = R.progress / L;
    const laps = rules.laps;
    const goal = L * laps;
    const stallLimit = Math.round(rules.stallSec * TICK_RATE);
    const tLimit = this.timeLimitTicks;
    const maxCrashes = Math.max(1, rules.maxCrashes | 0);
    const mpp = t.mpp, invMpp = 1 / mpp;
    const rad = P.carRadius * invMpp;
    const backLimit = rules.backLimit * invMpp;
    const heat = this.heat, hc = 1 / this.heatCell, hw = this.heatW;
    const acts = this.actions;
    const dt = 1 / TICK_RATE;
    const kappaMax = 1 / P.minRadius;
    const steerStep = P.steerSpeed * dt;
    const grade = t.grade, tn = t.n, tds = 1 / t.ds;
    const wf = P.weightFront ?? 0.45, wr = 1 - wf;
    const af = P.aeroFront ?? 0.42;
    const hcg = P.cgHeight ?? 0.28;
    const ls = P.loadSens ?? 0.08;
    const lsLat = (ls * (1 - ls)) / 2;
    const NrefF = wf * 2.5 * GRAVITY, NrefR = wr * 2.5 * GRAVITY;
    const xferK = hcg / WHEELBASE, latXK = (2 * hcg) / TRACKW;
    const tyreOn = !!C.tyreTemp, wearOn = !!C.wear, wearMul = C.wearMul ?? 1;
    const ersOn = !!C.ers;
    const drsMode = C.drs || 'off';
    const pitLap = C.pitLap | 0, pitCmp = compoundIndex(C.pitCompound), pitLoss = Math.round((C.pitLossSec || 0) * TICK_RATE);
    const iceW = (ersOn ? Math.max(0, P.power - ERS.kKW) : P.power) * 1000;
    const kW = ERS.kKW * 1000, hW = ERS.hKW * 1000;
    const tAmb = C.trackTemp ?? 35;
    const sf0 = t.sectorFrac[0] * L, sf1 = t.sectorFrac[1] * L;
    const zoneAt = t.drsZoneAt;

    for (let i = 0; i < this.N; i++) {
      this.done[i] = 0;
      if (this.status[i] !== RUNNING) { this.reward[i] = 0; continue; }

      // ağ çıkışları 2 kazançla doyurulur: tam gaz / tam fren kolayca ulaşılabilir olsun
      let steer = acts[2 * i] * ACTION_GAIN, thr = acts[2 * i + 1] * ACTION_GAIN;
      steer = steer > 1 ? 1 : steer < -1 ? -1 : steer;
      thr = thr > 1 ? 1 : thr < -1 ? -1 : thr;
      acts[2 * i] = steer;
      acts[2 * i + 1] = thr;

      // direksiyon servosu (anlık kilitten kilide geçemez)
      let sp = this.steerPos[i];
      const dsr = steer - sp;
      sp += dsr > steerStep ? steerStep : dsr < -steerStep ? -steerStep : dsr;
      this.steerPos[i] = sp;

      let gi = Math.floor(this.lastS[i] * tds) % tn;
      if (gi < 0) gi += tn;

      // --- DRS (bölgede, gaza basınca açılır; frende kapanır) ---
      let drs = 0;
      if (drsMode !== 'off') {
        const z = zoneAt[gi];
        if (z >= 0) {
          if (this.inZone[i] !== z) {
            this.inZone[i] = z;
            const v0 = this.spd[i] > 10 ? this.spd[i] : 10;
            this.drsElig[i] = drsMode === 'zones' ? 1 : this.aheadGap[i] / v0 < 1 ? 1 : 0;
          }
          if (thr < 0) { this.drsElig[i] = 0; this.drsOpen[i] = 0; }
          else if (this.drsElig[i] && thr > 0.3) this.drsOpen[i] = 1;
        } else {
          this.inZone[i] = -1;
          this.drsOpen[i] = 0;
        }
        drs = this.drsOpen[i];
      }

      // --- gerçekçi araç dinamiği (SI) ---
      let v = this.spd[i];
      const v2 = v * v;
      const m = P.mass + this.fuel[i];
      const kAir = (0.5 * AIR_DENSITY) / m;
      const cda = drs ? P.cda * DRS.cda : P.cda;
      const aeroTot = kAir * (drs ? P.cla * DRS.cla : P.cla) * v2;
      const aeroF = kAir * P.cla * af * v2; // DRS yalnızca arka kanadı etkiler
      const Ntot = GRAVITY + aeroTot;
      // boylamsal yük transferi (frende öne, gazda arkaya)
      let Nf = wf * GRAVITY + aeroF - this.aLongPrev[i] * xferK;
      const nMin = 0.12 * Ntot;
      if (Nf < nMin) Nf = nMin; else if (Nf > Ntot - nMin) Nf = Ntot - nMin;
      const Nr = Ntot - Nf;
      // lastik durumu
      const muE = P.mu * this._gripFactor(i);
      // yük hassasiyeti + yanal yük transferi
      const ay0 = this.aLatPrev[i];
      const xf = (latXK * wf * ay0) / Nf, xr = (latXK * wr * ay0) / Nr;
      const Gf = muE * Nf * Math.pow(Nf / NrefF, -ls) * (1 - lsLat * (xf > 1 ? 1 : xf * xf));
      const Gr = muE * Nr * Math.pow(Nr / NrefR, -ls) * (1 - lsLat * (xr > 1 ? 1 : xr * xr));
      const G = Gf + Gr;

      // boylamsal kuvvet
      let tireLong, uf, ur, deploy = 0;
      const fuelOk = this.fuel[i] > 0;
      if (thr >= 0) {
        let pw = fuelOk ? iceW * thr : 0;
        if (ersOn && thr > 0.9 && v > 8 && this.soc[i] > 0 && this.lapDep[i] < ERS.deployLapJ) {
          deploy = kW;
          pw += kW;
        }
        const a = pw / (m * (v > 3 ? v : 3));
        tireLong = a < Gr ? a : Gr; // arkadan itiş: patinaj sınırı arka aks tutuşu
        uf = 0;
        ur = tireLong / Gr;
      } else {
        // fren: dengeli dağılımın biraz önü (gerçek araçlardaki gibi önce ön kilitlenir → frende kararlı)
        const phi = Math.min(0.92, Gf / G + 0.05);
        const Bmax = Gf / phi;
        const B = -thr * Bmax;
        tireLong = -B;
        uf = (phi * B) / Gf;
        ur = ((1 - phi) * B) / Gr;
      }
      // ERS enerji muhasebesi
      if (ersOn) {
        let p = 0;
        if (deploy > 0) {
          const drain = (deploy - hW) * dt; // MGU-H doğrudan besleme bataryayı korur
          this.soc[i] -= drain;
          this.lapDep[i] += drain;
          if (this.soc[i] < 0) this.soc[i] = 0;
          p = deploy;
        } else if (thr < 0 && v > 5 && this.lapHarv[i] < ERS.harvestLapJ) {
          const brakeP = -tireLong * m * v;
          const h = brakeP < kW ? brakeP : kW;
          const add = Math.min(h * dt, ERS.storeJ - this.soc[i], ERS.harvestLapJ - this.lapHarv[i]);
          if (add > 0) { this.soc[i] += add; this.lapHarv[i] += add; p = -add / dt; }
        }
        this.ersKW[i] = p / 1000;
      }
      // yakıt
      if (fuelOk && thr > 0) {
        this.fuel[i] -= FUEL_FLOW_KGS * thr * (P.power / 750) * dt;
        if (this.fuel[i] < 0) this.fuel[i] = 0;
      }

      // yanal: her aksın sürtünme çemberinde kalan yanal kapasite
      const capF = Gf * Math.max(0.35, Math.sqrt(Math.max(0, 1 - uf * uf)));
      const capR = Gr * Math.max(0.45, Math.sqrt(Math.max(0, 1 - ur * ur)));
      const ayF = capF / wf, ayR = capR / wr;
      const kCmd = sp * kappaMax;
      const ayReq = (kCmd < 0 ? -kCmd : kCmd) * v2;
      const sgn = kCmd < 0 ? -1 : 1;
      const vv = v > 0.5 ? v : 0.5;
      let headRate = kCmd * v, pathRate = headRate, ay = ayReq, slideF = 0, slideR = 0;
      if (ayReq > ayF && ayF <= ayR) {
        // önden kayma (understeer): araç istenen kadar dönemez
        ay = ayF;
        slideF = ayReq - ayF;
        headRate = pathRate = (sgn * ayF) / vv;
      } else if (ayReq > ayR) {
        // arkadan kayma (oversteer): ön lastikler burnu çevirmeye devam eder, gidiş yönü geride kalır → β büyür
        const ayH = ayReq < ayF ? ayReq : ayF;
        ay = ayR;
        slideR = ayH - ayR;
        headRate = (sgn * ayH) / vv;
        pathRate = (sgn * ayR) / vv;
      }
      let beta = this.beta[i];
      beta += (headRate - pathRate) * dt;
      // toparlanma: arka aksta boş kapasite varsa kayma açısı söner
      const rearMargin = slideR > 0 ? 0 : 1 - (wr * ay) / (capR || 1);
      beta -= beta * (0.8 + 5 * (rearMargin > 0 ? rearMargin : 0)) * dt;
      const absB = beta < 0 ? -beta : beta;
      const slideTot = slideF + slideR;
      this.slip[i] = Math.min(1, slideTot / G + absB / SPIN_BETA);

      const aLong = tireLong - kAir * cda * v2 - P.rollRes * GRAVITY - GRAVITY * grade[gi] - slideTot * P.scrub - absB * G * 0.6;
      v += aLong * dt;
      if (v < 0) v = 0;
      this.aLongPrev[i] = aLong;
      this.aLatPrev[i] = ay;

      // lastik sıcaklığı ve aşınması
      const u2 = (tireLong * tireLong + ay * ay) / (G * G);
      const slipR = slideTot / G + absB;
      if (tyreOn) {
        let T = this.tyreT[i];
        T += (0.1175 * (u2 * v + slipR * v) - 0.0138 * (T - tAmb) * (1 + v / 30)) * dt;
        this.tyreT[i] = T > 160 ? 160 : T;
      }
      if (wearOn) {
        const cp = COMP_TABLE[this.comp[i]];
        const over = this.tyreT[i] - cp.topt - 10;
        const wk = 1e-5 * cp.wear * wearMul * (over > 0 ? 1 + over / 20 : 1);
        const w = this.wear[i] + wk * (u2 * v + slipR * v) * dt;
        this.wear[i] = w > 1 ? 1 : w;
      }

      const a = this.ang[i] + headRate * dt;
      this.beta[i] = beta;
      const dir = a - beta;
      const ox0 = this.x[i], oy0 = this.y[i];
      this.prevX[i] = ox0;
      this.prevY[i] = oy0;
      const step = v * dt * invMpp;
      const nx = ox0 + Math.cos(dir) * step, ny = oy0 + Math.sin(dir) * step;

      let r = -R.timePenalty;
      this.ticks[i]++;

      // duvar kontrolü
      const fx = (nx - ox) * inv, fy = (ny - oy) * inv;
      let d = -500, cell = -1;
      if (fx >= 0 && fy >= 0 && fx < gw && fy < gh) {
        cell = (fy | 0) * gw + (fx | 0);
        d = sdf[cell];
      }

      const spin = absB > SPIN_BETA;
      if (d < rad || spin) {
        // ÇARPMA / SPİN: ceza (hızlı çarpma daha çok cezalandırılır → yavaşlamayı öğrenmek kolaylaşır)
        r -= R.crash * (0.4 + 0.6 * Math.min(1, v / V_REF));
        this.crashes[i]++;
        if (spin) this.spins[i]++;
        this.crashEvents++;
        const hx = (nx - ox) * hc | 0, hy = (ny - oy) * hc | 0;
        const hk = hy * hw + hx;
        if (hk >= 0 && hk < heat.length) heat[hk] += 1;
        this.beta[i] = 0;
        if (this.crashes[i] >= maxCrashes) {
          if (!spin) { this.x[i] = nx; this.y[i] = ny; }
          this.ang[i] = spin ? dir : a;
          this.spd[i] = 0;
          this.status[i] = CRASHED;
          this.done[i] = 1;
          this.alive--;
        } else {
          // sek ve devam et: eski konumda dur
          this.spd[i] = 0;
          this.ang[i] = spin ? dir : a;
          this.stall[i] += 20;
        }
        this.reward[i] = r;
        this.fitness[i] += r;
        continue;
      }

      this.x[i] = nx; this.y[i] = ny; this.ang[i] = a; this.spd[i] = v;

      // ilerleme
      const s = sg[cell];
      let ds = s - this.lastS[i];
      if (ds > halfL) ds -= L;
      else if (ds < -halfL) ds += L;
      this.lastS[i] = s;
      const prog = this.progress[i] + ds;
      this.progress[i] = prog;
      r += progK * ds;

      if (prog > this.bestProg[i] + 0.5) {
        this.bestProg[i] = prog;
        this.stall[i] = 0;
      } else {
        this.stall[i]++;
      }

      // sektör ve tur sayımı
      const rel = prog - this.goalOff[i] - this.lapsDone[i] * L;
      const sn = this.secNext[i];
      const thrS = sn === 0 ? sf0 : sn === 1 ? sf1 : L;
      if (rel >= thrS) {
        const dur = this.ticks[i] - this.secT0[i];
        this.secTimes[i * 3 + sn] = dur;
        this.secT0[i] = this.ticks[i];
        if (!this.flying[i] && (!this.bestSec[sn] || dur < this.bestSec[sn])) this.bestSec[sn] = dur;
        if (sn < 2) this.secNext[i] = sn + 1;
        else {
          // tur tamamlandı
          this.secNext[i] = 0;
          const lt = this.ticks[i] - this.lapStart[i];
          if (!this.flying[i] && (!this.bestLapT[i] || lt < this.bestLapT[i])) this.bestLapT[i] = lt;
          this.lapsDone[i]++;
          this.lapDep[i] = 0;
          this.lapHarv[i] = 0;
          if (pitLap > 0 && this.lapsDone[i] === pitLap && this.lapsDone[i] < laps && !this.pitted[i]) {
            // PİT: süre kaybı + yeni lastik
            this.pitted[i] = 1;
            this.ticks[i] += pitLoss;
            this.secT0[i] += pitLoss;
            this.comp[i] = pitCmp;
            this.wear[i] = 0;
            this.tyreT[i] = C.startTemp;
            if (this.spd[i] > 22) this.spd[i] = 22;
          }
          this.lapStart[i] = this.ticks[i];
        }
      }

      if (prog >= goal + this.goalOff[i]) {
        // BİTİRDİ: büyük ödül + hız bonusu
        const sec = this.ticks[i] / TICK_RATE;
        r += R.finish + R.speedBonus * Math.max(0, rules.timeLimitSec * laps - sec);
        if (this.race) {
          const hk = (i / this.H) | 0;
          const [h0, h1] = this.heatRange(i);
          const n = h1 - h0;
          const pl = ++this.heatFinished[hk];
          this.place[i] = pl;
          if (n > 1) r += (R.position * (n - pl)) / (n - 1);
        }
        this.status[i] = FINISHED;
        this.lapTicks[i] = this.ticks[i];
        this.done[i] = 1;
        this.alive--;
        this.finished++;
      } else if (this.bestProg[i] - prog > backLimit || this.stall[i] > stallLimit) {
        r -= R.stall;
        this.status[i] = TIMEOUT;
        this.done[i] = 1;
        this.alive--;
      } else if (this.ticks[i] >= tLimit) {
        this.status[i] = TIMEOUT;
        this.done[i] = 1;
        this.alive--;
      }

      this.reward[i] = r;
      this.fitness[i] += r;
    }

    if (this.race) this._raceInteractions();

    this.tick++;
    if (this.status[0] === RUNNING && (this.tick % 3 === 0)) this.path.push(this.x[0], this.y[0]);
    this.computeObs();
  }

  // Yarış: araçlar arası temas ve sollamalar (yalnızca aynı seri içinde)
  _raceInteractions() {
    const N = this.N, H = this.H, R = this.cfg.reward, t = this.track, mpp = t.mpp;
    const maxCrashes = Math.max(1, this.cfg.rules.maxCrashes | 0);
    const st = this.status, ord = this.order;
    for (let h0 = 0; h0 < N; h0 += H) {
      const h1 = Math.min(N, h0 + H);
      for (let i = h0; i < h1; i++) {
        const si = st[i];
        if (si !== RUNNING && si !== FINISHED) continue;
        const pi = si === FINISHED ? 1e9 - this.place[i] : this.progress[i] - this.goalOff[i];
        for (let j = i + 1; j < h1; j++) {
          const sj = st[j];
          if (sj !== RUNNING && sj !== FINISHED) continue;
          const pj = sj === FINISHED ? 1e9 - this.place[j] : this.progress[j] - this.goalOff[j];
          const ki = j - h0, kj = i - h0;
          const ahead = pi > pj ? 1 : 0;
          if (this.fresh[i] || this.fresh[j]) {
            ord[i * H + ki] = ahead;
            ord[j * H + kj] = 1 - ahead;
          } else if (ord[i * H + ki] !== ahead && si === RUNNING && sj === RUNNING) {
            // sıra değişti → sollama
            const win = ahead ? i : j, lose = ahead ? j : i;
            this.reward[win] += R.overtake;
            this.fitness[win] += R.overtake;
            this.overtakes[win]++;
            this.reward[lose] -= R.overtake;
            this.fitness[lose] -= R.overtake;
            this.overtakes[lose]--;
            ord[i * H + ki] = ahead;
            ord[j * H + kj] = 1 - ahead;
          }
          // temas
          if (si !== RUNNING || sj !== RUNNING) continue;
          const dx = (this.x[j] - this.x[i]) * mpp, dy = (this.y[j] - this.y[i]) * mpp;
          if (dx * dx + dy * dy > CAR_LEN * CAR_LEN) continue;
          const ai = this.ang[i], c = Math.cos(ai), s = Math.sin(ai);
          const lx = dx * c + dy * s, ly = -dx * s + dy * c;
          const e = (lx / CAR_LEN) * (lx / CAR_LEN) + (ly / CAR_WID) * (ly / CAR_WID);
          if (e >= 1) continue;
          const back = pi < pj ? i : j, front = back === i ? j : i;
          const rel = Math.max(0, this.spd[back] - this.spd[front]);
          const pen = R.contact * (0.5 + Math.min(1.5, rel / 10));
          this.reward[back] -= pen;
          this.fitness[back] -= pen;
          this.reward[front] -= pen * 0.25;
          this.fitness[front] -= pen * 0.25;
          this.contacts[back]++;
          this.contacts[front]++;
          // arkadaki eski konumuna döner ve öndekinin hızına iner; öndeki sarsılır
          this.x[back] = this.prevX[back];
          this.y[back] = this.prevY[back];
          this.spd[back] = Math.min(this.spd[back], this.spd[front] * 0.95);
          this.spd[front] *= rel > 8 ? 0.85 : 0.98;
          // sarsıntı yönü: rastgele ama tekrarlanabilir (seri tekrarı eğitimdekinin aynısı olsun)
          let hsh = (this.tick * 73856093) ^ ((i - h0) * 19349663) ^ ((j - h0) * 83492791);
          hsh = Math.imul(hsh ^ (hsh >>> 15), 2246822519);
          hsh ^= hsh >>> 13;
          const kick = ((hsh >>> 0) / 4294967296) * 2 - 1;
          this.beta[front] += kick * Math.min(0.35, rel * 0.02);
          // yana it
          const side = ly >= 0 ? 1 : -1;
          const push = (0.25 / mpp) * side;
          this.x[j] += -s * push; this.y[j] += c * push;
          this.x[i] -= -s * push; this.y[i] -= c * push;
          if (rel > 18) {
            // ağır kaza: arkadaki araç hasar alır
            this.crashes[back]++;
            this.crashEvents++;
            if (this.crashes[back] >= maxCrashes) {
              st[back] = CRASHED;
              this.done[back] = 1;
              this.spd[back] = 0;
              this.alive--;
            } else this.spd[back] = 0;
          }
          if (st[i] !== RUNNING) break; // i bu temasla elendiyse serinin kalanıyla etkileşmesin
        }
      }
    }
    for (let i = 0; i < N; i++) this.fresh[i] = 0;
  }

  decayHeat(f) {
    const h = this.heat;
    for (let k = 0; k < h.length; k++) h[k] *= f;
    this.heatVersion++;
  }

  clearHeat() {
    this.heat.fill(0);
    this.heatVersion++;
  }

  // ışın uç noktaları (çizim için)
  rayEnds(i) {
    const out = [];
    const a = this.ang[i];
    const maxRay = this.cfg.sensors.maxRay / this.track.mpp;
    for (let r = 0; r < NRAY; r++) {
      const d = this.obs[i * OBS_SIZE + OBS.rays + r] * maxRay;
      const ra = a + (RAY_ANGLES_DEG[r] * Math.PI) / 180;
      out.push(this.x[i] + Math.cos(ra) * d, this.y[i] + Math.sin(ra) * d);
    }
    return out;
  }
}
