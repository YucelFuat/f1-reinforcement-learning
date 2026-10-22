// Toplu (mini-batch) çok katmanlı algılayıcı.
// Parametre düzeni nn.js ile AYNIDIR (her katman: W[çıkış][giriş] ardından b[çıkış]); gizli katmanlar tanh,
// çıkış katmanı doğrusal. Böylece burada eğitilen ağlar nn.js'deki forward() ile (tekrar, görselleştirme)
// birebir aynı sonucu verir. Gradyan tabanlı öğreniciler (PPO-sürekli, SAC) için hızlı ileri/geri geçiş sağlar.

import { paramCount } from '../nn.js';

export const LOG_2PI = Math.log(2 * Math.PI);

export class BatchMLP {
  constructor(sizes, maxB) {
    this.sizes = sizes.slice();
    this.L = sizes.length - 1;
    this.P = paramCount(sizes);
    this.offs = [];
    let k = 0;
    for (let l = 0; l < this.L; l++) {
      this.offs.push(k);
      k += sizes[l] * sizes[l + 1] + sizes[l + 1];
    }
    this.maxB = maxB;
    this.acts = sizes.map((n) => new Float32Array(maxB * n));   // acts[0] = girdi (çağıran doldurur)
    this.deltas = sizes.map((n) => new Float32Array(maxB * n)); // deltas[L] = çıkış türevi (çağıran doldurur)
  }

  get input() { return this.acts[0]; }
  get output() { return this.acts[this.L]; }
  get dOut() { return this.deltas[this.L]; }
  get dIn() { return this.deltas[0]; }

  // acts[0]'daki B satırlık girdi için ileri geçiş. Çıkış (B × sizes[L]) döner.
  forward(p, B, off = 0) {
    const { sizes, L, acts, offs } = this;
    for (let l = 0; l < L; l++) {
      const nin = sizes[l], nout = sizes[l + 1];
      const w0 = off + offs[l];
      fwdLayer(p, w0, w0 + nin * nout, acts[l], acts[l + 1], B, nin, nout, l < L - 1);
    }
    return acts[L];
  }

  // Geri yayılım. deltas[L] (çıkışa göre kayıp türevi) çağıran tarafından doldurulmuş olmalı.
  // grad: parametre gradyanının EKLENECEĞİ dizi (ağın kendi düzeninde, ofset 0); null → parametre gradyanı yok.
  // needIn: true → girdiye göre türev deltas[0]'a yazılır (SAC: Q ağından aksiyona gradyan).
  backward(p, B, grad, needIn = false, off = 0) {
    const { sizes, L, acts, deltas, offs } = this;
    for (let l = L - 1; l >= 0; l--) {
      const nin = sizes[l], nout = sizes[l + 1];
      if (grad) gradLayer(grad, offs[l], acts[l], deltas[l + 1], B, nin, nout);
      if (l > 0 || needIn) dprevLayer(p, off + offs[l], acts[l], deltas[l + 1], deltas[l], B, nin, nout, l > 0);
    }
  }
}

// ---- çekirdekler (kayıt bloklama: aynı yüklenen değer birden çok çarpımda kullanılır → ~3-4 kat hızlı) ----

// y = act(W·x + b): 4 çıkış × 2 örnek bloklar
function fwdLayer(p, w0, b0, x, y, B, nin, nout, tanh) {
  const o4 = nout & ~3;
  let b = 0;
  for (; b + 1 < B; b += 2) {
    const xo = b * nin, xo2 = xo + nin, yo = b * nout, yo2 = yo + nout;
    let o = 0;
    for (; o < o4; o += 4) {
      let s0 = p[b0 + o], s1 = p[b0 + o + 1], s2 = p[b0 + o + 2], s3 = p[b0 + o + 3];
      let t0 = s0, t1 = s1, t2 = s2, t3 = s3;
      const wa = w0 + o * nin, wb = wa + nin, wc = wb + nin, wd = wc + nin;
      for (let i = 0; i < nin; i++) {
        const xi = x[xo + i], zi = x[xo2 + i];
        const pa = p[wa + i], pb = p[wb + i], pc = p[wc + i], pd = p[wd + i];
        s0 += pa * xi; s1 += pb * xi; s2 += pc * xi; s3 += pd * xi;
        t0 += pa * zi; t1 += pb * zi; t2 += pc * zi; t3 += pd * zi;
      }
      if (tanh) {
        y[yo + o] = Math.tanh(s0); y[yo + o + 1] = Math.tanh(s1); y[yo + o + 2] = Math.tanh(s2); y[yo + o + 3] = Math.tanh(s3);
        y[yo2 + o] = Math.tanh(t0); y[yo2 + o + 1] = Math.tanh(t1); y[yo2 + o + 2] = Math.tanh(t2); y[yo2 + o + 3] = Math.tanh(t3);
      } else {
        y[yo + o] = s0; y[yo + o + 1] = s1; y[yo + o + 2] = s2; y[yo + o + 3] = s3;
        y[yo2 + o] = t0; y[yo2 + o + 1] = t1; y[yo2 + o + 2] = t2; y[yo2 + o + 3] = t3;
      }
    }
    for (; o < nout; o++) {
      let s = p[b0 + o], t = s;
      const w = w0 + o * nin;
      for (let i = 0; i < nin; i++) { const pw = p[w + i]; s += pw * x[xo + i]; t += pw * x[xo2 + i]; }
      y[yo + o] = tanh ? Math.tanh(s) : s;
      y[yo2 + o] = tanh ? Math.tanh(t) : t;
    }
  }
  for (; b < B; b++) {
    const xo = b * nin, yo = b * nout;
    for (let o = 0; o < nout; o++) {
      let s = p[b0 + o];
      const w = w0 + o * nin;
      for (let i = 0; i < nin; i++) s += p[w + i] * x[xo + i];
      y[yo + o] = tanh ? Math.tanh(s) : s;
    }
  }
}

