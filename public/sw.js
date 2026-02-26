/**
 * sw.js — Turquoise Service Worker
 *
 * Caches all static assets on first install.
 * Serves from cache first (offline-first strategy).
 * On update, new version activates immediately.
 *
 * Result: App loads instantly from cache.
 *         Works fully offline after first load.
 *         No internet required for UI.
 */

const CACHE = 'turquoise-v2';

const ASSETS = [
  './',
  './index.html',
  './main.js',
  './app.js',
  './network.js',
  './files.js',
  './identity.js',
  './messages.js',
  './bridge.js',
  './manifest.json',
];

// ── Install: cache all assets ────────────────────────────────────────────────

self.addEventListener('install', (ev) => {
  ev.waitUntil(
    caches.open(CACHE).then(cache => {
      return cache.addAll(ASSETS).catch(err => {
        console.warn('[SW] Some assets failed to cache (non-fatal):', err);
      });
    }).then(() => self.skipWaiting()) // activate immediately
  );
});

// ── Activate: clean old caches ────────────────────────────────────────────────

self.addEventListener('activate', (ev) => {
  ev.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE).map(k => caches.delete(k))
    )).then(() => self.clients.claim()) // take control of all pages
  );
});

// ── Fetch: cache-first, then network ─────────────────────────────────────────

self.addEventListener('fetch', (ev) => {
  // Only handle same-origin GET requests for static assets
  const url = new URL(ev.request.url);
  if (ev.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;
  // Don't cache WebSocket upgrades
  if (ev.request.headers.get('upgrade') === 'websocket') return;

  ev.respondWith(
    caches.match(ev.request).then(cached => {
      if (cached) return cached;

      return fetch(ev.request).then(response => {
        // Cache successful HTML/JS/CSS responses
        if (
          response.ok &&
          (ev.request.url.endsWith('.js')   ||
           ev.request.url.endsWith('.html') ||
           ev.request.url.endsWith('.css')  ||
           ev.request.url.endsWith('.json'))
        ) {
          const clone = response.clone();
          caches.open(CACHE).then(cache => cache.put(ev.request, clone));
        }
        return response;
      }).catch(() => {
        // Offline and not cached — return offline page
        if (ev.request.destination === 'document') {
          return caches.match('./index.html');
        }
      });
    })
  );
});
