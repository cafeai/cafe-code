import { Script } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  VISUALIZATION_FLUID_DIAGNOSTIC_COUNTER_MAX,
  VISUALIZATION_FLUID_RUNTIME_SOURCE,
  visualizationFluidScript,
} from "./visualizationFluidRuntime.ts";

/** Synthetic ordinary-page APIs execute only the fixed library, never received
 * source, a native runtime, user profile or real GPU. Real shader/pixel evidence
 * belongs to the explicit native fixture, independently of these ledger tests. */
function fixture(
  options: {
    markers?: number;
    unsupported?: boolean;
    rgbaFallback?: boolean;
    secondBufferNull?: boolean;
    initialZero?: boolean;
    presentationVisible?: "true" | "false";
    counterLimit?: number;
  } = {},
) {
  const listeners = new Map<object, Map<string, Set<(event?: unknown) => void>>>();
  function events<T extends object>(target: T) {
    return Object.assign(target, {
      addEventListener(type: string, listener: (event?: unknown) => void) {
        const types = listeners.get(target) ?? new Map();
        const set = types.get(type) ?? new Set();
        set.add(listener);
        types.set(type, set);
        listeners.set(target, types);
      },
      removeEventListener(type: string, listener: (event?: unknown) => void) {
        listeners.get(target)?.get(type)?.delete(listener);
      },
    });
  }
  const owned = {
    textures: new Set(),
    framebuffers: new Set(),
    programs: new Set(),
    shaders: new Set(),
    buffers: new Set(),
  };
  let draws = 0,
    peakTextures = 0,
    contextCalls = 0,
    bufferAttempts = 0,
    randomCalls = 0,
    maxTrigonometricArgument = 0;
  const shaderSources: string[] = [];
  const allocations: { width: number; height: number; channels: number }[] = [];
  const cleared: unknown[] = [];
  let framebuffer: unknown = null;
  const constants = [
    "RED",
    "RG",
    "RGBA",
    "RGBA16F",
    "RG16F",
    "R16F",
    "HALF_FLOAT",
    "MAX_TEXTURE_SIZE",
    "FRAMEBUFFER_COMPLETE",
    "LINK_STATUS",
    "ACTIVE_UNIFORMS",
    "COMPILE_STATUS",
  ] as const;
  const gl: Record<string, unknown> = Object.fromEntries(
    constants.map((key, index) => [key, index + 1]),
  );
  for (const [name, set] of Object.entries(owned)) {
    const singular =
      name === "framebuffers"
        ? "Framebuffer"
        : name.slice(0, -1).replace(/^./, (letter) => letter.toUpperCase());
    gl[`create${singular}`] = () => {
      if (name === "buffers" && ++bufferAttempts === 2 && options.secondBufferNull) return null;
      const value = {};
      set.add(value);
      peakTextures = Math.max(peakTextures, owned.textures.size);
      return value;
    };
    gl[`delete${singular}`] = (value: object) => {
      set.delete(value);
    };
  }
  for (const name of [
    "bindTexture",
    "texParameteri",
    "bindFramebuffer",
    "framebufferTexture2D",
    "clearColor",
    "clear",
    "activeTexture",
    "viewport",
    "shaderSource",
    "compileShader",
    "attachShader",
    "bindAttribLocation",
    "linkProgram",
    "useProgram",
    "uniform1i",
    "uniform1f",
    "uniform2f",
    "uniform3f",
    "bindBuffer",
    "bufferData",
    "vertexAttribPointer",
    "enableVertexAttribArray",
    "disable",
    "enable",
    "blendFunc",
  ])
    gl[name] = () => {};
  gl.texImage2D = (
    _target: unknown,
    _level: unknown,
    _internal: unknown,
    width: number,
    height: number,
    _border: unknown,
    format: unknown,
  ) =>
    allocations.push({ width, height, channels: format === gl.RED ? 1 : format === gl.RG ? 2 : 4 });
  gl.shaderSource = (_shader: unknown, source: string) => {
    shaderSources.push(source);
  };
  gl.checkFramebufferStatus = () => gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer = (_target: unknown, value: unknown) => {
    framebuffer = value;
  };
  gl.clear = () => {
    cleared.push(framebuffer);
  };
  gl.getExtension = () => ({ HALF_FLOAT_OES: 20 });
  gl.getShaderParameter = () => true;
  gl.getProgramParameter = (_program: unknown, parameter: unknown) =>
    parameter === gl.ACTIVE_UNIFORMS ? 0 : true;
  gl.getParameter = () => 4096;
  gl.drawElements = () => {
    draws += 1;
  };
  gl.drawingBufferWidth = 320;
  gl.drawingBufferHeight = 180;
  class Canvas {
    dataset: Record<string, string> = {};
    style: Record<string, string> = {};
    width = 300;
    height = 150;
    isConnected = true;
    parentNode = {};
    rect = { left: 0, top: 0, right: 320, bottom: 180, width: 320, height: 180 };
    getBoundingClientRect() {
      return this.rect;
    }
    setAttribute() {}
    getContext(type: string) {
      contextCalls += 1;
      return options.unsupported || (options.rgbaFallback && type === "webgl2") ? null : gl;
    }
  }
  const canvas = events(new Canvas());
  if (options.initialZero)
    canvas.rect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  const document = events({
    hidden: false,
    readyState: "complete",
    documentElement: {
      dataset: {
        cafeVisible: "false",
        cafeReducedMotion: "false",
        ...(options.presentationVisible === undefined
          ? {}
          : { cafePresentationVisible: options.presentationVisible }),
      },
    },
    querySelectorAll: () => Array.from({ length: options.markers ?? 1 }, () => canvas),
  });
  const motion = events({ matches: false });
  const window = events({ devicePixelRatio: 1 });
  const rafs = new Map<number, (time: number) => void>();
  let next = 0,
    now = 0;
  const observers: (() => void)[] = [];
  class Observer {
    private callback: () => void;
    constructor(callback: () => void) {
      this.callback = callback;
      observers.push(callback);
    }
    observe() {}
    disconnect() {
      observers.splice(observers.indexOf(this.callback), 1);
    }
  }
  new Script(VISUALIZATION_FLUID_RUNTIME_SOURCE).runInNewContext({
    document,
    window,
    HTMLCanvasElement: Canvas,
    matchMedia: () => motion,
    ResizeObserver: Observer,
    MutationObserver: Observer,
    performance: { now: () => now },
    // An instrumented, smaller diagnostic saturation point makes the otherwise
    // unreachable MAX_SAFE_INTEGER boundary testable without a mutable helper
    // API. Numeric validity and resource admissions use the real Number APIs.
    Number: {
      isFinite: Number.isFinite,
      isInteger: Number.isInteger,
      isSafeInteger: Number.isSafeInteger,
      MAX_SAFE_INTEGER: options.counterLimit ?? Number.MAX_SAFE_INTEGER,
    },
    // Stable instrumentation functions avoid creating a new closure for every
    // sample in the real long-run phase-wrap case. They retain actual trig math
    // and record only one bounded maximum, not a lifetime list of arguments.
    Math: Object.assign(Object.create(Math) as typeof Math, {
      random() {
        randomCalls++;
        return 0.5;
      },
      sin(argument: number) {
        maxTrigonometricArgument = Math.max(maxTrigonometricArgument, Math.abs(argument));
        return Math.sin(argument);
      },
      cos(argument: number) {
        maxTrigonometricArgument = Math.max(maxTrigonometricArgument, Math.abs(argument));
        return Math.cos(argument);
      },
    }),
    requestAnimationFrame(callback: (time: number) => void) {
      const id = ++next;
      rafs.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id: number) {
      rafs.delete(id);
    },
  });
  const fire = (target: object, type: string, event?: unknown) => {
    for (const callback of listeners.get(target)?.get(type) ?? []) callback(event);
  };
  const tick = () => {
    now += 34;
    const callbacks = [...rafs.values()];
    rafs.clear();
    for (const callback of callbacks) callback(now);
  };
  return {
    canvas,
    document,
    window,
    motion,
    owned,
    allocations,
    cleared,
    rafs,
    observers,
    fire,
    tick,
    draws: () => draws,
    contextCalls: () => contextCalls,
    peakTextures: () => peakTextures,
    shaderSources,
    randomCalls: () => randomCalls,
    maxTrigonometricArgument: () => maxTrigonometricArgument,
    liveListeners: () =>
      [...listeners.values()].reduce(
        (sum, types) => sum + [...types.values()].reduce((count, set) => count + set.size, 0),
        0,
      ),
  };
}

