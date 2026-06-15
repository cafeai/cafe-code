/**
 * Cafe Code service worker — Web Push + PWA install.
 *
 * Renders push payloads from the server (see apps/server/src/notifications/
 * WebPushNotifications.ts) as system notifications and routes notification
 * clicks back into the app.
 *
 * Payload shape: { title, body, tag, threadPath }
 */

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// Navigation-only pass-through. Cafe is not offline-capable, so we leave API and
// asset requests alone, but navigation handling gives browsers a real fetch
// event path for PWA installability while preserving network-first semantics.
self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return;
  event.respondWith(fetch(event.request));
});

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }
  const title = typeof payload.title === "string" && payload.title ? payload.title : "Cafe Code";
  const body = typeof payload.body === "string" ? payload.body : "";
  const tag = typeof payload.tag === "string" && payload.tag ? payload.tag : "cafe-code";
  const threadPath = typeof payload.threadPath === "string" ? payload.threadPath : "/";

  event.waitUntil(
    (async () => {
      // Skip the system notification when the user is already looking at the
      // thread in a focused window — the in-app UI covers that case.
      const windowClients = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      const focusedOnThread = windowClients.some((client) => {
        if (!client.focused) return false;
        try {
          return new URL(client.url).pathname === threadPath;
        } catch {
          return false;
        }
      });
      if (focusedOnThread) return;

      await self.registration.showNotification(title, {
        body,
        tag,
        data: { threadPath },
        icon: "/apple-touch-icon.png",
        badge: "/favicon-32x32.png",
      });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const threadPath =
    event.notification.data && typeof event.notification.data.threadPath === "string"
      ? event.notification.data.threadPath
      : "/";

  event.waitUntil(
    (async () => {
      const windowClients = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const client of windowClients) {
        if ("focus" in client) {
          await client.focus();
          if ("navigate" in client) {
            try {
              await client.navigate(threadPath);
            } catch {
              // Navigation can be refused (cross-origin redirects, detached
              // clients); focusing the app is still the right outcome.
            }
          }
          return;
        }
      }
      await self.clients.openWindow(threadPath);
    })(),
  );
});
