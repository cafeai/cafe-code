import { useNavigate } from "@tanstack/react-router";
import type { ServerProvider } from "@cafecode/contracts";
import { CircleCheckIcon, DownloadIcon, LoaderIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type TransitionEvent as ReactTransitionEvent,
} from "react";

import { useServerProviders } from "../../rpc/serverState";
import {
  getProviderUpdateSidebarPillView,
  type ProviderUpdateSidebarPillView,
} from "../ProviderUpdateLaunchNotification.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const PROVIDER_UPDATE_PILL_STYLES = {
  loading:
    "bg-primary/15 text-primary group-has-[button.provider-update-main:hover]/provider-update:bg-primary/22",
  success:
    "bg-success/12 text-success group-has-[button.provider-update-main:hover]/provider-update:bg-success/18",
  warning:
    "bg-warning/12 text-warning group-has-[button.provider-update-main:hover]/provider-update:bg-warning/18",
  error:
    "bg-destructive/12 text-destructive group-has-[button.provider-update-main:hover]/provider-update:bg-destructive/18",
} as const;

const PROVIDER_UPDATE_PILL_PROGRESS_STYLES = {
  success: "bg-success/18",
  warning: "bg-warning/14",
  error: "bg-destructive/14",
} as const;

// The visual exit lasts 180 ms. React state must never depend exclusively on
// `transitionend`: Chromium is allowed to emit `transitioncancel` instead, and
// a hidden or suspended Electron renderer can omit both events. This bounded
// fallback keeps animation decorative rather than a provider-state authority.
const PROVIDER_UPDATE_PILL_EXIT_FALLBACK_MS = 250;

interface ProviderUpdatePillTransitionState {
  readonly dismissedKeys: ReadonlySet<string>;
  readonly renderedView: ProviderUpdateSidebarPillView | null;
  readonly pendingView: ProviderUpdateSidebarPillView | null;
  readonly exitingKey: string | null;
  readonly dismissAfterExitKey: string | null;
}

const INITIAL_PROVIDER_UPDATE_PILL_TRANSITION_STATE: ProviderUpdatePillTransitionState = {
  dismissedKeys: new Set(),
  renderedView: null,
  pendingView: null,
  exitingKey: null,
  dismissAfterExitKey: null,
};

function latestProviderCheckedAt(
  providers: ReadonlyArray<Pick<ServerProvider, "checkedAt">>,
): string | undefined {
  return providers.reduce<string | undefined>(
    (latest, provider) =>
      latest === undefined || provider.checkedAt > latest ? provider.checkedAt : latest,
    undefined,
  );
}

