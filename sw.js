// Servis çalışanı (service worker): uygulamayı yüklenebilir yapar ve sunucu kapalıyken de açılmasını sağlar.
//
// Kural: HER ZAMAN ÖNCE AĞ. Sunucu çalışırken her dosya ağdan gelir (geliştirme sırasında eski kod asla
// sunulmaz); önbellek yalnızca ağ yoksa (sunucu kapalı / çevrimdışı) yedek olarak kullanılır.
// /api/ istekleri (CPU/RAM istatistiği vb.) hiç önbelleğe alınmaz ve servis çalışanından geçmez.
//
// Önbellek sürümü: aşağıdaki VERSION değiştiğinde eski önbellekler silinir.

const VERSION = 'v1';
const PREFIX = 'rl-yaris-';
const CACHE = PREFIX + VERSION;

// Sunucu dosya listesi veremezse en azından bunlar önbelleğe alınır
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'styles-infra.css',
  'manifest.webmanifest',
  'src/main.js',
  'src/pwa.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

const scopePath = () => new URL(self.registration.scope).pathname;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      let list = SHELL;
      try {
        // server.js uygulamanın tüm dosyalarını listeler → 3B görünüm dahil her şey çevrimdışı çalışır
        const r = await fetch('api/files', { cache: 'no-store' });
        if (r.ok) {
          const j = await r.json();
          if (Array.isArray(j.files)) list = [...new Set([...SHELL, ...j.files])];
        }
      } catch {
        /* liste yok → yalnızca kabuk */
      }
      await Promise.all(
        list.map(async (u) => {
          try {
            const res = await fetch(u, { cache: 'no-cache' });
            if (res.ok) await cache.put(u, res);
          } catch {
            /* tek dosya hatası kurulumu bozmasın */
          }
        }),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith(PREFIX) && k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const rel = url.pathname.startsWith(scopePath()) ? url.pathname.slice(scopePath().length) : url.pathname;
  if (rel.startsWith('api/')) return; // canlı veri: asla önbellekten değil
  if (req.headers.has('range')) return; // parça istekleri (medya) tarayıcıya kalsın
  event.respondWith(networkFirst(req, event));
});

async function networkFirst(req, event) {
  try {
    const res = await fetch(req);
    if (res.ok && res.type === 'basic') {
      const copy = res.clone();
      event.waitUntil(
        (async () => {
          try {
            const cache = await caches.open(CACHE);
            const old = await cache.match(req, { ignoreSearch: true });
            // aynı sürüm zaten önbellekteyse diske tekrar yazma
            const tag = copy.headers.get('ETag');
            if (old && tag && old.headers.get('ETag') === tag) return;
            await cache.put(req, copy);
          } catch {
            /* depolama dolu vb. → yok say */
          }
        })(),
      );
    }
    return res;
  } catch (err) {
    // ağ yok → önbellek
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    if (req.mode === 'navigate') {
      const shell = (await cache.match('index.html')) || (await cache.match('./'));
      if (shell) return shell;
    }
    return new Response('Çevrimdışı ve bu dosya önbellekte yok: ' + new URL(req.url).pathname, {
      status: 503,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cross-Origin-Resource-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Opener-Policy': 'same-origin',
      },
    });
  }
}
