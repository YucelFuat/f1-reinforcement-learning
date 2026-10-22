// Deney yöneticisi – arayüz (kalıcı pencere). Kütüphane yok: düz DOM + canvas (charts.js LineChart).
//
//   openExperimentManager({
//     getCurrent:    () => şu anki eğitimin deney nesnesi (veya null),
//     onLoadBrain:   (brain, run) => {},   // "Beyni yükle"
//     onApplyConfig: (cfg, run) => {},     // "Ayarları uygula" (aynı tohum + ayarlar = tekrar üretilebilir koşu)
//   })

import { LineChart } from './charts.js';
import { fmtLap } from './config.js';
import { upgradeBrain } from './brain.js';
import {
  saveRun, listRuns, deleteRun, downloadRuns, importRunsFromFile, diffConfigs, formatValue,
  mergeHistories, runningBestLap, defaultRunName,
} from './experiments.js';

// Koyu tema kategorik renkleri (uygulamanın grafik renkleriyle aynı sıra; renk körlüğü için doğrulandı)
const PALETTE = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
const MAX_COMPARE = PALETTE.length;

let current = null; // açık pencere

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function fmtDate(ts) {
  if (!ts) return '–';
  try {
    return new Date(ts).toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch {
    return new Date(ts).toISOString().slice(0, 16).replace('T', ' ');
  }
}

function fmtDur(sec) {
  if (sec == null || !isFinite(sec)) return '–';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (h) return `${h} sa ${m} dk`;
  if (m) return `${m} dk ${s} sn`;
  return `${s} sn`;
}

const lapOrDash = (v) => (v == null ? '–' : fmtLap(v));
const shortName = (s, n = 26) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

export function openExperimentManager(opts = {}) {
  if (current) {
    current.refresh();
    return current;
  }
  const { getCurrent = () => null, onLoadBrain = null, onApplyConfig = null } = opts;
  const prevFocus = document.activeElement;

  const ov = document.createElement('div');
  ov.className = 'xp-overlay';
  ov.innerHTML = `
    <div class="xp-modal" role="dialog" aria-modal="true" aria-labelledby="xpTitle">
      <header class="xp-head">
        <div><b id="xpTitle">Deney yöneticisi</b><span>Eğitimleri kaydet, karşılaştır ve aynı ayarlarla yeniden üret</span></div>
        <button class="xp-x" title="Kapat (Esc)" aria-label="Kapat">✕</button>
      </header>
      <div class="xp-body">
        <section class="xp-card xp-save">
          <h4>Bu deneyi kaydet</h4>
          <div class="xp-cur"></div>
          <div class="xp-save-row">
            <input type="text" class="xp-name" maxlength="80" placeholder="Deney adı" aria-label="Deney adı" />
            <button class="primary xp-do-save">Kaydet</button>
          </div>
          <textarea class="xp-notes" rows="2" maxlength="2000" placeholder="Notlar (isteğe bağlı): ne denedin, ne bekliyordun?" aria-label="Notlar"></textarea>
        </section>

        <section class="xp-card">
          <div class="xp-toolbar">
            <h4>Kayıtlı deneyler <small class="xp-count"></small></h4>
            <span class="xp-sp"></span>
            <button class="xp-import" title="Daha önce dışa aktarılmış deney dosyasını (.json) yükle">İçe aktar…</button>
            <button class="xp-export" title="Seçilen deneyleri (seçim yoksa tümünü) JSON dosyası olarak indir">Tümünü dışa aktar</button>
            <button class="primary xp-compare-btn" disabled>Karşılaştır</button>
            <input type="file" class="xp-file" accept=".json,application/json" hidden />
          </div>
          <div class="xp-msg" aria-live="polite"></div>
          <div class="xp-table-wrap"><table class="xp-table">
            <thead><tr>
              <th class="xp-c-sel" title="Karşılaştırmak için seç (en çok ${MAX_COMPARE})"></th>
              <th>Tarih</th><th>Ad</th><th>Pist</th><th>Algoritma</th><th class="num">Tohum</th><th class="num">Araç</th>
              <th class="num">En iyi tur</th><th class="num">İdeal tur</th><th class="num" title="Nesil (popülasyon) veya güncelleme (PPO/SAC)">Nesil</th>
              <th class="num" title="Eğitimin gerçek (duvar saati) süresi">Süre</th><th>İşlemler</th>
            </tr></thead>
            <tbody></tbody>
          </table></div>
        </section>

        <section class="xp-card xp-compare" hidden>
          <div class="xp-toolbar"><h4>Karşılaştırma</h4><span class="xp-sp"></span><button class="xp-compare-close">Gizle</button></div>
          <div class="xp-legend"></div>
          <div class="xp-charts"></div>
          <h4 class="xp-sub">Özet</h4>
          <div class="xp-table-wrap"><table class="xp-table xp-sum"></table></div>
          <h4 class="xp-sub">Ayar farkları</h4>
          <div class="xp-diff"></div>
        </section>
      </div>
    </div>`;
  document.body.appendChild(ov);

  const q = (s) => ov.querySelector(s);
  const state = { runs: [], selected: new Map(), compareShown: false, charts: [], confirmDel: null };

  // ---------- mesajlar ----------
  let msgTimer = 0;
  const msg = (text, err = false) => {
    const m = q('.xp-msg');
    m.textContent = text;
    m.className = 'xp-msg' + (err ? ' err' : ' ok');
    clearTimeout(msgTimer);
    msgTimer = setTimeout(() => {
      m.textContent = '';
      m.className = 'xp-msg';
    }, 5000);
  };

  // pencere boyutu değişince grafikleri yeniden çiz
  const onResize = () => {
    if (state.compareShown) for (const c of state.charts) c.chart.draw(c.data);
  };
  window.addEventListener('resize', onResize);

  // Pencere açıkken: Esc kapatır; diğer tuşlar uygulama kısayollarına (Boşluk, N, R, 1-6…) ulaşmaz.
  // Yakalama aşamasında durdurulur → odak pencere dışında (ör. devre dışı kalan düğme) olsa da çalışır.
  // Yazı alanlarına yazma bundan etkilenmez (varsayılan davranış).
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
    e.stopPropagation();
  };
  window.addEventListener('keydown', onKey, true);

  // ---------- kapatma ----------
  const close = () => {
    clearTimeout(msgTimer);
    window.removeEventListener('resize', onResize);
    window.removeEventListener('keydown', onKey, true);
    ov.remove();
    current = null;
    if (prevFocus && prevFocus.focus) try { prevFocus.focus(); } catch { /* yok */ }
  };
  q('.xp-x').onclick = close;
  ov.addEventListener('mousedown', (e) => {
    if (e.target === ov) close();
  });

  // ---------- şu anki deney ----------
  function renderCurrent() {
    let cur = null;
    try { cur = getCurrent(); } catch (e) { console.error(e); }
    const box = q('.xp-cur');
    const btn = q('.xp-do-save');
    if (!cur) {
      box.textContent = 'Kaydedilecek bir eğitim yok.';
      btn.disabled = true;
      return;
    }
    btn.disabled = false;
    const gens = cur.generations ?? cur.history?.at?.(-1)?.gen ?? 0;
    const parts = [
      cur.algoLabel || cur.algo, cur.trackName || cur.trackId, `${gens} nesil/güncelleme`,
      `en iyi tur ${lapOrDash(cur.bestLapSec)}`, cur.idealLapSec ? `ideal ${fmtLap(cur.idealLapSec)}` : null,
      cur.carCount ? `${cur.carCount} araç` : null, cur.seed != null ? `tohum ${cur.seed}` : 'tohum bilinmiyor',
    ].filter(Boolean);
    box.innerHTML = `<span class="xp-dot"></span>Şu anki eğitim: ${esc(parts.join(' · '))}`;
    const name = q('.xp-name');
    name.placeholder = defaultRunName({ ...cur, createdAt: Date.now() });
  }

  q('.xp-do-save').onclick = async () => {
    let cur = null;
    try { cur = getCurrent(); } catch (e) { console.error(e); }
    if (!cur) return msg('Kaydedilecek bir eğitim yok.', true);
    const btn = q('.xp-do-save');
    btn.disabled = true;
    try {
      const name = q('.xp-name').value.trim() || q('.xp-name').placeholder;
      const id = await saveRun({ ...cur, name, notes: q('.xp-notes').value, createdAt: Date.now() });
      q('.xp-name').value = '';
      q('.xp-notes').value = '';
      msg(`"${name}" kaydedildi.`);
      await refresh();
      const row = ov.querySelector(`tr[data-id="${id}"]`);
      if (row) row.classList.add('xp-new');
    } catch (e) {
      console.error(e);
      msg('Kaydedilemedi: ' + (e.message || e), true);
    } finally {
      btn.disabled = false;
    }
  };

  // ---------- liste ----------
  function freeColor() {
    const used = new Set(state.selected.values());
    for (let i = 0; i < MAX_COMPARE; i++) if (!used.has(i)) return i;
    return -1;
  }

  function renderList() {
    const tb = q('.xp-table tbody');
    q('.xp-count').textContent = state.runs.length ? `(${state.runs.length})` : '';
    if (!state.runs.length) {
      tb.innerHTML = `<tr><td colspan="12" class="xp-empty">Henüz kayıtlı deney yok. Yukarıdan şu anki eğitimi kaydedebilir veya bir dosya içe aktarabilirsin.</td></tr>`;
    } else {
      const full = state.selected.size >= MAX_COMPARE;
      tb.innerHTML = state.runs
        .map((r) => {
          const ci = state.selected.get(r.id);
          const sel = ci != null;
          const brain = r.bestLapBrain || r.bestBrain;
          return `<tr data-id="${r.id}" class="${sel ? 'sel' : ''}">
            <td class="xp-c-sel"><label class="xp-check">${sel ? `<i style="background:${PALETTE[ci]}"></i>` : '<i></i>'}<input type="checkbox" data-act="sel" ${sel ? 'checked' : ''} ${!sel && full ? 'disabled' : ''} aria-label="Karşılaştırmaya ekle"></label></td>
            <td class="nowrap">${esc(fmtDate(r.createdAt))}</td>
            <td class="xp-name-cell"><b>${esc(r.name)}</b>${r.notes ? `<small title="${esc(r.notes)}">${esc(shortName(r.notes.replace(/\s+/g, ' '), 70))}</small>` : ''}</td>
            <td>${esc(r.trackName || r.trackId || '–')}</td>
            <td title="${esc(r.algoLabel)}">${esc(shortName(r.algoLabel || r.algo || '–', 24))}</td>
            <td class="num">${r.seed ?? '–'}</td>
            <td class="num">${r.carCount ?? '–'}</td>
            <td class="num">${lapOrDash(r.bestLapSec)}</td>
            <td class="num">${lapOrDash(r.idealLapSec)}</td>
            <td class="num">${r.generations ?? '–'}</td>
            <td class="num nowrap">${fmtDur(r.wallSec)}</td>
            <td><div class="xp-acts">
              <button data-act="apply" title="Bu deneyin ayarlarını, pistini, algoritmasını ve tohumunu uygula ve yeniden başlat" ${onApplyConfig ? '' : 'disabled'}>Ayarları uygula</button>
              <button data-act="brain" title="${brain ? 'Bu deneyin en iyi beynini yükle' : 'Bu deneyde kayıtlı beyin yok'}" ${brain && onLoadBrain ? '' : 'disabled'}>Beyni yükle</button>
              <button data-act="export" title="Bu deneyi JSON dosyası olarak indir">Dışa aktar</button>
              <button data-act="del" class="xp-del" title="Sil">${state.confirmDel === r.id ? 'Emin misin?' : 'Sil'}</button>
            </div></td>
          </tr>`;
        })
        .join('');
    }
    const n = state.selected.size;
    const cb = q('.xp-compare-btn');
    cb.disabled = n < 1;
    cb.textContent = n ? `Karşılaştır (${n})` : 'Karşılaştır';
    q('.xp-export').textContent = n ? `Seçilenleri dışa aktar (${n})` : 'Tümünü dışa aktar';
    q('.xp-export').disabled = !state.runs.length;
  }

  async function refresh() {
    try {
      state.runs = await listRuns();
    } catch (e) {
      console.error(e);
      state.runs = [];
      msg('Deneyler okunamadı: ' + (e.message || e), true);
    }
    const ids = new Set(state.runs.map((r) => r.id));
    for (const id of [...state.selected.keys()]) if (!ids.has(id)) state.selected.delete(id);
    renderCurrent();
    renderList();
    if (state.compareShown) renderCompare();
  }

  const runById = (id) => state.runs.find((r) => String(r.id) === String(id));

  q('.xp-table tbody').addEventListener('click', async (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const tr = el.closest('tr[data-id]');
    const run = tr && runById(tr.dataset.id);
    if (!run) return;
    const act = el.dataset.act;
    if (act === 'sel') {
      if (el.checked) {
        const c = freeColor();
        if (c < 0) {
          el.checked = false;
          return msg(`En çok ${MAX_COMPARE} deney karşılaştırılabilir.`, true);
        }
        state.selected.set(run.id, c);
      } else state.selected.delete(run.id);
      renderList();
      if (state.compareShown) renderCompare();
    } else if (act === 'apply') {
      if (!onApplyConfig) return;
      try {
        onApplyConfig(structuredClone(run.cfg), run);
        close();
      } catch (err) {
        console.error(err);
        msg('Ayarlar uygulanamadı: ' + (err.message || err), true);
      }
    } else if (act === 'brain') {
      const b = run.bestLapBrain || run.bestBrain;
      if (!b || !onLoadBrain) return;
      try {
        onLoadBrain(upgradeBrain(b), run);
        close();
      } catch (err) {
        console.error(err);
        msg('Beyin yüklenemedi: ' + (err.message || err), true);
      }
    } else if (act === 'export') {
      downloadRuns([run]);
    } else if (act === 'del') {
      if (state.confirmDel !== run.id) {
        state.confirmDel = run.id;
        renderList();
        setTimeout(() => {
          if (state.confirmDel === run.id) {
            state.confirmDel = null;
            if (current) renderList();
          }
        }, 3000);
        return;
      }
      state.confirmDel = null;
      try {
        await deleteRun(run.id);
        state.selected.delete(run.id);
        msg(`"${run.name}" silindi.`);
        await refresh();
      } catch (err) {
        msg('Silinemedi: ' + (err.message || err), true);
      }
    }
  });

  // ---------- içe / dışa aktarma ----------
  q('.xp-import').onclick = () => q('.xp-file').click();
  q('.xp-file').onchange = async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const ids = await importRunsFromFile(f);
      msg(`${ids.length} deney içe aktarıldı.`);
      await refresh();
    } catch (err) {
      console.error(err);
      msg('İçe aktarılamadı: ' + (err.message || err), true);
    }
  };
  q('.xp-export').onclick = () => {
    const list = state.selected.size ? state.runs.filter((r) => state.selected.has(r.id)) : state.runs;
    if (!list.length) return;
    downloadRuns(list);
  };

  // ---------- karşılaştırma ----------
  q('.xp-compare-btn').onclick = () => {
    state.compareShown = true;
    q('.xp-compare').hidden = false;
    renderCompare();
    q('.xp-compare').scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  q('.xp-compare-close').onclick = () => {
    state.compareShown = false;
    q('.xp-compare').hidden = true;
  };

  function renderCompare() {
    const runs = state.runs.filter((r) => state.selected.has(r.id));
    const box = q('.xp-compare');
    if (!runs.length) {
      q('.xp-legend').innerHTML = '';
      q('.xp-charts').innerHTML = '<p class="xp-empty">Karşılaştırmak için listeden en az bir deney seç.</p>';
      q('.xp-sum').innerHTML = '';
      q('.xp-diff').innerHTML = '';
      return;
    }
    box.hidden = false;
    const color = (r) => PALETTE[state.selected.get(r.id)];

    // lejant
    q('.xp-legend').innerHTML = runs
      .map((r) => `<span><i style="background:${color(r)}"></i>${esc(shortName(r.name, 40))} <small>${esc(r.trackName || '')} · ${esc(shortName(r.algoLabel || r.algo, 22))}</small></span>`)
      .join('');

    // grafikler
    const defs = [
      { title: 'En iyi tur süresi (o ana kadarki, sn) — düşük daha iyi', seriesOf: runningBestLap, yFormat: (v) => v.toFixed(1) + 's' },
      { title: 'Bitirme oranı (%)', seriesOf: (h) => h.map((e) => (typeof e.finishRate === 'number' ? e.finishRate * 100 : null)), yFormat: (v) => v.toFixed(0) + '%', minY: 0, maxY: 100 },
      { title: 'En iyi ödül (fitness)', seriesOf: (h) => h.map((e) => (typeof e.best === 'number' ? e.best : null)), yFormat: (v) => (Math.abs(v) >= 1000 ? (v / 1000).toFixed(1) + 'k' : v.toFixed(0)) },
    ];
    if (runs.some((r) => (r.history || []).some((e) => typeof e.q === 'number'))) {
      defs.push({ title: 'Skor (ödülden bağımsız: ilerleme + bitirme + tur süresi)', seriesOf: (h) => h.map((e) => (typeof e.q === 'number' ? e.q : null)), yFormat: (v) => v.toFixed(2) });
    }
    const wrap = q('.xp-charts');
    const datas = defs.map((d) => mergeHistories(runs, d.seriesOf));
    const hasData = datas.map((data) => data.some((e) => e.v.some((v) => v != null)));
    wrap.innerHTML = defs
      .map((d, k) => `<div class="xp-chart"><h5>${esc(d.title)}</h5>${hasData[k] ? '<canvas></canvas>' : `<div class="xp-nochart">${k === 0 ? 'Seçilen deneylerde henüz tamamlanan tur yok.' : 'Veri yok.'}</div>`}</div>`)
      .join('');
    const canvases = wrap.querySelectorAll('canvas');
    let ci = 0;
    state.charts = [];
    defs.forEach((d, k) => {
      if (!hasData[k]) return;
      const data = datas[k];
      const chart = new LineChart(canvases[ci++], {
        series: runs.map((r, i) => ({ label: shortName(r.name, 22), color: color(r), get: (e) => e.v[i] })),
        yFormat: d.yFormat,
        xLabel: 'Nesil/günc.',
        minY: d.minY ?? null,
        maxY: d.maxY ?? null,
      });
      state.charts.push({ chart, data });
    });
    requestAnimationFrame(() => {
      for (const c of state.charts) c.chart.draw(c.data);
    });

    // özet tablosu (grafiklerin tablo görünümü)
    const last = (r) => (r.history && r.history.length ? r.history[r.history.length - 1] : null);
    const bestFit = (r) => (r.history || []).reduce((m, e) => (typeof e.best === 'number' && e.best > m ? e.best : m), -Infinity);
    const sumRows = [
      ['En iyi tur', (r) => lapOrDash(r.bestLapSec)],
      ['İdeal tur (en iyi sektörler)', (r) => lapOrDash(r.idealLapSec)],
      ['Nesil / güncelleme', (r) => r.generations ?? '–'],
      ['Son bitirme oranı', (r) => (last(r) && typeof last(r).finishRate === 'number' ? `%${(last(r).finishRate * 100).toFixed(0)}` : '–')],
      ['En yüksek ödül', (r) => { const b = bestFit(r); return isFinite(b) ? b.toFixed(0) : '–'; }],
      ['Eğitim süresi', (r) => fmtDur(r.wallSec)],
      ['Simüle edilen süre', (r) => (r.totalTicks ? fmtDur(r.totalTicks / 60) : '–')],
    ];
    q('.xp-sum').innerHTML =
      `<thead><tr><th></th>${runs.map((r) => `<th class="num"><i class="xp-sw" style="background:${color(r)}"></i>${esc(shortName(r.name, 24))}</th>`).join('')}</tr></thead>` +
      `<tbody>${sumRows.map(([lbl, f]) => `<tr><td>${esc(lbl)}</td>${runs.map((r) => `<td class="num">${esc(f(r))}</td>`).join('')}</tr>`).join('')}</tbody>`;

    // ayar farkları
    const diffBox = q('.xp-diff');
    if (runs.length < 2) {
      diffBox.innerHTML = '<p class="xp-empty">Ayar farklarını görmek için en az iki deney seç.</p>';
      return;
    }
    const rows = diffConfigs(runs);
    if (!rows.length) {
      diffBox.innerHTML = '<p class="xp-empty">Seçilen deneylerin tüm ayarları aynı.</p>';
      return;
    }
    let html = `<div class="xp-table-wrap"><table class="xp-table xp-diff-t"><thead><tr><th>Ayar</th>${runs
      .map((r) => `<th class="num"><i class="xp-sw" style="background:${color(r)}"></i>${esc(shortName(r.name, 24))}</th>`)
      .join('')}</tr></thead><tbody>`;
    let sec = null;
    for (const row of rows) {
      if (row.section !== sec) {
        sec = row.section;
        html += `<tr class="xp-sec"><td colspan="${runs.length + 1}">${esc(row.sectionLabel)}</td></tr>`;
      }
      const base = JSON.stringify(row.values[0] ?? null);
      html += `<tr><td class="xp-key" title="${esc(row.key)}">${esc(row.name)}</td>${row.values
        .map((v, i) => `<td class="num${i > 0 && JSON.stringify(v ?? null) !== base ? ' xp-chg' : ''}">${esc(formatValue(v))}</td>`)
        .join('')}</tr>`;
    }
    html += '</tbody></table></div>';
    diffBox.innerHTML = html + `<p class="xp-hint">Yalnızca farklı olan ${rows.length} ayar gösteriliyor. Vurgulu hücreler ilk deneyden farklı.</p>`;
  }

  current = {
    refresh,
    close,
    get element() {
      return ov;
    },
  };
  refresh();
  setTimeout(() => q('.xp-name').focus(), 30);
  return current;
}
