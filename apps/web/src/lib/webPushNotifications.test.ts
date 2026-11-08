import { afterEach, describe, expect, it, vi } from "vitest";
import { setUiLocale } from "@cafecode/shared/i18n";
import {
  enableWebPushNotifications,
  installWebPushLocaleSynchronization,
} from "./webPushNotifications.ts";

afterEach(() => {
  setUiLocale("en");
  vi.unstubAllGlobals();
});

describe("Web Push notification preferences", () => {
  function prepareSubscription(existing: boolean, accepted = true) {
    const subscription = {
      endpoint: "https://push.example/preferences",
      toJSON: () => ({
        endpoint: "https://push.example/preferences",
        keys: { auth: "opaque-auth", p256dh: "opaque-key" },
      }),
      unsubscribe: vi.fn(async () => true),
    };
    const registration = {
      pushManager: {
        getSubscription: vi.fn(async () => (existing ? subscription : null)),
        subscribe: vi.fn(async () => subscription),
      },
    };
    const notification = { requestPermission: vi.fn(async () => "granted") };
    vi.stubGlobal("Notification", notification);
    vi.stubGlobal("window", {
      isSecureContext: true,
      PushManager: class {},
      Notification: notification,
      atob: globalThis.atob,
    });
    vi.stubGlobal("navigator", {
      userAgent: "Synthetic notification fixture",
      serviceWorker: {
        register: vi.fn(async () => registration),
        ready: Promise.resolve(registration),
      },
    });
    const fetch = vi.fn(async (url: string, _init?: RequestInit) =>
      url.endsWith("public-key")
        ? { ok: true, json: async () => ({ publicKey: "AQID" }) }
        : { ok: accepted },
    );
    vi.stubGlobal("fetch", fetch);
    return { subscription, fetch };
  }

  it("registers an input-only subscription with explicit per-category choices", async () => {
    const { subscription, fetch } = prepareSubscription(false);
    await enableWebPushNotifications({ notifyOnCompletion: false, notifyOnUserInput: true });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]?.[0]).toBe("/api/notifications/web-push/subscriptions");
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body)).subscription).toEqual({
      ...subscription.toJSON(),
      uiLocale: "en",
      notifyOnCompletion: false,
      notifyOnUserInput: true,
    });
    expect(subscription.unsubscribe).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "retires only a new subscription after refused registration (existing=%s)",
    async (existing) => {
      const { subscription } = prepareSubscription(existing, false);
      await expect(
        enableWebPushNotifications({ notifyOnCompletion: true, notifyOnUserInput: true }),
      ).rejects.toThrow("The server rejected the push subscription.");
      expect(subscription.unsubscribe).toHaveBeenCalledTimes(existing ? 0 : 1);
    },
  );
});
describe("existing-subscription locale synchronization", () => {
  it("refreshes only presentation, serializes changes and removes its listener", async () => {
    const subscription = {
      toJSON: vi.fn(() => ({
        endpoint: "https://push.example/one",
        keys: { auth: "opaque", p256dh: "key" },
      })),
    };
    const getSubscription = vi.fn(async () => subscription);
    const getRegistration = vi.fn(async () => ({ pushManager: { getSubscription } }));
    const fetch = vi.fn(async (_input: string, _init: RequestInit) => ({ ok: true }));
    vi.stubGlobal("navigator", { serviceWorker: { getRegistration } });
    vi.stubGlobal("fetch", fetch);
    setUiLocale("ja");
    const cleanup = installWebPushLocaleSynchronization();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(fetch.mock.calls[0]![0]).toBe("/api/notifications/web-push/subscriptions/locale");
    expect(JSON.parse(String(fetch.mock.calls[0]![1]!.body))).toEqual({
      subscription: { ...subscription.toJSON(), uiLocale: "ja" },
    });
    setUiLocale("ko");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String(fetch.mock.calls[1]![1]!.body)).subscription.uiLocale).toBe("ko");
    expect(getRegistration).toHaveBeenCalledWith("/sw.js");
    cleanup();
    setUiLocale("en");
    await Promise.resolve();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("does not create a missing worker/subscription or send after disposal", async () => {
    const getRegistration = vi.fn(async () => undefined);
    const fetch = vi.fn();
    vi.stubGlobal("navigator", { serviceWorker: { getRegistration } });
    vi.stubGlobal("fetch", fetch);
    const cleanup = installWebPushLocaleSynchronization();
    await vi.waitFor(() => expect(getRegistration).toHaveBeenCalledOnce());
    expect(fetch).not.toHaveBeenCalled();
    cleanup();
    const cancelled = installWebPushLocaleSynchronization();
    cancelled();
    await Promise.resolve();
    expect(getRegistration).toHaveBeenCalledOnce();
  });
});
