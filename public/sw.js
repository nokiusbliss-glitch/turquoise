/**
 * sw.js — Turquoise v8
 *
 * Strategy:
 *   HTML  → cache-first (app shell loads offline)
 *   JS/JSON → network-first (always get fresh code, fall back to cache)
 *
 * This ensures code updates deploy immediately while keeping
 * offline UI capability for the shell.
 */

const CACHE = 'tq-v8';
const SHELL = ['/index.html', '/'];

self.addEventListener('install', ev => {
  ev.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', ev => {
  ev.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', ev => {
  const url = new URL(ev.request.url);

  // Never intercept WebSocket or cross-origin
  if (url.protocol === 'wss:' || url.protocol === 'ws:') return;
  if (url.origin !== self.location.origin) return;

  const ext = url.pathname.split('.').pop();

  // JS and JSON: network-first so code updates load immediately
  if (ext === 'js' || ext === 'json') {
    ev.respondWith(
      fetch(ev.request)
        .then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then(c => c.put(ev.request, clone));
          }
          return res;
        })
        .catch(() => caches.match(ev.request))
    );
    return;
  }

  // HTML and everything else: cache-first (offline shell)
  ev.respondWith(
    caches.match(ev.request).then(cached => {
      if (cached) return cached;
      return fetch(ev.request).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(ev.request, clone));
        }
        return res;
      }).catch(() => caches.match('/index.html'));
    })
  );
});
