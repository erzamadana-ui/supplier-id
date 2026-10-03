/* Supplier-ID service worker — app shell cache + GET API stale-while-revalidate. Aksi tulis (POST/PUT) tidak pernah di-cache atau diulang. */
const VERSION = 'sid-v2-2';
const SHELL = ['/supplier-id/', '/supplier-id/index.html', '/supplier-id/manifest.webmanifest', '/supplier-id/icon-192.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return; // mutasi selalu ke jaringan; status final disahkan server
  const url = new URL(req.url);
  if (url.pathname.includes('/api/')) {
    // stale-while-revalidate hanya untuk GET data; respons offline berasal dari cache terakhir
    e.respondWith(caches.open(VERSION + '-api').then(async (c) => {
      const cached = await c.match(req);
      const net = fetch(req).then((r) => { if (r.ok) c.put(req, r.clone()); return r; }).catch(() => cached);
      return cached ? (net.catch(() => cached), cached) : net;
    }));
    return;
  }
  if (url.origin === self.location.origin) {
    // Navigasi/index.html: network-first agar rilis baru langsung terpakai; cache hanya fallback offline. Aset ber-hash: cache-first.
    if (req.mode === 'navigate' || url.pathname.endsWith('/index.html') || url.pathname === '/supplier-id/' || url.pathname === '/supplier-id') {
      e.respondWith(fetch(req).then((r) => { if (r.ok) caches.open(VERSION).then((c) => c.put('/supplier-id/index.html', r.clone())); return r; }).catch(() => caches.match('/supplier-id/index.html')));
      return;
    }
    e.respondWith(caches.match(req).then((cached) => cached || fetch(req).then((r) => { if (r.ok && (url.pathname.includes('/assets/') || SHELL.includes(url.pathname))) caches.open(VERSION).then((c) => c.put(req, r.clone())); return r; }).catch(() => (req.mode === 'navigate' ? caches.match('/supplier-id/index.html') : undefined))));
  }
});
