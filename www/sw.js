/* sw.js — offline cache so the app works as an installed PWA */
const CACHE = 'chess-review-v1';
const ASSETS = [
  './', './index.html', './app.js', './board.js', './native-bridge.js',
  './styles.css', './manifest.webmanifest', './icon.svg',
  './lib/classify.js', './lib/pgn.mjs', './lib/analyze.mjs',
  './vendor/chess.js'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) =>
    Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/api/')) return; // never cache engine calls
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request))
  );
});
