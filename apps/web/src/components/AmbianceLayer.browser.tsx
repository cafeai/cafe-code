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
    state,
    params: {} as { environmentId?: string; threadId?: string },
    environmentId: null as string | null,
    anyThreadRunning: false,
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
  useParams: () => ambianceHarness.params,
}));

// Workspace/thread inputs stay test-owned so the workspace hook cannot load
// saved-host bootstrap/persistence through this fixture's intentionally
// isolated settings and store modules.
vi.mock("../environments/workspace", () => ({
  useWorkspaceEnvironmentId: () => ambianceHarness.environmentId,
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
  selectAnyThreadRunning: () => ambianceHarness.anyThreadRunning,
  useStore: ambianceHarness.useStore,
}));

import { AmbianceLayer } from "../ambiance/AmbianceLayer";
import { AmbianceEngine } from "../ambiance/ambianceEngine";

/**
 * Lets a test change the mocked settings and push a re-render, so effect
 * switching goes through the same path the settings picker uses.
 */
function selectEffect(effect: string) {
  ambianceHarness.settings.ambianceEffect = effect;
  ambianceHarness.notify();
}

type AmbianceScreen = Awaited<ReturnType<typeof render>>;
type EngineObservation = {
  readonly engine: AmbianceEngine;
  disposed: boolean;
  session: Parameters<AmbianceEngine["setSession"]>[0] | null;
  holding: boolean | null;
  ringReads: number;
  retiredRingReads: number;
};
type AmbianceFixture = {
  readonly host: HTMLDivElement;
  readonly engines: ReadonlyArray<EngineObservation>;
  render: () => Promise<AmbianceScreen>;
  poll: <A>(start: () => Promise<A>) => Promise<A>;
  runPendingIntervals: () => void;
  assertLive: () => void;
  finish: () => void;
  cleanup: () => Promise<void>;
};
type AmbianceFixtureOptions = {
  readonly controlledIntervals?: boolean;
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
function createAmbianceFixture(
  context: TestContext,
  options: AmbianceFixtureOptions,
): AmbianceFixture {
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
  let intervalClock:
    | {
        readonly originalSetInterval: typeof window.setInterval;
        readonly originalClearInterval: typeof window.clearInterval;
        readonly setInterval: typeof window.setInterval;
        readonly clearInterval: typeof window.clearInterval;
      }
    | undefined;
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
  const engines = new Map<AmbianceEngine, EngineObservation>();
  const engineRecorders: {
    method: "setConfig" | "setSession" | "setHolding" | "currentDrive" | "dispose";
    original: PropertyDescriptor;
    wrapper: unknown;
  }[] = [];
  const observeEngine = (engine: AmbianceEngine): EngineObservation => {
    let observation = engines.get(engine);
    if (!observation) {
      observation = {
        engine,
        disposed: false,
        session: null,
        holding: null,
        ringReads: 0,
        retiredRingReads: 0,
      };
      engines.set(engine, observation);
    }
    return observation;
  };
  const bounded = (value: number) =>
    Number.isFinite(value) ? Math.min(10_000_000, Math.max(0, Math.round(value))) : null;
  const assertLive = () => {
    if (retired || context.signal.aborted || activeAmbianceFixture !== owner)
      throw new Error("Ambiance fixture has retired");
  };
  const assertIntervalClock = () => {
    if (
      !intervalClock ||
      !vi.isFakeTimers() ||
      window.setInterval !== intervalClock.setInterval ||
      window.clearInterval !== intervalClock.clearInterval
    )
      throw new Error("Ambiance interval clock ownership changed");
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
      if (intervalClock) {
        // The real component must retire its registered callbacks during the
        // exact unmount. Restore only this fixture's clock, after all original
        // render/poll work and native resource teardown have joined.
        assertIntervalClock();
        const remainingIntervals = vi.getTimerCount();
        vi.useRealTimers();
        if (
          window.setInterval !== intervalClock.originalSetInterval ||
          window.clearInterval !== intervalClock.originalClearInterval
        )
          throw new Error("Ambiance interval clock did not restore its native methods");
        if (remainingIntervals !== 0)
          throw new Error("Ambiance interval callbacks survived their owning unmount");
      }
      for (const recorder of engineRecorders) {
        const current = Object.getOwnPropertyDescriptor(AmbianceEngine.prototype, recorder.method);
        if (current?.value !== recorder.wrapper)
          throw new Error("Ambiance engine recorder ownership changed before cleanup");
        Object.defineProperty(AmbianceEngine.prototype, recorder.method, recorder.original);
      }
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
    get engines() {
      return [...engines.values()];
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
    runPendingIntervals() {
      assertLive();
      assertIntervalClock();
      // Deliver only callbacks actually registered through the controlled
      // interval API. Cleared predecessor handles cannot be replayed. Timeout,
      // RAF, Date, canvas and the browser's real input/readiness stay native.
      vi.runOnlyPendingTimers();
      assertLive();
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
  // Registration precedes clock/host/native-recorder/render acquisition. Only
  // owner-transfer cases control intervals; pixel and motion cases retain the
  // native clock, and another fixture's fake clock can never be adopted here.
  if (options.controlledIntervals) {
    if (vi.isFakeTimers()) throw new Error("Ambiance fixture cannot adopt an existing fake clock");
    const originalSetInterval = window.setInterval;
    const originalClearInterval = window.clearInterval;
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    intervalClock = {
      originalSetInterval,
      originalClearInterval,
      setInterval: window.setInterval,
      clearInterval: window.clearInterval,
    };
  }
  host = document.createElement("div");
  // Observe the exact real engine owners without replacing their behavior.
  // These are state/resource receipts, not frame, pixel or animation samples:
  // a replaced owner must receive current levels, and its predecessor must
  // not remain the composer ring's timer target after native disposal.
  const recordEngine = (method: (typeof engineRecorders)[number]["method"], wrapper: unknown) => {
    const original = Object.getOwnPropertyDescriptor(AmbianceEngine.prototype, method);
    if (!original) throw new Error("Native ambiance engine method is unavailable");
    Object.defineProperty(AmbianceEngine.prototype, method, { ...original, value: wrapper });
    engineRecorders.push({ method, original, wrapper });
  };
  const originalSetConfig = AmbianceEngine.prototype.setConfig;
  const originalSetSession = AmbianceEngine.prototype.setSession;
  const originalSetHolding = AmbianceEngine.prototype.setHolding;
  const originalCurrentDrive = AmbianceEngine.prototype.currentDrive;
  const originalDispose = AmbianceEngine.prototype.dispose;
  recordEngine(
    "setConfig",
    function (this: AmbianceEngine, config: Parameters<typeof originalSetConfig>[0]) {
      originalSetConfig.call(this, config);
      observeEngine(this);
    },
  );
  recordEngine(
    "setSession",
    function (this: AmbianceEngine, session: Parameters<typeof originalSetSession>[0]) {
      originalSetSession.call(this, session);
      observeEngine(this).session = session;
    },
  );
  recordEngine("setHolding", function (this: AmbianceEngine, holding: boolean) {
    originalSetHolding.call(this, holding);
    observeEngine(this).holding = holding;
  });
  recordEngine("currentDrive", function (this: AmbianceEngine) {
    const drive = originalCurrentDrive.call(this);
    const observation = observeEngine(this);
    observation.ringReads += 1;
    if (observation.disposed) observation.retiredRingReads += 1;
    return drive;
  });
  recordEngine("dispose", function (this: AmbianceEngine) {
    originalDispose.call(this);
    observeEngine(this).disposed = true;
  });
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
  options: AmbianceFixtureOptions = {},
): Promise<void> {
  const fixture = createAmbianceFixture(context, options);
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
  ambianceHarness.params = {};
  ambianceHarness.environmentId = null;
  ambianceHarness.anyThreadRunning = false;
  ambianceHarness.state.environmentStateById = {};
  ambianceHarness.settings.ambianceEffect = "rain";
  ambianceHarness.settings.ambianceReactMode = "off";
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
  it.for(["focused", "aggregate"] as const)(
    "transfers current %s attention state and ring ownership to a replacement engine",
    async (source, context) => {
      const environmentId = "ambiance-owner-environment";
      const threadId = "ambiance-owner-thread";
      ambianceHarness.environmentId = environmentId;
      ambianceHarness.params = source === "focused" ? { environmentId, threadId } : {};
      ambianceHarness.anyThreadRunning = true;
      ambianceHarness.settings.ambianceReactMode = "live";
      Object.assign(ambianceHarness.state.environmentStateById, {
        [environmentId]: {
          threadIds: [threadId],
          sidebarThreadSummaryById: {
            [threadId]: {
              session: { orchestrationStatus: "running" },
              hasPendingApprovals: source === "aggregate",
              hasPendingUserInput: source === "focused",
            },
          },
          threadSessionById: {},
          threadTurnStateById: {},
          activityIdsByThreadId: {},
          activityByThreadId: {},
        },
      });
      await withAmbianceFixture(
        context,
        async (fixture) => {
          await fixture.render();
          const firstCanvas = canvasOf(fixture.host);
          const predecessor = fixture.engines[0];
          expect(predecessor?.session).toBe("running");
          expect(predecessor?.holding).toBe(true);
          expect(predecessor?.ringReads).toBeGreaterThan(0);

          // Only the effect changes. Session/request state stays identical, so
          // the new native resource must acquire those existing levels itself.
          selectEffect("aurora");
          const replacement = await fixture.poll(() =>
            vi.waitFor(() => {
              fixture.assertLive();
              const replacement = fixture.engines.find((engine) => engine !== predecessor);
              expect(canvasOf(fixture.host)).not.toBe(firstCanvas);
              expect(predecessor?.disposed).toBe(true);
              expect(replacement?.disposed).toBe(false);
              expect(replacement?.session).toBe("running");
              expect(replacement?.holding).toBe(true);
              return replacement;
            }),
          );
          // Readiness retains its original one-second poll. Once the actual
          // replacement is ready, deliver its pending interval callbacks in
          // one controlled step instead of sampling native timer progress.
          // The read delta proves callback ownership even if waitFor advanced
          // fake intervals while acquiring readiness; it is not pixel, CPU or
          // native elapsed-time evidence.
          const readsBeforeDelivery = replacement?.ringReads ?? 0;
          fixture.runPendingIntervals();
          expect(replacement?.ringReads).toBeGreaterThan(readsBeforeDelivery);
          expect(replacement?.ringReads).toBeGreaterThan(1);
          expect(predecessor?.retiredRingReads).toBe(0);
        },
        { controlledIntervals: true },
      );
    },
  );
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
