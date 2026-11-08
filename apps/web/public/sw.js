/**
 * Cafe Code service worker — Web Push + PWA install.
 *
 * Renders push payloads from the server (see apps/server/src/notifications/
 * WebPushNotifications.ts) as system notifications and routes notification
 * clicks back into the app.
 *
 * Payload shape: { title, body, tag, threadPath, icon, badge }
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

// Keep uploaded artwork authenticated and same-origin. Old/malformed payloads
// use the neutral mark rather than flashing the bundled mascot or fetching an
// arbitrary URL. Only the current server can select a private icon's bytes.
function notificationIcon(value, kind) {
  const variant = kind === "icon" ? "app-192" : "badge-96";
  const neutral = `/app-branding/neutral-v1/${variant}.png`;
  const bundled = kind === "icon" ? "/icon-192.png" : "/favicon-32x32.png";
  if (value === neutral || value === bundled) return value;
  const custom =
    /^\/api\/branding\/app-icon\/v1\/sha256-[a-f0-9]{64}\.(?:gif|jpe?g|png|webp)\/(app-192|badge-96)\.png$/;
  return typeof value === "string" && custom.test(value) && value.endsWith(`/${variant}.png`)
    ? value
    : neutral;
}

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }
  if (payload === null || typeof payload !== "object") payload = {};
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
        icon: notificationIcon(payload.icon, "icon"),
        badge: notificationIcon(payload.badge, "badge"),
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
