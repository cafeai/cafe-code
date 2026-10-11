import "../../index.css";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import type { NativeControlState } from "@cafecode/contracts";
import { getUiLocale, setUiLocale, uiText } from "@cafecode/shared/i18n";
import { NativeControlSettings } from "./NativeControlSettings";
import { applyInterfaceScalePercent } from "../../interfaceScale";

let mounted: Awaited<ReturnType<typeof render>> | undefined;
const originalLocale = getUiLocale();
beforeEach(() => setUiLocale("en"));
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  setUiLocale(originalLocale);
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

it("retranslates retained Cafe feedback without repeating the failed state read", async () => {
  const bridge = fixture();
  bridge.getNativeControlState.mockRejectedValueOnce(new Error("private IPC details"));
  mounted = await render(<NativeControlSettings bridge={bridge} />);
  await expect
    .element(page.getByRole("status"))
    .toHaveTextContent("Could not read the local controller state. Restart Cafe or refresh.");
  setUiLocale("ko");
  await expect
    .element(page.getByRole("status"))
    .toHaveTextContent("로컬 컨트롤러 상태를 읽지 못했습니다. Cafe를 재시작하거나 새로고침하세요.");
  expect(bridge.getNativeControlState).toHaveBeenCalledTimes(1);
  expect(bridge.setNativeControlEnabled).not.toHaveBeenCalled();
  expect(document.body.textContent).not.toContain("private IPC details");
});

it("keeps received controller text opaque while retranslating Cafe's empty-result fallback", async () => {
  const bridge = fixture();
  // Matching an English source is not translation provenance: this text came
  // from the synthetic controller, not from Cafe's finite fallback descriptor.
  bridge.getNativeControlDiagnostics.mockResolvedValueOnce({
    content: [{ type: "text", text: "Native operation completed." }],
  });
  mounted = await render(<NativeControlSettings bridge={bridge} />);
  const toggle = page.getByRole("switch", { name: "Enable local desktop control" });
  await expect.element(toggle).toBeEnabled();
  await toggle.click();
  await page.getByRole("button", { name: "Check permissions" }).click();
  await expect.element(page.getByRole("status")).toHaveTextContent("Native operation completed.");
  const stateReads = bridge.getNativeControlState.mock.calls.length;
  setUiLocale("ko");
  await expect
    .element(
      page.getByRole("button", {
        name: uiText("Test screenshot", undefined, undefined, "ko"),
      }),
    )
    .toBeEnabled();
  await expect.element(page.getByRole("status")).toHaveTextContent("Native operation completed.");
  expect(bridge.getNativeControlState).toHaveBeenCalledTimes(stateReads);
  expect(bridge.getNativeControlDiagnostics).toHaveBeenCalledTimes(1);
  expect(bridge.setNativeControlEnabled).toHaveBeenCalledTimes(1);

  await page
    .getByRole("button", {
      name: uiText("Test screenshot", undefined, undefined, "ko"),
    })
    .click();
  await expect
    .element(page.getByRole("status"))
    .toHaveTextContent("네이티브 작업이 완료되었습니다.");
  const readsAfterCapture = bridge.getNativeControlState.mock.calls.length;
  setUiLocale("en");
  await expect.element(page.getByRole("status")).toHaveTextContent("Native operation completed.");
  expect(bridge.captureNativeControlPreview).toHaveBeenCalledTimes(1);
  expect(bridge.getNativeControlState).toHaveBeenCalledTimes(readsAfterCapture);
});

it.each([
  { theme: "light", scale: 80 },
  { theme: "light", scale: 130 },
  { theme: "dark", scale: 80 },
  { theme: "dark", scale: 130 },
])("keeps Mac controls usable at narrow width in $theme at $scale%", async ({ theme, scale }) => {
  const root = document.documentElement;
  const originalDark = root.classList.contains("dark");
  const originalFontSize = root.style.fontSize;
  const originalViewport = { width: window.innerWidth, height: window.innerHeight };
  root.classList.toggle("dark", theme === "dark");
  applyInterfaceScalePercent(scale);
  await page.viewport(390, 1000);
  try {
    mounted = await render(
      <div className="bg-background p-3 text-foreground">
        <NativeControlSettings bridge={fixture()} />
      </div>,
    );
    const toggle = page.getByRole("switch", { name: "Enable local desktop control" });
    await expect.element(toggle).toBeEnabled();
    await toggle.click();
    await page.getByRole("button", { name: "Check permissions" }).click();
    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent("Synthetic permissions granted.");
    await expect
      .poll(() => {
        const section = mounted!.container.querySelector("section")!;
        const bounds = section.getBoundingClientRect();
        return (
          [...section.querySelectorAll("button")].every((button) => {
            const control = button.getBoundingClientRect();
            return (
              control.width > 0 && control.left >= bounds.left && control.right <= bounds.right + 1
            );
          }) && section.scrollWidth <= section.clientWidth
        );
      })
      .toBe(true);
    await page.screenshot();
  } finally {
    await mounted?.unmount();
    mounted = undefined;
    root.classList.toggle("dark", originalDark);
    root.style.fontSize = originalFontSize;
    await page.viewport(originalViewport.width, originalViewport.height);
  }
});
