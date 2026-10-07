import "../../index.css";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import type { NativeControlState } from "@cafecode/contracts";
import { NativeControlSettings } from "./NativeControlSettings";

let mounted: Awaited<ReturnType<typeof render>> | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});
function fixture(platform = "darwin", available = true) {
  let state: NativeControlState = {
    platform,
    enabled: false,
    phase: "off",
    driverVersion: "0.34.0",
    runtimeAvailable: available,
    detail: "Local desktop control is off.",
  };
  const bridge = {
    getNativeControlState: vi.fn(async () => state),
    setNativeControlEnabled: vi.fn(async (enabled: boolean) => {
      state = {
        ...state,
        enabled,
        phase: enabled ? "ready" : "off",
        detail: enabled ? "Native fixture is ready." : "Local desktop control is off.",
      };
      return state;
    }),
    getNativeControlDiagnostics: vi.fn(async () => ({
      content: [{ type: "text", text: "Synthetic permissions granted." }],
    })),
    captureNativeControlPreview: vi.fn(async () => ({
      content: [
        {
          type: "image",
          mimeType: "image/png",
          data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=",
        },
      ],
    })),
  };
  return bridge;
}
it.each(["linux", "win32"])("hides native desktop controls on %s", async (platform) => {
  const bridge = fixture(platform);
  mounted = await render(<NativeControlSettings bridge={bridge} />);
  await expect.poll(() => bridge.getNativeControlState.mock.calls.length).toBe(1);
  await expect
    .element(page.getByRole("switch", { name: "Enable local desktop control" }))
    .not.toBeInTheDocument();
  expect(bridge.setNativeControlEnabled).not.toHaveBeenCalled();
});
it("blocks enabling a missing runtime and shows Mac permission guidance", async () => {
  mounted = await render(<NativeControlSettings bridge={fixture("darwin", false)} />);
  await expect
    .element(page.getByText("The reviewed native runtime is unavailable", { exact: false }))
    .toBeVisible();
  await expect
    .element(page.getByRole("switch", { name: "Enable local desktop control" }))
    .toBeDisabled();
  await expect.element(page.getByRole("button", { name: "Test screenshot" })).toBeDisabled();
  await expect.element(page.getByText("Allow Cafe", { exact: false })).toBeVisible();
});
it("enables explicitly, checks permissions, shows a screenshot and clears it on disable", async () => {
  const bridge = fixture();
  mounted = await render(<NativeControlSettings bridge={bridge} />);
  const toggle = page.getByRole("switch", { name: "Enable local desktop control" });
  await expect.element(toggle).toBeEnabled();
  await toggle.click();
  await expect.element(page.getByText("Native fixture is ready.")).toBeVisible();
  await page.getByRole("button", { name: "Check permissions" }).click();
  await expect
    .element(page.getByRole("status"))
    .toHaveTextContent("Synthetic permissions granted.");
  await page.getByRole("button", { name: "Test screenshot" }).click();
  await expect.element(page.getByAltText("Native desktop test screenshot")).toBeVisible();
  await expect.element(toggle).toBeEnabled();
  await toggle.click();
  await expect.element(page.getByAltText("Native desktop test screenshot")).not.toBeInTheDocument();
  expect(bridge.setNativeControlEnabled.mock.calls.map(([enabled]) => enabled)).toEqual([
    true,
    false,
  ]);
});
it("keeps failed checks retryable without displaying raw IPC error contents", async () => {
  const bridge = fixture();
  bridge.getNativeControlState.mockRejectedValueOnce(new Error("private IPC details"));
  mounted = await render(<NativeControlSettings bridge={bridge} />);
  await expect
    .element(page.getByRole("status"))
    .toHaveTextContent("Could not read the local controller state. Restart Cafe or refresh.");
  await page.getByRole("button", { name: "Refresh state" }).click();
  await expect
    .element(page.getByRole("switch", { name: "Enable local desktop control" }))
    .toBeEnabled();
  await expect.element(page.getByText("private IPC details")).not.toBeInTheDocument();
});