export function SidebarProviderUpdatePillContent({
  providers,
  onOpenProviderSettings,
}: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly onOpenProviderSettings: () => void;
}) {
  const [transitionState, setTransitionState] = useState<ProviderUpdatePillTransitionState>(
    () => INITIAL_PROVIDER_UPDATE_PILL_TRANSITION_STATE,
  );
  const [visibleAfterIso, setVisibleAfterIso] = useState<string | undefined>();
  const effectiveVisibleAfterIso = visibleAfterIso ?? latestProviderCheckedAt(providers);
  const view = useMemo(
    () =>
      getProviderUpdateSidebarPillView(providers, {
        ...(effectiveVisibleAfterIso !== undefined
          ? { visibleAfterIso: effectiveVisibleAfterIso }
          : {}),
        dismissedKeys: transitionState.dismissedKeys,
      }),
    [effectiveVisibleAfterIso, providers, transitionState.dismissedKeys],
  );

  useEffect(() => {
    if (visibleAfterIso === undefined && effectiveVisibleAfterIso !== undefined) {
      setVisibleAfterIso(effectiveVisibleAfterIso);
    }
  }, [effectiveVisibleAfterIso, visibleAfterIso]);

  const displayedView = transitionState.renderedView ?? view;
  const dismissAfterVisibleMs = displayedView?.dismissAfterVisibleMs;
  const viewKey = displayedView?.key ?? null;
  const showDismissProgress =
    dismissAfterVisibleMs !== undefined &&
    displayedView?.tone !== "loading" &&
    transitionState.exitingKey !== viewKey;

  const startExit = useCallback(
    (key: string, nextView: ProviderUpdateSidebarPillView | null, dismissKey?: string) =>
      setTransitionState((previous) => {
        if (previous.exitingKey === key) {
          const nextDismissAfterExitKey = dismissKey ?? previous.dismissAfterExitKey;
          if (
            previous.pendingView === nextView &&
            previous.dismissAfterExitKey === nextDismissAfterExitKey
          ) {
            return previous;
          }
          return {
            ...previous,
            pendingView: nextView,
            dismissAfterExitKey: nextDismissAfterExitKey,
          };
        }
        return {
          ...previous,
          pendingView: nextView,
          exitingKey: key,
          dismissAfterExitKey: dismissKey ?? null,
        };
      }),
    [],
  );

  const completeExit = useCallback((key: string) => {
    setTransitionState((previous) => {
      // Multiple CSS properties may finish independently, transitioncancel can
      // race the timeout, and React Strict Mode may replay effects. Matching the
      // exact key makes every completion path safely idempotent.
      if (previous.exitingKey !== key) {
        return previous;
      }
      const dismissedKeys =
        previous.dismissAfterExitKey === key
          ? new Set(previous.dismissedKeys).add(key)
          : previous.dismissedKeys;
      return {
        dismissedKeys,
        renderedView: previous.pendingView,
        pendingView: null,
        exitingKey: null,
        dismissAfterExitKey: null,
      };
    });
  }, []);

  useEffect(() => {
    setTransitionState((previous) => {
      if (previous.exitingKey !== null) {
        // Provider status can move through queued, running, and terminal states
        // during a single 180 ms exit. Always land on the newest authoritative
        // view rather than an intermediate snapshot captured at exit start.
        return previous.pendingView === view ? previous : { ...previous, pendingView: view };
      }
      if (!previous.renderedView) {
        return view ? { ...previous, renderedView: view } : previous;
      }
      if (!view || view.key !== previous.renderedView.key) {
        return {
          ...previous,
          pendingView: view,
          exitingKey: previous.renderedView.key,
          dismissAfterExitKey: null,
        };
      }
      return previous.renderedView === view ? previous : { ...previous, renderedView: view };
    });
  }, [view]);

  useEffect(() => {
    const exitingKey = transitionState.exitingKey;
    if (exitingKey === null) {
      return;
    }
    const timeoutId = window.setTimeout(
      () => completeExit(exitingKey),
      PROVIDER_UPDATE_PILL_EXIT_FALLBACK_MS,
    );
    return () => window.clearTimeout(timeoutId);
  }, [completeExit, transitionState.exitingKey]);

  useEffect(() => {
    if (!dismissAfterVisibleMs || !viewKey) {
      return;
    }
    if (transitionState.exitingKey === viewKey) {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      startExit(viewKey, null, viewKey);
    }, dismissAfterVisibleMs);

    return () => window.clearTimeout(timeoutId);
  }, [dismissAfterVisibleMs, startExit, transitionState.exitingKey, viewKey]);

  if (!displayedView) {
    return null;
  }

  return (
    <div
      data-cafe-provider-update-pill="true"
      className={`group/provider-update relative flex h-7 w-full items-center overflow-hidden rounded-lg text-xs font-medium transform-gpu transition-all duration-180 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-transform ${
        PROVIDER_UPDATE_PILL_STYLES[displayedView.tone]
      } ${
        transitionState.exitingKey === displayedView.key
          ? "pointer-events-none translate-y-1.5 opacity-0"
          : "translate-y-0 opacity-100"
      }`}
      onTransitionEnd={(event: ReactTransitionEvent<HTMLDivElement>) => {
        if (event.target !== event.currentTarget) {
          return;
        }
        completeExit(displayedView.key);
      }}
      onTransitionCancel={(event: ReactTransitionEvent<HTMLDivElement>) => {
        if (event.target !== event.currentTarget) {
          return;
        }
        completeExit(displayedView.key);
      }}
    >
      {showDismissProgress ? (
        <div
          key={displayedView.key}
          aria-hidden="true"
          className={`provider-update-pill-progress pointer-events-none absolute inset-y-0 left-0 w-full origin-left border-r border-current/15 shadow-[inset_0_1px_0_rgb(255_255_255_/_0.08)] ${
            PROVIDER_UPDATE_PILL_PROGRESS_STYLES[displayedView.tone]
          }`}
          style={
            {
              "--provider-update-pill-dismiss-ms": `${dismissAfterVisibleMs}ms`,
            } as CSSProperties
          }
        />
      ) : null}
      <div className="pointer-events-none absolute inset-0 rounded-lg transition-colors" />
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={displayedView.description}
              className="provider-update-main relative z-[1] flex h-full flex-1 items-center gap-2 px-2 text-left"
              onClick={onOpenProviderSettings}
            >
              {displayedView.tone === "loading" ? (
                <LoaderIcon className="size-3.5 animate-spin" />
              ) : displayedView.tone === "success" ? (
                <CircleCheckIcon className="size-3.5" />
              ) : displayedView.tone === "error" ? (
                <TriangleAlertIcon className="size-3.5" />
              ) : (
                <DownloadIcon className="size-3.5" />
              )}
              <span>{displayedView.title}</span>
            </button>
          }
        />
        <TooltipPopup side="top">{displayedView.description}</TooltipPopup>
      </Tooltip>
      {displayedView.dismissible && (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label="Dismiss provider update notice"
                className="relative z-[1] mr-1 inline-flex size-5 items-center justify-center rounded-md opacity-70 transition-opacity hover:opacity-100"
                onClick={() => startExit(displayedView.key, null, displayedView.key)}
              >
                <XIcon className="size-3.5" />
              </button>
            }
          />
          <TooltipPopup side="top">Dismiss until provider status changes</TooltipPopup>
        </Tooltip>
      )}
    </div>
  );
}

export function SidebarProviderUpdatePill() {
  const navigate = useNavigate();
  const providers = useServerProviders();
  const openProviderSettings = useCallback(() => {
    void navigate({ to: "/settings/providers" });
  }, [navigate]);

  return (
    <SidebarProviderUpdatePillContent
      providers={providers}
      onOpenProviderSettings={openProviderSettings}
    />
  );
}
