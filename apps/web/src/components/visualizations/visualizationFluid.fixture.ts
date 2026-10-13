import { VISUALIZATION_FLUID_RUNTIME_SOURCE } from "@cafecode/shared/visualizationFluidRuntime";

/** This recorder belongs only to the synthetic document below. It does not
 * replace the runner's media, device, context or real browser input policy.
 * Native pixels/driver resources are qualified separately by Electron tests. */
export interface FluidFixtureRecorder {
  flush(time: number): number;
  pending(): number;
  summary(): {
    textures: number;
    framebuffers: number;
    programs: number;
    shaders: number;
    buffers: number;
    textureBytes: number;
    peakTextureBytes: number;
    peakTextures: number;
    createdTextures: number;
    deletedTextures: number;
    draws: number;
    /** Simulation targets are initialized before their first draw only. */
    solverClearsAfterDraw: number;
    listeners: number;
    resizeObservers: number;
    mutationObservers: number;
    peakObservers: number;
    maxPending: number;
    contextRequests: number;
    textureSizes: readonly (readonly [number, number])[];
    shaderSources: readonly string[];
  };
}

export interface FluidFixture {
  frame: HTMLIFrameElement;
  window: Window;
  document: Document;
  recorder: FluidFixtureRecorder;
  canvas(): HTMLCanvasElement;
  visible(value: boolean): void;
  presentationVisible(value: boolean): void;
  dispose(): void;
}

