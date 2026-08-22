// Prosty service worker — cache app-shellu, żeby apka instalowała się jak natywna
// i otwierała nawet przy słabym zasięgu. Dane (Firebase) zawsze idą przez sieć.
const CACHE_NAME = "szkolka-shell-v2";
const SHELL_FILES = [
  "./index.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // Nie cache'uj żądań do Firebase / zewnętrznych API — zawsze świeże dane.
  if (url.origin !== self.location.origin) return;

  // Network-first dla plików aplikacji, żeby zawsze widzieć najnowszą wersję,
  // z fallbackiem do cache przy braku sieci.
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request).then((r) => r || caches.match("./index.html")))
  );
});
