import {
  VISUALIZATION_FLUID_RUNTIME_SOURCE,
  visualizationFluidScript,
} from "@cafecode/shared/visualizationFluidRuntime";
import { afterEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { createFluidFixture, type FluidFixture } from "./visualizationFluid.fixture";

const fixtures: FluidFixture[] = [];
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

function frames(value: FluidFixture) {
  return Number(value.canvas().dataset.cafeFluidFrames);
}

/** All GL resource counts and scheduling are recorded in the document-local
 * driver, not inferred from the engine's own counters. These tests qualify
 * lifecycle/accounting, not physical GPU memory, pixels or native retirement. */
describe("generated fluid decoration lifecycle", () => {
  afterEach(() => {
    for (const value of fixtures.splice(0)) {
      value.dispose();
      expect(value.recorder.summary()).toMatchObject({ resizeObservers: 0, mutationObservers: 0 });
    }
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
    // The initial admitted size already consumed one of the finite eight sizes.
    for (let index = 0; index < 7; index++) {
      value.canvas().style.width = `${170 + index}px`;
      value.recorder.flush(80 + index * 40);
    }
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
