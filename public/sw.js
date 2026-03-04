/**
 * sw.js — Turquoise Service Worker
 * Cache-first for app shell, network-first for cross-origin fonts/assets.
 */

const CACHE_NAME = 'tq-v4';

const CORE_ASSETS = [
  '/',
  '/index.html',
  '/main.js',
  '/app.js',
  '/webrtc.js',
  '/identity.js',
  '/messages.js',
  '/files.js',
  '/tools-registry.js',
  '/tools-modules.js',
  '/manifest.json',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(CORE_ASSETS))
      .then(() => self.skipWaiting())
      .catch(err => console.warn('[SW] install cache failed:', err))
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;

  const url = new URL(e.request.url);

  if (e.request.headers.get('upgrade') === 'websocket') return;

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

  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request)
        .then(r => {
          if (r && r.ok) caches.open(CACHE_NAME).then(c => c.put(e.request, r.clone()));
          return r;
        })
        .catch(() => {
          if (e.request.mode === 'navigate') return caches.match('/index.html');
          return new Response('', { status: 504 });
        });
    })
  );
});
