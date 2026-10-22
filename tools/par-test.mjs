// Çok çekirdekli simülasyon (src/parallel) için tarayıcı testi — Playwright + Chromium.
// COOP/COEP başlıklarını gönderen küçük bir statik sunucu açar (crossOriginIsolated → SharedArrayBuffer),
// tools/par-test.html sayfasında şunları çalıştırır:
//   1) aynı tohumla tek çekirdek ↔ 1 ↔ 2 … işçi: araç-adım/sn, hızlanma, nesil geçmişinin birebir aynılığı
//   2) öğrenme ilerliyor mu (tur süresi çıkıyor, bitirme oranı artıyor)
//   3) yarış modu (seri boyu 6) işçilerle çalışıyor mu, seriler bölünmüyor mu
//   4) zorla nesil sonu, duraklatma, canlı ayar, beyin yükleme, yeniden kurma, pist değiştirme, kapatma,
//      bölümleme kenar durumları
//   5) oturumu sürdürme (src/persist.js) → ParallelTrainer: devamı tek çekirdekle birebir aynı mı
//   6) işçi hatasında tek çekirdeğe dönüş
//   7) ES ve CMA-ES için kısa birebir aynılık denetimi
// Konsol hatası olursa test başarısız sayılır. Not: hız ölçümü paylaşımlı/meşgul makinede gürültülüdür.
// Tarayıcıda elle denemek için: node server.js (COOP/COEP başlıklarıyla) → http://localhost:5180/tools/par-test.html
//
// Kullanım: node tools/par-test.mjs [--cars 400] [--gens 20] [--workers 1,2] [--track kidney] [--port 5201] [--headed 1]
//           [--url http://localhost:5180]   (kendi sunucusu yerine çalışan node server.js'yi kullan)
// (Playwright gerekir; uygulamanın kendisi için gerekmez.)
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const cars = +(args.cars || 400);
const gens = +(args.gens || 20);
const workers = (args.workers || '1,2').split(',').map((s) => (s === 'auto' ? 'auto' : +s));
const track = args.track || 'kidney';
const port = +(args.port || process.env.PAR_PORT || 5201);

