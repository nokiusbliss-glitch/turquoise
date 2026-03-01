/**
 * sw.js — Turquoise Service Worker
 * Caches all app assets after first load.
 * After that: zero interaction with Render for page loads.
 * Render is only ever contacted for the WebSocket signaling handshake.
 */

const CACHE_NAME = 'tq-v2';

const CORE_ASSETS = [
  '/',
  '/index.html',
  '/main.js',
  '/app.js',
  '/webrtc.js',
  '/identity.js',
  '/messages.js',
  '/files.js',
  '/manifest.json',
];

// Install: cache all core assets immediately
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(CORE_ASSETS))
      .then(() => self.skipWaiting())
      .catch(err => console.warn('[SW] install cache failed:', err))
  );
});

// Activate: delete old caches
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch: cache-first for our own assets, network-then-cache for fonts
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;

  const url = new URL(e.request.url);

  // WebSocket upgrade — never intercept
  if (e.request.headers.get('upgrade') === 'websocket') return;

  // Cross-origin (Google Fonts): network first, cache fallback
  if (url.origin !== self.location.origin) {
    e.respondWith(
      caches.open(CACHE_NAME).then(cache =>
        fetch(e.request)
          .then(r => { if (r && r.ok) cache.put(e.request, r.clone()); return r; })
          .catch(() => cache.match(e.request))
      )
    );
    return;
  }

  // Own assets: cache first, network fallback
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(r => {
        if (r && r.ok) {
          caches.open(CACHE_NAME).then(c => c.put(e.request, r.clone()));
        }
        return r;
      }).catch(() => {
        // Offline and not cached — return blank for navigation
        if (e.request.mode === 'navigate') {
          return caches.match('/index.html');
        }
      });
    })
  );
});
