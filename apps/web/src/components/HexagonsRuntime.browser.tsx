import { afterEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";

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

  it("keeps a cinematic 4K Canvas fallback inside its complete-frame tile and DPR budgets", async () => {
    await page.viewport(1_280, 720);
    const container = document.createElement("div");
    Object.assign(container.style, {
      position: "relative",
      width: "3840px",
      height: "2160px",
    });
    document.body.append(container);

    const controller = await createHexagonBackground({
      container,
      position: "absolute",
      zIndex: 0,
      getDisplayInfo: async () => ({
        id: "canvas-fallback-display",
        width: 3_840,
        height: 2_160,
        scaleFactor: window.devicePixelRatio,
      }),
      settings: {
        enabled: true,
        quality: "cinematic",
        renderer: "canvas",
        reducedMotion: "always",
        continueBackgroundAnimations: false,
        fallingEffectsEnabled: false,
      },
    });
    destroyBackground = () => controller.destroy();

    const state = controller.getState();
    expect(state.activeRenderer).toBe("canvas2d-fallback");
    expect(state.fallbackReason).toBe("forced-canvas");
    expect(state.tileCount).toBeGreaterThan(0);
    expect(state.tileCount).toBeLessThanOrEqual(64);
    expect(state.lastResult).toMatchObject({
      status: "rendered",
      tileInstances: state.tileCount,
      tileBudget: 64,
      minimumIdleMs: 150,
      mesh: "bounded-three-prism",
    });
    expect(Number(state.lastResult.dpr)).toBeLessThan(0.5);

    const canvas = controller.root.querySelector<HTMLCanvasElement>(
      '[data-hexagons-layer="tiles-canvas"]',
    );
    expect(canvas).not.toBeNull();
    expect(canvas!.width * canvas!.height).toBeLessThanOrEqual(1_250_000);
    const context = canvas!.getContext("2d");
    expect(context).not.toBeNull();
    expect(context!.getImageData(canvas!.width - 1, canvas!.height - 1, 1, 1).data[3]).toBe(255);
  });

  it("keeps extreme Canvas aspect ratios inside the complete-frame tile budget", async () => {
    const container = document.createElement("div");
    Object.assign(container.style, {
      position: "relative",
      width: "10000px",
      height: "100px",
    });
    document.body.append(container);

    const controller = await createHexagonBackground({
      container,
      position: "absolute",
      zIndex: 0,
      getDisplayInfo: async () => ({
        id: "extreme-aspect-canvas-display",
        width: 10_000,
        height: 100,
        scaleFactor: window.devicePixelRatio,
      }),
      settings: {
        enabled: true,
        quality: "performance",
        renderer: "canvas",
        reducedMotion: "always",
        continueBackgroundAnimations: false,
        fallingEffectsEnabled: false,
      },
    });
    destroyBackground = () => controller.destroy();

    const state = controller.getState();
    expect(state.activeRenderer).toBe("canvas2d-fallback");
    expect(state.tileCount).toBeGreaterThan(0);
    expect(state.tileCount).toBeLessThanOrEqual(32);
    expect(state.lastResult).toMatchObject({
      status: "rendered",
      tileInstances: state.tileCount,
      tileBudget: 32,
    });

    const canvas = controller.root.querySelector<HTMLCanvasElement>(
      '[data-hexagons-layer="tiles-canvas"]',
    );
    expect(canvas).not.toBeNull();
    expect(canvas!.width * canvas!.height).toBeLessThanOrEqual(600_000);
    const context = canvas!.getContext("2d");
    expect(context).not.toBeNull();
    expect(context!.getImageData(canvas!.width - 1, canvas!.height - 1, 1, 1).data[3]).toBe(255);
  });

  it.each([
    ["cairo-pentagon", "cairo-four-pentagon"],
    ["hexagram", "hexagram-twelve-facet"],
  ] as const)(
    "keeps schema-10 %s Canvas geometry inside its tile budget",
    async (tessellationMode, mesh) => {
      const container = document.createElement("div");
      Object.assign(container.style, {
        position: "relative",
        width: "1280px",
        height: "720px",
      });
      document.body.append(container);

      const controller = await createHexagonBackground({
        container,
        position: "absolute",
        zIndex: 0,
        getDisplayInfo: async () => ({
          id: `schema-10-${tessellationMode}-canvas-display`,
          width: 1_280,
          height: 720,
          scaleFactor: window.devicePixelRatio,
        }),
        settings: {
          enabled: true,
          quality: "cinematic",
          renderer: "canvas",
          reducedMotion: "always",
          continueBackgroundAnimations: false,
          fallingEffectsEnabled: false,
          tessellationMode,
        },
      });
      destroyBackground = () => controller.destroy();

      const state = controller.getState();
      expect(state.activeRenderer).toBe("canvas2d-fallback");
      expect(state.tileCount).toBeGreaterThan(0);
      expect(state.tileCount).toBeLessThanOrEqual(64);
      expect(state.lastResult).toMatchObject({
        status: "rendered",
        tileInstances: state.tileCount,
        tileBudget: 64,
        mesh,
      });
    },
  );

  it("rebuilds GPU-sized geometry to the Canvas budget when WebGL is lost", async () => {
    const container = document.createElement("div");
    Object.assign(container.style, {
      position: "relative",
      width: "1280px",
      height: "720px",
    });
    document.body.append(container);

    const controller = await createHexagonBackground({
      container,
      position: "absolute",
      zIndex: 0,
      getDisplayInfo: async () => ({
        id: "context-loss-display",
        width: 1_280,
        height: 720,
        scaleFactor: window.devicePixelRatio,
      }),
      settings: {
        enabled: true,
        quality: "cinematic",
        renderer: "auto",
        reducedMotion: "always",
        continueBackgroundAnimations: false,
        fallingEffectsEnabled: false,
      },
    });
    destroyBackground = () => controller.destroy();

    if (controller.getState().activeRenderer === "gpu-webgl2") {
      const gpuCanvas = controller.root.querySelector<HTMLCanvasElement>(
        '[data-hexagons-layer="tiles-gpu"]',
      );
      expect(gpuCanvas).not.toBeNull();
      gpuCanvas!.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    }

    const state = controller.getState();
    expect(state.activeRenderer).toBe("canvas2d-fallback");
    expect(state.tileCount).toBeGreaterThan(0);
    expect(state.tileCount).toBeLessThanOrEqual(64);
    expect(state.lastResult).toMatchObject({
      status: "rendered",
      tileInstances: state.tileCount,
      tileBudget: 64,
    });
  });

  it("leaves timer work breathing room between animated Canvas frames", async () => {
    const container = document.createElement("div");
    Object.assign(container.style, {
      position: "relative",
      width: "1280px",
      height: "720px",
    });
    document.body.append(container);

    let completedFrames = 0;
    const controller = await createHexagonBackground({
      container,
      position: "absolute",
      zIndex: 0,
      getDisplayInfo: async () => ({
        id: "animated-canvas-display",
        width: 1_280,
        height: 720,
        scaleFactor: window.devicePixelRatio,
      }),
      onState: (state) => {
        if (state.lastResult.status === "rendered") completedFrames += 1;
      },
      settings: {
        enabled: true,
        quality: "cinematic",
        renderer: "canvas",
        reducedMotion: "never",
        continueBackgroundAnimations: true,
        fallingEffectsEnabled: false,
      },
    });
    destroyBackground = () => controller.destroy();

    let heartbeatCount = 0;
    const heartbeat = window.setInterval(() => {
      heartbeatCount += 1;
    }, 25);
    await new Promise<void>((resolve) => window.setTimeout(resolve, 700));
    window.clearInterval(heartbeat);

    expect(heartbeatCount).toBeGreaterThanOrEqual(8);
    expect(completedFrames).toBeGreaterThanOrEqual(2);
    expect(completedFrames).toBeLessThanOrEqual(5);
    const result = controller.getState().lastResult;
    expect(result).toMatchObject({
      status: "rendered",
      tileBudget: 64,
      minimumIdleMs: 150,
    });
    expect(Number(result.scheduledIdleMs)).toBeGreaterThanOrEqual(150);
    expect(Number(result.scheduledIdleMs)).toBeGreaterThanOrEqual(Number(result.renderDurationMs));
  });
});
