import "../index.css";

import { afterEach, beforeEach, describe, expect, it, vi, type TestContext } from "vitest";
import { render } from "vitest-browser-react";

const ambianceHarness = vi.hoisted(() => {
  const state = {
    environmentStateById: {},
  };
  const useStore = Object.assign((selector: (value: typeof state) => unknown) => selector(state), {
    getState: () => state,
  });
  const listeners = new Set<() => void>();
  return {
    listeners,
    notify: () => {
      for (const listener of listeners) listener();
    },
    settings: {
      ambianceEnabled: true,
      ambianceEffect: "rain",
      ambianceIntensity: 1,
      ambianceReactMode: "off",
      ambianceSurfaceSidebar: true,
      ambianceSurfaceThread: true,
      ambianceSurfaceComposer: true,
      ambianceColor: "",
      appAccentColor: "",
      themeAccentColor: "",
      continueBackgroundAnimations: true,
    },
    useStore,
  };
});

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useParams: () => ({}),
}));

// These canvas fixtures have no selected workspace or thread. Keep that input
// explicit so the workspace hook cannot load saved-host bootstrap/persistence
// through this fixture's intentionally isolated settings and store modules.
vi.mock("../environments/workspace", () => ({
  useWorkspaceEnvironmentId: () => null,
}));

// The app is built with the React Compiler, which memoizes AmbianceCanvas, so a
// parent re-render alone never reaches it. The mock has to be a real
// subscribable store for a settings change to propagate the way it does live.
vi.mock("../hooks/useSettings", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useSettings: (selector: (settings: typeof ambianceHarness.settings) => unknown) =>
      useSyncExternalStore(
        (onChange: () => void) => {
          ambianceHarness.listeners.add(onChange);
          return () => ambianceHarness.listeners.delete(onChange);
        },
        () => selector(ambianceHarness.settings),
      ),
  };
});

vi.mock("../hooks/useTheme", () => ({
  useTheme: () => ({ theme: "dark" }),
}));

vi.mock("../store", () => ({
  selectAnyThreadRunning: () => false,
  useStore: ambianceHarness.useStore,
}));

import { AmbianceLayer } from "../ambiance/AmbianceLayer";

/**
 * Lets a test change the mocked settings and push a re-render, so effect
 * switching goes through the same path the settings picker uses.
 */
function selectEffect(effect: string) {
  ambianceHarness.settings.ambianceEffect = effect;
  ambianceHarness.notify();
}

type AmbianceScreen = Awaited<ReturnType<typeof render>>;
type AmbianceFixture = {
  readonly host: HTMLDivElement;
  render: () => Promise<AmbianceScreen>;
  poll: <A>(start: () => Promise<A>) => Promise<A>;
  assertLive: () => void;
  finish: () => void;
  cleanup: () => Promise<void>;
};
type CanvasObservations = {
  clears: number;
  strokes: number;
  sequence: number;
  lastOperation: "none" | "clear" | "stroke";
  lastStrokeSequence: number | null;
  lastStrokeWidth: number | null;
  lastStrokeHeight: number | null;
  sampleStrokeDimensions: boolean;
  saturated: boolean;
};
let activeAmbianceFixture: AmbianceFixture | undefined;

/**
 * Own the original render/polls and exact native recorder before acquisition.
 * Failure observations are passive fixed scalars captured before teardown;
 * they neither schedule a frame nor explain an unobserved historical timeout.
 */
