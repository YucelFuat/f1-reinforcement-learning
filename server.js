// Bağımlılıksız mini sunucu: uygulamayı yayınlar ve geliştirici paneline gerçek sistem CPU/RAM verisi sağlar.
// Çalıştır:  node server.js            (isteğe bağlı port: node server.js 8080  veya  --port=8080)
//            node server.js --app      (sunucu açılınca uygulamayı kendi penceresinde aç: Edge/Chrome uygulama modu)
//
// Her yanıta COOP/COEP/CORP başlıkları eklenir → sayfa "crossOriginIsolated" olur ve SharedArrayBuffer
// (çok çekirdekli eğitim) kullanılabilir. Tüm dosyalar yerel olduğu için bu başlıklar hiçbir şeyi engellemez.

import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn, execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const APP_ID = 'rl-yaris-lab';

// ---------- komut satırı ----------
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name) => {
  const a = argv.find((x) => x.startsWith(`--${name}=`));
  if (a) return a.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
};
const positionalPort = argv.find((x) => /^\d+$/.test(x));
let port = Number(opt('port') || positionalPort || process.env.PORT || 5180);
const APP_MODE = flag('app');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

// Her yanıtta: çapraz köken yalıtımı (SharedArrayBuffer için) + içerik türü koklamayı kapat
const BASE_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Content-Type-Options': 'nosniff',
};

function send(res, status, headers, body) {
  res.writeHead(status, { ...BASE_HEADERS, ...headers });
  res.end(body);
}

// ---------- CPU örnekleme (her saniye) ----------
let prev = os.cpus().map((c) => ({ ...c.times }));
let cpuStats = { total: 0, cores: os.cpus().map(() => 0) };
setInterval(() => {
  const cur = os.cpus().map((c) => ({ ...c.times }));
  const cores = cur.map((t, i) => {
    const p = prev[i] || t;
    const idle = t.idle - p.idle;
    const total = t.user + t.nice + t.sys + t.irq + t.idle - (p.user + p.nice + p.sys + p.irq + p.idle);
    return total > 0 ? Math.max(0, Math.min(100, (1 - idle / total) * 100)) : 0;
  });
  prev = cur;
  cpuStats = { total: cores.reduce((a, b) => a + b, 0) / (cores.length || 1), cores };
}, 1000).unref();

// ---------- çevrimdışı önbellek listesi (servis çalışanı kurulurken ister) ----------
const SKIP_DIRS = new Set(['.git', 'node_modules', 'tests', 'tools', '.vscode', '.idea']);
const SKIP_FILES = new Set(['server.js', 'sw.js', 'package.json', 'package-lock.json', 'Baslat.cmd', 'Baslat.ps1']);
const CACHE_EXT = new Set(['.html', '.js', '.mjs', '.css', '.json', '.webmanifest', '.png', '.jpg', '.jpeg', '.webp', '.svg', '.ico', '.glb', '.gltf', '.wasm', '.woff2', '.woff', '.txt']);
function listAppFiles() {
  const out = [];
  let newest = 0;
  const walk = (dir, rel) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name.startsWith('.')) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(abs, r);
      } else if (e.isFile() && !(rel === '' && SKIP_FILES.has(e.name)) && CACHE_EXT.has(path.extname(e.name).toLowerCase())) {
        out.push(r.split('/').map(encodeURIComponent).join('/'));
        try { newest = Math.max(newest, fs.statSync(abs).mtimeMs); } catch { /* yok say */ }
      }
    }
  };
  walk(ROOT, '');
  return { version: Math.round(newest), files: out.sort() };
}

// ---------- istekler ----------
const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { return send(res, 400, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Geçersiz istek'); }

  if (url.pathname === '/api/stats') {
    const body = JSON.stringify({
      cpu: cpuStats,
      cpuModel: (os.cpus()[0]?.model || '').trim(),
      mem: { total: os.totalmem(), free: os.freemem() },
      platform: `${os.platform()} ${os.release()}`,
      node: process.version,
      uptime: os.uptime(),
    });
    return send(res, 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, body);
  }
  if (url.pathname === '/api/health') {
    return send(res, 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, JSON.stringify({ app: APP_ID, node: process.version }));
  }
  if (url.pathname === '/api/files') {
    return send(res, 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, JSON.stringify(listAppFiles()));
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' }, 'İzin verilmeyen yöntem');
  }

  let p;
  try { p = decodeURIComponent(url.pathname); } catch { return send(res, 400, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Geçersiz adres'); }
  if (p === '/' || p.endsWith('/')) p += 'index.html';
  const file = path.normalize(path.join(ROOT, p));
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
    return send(res, 403, { 'Content-Type': 'text/plain; charset=utf-8' }, 'Yasak');
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      return send(res, 404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }, 'Bulunamadı: ' + p);
    }
    // no-cache: tarayıcı her seferinde sunucuya sorar (geliştirmede eski kod görülmez); değişmediyse 304 ile hızlı döner
    const etag = `W/"${st.size.toString(16)}-${Math.round(st.mtimeMs).toString(16)}"`;
    const headers = {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      ETag: etag,
    };
    if (req.headers['if-none-match'] === etag) return send(res, 304, headers);
    headers['Content-Length'] = st.size;
    if (req.method === 'HEAD') return send(res, 200, headers);
    res.writeHead(200, { ...BASE_HEADERS, ...headers });
    fs.createReadStream(file)
      .on('error', () => res.destroy())
      .pipe(res);
  });
});

