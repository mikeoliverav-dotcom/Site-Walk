/* Site Walk service worker: caches the whole app so it opens with no signal.
   To ship an update, change VERSION; phones pick it up the next time they open the app online. */
const VERSION = 'sitewalk-2.4.0';
const ASSETS = [
  './', './index.html', './app.js', './manifest.webmanifest',
  './vendor/pdf.min.js', './vendor/pdf.worker.min.js', './vendor/jspdf.umd.min.js', './vendor/pdf-lib.min.js',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png', './icons/apple-touch-icon.png'
];
/* Some hosts (Cloudflare Pages) redirect /index.html to /. Browsers refuse to open a page from a
   cached redirect, so every file is stored as a clean, non-redirected copy. */
const clean = r => r.redirected ? r.blob().then(b => new Response(b, { status: r.status, statusText: r.statusText, headers: r.headers })) : r;
self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => Promise.all(ASSETS.map(a =>
    fetch(a, { cache: 'reload' }).then(r => { if (!r.ok) throw new Error(a + ' ' + r.status); return clean(r); }).then(r => c.put(a, r))
  ))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
/* Cache-first for everything: a weak signal on site never stalls the app. */
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  /* Never touch the host's own pages, such as the Cloudflare Access sign-in (/cdn-cgi/…) */
  if (url.pathname.includes('/cdn-cgi/')) return;
  /* Sync requests always go to the server */
  if (url.pathname.startsWith(new URL(self.registration.scope).pathname + 'api/')) return;
  /* "?signin=…" skips the cache so a sign-in page (team access) can show, then loads the app fresh */
  if (req.mode === 'navigate' && url.searchParams.has('signin')) return;
  /* Only the app's own page opens from the cache; any other page goes to the network */
  const scope = new URL(self.registration.scope).pathname;
  if (req.mode === 'navigate' && url.pathname !== scope && url.pathname !== scope + 'index.html') return;
  if (req.mode === 'navigate') {
    e.respondWith(caches.match('./', { cacheName: VERSION }).then(hit => hit || caches.match('./index.html')).then(hit => hit ? clean(hit) : fetch(req)));
    return;
  }
  e.respondWith(caches.match(req, { ignoreSearch: true }).then(hit => hit || fetch(req)));
});