// grad[W] += δ·xᵀ, grad[b] += δ : 4 örnek bloklar (her gradyan elemanı 4 örnekte bir okunup yazılır)
function gradLayer(grad, g0, x, d, B, nin, nout) {
  const gb = g0 + nin * nout;
  let b = 0;
  for (; b + 3 < B; b += 4) {
    const xa = b * nin, xb = xa + nin, xc = xb + nin, xd = xc + nin;
    const da0 = b * nout, db0 = da0 + nout, dc0 = db0 + nout, dd0 = dc0 + nout;
    for (let o = 0; o < nout; o++) {
      const ga = d[da0 + o], gbb = d[db0 + o], gc = d[dc0 + o], gd = d[dd0 + o];
      if (ga === 0 && gbb === 0 && gc === 0 && gd === 0) continue;
      grad[gb + o] += ga + gbb + gc + gd;
      const w = g0 + o * nin;
      for (let i = 0; i < nin; i++) grad[w + i] += ga * x[xa + i] + gbb * x[xb + i] + gc * x[xc + i] + gd * x[xd + i];
    }
  }
  for (; b < B; b++) {
    const xo = b * nin, dO = b * nout;
    for (let o = 0; o < nout; o++) {
      const g = d[dO + o];
      if (g === 0) continue;
      grad[gb + o] += g;
      const w = g0 + o * nin;
      for (let i = 0; i < nin; i++) grad[w + i] += g * x[xo + i];
    }
  }
}

// dp = Wᵀ·δ (gizli katmanda × (1 − a²)): 4 çıkış bloklar
function dprevLayer(p, w0, x, d, dp, B, nin, nout, act) {
  const o4 = nout & ~3;
  for (let b = 0; b < B; b++) {
    const xo = b * nin, dO = b * nout;
    for (let i = 0; i < nin; i++) dp[xo + i] = 0;
    let o = 0;
    for (; o < o4; o += 4) {
      const ga = d[dO + o], gb = d[dO + o + 1], gc = d[dO + o + 2], gd = d[dO + o + 3];
      if (ga === 0 && gb === 0 && gc === 0 && gd === 0) continue;
      const wa = w0 + o * nin, wb = wa + nin, wc = wb + nin, wd = wc + nin;
      for (let i = 0; i < nin; i++) dp[xo + i] += ga * p[wa + i] + gb * p[wb + i] + gc * p[wc + i] + gd * p[wd + i];
    }
    for (; o < nout; o++) {
      const g = d[dO + o];
      if (g === 0) continue;
      const w = w0 + o * nin;
      for (let i = 0; i < nin; i++) dp[xo + i] += g * p[w + i];
    }
    if (act) {
      for (let i = 0; i < nin; i++) {
        const a = x[xo + i];
        dp[xo + i] *= 1 - a * a;
      }
    }
  }
}

// Adam iyileyicisinin durumunu kopyala / geri yükle (nn.js Adam nesnesi için)
export function adamState(a) {
  return { m: a.m.slice(), v: a.v.slice(), t: a.t };
}

export function adamLoad(a, s) {
  if (!s || s.m.length !== a.m.length) return false;
  a.m.set(s.m);
  a.v.set(s.v);
  a.t = s.t;
  return true;
}

// Gradyan normunu sınırla (dizinin yalnızca [0, n) kısmı)
export function clipNorm(g, maxNorm, n = g.length) {
  let s = 0;
  for (let i = 0; i < n; i++) s += g[i] * g[i];
  const norm = Math.sqrt(s);
  if (maxNorm > 0 && norm > maxNorm) {
    const f = maxNorm / norm;
    for (let i = 0; i < n; i++) g[i] *= f;
  }
  return norm;
}
