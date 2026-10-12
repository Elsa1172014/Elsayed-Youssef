// App-shell cache only. Never caches video/stream requests.
const CACHE = "gsr-shell-v1";
const SHELL = ["./", "index.html", "styles.css", "app.js", "manifest.webmanifest", "icons/icon.svg", "data/short-drama-providers.json", "data/short-dramas-own.json"];
self.addEventListener("install", e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL))));
self.addEventListener("activate", e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))));
self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin) return;
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
