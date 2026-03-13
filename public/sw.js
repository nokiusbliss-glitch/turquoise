/**
 * sw.js — Turquoise Service Worker v6
 * Cache-first for app shell, network-first for cross-origin assets.
 *
 * Changes v5→v6:
 *   - Added tqlog.js to CORE_ASSETS (new module required at boot)
 *   - Graceful partial install preserved from v5
 */

const CACHE_NAME = 'tq-v6';

const CORE_ASSETS = [
  '/',
  '/index.html',
  '/main.js',
  '/app.js',
  '/webrtc.js',
  '/identity.js',
  '/messages.js',
  '/files.js',
  '/folder.js',
  '/tqapps.js',
  '/tqlog.js',          // new
  '/tools-registry.js',
  '/tools-modules.js',
  '/manifest.json',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      const results = await Promise.allSettled(
        CORE_ASSETS.map(url =>
          cache.add(url).catch(err => {
            console.warn('[SW] failed to cache', url, err.message);
          })
        )
      );
      const failed = results.filter(r => r.status === 'rejected').length;
      if (failed) console.warn(`[SW] ${failed} asset(s) not cached — partial install`);
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;

  const url = new URL(e.request.url);

  if (e.request.headers.get('upgrade') === 'websocket') return;

  // Cross-origin: network-first, cache fallback
  if (url.origin !== self.location.origin) {
    e.respondWith(
      caches.open(CACHE_NAME).then(cache =>
        fetch(e.request)
          .then(r => {
            if (r && r.ok) cache.put(e.request, r.clone());
            return r;
          })
          .catch(() => cache.match(e.request))
      )
    );
    return;
  }

  // Same-origin: cache-first, then network, fallback to index.html for navigation
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request)
        .then(r => {
          if (r && r.ok) {
            caches.open(CACHE_NAME).then(c => c.put(e.request, r.clone()));
          }
          return r;
        })
        .catch(() => {
          if (e.request.mode === 'navigate') return caches.match('/index.html');
          return new Response('', { status: 504, statusText: 'Offline' });
        });
    })
  );
});
