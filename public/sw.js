/**
 * sw.js — Turquoise Service Worker
 *
 * Strategy: Cache-first for all app assets.
 * After first load, app works completely without server.
 * Signaling may fail (expected) — UI still loads.
 *
 * Cache versioned by date — bump CACHE_VER when deploying new code.
 *
 * Murphy's Law: if fetch fails, we serve from cache.
 *               If cache misses too, we serve the offline shell.
 */

const CACHE_VER  = 'tq-v8';
const SHELL = [
  '/',
  '/index.html',
  '/main.js',
  '/identity.js',
  '/messages.js',
  '/webrtc.js',
  '/files.js',
  '/app.js',
  '/manifest.json',
];

// ── Install: pre-cache shell ───────────────────────────────────────────────────
self.addEventListener('install', ev => {
  ev.waitUntil(
    caches.open(CACHE_VER)
      .then(cache => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(e => console.error('[SW] Install failed:', e))
  );
});

// ── Activate: delete old caches ───────────────────────────────────────────────
self.addEventListener('activate', ev => {
  ev.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_VER).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ── Fetch: cache-first for shell, network-first for API/WS ───────────────────
self.addEventListener('fetch', ev => {
  const url = new URL(ev.request.url);

  // WebSocket and cross-origin: pass through (never intercept)
  if (url.protocol === 'wss:' || url.protocol === 'ws:') return;
  if (url.origin !== self.location.origin)                return;

  // All same-origin requests: try cache first, fall back to network
  ev.respondWith(
    caches.match(ev.request).then(cached => {
      if (cached) return cached;
      return fetch(ev.request).then(response => {
        // Cache successful responses
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_VER).then(c => c.put(ev.request, clone));
        }
        return response;
      }).catch(() => {
        // Network failed, cache missed — serve index.html for navigation
        if (ev.request.mode === 'navigate') {
          return caches.match('/index.html');
        }
        return new Response('offline', { status: 503 });
      });
    })
  );
});
