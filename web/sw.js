/* Offline cache. Bump CACHE with every release so old assets are dropped. */
const CACHE = 'staves-web-v2';
const ASSETS = ['./', 'index.html', 'style.css', 'app.js', 'worker.js', 'manifest.webmanifest', 'assets/icon.svg', 'assets/engine.js',
  'assets/abcjs-basic-min.js', 'assets/First-light.mid', 'assets/ABCJS-LICENSE.md'];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith('staves-web-') && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  const base = new URL('./', self.location.href), allowed = new Set(ASSETS.map(path => new URL(path, base).href));
  if (!allowed.has(url.href)) return;
  // Stale-while-revalidate: answer from the cache at once, and refresh the cached copy in the
  // background, so a new deployment reaches returning visitors on their next visit even offline-first.
  event.respondWith(caches.open(CACHE).then(async cache => {
    const cached = await cache.match(event.request);
    const refresh = fetch(event.request, {cache: 'no-cache'})
      .then(response => { if (response.ok) return cache.put(event.request, response.clone()).then(() => response); return response; });
    if (!cached) return refresh;
    event.waitUntil(refresh.catch(() => {}));
    return cached;
  }));
});
