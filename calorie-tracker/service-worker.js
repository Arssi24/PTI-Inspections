const CACHE_NAME = 'calorie-tracker-v1';

// Keep this in sync with actual files in the project — a stale entry here
// breaks install and leaves phones stuck on old cached JS/CSS.
const PRECACHE_URLS = [
  'index.html',
  'onboarding.html',
  'dashboard.html',
  'manifest.json',
  'css/style.css',
  'js/calculations.js',
  'js/storage.js',
  'js/onboarding.js',
  'js/dashboard.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
