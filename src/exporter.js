// Replay verilerini tek bir ZIP dosyası olarak indirir (sıkıştırmasız, bağımlılıksız ZIP yazıcı).

import { fmtLap, COMPOUND_IDS } from './config.js';
import { traceValueAt, monoTable, interp } from './replay-analysis.js';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const enc = new TextEncoder();

export function makeZip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const f of files) {
    const name = enc.encode(f.name);
    const data = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
    const crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, 0x0800, true); // UTF-8 dosya adı
    lh.setUint16(8, 0, true); // sıkıştırma yok
    lh.setUint16(10, dosTime, true);
    lh.setUint16(12, dosDate, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, data.length, true);
    lh.setUint32(22, data.length, true);
    lh.setUint16(26, name.length, true);
    lh.setUint16(28, 0, true);
    parts.push(new Uint8Array(lh.buffer), name, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, 0, true);
    ch.setUint16(12, dosTime, true);
    ch.setUint16(14, dosDate, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, data.length, true);
    ch.setUint32(24, data.length, true);
    ch.setUint16(28, name.length, true);
    ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((s, p) => s + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
}

export function dataURLtoBytes(url) {
  const b64 = url.split(',')[1];
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(a.href);
  }, 8000);
}

// CSV: standart (virgül + nokta) ve Türkçe Excel uyumlu (noktalı virgül + ondalık virgül)
function toCSV(header, rows, tr) {
  const sep = tr ? ';' : ',';
  const num = (v) => {
    if (typeof v !== 'number') return `"${String(v).replace(/"/g, '""')}"`;
    if (!isFinite(v)) return '';
    const s = Number.isInteger(v) ? String(v) : v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
    return tr ? s.replace('.', ',') : s;
  };
  const lines = [header.join(sep)];
  for (const r of rows) lines.push(r.map(num).join(sep));
  return '﻿' + lines.join('\r\n');
}

export function telemetryRows(T) {
  const header = ['zaman_s', 'zaman_pitsiz_s', 'mesafe_m', 'tur', 'x_m', 'y_m', 'rakim_m', 'hiz_kmh', 'gaz_yuzde', 'fren_yuzde', 'vites', 'devir_rpm',
    'direksiyon_komut', 'direksiyon_gercek', 'yanal_g', 'boylamsal_g', 'kayma_yuzde', 'kayma_acisi_derece',
    'lastik_hamuru', 'lastik_sicaklik_c', 'lastik_asinma_yuzde', 'yakit_kg', 'ers_sarj_yuzde', 'ers_guc_kw', 'drs_acik', 'durum',
    ...[-90, -60, -35, -15, 0, 15, 35, 60, 90].map((a) => `isin_${a}_derece_oran`)];
  const rows = [];
  const has = !!T.tyreT;
  for (let i = 0; i < T.n; i++) {
    rows.push([T.t[i], has ? T.tnp[i] : T.t[i], T.dist[i], has ? T.lap[i] + 1 : 1, T.x[i], T.y[i], T.elev[i], T.speed[i], T.thr[i] * 100, T.brake[i] * 100, T.gear[i], Math.round(T.rpm[i]),
      T.steerCmd[i], T.steerPos[i], T.latG[i], T.longG[i], T.slip[i] * 100,
      has ? T.beta[i] : '', has ? COMPOUND_IDS[T.comp[i]] || '' : '', has ? T.tyreT[i] : '', has ? T.wear[i] * 100 : '', has ? T.fuel[i] : '',
      has ? T.soc[i] * 100 : '', has ? T.ersKW[i] : '', has ? T.drs[i] : '', has ? T.status[i] : '',
      ...T.rays.map((a) => a[i])]);
  }
  return { header, rows };
}

