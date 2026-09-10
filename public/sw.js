/* WeatherGPT Service Worker — SIH26068
 * Provides offline caching, network fallbacks, and PWA capabilities
 */

const CACHE_NAME = 'weathergpt-v2.1.0';
const STATIC_ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './data/weather_data.js',
  './manifest.webmanifest',
  './icons/app-icon.svg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  // Only intercept GET requests
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // For external APIs, always use network directly
  if (url.origin !== self.location.origin) {
    // Fonts or CDNs can be cached on demand
    if (url.origin.includes('fonts.googleapis.com') || url.origin.includes('fonts.gstatic.com')) {
      event.respondWith(
        caches.match(event.request).then((cached) => {
          if (cached) return cached;
          return fetch(event.request).then((response) => {
            if (!response || response.status !== 200) return response;
            const cloned = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, cloned));
            return response;
          }).catch(() => cached);
        })
      );
    }
    return;
  }

  // Stale-while-revalidate for local static assets
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      const fetchPromise = fetch(event.request).then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const cloned = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, cloned));
        }
        return networkResponse;
      }).catch((err) => {
        // Offline and not in cache
        return cachedResponse;
      });

      return cachedResponse || fetchPromise;
    })
  );
});
