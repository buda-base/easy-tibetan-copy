/* Easy Tibetan Copy — service worker.
   Caches the heavy, immutable assets (the Pyodide runtime from jsdelivr and the
   pdf-cmap-fix wheel) so repeat visits are fast and work offline after the first
   load. App files (html/js/css) are left to the normal network so updates ship. */

const CACHE = 'etc-pyodide-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const url = e.request.url;
  const cacheable = url.includes('cdn.jsdelivr.net/pyodide/') || url.includes('/wheels/');
  if (!cacheable) return; // default network handling for everything else
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(e.request);
      if (hit) return hit;
      const res = await fetch(e.request);
      // Cache successful and opaque (cross-origin CDN) responses alike.
      if (res && (res.ok || res.type === 'opaque')) cache.put(e.request, res.clone());
      return res;
    })
  );
});