describe("fixed generated fluid library", () => {
  it("embeds a bounded licensed ordinary-page constant only for generated documents", () => {
    expect(VISUALIZATION_FLUID_DIAGNOSTIC_COUNTER_MAX).toBe(Number.MAX_SAFE_INTEGER);
    expect(VISUALIZATION_FLUID_RUNTIME_SOURCE).toContain(
      "Math.min(Number.MAX_SAFE_INTEGER,value+1)",
    );
    expect(Buffer.byteLength(VISUALIZATION_FLUID_RUNTIME_SOURCE, "utf8")).toBeLessThanOrEqual(
      65_536,
    );
    expect(VISUALIZATION_FLUID_RUNTIME_SOURCE).not.toMatch(
      /<\/script|fetch\(|XMLHttpRequest|ipcRenderer|createNoiseTexture|bloomProgram|bloomFramebuffers/i,
    );
    expect(VISUALIZATION_FLUID_RUNTIME_SOURCE).toContain("Copyright (c) Pavel Dobryakov");
    expect(VISUALIZATION_FLUID_RUNTIME_SOURCE).toContain('THE SOFTWARE IS PROVIDED "AS IS"');
    expect(VISUALIZATION_FLUID_RUNTIME_SOURCE).toContain("vec2 force = 0.5");
    expect(VISUALIZATION_FLUID_RUNTIME_SOURCE).toContain(
      "float pressure = (L + R + B + T - divergence) * 0.25",
    );
    expect(visualizationFluidScript("mcp-app")).toBe("");
    expect(visualizationFluidScript("generated")).toBe(
      "<script>" + VISUALIZATION_FLUID_RUNTIME_SOURCE + "</script>",
    );
  });
  it.each([0, 2, 20])("allocates nothing when exact marker cardinality is %s", (markers) => {
    const value = fixture({ markers });
    expect(value.contextCalls()).toBe(0);
    expect(value.draws()).toBe(0);
    expect(value.rafs.size).toBe(0);
    expect(value.liveListeners()).toBe(0);
  });
  it("releases the first exact buffer when the second allocation is unavailable", () => {
    const value = fixture({ secondBufferNull: true });
    expect(value.canvas.dataset.cafeFluidState).toBe("unsupported");
    expect(Object.values(value.owned).every((set) => set.size === 0)).toBe(true);
    expect(value.rafs.size).toBe(0);
    expect(value.liveListeners()).toBe(0);
  });
  it("defers a genuine zero startup layout without GL or RAF and initializes once after positive observation", () => {
    const value = fixture({ initialZero: true });
    expect(value.canvas.dataset.cafeFluidState).toBe("waiting");
    expect(value.contextCalls()).toBe(0);
    expect(value.rafs.size).toBe(0);
    expect(value.observers).toHaveLength(2);
    expect(value.liveListeners()).toBe(4);
    value.canvas.rect = { left: 0, top: 0, right: 320, bottom: 180, width: 320, height: 180 };
    value.observers[0]!();
    expect(value.contextCalls()).toBe(1);
    expect(value.canvas.dataset.cafeFluidFrames).toBe("12");
    expect(value.owned.textures.size).toBe(8);
    expect(value.rafs.size).toBe(0);
    value.fire(value.window, "cafe-presentation-changed");
    expect(value.contextCalls()).toBe(1);
  });
  it("exhausts at the eighth zero observation without any GPU retry", () => {
    const value = fixture({ initialZero: true });
    for (let i = 0; i < 7; i++) value.fire(value.window, "cafe-visibility-changed");
    expect(value.canvas.dataset.cafeFluidLayoutObservations).toBe("8");
    expect(value.canvas.dataset.cafeFluidState).toBe("unsupported");
    expect(value.contextCalls()).toBe(0);
    expect(value.liveListeners()).toBe(0);
    expect(value.observers).toHaveLength(0);
    value.canvas.rect = { left: 0, top: 0, right: 320, bottom: 180, width: 320, height: 180 };
    value.fire(value.window, "cafe-visibility-changed");
    expect(value.contextCalls()).toBe(0);
  });
  it("keeps invalid positive layout terminal after pending startup", () => {
    const value = fixture({ initialZero: true });
    value.canvas.rect = { left: 0, top: 0, right: 1601, bottom: 180, width: 1601, height: 180 };
    value.observers[0]!();
    expect(value.canvas.dataset.cafeFluidState).toBe("unsupported");
    expect(value.contextCalls()).toBe(0);
    expect(value.observers).toHaveLength(0);
    expect(value.liveListeners()).toBe(0);
  });
  it.each(["pagehide", "removal"] as const)(
    "cleans exact pending observers/listeners on %s",
    (event) => {
      const value = fixture({ initialZero: true });
      if (event === "pagehide") value.fire(value.window, "pagehide");
      else {
        value.canvas.isConnected = false;
        value.observers[1]!();
      }
      expect(value.canvas.dataset.cafeFluidState).toBe("disposed");
      expect(value.contextCalls()).toBe(0);
      expect(value.rafs.size).toBe(0);
      expect(value.observers).toHaveLength(0);
      expect(value.liveListeners()).toBe(0);
    },
  );
  it("produces bounded solved static hidden poster work without any RAF", () => {
    const value = fixture();
    expect(value.canvas.dataset.cafeFluidFrames).toBe("12");
    expect(value.canvas.dataset.cafeFluidState).toBe("paused");
    expect(value.rafs.size).toBe(0);
    // Transparent page clearing must target the default drawing buffer, not
    // erase the just-swapped dye framebuffer produced by the supplied solver.
    expect(value.cleared.at(-1)).toBeNull();
    expect(value.owned.textures.size).toBe(8);
    expect(value.owned.programs.size).toBe(10);
    expect(value.owned.shaders.size).toBe(12);
    expect(value.owned.buffers.size).toBe(2);
    expect(Number(value.canvas.dataset.cafeFluidTextureBytes)).toBeLessThanOrEqual(
      16 * 1024 * 1024,
    );
  });
  it("boosts both final display paths without altering solver resources or equations", () => {
    const value = fixture();
    // The supplied solver already contains ordinary 2.0 constants. Select only
    // the two final presentation expressions, never count unrelated equations.
    const gainShaders = value.shaderSources.filter(
      (source) =>
        source.includes("texture2D(uTexture, vUv).rgb * 2.0") ||
        source.includes("C.rgb *= diffuse * 2.0"),
    );
    expect(gainShaders).toHaveLength(2);
    expect(
      gainShaders.some((source) => source.includes("texture2D(uTexture, vUv).rgb * 2.0")),
    ).toBe(true);
    expect(gainShaders.some((source) => source.includes("C.rgb *= diffuse * 2.0"))).toBe(true);
    expect(value.canvas.style.background).toBe(
      "linear-gradient(135deg,rgba(0,190,255,.24),rgba(123,44,255,.24),rgba(255,40,180,.24))",
    );
    expect(value.owned.programs.size).toBe(10);
    expect(value.owned.shaders.size).toBe(12);
    expect(value.owned.buffers.size).toBe(2);
  });
  it("accounts actual RGBA half-float fallback and deletes old targets before resize allocation", () => {
    const value = fixture({ rgbaFallback: true });
    const first = Number(value.canvas.dataset.cafeFluidTextureBytes);
    expect(first).toBeGreaterThan(0);
    expect(first).toBe(
      value.allocations
        .slice(-8)
        .reduce(
          (sum, allocation) => sum + allocation.width * allocation.height * allocation.channels * 2,
          0,
        ),
    );
    value.canvas.rect = { left: 0, top: 0, right: 1600, bottom: 2000, width: 1600, height: 2000 };
    value.document.documentElement.dataset.cafeVisible = "true";
    value.fire(value.window, "cafe-visibility-changed");
    value.tick();
    expect(value.peakTextures()).toBe(8);
    expect(value.canvas.width).toBeLessThanOrEqual(512);
    expect(value.canvas.height).toBeLessThanOrEqual(512);
    expect(Number(value.canvas.dataset.cafeFluidTextureBytes)).toBeLessThanOrEqual(
      16 * 1024 * 1024,
    );
  });
  it("pauses on both actual document and native presentation visibility without budget renewal", () => {
    const value = fixture();
    expect(value.document.documentElement.dataset.cafePresentationVisible).toBeUndefined();
    value.document.documentElement.dataset.cafeVisible = "true";
    value.fire(value.window, "cafe-visibility-changed");
    value.tick();
    const frames = Number(value.canvas.dataset.cafeFluidFrames);
    expect(frames).toBe(13);
    value.document.hidden = true;
    value.fire(value.document, "visibilitychange");
    expect(value.rafs.size).toBe(0);
    value.fire(value.window, "cafe-presentation-changed");
    expect(value.canvas.dataset.cafeFluidFrames).toBe(String(frames));
    value.document.hidden = false;
    value.fire(value.document, "visibilitychange");
    value.tick();
    expect(value.canvas.dataset.cafeFluidFrames).toBe("14");
    value.document.documentElement.dataset.cafeVisible = "false";
    value.fire(value.window, "cafe-visibility-changed");
    expect(value.rafs.size).toBe(0);
  });
  it("pauses paint-only masking without changing logical visibility or replacing solver resources", () => {
    const value = fixture({ presentationVisible: "true" });
    value.document.documentElement.dataset.cafeVisible = "true";
    value.fire(value.window, "cafe-visibility-changed");
    value.tick();
    const resources = Object.fromEntries(
      Object.entries(value.owned).map(([name, set]) => [name, [...set]]),
    );
    const allocations = value.allocations.length;
    const draws = value.draws();
    const frames = value.canvas.dataset.cafeFluidFrames;
    // The native owner publishes a separate cue, not a synthetic legacy logical
    // hide/return. Existing chart entrance handlers therefore need not replay.
    value.fire(value.window, "pointermove", { isTrusted: true, clientX: 20, clientY: 20 });
    value.document.documentElement.dataset.cafePresentationVisible = "false";
    value.fire(value.window, "cafe-presentation-visibility-changed");
    expect(value.document.documentElement.dataset.cafeVisible).toBe("true");
    expect(value.canvas.dataset.cafeFluidState).toBe("paused");
    expect(value.rafs.size).toBe(0);
    for (let index = 0; index < 100; index++) {
      value.fire(value.window, "pointermove", { isTrusted: true, clientX: 40, clientY: 40 });
      value.fire(value.window, "cafe-presentation-visibility-changed");
      value.tick();
    }
    expect(value.canvas.dataset.cafeFluidFrames).toBe(frames);
    expect(value.canvas.dataset.cafeFluidPointerInputs).toBe("0");
    expect(value.draws()).toBe(draws);
    expect(value.allocations).toHaveLength(allocations);
    value.document.documentElement.dataset.cafePresentationVisible = "true";
    value.fire(value.window, "cafe-presentation-visibility-changed");
    value.fire(value.window, "cafe-presentation-visibility-changed");
    expect(value.rafs.size).toBe(1);
    value.tick();
    expect(Number(value.canvas.dataset.cafeFluidFrames)).toBe(Number(frames) + 1);
    expect(value.canvas.dataset.cafeFluidPointerInputs).toBe("0");
    for (const [name, set] of Object.entries(value.owned))
      expect([...set]).toEqual(resources[name]);
    expect(value.allocations).toHaveLength(allocations);
    const resumedDraws = value.draws();
    value.fire(value.window, "pagehide");
    expect(value.liveListeners()).toBe(0);
    expect(value.observers).toHaveLength(0);
    expect(value.rafs.size).toBe(0);
    value.fire(value.window, "cafe-presentation-visibility-changed");
    expect(resumedDraws).toBeGreaterThan(draws);
    expect(value.draws()).toBe(resumedDraws);
    expect(value.canvas.dataset.cafeFluidFrames).toBe(String(Number(frames) + 1));
    for (const set of Object.values(value.owned)) expect(set.size).toBe(0);
  });
  it("honors the initial paint cue without weakening document/logical/reduced-motion gates", () => {
    const value = fixture({ presentationVisible: "false" });
    value.document.documentElement.dataset.cafeVisible = "true";
    value.fire(value.window, "cafe-visibility-changed");
    expect(value.canvas.dataset.cafeFluidFrames).toBe("12");
    expect(value.rafs.size).toBe(0);
    value.document.documentElement.dataset.cafePresentationVisible = "true";
    value.document.hidden = true;
    value.fire(value.window, "cafe-presentation-visibility-changed");
    expect(value.rafs.size).toBe(0);
    value.document.hidden = false;
    value.document.documentElement.dataset.cafeVisible = "false";
    value.fire(value.window, "cafe-presentation-visibility-changed");
    expect(value.rafs.size).toBe(0);
    value.document.documentElement.dataset.cafeVisible = "true";
    value.document.documentElement.dataset.cafeReducedMotion = "true";
    value.fire(value.window, "cafe-presentation-visibility-changed");
    expect(value.canvas.dataset.cafeFluidState).toBe("static");
    expect(value.canvas.dataset.cafeFluidFrames).toBe("12");
    expect(value.rafs.size).toBe(0);
    value.document.documentElement.dataset.cafePresentationVisible = "false";
    value.fire(value.window, "cafe-presentation-visibility-changed");
    value.canvas.rect = { left: 0, top: 0, right: 640, bottom: 320, width: 640, height: 320 };
    const allocations = value.allocations.length;
    value.observers[0]!();
    expect(value.allocations).toHaveLength(allocations);
    expect(value.canvas.dataset.cafeFluidFrames).toBe("12");
    value.document.documentElement.dataset.cafePresentationVisible = "true";
    value.fire(value.window, "cafe-presentation-visibility-changed");
    expect(value.canvas.dataset.cafeFluidFrames).toBe("24");
    expect(value.canvas.dataset.cafeFluidState).toBe("static");
    expect(value.rafs.size).toBe(0);
  });
  it("observes paint cues during bounded zero startup and removes the exact pending listener", () => {
    const value = fixture({ initialZero: true, presentationVisible: "false" });
    expect(value.canvas.dataset.cafeFluidState).toBe("waiting");
    expect(value.liveListeners()).toBe(4);
    value.document.documentElement.dataset.cafeVisible = "true";
    value.canvas.rect = { left: 0, top: 0, right: 320, bottom: 180, width: 320, height: 180 };
    value.fire(value.window, "cafe-presentation-visibility-changed");
    expect(value.contextCalls()).toBe(1);
    expect(value.canvas.dataset.cafeFluidFrames).toBe("12");
    expect(value.rafs.size).toBe(0);
    value.document.documentElement.dataset.cafePresentationVisible = "true";
    value.fire(value.window, "cafe-presentation-visibility-changed");
    expect(value.contextCalls()).toBe(1);
    expect(value.rafs.size).toBe(1);
    value.tick();
    expect(value.canvas.dataset.cafeFluidFrames).toBe("13");
    value.fire(value.window, "pagehide");
    expect(value.liveListeners()).toBe(0);
    expect(value.observers).toHaveLength(0);
    expect(value.rafs.size).toBe(0);
    value.fire(value.window, "cafe-presentation-visibility-changed");
    expect(value.contextCalls()).toBe(1);
  });
  it("rebuilds only changed visible static geometry with bounded warm-up and exact old-target deletion", () => {
    const value = fixture();
    value.document.documentElement.dataset.cafeVisible = "true";
    value.document.documentElement.dataset.cafeReducedMotion = "true";
    value.fire(value.window, "cafe-visibility-changed");
    const first = new Set(value.owned.textures);
    value.canvas.rect = { left: 0, top: 0, right: 640, bottom: 320, width: 640, height: 320 };
    value.observers[0]!();
    expect(value.canvas.width).toBe(512);
    expect(value.canvas.height).toBe(256);
    expect(value.canvas.dataset.cafeFluidFrames).toBe("24");
    expect(value.canvas.dataset.cafeFluidState).toBe("static");
    expect(value.rafs.size).toBe(0);
    expect(value.owned.textures.size).toBe(8);
    expect(value.owned.framebuffers.size).toBe(8);
    expect(value.owned.programs.size).toBe(10);
    expect(value.owned.buffers.size).toBe(2);
    expect([...first].some((texture) => value.owned.textures.has(texture))).toBe(false);
    expect(value.peakTextures()).toBe(8);
    expect(Number(value.canvas.dataset.cafeFluidTextureBytes)).toBeLessThanOrEqual(
      16 * 1024 * 1024,
    );
    const draws = value.draws();
    for (let index = 0; index < 100; index++) {
      value.observers[0]!();
      value.fire(value.window, "cafe-presentation-changed");
    }
    expect(value.draws()).toBe(draws);
    expect(value.canvas.dataset.cafeFluidFrames).toBe("24");
    expect(value.rafs.size).toBe(0);
    value.document.hidden = true;
    value.canvas.rect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
    value.observers[0]!();
    value.fire(value.window, "cafe-presentation-changed");
    expect(value.draws()).toBe(draws);
    expect(value.canvas.dataset.cafeFluidFrames).toBe("24");
    expect(value.owned.textures.size).toBe(8);
    value.document.hidden = false;
    value.document.documentElement.dataset.cafeVisible = "false";
    value.observers[0]!();
    expect(value.draws()).toBe(draws);
    expect(value.owned.textures.size).toBe(8);
    value.canvas.rect = { left: 0, top: 0, right: 320, bottom: 160, width: 320, height: 160 };
    value.document.documentElement.dataset.cafeVisible = "true";
    value.fire(value.window, "cafe-visibility-changed");
    expect(value.canvas.dataset.cafeFluidFrames).toBe("36");
    expect(value.canvas.width).toBe(320);
    expect(value.canvas.height).toBe(160);
    expect(value.rafs.size).toBe(0);
  });
  it("retains the eight-size static cap and retires every exact resource on a ninth size", () => {
    const value = fixture();
    value.document.documentElement.dataset.cafeVisible = "true";
    value.document.documentElement.dataset.cafeReducedMotion = "true";
    for (let index = 1; index <= 7; index++) {
      value.canvas.rect = {
        left: 0,
        top: 0,
        right: 320 + index,
        bottom: 180,
        width: 320 + index,
        height: 180,
      };
      value.fire(value.window, "cafe-presentation-changed");
      expect(value.canvas.dataset.cafeFluidFrames).toBe(String(12 * (index + 1)));
      expect(value.owned.textures.size).toBe(8);
      expect(value.rafs.size).toBe(0);
    }
    value.canvas.rect.width += 1;
    value.fire(value.window, "cafe-presentation-changed");
    expect(value.canvas.dataset.cafeFluidState).toBe("unsupported");
    expect(value.canvas.dataset.cafeFluidFrames).toBe("96");
    expect(value.peakTextures()).toBe(8);
    for (const set of Object.values(value.owned)) expect(set.size).toBe(0);
    expect(value.rafs.size).toBe(0);
    expect(value.observers).toHaveLength(0);
    expect(value.liveListeners()).toBe(0);
  });
  it("keeps a late visible static resize bounded without imposing a lifetime cutoff", () => {
    const value = fixture();
    value.document.documentElement.dataset.cafeVisible = "true";
    value.fire(value.window, "cafe-visibility-changed");
    for (let index = 12; index < 8995; index++) value.tick();
    expect(value.canvas.dataset.cafeFluidFrames).toBe("8995");
    value.document.documentElement.dataset.cafeReducedMotion = "true";
    value.canvas.rect.width = 321;
    value.fire(value.window, "cafe-presentation-changed");
    expect(value.canvas.dataset.cafeFluidState).toBe("static");
    expect(value.canvas.dataset.cafeFluidFrames).toBe("9007");
    expect(value.owned.textures.size).toBe(8);
    expect(value.peakTextures()).toBe(8);
    expect(Number(value.canvas.dataset.cafeFluidTextureBytes)).toBeLessThanOrEqual(
      16 * 1024 * 1024,
    );
    expect(value.rafs.size).toBe(0);
  });
  it("sustains visible motion and coalesced real pointer input beyond the former lifetime cutoff", () => {
    const value = fixture();
    const initialResources = Object.fromEntries(
      Object.entries(value.owned).map(([key, entries]) => [key, new Set(entries)]),
    );
    const initialAllocations = value.allocations.length;
    value.document.documentElement.dataset.cafeVisible = "true";
    value.fire(value.window, "cafe-visibility-changed");
    for (let index = 0; index < 400; index++) value.tick();
    expect(value.canvas.dataset.cafeFluidFrames).toBe("412");
    expect(value.canvas.dataset.cafeFluidState).toBe("running");
    expect(value.rafs.size).toBe(1);
    value.fire(value.window, "pointermove", { isTrusted: false, clientX: 10, clientY: 10 });
    value.tick();
    expect(value.canvas.dataset.cafeFluidPointerInputs).toBe("0");
    for (let index = 0; index < 9; index++) {
      for (let flood = 0; flood < 100; flood++)
        value.fire(value.window, "pointermove", {
          isTrusted: true,
          clientX: 10 + index,
          clientY: 10,
        });
      value.tick();
    }
    expect(value.canvas.dataset.cafeFluidPointerInputs).toBe("9");
    expect(value.rafs.size).toBe(1);
    value.motion.matches = true;
    value.fire(value.motion, "change");
    value.fire(value.window, "pointermove", { isTrusted: true, clientX: 10, clientY: 10 });
    expect(value.rafs.size).toBe(0);
    expect(value.canvas.dataset.cafeFluidState).toBe("static");
    value.motion.matches = false;
    value.fire(value.motion, "change");
    for (let index = Number(value.canvas.dataset.cafeFluidFrames); index < 10_000; index++)
      value.tick();
    expect(value.canvas.dataset.cafeFluidFrames).toBe("10000");
    expect(value.canvas.dataset.cafeFluidState).toBe("running");
    expect(value.rafs.size).toBe(1);
    value.fire(value.window, "pointermove", { isTrusted: true, clientX: 20, clientY: 20 });
    value.fire(value.window, "cafe-presentation-changed");
    value.fire(value.window, "pointermove", { isTrusted: true, clientX: 20, clientY: 20 });
    value.tick();
    expect(value.canvas.dataset.cafeFluidPointerInputs).toBe("10");
    expect(value.canvas.dataset.cafeFluidFrames).toBe("10001");
    expect(value.allocations).toHaveLength(initialAllocations);
    for (const [key, entries] of Object.entries(value.owned))
      expect(entries).toEqual(initialResources[key]);
    value.document.documentElement.dataset.cafeVisible = "false";
    value.fire(value.window, "cafe-visibility-changed");
    expect(value.rafs.size).toBe(0);
    const pausedDraws = value.draws();
    value.tick();
    expect(value.draws()).toBe(pausedDraws);
    expect(value.canvas.dataset.cafeFluidState).toBe("paused");
    value.document.documentElement.dataset.cafeVisible = "true";
    value.fire(value.window, "cafe-visibility-changed");
    value.tick();
    expect(value.canvas.dataset.cafeFluidFrames).toBe("10002");
    expect(value.rafs.size).toBe(1);
    value.fire(value.window, "pagehide");
    for (const set of Object.values(value.owned)) expect(set.size).toBe(0);
    expect(value.rafs.size).toBe(0);
    expect(value.liveListeners()).toBe(0);
    expect(value.observers).toHaveLength(0);
  });
  it("saturates counters without freezing phase, palette, passive input or rendering", () => {
    const value = fixture({ counterLimit: 64 });
    value.document.documentElement.dataset.cafeVisible = "true";
    value.fire(value.window, "cafe-visibility-changed");
    for (let index = 0; index < 100; index++) {
      value.fire(value.window, "pointermove", { isTrusted: true, clientX: 20, clientY: 20 });
      value.tick();
    }
    expect(value.canvas.dataset.cafeFluidFrames).toBe("64");
    expect(value.canvas.dataset.cafeFluidPointerInputs).toBe("64");
    const beforeDraws = value.draws();
    const beforeRandom = value.randomCalls();
    for (let index = 0; index < 100; index++) value.tick();
    expect(value.draws()).toBeGreaterThan(beforeDraws);
    expect(value.randomCalls()).toBeGreaterThan(beforeRandom);
    expect(value.canvas.dataset.cafeFluidFrames).toBe("64");
    expect(value.canvas.dataset.cafeFluidPointerInputs).toBe("64");
    expect(value.canvas.dataset.cafeFluidState).toBe("running");
    expect(value.rafs.size).toBe(1);
    expect(value.owned.textures.size).toBe(8);
  });
  it("wraps the joint orbit phase instead of accumulating imprecise trigonometric arguments", () => {
    const value = fixture();
    value.document.documentElement.dataset.cafeVisible = "true";
    value.fire(value.window, "cafe-visibility-changed");
    // More than the joint 2π×100 / .026 orbit period exercises an actual wrap,
    // not merely a short sample whose phase has not reached the boundary yet.
    for (let index = 0; index < 30_000; index++) value.tick();
    expect(value.maxTrigonometricArgument()).toBeLessThanOrEqual(Math.PI * 200);
    expect(value.maxTrigonometricArgument()).toBeGreaterThan(Math.PI * 199);
    expect(value.canvas.dataset.cafeFluidFrames).toBe("30012");
    expect(value.canvas.dataset.cafeFluidState).toBe("running");
    expect(value.rafs.size).toBe(1);
    expect(value.peakTextures()).toBe(8);
  });
  it.each(["pagehide", "webglcontextlost"])(
    "releases exact resources/listeners/observers on %s",
    (event) => {
      const value = fixture();
      value.document.documentElement.dataset.cafeVisible = "true";
      value.fire(value.window, "cafe-visibility-changed");
      value.fire(event === "pagehide" ? value.window : value.canvas, event);
      for (const set of Object.values(value.owned)) expect(set.size).toBe(0);
      expect(value.rafs.size).toBe(0);
      expect(value.liveListeners()).toBe(0);
      expect(value.observers.length).toBe(0);
      expect(value.canvas.dataset.cafeFluidState).toBe(
        event === "pagehide" ? "disposed" : "context-lost",
      );
    },
  );
  it("retains a static readable decoration when WebGL is absent without a retry loop", () => {
    const value = fixture({ unsupported: true });
    expect(value.canvas.dataset.cafeFluidState).toBe("unsupported");
    expect(value.canvas.style.background).toBe(
      "linear-gradient(135deg,rgba(0,190,255,.24),rgba(123,44,255,.24),rgba(255,40,180,.24))",
    );
    expect(value.rafs.size).toBe(0);
    expect(value.liveListeners()).toBe(0);
    expect(value.draws()).toBe(0);
  });
});
