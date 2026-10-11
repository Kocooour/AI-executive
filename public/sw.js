const CACHE = "ai-executive-shell-v11";
const SHELL = ["/offline", "/manifest.webmanifest", "/icons/lumi-icon-v3-192.png", "/icons/lumi-icon-v3-512.png", "/icons/lumi-icon-v3-maskable-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith("ai-executive-") && key !== CACHE)
            .map((key) => caches.delete(key)),
        ),
      ),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request, { cache: "no-store" })
        .catch(async () => (await caches.match("/offline")) || Response.error()),
    );
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ||
          fetch(request).then((response) => {
            if (response.ok && url.pathname.startsWith("/_next/static/")) {
              const copy = response.clone();
              caches.open(CACHE).then((cache) => cache.put(request, copy));
            }
            return response;
          }),
      ),
    );
  }
});

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { body: event.data?.text() || "A task needs your attention." };
  }
  const badgeCount = Number.isInteger(payload.appBadge) && payload.appBadge > 0
    ? Math.min(999, payload.appBadge)
    : 0;
  const badgePromise = typeof self.navigator.setAppBadge === "function"
    ? badgeCount > 0
      ? self.navigator.setAppBadge(badgeCount)
      : typeof self.navigator.clearAppBadge === "function"
        ? self.navigator.clearAppBadge()
        : self.navigator.setAppBadge(0)
    : Promise.resolve();
  event.waitUntil(
    Promise.all([badgePromise, self.registration.showNotification(payload.title || "Lumi", {
      body: payload.body || "A task needs your attention.",
      icon: "/icons/lumi-icon-v3-192.png",
      badge: "/icons/lumi-icon-v3-192.png",
      tag: payload.tag || "ai-executive-reminder",
      requireInteraction: Boolean(payload.requireInteraction),
      data: { url: payload.url || "/?view=Today" },
    })]),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) {
          if ("navigate" in client) client.navigate(target);
          return client.focus();
        }
      }
      return self.clients.openWindow ? self.clients.openWindow(target) : undefined;
    }),
  );
});
