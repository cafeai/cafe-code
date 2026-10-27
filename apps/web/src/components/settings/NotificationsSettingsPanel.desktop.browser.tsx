import "../../index.css";
import { useSyncExternalStore } from "react";
import { page } from "vitest/browser";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ownNotificationFixture } from "../notificationFixture.test.fixture";

const fixture = vi.hoisted(() => ({
  settings: { notificationsEnabled: false, userInputNotificationsEnabled: false },
  listeners: new Set<() => void>(),
  update: vi.fn(),
  enable: vi.fn(),
  disable: vi.fn(),
  show: vi.fn(),
}));
vi.mock("../../env", () => ({ isElectron: true }));
vi.mock("../../hooks/useSettings", () => ({
  useSettings: () =>
    useSyncExternalStore(
      (listener) => {
        fixture.listeners.add(listener);
        return () => fixture.listeners.delete(listener);
      },
      () => fixture.settings,
    ),
  useUpdateSettings: () => ({ updateSettings: fixture.update }),
  useClientSettingsHydrated: () => true,
}));
vi.mock("../../lib/webPushNotifications", () => ({
  enableWebPushNotifications: fixture.enable,
  disableWebPushNotifications: fixture.disable,
  getWebPushSupport: () => ({ supported: false, reason: "insecure-context" }),
}));

import { NotificationsSettingsPanel } from "./NotificationsSettingsPanel";

let owner: ReturnType<typeof ownNotificationFixture>;
beforeEach((context) => {
  owner = ownNotificationFixture(context);
  fixture.settings = { notificationsEnabled: false, userInputNotificationsEnabled: false };
  fixture.listeners.clear();
  fixture.enable.mockReset();
  fixture.disable.mockReset();
  fixture.show.mockReset().mockResolvedValue("sent");
  fixture.update.mockReset().mockImplementation((patch) => {
    fixture.settings = { ...fixture.settings, ...patch };
    for (const listener of fixture.listeners) listener();
  });
  vi.stubGlobal("desktopBridge", { showNotification: fixture.show });
});
afterEach(async () => {
  await owner.cleanup();
  expect(fixture.listeners.size).toBe(0);
  vi.unstubAllGlobals();
});

it("enables each desktop category only after native acceptance, without browser registration", async () => {
  await owner.mount(<NotificationsSettingsPanel />);
  for (const name of ["Enable user input notifications", "Enable chat completion notifications"]) {
    await owner.run(() => page.getByRole("switch", { name }).click());
    await expect.element(page.getByRole("switch", { name })).toBeChecked();
  }
  expect(fixture.settings).toEqual({
    notificationsEnabled: true,
    userInputNotificationsEnabled: true,
  });
  expect(fixture.show).toHaveBeenCalledTimes(2);
  expect(fixture.show).toHaveBeenLastCalledWith({
    title: "Cafe Code",
    body: "Test notification from Cafe Code.",
    tag: "cafe-code-notification-test",
  });
  expect(fixture.enable).not.toHaveBeenCalled();
  expect(fixture.disable).not.toHaveBeenCalled();
});

it("tests native delivery without enabling either notification category", async () => {
  await owner.mount(<NotificationsSettingsPanel />);
  await owner.run(() => page.getByRole("button", { name: "Send test notification" }).click());
  await expect
    .element(
      page.getByText(
        "Notification sent. If no banner appears, check notification settings and Focus or Do Not Disturb.",
      ),
    )
    .toBeVisible();
  expect(fixture.show).toHaveBeenCalledOnce();
  expect(fixture.update).not.toHaveBeenCalled();
});

it.each(["failed", "unsupported", "throw"])(
  "reports %s without persisting a failed opt-in or exposing raw errors",
  async (result) => {
    if (result === "throw")
      fixture.show.mockRejectedValueOnce(new Error("opaque native path/secret"));
    else fixture.show.mockResolvedValueOnce(result);
    await owner.mount(<NotificationsSettingsPanel />);
    await owner.run(() =>
      page.getByRole("switch", { name: "Enable user input notifications" }).click(),
    );
    await expect
      .element(
        page.getByText(
          result === "unsupported"
            ? "This desktop build cannot send notifications."
            : "Could not send a notification. Allow Cafe Code in system notification settings, then try again. macOS requires a signed app.",
        ),
      )
      .toBeVisible();
    await expect
      .element(page.getByRole("switch", { name: "Enable user input notifications" }))
      .not.toBeChecked();
    expect(fixture.update).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("opaque native path/secret");
  },
);

it("keeps opt-out available without invoking native delivery", async () => {
  fixture.settings = { notificationsEnabled: true, userInputNotificationsEnabled: false };
  await owner.mount(<NotificationsSettingsPanel />);
  await owner.run(() =>
    page.getByRole("switch", { name: "Enable chat completion notifications" }).click(),
  );
  await expect
    .element(page.getByRole("switch", { name: "Enable chat completion notifications" }))
    .not.toBeChecked();
  expect(fixture.update).toHaveBeenCalledExactlyOnceWith({ notificationsEnabled: false });
  expect(fixture.show).not.toHaveBeenCalled();
});

it("does not persist a delayed setup result after its settings page unmounts", async () => {
  let resolve!: (result: "sent" | "cancelled") => void;
  const result = new Promise<"sent" | "cancelled">((complete) => {
    resolve = complete;
  });
  owner.onRetire(() => resolve("cancelled"));
  fixture.show.mockReturnValueOnce(result);
  const mounted = await owner.mount(<NotificationsSettingsPanel />);
  await owner.run(() =>
    page.getByRole("switch", { name: "Enable user input notifications" }).click(),
  );
  expect(fixture.show).toHaveBeenCalledOnce();
  expect(fixture.update).not.toHaveBeenCalled();
  await mounted.unmount();
  resolve("sent");
  await result;
  expect(fixture.update).not.toHaveBeenCalled();
});
