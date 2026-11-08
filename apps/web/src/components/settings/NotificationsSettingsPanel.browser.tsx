import "../../index.css";
import { useSyncExternalStore } from "react";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const fixture = vi.hoisted(() => ({
  settings: { notificationsEnabled: false, userInputNotificationsEnabled: false },
  listeners: new Set<() => void>(),
  enable: vi.fn(),
  disable: vi.fn(),
  update: vi.fn(),
}));

vi.mock("../../env", () => ({ isElectron: false }));
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
  getWebPushSupport: () => ({ supported: true }),
}));

import { NotificationsSettingsPanel } from "./NotificationsSettingsPanel";

let mounted: Awaited<ReturnType<typeof render>> | undefined;
beforeEach(() => {
  fixture.settings = { notificationsEnabled: false, userInputNotificationsEnabled: false };
  fixture.listeners.clear();
  fixture.enable.mockReset().mockResolvedValue(undefined);
  fixture.disable.mockReset().mockResolvedValue(undefined);
  fixture.update.mockReset().mockImplementation((patch) => {
    fixture.settings = { ...fixture.settings, ...patch };
    for (const listener of fixture.listeners) listener();
  });
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  expect(fixture.listeners.size).toBe(0);
});

describe("notification preferences", () => {
  it("keeps input and completion independent while retaining push until both are disabled", async () => {
    fixture.settings = { notificationsEnabled: false, userInputNotificationsEnabled: true };
    mounted = await render(<NotificationsSettingsPanel />);
    const completion = page.getByRole("switch", { name: "Enable chat completion notifications" });
    const input = page.getByRole("switch", { name: "Enable user input notifications" });
    await expect.element(input).toBeChecked();
    await expect.element(completion).not.toBeChecked();
    expect(fixture.disable).not.toHaveBeenCalled();

    await completion.click();
    await expect.element(completion).toBeChecked();
    expect(fixture.enable).toHaveBeenLastCalledWith({
      notifyOnCompletion: true,
      notifyOnUserInput: true,
    });
    await completion.click();
    await expect.element(completion).not.toBeChecked();
    expect(fixture.enable).toHaveBeenLastCalledWith({
      notifyOnCompletion: false,
      notifyOnUserInput: true,
    });
    expect(fixture.disable).not.toHaveBeenCalled();
    await input.click();
    await expect.element(input).not.toBeChecked();
    expect(fixture.disable).toHaveBeenCalled();
    expect(fixture.settings).toEqual({
      notificationsEnabled: false,
      userInputNotificationsEnabled: false,
    });
  });

  it("keeps the previous preferences when browser registration fails", async () => {
    fixture.settings = { notificationsEnabled: true, userInputNotificationsEnabled: false };
    fixture.enable.mockRejectedValueOnce(new Error("Could not update notifications."));
    mounted = await render(<NotificationsSettingsPanel />);
    await page.getByRole("switch", { name: "Enable user input notifications" }).click();
    await expect.element(page.getByText("Could not update notifications.")).toBeVisible();
    await expect
      .element(page.getByRole("switch", { name: "Enable user input notifications" }))
      .not.toBeChecked();
    await expect
      .element(page.getByRole("switch", { name: "Enable chat completion notifications" }))
      .toBeChecked();
    expect(fixture.update).not.toHaveBeenCalled();
    expect(fixture.disable).not.toHaveBeenCalled();
  });
});