function createAmbianceFixture(context: TestContext): AmbianceFixture {
  if (activeAmbianceFixture) throw new Error("Previous ambiance fixture is still retiring");
  let host: HTMLDivElement | undefined;
  let owner: AmbianceFixture;
  let retired = context.signal.aborted;
  let finished = false;
  let observationsClosed = false;
  let observationUnavailable = false;
  let renderState: "not-started" | "pending" | "fulfilled" | "rejected" = "not-started";
  let rendering: ReturnType<typeof render> | undefined;
  let screen: AmbianceScreen | undefined;
  let cleanupPromise: Promise<void> | undefined;
  let failureObservation: object | undefined;
  const pending = new Set<Promise<unknown>>();
  const counts = new WeakMap<HTMLCanvasElement, CanvasObservations>();
  const knownContexts = new WeakMap<
    CanvasRenderingContext2D,
    { canvas: HTMLCanvasElement; value: CanvasObservations }
  >();
  const recorders: {
    method: "clearRect" | "stroke";
    original: PropertyDescriptor;
    wrapper: unknown;
  }[] = [];
  const bounded = (value: number) =>
    Number.isFinite(value) ? Math.min(10_000_000, Math.max(0, Math.round(value))) : null;
  const assertLive = () => {
    if (retired || context.signal.aborted || activeAmbianceFixture !== owner)
      throw new Error("Ambiance fixture has retired");
  };
  const captureFailure = (phase: "render-rejected" | "poll-rejected" | "retirement") => {
    if (failureObservation) return;
    try {
      const canvas = host?.querySelector<HTMLCanvasElement>('[data-cafe-ambiance-canvas="true"]');
      const rect = canvas?.getBoundingClientRect();
      const observed = canvas ? counts.get(canvas) : undefined;
      failureObservation = {
        phase,
        renderState,
        retired,
        observationUnavailable,
        canvas: Boolean(canvas),
        bitmapWidth: canvas ? bounded(canvas.width) : null,
        bitmapHeight: canvas ? bounded(canvas.height) : null,
        rectWidth: rect ? bounded(rect.width) : null,
        rectHeight: rect ? bounded(rect.height) : null,
        visible: document.visibilityState === "visible",
        focused: document.hasFocus(),
        reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
        clears: observed?.clears ?? 0,
        strokes: observed?.strokes ?? 0,
        sequence: observed?.sequence ?? 0,
        lastOperation: observed?.lastOperation ?? "none",
        lastStrokeSequence: observed?.lastStrokeSequence ?? null,
        lastStrokeWidth: observed?.lastStrokeWidth ?? null,
        lastStrokeHeight: observed?.lastStrokeHeight ?? null,
        saturated: observed?.saturated ?? false,
      };
    } catch {
      failureObservation = { phase, renderState, retired, observationUnavailable: true };
    }
  };
  const track = <A,>(
    phase: "render-rejected" | "poll-rejected",
    start: () => Promise<A>,
  ): Promise<A> => {
    assertLive();
    const original = start();
    pending.add(original);
    // Observe the original promise without translating its value or error.
    void original.then(
      () => pending.delete(original),
      () => {
        captureFailure(phase);
        pending.delete(original);
      },
    );
    return original;
  };
  const retire = () => {
    retired = true;
  };
  const cleanup = (): Promise<void> => {
    if (cleanupPromise) return cleanupPromise;
    retire();
    cleanupPromise = (async () => {
      if (!finished) captureFailure("retirement");
      // No retired continuation can admit another operation. Join the original
      // poll/render before removing its target or restoring native methods.
      await Promise.allSettled([...pending]);
      const settled = rendering ? (await Promise.allSettled([rendering]))[0] : undefined;
      const acquired = screen ?? (settled?.status === "fulfilled" ? settled.value : undefined);
      await acquired?.unmount();
      host?.remove();
      for (const recorder of recorders) {
        const current = Object.getOwnPropertyDescriptor(
          CanvasRenderingContext2D.prototype,
          recorder.method,
        );
        if (
          current === undefined ||
          current.value !== recorder.wrapper ||
          current.configurable !== recorder.original.configurable ||
          current.enumerable !== recorder.original.enumerable ||
          current.writable !== recorder.original.writable
        )
          throw new Error("Ambiance native recorder ownership changed before cleanup");
        Object.defineProperty(
          CanvasRenderingContext2D.prototype,
          recorder.method,
          recorder.original,
        );
      }
      observationsClosed = true;
      context.signal.removeEventListener("abort", retire);
      // A rejected cleanup retains its lease instead of admitting a successor.
      if (activeAmbianceFixture === owner) activeAmbianceFixture = undefined;
    })();
    return cleanupPromise;
  };
  owner = {
    get host() {
      if (!host) throw new Error("Ambiance fixture host was not acquired");
      return host;
    },
    assertLive,
    async render() {
      assertLive();
      if (rendering) throw new Error("Ambiance fixture already owns a render");
      renderState = "pending";
      rendering = track("render-rejected", () =>
        render(<AmbianceLayer />, { container: owner.host }),
      );
      void rendering.then(
        () => {
          renderState = "fulfilled";
        },
        () => {
          renderState = "rejected";
        },
      );
      const acquired = await rendering;
      // A late fulfilled render remains available to cleanup, but cannot
      // publish its screen as a live owner or continue into another case.
      assertLive();
      screen = acquired;
      return acquired;
    },
    async poll(start) {
      const result = await track("poll-rejected", start);
      assertLive();
      return result;
    },
    finish() {
      assertLive();
      finished = true;
    },
    cleanup,
  };
  activeAmbianceFixture = owner;
  context.signal.addEventListener("abort", retire, { once: true });
  context.onTestFinished(cleanup);
  context.onTestFailed(() => {
    try {
      console.info(
        "native-ambiance-first-paint-observation",
        failureObservation ?? { phase: "unavailable" },
      );
    } catch {
      /* Diagnostic delivery cannot change native ownership or errors. */
    }
  });
  assertLive();
  // Registration precedes host/native-recorder/render acquisition.
  host = document.createElement("div");
  const complete = (context: CanvasRenderingContext2D, operation: "clear" | "stroke") => {
    if (observationsClosed) return;
    try {
      let known = knownContexts.get(context);
      if (!known) {
        const canvas = context.canvas;
        // DOM ownership is admitted once per exact native context, rather than
        // rereading the document for each path stroke within a painted frame.
        if (!host?.contains(canvas) || canvas.dataset.cafeAmbianceCanvas !== "true") return;
        const value: CanvasObservations = {
          clears: 0,
          strokes: 0,
          sequence: 0,
          lastOperation: "none",
          lastStrokeSequence: null,
          lastStrokeWidth: null,
          lastStrokeHeight: null,
          sampleStrokeDimensions: true,
          saturated: false,
        };
        known = { canvas, value };
        knownContexts.set(context, known);
        counts.set(canvas, value);
      }
      const { canvas, value } = known;
      if (value.saturated) return;
      value.sequence += 1;
      value.lastOperation = operation;
      if (operation === "clear") {
        value.clears += 1;
        value.sampleStrokeDimensions = true;
      } else {
        value.strokes += 1;
        value.lastStrokeSequence = value.sequence;
        if (value.sampleStrokeDimensions) {
          value.lastStrokeWidth = bounded(canvas.width);
          value.lastStrokeHeight = bounded(canvas.height);
          value.sampleStrokeDimensions = false;
        }
      }
      if (value.sequence === 65_535) value.saturated = true;
    } catch {
      observationUnavailable = true;
    }
  };
  const clearDescriptor = Object.getOwnPropertyDescriptor(
    CanvasRenderingContext2D.prototype,
    "clearRect",
  );
  const strokeDescriptor = Object.getOwnPropertyDescriptor(
    CanvasRenderingContext2D.prototype,
    "stroke",
  );
  if (!clearDescriptor || !strokeDescriptor)
    throw new Error("Native ambiance methods are unavailable");
  const originalClear = CanvasRenderingContext2D.prototype.clearRect;
  const originalStroke = CanvasRenderingContext2D.prototype.stroke;
  function clear(this: CanvasRenderingContext2D, ...args: Parameters<typeof originalClear>) {
    const result = originalClear.apply(this, args);
    complete(this, "clear");
    return result;
  }
  function stroke(this: CanvasRenderingContext2D, ...args: Parameters<typeof originalStroke>) {
    const result = originalStroke.apply(this, args);
    complete(this, "stroke");
    return result;
  }
  Object.defineProperty(CanvasRenderingContext2D.prototype, "clearRect", {
    ...clearDescriptor,
    value: clear,
  });
  recorders.push({ method: "clearRect", original: clearDescriptor, wrapper: clear });
  Object.defineProperty(CanvasRenderingContext2D.prototype, "stroke", {
    ...strokeDescriptor,
    value: stroke,
  });
  recorders.push({ method: "stroke", original: strokeDescriptor, wrapper: stroke });
  document.body.append(host);
  return owner;
}

