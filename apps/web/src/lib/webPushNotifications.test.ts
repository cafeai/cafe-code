import { afterEach, describe, expect, it, vi } from "vitest";
import { setUiLocale } from "@cafecode/shared/i18n";
import { installWebPushLocaleSynchronization } from "./webPushNotifications.ts";

afterEach(() => {
  setUiLocale("en");
  vi.unstubAllGlobals();
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
