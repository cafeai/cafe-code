import { DEFAULT_SETTINGS, normalizeSettings, qualityLimits, settingsAffectFallingScene, settingsAffectGeometry } from "./config.js";
import { createFallingLayer } from "./falling.js";
import { advanceScene, createScene, shouldAnimate } from "./scene.js";
import { canvasQualityLimits, createCanvasRenderer } from "./renderers/canvas2d.js";
import { createWebGlRenderer, resolveLights } from "./renderers/webgl.js";

const LAYER_NAMES = ["tiles-gpu", "tiles-canvas", "reflection-gpu", "reflection-canvas", "vignette", "falling-gpu", "falling-canvas"];

function styleLayer(element, zIndex) {
  Object.assign(element.style, {
    position: "absolute",
    inset: "0",
    width: "100%",
    height: "100%",
    zIndex: String(zIndex),
    pointerEvents: "none",
  });
}

function createLayers(documentObject) {
  const elements = Object.fromEntries(LAYER_NAMES.map((name) => {
    const element = name === "vignette" ? documentObject.createElement("div") : documentObject.createElement("canvas");
    element.dataset.hexagonsLayer = name;
    element.setAttribute("aria-hidden", "true");
    return [name, element];
  }));
  styleLayer(elements["tiles-gpu"], 0);
  styleLayer(elements["tiles-canvas"], 0);
  styleLayer(elements["reflection-gpu"], 1);
  styleLayer(elements["reflection-canvas"], 1);
  styleLayer(elements.vignette, 2);
  styleLayer(elements["falling-gpu"], 3);
  styleLayer(elements["falling-canvas"], 3);
  elements["reflection-gpu"].style.mixBlendMode = "screen";
  elements["reflection-canvas"].style.mixBlendMode = "screen";
  elements.vignette.style.boxShadow = "inset 0 0 10vw #000b";
  return elements;
}

function systemReducedMotion(settings, mediaQuery) {
  return settings.reducedMotion === "always" || (settings.reducedMotion === "system" && mediaQuery.matches);
}