// Deterministic scheduling proves finite work and exact resource replacement
// without burning hundreds of real animation frames or fabricating GPU/RSS
// evidence. All accounting is independently collected at the GL boundary.
const RECORDER_SOURCE = String.raw`(() => {
  const frames = new Map();
  let nextFrame = 1, maxPending = 0, contextRequests = 0, draws = 0, solverClearsAfterDraw = 0;
  const textures = new Map(), framebuffers = new Set(), programs = new Set();
  const shaders = new Set(), buffers = new Set(), listeners = [];
  const textureSizes = [], shaderSources = [];
  const drawnFramebuffers = new Set();
  const resizeObservers = new Set(), mutationObservers = new Set();
  let peakObservers = 0;
  const NativeResizeObserver = window.ResizeObserver;
  const NativeMutationObserver = window.MutationObserver;
  // These subclasses forward genuine browser delivery unchanged. Only exact
  // construction/disconnection ownership is recorded; no observer is simulated.
  window.ResizeObserver = class extends NativeResizeObserver {
    constructor(callback) { super(callback); resizeObservers.add(this); peakObservers = Math.max(peakObservers, resizeObservers.size + mutationObservers.size); }
    disconnect() { resizeObservers.delete(this); return super.disconnect(); }
  };
  window.MutationObserver = class extends NativeMutationObserver {
    constructor(callback) { super(callback); mutationObservers.add(this); peakObservers = Math.max(peakObservers, resizeObservers.size + mutationObservers.size); }
    disconnect() { mutationObservers.delete(this); return super.disconnect(); }
  };
  let createdTextures = 0, deletedTextures = 0, peakTextures = 0, bufferAllocations = 0;
  let peakTextureBytes = 0, boundTexture = null, boundFramebuffer = null, nextObject = 1;
  function bytes() { let total = 0; for (const size of textures.values()) total += size; return total; }
  function allocate(set) { const value = { id: nextObject++ }; set.add(value); return value; }
  const nativeAdd = EventTarget.prototype.addEventListener;
  const nativeRemove = EventTarget.prototype.removeEventListener;
  const capture = options => typeof options === 'boolean' ? options : options?.capture === true;
  EventTarget.prototype.addEventListener = function(type, listener, options) {
    if (listener && type !== 'DOMContentLoaded' && !listeners.some(entry =>
      entry.target === this && entry.type === type && entry.listener === listener && entry.capture === capture(options))) {
      listeners.push({ target: this, type, listener, capture: capture(options) });
    }
    return nativeAdd.call(this, type, listener, options);
  };
  EventTarget.prototype.removeEventListener = function(type, listener, options) {
    const index = listeners.findIndex(entry => entry.target === this && entry.type === type &&
      entry.listener === listener && entry.capture === capture(options));
    if (index >= 0) listeners.splice(index, 1);
    return nativeRemove.call(this, type, listener, options);
  };
  window.requestAnimationFrame = callback => {
    const id = nextFrame++; frames.set(id, callback); maxPending = Math.max(maxPending, frames.size); return id;
  };
  window.cancelAnimationFrame = id => frames.delete(id);
  const prototype = WebGL2RenderingContext.prototype;
  const gl = Object.create(null);
  for (const name of Object.getOwnPropertyNames(prototype)) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    if (typeof descriptor?.value === 'number') gl[name] = descriptor.value;
  }
  for (const name of Object.getOwnPropertyNames(WebGLRenderingContext.prototype)) {
    const descriptor = Object.getOwnPropertyDescriptor(WebGLRenderingContext.prototype, name);
    if (typeof descriptor?.value === 'number') gl[name] = descriptor.value;
  }
  const noop = () => {};
  for (const name of ['activeTexture','texParameteri','bindFramebuffer','framebufferTexture2D',
    'clearColor','clear','viewport','attachShader','bindAttribLocation','linkProgram','compileShader','useProgram',
    'bindBuffer','bufferData','vertexAttribPointer','enableVertexAttribArray','disable',
    'enable','blendFunc','uniform1i','uniform1f','uniform2f','uniform3f','uniform4f',
    'pixelStorei','detachShader']) gl[name] = noop;
  gl.getExtension = name => name === 'WEBGL_lose_context' ? { loseContext: noop } : { HALF_FLOAT_OES: gl.HALF_FLOAT };
  gl.getParameter = name => name === gl.MAX_TEXTURE_SIZE ? 4096 : name === gl.MAX_TEXTURE_IMAGE_UNITS ? 16 : 0;
  gl.createTexture = () => {
    const value = { id: nextObject++ }; textures.set(value, 0); createdTextures++;
    peakTextures = Math.max(peakTextures, textures.size); return value;
  };
  gl.deleteTexture = value => { if (textures.delete(value)) deletedTextures++; };
  gl.bindTexture = (_, value) => { boundTexture = value; };
  gl.texImage2D = (_, __, internalFormat, width, height, ___, format, type) => {
    if (!boundTexture || !textures.has(boundTexture)) throw new Error('Unowned fixture texture');
    const channels = format === gl.RED ? 1 : format === gl.RG ? 2 : format === gl.RGB ? 3 : 4;
    const channelBytes = type === gl.UNSIGNED_BYTE ? 1 : type === gl.FLOAT ? 4 : 2;
    textures.set(boundTexture, width * height * channels * channelBytes);
    textureSizes.push([width, height]); peakTextureBytes = Math.max(peakTextureBytes, bytes());
  };
  gl.createFramebuffer = () => allocate(framebuffers);
  gl.deleteFramebuffer = value => { framebuffers.delete(value); drawnFramebuffers.delete(value); };
  gl.bindFramebuffer = (_, value) => { boundFramebuffer = value; };
  gl.clear = () => {
    // Clearing a newly allocated target is valid; clearing already-computed
    // dye/solver state during presentation would erase the actual fluid image.
    if (boundFramebuffer && drawnFramebuffers.has(boundFramebuffer)) solverClearsAfterDraw++;
  };
  gl.checkFramebufferStatus = () => document.documentElement.dataset.fixtureNoFormats === 'true'
    ? gl.FRAMEBUFFER_INCOMPLETE_ATTACHMENT : gl.FRAMEBUFFER_COMPLETE;
  gl.createProgram = () => allocate(programs);
  gl.deleteProgram = value => programs.delete(value);
  gl.getProgramParameter = (_, name) => name === gl.ACTIVE_UNIFORMS ? 0 : true;
  gl.getProgramInfoLog = () => '';
  gl.getUniformLocation = () => ({});
  gl.getAttribLocation = () => 0;
  gl.createShader = () => allocate(shaders);
  gl.deleteShader = value => shaders.delete(value);
  gl.shaderSource = (_, source) => shaderSources.push(source);
  gl.getShaderParameter = () => true;
  gl.getShaderInfoLog = () => '';
  gl.createBuffer = () => {
    bufferAllocations++;
    if (document.documentElement.dataset.fixtureFailSecondBuffer === 'true' && bufferAllocations === 2) return null;
    return allocate(buffers);
  };
  gl.deleteBuffer = value => buffers.delete(value);
  gl.drawElements = () => { draws++; if (boundFramebuffer) drawnFramebuffers.add(boundFramebuffer); };
  let canvas;
  Object.defineProperty(gl, 'drawingBufferWidth', { get: () => canvas?.width ?? 1 });
  Object.defineProperty(gl, 'drawingBufferHeight', { get: () => canvas?.height ?? 1 });
  HTMLCanvasElement.prototype.getContext = function(kind) {
    contextRequests++; canvas = this;
    if (document.documentElement.dataset.fixtureNoWebgl === 'true') return null;
    if (kind === 'webgl2' || kind === 'webgl' || kind === 'experimental-webgl') return gl;
    return null;
  };
  window.__fluidFixture = {
    flush(time) { const batch = [...frames.values()]; frames.clear(); for (const callback of batch) callback(time); return batch.length; },
    pending() { return frames.size; },
    summary() { return {
      textures: textures.size, framebuffers: framebuffers.size, programs: programs.size,
      shaders: shaders.size, buffers: buffers.size, textureBytes: bytes(), peakTextureBytes,
      peakTextures, createdTextures, deletedTextures, draws, solverClearsAfterDraw, listeners: listeners.length,
      resizeObservers: resizeObservers.size, mutationObservers: mutationObservers.size, peakObservers,
      maxPending, contextRequests, textureSizes: textureSizes.slice(), shaderSources: shaderSources.slice()
    }; }
  };
})();`;