// Sektör ve mini sektör tablosu (TelemetryPanel.sectorRows çıktısı)
export function sectorTableRows(rows) {
  const nm = rows.length ? rows[0].minis.length : 0;
  const renk = { p: 'mor', g: 'yesil', y: 'sari', '': '' };
  const header = ['satir', 'tur', 'tamamlandi', 's1_s', 's2_s', 's3_s', 'tur_s', 's1_renk', 's2_renk', 's3_renk', 'tur_renk',
    ...Array.from({ length: nm }, (_, m) => `mini_${m + 1}_s`), ...Array.from({ length: nm }, (_, m) => `mini_${m + 1}_renk`)];
  const out = rows.map((r) => [
    r.name, r.lap, r.complete ? 1 : 0, r.sectors[0] ?? '', r.sectors[1] ?? '', r.sectors[2] ?? '', r.time ?? '',
    ...r.cls.sectors.map((c) => renk[c] || ''), renk[r.cls.time] || '',
    ...r.minis.map((v) => v ?? ''), ...r.cls.minis.map((c) => renk[c] || ''),
  ]);
  return { header, rows: out };
}

// Karşılaştırma: 5 m aralıklı ortak mesafe ekseninde odak ve karşılaştırma kanalları + delta zaman
export function comparisonRows(T, cmp) {
  const tr = cmp.trace, dl = cmp.delta;
  const mono = monoTable(T.dist, Float32Array.from({ length: T.n }, (_, i) => i), T.n);
  const at = (arr, d) => {
    const fi = interp(mono.d, mono.t, d);
    if (!isFinite(fi)) return '';
    const i = Math.floor(fi), j = Math.min(T.n - 1, i + 1), f = fi - i;
    return arr[i] + (arr[j] - arr[i]) * f;
  };
  const header = ['mesafe_m', 'delta_s', 'odak_zaman_s', 'odak_hiz_kmh', 'karsi_hiz_kmh', 'odak_gaz_yuzde', 'karsi_gaz_yuzde', 'odak_fren_yuzde', 'karsi_fren_yuzde', 'odak_vites', 'karsi_vites'];
  const rows = [];
  for (let k = 0; k < dl.n; k++) {
    const d = dl.x[k];
    const v = (c) => {
      const x = traceValueAt(tr, c, d);
      return isFinite(x) ? x : '';
    };
    const pct = (x) => (x === '' ? '' : x * 100);
    rows.push([d, isFinite(dl.y[k]) ? dl.y[k] : '', at(T.time, d), at(T.speed, d), v('speed'), pct(at(T.thr, d)), pct(v('thr')), pct(at(T.brake, d)), pct(v('brake')), T.gear[Math.max(0, Math.round(interp(mono.d, mono.t, d)) || 0)] ?? '', v('gear')]);
  }
  return { header, rows };
}

// Çoklu tekrar: tüm araçların özeti
export function carsSummaryRows(cars) {
  const header = ['arac', 'renk', 'durum', 'sure_s', 'sira', 'tur', 'en_iyi_tur_s', 'en_iyi_s1_s', 'en_iyi_s2_s', 'en_iyi_s3_s', 'en_yuksek_hiz_kmh', 'ortalama_hiz_kmh',
    'sollama', 'temas', 'carpma', 'spin', 'pit', 'kullanilan_yakit_kg', 'maks_lastik_sicakligi_c', 'son_asinma_yuzde'];
  const rows = cars.map((c) => {
    const s = c.T.summary, r = c.rep, b = c.T.bestLap;
    return [c.name, c.livery || '', s.sonuc, s.surS, r.place || '', r.laps, b ? b.time : '', b ? b.sectors[0] ?? '' : '', b ? b.sectors[1] ?? '' : '', b ? b.sectors[2] ?? '' : '',
      s.enYuksekHizKmh, s.ortalamaHizKmh, r.overtakes ?? '', r.contacts ?? '', r.crashes ?? '', r.spins ?? '', s.pitSayisi, s.kullanilanYakitKg, s.maksLastikSicakligiC, s.sonLastikAsinmaYuzde];
  });
  return { header, rows };
}

