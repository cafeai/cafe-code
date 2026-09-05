import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "@tanstack/react-router";
import { useShallow } from "zustand/react/shallow";
import type {
  AmbianceEffect,
  AmbianceReactMode,
  EnvironmentId,
  OrchestrationSessionStatus,
  ThreadId,
} from "@cafecode/contracts";

import { useSettings } from "../hooks/useSettings";
import { ambianceBackend } from "./ambianceEffects";
import { useTheme } from "../hooks/useTheme";
import { normalizeAccentColor } from "../themeAccent";
import { selectAnyThreadRunning, useStore, type AppState } from "../store";
import { AmbianceEngine, normalizeAmbianceTint } from "./ambianceEngine";

/**
 * AmbianceLayer mounts the decorative weather canvas over the whole window
 * (pointer-events: none) and feeds it three kinds of input:
 *
 * 1. Settings — effect, intensity, react mode, surfaces, and color. The
 *    weather color defaults to the Appearance accent color (custom ambiance
 *    color → app accent → sidebar color → theme's sidebar accent variable).
 * 2. Geometry — the sidebar/thread split so per-surface clipping matches the
 *    real sidebar width. Rect reads happen on resize/observer callbacks and a
 *    slow 1s safety interval, never per animation frame.
 * 3. Thread signals — the focused thread's projected session status, pending
 *    approval/user-input flags, latest turn transitions, and new tool
 *    activity. These are read from existing store projections; the layer is
 *    display-only and never synthesizes lifecycle state (AGENTS.md renderer
 *    rule). With no focused thread, a slow poll aggregates "any thread
 *    running / any approval waiting" so background runs still stir the sky.
 *
 * The canvas sits at z-40: above app content, below dialogs/popovers (z-50)
 * and toasts, so modal work is never obscured.
 */

const SIDEBAR_CONTAINER_SELECTOR = '[data-slot="sidebar-container"]';
const STATE_COLOR_VARIABLE = "--cafe-ambiance-state-color";
const COMPOSER_RING_VARIABLE = "--cafe-ambiance-composer-ring";
/** Aggregate/background signal poll. Slow on purpose: it is a fallback. */
const AGGREGATE_POLL_INTERVAL_MS = 2_000;
/** Geometry + tint safety resync (sidebar mount/unmount, theme var flips). */
const GEOMETRY_SYNC_INTERVAL_MS = 1_000;
/** Composer ring/state-color CSS var refresh; CSS transitions smooth steps. */
const RING_SYNC_INTERVAL_MS = 250;

type FocusedThreadSignals = {
  status: OrchestrationSessionStatus | null;
  holding: boolean;
  latestTurnId: string | null;
  latestTurnState: "running" | "interrupted" | "completed" | "error" | null;
  lastActivityId: string | null;
  lastActivityTone: "info" | "tool" | "approval" | "error" | null;
  lastActivityKind: string | null;
  lastActivitySummary: string | null;
};

const EMPTY_SIGNALS: FocusedThreadSignals = {
  status: null,
  holding: false,
  latestTurnId: null,
  latestTurnState: null,
  lastActivityId: null,
  lastActivityTone: null,
  lastActivityKind: null,
  lastActivitySummary: null,
};