/** Fixed helper source alone executes inside this disposable document. No
 * received provider source, API/store, credentials or network is involved. */
export async function createFluidFixture(
  options: {
    markerCount?: number;
    visible?: boolean;
    presentationVisible?: boolean;
    noWebgl?: boolean;
    noFormats?: boolean;
    failSecondBuffer?: boolean;
    width?: number;
    height?: number;
    authoredOpacity?: number;
  } = {},
): Promise<FluidFixture> {
  const frame = document.createElement("iframe");
  frame.style.width = "400px";
  frame.style.height = "240px";
  frame.title = "Isolated fluid runtime fixture";
  const ready = new Promise<void>((resolve) =>
    frame.addEventListener("load", () => resolve(), { once: true }),
  );
  const width = options.width ?? 320;
  const height = options.height ?? 160;
  const markerCount = options.markerCount ?? 1;
  const markers = Array.from(
    { length: markerCount },
    () =>
      `<canvas data-cafe-fluid style="width:${width}px;height:${height}px;opacity:${options.authoredOpacity ?? 1}!important"></canvas>`,
  ).join("");
  const presentationVisible =
    options.presentationVisible === undefined
      ? ""
      : ` data-cafe-presentation-visible="${options.presentationVisible}"`;
  frame.srcdoc = `<!doctype html><html data-cafe-visible="${options.visible === true}"${presentationVisible} data-fixture-no-webgl="${options.noWebgl === true}" data-fixture-no-formats="${options.noFormats === true}" data-fixture-fail-second-buffer="${options.failSecondBuffer === true}"><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'"><script>${RECORDER_SOURCE}</script><script>${VISUALIZATION_FLUID_RUNTIME_SOURCE}</script></head><body>${markers}<p>Readable chart labels remain ordinary DOM.</p></body></html>`;
  document.body.append(frame);
  await ready;
  const fixtureWindow = frame.contentWindow!;
  const fixtureDocument = frame.contentDocument!;
  const recorder = (fixtureWindow as Window & { __fluidFixture: FluidFixtureRecorder })
    .__fluidFixture;
  return {
    frame,
    window: fixtureWindow,
    document: fixtureDocument,
    recorder,
    canvas: () => fixtureDocument.querySelector<HTMLCanvasElement>("canvas")!,
    visible(value) {
      fixtureDocument.documentElement.dataset.cafeVisible = String(value);
      fixtureWindow.dispatchEvent(new Event("cafe-visibility-changed"));
    },
    presentationVisible(value) {
      fixtureDocument.documentElement.dataset.cafePresentationVisible = String(value);
      fixtureWindow.dispatchEvent(new Event("cafe-presentation-visibility-changed"));
    },
    dispose() {
      fixtureWindow.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false }));
      frame.remove();
    },
  };
}
