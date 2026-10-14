import {
  VISUALIZATION_FLUID_RUNTIME_SOURCE,
  visualizationFluidScript,
} from "@cafecode/shared/visualizationFluidRuntime";
import { afterEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import {
  createFluidFixture,
  createNativeFluidFixture,
  type FluidFixture,
  type NativeFluidFixture,
} from "./visualizationFluid.fixture";

const fixtures: FluidFixture[] = [];
const nativeFixtures: NativeFluidFixture[] = [];
async function fixture(options: Parameters<typeof createFluidFixture>[0] = {}) {
  // Native context policy is a precondition, not a request to change the
  // user's preference or bypass the runtime's static accessibility branch.
  // Observe both owning and fixture documents; replacing the fixture iframe
  // alone never proves independence from a previous page-level media override.
  expect(window.matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(false);
  expect(window.matchMedia("(hover: hover)").matches).toBe(true);
  expect(window.matchMedia("(pointer: fine)").matches).toBe(true);
  const value = await createFluidFixture(options);
  fixtures.push(value);
  expect(value.window.matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(false);
  expect(value.window.matchMedia("(hover: hover)").matches).toBe(true);
  expect(value.window.matchMedia("(pointer: fine)").matches).toBe(true);
  return value;
}

function frames(value: Pick<FluidFixture, "canvas">) {
  return Number(value.canvas().dataset.cafeFluidFrames);
}

/** The browser provider delivers the click into the child document. Reading
 * its button geometry is an observation, never a focus/input rewrite. */
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
  const previous = Number(value.document.documentElement.dataset.fixtureTrustedClicks ?? "0");
  await userEvent.click(value.frame, {
    position: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
  });
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

/** Both samples use native default-framebuffer RGBA bytes at identical retained
 * dimensions. Frame counters alone cannot establish visible WebGL motion, and
 * a size-changing hash alone would be a false pixel-animation witness. */
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

/** Recorder cases independently qualify exact GL ownership and scheduling,
 * not physical GPU memory or native retirement. The explicitly named native
 * WebGL control uses an unmocked document and separately samples real pixels. */
describe("generated fluid decoration lifecycle", () => {
  afterEach(() => {
    for (const value of fixtures.splice(0)) {
      value.dispose();
      expect(value.recorder.summary()).toMatchObject({ resizeObservers: 0, mutationObservers: 0 });
    }
    for (const value of nativeFixtures.splice(0)) value.dispose();
  });

  it("embeds the complete licensed fixed library for generated documents only", () => {
    expect(visualizationFluidScript("mcp-app")).toBe("");
    expect(visualizationFluidScript("generated")).toBe(
      `<script>${VISUALIZATION_FLUID_RUNTIME_SOURCE}</script>`,
    );
    expect(VISUALIZATION_FLUID_RUNTIME_SOURCE).toContain("Copyright (c) Pavel Dobryakov");
    expect(VISUALIZATION_FLUID_RUNTIME_SOURCE).toContain('THE SOFTWARE IS PROVIDED "AS IS"');
    expect(VISUALIZATION_FLUID_RUNTIME_SOURCE).toContain("DEALINGS IN THE SOFTWARE.");
    // Actual equations/palette/orbit, not a description naming a fluid effect.
    for (const equation of [
      "vec2 coord = vUv - dt * texture2D(uVelocity, vUv).xy * texelSize;",
      "vec3 splat = exp(-dot(p, p) / radius) * color;",
      "float vorticity = R - L - T + B;",
      "force /= length(force) + 0.0001;",
      "float pressure = (L + R + B + T - divergence) * 0.25;",
      "velocity.xy -= vec2(R - L, T - B);",
      "float diffuse = clamp(dot(n, l) + 0.7, 0.7, 1.0);",
      "const h = 0.5 + Math.random() * 0.42;",
      "const r = base * (0.72 + 0.28 * Math.sin(orbitAngle * 0.37));",
    ])
      expect(VISUALIZATION_FLUID_RUNTIME_SOURCE).toContain(equation);
    expect(VISUALIZATION_FLUID_RUNTIME_SOURCE).not.toContain("bloomPrefilterShader");
    expect(VISUALIZATION_FLUID_RUNTIME_SOURCE).not.toContain("createNoiseTexture");
  });

  it("retains every complete supplied solver and shading program rather than approximating its equations", async () => {
    // SHA-256 of each complete shader body with whitespace normalized only,
    // independently extracted from the supplied e6768891… template. CI reads
    // no user's Downloads directory and does not depend on that path existing.
    const supplied = {
      baseVertexShader: "ffd95f644d99a14e1742e8a6ab52dd832c23a3fce35e77dd15962573006dc585",
      clearShader: "aec5b1942686574a4a3fb15ea4b764d7a2269355c98bae4d2e28dbc65f4abd4e",
      displayShader: "a9deed3d8eb40ab39fb32b5c9cc0188bd1f93c36609c656a7c06564fd3e64400",
      displayShadingShader: "315534c54ea1a51e7d2e1ae75f285fda52c67d291abd4325671cf48f906139f7",
      splatShader: "3061d12ec93c4c2f710a250ae67f6e2f254502d85def39f58ef0d34b133eb2b7",
      advectionManualFilteringShader:
        "df03b17fa63b92bb94aafa381fc570e28c8ed45668eb6fa329ecaa56b81e5c38",
      advectionShader: "6f4b0916798942a32addc55ad30984bf12aad51e19889da728d9017b9a05f3d0",
      divergenceShader: "1f846104d9f5b21c6a75e750244e2b1bf71b87c9389a9bf0cc6b7074c50b0bb5",
      curlShader: "fb9f2bc430c5691c90f29a209a5992051c707da44e1a676e19d7adebec6ca14f",
      vorticityShader: "3aa4609517d0430d5b6fdd27e040a7f6c84eab8252658759e1940032c1f1b49e",
      pressureShader: "55a3fc3b809f4937e3da98e4f23ca7b97aab0fdbb04f8296e1de75aef7a02164",
      gradientSubtractShader: "abad0a48954d586e5c819f27ba3d113593132f41c4eb11d051193d24d46f6e4c",
    };
    for (const [name, expected] of Object.entries(supplied)) {
      const start = VISUALIZATION_FLUID_RUNTIME_SOURCE.indexOf(`const ${name} = compileShader(`);
      expect(start, name).toBeGreaterThanOrEqual(0);
      const open = VISUALIZATION_FLUID_RUNTIME_SOURCE.indexOf("`", start);
      const close = VISUALIZATION_FLUID_RUNTIME_SOURCE.indexOf("`", open + 1);
      expect(close, name).toBeGreaterThan(open);
      let body = VISUALIZATION_FLUID_RUNTIME_SOURCE.slice(open + 1, close)
        .trim()
        .replace(/\s+/g, " ");
      // The accepted successor changes final display gain only. Reverse only
      // those exact two reviewed expressions for original complete-body parity;
      // every solver/equation/shading statement remains independently bound.
      if (name === "displayShader") {
        const gainComment =
          "// Final presentation only: retain the supplied dye/solver state, // with ten percent more colour than the original display baseline. ";
        expect(body).toContain(gainComment);
        // Remove only these exact reviewed explanatory lines. Arbitrary shader
        // comments/bytes remain in the original complete-body hash witness.
        body = body.replace(gainComment, "");
        expect(body).toContain("texture2D(uTexture, vUv).rgb * 1.1;");
        body = body.replace("texture2D(uTexture, vUv).rgb * 1.1;", "texture2D(uTexture, vUv).rgb;");
      } else if (name === "displayShadingShader") {
        expect(body).toContain("C.rgb *= diffuse * 1.1;");
        body = body.replace("C.rgb *= diffuse * 1.1;", "C.rgb *= diffuse;");
      }
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
      const hex = Array.from(new Uint8Array(digest), (value) =>
        value.toString(16).padStart(2, "0"),
      ).join("");
      expect(hex, name).toBe(expected);
    }
  });

  it.each([1, 0.8, 0.15, 0.05, 0])(
    "caps the actual decorative opacity without brightening quieter authored opacity %s",
    async (authoredOpacity) => {
      const value = await fixture({ authoredOpacity });
      const canvas = value.canvas();
      expect(value.window.getComputedStyle(canvas).opacity).toBe(
        String(Math.min(0.15, authoredOpacity)),
      );
      expect(canvas.style.getPropertyPriority("opacity")).toBe("important");
      expect(value.document.querySelector("p")?.style.opacity).toBe("");
      expect(value.recorder.summary()).toMatchObject({
        textures: 8,
        programs: 10,
        shaders: 12,
        buffers: 2,
        maxPending: 0,
      });
    },
  );

  it("requires exactly one marker and creates no idle resources without it", async () => {
    for (const markerCount of [0, 2]) {
      const value = await fixture({ markerCount, visible: true });
      const result = value.recorder.summary();
      expect(result.contextRequests).toBe(0);
      expect(result.textures).toBe(0);
      expect(result.programs).toBe(0);
      expect(result.listeners).toBe(0);
      expect(value.recorder.pending()).toBe(0);
    }
  });

  it("paints only finite static hidden startup with independently accounted resources", async () => {
    const value = await fixture();
    const canvas = value.canvas();
    expect(canvas.dataset.cafeFluidState).toBe("paused");
    expect(frames(value)).toBe(12);
    expect(value.recorder.pending()).toBe(0);
    const summary = value.recorder.summary();
    expect(summary).toMatchObject({
      textures: 8,
      framebuffers: 8,
      programs: 10,
      shaders: 12,
      buffers: 2,
      listeners: 8,
      solverClearsAfterDraw: 0,
      maxPending: 0,
    });
    expect(summary.textureBytes).toBe(9_668_608);
    expect(Number(canvas.dataset.cafeFluidTextureBytes)).toBe(summary.textureBytes);
    expect(summary.peakTextureBytes).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(summary.peakTextures).toBe(8);
    expect(canvas.width).toBeLessThanOrEqual(512);
    expect(canvas.height).toBeLessThanOrEqual(512);
    expect(canvas.style.pointerEvents).toBe("none");
    expect(canvas.getAttribute("aria-hidden")).toBe("true");
    expect(
      summary.shaderSources.some((source) =>
        source.includes("float pressure = (L + R + B + T - divergence) * 0.25;"),
      ),
    ).toBe(true);
  });

  it("continues beyond five minutes and 9000 frames with the same bounded resources and cadence", async () => {
    const value = await fixture({ visible: true });
    expect(value.window.matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(false);
    expect(value.recorder.pending()).toBe(1);
    value.recorder.flush(1);
    value.recorder.flush(16);
    expect(frames(value)).toBe(12);
    value.recorder.flush(40);
    expect(frames(value)).toBe(13);
    for (let time = 80; time <= 20_000; time += 40) value.recorder.flush(time);
    expect(frames(value)).toBe(512);
    expect(value.canvas().dataset.cafeFluidState).toBe("running");
    expect(value.recorder.pending()).toBe(1);
    for (let time = 20_040; time <= 400_000; time += 40) value.recorder.flush(time);
    expect(frames(value)).toBe(10012);
    expect(value.canvas().dataset.cafeFluidState).toBe("running");
    expect(value.recorder.pending()).toBe(1);
    expect(value.recorder.summary().maxPending).toBe(1);
    expect(value.recorder.summary().solverClearsAfterDraw).toBe(0);
    const draws = value.recorder.summary().draws;
    const resources = value.recorder.summary();
    value.visible(false);
    for (let time = 400_040; time <= 410_000; time += 40) value.recorder.flush(time);
    expect(frames(value)).toBe(10012);
    expect(value.recorder.summary().draws).toBe(draws);
    expect(value.recorder.pending()).toBe(0);
    value.visible(true);
    value.window.dispatchEvent(new Event("cafe-presentation-changed"));
    for (let time = 410_040; time <= 420_000; time += 40) value.recorder.flush(time);
    expect(frames(value)).toBe(10262);
    expect(value.recorder.summary().draws).toBeGreaterThan(draws);
    expect(value.recorder.pending()).toBe(1);
    expect(value.recorder.summary()).toMatchObject({
      textures: resources.textures,
      framebuffers: resources.framebuffers,
      programs: resources.programs,
      shaders: resources.shaders,
      buffers: resources.buffers,
      textureBytes: resources.textureBytes,
      peakTextures: 8,
    });
  });

  it("pauses immediately on the native hint and resumes without resetting its frame count", async () => {
    const value = await fixture({ visible: true });
    for (let time = 40; time <= 400; time += 40) value.recorder.flush(time);
    expect(frames(value)).toBe(22);
    value.visible(false);
    expect(value.recorder.pending()).toBe(0);
    expect(value.canvas().dataset.cafeFluidState).toBe("paused");
    for (let time = 440; time <= 4000; time += 40) value.recorder.flush(time);
    expect(frames(value)).toBe(22);
    value.visible(true);
    for (let time = 4040; time <= 20_000; time += 40) value.recorder.flush(time);
    expect(frames(value)).toBe(422);
    expect(value.recorder.pending()).toBe(1);
  });

  it("pauses paint-only without a legacy logical visibility event or solver reset", async () => {
    const value = await fixture({ visible: true, presentationVisible: true });
    const canvas = value.canvas();
    let logicalEvents = 0;
    const logicalVisibility = () => {
      logicalEvents += 1;
    };
    value.window.addEventListener("cafe-visibility-changed", logicalVisibility);
    try {
      for (let time = 40; time <= 400; time += 40) value.recorder.flush(time);
      expect(frames(value)).toBe(22);
      const resources = value.recorder.summary();
      const draws = resources.draws;
      // Actual passive mouse delivery may queue one input. A native paint hide
      // must discard that input, cancel RAF and preserve the same GL objects;
      // it is not logical offscreen retirement or a chart entrance signal.
      await userEvent.hover(value.frame, { position: { x: 100, y: 60 } });
      value.presentationVisible(false);
      expect(value.document.documentElement.dataset.cafeVisible).toBe("true");
      expect(logicalEvents).toBe(0);
      expect(canvas.dataset.cafeFluidState).toBe("paused");
      expect(value.recorder.pending()).toBe(0);
      for (let time = 440; time <= 4000; time += 40) value.recorder.flush(time);
      expect(frames(value)).toBe(22);
      expect(value.recorder.summary().draws).toBe(draws);
      value.presentationVisible(true);
      expect(value.canvas()).toBe(canvas);
      value.recorder.flush(4040);
      expect(frames(value)).toBe(23);
      expect(canvas.dataset.cafeFluidPointerInputs).toBe("0");
      expect(canvas.dataset.cafeFluidState).toBe("running");
      expect(value.recorder.pending()).toBe(1);
      expect(value.recorder.summary()).toMatchObject({
        textures: resources.textures,
        framebuffers: resources.framebuffers,
        programs: resources.programs,
        shaders: resources.shaders,
        buffers: resources.buffers,
        textureBytes: resources.textureBytes,
        createdTextures: resources.createdTextures,
        deletedTextures: resources.deletedTextures,
        solverClearsAfterDraw: 0,
        maxPending: 1,
      });
      expect(logicalEvents).toBe(0);
      // Logical visibility remains a separate authority/cooperation signal:
      // paint-only restoration cannot restart a logically hidden document.
      value.visible(false);
      expect(logicalEvents).toBe(1);
      value.presentationVisible(false);
      value.presentationVisible(true);
      expect(value.recorder.pending()).toBe(0);
      expect(frames(value)).toBe(23);
      expect(logicalEvents).toBe(1);
    } finally {
      value.window.removeEventListener("cafe-visibility-changed", logicalVisibility);
    }
  });

  it("applies paint-only cues during bounded zero-layout startup without reviving terminal state", async () => {
    const value = await fixture({
      width: 0,
      height: 0,
      visible: true,
      presentationVisible: false,
    });
    expect(value.canvas().dataset.cafeFluidState).toBe("waiting");
    expect(value.recorder.summary().contextRequests).toBe(0);
    value.presentationVisible(true);
    value.presentationVisible(false);
    expect(value.recorder.summary().contextRequests).toBe(0);
    value.canvas().style.width = "320px";
    value.canvas().style.height = "160px";
    await expect.poll(() => value.canvas().dataset.cafeFluidState).toBe("paused");
    expect(value.recorder.pending()).toBe(0);
    expect(frames(value)).toBe(12);
    value.presentationVisible(true);
    expect(value.recorder.pending()).toBe(1);
    value.recorder.flush(40);
    expect(frames(value)).toBe(13);
    const canvas = value.canvas();
    value.dispose();
    value.presentationVisible(false);
    value.presentationVisible(true);
    expect(canvas.dataset.cafeFluidState).toBe("disposed");
    expect(value.recorder.pending()).toBe(0);
    expect(value.recorder.summary()).toMatchObject({
      textures: 0,
      framebuffers: 0,
      programs: 0,
      shaders: 0,
      buffers: 0,
      textureBytes: 0,
      listeners: 0,
      resizeObservers: 0,
      mutationObservers: 0,
    });
  });

  it("deletes every exact old framebuffer before bounded resize replacement", async () => {
    const value = await fixture({ visible: true });
    const initial = value.recorder.summary();
    value.canvas().style.width = "160px";
    value.canvas().style.height = "160px";
    value.recorder.flush(40);
    const resized = value.recorder.summary();
    expect(resized.createdTextures - initial.createdTextures).toBe(8);
    expect(resized.deletedTextures - initial.deletedTextures).toBe(8);
    expect(resized.textures).toBe(8);
    expect(resized.framebuffers).toBe(8);
    expect(resized.programs).toBe(10);
    expect(resized.buffers).toBe(2);
    expect(resized.peakTextures).toBe(8);
    expect(resized.textureBytes).toBe(4_834_304);
    // The initial size plus these seven replacements exhaust the unchanged
    // allocation cap. Later valid CSS layout retains the last complete target.
    for (let index = 0; index < 6; index++) {
      value.canvas().style.width = `${170 + index}px`;
      value.recorder.flush(80 + index * 40);
    }
    const retained = value.recorder.summary();
    const size = [value.canvas().width, value.canvas().height];
    expect(retained.createdTextures - initial.createdTextures).toBe(7 * 8);
    expect(retained.deletedTextures - initial.deletedTextures).toBe(7 * 8);
    value.canvas().style.width = "176px";
    value.recorder.flush(320);
    expect(value.canvas().getBoundingClientRect().width).toBe(176);
    expect(value.canvas().dataset.cafeFluidState).toBe("running");
    expect(frames(value)).toBe(20);
    expect([value.canvas().width, value.canvas().height]).toEqual(size);
    expect(value.recorder.pending()).toBe(1);
    expect(value.recorder.summary()).toMatchObject({
      textures: 8,
      framebuffers: 8,
      programs: 10,
      shaders: 12,
      buffers: 2,
      textureBytes: retained.textureBytes,
      createdTextures: retained.createdTextures,
      deletedTextures: retained.deletedTextures,
      textureIds: retained.textureIds,
      framebufferIds: retained.framebufferIds,
      peakTextures: 8,
      solverClearsAfterDraw: 0,
      maxPending: 1,
    });
  });

  it("keeps native chart-button motion alive after eight physical-size admissions", async () => {
    const value = await fixture({ visible: true, interactiveLayout: true });
    const canvas = value.canvas();
    const initial = value.recorder.summary();
    let retained: ReturnType<FluidFixture["recorder"]["summary"]> | undefined;
    let retainedSize: readonly [number, number] | undefined;
    // Boot counts as admission one. A/B toggles consume the other seven; all
    // later valid layout changes must reuse that last complete solver, rather
    // than refill the quota or terminate the chart's ordinary animation.
    for (let index = 0; index < 24; index++) {
      const choice = index % 2 === 0 ? "b" : "a";
      await clickChart(value, choice);
      expect(canvas.getBoundingClientRect().width).toBe(choice === "a" ? 320 : 160);
      expect(canvas.getBoundingClientRect().height).toBe(160);
      value.recorder.flush(40 * (index + 1));
      expect(value.canvas()).toBe(canvas);
      // Fixed synthetic scalars retain the exact crossed boundary on failure;
      // no authored source, received exception or user chart state is copied.
      expect(
        canvas.dataset.cafeFluidState,
        JSON.stringify({
          click: index + 1,
          trustedClicks: value.document.documentElement.dataset.fixtureTrustedClicks,
          logicalVisible: value.document.documentElement.dataset.cafeVisible,
          hidden: value.document.hidden,
          reducedMotion: value.window.matchMedia("(prefers-reduced-motion: reduce)").matches,
          width: canvas.getBoundingClientRect().width,
          height: canvas.getBoundingClientRect().height,
          bufferWidth: canvas.width,
          bufferHeight: canvas.height,
          rejectedWidth: canvas.dataset.cafeFluidRejectedWidth ?? null,
          rejectedHeight: canvas.dataset.cafeFluidRejectedHeight ?? null,
          frames: frames(value),
          textures: value.recorder.summary().textures,
          pending: value.recorder.pending(),
        }),
      ).toBe("running");
      expect(frames(value)).toBe(13 + index);
      expect(value.recorder.pending()).toBe(1);
      const current = value.recorder.summary();
      expect(current).toMatchObject({
        textures: 8,
        framebuffers: 8,
        programs: 10,
        shaders: 12,
        buffers: 2,
        peakTextures: 8,
        contextRequests: 1,
        maxPending: 1,
        solverClearsAfterDraw: 0,
      });
      expect(current.peakTextureBytes).toBeLessThanOrEqual(16 * 1024 * 1024);
      expect(canvas.width).toBeLessThanOrEqual(512);
      expect(canvas.height).toBeLessThanOrEqual(512);
      if (index < 7) {
        expect(current.createdTextures - initial.createdTextures).toBe(8 * (index + 1));
        expect(current.deletedTextures - initial.deletedTextures).toBe(8 * (index + 1));
        const scale = Math.min(
          value.window.devicePixelRatio,
          512 / Math.max(choice === "a" ? 320 : 160, 160),
        );
        expect(canvas.width).toBe(Math.floor((choice === "a" ? 320 : 160) * scale));
        expect(canvas.height).toBe(Math.floor(160 * scale));
        if (index === 6) {
          retained = current;
          retainedSize = [canvas.width, canvas.height];
        }
      } else {
        expect(current.createdTextures).toBe(retained!.createdTextures);
        expect(current.deletedTextures).toBe(retained!.deletedTextures);
        expect(current.textureBytes).toBe(retained!.textureBytes);
        expect(current.textureIds).toEqual(retained!.textureIds);
        expect(current.framebufferIds).toEqual(retained!.framebufferIds);
        expect([canvas.width, canvas.height]).toEqual(retainedSize);
      }
    }
    expect(value.document.documentElement.dataset.fixtureTrustedClicks).toBe("24");
  });

  it("coalesces native chart-layout bursts and performs no allocation for unchanged controls", async () => {
    const value = await fixture({ visible: true, interactiveLayout: true });
    const initial = value.recorder.summary();
    for (let index = 0; index < 20; index++) await clickChart(value, "same");
    expect(value.canvas().getBoundingClientRect().width).toBe(320);
    expect(frames(value)).toBe(12);
    value.recorder.flush(40);
    expect(frames(value)).toBe(13);
    expect(value.recorder.summary()).toMatchObject({
      createdTextures: initial.createdTextures,
      deletedTextures: initial.deletedTextures,
      textureIds: initial.textureIds,
      framebufferIds: initial.framebufferIds,
      solverClearsAfterDraw: 0,
      maxPending: 1,
    });
    for (const choice of ["b", "a", "b", "a", "b"] as const) await clickChart(value, choice);
    expect(value.canvas().getBoundingClientRect().width).toBe(160);
    expect(frames(value)).toBe(13);
    expect(value.recorder.summary().createdTextures).toBe(initial.createdTextures);
    value.recorder.flush(80);
    expect(frames(value)).toBe(14);
    expect([value.canvas().width, value.canvas().height]).toEqual(physicalSize(value));
    const changed = value.recorder.summary();
    expect(changed.createdTextures - initial.createdTextures).toBe(8);
    expect(changed.deletedTextures - initial.deletedTextures).toBe(8);
    expect(changed).toMatchObject({ peakTextures: 8, maxPending: 1, solverClearsAfterDraw: 0 });
    // More controls that leave the current physical layout unchanged never
    // consume admission slots or schedule another simultaneous solver frame.
    for (let index = 0; index < 20; index++) await clickChart(value, "same");
    value.recorder.flush(120);
    expect(frames(value)).toBe(15);
    expect(value.recorder.summary()).toMatchObject({
      createdTextures: changed.createdTextures,
      deletedTextures: changed.deletedTextures,
      textureIds: changed.textureIds,
      framebufferIds: changed.framebufferIds,
      contextRequests: 1,
      maxPending: 1,
    });
    expect(value.document.documentElement.dataset.fixtureTrustedClicks).toBe("45");
  });

  it.each(["logical", "paint"] as const)(
    "does no native layout work under the %s mask and adopts only its latest geometry",
    async (cue) => {
      const value = await fixture({ visible: true, interactiveLayout: true });
      const initial = value.recorder.summary();
      const mask = cue === "logical" ? value.visible : value.presentationVisible;
      mask(false);
      for (const choice of ["b", "a", "b", "a", "b"] as const) await clickChart(value, choice);
      expect(value.canvas().getBoundingClientRect().width).toBe(160);
      value.recorder.flush(40);
      expect(frames(value)).toBe(12);
      expect(value.recorder.pending()).toBe(0);
      expect(value.recorder.summary()).toMatchObject({
        draws: initial.draws,
        createdTextures: initial.createdTextures,
        deletedTextures: initial.deletedTextures,
        textureIds: initial.textureIds,
        framebufferIds: initial.framebufferIds,
      });
      mask(true);
      value.recorder.flush(80);
      expect(frames(value)).toBe(13);
      expect(value.canvas().dataset.cafeFluidState).toBe("running");
      expect([value.canvas().width, value.canvas().height]).toEqual(physicalSize(value));
      expect(value.recorder.summary()).toMatchObject({
        createdTextures: initial.createdTextures + 8,
        deletedTextures: initial.deletedTextures + 8,
        peakTextures: 8,
        maxPending: 1,
        solverClearsAfterDraw: 0,
      });
    },
  );

  it("never revives post-cap invalid geometry through later native chart buttons", async () => {
    const value = await fixture({ visible: true, interactiveLayout: true });
    for (let index = 0; index < 7; index++) {
      await clickChart(value, index % 2 === 0 ? "b" : "a");
      value.recorder.flush(40 * (index + 1));
    }
    const retained = value.recorder.summary();
    value.document.querySelector<HTMLElement>("[data-fluid-scene]")!.style.width = "4097px";
    value.recorder.flush(320);
    expect(value.canvas().dataset.cafeFluidState).toBe("unsupported");
    expect(value.canvas().dataset.cafeFluidRejectedWidth).toBe("unknown");
    expect(value.recorder.summary()).toMatchObject({
      textures: 0,
      framebuffers: 0,
      programs: 0,
      shaders: 0,
      buffers: 0,
      listeners: 0,
      resizeObservers: 0,
      mutationObservers: 0,
      createdTextures: retained.createdTextures,
      deletedTextures: retained.deletedTextures + 8,
    });
    await clickChart(value, "a");
    value.visible(false);
    value.visible(true);
    value.recorder.flush(360);
    expect(value.canvas().getBoundingClientRect().width).toBe(320);
    expect(value.canvas().dataset.cafeFluidState).toBe("unsupported");
    expect(value.recorder.pending()).toBe(0);
    expect(value.recorder.summary().contextRequests).toBe(1);
    expect(value.recorder.summary().createdTextures).toBe(retained.createdTextures);
  });

  it("keeps post-cap cooperative reduced-motion output static through native chart buttons", async () => {
    const value = await fixture({ visible: true, interactiveLayout: true });
    // This is the existing document-level cooperative cue, not a replacement
    // for the independently observed native no-preference context. Native
    // reduced-motion renderer qualification remains in its separate project.
    value.document.documentElement.dataset.cafeReducedMotion = "true";
    value.window.dispatchEvent(new Event("cafe-presentation-changed"));
    expect(value.window.matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(false);
    for (let index = 0; index < 7; index++) {
      await clickChart(value, index % 2 === 0 ? "b" : "a");
      value.window.dispatchEvent(new Event("cafe-presentation-changed"));
      expect(frames(value)).toBe(12 * (index + 2));
      expect(value.recorder.pending()).toBe(0);
    }
    const retained = value.recorder.summary();
    const size = [value.canvas().width, value.canvas().height];
    for (let index = 0; index < 24; index++) {
      await clickChart(value, index % 2 === 0 ? "a" : "b");
      value.window.dispatchEvent(new Event("cafe-presentation-changed"));
      value.recorder.flush(40 * (index + 1));
      expect(value.canvas().dataset.cafeFluidState).toBe("static");
      expect(frames(value)).toBe(96);
      expect(value.recorder.pending()).toBe(0);
      expect([value.canvas().width, value.canvas().height]).toEqual(size);
      expect(value.recorder.summary()).toMatchObject({
        draws: retained.draws,
        createdTextures: retained.createdTextures,
        deletedTextures: retained.deletedTextures,
        textureIds: retained.textureIds,
        framebufferIds: retained.framebufferIds,
        contextRequests: 1,
        solverClearsAfterDraw: 0,
      });
    }
  });

  it.each(["context-loss", "pagehide"] as const)(
    "retires retained post-cap resources on %s without revival from native buttons",
    async (reason) => {
      const value = await fixture({ visible: true, interactiveLayout: true });
      const canvas = value.canvas();
      for (let index = 0; index < 7; index++) {
        await clickChart(value, index % 2 === 0 ? "b" : "a");
        value.recorder.flush(40 * (index + 1));
      }
      const retained = value.recorder.summary();
      if (reason === "context-loss") canvas.dispatchEvent(new Event("webglcontextlost"));
      else value.window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false }));
      expect(canvas.dataset.cafeFluidState).toBe(
        reason === "context-loss" ? "context-lost" : "disposed",
      );
      expect(value.recorder.summary()).toMatchObject({
        textures: 0,
        framebuffers: 0,
        programs: 0,
        shaders: 0,
        buffers: 0,
        textureBytes: 0,
        listeners: 0,
        resizeObservers: 0,
        mutationObservers: 0,
        createdTextures: retained.createdTextures,
        deletedTextures: retained.deletedTextures + 8,
      });
      await clickChart(value, "a");
      value.visible(false);
      value.visible(true);
      value.window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false }));
      value.recorder.flush(320);
      expect(canvas.dataset.cafeFluidState).toBe(
        reason === "context-loss" ? "context-lost" : "disposed",
      );
      expect(value.recorder.pending()).toBe(0);
      expect(value.recorder.summary().contextRequests).toBe(1);
      expect(value.recorder.summary().createdTextures).toBe(retained.createdTextures);
      expect(value.recorder.summary().deletedTextures).toBe(retained.deletedTextures + 8);
    },
  );

  it("continues actual native WebGL pixels after exhausting size admissions with trusted chart buttons", async () => {
    expect(window.matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(false);
    expect(window.matchMedia("(hover: hover)").matches).toBe(true);
    expect(window.matchMedia("(pointer: fine)").matches).toBe(true);
    const value = await createNativeFluidFixture();
    nativeFixtures.push(value);
    expect(value.window.matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(false);
    expect(value.window.matchMedia("(hover: hover)").matches).toBe(true);
    expect(value.window.matchMedia("(pointer: fine)").matches).toBe(true);
    expect((value.window as Window & { __fluidFixture?: unknown }).__fluidFixture).toBeUndefined();
    const canvas = value.canvas();
    // A native unsupported/absent driver is a qualification failure, not an
    // excuse to use a recorder, skip this host or add permissive native flags.
    expect(canvas.dataset.cafeFluidState).toBe("running");
    const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    expect(gl).not.toBeNull();
    expect(gl!.getParameter(gl!.VERSION)).toMatch(/^WebGL/);
    await expect.poll(() => frames(value)).toBeGreaterThan(12);
    for (let index = 0; index < 7; index++) {
      const before = frames(value);
      const choice = index % 2 === 0 ? "b" : "a";
      await clickChart(value, choice);
      expect(canvas.getBoundingClientRect().width).toBe(choice === "a" ? 320 : 160);
      expect(canvas.getBoundingClientRect().height).toBe(160);
      await expect.poll(() => [canvas.width, canvas.height]).toEqual(physicalSize(value));
      await expect.poll(() => frames(value)).toBeGreaterThan(before);
      expect(canvas.dataset.cafeFluidState).toBe("running");
    }
    const size = [canvas.width, canvas.height];
    const beforeFrames = frames(value);
    const beforePixels = await nativePixelDigest(canvas, gl!);
    for (let index = 0; index < 24; index++) {
      const before = frames(value);
      const choice = index % 2 === 0 ? "a" : "b";
      await clickChart(value, choice);
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
    }
    const afterPixels = await nativePixelDigest(canvas, gl!);
    expect(frames(value)).toBeGreaterThanOrEqual(beforeFrames + 24);
    expect(afterPixels).not.toBe(beforePixels);
    expect(value.document.documentElement.dataset.fixtureTrustedClicks).toBe("31");
    value.visible(false);
    const paused = frames(value);
    const pausedPixels = await nativePixelDigest(canvas, gl!);
    await clickChart(value, "a");
    expect(canvas.dataset.cafeFluidState).toBe("paused");
    expect(canvas.dataset.cafeFluidRaf).toBe("false");
    expect(frames(value)).toBe(paused);
    expect(await nativePixelDigest(canvas, gl!)).toBe(pausedPixels);
    expect([canvas.width, canvas.height]).toEqual(size);
    value.visible(true);
    await expect.poll(() => frames(value)).toBeGreaterThan(paused + 2);
    expect(await nativePixelDigest(canvas, gl!)).not.toBe(pausedPixels);
  });

  it("bounds extreme aspect ratios and refuses invalid size before context allocation", async () => {
    const wide = await fixture({ width: 4096, height: 1 });
    expect(wide.canvas().width).toBe(512);
    expect(wide.canvas().height).toBe(1);
    expect(
      wide.recorder
        .summary()
        .textureSizes.every(
          ([width, height]) => width <= 1024 && height <= 1024 && width > 0 && height > 0,
        ),
    ).toBe(true);
    expect(wide.recorder.summary().peakTextureBytes).toBeLessThanOrEqual(16 * 1024 * 1024);
    const rejected = await fixture({ width: 4097, height: 200 });
    expect(rejected.canvas().dataset.cafeFluidState).toBe("unsupported");
    expect(rejected.recorder.summary().contextRequests).toBe(0);
    expect(rejected.recorder.pending()).toBe(0);
  });

  it.each([1601, 4096])(
    "runs at logical width %s without increasing physical resource or frame quotas",
    async (width) => {
      const value = await fixture({ width, height: 320, visible: true });
      expect(value.canvas().getBoundingClientRect().width).toBe(width);
      expect(value.canvas().width).toBeLessThanOrEqual(512);
      expect(value.canvas().height).toBeLessThanOrEqual(512);
      value.recorder.flush(40);
      expect(value.canvas().dataset.cafeFluidState).toBe("running");
      expect(frames(value)).toBe(13);
      expect(value.recorder.pending()).toBe(1);
      expect(value.recorder.summary()).toMatchObject({
        textures: 8,
        framebuffers: 8,
        programs: 10,
        shaders: 12,
        buffers: 2,
        maxPending: 1,
      });
      expect(value.recorder.summary().peakTextureBytes).toBeLessThanOrEqual(16 * 1024 * 1024);
      expect(
        value.recorder
          .summary()
          .textureSizes.every(([w, h]) => w >= 1 && w <= 1024 && h >= 1 && h <= 1024),
      ).toBe(true);
      const resources = value.recorder.summary().createdTextures;
      value.recorder.flush(41);
      expect(frames(value)).toBe(13);
      expect(value.recorder.summary().createdTextures).toBe(resources);
      value.visible(false);
      expect(value.recorder.pending()).toBe(0);
    },
  );

  it("waits at zero initial layout without GL or RAF until a genuine resize provides valid geometry", async () => {
    const value = await fixture({ width: 0, height: 0, visible: true });
    expect(value.canvas().dataset.cafeFluidState).toBe("waiting");
    expect(value.recorder.summary()).toMatchObject({
      contextRequests: 0,
      textures: 0,
      programs: 0,
      buffers: 0,
      resizeObservers: 1,
      mutationObservers: 1,
    });
    for (let time = 40; time <= 4000; time += 40) value.recorder.flush(time);
    expect(value.recorder.pending()).toBe(0);
    expect(frames(value)).toBe(0);
    // No fabricated observer callback: actual CSS layout change is delivered
    // through the native browser's ResizeObserver in this fixture document.
    value.canvas().style.width = "320px";
    value.canvas().style.height = "160px";
    await expect.poll(() => value.canvas().dataset.cafeFluidState).toBe("running");
    expect(value.recorder.summary()).toMatchObject({
      contextRequests: 1,
      textures: 8,
      programs: 10,
      buffers: 2,
      resizeObservers: 1,
      mutationObservers: 1,
      peakObservers: 2,
      solverClearsAfterDraw: 0,
    });
    expect(frames(value)).toBe(12);
    expect(value.recorder.pending()).toBe(1);
  });

  it("exhausts bounded zero-layout observations without retries or allocations after terminal refusal", async () => {
    const value = await fixture({ width: 0, height: 0, visible: true });
    expect(value.canvas().dataset.cafeFluidState).toBe("waiting");
    let observations = 0;
    while (value.canvas().dataset.cafeFluidState === "waiting" && observations < 8) {
      value.visible(false);
      observations++;
    }
    expect(observations).toBeLessThanOrEqual(8);
    expect(value.canvas().dataset.cafeFluidState).toBe("unsupported");
    expect(value.canvas().dataset.cafeFluidLayoutObservations).toBe("8");
    expect(value.recorder.summary()).toMatchObject({
      contextRequests: 0,
      textures: 0,
      programs: 0,
      buffers: 0,
      listeners: 0,
      resizeObservers: 0,
      mutationObservers: 0,
      peakObservers: 2,
    });
    value.canvas().style.width = "320px";
    value.canvas().style.height = "160px";
    value.visible(true);
    value.window.dispatchEvent(new Event("cafe-presentation-changed"));
    for (let time = 40; time <= 4000; time += 40) value.recorder.flush(time);
    expect(value.canvas().dataset.cafeFluidState).toBe("unsupported");
    expect(value.recorder.summary().contextRequests).toBe(0);
    expect(value.recorder.pending()).toBe(0);
  });

  it("refuses an invalid positive startup layout permanently before GL allocation", async () => {
    const value = await fixture({ width: 0, height: 0, visible: true });
    expect(value.canvas().dataset.cafeFluidState).toBe("waiting");
    value.canvas().style.width = "4097px";
    value.canvas().style.height = "200px";
    await expect.poll(() => value.canvas().dataset.cafeFluidState).toBe("unsupported");
    expect(value.recorder.summary()).toMatchObject({
      contextRequests: 0,
      listeners: 0,
      resizeObservers: 0,
      mutationObservers: 0,
    });
    value.canvas().style.width = "320px";
    value.visible(true);
    expect(value.canvas().dataset.cafeFluidState).toBe("unsupported");
    expect(value.recorder.summary().contextRequests).toBe(0);
    expect(value.recorder.pending()).toBe(0);
  });

  it("releases all pending startup observers and listeners on own removal or pagehide", async () => {
    const removed = await fixture({ width: 0, height: 0, visible: true });
    const canvas = removed.canvas();
    expect(canvas.dataset.cafeFluidState).toBe("waiting");
    canvas.remove();
    await expect.poll(() => canvas.dataset.cafeFluidState).toBe("disposed");
    expect(removed.recorder.summary()).toMatchObject({
      contextRequests: 0,
      textures: 0,
      listeners: 0,
      resizeObservers: 0,
      mutationObservers: 0,
    });
    expect(removed.recorder.pending()).toBe(0);
    const hidden = await fixture({ width: 0, height: 0, visible: true });
    const hiddenCanvas = hidden.canvas();
    expect(hiddenCanvas.dataset.cafeFluidState).toBe("waiting");
    hidden.dispose();
    expect(hiddenCanvas.dataset.cafeFluidState).toBe("disposed");
    expect(hidden.recorder.summary()).toMatchObject({
      contextRequests: 0,
      textures: 0,
      listeners: 0,
      resizeObservers: 0,
      mutationObservers: 0,
    });
    expect(hidden.recorder.pending()).toBe(0);
  });

  it("rejects synthetic pointers and coalesces more than six real passive interactions without frame renewal", async () => {
    const value = await fixture({ visible: true });
    for (let time = 40; time <= 20_000; time += 40) value.recorder.flush(time);
    for (let index = 0; index < 1000; index++)
      value.window.dispatchEvent(
        new PointerEvent("pointermove", { clientX: 20, clientY: 20, cancelable: true }),
      );
    expect(value.recorder.pending()).toBe(1);
    expect(frames(value)).toBe(512);
    expect(Number(value.canvas().dataset.cafeFluidPointerInputs)).toBe(0);
    // The existing provider owns this actual mouse event; it is not a forged
    // isTrusted field or browser media override. Canvas remains pointer-inert.
    let time = 20_000;
    for (let interaction = 0; interaction < 9; interaction++) {
      await userEvent.hover(value.frame, { position: { x: 100 + interaction * 10, y: 60 } });
      expect(value.recorder.pending()).toBe(1);
      value.recorder.flush((time += 40));
      expect(Number(value.canvas().dataset.cafeFluidPointerInputs)).toBe(interaction + 1);
      expect(frames(value)).toBe(513 + interaction);
    }
    // Several genuine deliveries before a frame are one latest bounded input,
    // not a growing event queue or another concurrent animation loop.
    for (let interaction = 0; interaction < 8; interaction++)
      await userEvent.hover(value.frame, { position: { x: 120 + interaction * 10, y: 70 } });
    expect(Number(value.canvas().dataset.cafeFluidPointerInputs)).toBe(9);
    value.recorder.flush((time += 40));
    expect(Number(value.canvas().dataset.cafeFluidPointerInputs)).toBe(10);
    expect(frames(value)).toBe(522);
    expect(value.recorder.pending()).toBe(1);
    expect(value.recorder.summary().maxPending).toBe(1);
    value.visible(false);
    expect(value.recorder.pending()).toBe(0);
    expect(value.recorder.summary().textures).toBe(8);
  });

  it("releases listeners, frames and every exact GL object on context loss or removal", async () => {
    const lost = await fixture({ visible: true });
    lost.canvas().dispatchEvent(new Event("webglcontextlost"));
    expect(lost.canvas().dataset.cafeFluidState).toBe("context-lost");
    expect(lost.recorder.pending()).toBe(0);
    expect(lost.recorder.summary()).toMatchObject({
      textures: 0,
      framebuffers: 0,
      programs: 0,
      shaders: 0,
      buffers: 0,
      textureBytes: 0,
      listeners: 0,
    });
    lost.visible(true);
    expect(lost.recorder.pending()).toBe(0);
    const removed = await fixture({ visible: true });
    const canvas = removed.canvas();
    canvas.remove();
    await expect.poll(() => canvas.dataset.cafeFluidState).toBe("disposed");
    expect(removed.recorder.pending()).toBe(0);
    expect(removed.recorder.summary()).toMatchObject({
      textures: 0,
      framebuffers: 0,
      programs: 0,
      shaders: 0,
      buffers: 0,
      textureBytes: 0,
      listeners: 0,
    });
  });

  it("retains readable static fallback without WebGL and tears down exactly once on pagehide", async () => {
    const unsupported = await fixture({ noWebgl: true, visible: true });
    expect(unsupported.canvas().dataset.cafeFluidState).toBe("unsupported");
    expect(unsupported.document.body.textContent).toContain(
      "Readable chart labels remain ordinary DOM.",
    );
    expect(unsupported.canvas().style.background).toContain("linear-gradient");
    expect(unsupported.recorder.pending()).toBe(0);
    expect(unsupported.recorder.summary().textures).toBe(0);
    const active = await fixture({ visible: true });
    active.dispose();
    const first = active.recorder.summary();
    active.dispose();
    expect(active.recorder.summary()).toEqual(first);
    expect(first).toMatchObject({
      textures: 0,
      framebuffers: 0,
      programs: 0,
      shaders: 0,
      buffers: 0,
      textureBytes: 0,
      listeners: 0,
    });
    expect(active.recorder.pending()).toBe(0);
  });

  it("disposes successful partial allocations when a format or later buffer fails", async () => {
    for (const options of [{ noFormats: true }, { failSecondBuffer: true }]) {
      const value = await fixture({ ...options, visible: true });
      expect(value.canvas().dataset.cafeFluidState).toBe("unsupported");
      expect(value.recorder.pending()).toBe(0);
      expect(value.recorder.summary()).toMatchObject({
        textures: 0,
        framebuffers: 0,
        programs: 0,
        shaders: 0,
        buffers: 0,
        textureBytes: 0,
        listeners: 0,
      });
    }
  });
});
