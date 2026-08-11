import "../index.css";

import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@cafecode/contracts/settings";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { parseHexagonsBackgroundText } from "../hexagonsBackgroundPreset";

const mocks = vi.hoisted(() => ({
  settings: null as unknown as UnifiedSettings,
  createHexagonBackground: vi.fn(),
  destroy: vi.fn(),
}));

vi.mock("../hooks/useSettings", () => ({
  useSettings: <T,>(selector: (settings: UnifiedSettings) => T) => selector(mocks.settings),
}));

vi.mock("../vendor/the-hexagons-runtime-club-code/runtime/portable.js", () => ({
  createHexagonBackground: mocks.createHexagonBackground,
}));

import { HexagonsBackground } from "./HexagonsBackground";

const PRESET = parseHexagonsBackgroundText(
  JSON.stringify({
    kind: "the-hexagons-background",
    formatVersion: 1,
    name: "Black Light",
    target: "club-code",
    settings: {
      material: "glass",
      frontLightEnabled: true,
      frontLightColor: "#9900ff",
      fallingEffectsEnabled: true,
      renderer: "gpu",
      reducedMotion: "never",
    },
    activationHints: { backgroundEnabled: true, fallingEffectsEnabled: true },
    hostPolicyHints: { renderer: "gpu", reducedMotion: "never" },
  }),
).serialized;

beforeEach(() => {
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("data-cafe-hexagons-background");
  mocks.settings = {
    ...DEFAULT_UNIFIED_SETTINGS,
    hexagonsBackgroundEnabled: false,
    hexagonsBackgroundPresetJson: PRESET,
    continueBackgroundAnimations: false,
  };
  mocks.destroy.mockReset();
  mocks.createHexagonBackground.mockReset();
  mocks.createHexagonBackground.mockResolvedValue({
    destroy: mocks.destroy,
    getState: () => ({
      activeRenderer: "webgl2",
      animationAllowed: true,
      tileCount: 144,
      fallbackReason: null,
    }),
  });
});

describe("The Hexagons background host", () => {
  it("does not mount for a disabled or invalid stored preset", async () => {
    const mounted = await render(<HexagonsBackground />);

    expect(mocks.createHexagonBackground).not.toHaveBeenCalled();
    await expect.element(page.getByTestId("hexagons-background")).not.toBeInTheDocument();

    mocks.settings = {
      ...mocks.settings,
      hexagonsBackgroundEnabled: true,
      hexagonsBackgroundPresetJson: "invalid",
    };
    await mounted.rerender(<HexagonsBackground />);
    expect(mocks.createHexagonBackground).not.toHaveBeenCalled();
    await expect.element(page.getByTestId("hexagons-background")).not.toBeInTheDocument();
  });

  it("mounts below the app with Club Code activation and motion policy", async () => {
    mocks.settings = {
      ...mocks.settings,
      hexagonsBackgroundEnabled: true,
      continueBackgroundAnimations: true,
    };
    const mounted = await render(<HexagonsBackground />);
    const background = page.getByTestId("hexagons-background");

    await expect.element(background).toBeInTheDocument();
    await expect.poll(() => mocks.createHexagonBackground.mock.calls.length).toBe(1);
    const options = mocks.createHexagonBackground.mock.calls[0]?.[0];
    expect(options.settings).toMatchObject({
      material: "glass",
      frontLightEnabled: true,
      frontLightColor: "#9900ff",
      enabled: true,
      fallingEffectsEnabled: false,
      renderer: "auto",
      reducedMotion: "system",
      continueBackgroundAnimations: true,
    });
    expect(options.pointerTarget).toBe(window);
    expect(options.position).toBe("absolute");
    expect(options.zIndex).toBe(0);
    await expect.element(background).toHaveAttribute("data-hexagons-status", "ready");
    await expect.element(background).toHaveAttribute("data-hexagons-renderer", "webgl2");
    await expect.element(background).toHaveAttribute("data-hexagons-tile-count", "144");
    expect(document.documentElement.dataset.cafeHexagonsBackground).toBe("true");
    expect(getComputedStyle(background.element()).pointerEvents).toBe("none");

    await mounted.unmount();
    expect(mocks.destroy).toHaveBeenCalledOnce();
    expect(document.documentElement.hasAttribute("data-cafe-hexagons-background")).toBe(false);
  });

  it("cleans partial renderer output when startup fails", async () => {
    mocks.settings = {
      ...mocks.settings,
      hexagonsBackgroundEnabled: true,
    };
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.createHexagonBackground.mockImplementationOnce(async ({ container }) => {
      container.append(document.createElement("canvas"));
      throw new Error("Renderer startup failed");
    });

    const mounted = await render(<HexagonsBackground />);
    const background = page.getByTestId("hexagons-background");
    await expect.element(background).toHaveAttribute("data-hexagons-status", "error");
    expect(background.element().childElementCount).toBe(0);
    expect(document.documentElement.hasAttribute("data-cafe-hexagons-background")).toBe(false);

    await mounted.unmount();
    consoleError.mockRestore();
  });
});
