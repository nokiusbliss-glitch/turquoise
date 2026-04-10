/**
 * sw.js — Turquoise Service Worker v7
 * Network-first for the live app shell so UI/JS updates don't get stuck on
 * stale cached bundles after interface changes.
 */

const CACHE = 'tq-v17';

const CORE = [
  '/',
  '/index.html',
  '/bootstrap.js',
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

const CORE_SET = new Set(CORE);

function shouldUseNetworkFirst(request, url) {
  if (request.mode === 'navigate') return true;
  if (url.origin !== self.location.origin) return true;
  return CORE_SET.has(url.pathname);
}

async function putIfOk(cache, request, response) {
  if (response?.ok) {
    try { await cache.put(request, response.clone()); } catch {}
  }
  return response;
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const fresh = await fetch(request);
    return await putIfOk(cache, request, fresh);
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    if (request.mode === 'navigate') return (await cache.match('/index.html')) || Response.error();
    return new Response('', { status: 504, statusText: 'Offline' });
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const fresh = await fetch(request);
    return await putIfOk(cache, request, fresh);
  } catch {
    if (request.mode === 'navigate') return (await cache.match('/index.html')) || Response.error();
    return new Response('', { status: 504, statusText: 'Offline' });
  }
}

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(async cache => {
      const results = await Promise.allSettled(
        CORE.map(url => {
          const req = new Request(url, { cache: 'reload' });
          return cache.add(req).catch(err => { console.warn('[SW] skip:', url, err.message); });
        })
      );
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
  e.respondWith(shouldUseNetworkFirst(e.request, url) ? networkFirst(e.request) : cacheFirst(e.request));
});