async function withAmbianceFixture(
  context: TestContext,
  body: (fixture: AmbianceFixture) => Promise<void>,
): Promise<void> {
  const fixture = createAmbianceFixture(context);
  let bodyFailed = false;
  try {
    await body(fixture);
    fixture.finish();
  } catch (error) {
    bodyFailed = true;
    throw error;
  } finally {
    try {
      await fixture.cleanup();
    } catch (error) {
      // Preserve an original assertion; afterEach separately rejoins the same
      // rejected cleanup and keeps its ownership failure visible as a hook error.
      if (!bodyFailed) throw error;
    }
  }
}

beforeEach(() => {
  if (activeAmbianceFixture) throw new Error("Previous ambiance fixture is still retiring");
});
afterEach(async () => {
  await activeAmbianceFixture?.cleanup();
  ambianceHarness.settings.ambianceEffect = "rain";
  ambianceHarness.settings.continueBackgroundAnimations = true;
  ambianceHarness.notify();
  document.documentElement.style.removeProperty("--cafe-ambiance-state-color");
  document.documentElement.style.removeProperty("--cafe-ambiance-composer-ring");
});

describe("AmbianceLayer", () => {
  it("fills the viewport and paints visible weather pixels when enabled", async (context) => {
    await withAmbianceFixture(context, async (fixture) => {
      await fixture.render();
      const canvas = fixture.host.querySelector('[data-cafe-ambiance-canvas="true"]');
      expect(canvas).toBeInstanceOf(HTMLCanvasElement);
      if (!(canvas instanceof HTMLCanvasElement)) throw new Error("Ambiance canvas did not mount");
      await fixture.poll(() =>
        vi.waitFor(
          () => {
            fixture.assertLive();
            const rect = canvas.getBoundingClientRect();
            expect(rect.width).toBe(window.innerWidth);
            expect(rect.height).toBe(window.innerHeight);
            const context = canvas.getContext("2d");
            expect(context).not.toBeNull();
            if (!context) return;
            const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
            let painted = false;
            for (let index = 3; index < pixels.length; index += 4) {
              if (pixels[index]! > 0) {
                painted = true;
                break;
              }
            }
            expect(painted).toBe(true);
          },
          { timeout: 3_000 },
        ),
      );
    });
  });
});