async function loadPlaywright() {
  const tries = ['playwright', process.env.PLAYWRIGHT_PATH, '/opt/npm-tools/node_modules/playwright/index.mjs'].filter(Boolean);
  for (const t of tries) {
    try {
      return await import(t.startsWith('/') ? pathToFileURL(t).href : t);
    } catch { /* sonrakini dene */ }
  }
  throw new Error('Playwright bulunamadı (PLAYWRIGHT_PATH ile yolunu verebilirsiniz)');
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.css': 'text/css', '.glb': 'model/gltf-binary', '.png': 'image/png' };
function startServer() {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/') p = '/index.html';
    const file = path.normalize(path.join(ROOT, p));
    if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, data) => {
      const h = {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Resource-Policy': 'same-origin',
        'Cache-Control': 'no-cache',
      };
      if (err) { res.writeHead(404, h); res.end('yok'); return; }
      res.writeHead(200, { ...h, 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise((ok, fail) => { server.once('error', fail); server.listen(port, '127.0.0.1', () => ok(server)); });
}

const fails = [];
const check = (cond, msg) => { console.log(`${cond ? '  ✔' : '  ✘'} ${msg}`); if (!cond) fails.push(msg); };
const fmt = (r, base) => `${r.label.padEnd(13)} ${(r.ms / 1000).toFixed(2).padStart(6)} sn  ${String(r.ticks).padStart(6)} adım  ${(r.carSteps / 1e6).toFixed(2)} M araç-adım/sn` +
  (base ? `  ×${(r.carSteps / base.carSteps).toFixed(2)}` : '') + `  bitirme %${(r.finFirst * 100).toFixed(0)}→%${(r.finLast * 100).toFixed(0)}` +
  `  en iyi tur ${r.bestLap ? r.bestLap.toFixed(2) + ' sn' : '–'}` + (r.loads ? `  doluluk ${r.loads.map((l) => (l * 100).toFixed(0) + '%').join('/')}` : '') +
  (r.same !== undefined ? `  aynı: ${r.same === true ? 'evet' : r.same}` : '');

const parts = (sl) => `işçi başına araç ${JSON.stringify(sl.map((w) => w.reduce((a, c) => a + c[1], 0)))} (${sl.map((w) => w.length).join('+')} parça)`;

// --url verilirse çalışan bir sunucu kullanılır (ör. node server.js → --url http://localhost:5180)
const server = args.url ? null : await startServer();
const base = (args.url || `http://127.0.0.1:${port}`).replace(/\/$/, '');
const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ headless: args.headed !== '1' });
const page = await browser.newPage();
const errors = [];
let expectFallbackWarn = false;
page.on('console', (m) => {
  if (m.type() !== 'error' && m.type() !== 'warning') return;
  if (expectFallbackWarn && m.type() === 'warning' && m.text().includes('Tek çekirdekli simülasyona dönülüyor')) return; // beklenen
  errors.push(`[${m.type()}] ${m.text()}`);
});
page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
try {
  await page.goto(`${base}/tools/par-test.html`);
  await page.waitForFunction(() => window.parTest, null, { timeout: 30000 });
  const env = await page.evaluate(() => ({ iso: crossOriginIsolated, hc: navigator.hardwareConcurrency, ua: navigator.userAgent }));
  console.log(`crossOriginIsolated=${env.iso} · çekirdek=${env.hc} · ${env.ua.match(/Chrom\S+/)?.[0]}`);
  check(env.iso, 'sayfa crossOriginIsolated (COOP/COEP)');

  console.log(`\n1) Hız + birebir aynılık: GA · ${cars} araç · ${track} · ${gens} nesil`);
  const b = await page.evaluate((o) => window.parTest.bench(o), { track, cars, gens, workers, algo: 'ga', seed: 1 });
  console.log('   ' + fmt(b.single));
  for (const r of b.par) console.log('   ' + fmt(r, b.single) + `  ${parts(r.slices)}`);
  for (const r of b.par) check(r.same === true, `${r.label}: nesil geçmişi tek çekirdekle birebir aynı`);
  for (const r of b.par) check(r.slicesOk, `${r.label}: parçalar tüm araçları tam bir kez kapsıyor`);
  // Not: çekirdekten çok iş parçacığı varsa (ör. 2 çekirdekte 2 işçi + ana) işletim sistemi ana iş parçacığını
  // arada bekletebilir; bu yüzden en uzun değer bilgi amaçlı, ölçüt ortanca ve %99.
  for (const r of b.par) {
    const p = r.pump;
    check(p.med < 0.5 && p.p99 < 3, `${r.label}: pump() engellemiyor (${p.n} çağrı: ortanca ${p.med.toFixed(3)} ms, %99 ${p.p99.toFixed(2)} ms, en uzun ${p.max.toFixed(2)} ms)`);
  }

  console.log('\n2) Öğrenme ilerliyor mu (paralel koşu)');
  const lp = b.par.at(-1);
  check(lp.bestLap != null, `tur süresi çıktı (${lp.bestLap ? lp.bestLap.toFixed(2) + ' sn' : '–'})`);
  check(lp.finLast > lp.finFirst, `bitirme oranı arttı (%${(lp.finFirst * 100).toFixed(1)} → %${(lp.finLast * 100).toFixed(1)})`);
  check(lp.hist.at(-1).best > lp.hist[0].best, `en iyi ödül arttı (${lp.hist[0].best.toFixed(0)} → ${lp.hist.at(-1).best.toFixed(0)})`);
  check(lp.ghostLen > 0, 'hayalet izi (0 numaralı araç) toplandı');
  check(lp.sectors.every((s) => s > 0), 'sektör en iyileri toplandı');

  console.log('\n3) Yarış modu (seri 6) işçilerle');
  const rc = await page.evaluate((o) => window.parTest.raceTest(o), { track, cars, gens: 6, workers: Math.max(2, ...workers.filter((w) => w !== 'auto')) });
  console.log('   ' + fmt(rc) + `  ${parts(rc.slices)}`);
  check(rc.slicesOk, 'parçalar seri (6) sınırlarında, seriler işçiler arasında bölünmüyor');
  check(rc.hist.length >= 6 && rc.hist.every((g) => g.contacts !== undefined), 'yarış nesilleri tamamlandı, temas/sollama sayıldı');
  check(rc.contacts > 0, `araçlar arası temas oldu (${rc.contacts})`);

  const badPlans = await page.evaluate(() => window.parTest.planTest());
  check(!badPlans.length, 'bölümleme kenar durumları (N × seri boyu × işçi)' + (badPlans.length ? ': ' + JSON.stringify(badPlans.slice(0, 3)) : ''));

  console.log('\n4) Çalışma zamanı işlemleri');
  const ops = await page.evaluate((o) => window.parTest.opsTest(o), { track, cars: 200, workers: 2 });
  for (const [k, v] of Object.entries(ops)) check(v === true, k);

  console.log('\n5) Oturumu sürdürme (persist.js) → ParallelTrainer');
  const rs = await page.evaluate(() => window.parTest.resumeTest({}));
  if (rs.skipped) console.log('   atlandı: ' + rs.skipped);
  else {
    check(rs.restored === true, 'kayıt ParallelTrainer\'a yüklendi');
    check(rs.same === true, `devam eden nesiller tek çekirdekli kesintisiz eğitimle birebir aynı${rs.same === true ? '' : ' (' + rs.same + ')'}`);
    check(rs.resync === true, 'dışarıdan algo.setState → işçiler yeni politikalarla nesli baştan sürdü');
  }

  console.log('\n6) İşçi hatası → tek çekirdeğe dönüş');
  expectFallbackWarn = true;
  const fb = await page.evaluate(() => window.parTest.fallbackTest({}));
  expectFallbackWarn = false;
  for (const [k, v] of Object.entries(fb)) check(v === true, k);

  console.log('\n7) ES ve CMA-ES (kısa koşu: yalnızca birebir aynılık; hız anlamlı değil — işçiler JIT ısınmasında)');
  for (const algo of ['es', 'cmaes']) {
    const r = await page.evaluate((o) => window.parTest.bench(o), { track, cars: 120, gens: 5, workers: [2], algo, seed: 7 });
    console.log('   ' + algo.padEnd(6) + fmt(r.par[0], r.single));
    check(r.par[0].same === true, `${algo}: tek çekirdekle birebir aynı`);
  }
} catch (e) {
  fails.push('istisna: ' + e.message);
  console.error(e);
} finally {
  console.log('\nKonsol hata/uyarıları: ' + (errors.length ? '\n  ' + errors.join('\n  ') : 'yok'));
  if (errors.length) fails.push('konsol hataları');
  await browser.close();
  if (server) server.close();
}
console.log(fails.length ? `\nBAŞARISIZ (${fails.length}): ${fails.join(' · ')}` : '\nTüm denetimler geçti.');
process.exit(fails.length ? 1 : 0);
