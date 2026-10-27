import "../../index.css";
import { EnvironmentId, ThreadId, type GlideControlResult } from "@cafecode/contracts";
import { beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";
import { GlideControl } from "./GlideControl";

const fixture = vi.hoisted(() => ({
  control: vi.fn(),
  copy: vi.fn(async (_value: string) => undefined),
  local: true,
}));
vi.mock("../../environmentApi", () => ({
  readEnvironmentApi: () => ({ glide: { control: fixture.control } }),
}));
vi.mock("../../localCapabilities", () => ({
  getLocalShellCapabilities: () => ({
    canOpenLocalEditor: fixture.local,
    canOpenLocalTerminal: fixture.local,
    canOpenLocalPath: fixture.local,
    canPickLocalFolder: fixture.local,
  }),
}));
vi.mock("~/lib/copyToClipboard", () => ({ copyTextToClipboard: fixture.copy }));
const environmentId = EnvironmentId.make("glide-browser");
const threadId = ThreadId.make("glide-chat");
const state: GlideControlResult = {
  available: true,
  connected: true,
  enabled: false,
  fullAccess: true,
  busy: false,
  paused: false,
  accessibility: true,
  screenRecording: true,
  apps: [],
  runningApps: [],
  message: "Background desktop control",
};
const hostApp = {
  path: "/Users/dev/cafe/apps/desktop/.electron-runtime/debug/Cafe Code (Debug).app",
  name: "Cafe Code (Debug)",
  bundleId: "com.cafeai.cafecode.debug",
};
const missing: GlideControlResult = {
  ...state,
  accessibility: false,
  screenRecording: false,
  hostApp,
  osMajorVersion: 27,
};
beforeEach(() => {
  fixture.control.mockReset();
  fixture.copy.mockClear();
  fixture.local = true;
});
const button = () => page.getByRole("button", { name: "Computer use", exact: true });
const dialog = () => page.getByTestId("glide-setup-dialog");
const permissionState = (id: string) =>
  document.querySelector(`[data-permission="${id}"]`)?.getAttribute("data-state");
it("refreshes the saved switch after a draft becomes a server chat and its first session opens", async () => {
  fixture.control
    .mockResolvedValueOnce(state)
    .mockResolvedValueOnce(state)
    .mockResolvedValue({ ...state, enabled: true });
  const view = await render(
    <GlideControl
      environmentId={environmentId}
      threadId={null}
      runtimeMode="full-access"
      draftEnabled
      onDraftEnabledChange={() => {}}
      refreshKey="true:"
    />,
  );
  await expect.element(button()).toBeEnabled();
  await expect.element(button()).toHaveAttribute("aria-pressed", "true");
  await view.rerender(
    <GlideControl
      environmentId={environmentId}
      threadId={threadId}
      runtimeMode="full-access"
      refreshKey="true:"
    />,
  );
  await expect.element(button()).toHaveAttribute("aria-pressed", "false");
  await expect.element(button()).toBeEnabled();
  await view.rerender(
    <GlideControl
      environmentId={environmentId}
      threadId={threadId}
      runtimeMode="full-access"
      refreshKey="false:first-session"
    />,
  );
  await expect.element(button()).toHaveAttribute("aria-pressed", "true");
  expect(fixture.control.mock.calls.map(([input]) => input)).toEqual([
    { action: "status" },
    { action: "status", threadId },
    { action: "status", threadId },
  ]);
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

it("switches computer use on and off with exact chat authority and waits for confirmation", async () => {
  const enabled = deferred<GlideControlResult>();
  fixture.control
    .mockResolvedValueOnce(state)
    .mockReturnValueOnce(enabled.promise)
    .mockResolvedValue(state);
  await render(
    <GlideControl environmentId={environmentId} threadId={threadId} runtimeMode="full-access" />,
  );
  await expect.element(button()).toBeEnabled();
  await expect.element(button()).toHaveAttribute("aria-pressed", "false");
  await button().click();
  expect(fixture.control.mock.calls.at(-1)?.[0]).toEqual({
    action: "set-enabled",
    threadId,
    enabled: true,
  });
  await expect.element(button()).toBeDisabled();
  await expect.element(button()).toHaveAttribute("aria-pressed", "false");
  enabled.resolve({ ...state, enabled: true });
  await expect.element(button()).toHaveAttribute("aria-pressed", "true");
  await expect.element(button()).toBeEnabled();
  await button().click();
  await expect.element(button()).toHaveAttribute("aria-pressed", "false");
  expect(fixture.control.mock.calls.at(-1)?.[0]).toEqual({
    action: "set-enabled",
    threadId,
    enabled: false,
  });
  expect(fixture.control).toHaveBeenCalledTimes(3);
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
});

it.each(["approval-required", "full-access"] as const)(
  "restores the saved switch and allows revocation with missing OS permissions in %s mode",
  async (runtimeMode) => {
    fixture.control
      .mockResolvedValueOnce({
        ...state,
        enabled: true,
        fullAccess: runtimeMode === "full-access",
        accessibility: false,
        screenRecording: false,
      })
      .mockResolvedValue(state);
    await render(
      <GlideControl environmentId={environmentId} threadId={threadId} runtimeMode={runtimeMode} />,
    );
    await expect.element(button()).toHaveAttribute("aria-pressed", "true");
    await button().click();
    await expect.element(button()).toHaveAttribute("aria-pressed", "false");
    expect(fixture.control.mock.calls.at(-1)?.[0]).toEqual({
      action: "set-enabled",
      threadId,
      enabled: false,
    });
  },
);

it("requires Full access, then opens setup on first click without enabling or opening Settings", async () => {
  fixture.control.mockResolvedValue({
    ...state,
    fullAccess: false,
    accessibility: false,
    screenRecording: false,
  });
  const view = await render(
    <GlideControl
      environmentId={environmentId}
      threadId={threadId}
      runtimeMode="approval-required"
    />,
  );
  await expect.poll(() => fixture.control.mock.calls.length).toBe(1);
  await expect.element(button()).toBeDisabled();
  fixture.control.mockResolvedValue({ ...missing });
  await view.rerender(
    <GlideControl environmentId={environmentId} threadId={threadId} runtimeMode="full-access" />,
  );
  await expect.element(button()).toBeEnabled();
  await button().click();
  await expect.element(dialog()).toBeVisible();
  await expect.element(page.getByText("Set up computer use")).toBeVisible();
  await expect.poll(() => permissionState("accessibility")).toBe("missing");
  await expect.poll(() => permissionState("screen-recording")).toBe("missing");
  await expect
    .element(page.getByText("Device Control and Data Access", { exact: true }))
    .toBeVisible();
  await expect
    .element(page.getByText("Screen & System Audio Recording", { exact: true }))
    .toBeVisible();
  await expect.element(page.getByTestId("glide-host-app-path")).toHaveTextContent(hostApp.path);
  expect(fixture.control.mock.calls.length).toBeGreaterThanOrEqual(3);
  expect(fixture.control.mock.calls.every(([input]) => input.action === "status")).toBe(true);

  // Opening Settings returns fresh native status; it never implies a grant.
  // Setup polling may follow either click, so require the exact ordered actions
  // rather than treating the last global call as the settings-action receipt.
  const nonStatusInputs = () =>
    fixture.control.mock.calls.map(([input]) => input).filter((input) => input.action !== "status");
  await page.getByRole("button", { name: "Open Device Control and Data Access settings" }).click();
  await expect.poll(nonStatusInputs).toEqual([{ action: "open-accessibility", threadId }]);
  await expect.poll(() => permissionState("accessibility")).toBe("missing");
  await page.getByRole("button", { name: "Open Screen & System Audio Recording settings" }).click();
  await expect.poll(nonStatusInputs).toEqual([
    { action: "open-accessibility", threadId },
    { action: "open-screen-recording", threadId },
  ]);
  expect(fixture.control.mock.calls.some(([input]) => input.action === "set-enabled")).toBe(false);
  // Escape dismisses setup and returns to the truthful, still-off switch.
  await userEvent.keyboard("{Escape}");
  await expect.element(dialog()).not.toBeInTheDocument();
  await expect.element(button()).toHaveAttribute("aria-pressed", "false");
});

it("marks each permission complete as native polling confirms it, then enables the exact chat", async () => {
  fixture.control
    .mockResolvedValueOnce(missing)
    .mockResolvedValueOnce(missing)
    .mockResolvedValueOnce({ ...missing, accessibility: true })
    .mockResolvedValueOnce({ ...missing, accessibility: true, screenRecording: true })
    .mockResolvedValueOnce({
      ...missing,
      accessibility: true,
      screenRecording: true,
      enabled: true,
    })
    .mockResolvedValue({ ...missing, accessibility: true, screenRecording: true, enabled: true });
  await render(
    <GlideControl environmentId={environmentId} threadId={threadId} runtimeMode="full-access" />,
  );
  await expect.element(button()).toBeEnabled();
  await button().click();
  await expect.element(dialog()).toBeVisible();
  await expect.poll(() => permissionState("accessibility"), { timeout: 5_000 }).toBe("granted");
  await expect.poll(() => permissionState("screen-recording")).toBe("missing");
  await expect.poll(() => permissionState("screen-recording"), { timeout: 5_000 }).toBe("granted");
  await expect.element(page.getByText("Computer use is ready")).toBeVisible();
  const statusReads = fixture.control.mock.calls.length;
  await page.getByRole("button", { name: "Turn on for this chat" }).click();
  await expect.element(dialog()).not.toBeInTheDocument();
  await expect.element(button()).toHaveAttribute("aria-pressed", "true");
  expect(fixture.control.mock.calls.slice(statusReads).map(([input]) => input)).toEqual([
    { action: "set-enabled", threadId, enabled: true },
  ]);
});

it("stops polling when setup is dismissed and leaves the chat off", async () => {
  fixture.control.mockResolvedValue(missing);
  await render(
    <GlideControl environmentId={environmentId} threadId={threadId} runtimeMode="full-access" />,
  );
  await expect.element(button()).toBeEnabled();
  await button().click();
  await expect.element(dialog()).toBeVisible();
  await expect.poll(() => fixture.control.mock.calls.length, { timeout: 5_000 }).toBeGreaterThan(2);
  await page.getByRole("button", { name: "Close", exact: true }).first().click();
  await expect.element(dialog()).not.toBeInTheDocument();
  const reads = fixture.control.mock.calls.length;
  await new Promise((resolve) => setTimeout(resolve, 2_600));
  expect(fixture.control.mock.calls.length).toBe(reads);
  expect(fixture.control.mock.calls.every(([input]) => input.action === "status")).toBe(true);
  await expect.element(button()).toHaveAttribute("aria-pressed", "false");
  // The user can return to setup.
  await button().click();
  await expect.element(dialog()).toBeVisible();
});

it("stops polling when the control unmounts with setup open", async () => {
  fixture.control.mockResolvedValue(missing);
  const view = await render(
    <GlideControl environmentId={environmentId} threadId={threadId} runtimeMode="full-access" />,
  );
  await expect.element(button()).toBeEnabled();
  await button().click();
  await expect.element(dialog()).toBeVisible();
  await view.unmount();
  const reads = fixture.control.mock.calls.length;
  await new Promise((resolve) => setTimeout(resolve, 2_600));
  expect(fixture.control.mock.calls.length).toBe(reads);
});

it("ignores a stale status read that resolves after a newer native result", async () => {
  const stale = deferred<GlideControlResult>();
  fixture.control
    .mockResolvedValueOnce(missing)
    .mockReturnValueOnce(stale.promise)
    .mockResolvedValue({ ...missing, accessibility: true });
  await render(
    <GlideControl environmentId={environmentId} threadId={threadId} runtimeMode="full-access" />,
  );
  await expect.element(button()).toBeEnabled();
  await button().click();
  await page.getByRole("button", { name: "Open Device Control and Data Access settings" }).click();
  await expect.poll(() => permissionState("accessibility")).toBe("granted");
  stale.resolve(missing);
  await stale.promise;
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(permissionState("accessibility")).toBe("granted");
});

it("copies and reveals only the native host app path", async () => {
  fixture.control.mockResolvedValue(missing);
  await render(
    <GlideControl environmentId={environmentId} threadId={threadId} runtimeMode="full-access" />,
  );
  await expect.element(button()).toBeEnabled();
  await button().click();
  await page.getByRole("button", { name: "Copy path" }).click();
  await expect.poll(() => fixture.copy.mock.calls).toEqual([[hostApp.path]]);
  await expect.element(page.getByRole("button", { name: "Copied" })).toBeVisible();
  await page.getByRole("button", { name: "Show in Finder" }).click();
  await expect
    .poll(() => fixture.control.mock.calls.at(-1)?.[0])
    .toEqual({ action: "reveal-host-app", threadId });
});

it("omits Finder for remote servers and explains an unidentified app", async () => {
  fixture.local = false;
  const { hostApp: _omitted, ...withoutHost } = missing;
  fixture.control.mockResolvedValue(withoutHost);
  await render(
    <GlideControl environmentId={environmentId} threadId={threadId} runtimeMode="full-access" />,
  );
  await expect.element(button()).toBeEnabled();
  await button().click();
  await expect.element(page.getByText(/couldn’t be identified/)).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Show in Finder" }))
    .not.toBeInTheDocument();
});

it("leads a fresh draft into its own saved choice without a server mutation", async () => {
  const onDraftEnabledChange = vi.fn();
  fixture.control.mockResolvedValue({ ...missing, accessibility: true, screenRecording: true });
  fixture.control.mockResolvedValueOnce(missing);
  await render(
    <GlideControl
      environmentId={environmentId}
      threadId={null}
      runtimeMode="full-access"
      onDraftEnabledChange={onDraftEnabledChange}
    />,
  );
  await expect.element(button()).toBeEnabled();
  await button().click();
  await expect.element(page.getByText("Computer use is ready")).toBeVisible();
  await page.getByRole("button", { name: "Turn on for this chat" }).click();
  await expect.poll(() => onDraftEnabledChange.mock.calls).toEqual([[true, "0"]]);
  await expect.element(dialog()).not.toBeInTheDocument();
  expect(fixture.control.mock.calls.every(([input]) => input.action === "status")).toBe(true);
  expect(fixture.control.mock.calls.every(([input]) => !("threadId" in input))).toBe(true);
});

it("reflects Stop all through an inert activity read without probing permissions again", async () => {
  const onActivityChange = vi.fn();
  fixture.control.mockImplementation(async (input) =>
    input.action === "activity"
      ? { ...state, enabled: false, stopRevision: "1", activity: { state: "stopped" } }
      : { ...state, enabled: true, stopRevision: "0", activity: { state: "ready" } },
  );
  await render(
    <GlideControl
      environmentId={environmentId}
      threadId={threadId}
      runtimeMode="full-access"
      onActivityChange={onActivityChange}
    />,
  );
  await expect.element(button()).toHaveAttribute("aria-pressed", "true");
  await expect.element(button()).toHaveAttribute("aria-pressed", "false");
  expect(fixture.control.mock.calls.filter(([input]) => input.action === "status")).toHaveLength(1);
  expect(
    fixture.control.mock.calls.some(
      ([input]) => input.action === "activity" && input.threadId === threadId,
    ),
  ).toBe(true);
  expect(onActivityChange).toHaveBeenCalledWith({ state: "stopped" });
});

it("clears a stale draft grant after Stop all instead of silently renewing it", async () => {
  const change = vi.fn();
  fixture.control.mockResolvedValue({ ...state, stopRevision: "3" });
  await render(
    <GlideControl
      environmentId={environmentId}
      threadId={null}
      runtimeMode="full-access"
      draftEnabled
      draftRevision="2"
      onDraftEnabledChange={change}
    />,
  );
  await expect.poll(() => change.mock.calls).toEqual([[false]]);
  expect(fixture.control.mock.calls.every(([input]) => input.action === "status")).toBe(true);
});

it("retires a late toggle acknowledgement when the chat changes", async () => {
  const old = deferred<GlideControlResult>();
  fixture.control
    .mockResolvedValueOnce(state)
    .mockReturnValueOnce(old.promise)
    .mockResolvedValue(state);
  const view = await render(
    <GlideControl environmentId={environmentId} threadId={threadId} runtimeMode="full-access" />,
  );
  await expect.element(button()).toBeEnabled();
  await button().click();
  const replacement = ThreadId.make("replacement-chat");
  await view.rerender(
    <GlideControl environmentId={environmentId} threadId={replacement} runtimeMode="full-access" />,
  );
  await expect.element(button()).toBeEnabled();
  old.resolve({ ...state, enabled: true });
  await old.promise;
  await expect.element(button()).toHaveAttribute("aria-pressed", "false");
  expect(fixture.control.mock.calls.at(-1)?.[0]).toEqual({
    action: "status",
    threadId: replacement,
  });
});

it("keeps an unconfirmed change off and refreshes instead of replaying it", async () => {
  fixture.control
    .mockResolvedValueOnce(state)
    .mockRejectedValueOnce(new Error("Lost acknowledgement"))
    .mockResolvedValue({ ...state, enabled: true });
  await render(
    <GlideControl environmentId={environmentId} threadId={threadId} runtimeMode="full-access" />,
  );
  await expect.element(button()).toBeEnabled();
  await button().click();
  await expect.element(button()).toBeEnabled();
  await expect.element(button()).toHaveAttribute("aria-pressed", "false");
  await button().click();
  await expect.element(button()).toHaveAttribute("aria-pressed", "true");
  expect(fixture.control.mock.calls.at(-1)?.[0]).toEqual({ action: "status", threadId });
  expect(fixture.control.mock.calls.filter((c) => c[0].action === "set-enabled")).toHaveLength(1);
});