function selectFocusedThreadSignals(
  state: AppState,
  environmentId: EnvironmentId | undefined,
  threadId: ThreadId | undefined,
): FocusedThreadSignals {
  if (!environmentId || !threadId) {
    return EMPTY_SIGNALS;
  }
  const environmentState = state.environmentStateById[environmentId];
  if (!environmentState) {
    return EMPTY_SIGNALS;
  }
  const summary = environmentState.sidebarThreadSummaryById[threadId];
  const session = environmentState.threadSessionById[threadId] ?? summary?.session ?? null;
  const latestTurn =
    environmentState.threadTurnStateById[threadId]?.latestTurn ?? summary?.latestTurn ?? null;
  const activityIds = environmentState.activityIdsByThreadId[threadId];
  const lastActivityId =
    activityIds && activityIds.length > 0 ? (activityIds[activityIds.length - 1] ?? null) : null;
  const lastActivity =
    lastActivityId !== null
      ? (environmentState.activityByThreadId[threadId]?.[lastActivityId] ?? null)
      : null;
  return {
    status: session?.orchestrationStatus ?? null,
    holding: Boolean(summary?.hasPendingApprovals || summary?.hasPendingUserInput),
    latestTurnId: latestTurn?.turnId ?? null,
    latestTurnState: latestTurn?.state ?? null,
    lastActivityId,
    lastActivityTone: lastActivity?.tone ?? null,
    lastActivityKind: lastActivity?.kind ?? null,
    lastActivitySummary: lastActivity?.summary ?? null,
  };
}

/** Bounded shell-level sweep used only by the slow background poll. */
function anyThreadHolding(state: AppState): boolean {
  for (const environmentState of Object.values(state.environmentStateById)) {
    for (const threadId of environmentState.threadIds) {
      const summary = environmentState.sidebarThreadSummaryById[threadId];
      if (summary?.hasPendingApprovals || summary?.hasPendingUserInput) {
        return true;
      }
    }
  }
  return false;
}

