import { type ReactNode, useEffect } from "react";

import { usePrimaryEnvironmentId } from "../environments/primary";
import { getWsConnectionUiState, useWsConnectionStatus } from "../rpc/wsConnectionState";
import { selectBootstrapCompleteForEnvironment, useStore } from "../store";
import { useDesktopDebugEnabled } from "../lib/desktopDebugState";
import { Spinner } from "./ui/spinner";
import { Skeleton } from "./ui/skeleton";
import { SidebarMenuSkeleton } from "./ui/sidebar";

function describeBootstrapStatus(input: {
  readonly uiState: ReturnType<typeof getWsConnectionUiState>;
}): { readonly detail: string; readonly title: string } {
  if (input.uiState === "offline") {
    return {
      detail: "Waiting for a network connection.",
      title: "Connecting to workspace",
    };
  }

  if (input.uiState === "error") {
    return {
      detail: "Waiting for the workspace to respond.",
      title: "Connecting to workspace",
    };
  }

  return {
    detail: "Loading projects and chats.",
    title: "Connecting to workspace",
  };
}

function StartupSidebarSkeleton() {
  return (
    <aside
      aria-hidden="true"
      className="hidden min-h-0 border-border border-r bg-card text-card-foreground md:flex md:w-64 md:flex-col"
    >
      <div className="h-[52px] shrink-0 border-border border-b px-3 py-3">
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

export function InitialBackendBootstrapSurface({ children }: { readonly children: ReactNode }) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const bootstrapComplete = useStore((state) =>
    selectBootstrapCompleteForEnvironment(state, primaryEnvironmentId),
  );
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
    return children;
  }

  const copy = describeBootstrapStatus({
    uiState: uiState === "connected" ? "connecting" : uiState,
  });

  return (
    <div
      className="grid h-dvh min-h-0 grid-cols-1 overflow-hidden bg-background text-foreground md:grid-cols-[auto_minmax(0,1fr)]"
      data-testid="initial-backend-bootstrap-loading"
    >
      <StartupSidebarSkeleton />
      <main className="flex min-h-0 min-w-0 flex-col">
        <header className="flex h-[52px] shrink-0 items-center border-border border-b px-4 md:px-5">
          <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
            <Spinner
              aria-hidden="true"
              className="size-4 shrink-0 text-muted-foreground"
              role="presentation"
            />
            <span className="truncate">{copy.title}</span>
          </div>
        </header>
        <section className="flex min-h-0 flex-1 items-center justify-center px-6 py-8">
          <div className="grid w-full max-w-2xl gap-8">
            <div className="flex min-w-0 items-start gap-4" role="status" aria-live="polite">
              <div className="mt-0.5 rounded-md border border-border bg-card p-2 text-muted-foreground">
                <Spinner aria-hidden="true" className="size-5" role="presentation" />
              </div>
              <div className="min-w-0">
                <h1 className="text-lg font-semibold tracking-normal">{copy.title}</h1>
                <p className="mt-1 max-w-md text-sm leading-6 text-muted-foreground">
                  {copy.detail}
                </p>
              </div>
            </div>
            <StartupMainSkeleton />
          </div>
        </section>
      </main>
    </div>
  );
}
