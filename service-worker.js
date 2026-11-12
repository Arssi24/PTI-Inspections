const CACHE_NAME = 'pti-inspections-v16';
const CORE_ASSETS = [
  './', './index.html', './manifest.json', './css/styles.css',
  './js/app.js', './js/offlineQueue.js', './js/qrcode.min.js', './js/jsQR.min.js',
  './js/supabase.umd.js', './js/supabase-config.js', './js/supabaseClient.js',
  './js/mp4box.all.min.js', './js/mp4-muxer.js', './js/mp4Repair.js', './js/liveRecorder.js',
  './assets/icons/icon-180.png', './assets/icons/icon-192.png', './assets/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  // add() per file so one missing file can never abort the whole install
  event.waitUntil(Promise.allSettled(CORE_ASSETS.map((a) =>
    fetch(a, { cache: 'reload' }).then((res) => (res.ok ? caches.open(CACHE_NAME).then((c) => c.put(a, res)) : null))
  )));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) => Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))))
  );
  self.clients.claim();
});

// Stale-while-revalidate: open instantly from the saved copy, refresh it in the background.
// Cross-origin requests (Supabase API, videos) are left untouched.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req, { ignoreSearch: req.mode === 'navigate' });
    const network = fetch(req, { cache: 'no-cache' })
      .then((res) => {
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      })
      .catch(() => null);
    if (cached) {
      event.waitUntil(network);
      return cached;
    }
    return (await network) || Response.error();
  })());
});
