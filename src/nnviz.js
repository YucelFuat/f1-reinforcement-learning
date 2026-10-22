// Seçili aracın sinir ağını canlı çizer: bağlantılar (ağırlıklar) ve nöron aktivasyonları.

import { forwardCache, makeActs } from './nn.js';
import { OBS_SIZE, INPUT_LABELS } from './config.js';

function actColor(v, alpha = 1) {
  // ıraksak: negatif mavi ↔ gri ↔ pozitif turuncu
  const t = Math.max(-1, Math.min(1, v));
  if (t >= 0) {
    const r = Math.round(110 + 135 * t), g = Math.round(118 + (104 - 118) * t), b = Math.round(125 + (38 - 125) * t);
    return `rgba(${r},${g},${b},${alpha})`;
  }
  const u = -t;
  const r = Math.round(110 + (57 - 110) * u), g = Math.round(118 + (135 - 118) * u), b = Math.round(125 + (229 - 125) * u);
  return `rgba(${r},${g},${b},${alpha})`;
}

export class NNViz {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.acts = null;
    this.sizesKey = '';
  }

  draw(net, obs, obsOff) {
    const cv = this.canvas;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const r = cv.getBoundingClientRect();
    const Wc = Math.max(10, r.width), Hc = Math.max(10, r.height);
    if (cv.width !== Math.round(Wc * dpr) || cv.height !== Math.round(Hc * dpr)) {
      cv.width = Math.round(Wc * dpr);
      cv.height = Math.round(Hc * dpr);
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, Wc, Hc);
    if (!net) return;
    const sizes = net.sizes;
    const key = sizes.join(',');
    if (key !== this.sizesKey) {
      this.acts = makeActs(sizes);
      this.sizesKey = key;
    }
    const out = forwardCache(net.params, net.off, sizes, obs, obsOff, this.acts, net.outTanh);
    let probs = null;
    if (net.softmax) {
      let mx = -Infinity;
      for (const v of out) mx = Math.max(mx, v);
      const e = Array.from(out, (v) => Math.exp(v - mx));
      const s = e.reduce((a, b) => a + b, 0);
      probs = e.map((v) => v / s);
    }

    const L = sizes.length;
    ctx.font = '10px system-ui, sans-serif';
    const outW = Math.max(...(net.outputLabels || ['ç0']).map((l) => ctx.measureText(l + ' 100%').width));
    const padL = 74, padR = Math.min(110, outW + 16), padT = 10, padB = 10;
    const W = Wc - padL - padR, H = Hc - padT - padB;
    const colX = (l) => padL + (L === 1 ? 0 : (l / (L - 1)) * W);
    const nodeY = (l, i) => padT + ((i + 0.5) / sizes[l]) * H;

    // bağlantılar
    let k = net.off;
    for (let l = 0; l < L - 1; l++) {
      const nin = sizes[l], nout = sizes[l + 1];
      const x0 = colX(l), x1 = colX(l + 1);
      const many = nin * nout > 600;
      for (let o = 0; o < nout; o++) {
        const y1 = nodeY(l + 1, o);
        for (let i = 0; i < nin; i++) {
          const w = net.params[k + o * nin + i];
          const sig = w * this.acts[l][i];
          const mag = Math.min(1, Math.abs(w) / 1.5);
          if (many && mag < 0.25) continue;
          ctx.strokeStyle = sig >= 0 ? `rgba(235,104,52,${0.06 + 0.5 * mag})` : `rgba(57,135,229,${0.06 + 0.5 * mag})`;
          ctx.lineWidth = 0.4 + 1.6 * mag;
          ctx.beginPath();
          ctx.moveTo(x0, nodeY(l, i));
          ctx.lineTo(x1, y1);
          ctx.stroke();
        }
      }
      k += nin * nout + nout;
    }

    // nöronlar
    ctx.font = '10px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    for (let l = 0; l < L; l++) {
      const rr = Math.max(2.5, Math.min(7, (H / sizes[l]) * 0.36));
      for (let i = 0; i < sizes[l]; i++) {
        let v = this.acts[l][i];
        if (l === 0 && i < 9) v = 1 - 2 * v; // ışın: yakın duvar = pozitif
        if (l === L - 1 && probs) v = probs[i] * 2 - 0.2;
        const x = colX(l), y = nodeY(l, i);
        ctx.fillStyle = actColor(v);
        ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(x, y, rr, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        if (l === 0) {
          ctx.textAlign = 'right';
          ctx.fillStyle = '#8b949e';
          ctx.fillText(INPUT_LABELS[i] || `g${i}`, x - rr - 4, y);
        } else if (l === L - 1) {
          ctx.textAlign = 'left';
          ctx.fillStyle = '#e6edf3';
          const lab = net.outputLabels?.[i] ?? `ç${i}`;
          const val = probs ? `${(probs[i] * 100).toFixed(0)}%` : this.acts[l][i].toFixed(2);
          ctx.fillText(`${lab} ${val}`, x + rr + 4, y);
          if (probs) {
            ctx.fillStyle = 'rgba(57,135,229,0.55)';
            ctx.fillRect(x + rr + 4, y + 6, probs[i] * 50, 2);
          }
        }
      }
    }
  }
}

export { INPUT_LABELS, OBS_SIZE };
