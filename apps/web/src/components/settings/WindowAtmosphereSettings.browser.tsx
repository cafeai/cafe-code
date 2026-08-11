import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@cafecode/contracts/settings";
import { page } from "vitest/browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { WindowAtmosphereSettings } from "./WindowAtmosphereSettings";

const testState = vi.hoisted(() => ({
  settings: null as UnifiedSettings | null,
  atmosphereAvailable: true,
  updateSettings: vi.fn(),
  toastAdd: vi.fn(),
}));

vi.mock("../../hooks/useSettings", () => ({
  useSettings: <T,>(selector?: (settings: UnifiedSettings) => T) => {
    const settings = testState.settings ?? DEFAULT_UNIFIED_SETTINGS;
    return selector ? selector(settings) : settings;
  },
  useUpdateSettings: () => ({ updateSettings: testState.updateSettings }),
}));

vi.mock("../../rpc/serverState", () => ({
  useServerConfig: () => ({
    ambientExperienceCapabilities: { atmosphere: testState.atmosphereAvailable },
  }),
}));

vi.mock("../ui/toast", () => ({
  stackedThreadToast: (toast: unknown) => toast,
  toastManager: { add: testState.toastAdd },
}));

describe("WindowAtmosphereSettings", () => {
  beforeEach(() => {
    testState.settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      fallingEffectsEnabled: true,
      fallingEffectKind: "matrix",
    };
    testState.atmosphereAvailable = true;
    testState.updateSettings.mockReset();
    testState.toastAdd.mockReset();
  });

  it("offers only the base Matrix settings and persists selections", async () => {
    const screen = await render(<WindowAtmosphereSettings />);

    await expect.element(page.getByText("Window atmosphere", { exact: true })).toBeInTheDocument();
    await expect.element(page.getByText("Matrix color mode", { exact: true })).toBeInTheDocument();
    await expect
      .element(page.getByText("Roman / Japanese mix", { exact: true }))
      .toBeInTheDocument();
    await expect.element(page.getByText("Live work vocabulary")).not.toBeInTheDocument();
    await expect.element(page.getByText("Provider activity links")).not.toBeInTheDocument();

    await page.getByText("Rain", { exact: true }).click();
    expect(testState.updateSettings).toHaveBeenCalledWith({ fallingEffectKind: "rain" });

    await page.getByText("Rainbow Extra", { exact: true }).click();
    expect(testState.updateSettings).toHaveBeenCalledWith({
      fallingEffectMatrixColorMode: "rainbow-extra",
    });

    await screen.unmount();
  });

  it("fails closed when the server does not expose atmosphere support", async () => {
    testState.atmosphereAvailable = false;
    const screen = await render(<WindowAtmosphereSettings />);

    await expect
      .element(page.getByText("This server has not enabled the window atmosphere capability."))
      .toBeInTheDocument();
    await expect.element(page.getByLabelText("Show falling effects")).toBeDisabled();
    await expect.element(page.getByText("Effect", { exact: true })).not.toBeInTheDocument();

    await screen.unmount();
  });

  it("resets every base atmosphere field together", async () => {
    testState.settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      fallingEffectsEnabled: true,
      fallingEffectKind: "matrix",
      fallingEffectColor: "#123456",
      fallingEffectMatrixColorMode: "rainbow-extra",
      fallingEffectOpacity: 0.8,
      fallingEffectSpeed: 2,
      fallingEffectDensity: 2,
      fallingEffectJapaneseRatio: 0.8,
    };
    const screen = await render(<WindowAtmosphereSettings />);

    await page.getByLabelText("Reset window atmosphere").click();
    expect(testState.updateSettings).toHaveBeenCalledWith({
      hexagonsBackgroundEnabled: false,
      hexagonsBackgroundPresetJson: null,
      fallingEffectsEnabled: false,
      fallingEffectKind: "snow",
      fallingEffectColor: "auto",
      fallingEffectMatrixColorMode: "fixed",
      fallingEffectOpacity: 0.35,
      fallingEffectSpeed: 1,
      fallingEffectDensity: 1,
      fallingEffectJapaneseRatio: 0.45,
    });

    await screen.unmount();
  });

  it("keeps The Hexagons disabled until a preset is present", async () => {
    const screen = await render(<WindowAtmosphereSettings />);

    await expect
      .element(page.getByLabelText("Show imported The Hexagons background"))
      .toBeDisabled();
    await expect.element(page.getByText("Import preset", { exact: true })).toBeInTheDocument();

    await screen.unmount();
  });
});
