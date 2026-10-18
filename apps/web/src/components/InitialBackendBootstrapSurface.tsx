import { useUiLocale, useUiPresentation } from "~/i18n";
import { uiText } from "@cafecode/shared/i18n";
import * as Schema from "effect/Schema";
import {
  createContext,
  type CSSProperties,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";

import { usePrimaryEnvironmentId } from "../environments/primary";
import { getWsConnectionUiState, useWsConnectionStatus } from "../rpc/wsConnectionState";
import { selectBootstrapCompleteForEnvironment, useStore } from "../store";
import { useDesktopDebugEnabled } from "../lib/desktopDebugState";
import { getLocalStorageItem } from "../hooks/useLocalStorage";
import { useDelayedFlag } from "../hooks/useDelayedFlag";
import { useUiStateStore } from "../uiStateStore";
import { cn } from "../lib/utils";
import { Spinner } from "./ui/spinner";
import { Skeleton } from "./ui/skeleton";
import { SidebarMenuSkeleton } from "./ui/sidebar";

/**
 * Startup sequence (docs/style-guide.md §9): the index.html logo, then the
 * root route's splash, then this skeleton fading in, then the app fading in.
 * Status text waits half a second so a fast start shows only skeletons, and a
 * connection problem waits a second so a brief reconnect never flashes.
 */
const STARTUP_STATUS_DELAY_MS = 500;
const STARTUP_PROBLEM_DELAY_MS = 1_000;

/**
 * The real sidebar persists its resized width under this key and its open
 * state in the UI store (see AppSidebarLayout). Reading the same values keeps
 * the skeleton's columns where the app will put them, so nothing shifts when
 * the app replaces it.
 */
const THREAD_SIDEBAR_WIDTH_STORAGE_KEY = "chat_thread_sidebar_width";
const THREAD_SIDEBAR_MIN_WIDTH = 13 * 16;

function readPersistedSidebarWidth(): number | null {
  try {
    const stored = getLocalStorageItem(THREAD_SIDEBAR_WIDTH_STORAGE_KEY, Schema.Finite);
    return stored === null ? null : Math.max(THREAD_SIDEBAR_MIN_WIDTH, stored);
  } catch {
    // A malformed value falls back to the sidebar's default width, as the
    // real sidebar does.
    return null;
  }
}

function describeBootstrapStatus(input: { readonly problem: "offline" | "error" | null }): {
  readonly detail: string;
  readonly title: string;
} {
  if (input.problem === "offline") {
    return {
      detail: uiText("Waiting for a network connection."),
      title: uiText("Connecting to workspace"),
    };
  }
  if (input.problem === "error") {
    return {
      detail: uiText("Waiting for the workspace to respond."),
      title: uiText("Connecting to workspace"),
    };
  }
  return {
    detail: uiText("Loading projects and chats."),
    title: uiText("Connecting to workspace"),
  };
}

/**
 * True once this surface has rendered its skeleton during startup, so the
 * innermost startup gate (OnboardingSurface) can fade the real app in instead
 * of swapping it in abruptly.
 */
const StartupSkeletonShownContext = createContext(false);

export function useStartupSkeletonShown(): boolean {
  return useContext(StartupSkeletonShownContext);
}

function StartupSidebarSkeleton() {
  const [width] = useState(readPersistedSidebarWidth);
  return (
    <aside
      aria-hidden="true"
      className="hidden min-h-0 w-(--startup-sidebar-width) shrink-0 border-border border-r bg-card text-card-foreground md:flex md:flex-col"
      style={
        {
          "--startup-sidebar-width": width === null ? "16rem" : `${width}px`,
        } as CSSProperties
      }
    >
      {/* macOS draws the traffic lights over this corner. Match the real
          sidebar header's fixed band and leading clearance. */}
      <div className="h-[52px] shrink-0 border-border border-b px-3 py-3 mac-traffic-lights:h-(--app-mac-titlebar-height) mac-traffic-lights:pl-(--app-mac-titlebar-leading-space)">
        <Skeleton className="h-5 w-28 rounded-md" />
      </div>
      <div className="grid gap-2 px-3 py-3">
        <SidebarMenuSkeleton showIcon />
        <div className="pt-3">
          <Skeleton className="h-3 w-16 rounded-full" />
        </div>
        <SidebarMenuSkeleton showIcon />
        <SidebarMenuSkeleton showIcon />
        <SidebarMenuSkeleton className="ml-5" />
        <SidebarMenuSkeleton className="ml-5" />
      </div>
      <div className="min-h-6 flex-1" />
      <div className="grid gap-2 border-border border-t px-3 py-3">
        <SidebarMenuSkeleton showIcon />
        <SidebarMenuSkeleton showIcon />
      </div>
    </aside>
  );
}

function StartupMainSkeleton() {
  return (
    <div aria-hidden="true" className="grid w-full max-w-2xl gap-3">
      <div className="flex items-center gap-3">
        <Skeleton className="size-8 rounded-md" />
        <div className="grid flex-1 gap-2">
          <Skeleton className="h-4 w-48 rounded-full" />
          <Skeleton className="h-3 w-72 max-w-full rounded-full" />
        </div>
      </div>
      <div className="mt-4 grid gap-2">
        <Skeleton className="h-3 w-full rounded-full" />
        <Skeleton className="h-3 w-11/12 rounded-full" />
        <Skeleton className="h-3 w-10/12 rounded-full" />
        <Skeleton className="h-3 w-8/12 rounded-full" />
      </div>
    </div>
  );
}

/**
 * Layout-matching placeholder shown while the workspace connects and, by
 * OnboardingSurface, while settings hydrate. One spinner; its label appears
 * only after a noticeable wait. Screen readers get the status immediately.
 */
export function StartupSkeleton({
  problem = null,
  animateIn = true,
}: {
  readonly problem?: "offline" | "error" | null;
  readonly animateIn?: boolean;
}) {
  const uiPresentation = useUiPresentation(UI_PRESENTATION_SOURCES);

  const showStatus = useDelayedFlag(true, { delayMs: STARTUP_STATUS_DELAY_MS });
  const showProblem = useDelayedFlag(problem !== null, { delayMs: STARTUP_PROBLEM_DELAY_MS });
  const copy = uiPresentation.describeBootstrapStatus({ problem: showProblem ? problem : null });
  const sidebarOpen = useUiStateStore((state) => state.navigationSidebarOpen);

  return (
    <div
      className={cn(
        "flex h-dvh min-h-0 overflow-hidden bg-background text-foreground",
        animateIn && "animate-enter-fade",
      )}
      data-testid="initial-backend-bootstrap-loading"
    >
      {sidebarOpen ? <StartupSidebarSkeleton /> : null}
      <main className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* Like the real content header, reserve the macOS traffic-light corner
            only while the sidebar is hidden and this header reaches it. */}
        <header
          className={cn(
            "flex h-[52px] shrink-0 items-center border-border border-b px-4 md:px-5",
            "mac-traffic-lights:h-(--app-mac-titlebar-height)",
            !sidebarOpen && "mac-traffic-lights:pl-(--app-mac-titlebar-leading-space)",
          )}
        >
          <Skeleton aria-hidden="true" className="h-4 w-40 rounded-full" />
        </header>
        <section className="flex min-h-0 flex-1 items-center justify-center px-6 py-8">
          <div className="grid w-full max-w-2xl gap-8">
            <div
              className="flex min-h-10 min-w-0 items-center gap-3"
              role="status"
              aria-live="polite"
            >
              {showStatus ? (
                <div className="flex min-w-0 animate-enter-fade items-center gap-3">
                  <Spinner
                    aria-hidden="true"
                    className="size-5 shrink-0 text-muted-foreground"
                    role="presentation"
                  />
                  <div className="min-w-0">
                    <h1 className="text-base font-semibold">{copy.title}</h1>
                    <p className="text-sm text-muted-foreground">{copy.detail}</p>
                  </div>
                </div>
              ) : (
                <span className="sr-only">{copy.title}</span>
              )}
            </div>
            <StartupMainSkeleton />
          </div>
        </section>
      </main>
    </div>
  );
}

