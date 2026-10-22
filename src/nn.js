// Küçük, bağımlılıksız çok katmanlı algılayıcı (MLP).
// Parametre düzeni (her katman için): W[çıkış][giriş] ardından b[çıkış]. Tümü tek bir Float32Array'de.
// Gizli katmanlar tanh; çıkış katmanı 'tanh' veya 'linear'.

export function paramCount(sizes) {
  let c = 0;
  for (let l = 0; l < sizes.length - 1; l++) c += sizes[l] * sizes[l + 1] + sizes[l + 1];
  return c;
}

export function initParams(p, off, sizes, rng, outScale = 1) {
  let k = off;
  const L = sizes.length - 1;
  for (let l = 0; l < L; l++) {
    const nin = sizes[l], nout = sizes[l + 1];
    const std = (l === L - 1 ? outScale : 1) / Math.sqrt(nin);
    for (let i = 0; i < nin * nout; i++) p[k++] = rng.gauss() * std;
    for (let i = 0; i < nout; i++) p[k++] = 0;
  }
}

// En büyük katman genişliği (ara bellek boyu için)
export function maxWidth(sizes) {
  return Math.max(...sizes);
}

// Hızlı ileri geçiş. Çıkışın bulunduğu ara belleği döndürür.
export function forward(p, off, sizes, input, inOff, bufA, bufB, outTanh) {
  let src = input, srcOff = inOff, k = off;
  const L = sizes.length - 1;
  for (let l = 0; l < L; l++) {
    const nin = sizes[l], nout = sizes[l + 1];
    const dst = l & 1 ? bufB : bufA;
    const last = l === L - 1;
    const bOff = k + nin * nout;
    for (let o = 0; o < nout; o++) {
      let s = p[bOff + o];
      const w = k + o * nin;
      for (let i = 0; i < nin; i++) s += p[w + i] * src[srcOff + i];
      dst[o] = !last || outTanh ? Math.tanh(s) : s;
    }
    k = bOff + nout;
    src = dst;
    srcOff = 0;
  }
  return src;
}

// Katman aktivasyonları için ara bellekler
export function makeActs(sizes) {
  return sizes.map((n) => new Float32Array(n));
}

// İleri geçiş, tüm katman aktivasyonlarını acts[] içine yazar (görselleştirme ve geri yayılım için)
export function forwardCache(p, off, sizes, input, inOff, acts, outTanh) {
  const a0 = acts[0];
  for (let i = 0; i < sizes[0]; i++) a0[i] = input[inOff + i];
  let k = off;
  const L = sizes.length - 1;
  for (let l = 0; l < L; l++) {
    const nin = sizes[l], nout = sizes[l + 1];
    const src = acts[l], dst = acts[l + 1];
    const last = l === L - 1;
    const bOff = k + nin * nout;
    for (let o = 0; o < nout; o++) {
      let s = p[bOff + o];
      const w = k + o * nin;
      for (let i = 0; i < nin; i++) s += p[w + i] * src[i];
      dst[o] = !last || outTanh ? Math.tanh(s) : s;
    }
    k = bOff + nout;
  }
  return acts[L];
}

// Geri yayılım. dOut: çıkış katmanının ön-aktivasyonuna göre kayıp türevi.
// grad dizisine EKLER. deltas: makeActs(sizes) ile oluşturulmuş geçici bellek.
export function backward(p, off, sizes, acts, dOut, grad, deltas) {
  const L = sizes.length - 1;
  // katman ofsetleri
  const offs = [];
  let k = off;
  for (let l = 0; l < L; l++) {
    offs.push(k);
    k += sizes[l] * sizes[l + 1] + sizes[l + 1];
  }
  let delta = deltas[L];
  for (let o = 0; o < sizes[L]; o++) delta[o] = dOut[o];
  for (let l = L - 1; l >= 0; l--) {
    const nin = sizes[l], nout = sizes[l + 1];
    const w0 = offs[l];
    const gOff = w0 - off;
    const ain = acts[l];
    for (let o = 0; o < nout; o++) {
      const g = delta[o];
      if (g === 0) continue;
      grad[gOff + nin * nout + o] += g;
      const wg = gOff + o * nin;
      for (let i = 0; i < nin; i++) grad[wg + i] += g * ain[i];
    }
    if (l > 0) {
      const nd = deltas[l];
      for (let i = 0; i < nin; i++) {
        let s = 0;
        for (let o = 0; o < nout; o++) s += p[w0 + o * nin + i] * delta[o];
        nd[i] = s * (1 - ain[i] * ain[i]);
      }
      delta = nd;
    }
  }
}

export class Adam {
  constructor(n, lr = 1e-3, b1 = 0.9, b2 = 0.999, eps = 1e-8) {
    this.m = new Float32Array(n);
    this.v = new Float32Array(n);
    this.t = 0;
    this.lr = lr;
    this.b1 = b1;
    this.b2 = b2;
    this.eps = eps;
  }
  // params -= lr * adam(grad)
  step(params, grad, off = 0) {
    this.t++;
    const { m, v, b1, b2, eps } = this;
    const bc1 = 1 - Math.pow(b1, this.t), bc2 = 1 - Math.pow(b2, this.t);
    const a = (this.lr * Math.sqrt(bc2)) / bc1;
    for (let i = 0; i < m.length; i++) {
      const g = grad[i];
      m[i] = b1 * m[i] + (1 - b1) * g;
      v[i] = b2 * v[i] + (1 - b2) * g * g;
      params[off + i] -= (a * m[i]) / (Math.sqrt(v[i]) + eps);
    }
  }
  toJSON() {
    return { m: Array.from(this.m), v: Array.from(this.v), t: this.t, lr: this.lr };
  }
  static from(o) {
    const a = new Adam(o.m.length, o.lr);
    a.m.set(o.m);
    a.v.set(o.v);
    a.t = o.t;
    return a;
  }
}

export function clipGrad(grad, maxNorm) {
  let s = 0;
  for (let i = 0; i < grad.length; i++) s += grad[i] * grad[i];
  const n = Math.sqrt(s);
  if (n > maxNorm && n > 0) {
    const f = maxNorm / n;
    for (let i = 0; i < grad.length; i++) grad[i] *= f;
  }
  return n;
}