export async function createHexagonBackground(options = {}) {
  const documentObject = options.document ?? globalThis.document;
  const windowObject = options.window ?? globalThis.window;
  const container = options.container ?? documentObject?.body;
  if (!documentObject || !windowObject || !container?.append) throw new TypeError("A browser document, window, and container are required.");

  const root = documentObject.createElement("div");
  root.dataset.hexagonsBackground = "";
  root.setAttribute("aria-hidden", "true");
  Object.assign(root.style, {
    position: options.position === "absolute" ? "absolute" : "fixed",
    inset: "0",
    overflow: "hidden",
    zIndex: String(options.zIndex ?? 0),
    pointerEvents: "none",
    background: "#000",
  });
  const layers = createLayers(documentObject);
  root.append(...LAYER_NAMES.map((name) => layers[name]));
  container.append(root);

  let settings = normalizeSettings({ ...DEFAULT_SETTINGS, ...(options.preset?.settings ?? options.preset ?? {}), ...(options.settings ?? {}) });
  let display = options.display ?? { id: "portable", width: 1, height: 1, scaleFactor: windowObject.devicePixelRatio || 1 };
  let scene;
  let disposed = false;
  let frameHandle = 0;
  let resizeHandle = 0;
  let lastFrameTime = windowObject.performance.now();
  let canvasFrameAvailableAt = 0;
  let pointer = { x: 0, y: 0, active: false };
  let activeRenderer = "initializing";
  let fallbackReason = null;
  let lastResult = { status: "empty", drawCalls: 0 };
  let lastFallingResult = { status: "disabled", renderer: "none", primitives: 0 };
  let gpuOperational = false;
  const mediaQuery = windowObject.matchMedia("(prefers-reduced-motion: reduce)");
  const abortController = new AbortController();
  const listen = (target, event, callback) => target.addEventListener(event, callback, { signal: abortController.signal });
  const canvasRenderer = createCanvasRenderer(layers["tiles-canvas"]);
  // Hosts such as Club Code keep their own falling renderer authoritative. Do
  // not allocate the bundled Canvas and WebGL resources until a host explicitly
  // enables this runtime's falling effects. A later settings update can still
  // opt in without recreating the background controller.
  let fallingLayer = null;
  const webgl = createWebGlRenderer(layers["tiles-gpu"], (state) => {
    if (disposed) return;
    const previousRenderer = activeRenderer;
    gpuOperational = state.status === "restored";
    fallbackReason = state.status === "context-lost" ? state.fallbackReason : null;
    chooseRenderer();
    if (state.status === "restored" || previousRenderer !== activeRenderer) rebuild();
  });
  gpuOperational = webgl.available;

  function viewport() {
    if (root.style.position === "fixed") return { width: Math.max(1, windowObject.innerWidth), height: Math.max(1, windowObject.innerHeight) };
    const bounds = root.getBoundingClientRect();
    return { width: Math.max(1, bounds.width), height: Math.max(1, bounds.height) };
  }

  function desiredDpr(size) {
    const limits = qualityLimits(settings.quality);
    const areaBound = Math.sqrt(limits.backingPixels / Math.max(1, size.width * size.height));
    return Math.max(0.5, Math.min(windowObject.devicePixelRatio || 1, limits.dpr, areaBound));
  }

  function chooseRenderer() {
    const gpuRequested = settings.renderer !== "canvas";
    if (gpuRequested && webgl.available && gpuOperational) {
      activeRenderer = "gpu-webgl2";
      fallbackReason = null;
      layers["tiles-gpu"].style.opacity = "1";
      layers["tiles-canvas"].style.opacity = "0";
    } else {
      activeRenderer = "canvas2d-fallback";
      fallbackReason = gpuRequested ? fallbackReason || webgl.fallbackReason || "gpu-unavailable" : "forced-canvas";
      layers["tiles-gpu"].style.opacity = "0";
      layers["tiles-canvas"].style.opacity = "1";
    }
  }

  function animationAllowed() {
    return shouldAnimate({
      enabled: settings.enabled,
      reducedMotion: systemReducedMotion(settings, mediaQuery),
      documentVisible: documentObject.visibilityState === "visible",
      windowFocused: typeof documentObject.hasFocus !== "function" || documentObject.hasFocus(),
      continueBackgroundAnimations: settings.continueBackgroundAnimations,
    });
  }

  function stateSnapshot() {
    return {
      activeRenderer,
      fallbackReason,
      animationAllowed: animationAllowed(),
      lastResult: { ...lastResult },
      fallingResult: { ...lastFallingResult },
      tileCount: scene?.grid.tiles.length ?? 0,
    };
  }

  function ensureFallingLayer() {
    if (fallingLayer) return fallingLayer;
    fallingLayer = createFallingLayer(layers["falling-canvas"], layers["falling-gpu"], layers["reflection-canvas"], layers["reflection-gpu"]);
    const size = scene?.viewport ?? viewport();
    fallingLayer.resize(size.width, size.height, desiredDpr(size), settings);
    return fallingLayer;
  }

  function draw(delta = 0) {
    if (disposed || !scene) return;
    root.hidden = !settings.enabled;
    if (!settings.enabled) return;
    advanceScene(scene, systemReducedMotion(settings, mediaQuery) ? 0 : delta, settings, pointer);
    const lights = resolveLights(scene, settings, pointer);
    lastResult = activeRenderer === "gpu-webgl2" ? webgl.render(scene, settings, lights) : canvasRenderer.render(scene, settings, lights);
    // A bounded Canvas frame can still be expensive on software rasterizers.
    // Guarantee a main-thread breathing window after every completed fallback
    // frame so transport/bootstrap/input tasks run before another frame begins.
    if (activeRenderer === "canvas2d-fallback") {
      const measuredDuration = Number(lastResult.renderDurationMs);
      const scheduledIdleMs = Math.max(
        canvasQualityLimits(settings.quality).minimumIdleMs,
        Number.isFinite(measuredDuration) ? measuredDuration : 0,
      );
      lastResult = { ...lastResult, scheduledIdleMs };
      canvasFrameAvailableAt = windowObject.performance.now() + scheduledIdleMs;
    } else {
      canvasFrameAvailableAt = 0;
    }
    if (lastResult.status === "context-lost" || lastResult.status === "gl-error") {
      gpuOperational = false;
      fallbackReason = lastResult.status;
      chooseRenderer();
      // Canvas needs a coarser, complete grid than WebGL. Rebuild before the
      // first fallback frame instead of synchronously walking the GPU-sized
      // scene on the renderer main thread.
      rebuild();
      return;
    }
    if (settings.fallingEffectsEnabled) {
      lastFallingResult = ensureFallingLayer().render(systemReducedMotion(settings, mediaQuery) ? 0 : delta, scene, settings);
    } else if (fallingLayer) {
      lastFallingResult = fallingLayer.render(0, scene, settings);
    } else {
      lastFallingResult = { status: "disabled", renderer: "none", primitives: 0 };
    }
    // Initial rebuilds happen before the public controller is assigned. Build
    // the callback payload directly so onState is safe during startup.
    options.onState?.(stateSnapshot());
  }

  function rebuild() {
    const size = viewport();
    display = { ...display, width: Math.max(1, Number(display.width) || size.width), height: Math.max(1, Number(display.height) || size.height), scaleFactor: Math.max(0.5, Number(display.scaleFactor) || 1) };
    chooseRenderer();
    const maximumTiles = activeRenderer === "canvas2d-fallback"
      ? canvasQualityLimits(settings.quality).tiles
      : undefined;
    scene = createScene(size, display, settings, maximumTiles);
    advanceScene(scene, 0, settings, pointer);
    const dpr = desiredDpr(size);
    if (activeRenderer === "gpu-webgl2") webgl.resize(size.width, size.height, dpr);
    canvasRenderer.resize(size.width, size.height, dpr, settings);
    fallingLayer?.resize(size.width, size.height, dpr, settings);
    draw(0);
  }

  function loop(now) {
    frameHandle = 0;
    if (activeRenderer === "canvas2d-fallback" && now < canvasFrameAvailableAt) {
      if (animationAllowed()) frameHandle = windowObject.requestAnimationFrame(loop);
      return;
    }
    const delta = Math.min(0.1, Math.max(0, (now - lastFrameTime) / 1000));
    lastFrameTime = now;
    draw(delta);
    if (animationAllowed()) frameHandle = windowObject.requestAnimationFrame(loop);
  }

  function syncAnimation() {
    if (animationAllowed()) {
      if (!frameHandle) {
        lastFrameTime = windowObject.performance.now();
        frameHandle = windowObject.requestAnimationFrame(loop);
      }
    } else {
      if (frameHandle) windowObject.cancelAnimationFrame(frameHandle);
      frameHandle = 0;
      draw(0);
    }
  }

  function scheduleResize() {
    if (resizeHandle || disposed) return;
    resizeHandle = windowObject.requestAnimationFrame(async () => {
      resizeHandle = 0;
      if (options.getDisplayInfo) display = await options.getDisplayInfo();
      rebuild();
      syncAnimation();
    });
  }

  function localPointer(event) {
    if (root.style.position === "fixed") return { x: event.clientX, y: event.clientY, active: true };
    const bounds = root.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top, active: true };
  }

  const pointerTarget = options.pointerTarget ?? windowObject;
  listen(pointerTarget, "pointermove", (event) => { pointer = localPointer(event); if (!animationAllowed()) draw(0); });
  listen(pointerTarget, "pointerleave", () => { pointer.active = false; });
  listen(windowObject, "resize", scheduleResize);
  listen(windowObject, "focus", syncAnimation);
  listen(windowObject, "blur", syncAnimation);
  listen(documentObject, "visibilitychange", syncAnimation);
  listen(mediaQuery, "change", syncAnimation);

  if (options.getDisplayInfo) display = await options.getDisplayInfo();

  const controller = Object.freeze({
    root,
    updateSettings(patch) {
      const previous = settings;
      const previousRenderer = activeRenderer;
      settings = normalizeSettings({ ...settings, ...patch });
      root.hidden = !settings.enabled;
      const rebuildRequired = settingsAffectGeometry(previous, settings) || settingsAffectFallingScene(previous, settings) || ["particleCount", "particleSpeed", "particleSpeedVariation", "quality", "seed"].some((key) => previous[key] !== settings[key]);
      chooseRenderer();
      if (rebuildRequired || previousRenderer !== activeRenderer) rebuild(); else draw(0);
      syncAnimation();
      return controller.getSettings();
    },
    replaceSettings(next) {
      settings = normalizeSettings(next);
      rebuild();
      syncAnimation();
      return controller.getSettings();
    },
    resize: scheduleResize,
    getSettings: () => ({ ...settings }),
    getState: stateSnapshot,
    destroy() {
      if (disposed) return;
      disposed = true;
      abortController.abort();
      if (frameHandle) windowObject.cancelAnimationFrame(frameHandle);
      if (resizeHandle) windowObject.cancelAnimationFrame(resizeHandle);
      webgl.dispose();
      canvasRenderer.dispose();
      fallingLayer?.dispose();
      root.remove();
    },
  });

  rebuild();
  syncAnimation();
  return controller;
}