export function InitialBackendBootstrapSurface({ children }: { readonly children: ReactNode }) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const bootstrapComplete = useStore((state) =>
    selectBootstrapCompleteForEnvironment(state, primaryEnvironmentId),
  );
  // Captured once: if the workspace was not ready on first render, the
  // skeleton was on screen and the app should fade in after it.
  const [skeletonShown] = useState(() => !bootstrapComplete);
  const status = useWsConnectionStatus();
  const uiState = getWsConnectionUiState(status);
  const desktopDebugEnabled = useDesktopDebugEnabled();

  useEffect(() => {
    if (!desktopDebugEnabled) {
      return;
    }
    const bridge = window.desktopBridge;
    if (!bridge?.publishDebugSnapshot) {
      return;
    }

    // This publisher deliberately lives above every route. A new profile opens the
    // onboarding screen, so ChatView cannot prove that the renderer completed its
    // authenticated WebSocket bootstrap. Keep this snapshot free of connection URLs,
    // errors, environment identifiers, and user content because it is served by the
    // local desktop diagnostics endpoint.
    void bridge
      .publishDebugSnapshot({
        debugSnapshotVersion: 1,
        source: "InitialBackendBootstrapSurface",
        capturedAt: new Date().toISOString(),
        diagnostics: {
          online: navigator.onLine,
          localApi: { available: true },
        },
        connection: {
          bootstrapComplete,
          phase: status.phase,
          hasConnected: status.hasConnected,
          connected: status.phase === "connected",
        },
      })
      .catch(() => undefined);
  }, [bootstrapComplete, desktopDebugEnabled, status.hasConnected, status.phase]);

  if (bootstrapComplete) {
    return (
      <StartupSkeletonShownContext.Provider value={skeletonShown}>
        {children}
      </StartupSkeletonShownContext.Provider>
    );
  }

  return (
    <StartupSkeleton problem={uiState === "offline" || uiState === "error" ? uiState : null} />
  );
}

// Finite source-owned labels/helpers only; no received or user data.
const UI_PRESENTATION_SOURCES = { describeBootstrapStatus };
