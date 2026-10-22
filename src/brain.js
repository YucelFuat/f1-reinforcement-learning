// Beyin (sinir ağı) kayıtlarının sürüm uyumluluğu.
// Eski sürümlerde gözlem 15 girdiydi; yeni girdiler sona eklendiği için ilk katmana sıfır ağırlık eklenerek
// eski beyinler aynı davranışla çalışmaya devam eder.

import { OBS_SIZE } from './config.js';

function padFirstLayer(params, sizes, newIn) {
  const oldIn = sizes[0], out = sizes[1];
  if (oldIn === newIn) return params;
  const extra = newIn - oldIn;
  const res = new Float32Array(params.length + extra * out);
  let k = 0, r = 0;
  for (let o = 0; o < out; o++) {
    for (let i = 0; i < oldIn; i++) res[r++] = params[k++];
    r += extra; // yeni girdiler: 0 ağırlık
  }
  // kalan her şey (ilk katman biası + diğer katmanlar) aynen
  while (k < params.length) res[r++] = params[k++];
  return res;
}

// Gerekirse beyni güncel gözlem boyutuna yükseltir (yerinde değil, kopya döner)
export function upgradeBrain(brain) {
  if (!brain || !brain.sizes) return brain;
  const b = { ...brain };
  if (b.sizes[0] < OBS_SIZE) {
    b.params = padFirstLayer(Float32Array.from(b.params), b.sizes, OBS_SIZE);
    b.sizes = [OBS_SIZE, ...b.sizes.slice(1)];
    b.upgradedFrom = brain.sizes[0];
  }
  if (b.vparams && b.sizesV && b.sizesV[0] < OBS_SIZE) {
    b.vparams = padFirstLayer(Float32Array.from(b.vparams), b.sizesV, OBS_SIZE);
    b.sizesV = [OBS_SIZE, ...b.sizesV.slice(1)];
  }
  if (b.qparams && b.sizesQ && b.sizesQ[0] < OBS_SIZE + 2) {
    // SAC Q ağı: girdi = gözlem + aksiyon (2). Aksiyon girdileri gözlemden sonra gelir → ortadan genişlet
    const oldIn = b.sizesQ[0], out = b.sizesQ[1], extra = OBS_SIZE + 2 - oldIn;
    const p = Float32Array.from(b.qparams), res = new Float32Array(p.length + extra * out);
    let k = 0, r = 0;
    for (let o = 0; o < out; o++) {
      for (let i = 0; i < oldIn - 2; i++) res[r++] = p[k++];
      r += extra;
      res[r++] = p[k++];
      res[r++] = p[k++];
    }
    while (k < p.length) res[r++] = p[k++];
    b.qparams = res;
    b.sizesQ = [OBS_SIZE + 2, ...b.sizesQ.slice(1)];
  }
  return b;
}
