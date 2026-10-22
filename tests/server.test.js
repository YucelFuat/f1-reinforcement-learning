// Mini sunucu testi (server.js): çapraz köken yalıtım başlıkları, MIME türleri, 304, /api uçları, güvenlik.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server.js', '0'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => reject(new Error('sunucu başlamadı: ' + out)), 10000);
    child.stdout.on('data', (d) => {
      out += d;
      const m = out.match(/http:\/\/localhost:(\d+)\//);
      if (m) {
        clearTimeout(timer);
        resolve({ child, port: +m[1] });
      }
    });
    child.stderr.on('data', (d) => (out += d));
    child.on('exit', (code) => reject(new Error(`sunucu kapandı (${code}): ${out}`)));
  });
}

function request(port, pathname, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

let srv;
before(async () => {
  srv = await startServer();
});
after(() => {
  if (srv) srv.child.kill();
});

const ISOLATION = {
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-embedder-policy': 'require-corp',
  'cross-origin-resource-policy': 'same-origin',
};

test('her yanıtta COOP/COEP/CORP başlıkları (crossOriginIsolated için)', async () => {
  for (const p of ['/', '/src/main.js', '/styles.css', '/api/stats', '/olmayan-dosya.js']) {
    const r = await request(srv.port, p);
    for (const [k, v] of Object.entries(ISOLATION)) assert.equal(r.headers[k], v, `${p}: ${k}`);
  }
});

test('MIME türleri', async () => {
  const want = {
    '/': 'text/html; charset=utf-8',
    '/index.html': 'text/html; charset=utf-8',
    '/src/main.js': 'text/javascript; charset=utf-8',
    '/styles.css': 'text/css; charset=utf-8',
    '/manifest.webmanifest': 'application/manifest+json; charset=utf-8',
    '/icons/icon-192.png': 'image/png',
    '/assets/f1car.glb': 'model/gltf-binary',
    '/vendor/three-LICENSE.txt': 'text/plain; charset=utf-8',
  };
  for (const [p, type] of Object.entries(want)) {
    const r = await request(srv.port, p, { method: 'HEAD' });
    assert.equal(r.status, 200, p);
    assert.equal(r.headers['content-type'], type, p);
    assert.equal(r.headers['cache-control'], 'no-cache', `${p}: geliştirmede eski kod görülmemeli`);
  }
});

test('ETag ile 304; HEAD gövdesiz', async () => {
  const a = await request(srv.port, '/src/config.js');
  assert.equal(a.status, 200);
  assert.ok(a.headers.etag);
  assert.ok(a.body.length > 100);
  const b = await request(srv.port, '/src/config.js', { headers: { 'If-None-Match': a.headers.etag } });
  assert.equal(b.status, 304);
  assert.equal(b.body.length, 0);
  const h = await request(srv.port, '/src/config.js', { method: 'HEAD' });
  assert.equal(h.body.length, 0);
  assert.equal(+h.headers['content-length'], a.body.length);
});

test('/api uçları: stats, health, files', async () => {
  const s = await request(srv.port, '/api/stats');
  assert.equal(s.status, 200);
  assert.equal(s.headers['cache-control'], 'no-store');
  const j = JSON.parse(s.body);
  assert.ok(Array.isArray(j.cpu.cores) && j.mem.total > 0 && j.node);
  const h = JSON.parse((await request(srv.port, '/api/health')).body);
  assert.equal(h.app, 'rl-yaris-lab');
  const f = JSON.parse((await request(srv.port, '/api/files')).body);
  assert.ok(f.files.includes('index.html') && f.files.includes('src/main.js') && f.files.includes('manifest.webmanifest'));
  assert.ok(!f.files.some((x) => x.startsWith('tests/') || x.startsWith('tools/') || x === 'server.js' || x === 'sw.js'), 'test/araç/sunucu dosyaları önbelleğe girmemeli');
});

test('404, yöntem ve klasör dışına çıkma denemeleri', async () => {
  assert.equal((await request(srv.port, '/yok/yok.js')).status, 404);
  assert.equal((await request(srv.port, '/src')).status, 404);
  assert.equal((await request(srv.port, '/index.html', { method: 'POST' })).status, 405);
  for (const p of ['/..%2f..%2f..%2fetc%2fpasswd', '/%2e%2e/%2e%2e/etc/passwd', '/..%5c..%5cserver.js', '/%E0%A4%A']) {
    const r = await request(srv.port, p);
    assert.ok([400, 403, 404].includes(r.status), `${p} → ${r.status}`);
    assert.ok(!r.body.toString().includes('root:'), p);
  }
});
