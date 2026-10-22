// Otomatik ayar (AutoML): eğitimi izler, uzun süre gelişme olmazsa algoritma ve ödül/ceza
// değerlerinden birini değiştirip bir süre dener; sonuç daha iyiyse kalıcı yapar, değilse geri alır.
//
// Karşılaştırma ödülden BAĞIMSIZ bir skorla yapılır (ödül ağırlıkları değişince fitness ölçeği de değişir):
//   skor = en iyi %10'un ortalama ilerlemesi (0-1)  +  0.5 × bitirme oranı  +  tur süresi skoru (0-1)
// Bir "blok" GA/ES'de bir nesil, PPO'da yeterli sayıda bitmiş bölümdür.

const KNOBS = {
  ga: [
    { key: 'ga.mutStd', label: 'Mutasyon gücü', min: 0.02, max: 0.6, log: true, f: 1.6 },
    { key: 'ga.mutRate', label: 'Mutasyon oranı', min: 0.02, max: 0.4, log: true, f: 1.6 },
    { key: 'ga.eliteFrac', label: 'Elit oranı', min: 0.01, max: 0.25, log: true, f: 1.7 },
    { key: 'ga.selectFrac', label: 'Ebeveyn havuzu', min: 0.05, max: 0.6, log: true, f: 1.5 },
    { key: 'ga.crossover', label: 'Çaprazlama', min: 0, max: 1, log: false, step: 0.25 },
  ],
  es: [
    { key: 'es.sigma', label: 'Gürültü (σ)', min: 0.02, max: 0.4, log: true, f: 1.5 },
    { key: 'es.lr', label: 'Öğrenme hızı', min: 0.003, max: 0.2, log: true, f: 1.7 },
  ],
  ppo: [
    { key: 'ppo.lr', label: 'Öğrenme hızı', min: 0.00005, max: 0.003, log: true, f: 1.8 },
    { key: 'ppo.entropy', label: 'Entropi (keşif)', min: 0.0005, max: 0.05, log: true, f: 2 },
    { key: 'ppo.clip', label: 'PPO kırpma', min: 0.05, max: 0.4, log: true, f: 1.5 },
  ],
  cmaes: [
    { key: 'cmaes.muFrac', label: 'Seçilen oran (μ/λ)', min: 0.1, max: 0.5, log: false, step: 0.1 },
  ],
  ppoc: [
    { key: 'ppoc.lr', label: 'Öğrenme hızı', min: 0.00005, max: 0.003, log: true, f: 1.8 },
    { key: 'ppoc.clip', label: 'PPO kırpma', min: 0.05, max: 0.4, log: true, f: 1.5 },
  ],
  sac: [
    { key: 'sac.lr', label: 'Öğrenme hızı', min: 0.00005, max: 0.003, log: true, f: 1.8 },
    { key: 'sac.targetEntropy', label: 'Hedef entropi', min: -6, max: 1, log: false, step: 1 },
  ],
  reward: [
    { key: 'reward.crash', label: 'Çarpma cezası', min: 5, max: 400, log: true, f: 1.8 },
    { key: 'reward.stall', label: 'Takılma cezası', min: 5, max: 400, log: true, f: 1.8 },
    { key: 'reward.timePenalty', label: 'Zaman cezası', min: 0.002, max: 0.5, log: true, f: 2 },
    { key: 'reward.speedBonus', label: 'Hız bonusu', min: 1, max: 100, log: true, f: 1.8 },
    { key: 'reward.finish', label: 'Bitirme ödülü', min: 50, max: 4000, log: true, f: 1.8 },
    { key: 'reward.progress', label: 'İlerleme ödülü', min: 200, max: 5000, log: true, f: 1.6 },
  ],
};

function getPath(cfg, key) {
  const [a, b] = key.split('.');
  return cfg[a][b];
}
function setPath(cfg, key, v) {
  const [a, b] = key.split('.');
  cfg[a][b] = v;
}
function round(v) {
  if (v === 0) return 0;
  const d = Math.max(0, 3 - Math.floor(Math.log10(Math.abs(v))));
  return +v.toFixed(Math.min(6, d));
}

