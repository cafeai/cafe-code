import { afterEach, describe, expect, it } from "vitest";

import { createHexagonBackground } from "../vendor/the-hexagons-runtime-club-code/runtime/portable.js";

let destroyBackground: (() => void) | null = null;

afterEach(() => {
  destroyBackground?.();
  destroyBackground = null;
  document.body.innerHTML = "";
});

describe("vendored The Hexagons runtime", () => {
  it("renders the seven-layer scene with GPU selection or Canvas2D fallback", async () => {
    const container = document.createElement("div");
    Object.assign(container.style, {
      position: "relative",
      width: "480px",
      height: "320px",
    });
    document.body.append(container);

    const controller = await createHexagonBackground({
      container,
      position: "absolute",
      zIndex: 0,
      getDisplayInfo: async () => ({
        id: "browser-test-display",
        width: 1920,
        height: 1080,
        scaleFactor: 1,
      }),
      settings: {
        enabled: true,
        quality: "balanced",
        material: "glass",
        frontLightEnabled: true,
        frontLightColor: "#9900ff",
        emberPulse: true,
        fallingEffectsEnabled: false,
        renderer: "auto",
        reducedMotion: "always",
        continueBackgroundAnimations: false,
      },
    });
    destroyBackground = () => controller.destroy();

    expect(controller.root.parentElement).toBe(container);
    expect(controller.root.querySelectorAll("[data-hexagons-layer]")).toHaveLength(7);
    expect(getComputedStyle(controller.root).pointerEvents).toBe("none");
    const state = controller.getState();
    expect(["gpu-webgl2", "canvas2d-fallback"]).toContain(state.activeRenderer);
    expect(state.tileCount).toBeGreaterThan(0);
    expect(state.fallingResult).toMatchObject({
      status: "disabled",
      renderer: "none",
      primitives: 0,
    });
    controller.updateSettings({ frontLightColor: "#00ff88" });
    expect(controller.getSettings().frontLightColor).toBe("#00ff88");
    controller.resize();
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    expect(controller.getState().tileCount).toBeGreaterThan(0);

    controller.destroy();
    destroyBackground = null;
    expect(controller.root.isConnected).toBe(false);
  });
});
