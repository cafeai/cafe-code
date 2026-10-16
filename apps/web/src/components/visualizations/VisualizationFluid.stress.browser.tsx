import { afterEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import {
  createNativeFluidFixture,
  type FluidFixture,
  type NativeFluidFixture,
} from "./visualizationFluid.fixture";
const nativeFixtures: NativeFluidFixture[] = [];
const nativeCleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of nativeCleanups.splice(0)) cleanup();
  for (const value of nativeFixtures.splice(0)) value.dispose();
});
async function clickChart(
  value: Pick<FluidFixture, "document" | "frame">,
  choice: "a" | "b" | "same",
) {
  const button = value.document.querySelector<HTMLButtonElement>(
    `[data-fluid-layout="${choice}"]`,
  )!;
  const rect = button.getBoundingClientRect();
  expect(rect.width).toBeGreaterThan(0);
  expect(rect.height).toBeGreaterThan(0);
  expect(value.frame.contentDocument).toBe(value.document);
  expect(button.ownerDocument).toBe(value.document);
  const previous = Number(value.document.documentElement.dataset.fixtureTrustedClicks ?? "0");
  const names = { a: "Chart A", b: "Chart B", same: "Same chart" } as const;
  await userEvent.click(
    page
      .frameLocator(page.elementLocator(value.frame))
      .getByRole("button", { name: names[choice], exact: true }),
  );
  expect(value.document.documentElement.dataset.fixtureTrustedClicks).toBe(String(previous + 1));
  expect(value.document.documentElement.dataset.fixtureChart).toBe(choice);
}

function physicalSize(value: Pick<FluidFixture, "canvas" | "window">) {
  const rect = value.canvas().getBoundingClientRect();
  const scale = Math.min(value.window.devicePixelRatio, 512 / Math.max(rect.width, rect.height));
  return [
    Math.max(1, Math.floor(rect.width * scale)),
    Math.max(1, Math.floor(rect.height * scale)),
  ];
}

