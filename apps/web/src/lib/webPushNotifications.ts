/**
 * Web Push client plumbing for the per-device notifications toggle.
 *
 * Pairs with apps/web/public/sw.js (renders pushes) and the server routes in
 * apps/server/src/http.ts (stores subscriptions, sends on turn completion).
 */

export type WebPushSupport =
  | { readonly supported: true }
  | {
      readonly supported: false;
      readonly reason:
        | "insecure-context"
        | "no-service-worker"
        | "no-push-manager"
        | "no-notifications";
    };

export function getWebPushSupport(): WebPushSupport {
  if (typeof window === "undefined" || !window.isSecureContext) {
    return { supported: false, reason: "insecure-context" };
  }
  if (!("serviceWorker" in navigator)) {
    return { supported: false, reason: "no-service-worker" };
  }
  if (!("PushManager" in window)) {
    return { supported: false, reason: "no-push-manager" };
  }
  if (!("Notification" in window)) {
    return { supported: false, reason: "no-notifications" };
  }
  return { supported: true };
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i += 1) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

async function ensureServiceWorkerRegistration(): Promise<ServiceWorkerRegistration> {
  const registration = await navigator.serviceWorker.register("/sw.js", {
    updateViaCache: "none",
  });
  await navigator.serviceWorker.ready;
  return registration;
}

/**
 * Request permission, register the service worker, subscribe to push, and
 * store the subscription server-side. Throws with a user-presentable message
 * on any failure so the settings toggle can surface it and revert.
 */
export async function enableWebPushNotifications(): Promise<void> {
  const support = getWebPushSupport();
  if (!support.supported) {
    throw new Error(describeUnsupported(support.reason));
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error(
      permission === "denied"
        ? "Notification permission was denied. Allow notifications for this site in your browser settings, then try again."
        : "Notification permission was not granted.",
    );
  }

  const keyResponse = await fetch("/api/notifications/web-push/public-key");
  if (!keyResponse.ok) {
    throw new Error("The server could not provide a push key.");
  }
  const { publicKey } = (await keyResponse.json()) as { publicKey: string };

  const registration = await ensureServiceWorkerRegistration();
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey).buffer as ArrayBuffer,
  });

  const storeResponse = await fetch("/api/notifications/web-push/subscriptions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      subscription: subscription.toJSON(),
      label: navigator.userAgent.slice(0, 120),
    }),
  });
  if (!storeResponse.ok) {
    await subscription.unsubscribe().catch(() => {});
    throw new Error("The server rejected the push subscription.");
  }
}

/** Unsubscribe locally and remove the subscription server-side. */
export async function disableWebPushNotifications(): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  const registration = await navigator.serviceWorker.getRegistration("/sw.js");
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return;

  await fetch("/api/notifications/web-push/unsubscribe", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpoint: subscription.endpoint }),
  }).catch(() => {});
  await subscription.unsubscribe().catch(() => {});
}

function describeUnsupported(
  reason: Exclude<WebPushSupport, { supported: true }>["reason"],
): string {
  switch (reason) {
    case "insecure-context":
      return "Push notifications require HTTPS. Connect to the server over HTTPS to enable them on this device.";
    case "no-service-worker":
    case "no-push-manager":
    case "no-notifications":
      return "This browser does not support push notifications. On iOS, add the app to your home screen first.";
  }
}
