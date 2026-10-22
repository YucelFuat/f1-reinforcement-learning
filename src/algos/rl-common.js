// Sürekli aksiyonlu gradyan algoritmaları (PPO-sürekli, SAC) için ortak yardımcılar:
//   • gözlem normalizasyonu (kayan ortalama / varyans) ve bunun ağın ilk katmanına gömülmesi
//     (tekrar ve görselleştirme ham gözlemle forward() çalıştırır → normalizasyon ağırlıklara katlanır)
//   • ağ çıkışlarını kırpma / ölçekleme (beyin dışa aktarımı için)
//   • süre limiti (kesme) tespiti

import { TIMEOUT } from '../sim.js';

export { LOG_2PI } from './mlp.js';

// Kayan ortalama/varyans (Chan paralel birleştirme). count üst sınırı sayesinde eski veriyi
// yavaşça unutur (araçlar hızlandıkça gözlem dağılımı değişir).
export class RunningNorm {
  constructor(n, { floor = 0.1, maxCount = 3e5 } = {}) {
    this.n = n;
    this.floor = floor;
    this.maxCount = maxCount;
    this.mean = new Float64Array(n);
    this.var = new Float64Array(n).fill(1);
    this.count = 0;
    this.mu = new Float32Array(n);          // hızlı normalizasyon için float32 kopyalar
    this.inv = new Float32Array(n).fill(1); // 1 / max(std, floor)
    this._bm = new Float64Array(n);
    this._bv = new Float64Array(n);
    this._refresh();
  }

  _refresh() {
    for (let k = 0; k < this.n; k++) {
      this.mu[k] = this.count > 0 ? this.mean[k] : 0;
      const sd = this.count > 0 ? Math.sqrt(this.var[k]) : 1;
      this.inv[k] = 1 / Math.max(sd, this.floor);
    }
  }

  // data[off + r*stride + k], r ∈ rows (mask[r] ≠ 0 olanlar; mask yoksa hepsi)
  update(data, off, stride, rows, mask = null) {
    const n = this.n, bm = this._bm, bv = this._bv;
    let c = 0;
    bm.fill(0);
    bv.fill(0);
    for (let r = 0; r < rows; r++) {
      if (mask && !mask[r]) continue;
      const o = off + r * stride;
      for (let k = 0; k < n; k++) bm[k] += data[o + k];
      c++;
    }
    if (!c) return;
    for (let k = 0; k < n; k++) bm[k] /= c;
    for (let r = 0; r < rows; r++) {
      if (mask && !mask[r]) continue;
      const o = off + r * stride;
      for (let k = 0; k < n; k++) {
        const d = data[o + k] - bm[k];
        bv[k] += d * d;
      }
    }
    const n0 = this.count, tot = n0 + c;
    for (let k = 0; k < n; k++) {
      const delta = bm[k] - this.mean[k];
      const m2 = this.var[k] * n0 + bv[k] + (delta * delta * n0 * c) / tot;
      this.mean[k] += (delta * c) / tot;
      this.var[k] = n0 === 0 ? bv[k] / c : m2 / tot;
    }
    this.count = Math.min(tot, this.maxCount);
    this._refresh();
  }

  // src[sOff..] → dst[dOff..] (n eleman)
  apply(src, sOff, dst, dOff) {
    const mu = this.mu, inv = this.inv;
    for (let k = 0; k < this.n; k++) dst[dOff + k] = (src[sOff + k] - mu[k]) * inv[k];
  }

  getState() {
    return { n: this.n, mean: this.mean.slice(), var: this.var.slice(), count: this.count, floor: this.floor, maxCount: this.maxCount };
  }

  setState(s) {
    if (!s || s.n !== this.n) return false;
    this.mean.set(s.mean);
    this.var.set(s.var);
    this.count = s.count;
    this._refresh();
    return true;
  }
}