async function nativePixelDigest(
  canvas: HTMLCanvasElement,
  gl: WebGLRenderingContext | WebGL2RenderingContext,
) {
  expect(gl.isContextLost()).toBe(false);
  expect(gl.getError()).toBe(gl.NO_ERROR);
  expect(canvas.width).toBeGreaterThan(0);
  expect(canvas.height).toBeGreaterThan(0);
  expect(Math.max(canvas.width, canvas.height)).toBeLessThanOrEqual(512);
  const pixels = new Uint8Array(canvas.width * canvas.height * 4);
  gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  expect(gl.getError()).toBe(gl.NO_ERROR);
  expect(pixels.some((byte, index) => index % 4 !== 3 && byte > 0)).toBe(true);
  expect(pixels.some((byte, index) => index % 4 === 3 && byte > 0)).toBe(true);
  const digest = await crypto.subtle.digest("SHA-256", pixels);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
describe("optional native fluid stress qualification", () => {
  it("continues actual native WebGL pixels after exhausting size admissions with trusted chart buttons", async () => {
    // Preserve the original single test deadline. If it expires, retain which
    // native phase/input actually finished before afterEach removes the frame;
    // a later screenshot cannot reconstruct that evidence. This bounded trace
    // reads existing scalar attributes only, never GL state, pixels or source.
    const startedAt = performance.now();
    const phases: {
      phase: string;
      index: number | null;
      elapsedMs: number;
      trustedClicks: number | null;
      frames: number | null;
      width: number | null;
      height: number | null;
    }[] = [];
    let observed: NativeFluidFixture | undefined;
    let pendingFrame: HTMLIFrameElement | undefined;
    let finished = false;
    let retired = false;
    let truncated = false;
    const record = (phase: string, index: number | null = null) => {
      if (retired) throw new Error("Native fluid qualification already retired");
      if (phases.length === 128) {
        truncated = true;
        return;
      }
      const canvas = observed?.canvas();
      const finiteCount = (value: unknown): number | null => {
        const count = typeof value === "number" ? value : Number(value);
        return Number.isSafeInteger(count) && count >= 0 ? count : null;
      };
      phases.push({
        phase,
        index,
        elapsedMs: Math.round(performance.now() - startedAt),
        trustedClicks: observed
          ? finiteCount(observed.document.documentElement.dataset.fixtureTrustedClicks)
          : null,
        frames: canvas ? finiteCount(canvas.dataset.cafeFluidFrames) : null,
        width: canvas ? finiteCount(canvas.width) : null,
        height: canvas ? finiteCount(canvas.height) : null,
      });
    };
    // An identically named control outside the owned child must receive no
    // input. Keep this alongside the real 31-click path, not a mocked locator.
    const decoy = document.createElement("button");
    decoy.type = "button";
    decoy.textContent = "Chart A";
    let decoyClicks = 0;
    decoy.onclick = () => decoyClicks++;
    const cleanup = () => {
      if (retired) return;
      if (!finished && observed) {
        record(observed.document.hidden ? "failure-document-hidden" : "failure-document-visible");
        const state = observed.canvas().dataset.cafeFluidState;
        record(
          state === "running"
            ? "failure-runtime-running"
            : state === "paused"
              ? "failure-runtime-paused"
              : "failure-runtime-other",
        );
        const bounds = observed.frame.getBoundingClientRect();
        record(
          bounds.bottom > 0 &&
            bounds.top < window.innerHeight &&
            bounds.right > 0 &&
            bounds.left < window.innerWidth
            ? "failure-frame-in-viewport"
            : "failure-frame-outside-viewport",
        );
      }
      retired = true;
      try {
        if (!finished) console.info("native-fluid-qualification-phases", { truncated, phases });
      } finally {
        decoy.remove();
        // Creation ownership is installed before srcdoc/navigation or append.
        // A hard timeout during frame load must not strand an unregistered frame.
        pendingFrame?.remove();
      }
    };
    nativeCleanups.push(cleanup);
    document.body.append(decoy);
    try {
      record("fixture-start");
      expect(window.matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(false);
      expect(window.matchMedia("(hover: hover)").matches).toBe(true);
      expect(window.matchMedia("(pointer: fine)").matches).toBe(true);
      const value = await createNativeFluidFixture((frame) => {
        pendingFrame = frame;
      });
      if (retired) {
        value.dispose();
        throw new Error("Native fluid qualification already retired");
      }
      nativeFixtures.push(value);
      pendingFrame = undefined;
      observed = value;
      record("fixture-ready");
      expect(value.window.matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(false);
      expect(value.window.matchMedia("(hover: hover)").matches).toBe(true);
      expect(value.window.matchMedia("(pointer: fine)").matches).toBe(true);
      expect(
        (value.window as Window & { __fluidFixture?: unknown }).__fluidFixture,
      ).toBeUndefined();
      const canvas = value.canvas();
      // A native unsupported/absent driver is a qualification failure, not an
      // excuse to use a recorder, skip this host or add permissive native flags.
      expect(canvas.dataset.cafeFluidState).toBe("running");
      const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
      expect(gl).not.toBeNull();
      expect(gl!.getParameter(gl!.VERSION)).toMatch(/^WebGL/);
      await expect.poll(() => frames(value)).toBeGreaterThan(12);
      record("initial-frames-ready");
      for (let index = 0; index < 7; index++) {
        const before = frames(value);
        const choice = index % 2 === 0 ? "b" : "a";
        record("admission-click-start", index);
        await clickChart(value, choice);
        record("admission-click-complete", index);
        expect(canvas.getBoundingClientRect().width).toBe(choice === "a" ? 320 : 160);
        expect(canvas.getBoundingClientRect().height).toBe(160);
        await expect.poll(() => [canvas.width, canvas.height]).toEqual(physicalSize(value));
        await expect.poll(() => frames(value)).toBeGreaterThan(before);
        expect(canvas.dataset.cafeFluidState).toBe("running");
        record("admission-frame-ready", index);
      }
      const size = [canvas.width, canvas.height];
      const beforeFrames = frames(value);
      record("before-pixels-start");
      const beforePixels = await nativePixelDigest(canvas, gl!);
      record("before-pixels-complete");
      for (let index = 0; index < 24; index++) {
        const before = frames(value);
        const choice = index % 2 === 0 ? "a" : "b";
        record("retained-click-start", index);
        await clickChart(value, choice);
        record("retained-click-complete", index);
        expect(canvas.getBoundingClientRect().width).toBe(choice === "a" ? 320 : 160);
        await expect.poll(() => frames(value)).toBeGreaterThan(before);
        expect(value.canvas()).toBe(canvas);
        expect(canvas.getContext("webgl2") ?? canvas.getContext("webgl")).toBe(gl);
        expect([canvas.width, canvas.height]).toEqual(size);
        expect(canvas.dataset.cafeFluidState).toBe("running");
        expect(canvas.dataset.cafeFluidTextures).toBe("8");
        expect(canvas.dataset.cafeFluidPrograms).toBe("10");
        expect(canvas.dataset.cafeFluidBuffers).toBe("2");
        expect(canvas.dataset.cafeFluidRaf).toBe("true");
        expect(Number(canvas.dataset.cafeFluidTextureBytes)).toBeLessThanOrEqual(16 * 1024 * 1024);
        record("retained-frame-ready", index);
      }
      record("after-pixels-start");
      const afterPixels = await nativePixelDigest(canvas, gl!);
      record("after-pixels-complete");
      expect(frames(value)).toBeGreaterThanOrEqual(beforeFrames + 24);
      expect(afterPixels).not.toBe(beforePixels);
      expect(value.document.documentElement.dataset.fixtureTrustedClicks).toBe("31");
      expect(decoyClicks).toBe(0);
      value.visible(false);
      record("paused");
      const paused = frames(value);
      const pausedPixels = await nativePixelDigest(canvas, gl!);
      record("paused-click-start");
      await clickChart(value, "a");
      record("paused-click-complete");
      expect(canvas.dataset.cafeFluidState).toBe("paused");
      expect(canvas.dataset.cafeFluidRaf).toBe("false");
      expect(frames(value)).toBe(paused);
      expect(await nativePixelDigest(canvas, gl!)).toBe(pausedPixels);
      expect([canvas.width, canvas.height]).toEqual(size);
      value.visible(true);
      await expect.poll(() => frames(value)).toBeGreaterThan(paused + 2);
      expect(await nativePixelDigest(canvas, gl!)).not.toBe(pausedPixels);
      expect(decoyClicks).toBe(0);
      finished = true;
    } finally {
      cleanup();
    }
  });
});

function frames(value: Pick<FluidFixture, "canvas">) {
  return Number(value.canvas().dataset.cafeFluidFrames);
}
