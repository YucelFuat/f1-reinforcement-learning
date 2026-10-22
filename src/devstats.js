// Geliştirici modu: FPS, kare süreleri, simülasyon/çizim maliyeti, ana iş parçacığı yükü,
// bellek ve (node server.js üzerinden) GERÇEK sistem CPU kullanımı.

export class DevStats {
  constructor(root) {
    this.root = root;
    this.frames = []; // {t, dt, sim, render, ticks, cars}
    this.spark = root.querySelector('canvas');
    this.body = root.querySelector('.dev-body');
    this.server = null;
    this.serverOk = null;
    this.longTasks = [];
    this.lastUi = 0;
    this.ppoMs = 0;
    try {
      const po = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) this.longTasks.push({ t: performance.now(), d: e.duration });
      });
      po.observe({ type: 'longtask', buffered: false });
    } catch { /* desteklenmiyor */ }
    this._poll();
    setInterval(() => this._poll(), 1000);
  }

  async _poll() {
    if (this.root.hidden) return;
    try {
      const r = await fetch('/api/stats', { cache: 'no-store' });
      if (!r.ok) throw new Error();
      this.server = await r.json();
      this.serverOk = true;
    } catch {
      this.serverOk = false;
    }
  }

  record(f) {
    this.frames.push(f);
    const cut = f.t - 3000;
    while (this.frames.length && this.frames[0].t < cut) this.frames.shift();
  }

  render(extra) {
    const now = performance.now();
    if (this.root.hidden || now - this.lastUi < 250) return;
    this.lastUi = now;
    const fr = this.frames.filter((f) => f.t > now - 1000);
    if (!fr.length) return;
    const fps = fr.length;
    const dts = fr.map((f) => f.dt);
    const avgDt = dts.reduce((a, b) => a + b, 0) / dts.length;
    const worst = Math.max(...dts);
    const simMs = fr.reduce((a, f) => a + f.sim, 0);
    const renMs = fr.reduce((a, f) => a + f.render, 0);
    const uiMs = fr.reduce((a, f) => a + (f.ui || 0), 0);
    const span = Math.max(1, now - fr[0].t + avgDt);
    const load = Math.min(100, ((simMs + renMs + uiMs) / span) * 100);
    const ticks = fr.reduce((a, f) => a + f.ticks, 0);
    const carSteps = fr.reduce((a, f) => a + f.ticks * f.cars, 0);
    this.longTasks = this.longTasks.filter((l) => l.t > now - 10000);
    const mem = performance.memory;
    const s = this.server;

    const row = (k, v, cls = '') => `<div class="dv-row"><span>${k}</span><b class="${cls}">${v}</b></div>`;
    const lvl = (v, a, b) => (v < a ? 'ok' : v < b ? 'warn' : 'bad');
    let html = '';
    html += row('FPS', fps, fps >= 50 ? 'ok' : fps >= 30 ? 'warn' : 'bad');
    html += row('Kare süresi (ort / en kötü)', `${avgDt.toFixed(1)} / ${worst.toFixed(0)} ms`);
    html += row('Simülasyon / kare', `${(simMs / fps).toFixed(2)} ms`);
    html += row('Çizim / kare', `${(renMs / fps).toFixed(2)} ms`);
    html += row('Ana iş parçacığı yükü', `${load.toFixed(0)} %`, lvl(load, 60, 90));
    html += row('Sim adımı / sn', `${ticks.toLocaleString('tr-TR')}  (${(ticks / 60).toFixed(1)}x)`);
    html += row('Araç-adım / sn', carSteps >= 1e6 ? `${(carSteps / 1e6).toFixed(2)} M` : `${(carSteps / 1e3).toFixed(0)} K`);
    html += row('Uzun görev (>50ms, 10 sn)', this.longTasks.length, this.longTasks.length ? 'warn' : 'ok');
    if (extra.workers) html += row('Simülasyon işçileri', extra.workers);
    if (extra.ppoMs != null) html += row('PPO güncelleme (worker)', `${extra.ppoMs.toFixed(0)} ms`);
    if (mem) html += row('JS bellek', `${(mem.usedJSHeapSize / 1048576).toFixed(0)} / ${(mem.jsHeapSizeLimit / 1048576).toFixed(0)} MB`);
    html += row('Mantıksal çekirdek', navigator.hardwareConcurrency || '?');
    html += row('Canvas', `${extra.canvasW}×${extra.canvasH} @${extra.dpr}x`);

    if (this.serverOk && s) {
      html += `<div class="dv-sep">Sistem (gerçek CPU)</div>`;
      html += row('CPU toplam', `${s.cpu.total.toFixed(0)} %`, lvl(s.cpu.total, 60, 85));
      html += `<div class="dv-cores">${s.cpu.cores
        .map((c) => `<i title="${c.toFixed(0)}%"><em style="height:${Math.max(2, c)}%;background:${c > 85 ? '#f85149' : c > 60 ? '#d29922' : '#3fb950'}"></em></i>`)
        .join('')}</div>`;
      html += row('RAM', `${((s.mem.total - s.mem.free) / 1073741824).toFixed(1)} / ${(s.mem.total / 1073741824).toFixed(1)} GB`);
      html += `<div class="dv-note">${s.cpuModel}</div>`;
    } else if (this.serverOk === false) {
      html += `<div class="dv-note">Sistem CPU% için uygulamayı <code>node server.js</code> ile açın.</div>`;
    }
    this.body.innerHTML = html;
    this._drawSpark();
  }

  _drawSpark() {
    const cv = this.spark;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = cv.clientWidth, h = cv.clientHeight;
    if (cv.width !== w * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const fr = this.frames.slice(-Math.floor(w));
    const maxMs = 50;
    // 16.7 ms ve 33 ms çizgileri
    for (const [ms, col] of [[16.7, 'rgba(63,185,80,0.5)'], [33.3, 'rgba(210,153,34,0.5)']]) {
      const y = h - (ms / maxMs) * h;
      ctx.strokeStyle = col;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
    const x0 = w - fr.length;
    fr.forEach((f, i) => {
      const simH = (Math.min(maxMs, f.sim) / maxMs) * h;
      const renH = (Math.min(maxMs, f.render) / maxMs) * h;
      const dtH = (Math.min(maxMs, f.dt) / maxMs) * h;
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.fillRect(x0 + i, h - dtH, 1, dtH);
      ctx.fillStyle = '#3987e5';
      ctx.fillRect(x0 + i, h - simH, 1, simH);
      ctx.fillStyle = '#d95926';
      ctx.fillRect(x0 + i, h - simH - renH, 1, renH);
    });
  }
}