describe("AmbianceLayer effect switching", () => {
  const canvasOf = (host: HTMLElement) =>
    host.querySelector<HTMLCanvasElement>('[data-cafe-ambiance-canvas="true"]');
  it("rebuilds the canvas when switching between two shader effects", async (context) => {
    await withAmbianceFixture(context, async (fixture) => {
      await fixture.render();
      selectEffect("aurora");
      let first: HTMLCanvasElement | null = null;
      await fixture.poll(() =>
        vi.waitFor(() => {
          fixture.assertLive();
          first = canvasOf(fixture.host);
          expect(first?.dataset.cafeAmbianceEffect).toBe("aurora");
        }),
      );
      // Every shader compiles its program once at construction, so switching
      // shader effects must replace the canvas and retain the new program.
      selectEffect("grid");
      await fixture.poll(() =>
        vi.waitFor(() => {
          fixture.assertLive();
          const next = canvasOf(fixture.host);
          expect(next?.dataset.cafeAmbianceEffect).toBe("grid");
          expect(next).not.toBe(first);
        }),
      );
    });
  });
  it("keeps one canvas across 2D effects so their pools carry over", async (context) => {
    await withAmbianceFixture(context, async (fixture) => {
      await fixture.render();
      selectEffect("rain");
      let first: HTMLCanvasElement | null = null;
      await fixture.poll(() =>
        vi.waitFor(() => {
          fixture.assertLive();
          first = canvasOf(fixture.host);
          expect(first?.dataset.cafeAmbianceEffect).toBe("rain");
        }),
      );
      selectEffect("glass");
      await fixture.poll(() =>
        vi.waitFor(() => {
          fixture.assertLive();
          const next = canvasOf(fixture.host);
          expect(next?.dataset.cafeAmbianceEffect).toBe("glass");
          expect(next).toBe(first);
        }),
      );
    });
  });
});
