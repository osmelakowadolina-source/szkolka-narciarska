// Service worker — cache app-shellu + modułów Firebase, żeby aplikacja
// otwierała się także bez zasięgu. Dane Firestore idą przez SDK (własny cache
// offline włączony w index.html), a nie przez ten plik.
const CACHE_NAME = "szkolka-shell-v3";
const SHELL_FILES = [
  "./index.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-192.png",
  "./icon-maskable-512.png"
];
// Cross-origin zasoby statyczne, które trzeba mieć offline (SDK Firebase, czcionki).
const STATIC_CDN = ["www.gstatic.com", "fonts.gstatic.com", "fonts.googleapis.com"];

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

function putIfOk(request, response) {
  // nie zapamiętujemy błędów (404/500) ani odpowiedzi częściowych
  if (response && response.ok && response.status === 200) {
    const copy = response.clone();
    caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
  }
  return response;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;               // cache.put nie obsługuje POST
  const url = new URL(req.url);

  // SDK Firebase i czcionki: wersjonowane, więc cache-first (+ odświeżenie w tle dla CSS czcionek)
  if (STATIC_CDN.includes(url.hostname)) {
    event.respondWith(
      caches.match(req).then((hit) => {
        const net = fetch(req).then((r) => putIfOk(req, r)).catch(() => hit);
        return hit || net;
      })
    );
    return;
  }

  // Pozostałe zewnętrzne API (Firestore, Auth, Open-Meteo) — zawsze przez sieć.
  if (url.origin !== self.location.origin) return;

  // Pliki aplikacji: network-first z pominięciem HTTP-cache przeglądarki
  // (GitHub Pages trzyma pliki ok. 10 min), fallback do cache offline.
  event.respondWith(
    fetch(req, { cache: "no-cache" })
      .then((r) => putIfOk(req, r))
      .catch(() => caches.match(req).then((r) => r || caches.match("./index.html")))
  );
});
