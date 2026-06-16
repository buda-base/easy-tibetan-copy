/* Easy Tibetan Copy — service worker.
   Caches the two heavy assets — the Pyodide runtime (jsdelivr, immutable, pinned
   by version in its URL) and the current pdf-cmap-fix wheel — so repeat visits
   are fast and work offline. App files (html/js/css) are always served from the
   network so updates ship immediately.

   The wheel cache name is keyed by the wheel's *content hash* (stamped at deploy
   time, see deploy-pages.yml). When the bundled wheel changes, the cache name
   changes too: the new worker activates and evicts the stale wheel on `activate`.
   This is what makes a redeployed fix actually reach returning visitors — the
   previous worker cached `/wheels/` cache-first under a fixed name and never
   revalidated, so a corrected wheel served under the same filename could never
   replace the broken one already in a user's cache. */

const RUNTIME = 'etc-pyodide-runtime';
const WHEEL = 'etc-wheel-__WHEEL_HASH__';
const KEEP = new Set([RUNTIME, WHEEL]);

// On localhost the wheel hash isn't stamped (that happens in CI), so the cache
// key never changes between local rebuilds. Use network-first there: always
// fetch fresh, fall back to cache only when offline. Prod stays cache-first.
const DEV =
  self.location.hostname === 'localhost' ||
  self.location.hostname === '127.0.0.1' ||
  self.location.hostname === '[::1]';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (e) =>
  e.waitUntil(
    (async () => {
      // Drop every cache that isn't current — including the legacy
      // `etc-pyodide-v1` that pinned the old wheel for existing users.
      const names = await caches.keys();
      await Promise.all(names.map((n) => (KEEP.has(n) ? null : caches.delete(n))));
      await self.clients.claim();
    })()
  )
);

self.addEventListener('fetch', (e) => {
  const url = e.request.url;
  const isRuntime = url.includes('cdn.jsdelivr.net/pyodide/');
  const isWheel = url.includes('/wheels/');
  if (!isRuntime && !isWheel) return; // default network handling for everything else
  const name = isRuntime ? RUNTIME : WHEEL;
  e.respondWith(
    caches.open(name).then(async (cache) => {
      const store = (res) => {
        // Cache successful and opaque (cross-origin CDN) responses alike.
        if (res && (res.ok || res.type === 'opaque')) cache.put(e.request, res.clone());
        return res;
      };
      if (DEV) {
        // Network-first: a locally rebuilt wheel shows up on reload; cache is
        // only a fallback when the network is unavailable.
        try {
          return store(await fetch(e.request));
        } catch (_) {
          return (await cache.match(e.request)) || Response.error();
        }
      }
      // Prod: cache-first (instant, offline-capable; key is the wheel hash).
      const hit = await cache.match(e.request);
      return hit || store(await fetch(e.request));
    })
  );
});
