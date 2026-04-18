/**
 * sw.js — Turquoise Service Worker v7
 * Cache-first for app shell, network-first for cross-origin.
 * Graceful partial install: a failing asset doesn't abort the install.
 */

const CACHE = 'tq-v15';  // bumped: forces old tq-v14 cache to be evicted on next visit

const CORE = [
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
  '/tqlog.js',
  '/tools-registry.js',
  '/tools-modules.js',
  '/manifest.json',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(async cache => {
      const results = await Promise.allSettled(CORE.map(url => cache.add(url).catch(err => { console.warn('[SW] skip:', url, err.message); })));
      const failed  = results.filter(r => r.status==='rejected').length;
      if (failed) console.warn(`[SW] ${failed} asset(s) not cached — partial install`);
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (e.request.headers.get('upgrade')==='websocket') return;

  // Cross-origin: network-first
  if (url.origin !== self.location.origin) {
    e.respondWith(
      caches.open(CACHE).then(cache =>
        fetch(e.request).then(r=>{if(r?.ok)cache.put(e.request,r.clone());return r;}).catch(()=>cache.match(e.request))
      )
    );
    return;
  }

  // Same-origin: cache-first, network fallback, SPA fallback for navigation
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request)
        .then(r => { if(r?.ok) caches.open(CACHE).then(c=>c.put(e.request,r.clone())); return r; })
        .catch(() => {
          if (e.request.mode==='navigate') return caches.match('/index.html');
          return new Response('', {status:504,statusText:'Offline'});
        });
    })
  );
});