// Bir grup bölümden (ilerleme oranları + bitirme süreleri) ödülden bağımsız skor
export function blockScore(progress, lapTicks, limitTicks) {
  const n = progress.length;
  if (!n) return 0;
  const sorted = Array.from(progress).sort((a, b) => b - a);
  const k = Math.max(1, Math.round(n * 0.1));
  let top = 0;
  for (let i = 0; i < k; i++) top += Math.min(1, sorted[i]);
  top /= k;
  const fin = lapTicks.length;
  const best = fin ? Math.min(...lapTicks) : 0;
  const lapScore = best ? Math.max(0, 1 - best / limitTicks) : 0;
  return top + 0.5 * (fin / n) + lapScore;
}

export class AutoTuner {
  constructor(cfg) {
    this.cfg = cfg;
    this.enabled = true;
    this.onChange = null; // (knob, oldV, newV) → arayüzü güncelle
    this.reset();
  }

  reset() {
    this.scores = []; // blok skorları
    this.bestAvg = -Infinity;
    this.sinceBest = 0;
    this.state = 'observe'; // observe | trial | settle
    this.trial = null;
    this.settle = 0;
    this.log = [];
    this.accepted = 0;
    this.rejected = 0;
    this.stats = {}; // knob → {ok, fail, lastDir, tabu}
    this.ppoMark = null;
  }

  // ayarlar (algoritmaya göre)
  knobs(algo) {
    return [...(KNOBS[algo] || []), ...KNOBS.reward];
  }

  get params() {
    // pencere boyları (blok)
    return { stagnation: 10, baseline: 5, trial: 6, settle: 2 };
  }

  status() {
    if (!this.enabled) return 'Kapalı';
    if (this.state === 'trial') {
      const t = this.trial;
      return `Deneniyor: ${t.knob.label} ${t.dir > 0 ? '↑' : '↓'} (${t.scores.length}/${this.params.trial} blok)`;
    }
    if (this.state === 'settle') return 'Değişiklik oturuyor…';
    const p = this.params;
    return this.sinceBest >= p.stagnation - 3
      ? `Gözlem: ${this.sinceBest}/${p.stagnation} blok gelişme yok`
      : `Gözlem: gelişme sürüyor (${this.sinceBest}/${p.stagnation})`;
  }

  _push(msg, kind = 'info') {
    this.log.unshift({ msg, kind, t: Date.now() });
    if (this.log.length > 40) this.log.pop();
  }

  // Popülasyon algoritmaları: her nesil sonunda çağrılır
  onGeneration(trainer, entry) {
    if (!this.enabled) return;
    if (trainer.isPopulation) {
      this._block(trainer, entry.q);
    } else {
      // PPO: yeterince bölüm bitince bir blok kapanır
      if (this.ppoMark == null) this.ppoMark = trainer.episodes;
      const need = Math.min(200, Math.max(40, trainer.sim.N));
      const done = trainer.episodes - this.ppoMark;
      if (done < need) return;
      const eps = trainer.epWindow.slice(-Math.min(done, trainer.epWindow.length));
      this.ppoMark = trainer.episodes;
      const limit = trainer.sim.timeLimitTicks;
      const q = blockScore(eps.map((e) => e.prog), eps.filter((e) => e.fin).map((e) => e.lap), limit);
      this._block(trainer, q);
    }
  }

  _block(trainer, q) {
    const p = this.params;
    this.scores.push(q);
    if (this.scores.length > 400) this.scores.shift();
    const avg3 = this._mean(this.scores.slice(-3));

    if (this.state === 'settle') {
      if (--this.settle <= 0) this.state = 'observe';
      return;
    }

    if (this.state === 'trial') {
      const t = this.trial;
      t.scores.push(q);
      if (t.scores.length >= p.trial) this._decide(trainer);
      return;
    }

    // gözlem
    const thr = this.bestAvg + Math.max(0.005, Math.abs(this.bestAvg) * 0.01);
    if (avg3 > thr || !isFinite(this.bestAvg)) {
      this.bestAvg = Math.max(this.bestAvg, avg3);
      this.sinceBest = 0;
    } else {
      this.sinceBest++;
    }
    if (this.sinceBest >= p.stagnation && this.scores.length >= p.baseline) this._startTrial(trainer);
  }

  _mean(a) {
    return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
  }