function readCssVariable(name: string): string {
  if (typeof document === "undefined") return "";
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/**
 * Weather tint resolution. An explicit ambiance color wins; otherwise follow
 * the Appearance tab's accent color, then the sidebar color, then the
 * theme-provided sidebar accent variable.
 */
function resolveAmbianceTint(
  ambianceColor: string,
  appAccentColor: string,
  themeAccentColor: string,
): string {
  const custom = normalizeAccentColor(ambianceColor);
  if (custom) return custom;
  const appAccent = normalizeAccentColor(appAccentColor);
  if (appAccent) return appAccent;
  const sidebarAccent = normalizeAccentColor(themeAccentColor);
  if (sidebarAccent) return sidebarAccent;
  return normalizeAmbianceTint(readCssVariable("--cafe-sidebar-accent"));
}

function clearAmbianceCssVariables(): void {
  if (typeof document === "undefined") return;
  document.documentElement.style.removeProperty(STATE_COLOR_VARIABLE);
  document.documentElement.style.removeProperty(COMPOSER_RING_VARIABLE);
}

type AmbianceConfigInputs = {
  effect: AmbianceEffect;
  intensity: number;
  reactMode: AmbianceReactMode;
  ambianceColor: string;
  appAccentColor: string;
  themeAccentColor: string;
  surfaceSidebar: boolean;
  surfaceThread: boolean;
  reducedMotion: boolean;
  dark: boolean;
};

function buildEngineConfig(inputs: AmbianceConfigInputs) {
  return {
    effect: inputs.effect,
    intensity: inputs.intensity,
    reactMode: inputs.reactMode,
    tint: resolveAmbianceTint(inputs.ambianceColor, inputs.appAccentColor, inputs.themeAccentColor),
    surfaces: { sidebar: inputs.surfaceSidebar, thread: inputs.surfaceThread },
    reducedMotion: inputs.reducedMotion,
    dark: inputs.dark,
  };
}

function AmbianceCanvas() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<AmbianceEngine | null>(null);
  const { theme, resolvedTheme } = useTheme();
  const dark = resolvedTheme !== "light";

  const effect = useSettings((settings) => settings.ambianceEffect);
  const backend = ambianceBackend(effect);
  // Rebuild key for the canvas element and the engine.
  //
  // A canvas holds exactly one context type, so crossing the 2D/WebGL boundary
  // must remount the element. WebGL effects additionally compile their shader
  // program once at construction, so switching between two shader effects has
  // to rebuild as well — keying only on the backend left the canvas running the
  // previously compiled program and the background never changed.
  //
  // The 2D effects all share one engine and swap through `setConfig`, which
  // keeps their particle pools so the new effect fades in from a believable
  // mid-state instead of a burst.
  const engineKey = backend === "webgl" ? `webgl:${effect}` : "2d";
  const intensity = useSettings((settings) => settings.ambianceIntensity);
  const opacity = useSettings((settings) => settings.ambianceOpacity);
  const reactMode = useSettings((settings) => settings.ambianceReactMode);
  const surfaceSidebar = useSettings((settings) => settings.ambianceSurfaceSidebar);
  const surfaceThread = useSettings((settings) => settings.ambianceSurfaceThread);
  const surfaceComposer = useSettings((settings) => settings.ambianceSurfaceComposer);
  const ambianceColor = useSettings((settings) => settings.ambianceColor);
  const appAccentColor = useSettings((settings) => settings.appAccentColor);
  const themeAccentColor = useSettings((settings) => settings.themeAccentColor);
  const continueBackgroundAnimations = useSettings(
    (settings) => settings.continueBackgroundAnimations,
  );

  const [reducedMotion, setReducedMotion] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );

  // Route params are plain strings; the store is keyed by branded ids. Cast
  // once here, matching the existing threadRoutes.ts convention.
  const params = useParams({ strict: false }) as {
    environmentId?: string;
    threadId?: string;
  };
  const focusedEnvironmentId = params.environmentId as EnvironmentId | undefined;
  const focusedThreadId = params.threadId as ThreadId | undefined;

  const signals = useStore(
    useShallow((state) => selectFocusedThreadSignals(state, focusedEnvironmentId, focusedThreadId)),
  );

  // Engine lifecycle: created once per mount of the enabled layer.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const engine = new AmbianceEngine(canvas, configInputsRef.current.effect);
    engineRef.current = engine;
    engine.setConfig(buildEngineConfig(configInputsRef.current));
    return () => {
      // dispose() also releases the WebGL context rather than leaving it
      // resident until GC; effect switches must never stack up contexts.
      engine.dispose();
      engine.clear();
      engineRef.current = null;
      clearAmbianceCssVariables();
    };
  }, [engineKey]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReducedMotion(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  // Latest config inputs, readable from long-lived intervals without
  // re-arming those effects (re-arming the geometry effect would reseed the
  // particle pools on every slider tick).
  const configInputsRef = useRef<AmbianceConfigInputs>({
    effect,
    intensity,
    reactMode,
    ambianceColor,
    appAccentColor,
    themeAccentColor,
    surfaceSidebar,
    surfaceThread,
    reducedMotion,
    dark,
  });
  configInputsRef.current = {
    effect,
    intensity,
    reactMode,
    ambianceColor,
    appAccentColor,
    themeAccentColor,
    surfaceSidebar,
    surfaceThread,
    reducedMotion,
    dark,
  };

  // Settings → engine config. `theme` is a dependency so the accent-variable
  // fallback re-resolves when the palette flips between light and dark.
  useEffect(() => {
    engineRef.current?.setConfig(buildEngineConfig(configInputsRef.current));
  }, [
    ambianceColor,
    appAccentColor,
    effect,
    intensity,
    reactMode,
    reducedMotion,
    surfaceSidebar,
    surfaceThread,
    theme,
    themeAccentColor,
    dark,
  ]);

  // Geometry: full-window canvas plus the sidebar/thread split boundary.
  // Mount-once; rect reads happen on resize events, sidebar size changes,
  // and a slow safety interval — never inside the frame loop.
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;

    let observer: ResizeObserver | null = null;
    let observedSidebar: Element | null = null;

    const readSideBoundary = (): number => {
      const sidebar = document.querySelector(SIDEBAR_CONTAINER_SELECTOR);
      if (observer && sidebar !== observedSidebar) {
        if (observedSidebar) observer.unobserve(observedSidebar);
        if (sidebar) observer.observe(sidebar);
        observedSidebar = sidebar;
      }
      if (!sidebar) return 0;
      const rect = sidebar.getBoundingClientRect();
      // The sidebar is anchored to the left edge; anything else (mobile sheet
      // mid-animation, detached layouts) falls back to "no sidebar column".
      if (rect.left > 1 || rect.width <= 0) return 0;
      return Math.max(0, Math.min(rect.right, window.innerWidth));
    };

    const syncGeometry = () => {
      engine.resize(
        window.innerWidth,
        window.innerHeight,
        window.devicePixelRatio || 1,
        readSideBoundary(),
      );
    };
    const syncSideOnly = () => {
      engine.setSideBoundary(readSideBoundary());
    };

    observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(syncSideOnly) : null;
    syncGeometry();
    window.addEventListener("resize", syncGeometry);
    // Safety net for sidebar mount/unmount plus computed accent-variable
    // flips (system theme changes) that React dependencies cannot observe.
    const interval = window.setInterval(() => {
      syncSideOnly();
      engine.setConfig(buildEngineConfig(configInputsRef.current));
    }, GEOMETRY_SYNC_INTERVAL_MS);

    return () => {
      window.removeEventListener("resize", syncGeometry);
      window.clearInterval(interval);
      observer?.disconnect();
    };
  }, [engineKey]);

  // Run/pause mirroring the CSS background-animation convention: pause when
  // the document is hidden or the window is blurred unless the user opted
  // into background animations.
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;

    const syncRunState = () => {
      const hidden = document.visibilityState !== "visible";
      const blurred = typeof document.hasFocus === "function" && !document.hasFocus();
      const shouldPause = !continueBackgroundAnimations && (hidden || blurred);
      if (shouldPause) {
        engine.stop();
      } else if (!engine.isRunning()) {
        engine.start();
      }
    };

    syncRunState();
    document.addEventListener("visibilitychange", syncRunState);
    window.addEventListener("focus", syncRunState);
    window.addEventListener("blur", syncRunState);
    return () => {
      document.removeEventListener("visibilitychange", syncRunState);
      window.removeEventListener("focus", syncRunState);
      window.removeEventListener("blur", syncRunState);
      engine.stop();
    };
  }, [engineKey, continueBackgroundAnimations]);

  // Focused-thread signals → engine. Pulses fire only on observed
  // transitions, never on initial subscription, so opening an old thread
  // does not replay its history as weather.
  const previousSignalsRef = useRef<{ threadId: string | null; signals: FocusedThreadSignals }>({
    threadId: null,
    signals: EMPTY_SIGNALS,
  });
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;

    const focusedKey = focusedThreadId ?? null;
    const previous = previousSignalsRef.current;
    const isSameThread = previous.threadId === focusedKey;

    if (focusedKey !== null && signals.status === null) {
      // Focused thread without a projected session yet (fresh thread):
      // settle to idle instead of keeping another thread's leftover weather.
      engine.setSession("idle");
      engine.setHolding(false);
    }

    if (focusedKey !== null && signals.status !== null) {
      engine.setSession(signals.status);
      engine.setHolding(signals.holding);

      if (isSameThread) {
        const before = previous.signals;
        if (signals.status === "error" && before.status !== "error") {
          engine.pulseFault();
        }
        if (
          signals.latestTurnState === "error" &&
          (before.latestTurnState !== "error" || before.latestTurnId !== signals.latestTurnId)
        ) {
          engine.pulseFault();
        }
        if (
          signals.latestTurnState === "completed" &&
          before.latestTurnState === "running" &&
          before.latestTurnId === signals.latestTurnId
        ) {
          engine.pulseClear();
        }
        if (
          reactMode === "live" &&
          signals.lastActivityId !== null &&
          signals.lastActivityId !== before.lastActivityId
        ) {
          const summary = signals.lastActivitySummary ?? "";
          const kind = signals.lastActivityKind ?? "";
          // Context compaction reads as fog; other tool starts as gusts.
          if (kind.includes("compaction") || summary.toLowerCase().includes("compact")) {
            engine.pulseFog();
          } else if (signals.lastActivityTone === "tool" && kind.endsWith("started")) {
            engine.pulseBurst();
          }
        }
      }
    }

    previousSignalsRef.current = { threadId: focusedKey, signals };
  }, [focusedThreadId, reactMode, signals]);

  // Background fallback when no thread is focused (dashboard, settings):
  // a slow bounded poll keeps the sky honest about running work elsewhere.
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;
    if (focusedThreadId) return;
    if (reactMode === "off") {
      engine.setSession("idle");
      engine.setHolding(false);
      return;
    }

    const syncAggregate = () => {
      const state = useStore.getState();
      engine.setSession(selectAnyThreadRunning(state) ? "running" : "idle");
      engine.setHolding(anyThreadHolding(state));
    };
    syncAggregate();
    const interval = window.setInterval(syncAggregate, AGGREGATE_POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [focusedThreadId, reactMode]);

  // State color + composer ring CSS variables. Written at a slow cadence and
  // only on change; the CSS side owns the smoothing transition.
  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) return;

    let lastRing = "";
    let lastColor = "";
    const syncRing = () => {
      const color = engine.stateColor();
      if (color !== lastColor) {
        lastColor = color;
        document.documentElement.style.setProperty(STATE_COLOR_VARIABLE, color);
      }
      if (!surfaceComposer) {
        if (lastRing !== "") {
          lastRing = "";
          document.documentElement.style.removeProperty(COMPOSER_RING_VARIABLE);
        }
        return;
      }
      // Quantize drive so the generated gradient string is stable between
      // small eases and the style write is skipped most ticks.
      const drive = Math.round(engine.currentDrive() * 20) / 20;
      const [r, g, b] = [1, 3, 5].map((offset) =>
        Number.parseInt(color.slice(offset, offset + 2), 16),
      );
      const stop = (alpha: number) => `rgba(${r},${g},${b},${alpha.toFixed(3)})`;
      const ring = `linear-gradient(115deg,${stop(0.14 + drive * 0.5)},${stop(0.05)} 60%,${stop(
        0.2 + drive * 0.35,
      )})`;
      if (ring !== lastRing) {
        lastRing = ring;
        document.documentElement.style.setProperty(COMPOSER_RING_VARIABLE, ring);
      }
    };

    syncRing();
    const interval = window.setInterval(syncRing, RING_SYNC_INTERVAL_MS);
    return () => {
      window.clearInterval(interval);
      clearAmbianceCssVariables();
    };
  }, [surfaceComposer]);

  // Canvas is a replaced element, and `contain: strict` includes size
  // containment. Chromium therefore cannot derive a used size from `inset: 0`
  // alone and collapses the visible box to 0x0 even though the backing bitmap
  // is populated. Keep containment for paint/layout isolation, but give the
  // fixed canvas explicit viewport dimensions so its CSS and bitmap geometry
  // describe the same surface.
  const canvasStyle = useMemo(
    () => ({
      contain: "strict" as const,
      height: "100dvh",
      width: "100vw",
      opacity,
    }),
    [opacity],
  );

  return (
    <canvas
      key={engineKey}
      ref={canvasRef}
      aria-hidden="true"
      data-cafe-ambiance-canvas="true"
      data-cafe-ambiance-backend={backend}
      data-cafe-ambiance-effect={effect}
      className="pointer-events-none fixed inset-0 z-40"
      style={canvasStyle}
    />
  );
}

export function AmbianceLayer() {
  const enabled = useSettings((settings) => settings.ambianceEnabled);

  // Clear any leftover composer-ring variables when ambiance turns off while
  // the app stays mounted (the canvas subtree unmounts with it).
  useEffect(() => {
    if (!enabled) {
      clearAmbianceCssVariables();
    }
  }, [enabled]);

  if (!enabled) {
    return null;
  }
  return <AmbianceCanvas />;
}