// Tek değişkenli kayan varyans (PPO ödül normalizasyonu: indirimli getirinin std'si)
export class RunningScalar {
  constructor(maxCount = 1e6) {
    this.mean = 0;
    this.var = 1;
    this.count = 0;
    this.maxCount = maxCount;
  }
  update(values, n) {
    if (n <= 0) return;
    let m = 0;
    for (let i = 0; i < n; i++) m += values[i];
    m /= n;
    let v = 0;
    for (let i = 0; i < n; i++) v += (values[i] - m) * (values[i] - m);
    const n0 = this.count, tot = n0 + n, delta = m - this.mean;
    const m2 = this.var * n0 + v + (delta * delta * n0 * n) / tot;
    this.mean += (delta * n) / tot;
    this.var = n0 === 0 ? v / n : m2 / tot;
    this.count = Math.min(tot, this.maxCount);
  }
  get std() {
    return Math.sqrt(this.var) + 1e-8;
  }
  getState() {
    return { mean: this.mean, var: this.var, count: this.count };
  }
  setState(s) {
    if (!s) return false;
    this.mean = s.mean;
    this.var = s.var;
    this.count = s.count;
    return true;
  }
}

// Normalizasyonu ilk katmana göm: W'·x + b' = W·((x − μ)·inv) + b  (ham gözlemle eşdeğer ağ). Kopya döner.
export function foldNorm(params, sizes, mu, inv) {
  const out = Float32Array.from(params);
  const nin = sizes[0], nout = sizes[1];
  const bOff = nin * nout;
  for (let o = 0; o < nout; o++) {
    let shift = 0;
    for (let i = 0; i < nin; i++) {
      const w = params[o * nin + i] * inv[i];
      out[o * nin + i] = w;
      shift += w * mu[i];
    }
    out[bOff + o] = params[bOff + o] - shift;
  }
  return out;
}

// foldNorm'un tersi: ham gözlemle çalışan ağı normalize gözlemle çalışacak hâle getirir. Kopya döner.
export function unfoldNorm(params, sizes, mu, inv) {
  const out = Float32Array.from(params);
  const nin = sizes[0], nout = sizes[1];
  const bOff = nin * nout;
  for (let o = 0; o < nout; o++) {
    let shift = 0;
    for (let i = 0; i < nin; i++) {
      const wr = params[o * nin + i];
      out[o * nin + i] = wr / inv[i];
      shift += wr * mu[i];
    }
    out[bOff + o] = params[bOff + o] + shift;
  }
  return out;
}

// Son katmanın yalnızca ilk `keep` çıkışını bırak (ör. SAC: [μ1, μ2, logσ1, logσ2] → [μ1, μ2])
export function trimOutputs(params, sizes, keep) {
  const L = sizes.length - 1;
  const nin = sizes[L - 1], nout = sizes[L];
  let off = 0;
  for (let l = 0; l < L - 1; l++) off += sizes[l] * sizes[l + 1] + sizes[l + 1];
  const out = new Float32Array(off + nin * keep + keep);
  out.set(params.subarray(0, off), 0);
  out.set(params.subarray(off, off + nin * keep), off);
  out.set(params.subarray(off + nin * nout, off + nin * nout + keep), off + nin * keep);
  return { params: out, sizes: [...sizes.slice(0, L), keep] };
}

// Son katmanın ağırlık ve biaslarını f ile çarp (yerinde)
export function scaleOutputs(params, sizes, f, rows = null) {
  const L = sizes.length - 1;
  const nin = sizes[L - 1], nout = sizes[L];
  let off = 0;
  for (let l = 0; l < L - 1; l++) off += sizes[l] * sizes[l + 1] + sizes[l + 1];
  const nr = rows ?? nout;
  for (let o = 0; o < nr; o++) {
    for (let i = 0; i < nin; i++) params[off + o * nin + i] *= f;
    params[off + nin * nout + o] *= f;
  }
  return params;
}

// Bölüm süre limiti yüzünden mi bitti? (gerçek bir son değil → değer önyüklemesi yapılmalı)
export function isTruncated(sim, i) {
  return sim.status[i] === TIMEOUT && sim.ticks[i] >= sim.timeLimitTicks;
}

export function sameSizes(a, b) {
  return !!a && !!b && a.length === b.length && a.every((v, k) => v === b[k]);
}
