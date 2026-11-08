import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { webAppIconUrl } from "@cafecode/shared/webAppBranding";

type PushEvent = { data: { json: () => unknown }; waitUntil: (work: Promise<void>) => void };
const source = await readFile(new URL("../public/sw.js", import.meta.url), "utf8");

function fixture(focused = false) {
  const listeners = new Map<string, (event: PushEvent) => void>();
  const showNotification = vi.fn(async (_title: string, _options: unknown) => {});
  const fetch = vi.fn();
  runInNewContext(source, {
    URL,
    fetch,
    self: {
      addEventListener: (name: string, listener: (event: PushEvent) => void) =>
        listeners.set(name, listener),
      registration: { showNotification },
      clients: {
        matchAll: async () =>
          focused ? [{ focused: true, url: "https://cafe.invalid/env/thread" }] : [],
      },
    },
  });
  return {
    showNotification,
    fetch,
    push: async (payload: unknown) => {
      let pending: Promise<void> | undefined;
      listeners.get("push")!({
        data: { json: () => payload },
        waitUntil: (work) => {
          pending = work;
        },
      });
      expect(pending).toBeDefined();
      await pending;
    },
  };
}

describe("push notification artwork", () => {
  it("uses the exact custom icon and badge selected by the delivering server", async () => {
    const worker = fixture();
    const branding = `custom:sha256-${"a".repeat(64)}.webp` as const;
    const icon = webAppIconUrl(branding, "app-192");
    const badge = webAppIconUrl(branding, "badge-96");
    await worker.push({
      title: "Synthetic thread",
      body: "Finished running",
      tag: "thread",
      threadPath: "/env/thread",
      icon,
      badge,
    });
    expect(worker.showNotification).toHaveBeenCalledExactlyOnceWith("Synthetic thread", {
      body: "Finished running",
      tag: "thread",
      data: { threadPath: "/env/thread" },
      icon,
      badge,
    });
    expect(worker.fetch).not.toHaveBeenCalled();
  });

  it("uses neutral artwork for older payloads and refuses arbitrary image fetches", async () => {
    const worker = fixture();
    for (const payload of [
      {},
      null,
      { icon: "https://foreign.invalid/image.png", badge: "//foreign.invalid/badge.png" },
      { icon: "/api/branding/app-icon/v1/../../secret", badge: "/favicon-32x32.png?token=secret" },
    ]) {
      await worker.push(payload);
      expect(worker.showNotification).toHaveBeenLastCalledWith(
        "Cafe Code",
        expect.objectContaining({
          icon: webAppIconUrl("neutral", "app-192"),
          badge: webAppIconUrl("neutral", "badge-96"),
        }),
      );
    }
    expect(worker.fetch).not.toHaveBeenCalled();
  });

  it("still suppresses a system notification when its thread is focused", async () => {
    const worker = fixture(true);
    await worker.push({
      threadPath: "/env/thread",
      icon: webAppIconUrl("default", "app-192"),
      badge: webAppIconUrl("default", "badge-96"),
    });
    expect(worker.showNotification).not.toHaveBeenCalled();
  });
});