export function historyRows(history) {
  const header = ['nesil_veya_guncelleme', 'en_iyi_odul', 'ortalama_odul', 'bitiren', 'bitirme_orani', 'en_iyi_tur_s', 'ortalama_ilerleme', 'skor'];
  const rows = history.map((h) => [h.gen, h.best, h.avg, h.finishers, h.finishRate, h.bestLap ?? '', h.avgProgress, h.q ?? '']);
  return { header, rows };
}

export function buildExport({ T, panel, title, meta, history, tunerLog, brain, mapCanvas, frameDataURL, mode = 'single', focusName, cars, sectorRows, cmp, events }) {
  const files = [];
  const both = (base, tbl) => {
    files.push({ name: `${base}.csv`, data: toCSV(tbl.header, tbl.rows, false) });
    files.push({ name: `${base}_excel_tr.csv`, data: toCSV(tbl.header, tbl.rows, true) });
  };
  both('telemetri', telemetryRows(T));
  if (history && history.length) both('egitim_gecmisi', historyRows(history));
  if (sectorRows && sectorRows.length) both('sektorler', sectorTableRows(sectorRows));
  if (cmp && cmp.delta && cmp.delta.n) both('karsilastirma_delta', comparisonRows(T, cmp));
  if (cars && cars.length > 1) {
    both('araclar_ozet', carsSummaryRows(cars));
    cars.forEach((c, i) => {
      const tel = telemetryRows(c.T);
      const trm = { ğ: 'g', ü: 'u', ş: 's', ö: 'o', ç: 'c', ı: 'i', İ: 'I', Ğ: 'G', Ü: 'U', Ş: 'S', Ö: 'O', Ç: 'C' };
      const safe = String(c.name).replace(/[ğüşöçıİĞÜŞÖÇ]/g, (ch) => trm[ch]).replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'arac';
      files.push({ name: `araclar/${String(i + 1).padStart(2, '0')}_${safe}_telemetri.csv`, data: toCSV(tel.header, tel.rows, false) });
    });
  }
  if (events && events.length) {
    both('seri_olaylari', {
      header: ['zaman_s', 'olay', 'arac_1', 'arac_2'],
      rows: events.map((e) => [e.k / 60, e.type === 'overtake' ? 'sollama' : 'temas', e.names[0], e.names[1]]),
    });
  }
  const ozet = {
    baslik: title,
    tekrarModu: mode,
    odak: focusName || null,
    ozet: T.summary,
    turlar: (T.analysis || []).map((l) => ({ tur: l.lap, sureS: l.time, sektorlerS: l.sectors, tamamlandi: l.complete })),
    pitler: (T.pits || []).map((p) => ({ tur: p.lap, kayipS: p.loss, eskiHamur: COMPOUND_IDS[p.compFrom], yeniHamur: COMPOUND_IDS[p.compTo] })),
    karsilastirma: cmp ? { etiket: cmp.trace.label, tur: cmp.trace.kind, turSuresiS: cmp.trace.lapTime ?? null, kaynak: cmp.trace.source || null } : null,
    araclar: cars && cars.length > 1 ? cars.map((c) => ({ ad: c.name, ozet: c.T.summary, sira: c.rep.place || null, sollama: c.rep.overtakes, temas: c.rep.contacts })) : undefined,
    ...meta,
    olusturma: new Date().toISOString(),
  };
  files.push({ name: 'ozet.json', data: JSON.stringify(ozet, null, 2) });
  if (tunerLog && tunerLog.length) {
    files.push({
      name: 'otomatik_ayar_gunlugu.txt',
      data: tunerLog.slice().reverse().map((l) => `${new Date(l.t).toLocaleString('tr-TR')}  ${l.msg}`).join('\r\n'),
    });
  }
  if (brain) {
    files.push({
      name: 'beyin.json',
      data: JSON.stringify({ format: 'rl-race-brain', version: 1, ...brain, params: Array.from(brain.params), vparams: brain.vparams ? Array.from(brain.vparams) : undefined }),
    });
  }
  files.push({ name: 'telemetri_grafikleri.png', data: dataURLtoBytes(panel.toPNG(title)) });
  if (mapCanvas) files.push({ name: 'pist_haritasi.png', data: dataURLtoBytes(mapCanvas.toDataURL('image/png')) });
  if (frameDataURL) files.push({ name: '3b_goruntu.png', data: dataURLtoBytes(frameDataURL) });
  const lines = [
    'RL Yarış Laboratuvarı – replay veri paketi',
    '',
    `${title}`,
    `Süre: ${fmtLap(T.summary.surS)} (${T.summary.sonuc})${focusName ? ` · odak araç: ${focusName}` : ''}`,
    '',
    'telemetri.csv              Odak aracın her simülasyon adımı (1/60 sn) için tüm kanalları. Virgülle ayrılmış, ondalık nokta (Python, R, pandas...).',
    'telemetri_excel_tr.csv     Aynı veri, Türkçe Excel için: noktalı virgül ve ondalık virgül. (Tüm *_excel_tr.csv dosyaları böyledir.)',
    'sektorler.csv              S1/S2/S3, tur ve mini sektör süreleri; renk: mor (en hızlı), yeşil (kendi en iyisi), sarı (daha yavaş).',
  ];
  if (cmp && cmp.delta && cmp.delta.n) lines.push('karsilastirma_delta.csv    5 m aralıklarla odak ve karşılaştırma (hız, gaz, fren, vites) + delta_s (pozitif = odak daha yavaş).');
  if (cars && cars.length > 1) {
    lines.push('araclar_ozet.csv           Çoklu tekrardaki tüm araçların özeti (süre, sıra, en iyi tur/sektörler, sollama, temas…).');
    lines.push('araclar/*.csv              Her aracın tam telemetrisi.');
  }
  if (events && events.length) lines.push('seri_olaylari.csv          Seri tekrarındaki sollama ve temas olayları (karelerden çıkarılmıştır).');
  lines.push(
    'egitim_gecmisi*.csv        Eğitim boyunca her nesil/güncellemenin istatistikleri.',
    'ozet.json                  Tur özeti, turlar, pitler, pist, algoritma, fizik, kurallar ve ödül/ceza ayarları.',
    'otomatik_ayar_gunlugu.txt  Otomatik ayarın denediği, kabul ettiği ve geri aldığı değişiklikler.',
    'beyin.json                 Bu sürüşü yapan sinir ağı (uygulamada "JSON yükle" ile geri yüklenebilir).',
    'telemetri_grafikleri.png   Tüm telemetri grafikleri (sürüş + araç sistemleri, varsa karşılaştırma).',
    'pist_haritasi.png          Sürülen çizgi.',
    '3b_goruntu.png             İndirme anındaki 3B görüntü.',
    '',
    'Kanallar: zaman_s (pit kaybı dahil), zaman_pitsiz_s, mesafe_m (başlangıç çizgisinden, çok turda birikimli), tur, x_m/y_m (konum), rakim_m,',
    'hiz_kmh, gaz_yuzde, fren_yuzde, vites, devir_rpm, direksiyon_komut (yapay zekânın istediği, -1..1), direksiyon_gercek (servo gecikmeli),',
    'yanal_g, boylamsal_g, kayma_yuzde (lastik tutuş sınırının aşılma oranı), kayma_acisi_derece (β: burun ile gidiş yönü farkı),',
    'lastik_hamuru (soft/medium/hard), lastik_sicaklik_c, lastik_asinma_yuzde, yakit_kg, ers_sarj_yuzde (4 MJ batarya), ers_guc_kw (+ kullanım / − şarj),',
    'drs_acik (0/1), durum (0 sürüyor, 1 çarptı, 2 bitirdi, 3 elendi), isin_*_derece_oran (sensör mesafesi / 200 m).',
    '',
    'Bu telemetri.csv dosyası tekrar ekranında "CSV içe aktar…" ile karşılaştırma olarak geri yüklenebilir.',
  );
  files.push({ name: 'OKU_BENI.txt', data: lines.join('\r\n') });
  return makeZip(files);
}
