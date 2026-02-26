const CACHE = "turquoise-v1";
const ASSETS = [
  "/",
  "/index.html",
  "/style.css",
  "/app.js",
  "/state.js",
  "/ui.js",
  "/manifest.json"
];

self.addEventListener("install", e => {
  e.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(ASSETS))
  );
});

self.addEventListener("fetch", e => {
  e.respondWith(
    caches.match(e.request).then(resp => resp || fetch(e.request))
  );
});