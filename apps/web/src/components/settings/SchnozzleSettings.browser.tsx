import "../../index.css";
import { beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

const mocks = vi.hoisted(() => ({
  settings: { schnozzleEnabled: false, schnozzleRelayOrigin: "" },
  updateSettings: vi.fn(),
  openExternal: vi.fn<() => Promise<void>>(),
}));
vi.mock("../../hooks/useSettings", () => ({
  useSettings: (selector: (settings: typeof mocks.settings) => unknown) => selector(mocks.settings),
  useUpdateSettings: () => ({ updateSettings: mocks.updateSettings }),
}));
vi.mock("../../localApi", () => ({
  ensureLocalApi: () => ({ shell: { openExternal: mocks.openExternal } }),
}));
import { SchnozzleSettings, schnozzleOrigin } from "./SchnozzleSettings";

beforeEach(() => {
  mocks.settings = { schnozzleEnabled: false, schnozzleRelayOrigin: "" };
  mocks.updateSettings.mockReset();
  mocks.openExternal.mockReset();
  mocks.openExternal.mockResolvedValue(undefined);
});

it("stays off until enabled, saves only an origin and opens the room on an explicit click", async () => {
  const mounted = await render(
    <main className="mx-auto max-w-4xl p-6">
      <SchnozzleSettings />
    </main>,
  );
  try {
    await expect
      .element(page.getByRole("switch", { name: "Enable Amalgamating Schnozzle" }))
      .not.toBeChecked();
    expect(mocks.openExternal).not.toHaveBeenCalled();
    if (import.meta.env.VITE_SCHNOZZLE_CAPTURE === "1")
      await page.screenshot({ path: "schnozzle-disabled.png" });
    await page.getByRole("switch", { name: "Enable Amalgamating Schnozzle" }).click();
    expect(mocks.updateSettings).toHaveBeenCalledWith({ schnozzleEnabled: true });
    mocks.settings = { schnozzleEnabled: true, schnozzleRelayOrigin: "https://relay.example.com" };
    await mounted.rerender(
      <main className="mx-auto max-w-4xl p-6">
        <SchnozzleSettings />
      </main>,
    );
    const address = page.getByRole("textbox", { name: "Schnozzle relay address" });
    await address.fill("https://relay.example.com/?secret=must-not-save");
    await expect.element(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    await address.fill("https://relay.example.com/");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    expect(mocks.updateSettings).toHaveBeenCalledWith({
      schnozzleRelayOrigin: "https://relay.example.com",
    });
    expect(mocks.openExternal).not.toHaveBeenCalled();
    if (import.meta.env.VITE_SCHNOZZLE_CAPTURE === "1")
      await page.screenshot({ path: "schnozzle-enabled.png" });
    await page.getByRole("button", { name: "Open Schnozzle", exact: true }).click();
    expect(mocks.openExternal).toHaveBeenCalledWith("https://relay.example.com");
  } finally {
    await mounted.unmount();
  }
});

it("rejects credentials, invitation fragments, insecure remote hosts and executable schemes", () => {
  for (const input of [
    "javascript:alert(1)",
    "file:///private",
    "http://192.168.1.2",
    "https://user:secret@relay.example.com",
    "https://relay.example.com/#invite",
    "https://relay.example.com/secret",
  ]) {
    expect(schnozzleOrigin(input)).toBeNull();
  }
  expect(schnozzleOrigin("https://relay.example.com/")).toBe("https://relay.example.com");
  expect(schnozzleOrigin("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787");
});
