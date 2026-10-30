/* Cache only public, immutable build assets. Auth, HTML, API, WebSocket,
   terminal output and all workspace content always go to the network. */
const CACHE = "agent-workspace-static-v1";
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});
self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  const immutableAsset = /^\/assets\/[a-zA-Z0-9_-]+\.(js|css|woff2?)$/.test(
    url.pathname,
  );
  const icon = /^\/icons\/workspace-(192|512)\.png$/.test(url.pathname);
  if (
    request.method !== "GET" ||
    url.origin !== self.location.origin ||
    url.search ||
    (!immutableAsset && !icon)
  )
    return;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok && response.type === "basic")
        await cache.put(request, response.clone());
      return response;
    }),
  );
});
