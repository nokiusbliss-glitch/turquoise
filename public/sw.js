/**
 * sw.js — Turquoise service worker
 * Stable offline shell + safe runtime caching.
 */

const CACHE_NAME = 'tq-v3';

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

function isStaticAsset(pathname) {
  return /\.(js|css|png|svg|ico|woff2|json|webmanifest)$/i.test(pathname);
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(CORE_ASSETS);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  if (url.origin !== self.location.origin) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      try {
        const net = await fetch(req);
        if (net && (net.ok || net.type === 'opaque')) {
          cache.put(req, net.clone()).catch(() => {});
        }
        return net;
      } catch {
        const cached = await cache.match(req);
        return cached || Response.error();
      }
    })());
    return;
  }

  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      try {
        const net = await fetch(req);
        if (net && net.ok) cache.put('/index.html', net.clone()).catch(() => {});
        return net;
      } catch {
        const cached = await cache.match('/index.html');
        return cached || Response.error();
      }
    })());
    return;
  }

  if (isStaticAsset(url.pathname)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(req);

      const networkPromise = fetch(req)
        .then((net) => {
          if (net && net.ok) cache.put(req, net.clone()).catch(() => {});
          return net;
        })
        .catch(() => null);

      return cached || (await networkPromise) || Response.error();
    })());
    return;
  }
});
