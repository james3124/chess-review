/* sw.js — offline support for the app shell.
 *
 * Network-first for our own files: a rebuilt app must be picked up
 * immediately, otherwise a stale bundle keeps being served from the
 * Cache API (which is exactly how the previous bug survived a reinstall).
 * The cache is only a fallback for when the device is offline.
 *
 * Cross-origin requests (chess.com) are never intercepted or cached.
 */
const CACHE = 'chess-review-v2';
const SHELL = [
  './', './index.html', './app.js', './board.js', './native-bridge.js',
  './chesscom.mjs', './chesscom-bridge.js', './styles.css',
  './manifest.webmanifest', './icon.svg',
  './lib/classify.js', './lib/pgn.mjs', './lib/analyze.mjs',
  './vendor/chess.js'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.pathname.startsWith('/api/')) return;       // engine: never cache
  if (url.origin !== self.location.origin) return;     // chess.com: never cache

  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() =>
        caches.match(e.request, { ignoreSearch: true }).then(
          (hit) => hit || caches.match('./index.html')
        )
      )
  );
});
