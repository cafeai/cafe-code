import { afterEach, describe, expect, it } from "vitest";
import { createFluidFixture, type FluidFixture } from "./visualizationFluid.fixture";

const fixtures: FluidFixture[] = [];
async function fixture(options: Parameters<typeof createFluidFixture>[0] = {}) {
  expect(matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(false);
  const value = await createFluidFixture(options);
  fixtures.push(value);
  return value;
}
afterEach(() => {
  for (const value of fixtures.splice(0)) value.dispose();
});

describe("fluid decoration behavior", () => {
  it("does not start without one eligible canvas", async () => {
    for (const markerCount of [0, 2]) {
      const value = await fixture({ markerCount, visible: true });
      expect(value.recorder.summary().contextRequests).toBe(0);
      expect(value.recorder.pending()).toBe(0);
    }
  });
  it("bounds decoration resources and releases them on disposal", async () => {
    const value = await fixture({ visible: true });
    const canvas = value.canvas();
    const summary = value.recorder.summary();
    expect(canvas.dataset.cafeFluidState).toBe("running");
    expect(Math.max(canvas.width, canvas.height)).toBeLessThanOrEqual(512);
    expect(summary.textureBytes).toBeGreaterThan(0);
    expect(summary.peakTextureBytes).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(value.recorder.pending()).toBe(1);
    value.dispose();
    expect(canvas.dataset.cafeFluidState).toBe("disposed");
    expect(value.recorder.pending()).toBe(0);
    expect(value.recorder.summary()).toMatchObject({
      textures: 0,
      framebuffers: 0,
      programs: 0,
      shaders: 0,
      buffers: 0,
      listeners: 0,
      resizeObservers: 0,
      mutationObservers: 0,
    });
  });
  it("pauses hidden output and resumes the existing decoration", async () => {
    const value = await fixture({ visible: true });
    const canvas = value.canvas();
    value.recorder.flush(40);
    const frames = canvas.dataset.cafeFluidFrames;
    value.visible(false);
    expect(canvas.dataset.cafeFluidState).toBe("paused");
    expect(value.recorder.pending()).toBe(0);
    value.recorder.flush(80);
    expect(canvas.dataset.cafeFluidFrames).toBe(frames);
    value.visible(true);
    expect(value.canvas()).toBe(canvas);
    expect(canvas.dataset.cafeFluidState).toBe("running");
    expect(value.recorder.pending()).toBe(1);
  });
  it("does not let paint restoration revive a logically hidden document", async () => {
    const value = await fixture({ visible: true });
    value.visible(false);
    value.presentationVisible(false);
    value.presentationVisible(true);
    expect(value.canvas().dataset.cafeFluidState).toBe("paused");
    expect(value.recorder.pending()).toBe(0);
  });
  it("keeps a readable static fallback when WebGL is unavailable", async () => {
    const value = await fixture({ noWebgl: true, visible: true });
    expect(value.canvas().dataset.cafeFluidState).toBe("unsupported");
    expect(value.canvas().style.background).not.toBe("");
    expect(value.recorder.pending()).toBe(0);
  });
  it("retires the decoration after context loss", async () => {
    const value = await fixture({ visible: true });
    value.canvas().dispatchEvent(new Event("webglcontextlost"));
    expect(value.canvas().dataset.cafeFluidState).toBe("context-lost");
    expect(value.recorder.pending()).toBe(0);
    expect(value.recorder.summary().textures).toBe(0);
  });
});
