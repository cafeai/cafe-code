import { useUiLocale, useUiPresentation } from "~/i18n";
import { uiText } from "@cafecode/shared/i18n";
import { useEffect, useState, type ReactNode } from "react";
import { useDelayedFlag } from "~/hooks/useDelayedFlag";
import { CircleAlertIcon, LoaderCircleIcon, RefreshCwIcon, WifiOffIcon } from "lucide-react";
import type { EnvironmentId } from "@cafecode/contracts";

import { cn } from "~/lib/utils";
import {
  getWsConnectionUiState,
  useWsConnectionStatus,
  type WsConnectionStatus,
} from "../../rpc/wsConnectionState";
import {
  getPrimaryEnvironmentConnection,
  reconnectSavedEnvironment,
  useSavedEnvironmentRegistryStore,
  useSavedEnvironmentRuntimeStore,
} from "../../environments/runtime";
import { usePrimaryEnvironmentId } from "../../environments/primary";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import {
  resolveSavedEnvironmentConnectionIssue,
  type ConnectionIssue,
} from "./ConnectionStatusIndicator.logic";

// Offline (no network) wins over a terminal admission rejection, which wins
// over an in-flight reconnect. Transient failures never exhaust their retry.
function resolveConnectionIssue(status: WsConnectionStatus): ConnectionIssue | null {
  const uiState = getWsConnectionUiState(status);
  if (uiState === "offline" && status.disconnectedAt !== null) {
    return "offline";
  }
  if (status.hasConnected && status.reconnectPhase === "exhausted") {
    return "exhausted";
  }
  if (status.hasConnected && uiState === "reconnecting") {
    return "reconnecting";
  }
  return null;
}

function getConnectionDisplayName(status: WsConnectionStatus): string {
  return status.connectionLabel?.trim() || uiText("Cafe Code Server");
}

// Report the enforcing schedule's attempts rather than a fictitious "N/8".
// The delay is capped, but the active protocol owns persistent retries; browser
// resume events do not bypass its ramp. Only a healthy received Pong resets it.
function formatAttemptCount(status: WsConnectionStatus): string | null {
  return formatAttemptCountValue(status.reconnectAttemptCount);
}

function formatAttemptCountValue(count: number): string | null {
  if (count < 1) {
    return null;
  }
  return uiText("{count, plural, one {{count} attempt} other {{count} attempts}}", { count });
}

function formatRetryCountdown(nextRetryAt: string, nowMs: number): string {
  const remainingMs = Math.max(0, new Date(nextRetryAt).getTime() - nowMs);
  return uiText("{seconds}s", { seconds: Math.max(1, Math.ceil(remainingMs / 1000)) });
}

const ISSUE_VISUALS: Record<
  ConnectionIssue,
  { label: string; tone: string; icon: typeof WifiOffIcon; spin?: boolean }
> = {
  reconnecting: {
    get label() {
      return uiText("Reconnecting…");
    },
    tone: "text-status-attention-foreground",
    icon: LoaderCircleIcon,
    spin: true,
  },
  offline: {
    get label() {
      return uiText("Offline");
    },
    tone: "text-muted-foreground",
    icon: WifiOffIcon,
  },
  exhausted: {
    get label() {
      return uiText("Disconnected");
    },
    tone: "text-status-error-foreground",
    icon: CircleAlertIcon,
  },
  disconnected: {
    get label() {
      return uiText("Disconnected");
    },
    tone: "text-muted-foreground",
    icon: CircleAlertIcon,
  },
};

/** Brief reconnects (focus/visibility wakeups) settle within this window. */
const CONNECTION_ISSUE_SHOW_DELAY_MS = 1_000;
/** Keep a shown chip up long enough to read, so it never blinks. */
const CONNECTION_ISSUE_MIN_VISIBLE_MS = 600;

/**
 * Compact connection-status chip beside Settings. Replaces the full-size
 * reconnect toast: the chip shows only a spinner + short label, and the retry
 * countdown / attempt detail lives in a popover opened on hover (desktop) or
 * tap (mobile). Renders nothing while the socket is healthy.
 *
 * Per docs/style-guide.md §9 it waits about a second before appearing, so a
 * reconnect that finishes quickly never flashes, then fades in and out.
 */