// ---------- uygulama penceresini aç ----------
function regAppPath(exe) {
  for (const hive of ['HKCU', 'HKLM']) {
    try {
      const out = execFileSync('reg', ['query', `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`, '/ve'], {
        encoding: 'utf8', windowsHide: true, timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
      });
      const m = out.match(/REG_(?:EXPAND_)?SZ\s+(.+)/);
      if (m) {
        const p = m[1].trim().replace(/^"|"$/g, '').replace(/%([^%]+)%/g, (_, v) => process.env[v] || '');
        if (fs.existsSync(p)) return p;
      }
    } catch { /* kayıt yok */ }
  }
  return null;
}

function findWindowsBrowser(exe, rel) {
  const bases = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
  for (const b of bases) {
    const p = path.join(b, rel);
    if (fs.existsSync(p)) return p;
  }
  return regAppPath(exe);
}

function launch(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let done = false;
    try {
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false, ...opts });
      child.once('error', () => { if (!done) { done = true; resolve(false); } });
      child.once('spawn', () => { if (!done) { done = true; child.unref(); resolve(true); } });
    } catch {
      resolve(false);
    }
  });
}

async function openAppWindow(url) {
  const plat = process.platform;
  if (plat === 'win32') {
    const edge = findWindowsBrowser('msedge.exe', 'Microsoft\\Edge\\Application\\msedge.exe');
    if (edge && (await launch(edge, [`--app=${url}`]))) return 'Microsoft Edge (uygulama modu)';
    const chrome = findWindowsBrowser('chrome.exe', 'Google\\Chrome\\Application\\chrome.exe');
    if (chrome && (await launch(chrome, [`--app=${url}`]))) return 'Google Chrome (uygulama modu)';
    // varsayılan tarayıcı
    if (await launch('cmd', ['/c', 'start', '""', `"${url}"`], { windowsVerbatimArguments: true, windowsHide: true })) return 'varsayılan tarayıcı';
    return null;
  }
  if (plat === 'darwin') return (await launch('open', [url])) ? 'varsayılan tarayıcı' : null;
  return (await launch('xdg-open', [url])) ? 'varsayılan tarayıcı' : null;
}

async function openAndReport(url) {
  const how = await openAppWindow(url);
  if (how) console.log(`  Uygulama penceresi açılıyor (${how}).\n`);
  else console.log(`  Pencere otomatik açılamadı. Tarayıcıda şu adresi aç:  ${url}\n`);
}

// Aynı portta bu uygulamanın başka bir kopyası çalışıyor mu?
function probeExisting(p) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: p, path: '/api/health', timeout: 800 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try { resolve(JSON.parse(body).app === APP_ID); } catch { resolve(false); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

server.on('error', async (e) => {
  if (e.code === 'EADDRINUSE') {
    if (APP_MODE && (await probeExisting(port))) {
      const url = `http://localhost:${port}/`;
      console.log(`\n  RL Yarış Laboratuvarı zaten çalışıyor: ${url}`);
      await openAndReport(url);
      process.exit(0);
    }
    console.log(`Port ${port} dolu, ${port + 1} deneniyor…`);
    port++;
    setTimeout(() => server.listen(port), 100);
  } else {
    throw e;
  }
});

server.listen(port, () => {
  const actual = server.address().port;
  const url = `http://localhost:${actual}/`;
  console.log('\n  RL Yarış Laboratuvarı çalışıyor:');
  console.log(`  →  ${url}\n`);
  console.log(APP_MODE ? '  Bu pencereyi kapatmak veya Ctrl+C uygulamayı durdurur.\n' : '  Durdurmak için Ctrl+C\n');
  if (APP_MODE) openAndReport(url);
});
