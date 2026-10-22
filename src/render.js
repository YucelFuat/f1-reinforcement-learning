// Canvas 2D çizici: pist (önceden çizilmiş), araçlar, sensörler, ısı haritası, hayalet iz.
// 2D üstten görünüm ve izometrik (2.5D) görünüm aynı dönüşüm matrisiyle yapılır.

import { RUNNING, FINISHED, CRASHED } from './sim.js';

const TS_MAX = 1.5; // pist ön-çizim çözünürlük çarpanı (büyük pistlerde bellek için düşürülür)
const ISO_ANGLE = Math.PI / 4;
const ISO_KY = 0.56;

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.cam = { x: 0, y: 0, zoom: 0.5 };
    this.iso = false;
    this.trackCanvas = null;
    this.heatCanvas = null;
    this.heatStamp = -1;
    this.heatFrame = 0;
    this.M = [1, 0, 0, 1, 0, 0];
    this.editPoints = null;
    this.resize();
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(r.width * this.dpr));
    const h = Math.max(1, Math.round(r.height * this.dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.cssW = r.width;
    this.cssH = r.height;
  }

  setTrack(track) {
    this.track = track;
    this._prerenderTrack();
    this._buildEdges();
    this.heatCanvas = null;
    this.heatStamp = -1;
    this.fit();
  }

  fit() {
    const b = this.track.bounds;
    this.cam.x = b.minX + b.w / 2;
    this.cam.y = b.minY + b.h / 2;
    // pistin (izometrik dahil) ekrandaki kapsamını bul
    let ex = b.w, ey = b.h;
    if (this.iso) {
      const cs = Math.cos(ISO_ANGLE), sn = Math.sin(ISO_ANGLE);
      const xs = [], ys = [];
      for (const [x, y] of [[b.minX, b.minY], [b.maxX, b.minY], [b.minX, b.maxY], [b.maxX, b.maxY]]) {
        xs.push(cs * x - sn * y);
        ys.push(ISO_KY * (sn * x + cs * y));
      }
      ex = Math.max(...xs) - Math.min(...xs);
      ey = Math.max(...ys) - Math.min(...ys);
    }
    this.cam.zoom = Math.min(this.cssW / ex, this.cssH / ey) * (this.iso ? 1.08 : 0.98);
  }

  setIso(on) {
    this.iso = on;
    this.fit();
  }

  // dünya → ekran matrisi (cihaz pikseli)
  _matrix() {
    const z = this.cam.zoom * this.dpr;
    let a, b, c, d;
    if (this.iso) {
      const cs = Math.cos(ISO_ANGLE), sn = Math.sin(ISO_ANGLE);
      a = z * cs; c = -z * sn;
      b = z * ISO_KY * sn; d = z * ISO_KY * cs;
    } else {
      a = z; b = 0; c = 0; d = z;
    }
    const sx = (this.cssW * this.dpr) / 2, sy = (this.cssH * this.dpr) / 2;
    const e = sx - (a * this.cam.x + c * this.cam.y);
    const f = sy - (b * this.cam.x + d * this.cam.y);
    this.M = [a, b, c, d, e, f];
    return this.M;
  }

  screenToWorld(px, py) {
    const [a, b, c, d, e, f] = this._matrix();
    const X = px * this.dpr - e, Y = py * this.dpr - f;
    const det = a * d - b * c;
    return [(d * X - c * Y) / det, (-b * X + a * Y) / det];
  }

  zoomAt(px, py, factor) {
    const [wx, wy] = this.screenToWorld(px, py);
    this.cam.zoom = Math.max(0.08, Math.min(8, this.cam.zoom * factor));
    const [wx2, wy2] = this.screenToWorld(px, py);
    this.cam.x += wx - wx2;
    this.cam.y += wy - wy2;
  }

  panBy(dxCss, dyCss) {
    const [x0, y0] = this.screenToWorld(0, 0);
    const [x1, y1] = this.screenToWorld(dxCss, dyCss);
    this.cam.x -= x1 - x0;
    this.cam.y -= y1 - y0;
  }

  _buildEdges() {
    const t = this.track;
    const n = t.n, hw = t.halfWidth;
    this.edgeL = new Float32Array(n * 2);
    this.edgeR = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      const nx = -Math.sin(t.tan[i]), ny = Math.cos(t.tan[i]);
      this.edgeL[2 * i] = t.cx[i] + nx * hw;
      this.edgeL[2 * i + 1] = t.cy[i] + ny * hw;
      this.edgeR[2 * i] = t.cx[i] - nx * hw;
      this.edgeR[2 * i + 1] = t.cy[i] - ny * hw;
    }
  }

  _prerenderTrack() {
    const t = this.track, b = t.bounds;
    const cv = document.createElement('canvas');
    const TS = Math.min(TS_MAX, 3200 / Math.max(b.w, b.h));
    cv.width = Math.ceil(b.w * TS);
    cv.height = Math.ceil(b.h * TS);
    const g = cv.getContext('2d');
    g.setTransform(TS, 0, 0, TS, -b.minX * TS, -b.minY * TS);

    // çim + doku
    g.fillStyle = '#1d3a22';
    g.fillRect(b.minX, b.minY, b.w, b.h);
    const noise = document.createElement('canvas');
    noise.width = noise.height = 96;
    const ng = noise.getContext('2d');
    for (let k = 0; k < 900; k++) {
      const v = Math.random();
      ng.fillStyle = v < 0.5 ? 'rgba(255,255,255,0.035)' : 'rgba(0,0,0,0.08)';
      ng.fillRect(Math.random() * 96, Math.random() * 96, 1 + Math.random() * 2, 1 + Math.random() * 2);
    }
    g.fillStyle = g.createPattern(noise, 'repeat');
    g.fillRect(b.minX, b.minY, b.w, b.h);
    // çim şeritleri
    g.globalAlpha = 0.05;
    g.fillStyle = '#ffffff';
    for (let x = b.minX; x < b.maxX; x += 120) g.fillRect(x, b.minY, 60, b.h);
    g.globalAlpha = 1;

    const path = new Path2D();
    path.moveTo(t.cx[0], t.cy[0]);
    for (let i = 1; i < t.n; i++) path.lineTo(t.cx[i], t.cy[i]);
    path.closePath();
    g.lineJoin = 'round';
    g.lineCap = 'round';
    const hw = t.halfWidth;

    // kum havuzu
    g.strokeStyle = '#8a7b5f';
    g.lineWidth = hw * 2 + 34;
    g.stroke(path);
    g.strokeStyle = 'rgba(0,0,0,0.12)';
    g.lineWidth = hw * 2 + 30;
    g.stroke(path);
    // kerb (kırmızı-beyaz)
    g.strokeStyle = '#f2f2f2';
    g.lineWidth = hw * 2 + 10;
    g.stroke(path);
    g.strokeStyle = '#d23a3a';
    g.setLineDash([14, 14]);
    g.stroke(path);
    g.setLineDash([]);
    // asfalt
    g.strokeStyle = '#3a3d43';
    g.lineWidth = hw * 2;
    g.stroke(path);
    g.strokeStyle = 'rgba(255,255,255,0.025)';
    g.lineWidth = hw * 1.2;
    g.stroke(path);
    // orta çizgi
    g.strokeStyle = 'rgba(255,255,255,0.18)';
    g.lineWidth = 1.5;
    g.setLineDash([18, 22]);
    g.stroke(path);
    g.setLineDash([]);

    // kenar çizgileri
    for (const side of [1, -1]) {
      g.beginPath();
      for (let i = 0; i <= t.n; i++) {
        const k = i % t.n;
        const nx = -Math.sin(t.tan[k]) * side, ny = Math.cos(t.tan[k]) * side;
        const x = t.cx[k] + nx * (hw - 3), y = t.cy[k] + ny * (hw - 3);
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.strokeStyle = 'rgba(255,255,255,0.75)';
      g.lineWidth = 1.6;
      g.stroke();
    }

    // yön okları
    g.fillStyle = 'rgba(255,255,255,0.10)';
    const step = Math.round(380 / t.ds);
    for (let i = step; i < t.n - step / 2; i += step) {
      g.save();
      g.translate(t.cx[i], t.cy[i]);
      g.rotate(t.tan[i]);
      g.beginPath();
      g.moveTo(12, 0); g.lineTo(-6, -10); g.lineTo(-2, 0); g.lineTo(-6, 10);
      g.closePath();
      g.fill();
      g.restore();
    }

    // DRS bölgeleri (dış kenarda yeşil şerit)
    const zoneAt = t.drsZoneAt;
    if (zoneAt) {
      g.strokeStyle = 'rgba(34,197,94,0.85)';
      g.lineWidth = 3.2;
      for (const side of [1, -1]) {
        g.beginPath();
        let on = false;
        for (let i = 0; i <= t.n; i++) {
          const k = i % t.n;
          if (zoneAt[k] < 0) { on = false; continue; }
          const nx = -Math.sin(t.tan[k]) * side, ny = Math.cos(t.tan[k]) * side;
          const x = t.cx[k] + nx * (hw + 1), y = t.cy[k] + ny * (hw + 1);
          if (!on) { g.moveTo(x, y); on = true; } else g.lineTo(x, y);
        }
        g.stroke();
      }
      g.font = `bold ${Math.max(9, hw * 0.55)}px system-ui, sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      (t.drsZones || []).forEach((z) => {
        const k = t.idxAt(z.s0 + 20 / t.mpp);
        const nx = -Math.sin(t.tan[k]), ny = Math.cos(t.tan[k]);
        g.fillStyle = 'rgba(34,197,94,0.95)';
        g.fillText('DRS', t.cx[k] + nx * (hw + 12), t.cy[k] + ny * (hw + 12));
      });
    }
    // sektör sınırları
    if (t.sectorFrac) {
      g.font = `bold ${Math.max(9, hw * 0.5)}px system-ui, sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      [0, 1].forEach((q) => {
        const k = t.idxAt(t.sectorFrac[q] * t.length);
        const nx = -Math.sin(t.tan[k]), ny = Math.cos(t.tan[k]);
        g.strokeStyle = 'rgba(250,204,21,0.9)';
        g.lineWidth = 2;
        g.setLineDash([5, 4]);
        g.beginPath();
        g.moveTo(t.cx[k] + nx * hw, t.cy[k] + ny * hw);
        g.lineTo(t.cx[k] - nx * hw, t.cy[k] - ny * hw);
        g.stroke();
        g.setLineDash([]);
        g.fillStyle = 'rgba(250,204,21,0.95)';
        g.fillText(`S${q + 2}`, t.cx[k] - nx * (hw + 14), t.cy[k] - ny * (hw + 14));
      });
    }
    // viraj numaraları (dönüşün dış tarafında)
    if (t.corners && t.corners.length <= 40) {
      g.font = `${Math.max(8, hw * 0.45)}px system-ui, sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      for (const c of t.corners) {
        const k = c.i;
        const side = c.k > 0 ? -1 : 1; // dış taraf
        const nx = -Math.sin(t.tan[k]) * side, ny = Math.cos(t.tan[k]) * side;
        const x = t.cx[k] + nx * (hw + 24), y = t.cy[k] + ny * (hw + 24);
        g.fillStyle = 'rgba(0,0,0,0.45)';
        g.beginPath();
        g.arc(x, y, Math.max(6, hw * 0.42), 0, Math.PI * 2);
        g.fill();
        g.fillStyle = 'rgba(255,255,255,0.85)';
        g.fillText(String(c.no), x, y + 0.5);
      }
    }

    // start/finiş çizgisi (damalı)
    g.save();
    g.translate(t.cx[0], t.cy[0]);
    g.rotate(t.tan[0]);
    const sq = 6;
    for (let r = 0; r < 2; r++) {
      for (let k = -Math.ceil(hw / sq); k < Math.ceil(hw / sq); k++) {
        g.fillStyle = (k + r) % 2 === 0 ? '#ffffff' : '#111111';
        g.fillRect(-sq + r * sq, k * sq, sq, sq);
      }
    }
    g.restore();

    this.trackCanvas = cv;
  }

  _updateHeat(sim) {
    const W = sim.heatW, H = sim.heatH;
    if (!this.heatCanvas || this.heatCanvas.width !== W || this.heatCanvas.height !== H) {
      this.heatCanvas = document.createElement('canvas');
      this.heatCanvas.width = W;
      this.heatCanvas.height = H;
      this.heatImg = this.heatCanvas.getContext('2d').createImageData(W, H);
    }
    const heat = sim.heat;
    let mx = 0;
    for (let k = 0; k < heat.length; k++) if (heat[k] > mx) mx = heat[k];
    const data = this.heatImg.data;
    const lm = Math.log1p(Math.max(mx, 3));
    for (let k = 0; k < heat.length; k++) {
      const v = heat[k];
      const p = k * 4;
      if (v <= 0.05) { data[p + 3] = 0; continue; }
      const q = Math.min(1, Math.log1p(v) / lm);
      data[p] = 255;
      data[p + 1] = Math.round(200 * (1 - q));
      data[p + 2] = 40;
      data[p + 3] = Math.round(70 + 170 * q);
    }
    this.heatCanvas.getContext('2d').putImageData(this.heatImg, 0, 0);
  }

  draw(trainer, view) {
    this.resize();
    const ctx = this.ctx;
    const sim = trainer.sim;
    const t = this.track;
    const W = this.canvas.width, H = this.canvas.height;

    // kamera takibi
    if (view.follow && view.selected >= 0 && view.selected < sim.N) {
      const i = view.selected;
      this.cam.x += (sim.x[i] - this.cam.x) * 0.12;
      this.cam.y += (sim.y[i] - this.cam.y) * 0.12;
    }
    const M = this._matrix();
    const [a, b, c, d, e, f] = M;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0f1512';
    ctx.fillRect(0, 0, W, H);

    if (this.editPoints) {
      // çizim modunda: boş zemin + ızgara + taslak
      ctx.setTransform(a, b, c, d, e, f);
      const [x0, y0] = this.screenToWorld(0, 0);
      const [x1, y1] = this.screenToWorld(this.cssW, this.cssH);
      ctx.fillStyle = '#1d3a22';
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      ctx.strokeStyle = 'rgba(255,255,255,0.06)';
      ctx.lineWidth = 1 / this.cam.zoom;
      ctx.beginPath();
      for (let x = Math.floor(x0 / 100) * 100; x < x1; x += 100) { ctx.moveTo(x, y0); ctx.lineTo(x, y1); }
      for (let y = Math.floor(y0 / 100) * 100; y < y1; y += 100) { ctx.moveTo(x0, y); ctx.lineTo(x1, y); }
      ctx.stroke();
      this._drawEditor(ctx, M);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      return;
    }
    ctx.setTransform(a, b, c, d, e, f);
    ctx.imageSmoothingEnabled = true;
    const bb = t.bounds;
    ctx.drawImage(this.trackCanvas, bb.minX, bb.minY, bb.w, bb.h);

    // izometrik bariyer duvarları
    if (this.iso) this._drawIsoWalls(ctx, M);

    // ısı haritası (çarpma = ceza noktaları)
    if (view.heatmap) {
      if (++this.heatFrame % 15 === 0 || this.heatStamp !== sim.heatVersion || !this.heatCanvas) {
        this._updateHeat(sim);
        this.heatStamp = sim.heatVersion;
      }
      ctx.setTransform(a, b, c, d, e, f);
      ctx.globalAlpha = 0.85;
      ctx.drawImage(this.heatCanvas, bb.minX, bb.minY, sim.heatW * sim.heatCell, sim.heatH * sim.heatCell);
      ctx.globalAlpha = 1;
    }

    // hayalet iz (önceki şampiyon / ortalama politika)
    if (view.ghost && trainer.ghost && trainer.ghost.length > 4) {
      const g = trainer.ghost;
      ctx.setTransform(a, b, c, d, e, f);
      ctx.beginPath();
      ctx.moveTo(g[0], g[1]);
      for (let k = 2; k < g.length; k += 2) ctx.lineTo(g[k], g[k + 1]);
      ctx.strokeStyle = 'rgba(190,160,255,0.85)';
      ctx.lineWidth = 2.2 / (this.cam.zoom);
      ctx.setLineDash([8 / this.cam.zoom, 6 / this.cam.zoom]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    this._drawCars(ctx, sim, view, M);

    // seçili aracın sensörleri
    if (view.rays && view.selected >= 0 && sim.status[view.selected] === RUNNING) {
      const i = view.selected;
      const ends = sim.rayEnds(i);
      ctx.setTransform(a, b, c, d, e, f);
      const maxRay = sim.cfg.sensors.maxRay / sim.track.mpp;
      for (let r = 0; r < ends.length / 2; r++) {
        const ex = ends[2 * r], ey = ends[2 * r + 1];
        const dist = Math.hypot(ex - sim.x[i], ey - sim.y[i]) / maxRay;
        const hue = Math.round(dist * 120);
        ctx.strokeStyle = `hsla(${hue},90%,60%,0.85)`;
        ctx.lineWidth = 1.4 / this.cam.zoom;
        ctx.beginPath();
        ctx.moveTo(sim.x[i], sim.y[i]);
        ctx.lineTo(ex, ey);
        ctx.stroke();
        ctx.fillStyle = `hsl(${hue},90%,60%)`;
        ctx.beginPath();
        ctx.arc(ex, ey, 3 / this.cam.zoom, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    if (this.editPoints) this._drawEditor(ctx, M);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  _drawIsoWalls(ctx, M) {
    const [a, b, c, d, e, f] = M;
    const lift = Math.max(2, 7 * this.cam.zoom * this.dpr);
    for (const edge of [this.edgeL, this.edgeR]) {
      const n = edge.length / 2;
      const steps = 4;
      for (let s = 0; s <= steps; s++) {
        ctx.setTransform(a, b, c, d, e, f - (lift * s) / steps);
        ctx.beginPath();
        ctx.moveTo(edge[0], edge[1]);
        for (let i = 1; i < n; i++) ctx.lineTo(edge[2 * i], edge[2 * i + 1]);
        ctx.closePath();
        ctx.strokeStyle = s === steps ? '#e8e8e8' : s % 2 ? '#c03030' : '#8a1f1f';
        ctx.lineWidth = (s === steps ? 2.2 : 3) / this.cam.zoom;
        ctx.stroke();
      }
    }
  }

  _drawCars(ctx, sim, view, M) {
    const [a, b, c, d, e, f] = M;
    const N = sim.N;
    const iso = this.iso;
    const lift = iso ? 4 * this.cam.zoom * this.dpr : 0;
    const groups = [
      { test: (i) => sim.status[i] === CRASHED, color: 'rgba(229,115,115,0.35)', show: view.showDead },
      { test: (i) => sim.status[i] !== RUNNING && sim.status[i] !== FINISHED && sim.status[i] !== CRASHED, color: 'rgba(160,160,160,0.30)', show: view.showDead },
      { test: (i) => sim.status[i] === FINISHED, color: '#ffd54f', show: true },
      { test: (i) => sim.status[i] === RUNNING && i !== 0, color: '#4fc3f7', show: true },
      { test: (i) => i === 0 && sim.status[i] === RUNNING, color: '#c39bff', show: true },
    ];
    const L = 8, Wd = 4; // yarı uzunluk / yarı genişlik

    // izometrik gölgeler
    if (iso) {
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      for (let i = 0; i < N; i++) {
        if (sim.status[i] !== RUNNING) continue;
        const cs = Math.cos(sim.ang[i]), sn = Math.sin(sim.ang[i]);
        const x = sim.x[i], y = sim.y[i];
        ctx.setTransform(a * cs + c * sn, b * cs + d * sn, -a * sn + c * cs, -b * sn + d * cs, a * x + c * y + e, b * x + d * y + f);
        ctx.fillRect(-L, -Wd, 2 * L, 2 * Wd);
      }
    }

    for (const g of groups) {
      if (!g.show) continue;
      ctx.fillStyle = g.color;
      for (let i = 0; i < N; i++) {
        if (!g.test(i)) continue;
        const cs = Math.cos(sim.ang[i]), sn = Math.sin(sim.ang[i]);
        const x = sim.x[i], y = sim.y[i];
        const up = sim.status[i] === RUNNING || sim.status[i] === FINISHED ? lift : lift * 0.3;
        ctx.setTransform(a * cs + c * sn, b * cs + d * sn, -a * sn + c * cs, -b * sn + d * cs, a * x + c * y + e, b * x + d * y + f - up);
        ctx.fillRect(-L, -Wd, 2 * L, 2 * Wd);
      }
    }
    // ön cam (koyu)
    if (this.cam.zoom > 0.35) {
      ctx.fillStyle = 'rgba(10,20,30,0.75)';
      for (let i = 0; i < N; i++) {
        if (sim.status[i] !== RUNNING && sim.status[i] !== FINISHED) continue;
        const cs = Math.cos(sim.ang[i]), sn = Math.sin(sim.ang[i]);
        const x = sim.x[i], y = sim.y[i];
        ctx.setTransform(a * cs + c * sn, b * cs + d * sn, -a * sn + c * cs, -b * sn + d * cs, a * x + c * y + e, b * x + d * y + f - lift);
        ctx.fillRect(1, -Wd + 1, 4, 2 * Wd - 2);
      }
    }
    // seçili araç vurgusu
    const s = view.selected;
    if (s >= 0 && s < N) {
      const cs = Math.cos(sim.ang[s]), sn = Math.sin(sim.ang[s]);
      const x = sim.x[s], y = sim.y[s];
      ctx.setTransform(a * cs + c * sn, b * cs + d * sn, -a * sn + c * cs, -b * sn + d * cs, a * x + c * y + e, b * x + d * y + f - lift);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(-L, -Wd, 2 * L, 2 * Wd);
      ctx.strokeStyle = '#ff4081';
      ctx.lineWidth = 2;
      ctx.strokeRect(-L - 3, -Wd - 3, 2 * L + 6, 2 * Wd + 6);
      // yarış modu: seçili aracın serisindeki rakipler
      if (sim.race) {
        const [h0, h1] = sim.heatRange(s);
        ctx.strokeStyle = '#ff9f43';
        ctx.lineWidth = 1.5;
        for (let i = h0; i < h1; i++) {
          if (i === s || (sim.status[i] !== RUNNING && sim.status[i] !== FINISHED)) continue;
          const c2 = Math.cos(sim.ang[i]), s2 = Math.sin(sim.ang[i]);
          ctx.setTransform(a * c2 + c * s2, b * c2 + d * s2, -a * s2 + c * c2, -b * s2 + d * c2, a * sim.x[i] + c * sim.y[i] + e, b * sim.x[i] + d * sim.y[i] + f - lift);
          ctx.strokeRect(-L - 2, -Wd - 2, 2 * L + 4, 2 * Wd + 4);
        }
      }
    }
  }

  _drawEditor(ctx, M) {
    const [a, b, c, d, e, f] = M;
    const pts = this.editPoints;
    ctx.setTransform(a, b, c, d, e, f);
    const z = this.cam.zoom;
    if (pts.length > 1) {
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (const p of pts) ctx.lineTo(p[0], p[1]);
      ctx.closePath();
      ctx.strokeStyle = 'rgba(255,255,255,0.18)';
      ctx.lineWidth = (this.editWidth || 40) * 2;
      ctx.lineJoin = 'round';
      ctx.stroke();
      ctx.strokeStyle = '#ffeb3b';
      ctx.lineWidth = 2 / z;
      ctx.setLineDash([6 / z, 6 / z]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    pts.forEach((p, k) => {
      ctx.fillStyle = k === 0 ? '#ff4081' : '#ffeb3b';
      ctx.beginPath();
      ctx.arc(p[0], p[1], 7 / z, 0, Math.PI * 2);
      ctx.fill();
    });
  }
}
