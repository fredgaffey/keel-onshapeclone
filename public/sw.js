// Keel's service worker: the app shell and SolidCraft's files are cached so Keel opens offline.
// The API is never cached; documents are kept on the device by the pages themselves (local.js).
const SHELL = 'keel-shell-v3';
const CAD = 'keel-cad-v2';
const SHELL_FILES = ['/', '/doc', '/css/keel.css', '/js/api.js', '/js/home.js', '/js/editor.js', '/js/local.js', '/js/merge.js', '/js/flexblade.js', '/js/scripts-panel.js', '/js/scripts/index.js', '/js/scripts/airfoil.js', '/js/scripts/propeller.js', '/img/keel.svg', '/manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== CAD).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  if (e.request.mode === 'navigate') {
    const page = /^\/d\//.test(url.pathname) ? '/doc' : url.pathname.startsWith('/cad/') ? null : '/';
    e.respondWith(networkFirst(e.request, SHELL, page));
    return;
  }
  // SolidCraft's WebAssembly (32 MB compressed) is left to the browser's HTTP cache, which keeps
  // it compressed and serves it offline (it's immutable for a year). Piping it through this
  // worker's Cache API copy aborted the download when two loads overlapped.
  if (url.pathname.endsWith('_bg.wasm')) return;
  if (url.pathname.startsWith('/cad/')) {
    // File names carry content hashes, except a few fixed ones (index.html, sw.js, build.json).
    const hashed = /-[0-9a-f]{16}[._]/.test(url.pathname) || url.pathname.includes('/fonts/') || url.pathname.includes('/icons/');
    e.respondWith(hashed ? cacheFirst(e.request, CAD) : networkFirst(e.request, CAD));
    return;
  }
  e.respondWith(networkFirst(e.request, SHELL));
});

async function networkFirst(request, cacheName, fallbackPath = null) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(request);
    if (res.ok) cache.put(fallbackPath && request.mode === 'navigate' ? fallbackPath : request, res.clone());
    return res;
  } catch (err) {
    const hit = (await cache.match(request, { ignoreSearch: true })) || (fallbackPath && (await cache.match(fallbackPath)));
    if (hit) return hit;
    throw err;
  }
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) cache.put(request, res.clone());
  return res;
}
