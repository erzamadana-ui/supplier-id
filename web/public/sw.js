/* Supplier-ID service worker — app shell cache + GET API network-first (cache hanya fallback offline). Aksi tulis (POST/PUT) tidak pernah di-cache atau diulang.
 * v2.1 (inspeksi 8 Okt 2026): sebelumnya stale-while-revalidate → data lama tampil setelah aksi (task baru tidak muncul, "job terakhir" basi)
 * dan respons akun sebelumnya tampil setelah ganti akun di perangkat yang sama (cache dikunci per URL, bukan per token). */
const VERSION = 'sid-v2-4';
const API_CACHE = VERSION + '-api';
const SHELL = ['/supplier-id/', '/supplier-id/index.html', '/supplier-id/manifest.webmanifest', '/supplier-id/icon-192.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION && k !== API_CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
// Halaman memberi tahu saat token berubah (login/logout/ganti akun) → cache API dibuang agar data akun lain tidak pernah tampil.
self.addEventListener('message', (e) => { if (e.data && e.data.type === 'CLEAR_API_CACHE') e.waitUntil(caches.delete(API_CACHE)); });
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return; // mutasi selalu ke jaringan; status final disahkan server
  const url = new URL(req.url);
  if (url.pathname.includes('/api/')) {
    // network-first: jawaban terbaru selalu dipakai; cache hanya dipakai bila jaringan gagal (offline), dan hanya untuk token yang sama
    // (cache dikunci per URL + sidik jari Authorization agar akun lain tidak membaca data akun sebelumnya).
    const auth = req.headers.get('Authorization') || '';
    const key = new Request(req.url + (req.url.includes('?') ? '&' : '?') + '_sw_auth=' + fingerprint(auth));
    e.respondWith(caches.open(API_CACHE).then(async (c) => {
      try {
        const r = await fetch(req);
        if (r.ok) c.put(key, r.clone());
        return r;
      } catch {
        const cached = await c.match(key);
        if (cached) return cached;
        return new Response(JSON.stringify({ error: 'OFFLINE' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
      }
    }));
    return;
  }
  if (url.origin === self.location.origin) {
    // Navigasi/index.html: network-first agar rilis baru langsung terpakai; cache hanya fallback offline. Aset ber-hash: cache-first.
    if (req.mode === 'navigate' || url.pathname.endsWith('/index.html') || url.pathname === '/supplier-id/' || url.pathname === '/supplier-id') {
      // cache:'no-cache' = selalu revalidasi ke server (ETag) agar HTTP cache 10 menit GitHub Pages tidak menahan index lama
      e.respondWith(fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }).then((r) => { if (r.ok) caches.open(VERSION).then((c) => c.put('/supplier-id/index.html', r.clone())); return r; }).catch(() => caches.match('/supplier-id/index.html')));
      return;
    }
    e.respondWith(caches.match(req).then((cached) => cached || fetch(req).then((r) => { if (r.ok && (url.pathname.includes('/assets/') || SHELL.includes(url.pathname))) caches.open(VERSION).then((c) => c.put(req, r.clone())); return r; }).catch(() => (req.mode === 'navigate' ? caches.match('/supplier-id/index.html') : undefined))));
  }
});
/** Sidik jari pendek (bukan rahasia) dari header Authorization: cukup untuk memisahkan cache antar akun; token tidak disimpan. */
function fingerprint(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h.toString(36); }
