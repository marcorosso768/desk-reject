/* Offline cache for the app shell. Bump VERSION when any listed file changes. */
const VERSION = "desk-reject-v23";
const SHELL = [
  "./",
  "index.html",
  "manifest.webmanifest",
  "assets/style.css",
  "assets/app.js",
  "assets/presets.js",
  "assets/vendor/qrcode.js",
  "assets/vendor/jspdf.umd.min.js",
  "assets/fonts/pdf/cmu-serif-500-roman.ttf",
  "assets/fonts/pdf/cmu-serif-500-italic.ttf",
  "assets/fonts/pdf/cmu-serif-700-roman.ttf",
  "assets/fonts/pdf/cmu-sans-serif-700-roman.ttf",
  "assets/fonts/pdf/cmu-typewriter-text-500-roman.ttf",
  "assets/icons/icon.svg",
  "assets/icons/icon-192-dark.png",
  "assets/icons/apple-touch-icon-dark.png",
  "assets/fonts/cmu-serif-500-roman.woff2",
  "assets/fonts/cmu-serif-500-italic.woff2",
  "assets/fonts/cmu-serif-700-roman.woff2",
  "assets/fonts/cmu-sans-serif-700-roman.woff2",
  "assets/fonts/cmu-typewriter-text-500-roman.woff2"
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network first, cache as fallback: updates show up on the next load,
// and the board still opens without a connection.
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET" || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
