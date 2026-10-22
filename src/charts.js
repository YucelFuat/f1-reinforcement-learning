// Hafif çizgi grafik (tek eksen) + üzerine gelince ipucu (crosshair + tooltip).

export class LineChart {
  constructor(canvas, { series, yFormat = (v) => v.toFixed(0), xLabel = 'Nesil', minY = null, maxY = null }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.series = series; // [{key, label, color, get?}]
    this.yFormat = yFormat;
    this.xLabel = xLabel;
    this.minY = minY;
    this.maxY = maxY;
    this.hoverX = null;
    this.data = [];
    canvas.addEventListener('mousemove', (e) => {
      const r = canvas.getBoundingClientRect();
      this.hoverX = e.clientX - r.left;
      this.draw(this.data);
    });
    canvas.addEventListener('mouseleave', () => {
      this.hoverX = null;
      this.draw(this.data);
    });
  }

  draw(history) {
    this.data = history;
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
    const padL = 44, padR = 8, padT = 8, padB = 18;
    const W = Wc - padL - padR, H = Hc - padT - padB;

    const pts = this.series.map((s) => history.map((h) => (s.get ? s.get(h) : h[s.key])));
    let lo = Infinity, hi = -Infinity;
    for (const arr of pts) for (const v of arr) if (v != null && isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    if (!isFinite(lo)) { lo = 0; hi = 1; }
    if (this.minY != null) lo = Math.min(lo, this.minY);
    if (this.maxY != null) hi = Math.max(hi, this.maxY);
    if (hi - lo < 1e-6) { hi += 1; lo -= 1; }
    const pad = (hi - lo) * 0.06;
    if (this.minY == null) lo -= pad;
    hi += pad;

    const n = history.length;
    const X = (i) => padL + (n <= 1 ? W / 2 : (i / (n - 1)) * W);
    const Y = (v) => padT + H - ((v - lo) / (hi - lo)) * H;

    const n0 = history.length;
    if (n0 === 0) {
      ctx.font = '11px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#6e7681';
      ctx.fillText('İlk nesil bekleniyor…', Wc / 2, Hc / 2);
      return;
    }
    // ızgara + eksen etiketleri
    ctx.font = '10px ui-monospace, Consolas, monospace';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    for (let k = 0; k <= 3; k++) {
      const v = lo + ((hi - lo) * k) / 3;
      const y = Y(v);
      ctx.strokeStyle = 'rgba(255,255,255,0.06)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padL, Math.round(y) + 0.5);
      ctx.lineTo(padL + W, Math.round(y) + 0.5);
      ctx.stroke();
      ctx.fillStyle = '#8b949e';
      ctx.fillText(this.yFormat(v), padL - 5, y);
    }
    if (n > 0) {
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(String(history[0].gen), padL, Hc - 4);
      ctx.textAlign = 'right';
      ctx.fillText(String(history[n - 1].gen), padL + W, Hc - 4);
    }
    if (n === 0) {
      ctx.textAlign = 'center';
      ctx.fillStyle = '#6e7681';
      ctx.fillText('Veri bekleniyor…', padL + W / 2, padT + H / 2);
      return;
    }

    // çok fazla nokta varsa kovalara indir (ekran pikseli başına ~1 nokta)
    const step = Math.max(1, Math.floor(n / W));
    this.series.forEach((s, si) => {
      const arr = pts[si];
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < n; i += step) {
        let v = arr[i];
        if (step > 1) {
          let sum = 0, c = 0;
          for (let j = i; j < Math.min(n, i + step); j++) if (arr[j] != null) { sum += arr[j]; c++; }
          v = c ? sum / c : null;
        }
        if (v == null || !isFinite(v)) { started = false; continue; }
        if (!started) { ctx.moveTo(X(i), Y(v)); started = true; }
        else ctx.lineTo(X(i), Y(v));
      }
      ctx.stroke();
      if (n === 1 && arr[0] != null) {
        ctx.fillStyle = s.color;
        ctx.beginPath();
        ctx.arc(X(0), Y(arr[0]), 4, 0, Math.PI * 2);
        ctx.fill();
      }
    });

    // hover
    if (this.hoverX != null && this.hoverX >= padL && this.hoverX <= padL + W) {
      const i = Math.max(0, Math.min(n - 1, Math.round(((this.hoverX - padL) / W) * (n - 1))));
      const x = X(i);
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, padT);
      ctx.lineTo(Math.round(x) + 0.5, padT + H);
      ctx.stroke();
      const lines = [`${this.xLabel} ${history[i].gen}`];
      this.series.forEach((s, si) => {
        const v = pts[si][i];
        if (v != null && isFinite(v)) {
          ctx.fillStyle = s.color;
          ctx.strokeStyle = '#161b22';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(x, Y(v), 4, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
        lines.push(`${s.label}: ${v == null || !isFinite(v) ? '–' : this.yFormat(v)}`);
      });
      ctx.font = '11px system-ui, sans-serif';
      const tw = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 14;
      const th = lines.length * 15 + 8;
      let tx = x + 10;
      if (tx + tw > Wc) tx = x - tw - 10;
      const ty = padT + 2;
      ctx.fillStyle = 'rgba(13,17,23,0.94)';
      ctx.strokeStyle = 'rgba(255,255,255,0.15)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(tx, ty, tw, th, 6);
      ctx.fill();
      ctx.stroke();
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      lines.forEach((l, k) => {
        ctx.fillStyle = k === 0 ? '#8b949e' : '#e6edf3';
        ctx.fillText(l, tx + 7, ty + 5 + k * 15);
      });
    }
  }
}
