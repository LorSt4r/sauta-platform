const CACHE_NAME = 'sauta-pwa-v1';
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/src/main.ts',
  '/src/style.css',
  'https://fonts.googleapis.com/css2?family=Outfit:wght@300;500;700&display=swap'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((name) => {
          if (name !== CACHE_NAME) {
            return caches.delete(name);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Strategia Stale-while-revalidate per velocità estrema
self.addEventListener('fetch', (event) => {
  // Ignora le richieste API e WebSocket dal caching
  if (event.request.url.includes('/api/') || event.request.url.startsWith('ws')) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      const fetchPromise = fetch(event.request).then((networkResponse) => {
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, networkResponse.clone());
        });
        return networkResponse;
      }).catch(() => {
        // Se la rete fallisce e non c'è in cache, ritorna index (Offline)
        return caches.match('/');
      });

      return cachedResponse || fetchPromise;
    })
  );
});
