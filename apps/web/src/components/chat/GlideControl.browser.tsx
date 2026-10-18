import "../../index.css";
import { EnvironmentId, ThreadId, type GlideControlResult } from "@cafecode/contracts";
import { beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import { GlideControl } from "./GlideControl";

const fixture = vi.hoisted(() => ({ control: vi.fn() }));
vi.mock("../../environmentApi", () => ({
  readEnvironmentApi: () => ({ glide: { control: fixture.control } }),
}));
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
beforeEach(() => fixture.control.mockReset());
const button = () => page.getByRole("button", { name: "Computer use", exact: true });
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

it("requires Full access and opens a missing permission's Settings only on explicit click", async () => {
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
  fixture.control.mockResolvedValue({ ...state, accessibility: false, screenRecording: false });
  await view.rerender(
    <GlideControl environmentId={environmentId} threadId={threadId} runtimeMode="full-access" />,
  );
  await expect.element(button()).toBeEnabled();
  expect(fixture.control.mock.calls.map((c) => c[0].action)).toEqual(["status", "status"]);
  await button().click();
  await expect
    .poll(() => fixture.control.mock.calls.at(-1)?.[0])
    .toEqual({ action: "open-accessibility", threadId });
  fixture.control.mockResolvedValue({ ...state, screenRecording: false });
  window.dispatchEvent(new Event("focus"));
  await expect
    .poll(() => fixture.control.mock.calls.at(-1)?.[0])
    .toEqual({ action: "status", threadId });
  await expect.element(button()).toBeEnabled();
  await button().click();
  await expect
    .poll(() => fixture.control.mock.calls.at(-1)?.[0])
    .toEqual({ action: "open-screen-recording", threadId });
  expect(fixture.control.mock.calls.some((c) => c[0].action === "set-enabled")).toBe(false);
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
