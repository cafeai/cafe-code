import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@cafecode/contracts/settings";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { MAX_ATMOSPHERE_CANVAS_PIXELS } from "../windowAtmosphere";
import { WindowAtmosphere } from "./WindowAtmosphere";

const testState = vi.hoisted(() => ({
  settings: null as UnifiedSettings | null,
  atmosphereAvailable: true,
}));

vi.mock("../hooks/useSettings", () => ({
  useSettings: <T,>(selector: (settings: UnifiedSettings) => T) =>
    selector(testState.settings ?? DEFAULT_UNIFIED_SETTINGS),
}));

vi.mock("../hooks/useTheme", () => ({
  useTheme: () => ({ resolvedTheme: "dark" as const }),
}));

vi.mock("../rpc/serverState", () => ({
  useServerConfig: () => ({
    ambientExperienceCapabilities: { atmosphere: testState.atmosphereAvailable },
  }),
}));

function createCanvasContext() {
  return {
    arc: vi.fn(),
    beginPath: vi.fn(),
    clearRect: vi.fn(),
    fill: vi.fn(),
    fillText: vi.fn(),
    lineTo: vi.fn(),
    moveTo: vi.fn(),
    restore: vi.fn(),
    save: vi.fn(),
    setTransform: vi.fn(),
    stroke: vi.fn(),
    fillStyle: "",
    font: "",
    globalAlpha: 1,
    lineCap: "butt",
    lineWidth: 1,
    strokeStyle: "",
    textAlign: "start",
    textBaseline: "alphabetic",
  } as unknown as CanvasRenderingContext2D;
}

describe("WindowAtmosphere", () => {
  const originalGetContext = HTMLCanvasElement.prototype.getContext;
  const originalGetBoundingClientRect = HTMLCanvasElement.prototype.getBoundingClientRect;
  const originalDevicePixelRatio = window.devicePixelRatio;
  const originalInnerWidth = window.innerWidth;
  const originalInnerHeight = window.innerHeight;
  let context: CanvasRenderingContext2D;
  let reducedMotion = false;
  let mediaChange: (() => void) | null = null;
  let removeMediaChangeListener: ReturnType<typeof vi.fn>;
  let frames = new Map<number, FrameRequestCallback>();
  let nextFrameId = 1;

  beforeEach(() => {
    testState.settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      fallingEffectsEnabled: true,
      fallingEffectKind: "matrix",
      continueBackgroundAnimations: true,
    };
    testState.atmosphereAvailable = true;
    context = createCanvasContext();
    reducedMotion = false;
    mediaChange = null;
    removeMediaChangeListener = vi.fn();
    frames = new Map();
    nextFrameId = 1;

    HTMLCanvasElement.prototype.getContext = vi.fn(
      () => context,
    ) as unknown as typeof originalGetContext;
    HTMLCanvasElement.prototype.getBoundingClientRect = vi.fn(
      () =>
        ({
          width: 8_000,
          height: 4_000,
        }) as DOMRect,
    );
    Object.defineProperty(window, "devicePixelRatio", { configurable: true, value: 4 });
    vi.spyOn(window, "matchMedia").mockImplementation(
      () =>
        ({
          get matches() {
            return reducedMotion;
          },
          addEventListener: (_type: string, listener: () => void) => {
            mediaChange = listener;
          },
          removeEventListener: removeMediaChangeListener,
        }) as unknown as MediaQueryList,
    );
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      const id = nextFrameId++;
      frames.set(id, callback);
      return id;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
      frames.delete(id);
    });
  });

  afterEach(() => {
    HTMLCanvasElement.prototype.getContext = originalGetContext;
    HTMLCanvasElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
    Object.defineProperty(window, "devicePixelRatio", {
      configurable: true,
      value: originalDevicePixelRatio,
    });
    Object.defineProperty(window, "innerWidth", { configurable: true, value: originalInnerWidth });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: originalInnerHeight,
    });
    vi.restoreAllMocks();
  });

  it("mounts a bounded canvas and schedules base Matrix rendering", async () => {
    const screen = await render(<WindowAtmosphere />);
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="window-atmosphere"]');

    expect(canvas).not.toBeNull();
    expect((canvas?.width ?? 0) * (canvas?.height ?? 0)).toBeLessThanOrEqual(
      MAX_ATMOSPHERE_CANVAS_PIXELS,
    );
    expect(frames.size).toBe(1);

    const frame = Array.from(frames.values())[0];
    frames.clear();
    frame?.(1_000);
    expect(context.fillText).toHaveBeenCalled();
    expect(frames.size).toBe(1);

    await screen.unmount();
    expect(frames.size).toBe(0);
  });

  it("suppresses rendering and animation under reduced motion", async () => {
    reducedMotion = true;
    const screen = await render(<WindowAtmosphere />);

    expect(context.fillText).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);

    reducedMotion = false;
    mediaChange?.();
    expect(frames.size).toBe(1);

    await screen.unmount();
    expect(removeMediaChangeListener).toHaveBeenCalledWith("change", expect.any(Function));
  });

  it("cancels a running frame when reduced motion becomes active", async () => {
    const screen = await render(<WindowAtmosphere />);
    expect(frames.size).toBe(1);

    reducedMotion = true;
    mediaChange?.();

    expect(frames.size).toBe(0);
    expect(context.clearRect).toHaveBeenCalled();

    await screen.unmount();
  });

  it("falls back to finite viewport dimensions for invalid layout measurements", async () => {
    HTMLCanvasElement.prototype.getBoundingClientRect = vi.fn(
      () =>
        ({
          width: Number.NaN,
          height: Number.POSITIVE_INFINITY,
        }) as DOMRect,
    );
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 640 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 360 });

    const screen = await render(<WindowAtmosphere />);
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="window-atmosphere"]');

    expect(canvas?.width).toBe(1_280);
    expect(canvas?.height).toBe(720);

    await screen.unmount();
  });

  it("does not mount when the server does not expose atmosphere support", async () => {
    testState.atmosphereAvailable = false;
    const screen = await render(<WindowAtmosphere />);

    expect(document.querySelector('[data-testid="window-atmosphere"]')).toBeNull();
    expect(frames.size).toBe(0);

    await screen.unmount();
  });
});