export function ConnectionStatusIndicator({
  environmentId,
  className,
  fallback = null,
  side = "bottom",
}: {
  readonly environmentId: EnvironmentId;
  readonly className?: string;
  /** The lower-priority status returns only after the connection chip exits. */
  readonly fallback?: ReactNode;
  readonly side?: "top" | "bottom";
}) {
  const uiLocale = useUiLocale();
  const uiPresentation = useUiPresentation(UI_PRESENTATION_SOURCES);

  const status = useWsConnectionStatus();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const savedRuntime = useSavedEnvironmentRuntimeStore((state) => state.byId[environmentId]);
  const savedEnvironment = useSavedEnvironmentRegistryStore((state) => state.byId[environmentId]);
  const isPrimaryEnvironment = environmentId === primaryEnvironmentId;
  const issue = isPrimaryEnvironment
    ? resolveConnectionIssue(status)
    : resolveSavedEnvironmentConnectionIssue({
        runtime: savedRuntime,
        browserOnline: status.online,
      });
  const [nowMs, setNowMs] = useState(() => Date.now());
  const savedNextRetryAt = savedRuntime?.nextRetryAt ?? null;
  const shown = useDelayedFlag(issue !== null, {
    delayMs: CONNECTION_ISSUE_SHOW_DELAY_MS,
    minVisibleMs: CONNECTION_ISSUE_MIN_VISIBLE_MS,
  });
  // While the chip fades out after recovery, keep showing the last issue it
  // described rather than collapsing mid-fade.
  const [lastIssue, setLastIssue] = useState<ConnectionIssue | null>(issue);
  if (issue !== null && issue !== lastIssue) {
    setLastIssue(issue);
  }
  const [rendered, setRendered] = useState(false);
  if (shown && !rendered) {
    setRendered(true);
  }
  useEffect(() => {
    if (shown || !rendered) return;
    // Exit fade (fast) before unmounting.
    const timer = window.setTimeout(() => setRendered(false), 150);
    return () => window.clearTimeout(timer);
  }, [rendered, shown]);
  const displayIssue = issue ?? lastIssue;

  const isCountingDown =
    issue === "reconnecting" &&
    (isPrimaryEnvironment
      ? status.reconnectPhase === "waiting" && status.nextRetryAt !== null
      : savedRuntime?.reconnectPhase === "waiting" && savedNextRetryAt !== null);

  useEffect(() => {
    if (!isCountingDown) {
      return;
    }
    setNowMs(Date.now());
    const intervalId = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(intervalId);
  }, [isCountingDown, savedNextRetryAt, status.nextRetryAt]);

  if (!rendered || displayIssue === null) {
    return fallback;
  }

  const visual = uiPresentation.ISSUE_VISUALS[displayIssue];
  const Icon = visual.icon;
  const attemptLabel = isPrimaryEnvironment
    ? uiPresentation.formatAttemptCount(status)
    : uiPresentation.formatAttemptCountValue(savedRuntime?.reconnectAttemptCount ?? 0);
  const connectionDisplayName = isPrimaryEnvironment
    ? uiPresentation.getConnectionDisplayName(status)
    : savedEnvironment?.label.trim() ||
      uiText("Saved Cafe Code Server", undefined, undefined, uiLocale);
  const nextRetryAt = isPrimaryEnvironment ? status.nextRetryAt : savedNextRetryAt;
  const lastError = isPrimaryEnvironment ? status.lastError : (savedRuntime?.lastError ?? null);

  const handleRetry = () => {
    const retry = isPrimaryEnvironment
      ? getPrimaryEnvironmentConnection().reconnect()
      : reconnectSavedEnvironment(environmentId);
    void retry.catch((error) => {
      console.warn("Manual WebSocket reconnect failed", { error });
    });
  };

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={0}
        render={
          <button
            type="button"
            data-cafe-connection-status
            data-state={shown ? "open" : "closed"}
            className={cn(
              "inline-flex shrink-0 animate-enter-fade items-center gap-1.5 rounded-full border border-border bg-muted px-2 py-0.5 text-2xs font-medium transition-[background-color,opacity] duration-(--duration-fast) ease-out hover:bg-accent data-[state=closed]:pointer-events-none data-[state=closed]:opacity-0",
              visual.tone,
              className,
            )}
            aria-label={uiText(
              "Connection {value0}. Show reconnect details.",
              {
                value0: visual.label,
              },
              undefined,
              uiLocale,
            )}
          >
            <Icon
              className={cn("size-3 shrink-0", visual.spin && "animate-spin")}
              aria-hidden="true"
            />
            <span className="truncate">{visual.label}</span>
          </button>
        }
      />
      <PopoverPopup tooltipStyle side={side} align="end" className="w-max max-w-64 px-3 py-2">
        <div className="space-y-1.5 leading-tight">
          <div className="text-xs font-medium text-foreground">
            {displayIssue === "offline"
              ? uiText("Offline", undefined, undefined, uiLocale)
              : uiText(
                  "Disconnected from {value0}",
                  { value0: connectionDisplayName },
                  undefined,
                  uiLocale,
                )}
          </div>
          <div className="space-y-0.5 text-2xs text-muted-foreground">
            {displayIssue === "offline" ? (
              <div>{uiText("Waiting for network.", undefined, undefined, uiLocale)}</div>
            ) : displayIssue === "exhausted" ? (
              <div>
                {uiText(
                  "Automatic reconnect paused. Check the connection, then retry.",
                  undefined,
                  undefined,
                  uiLocale,
                )}
              </div>
            ) : displayIssue === "disconnected" ? (
              <div>{uiText("This connection is inactive.", undefined, undefined, uiLocale)}</div>
            ) : (
              <>
                <div>
                  {nextRetryAt === null
                    ? uiText("Reconnecting now…", undefined, undefined, uiLocale)
                    : uiText(
                        "Next attempt in {value0}",
                        {
                          value0: uiPresentation.formatRetryCountdown(nextRetryAt, nowMs),
                        },
                        undefined,
                        uiLocale,
                      )}
                </div>
                {attemptLabel ? <div>{attemptLabel}</div> : null}
              </>
            )}
            {lastError ? <div className="text-subtle-foreground">{lastError}</div> : null}
          </div>
          {displayIssue !== "offline" ? (
            <button
              type="button"
              onClick={handleRetry}
              className="mt-1 inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-2xs font-medium text-foreground transition-colors duration-(--duration-fast) hover:bg-muted"
            >
              <RefreshCwIcon className="size-3" aria-hidden="true" />
              {displayIssue === "exhausted"
                ? uiText("Retry", undefined, undefined, uiLocale)
                : uiText("Retry now", undefined, undefined, uiLocale)}
            </button>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

// Finite source-owned labels/helpers only; no received or user data.
const UI_PRESENTATION_SOURCES = {
  ISSUE_VISUALS,
  formatAttemptCount,
  formatAttemptCountValue,
  formatRetryCountdown,
  getConnectionDisplayName,
};