  _pickKnob(algo) {
    const ks = this.knobs(algo);
    // başarı geçmişine göre ağırlıklı seçim, son başarısız denemeler tabu
    const weights = ks.map((k) => {
      const s = this.stats[k.key] || { ok: 0, fail: 0, tabu: 0 };
      if (s.tabu > 0) return 0.05;
      return Math.max(0.2, 1 + s.ok * 0.8 - s.fail * 0.25);
    });
    let r = Math.random() * weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < ks.length; i++) {
      r -= weights[i];
      if (r <= 0) return ks[i];
    }
    return ks[ks.length - 1];
  }

  _startTrial(trainer) {
    const algo = trainer.algo.name;
    const knob = this._pickKnob(algo);
    const s = (this.stats[knob.key] ||= { ok: 0, fail: 0, lastDir: 0, tabu: 0, failDirs: {} });
    for (const k in this.stats) if (this.stats[k].tabu > 0) this.stats[k].tabu--;
    const old = getPath(this.cfg, knob.key);
    // yön: son başarılı yön, yoksa daha önce başarısız olmayan yön, yoksa rastgele
    let dir = s.lastDir || (Math.random() < 0.5 ? 1 : -1);
    if (s.failDirs[dir] && !s.failDirs[-dir]) dir = -dir;
    // uzun durgunlukta daha cesur adımlar
    const bold = 1 + Math.min(1, this.rejected / 12);
    let nv;
    if (knob.log) nv = old * Math.pow(knob.f, dir * bold);
    else nv = old + dir * knob.step * bold;
    nv = round(Math.max(knob.min, Math.min(knob.max, nv)));
    if (nv === old) {
      dir = -dir;
      nv = knob.log ? old * Math.pow(knob.f, dir) : old + dir * knob.step;
      nv = round(Math.max(knob.min, Math.min(knob.max, nv)));
    }
    if (nv === old) {
      s.tabu = 3;
      return;
    }
    // taban: son blokların ortalaması; geri alma sonrası düşük kalmış olabilir → en iyi seviyenin %98'inden az olmasın
    const recent = this._mean(this.scores.slice(-this.params.baseline));
    const baseline = isFinite(this.bestAvg) ? Math.max(recent, this.bestAvg * 0.98) : recent;
    this.trial = { knob, dir, old, nv, baseline, scores: [] };
    this._apply(trainer, knob, nv);
    this.state = 'trial';
    this._push(`Deneme: ${knob.label} ${fmt(old)} → ${fmt(nv)} (taban skor ${baseline.toFixed(3)})`, 'try');
    if (this.onChange) this.onChange(knob, old, nv);
  }

  _decide(trainer) {
    const t = this.trial;
    const s = this.stats[t.knob.key];
    // ilk blok geçiş etkisi; değerlendirmeye son bloklar ve en iyi blok birlikte girer
    const tail = t.scores.slice(1);
    const score = 0.7 * this._mean(tail) + 0.3 * Math.max(...tail);
    const need = t.baseline + Math.max(0.01, Math.abs(t.baseline) * 0.02);
    if (score > need) {
      this.accepted++;
      s.ok++;
      s.lastDir = t.dir;
      s.failDirs = {};
      this.bestAvg = Math.max(this.bestAvg, this._mean(tail));
      this.sinceBest = 0;
      this._push(`✓ Kabul: ${t.knob.label} = ${fmt(t.nv)} (skor ${t.baseline.toFixed(3)} → ${score.toFixed(3)})`, 'ok');
      this.state = 'settle';
      this.settle = this.params.settle;
    } else {
      this.rejected++;
      s.fail++;
      s.failDirs[t.dir] = true;
      if (s.failDirs[1] && s.failDirs[-1]) {
        s.tabu = 4;
        s.failDirs = {};
      }
      s.lastDir = 0;
      this._apply(trainer, t.knob, t.old);
      this._push(`✗ Geri alındı: ${t.knob.label} ${fmt(t.nv)} → ${fmt(t.old)} (skor ${score.toFixed(3)} ≤ ${need.toFixed(3)})`, 'fail');
      if (this.onChange) this.onChange(t.knob, t.nv, t.old);
      // hâlâ durgun: kısa bir oturma süresinden sonra yeni deneme
      this.sinceBest = this.params.stagnation;
      this.state = 'settle';
      this.settle = 3;
    }
    this.trial = null;
  }

  _apply(trainer, knob, v) {
    setPath(this.cfg, knob.key, v);
    // GA'nın kendi uyarlamalı mutasyonu da yeni değerden başlasın
    if (knob.key === 'ga.mutStd' && trainer.algo.name === 'ga') trainer.algo.mutStd = v;
  }
}

function fmt(v) {
  if (Math.abs(v) >= 100) return v.toFixed(0);
  if (Math.abs(v) >= 1) return (+v.toFixed(2)).toString();
  return (+v.toPrecision(2)).toString();
}
