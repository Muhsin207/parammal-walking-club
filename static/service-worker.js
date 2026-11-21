const CACHE_NAME = "parammal-walking-club-shell-v1";
const APP_SHELL = [
  "/",
  "/static/manifest.webmanifest",
  "/static/pwa-icon-192.png",
  "/static/pwa-icon-512.png",
  "/static/pwa-icon-180.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key.startsWith("parammal-walking-club-shell-") && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || request.mode !== "navigate") return;

  event.respondWith(
    fetch(request).then((response) => {
      if (response.ok) {
        const copy = response.clone();
        event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put("/", copy)));
      }
      return response;
    }).catch(async () => {
      const cachedPage = await caches.match("/");
      if (cachedPage) return cachedPage;
      throw new Error("The app shell is not available offline.");
    })
  );
});