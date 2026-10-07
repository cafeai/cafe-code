import { useEffect, useState } from "react";
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

// Mirror the precedence the toast surface used: offline (no network) wins over
// an exhausted retry loop, which wins over an in-flight reconnect.
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
  return status.connectionLabel?.trim() || "Cafe Code Server";
}

// A running total of attempts this outage rather than "N/8": the backoff cap is
// not a real ceiling — focus/visibility/online events keep retrying past it, so
// the count climbs until the socket actually reconnects.
function formatAttemptCount(status: WsConnectionStatus): string | null {
  return formatAttemptCountValue(status.reconnectAttemptCount);
}

function formatAttemptCountValue(count: number): string | null {
  if (count < 1) {
    return null;
  }
  return `${count} attempt${count === 1 ? "" : "s"}`;
}

function formatRetryCountdown(nextRetryAt: string, nowMs: number): string {
  const remainingMs = Math.max(0, new Date(nextRetryAt).getTime() - nowMs);
  return `${Math.max(1, Math.ceil(remainingMs / 1000))}s`;
}

const ISSUE_VISUALS: Record<
  ConnectionIssue,
  { label: string; tone: string; icon: typeof WifiOffIcon; spin?: boolean }
> = {
  reconnecting: {
    label: "Reconnecting…",
    tone: "text-status-attention-foreground",
    icon: LoaderCircleIcon,
    spin: true,
  },
  offline: { label: "Offline", tone: "text-muted-foreground", icon: WifiOffIcon },
  exhausted: {
    label: "Disconnected",
    tone: "text-status-error-foreground",
    icon: CircleAlertIcon,
  },
  disconnected: {
    label: "Disconnected",
    tone: "text-muted-foreground",
    icon: CircleAlertIcon,
  },
};

/** Brief reconnects (focus/visibility wakeups) settle within this window. */
const CONNECTION_ISSUE_SHOW_DELAY_MS = 1_000;
/** Keep a shown chip up long enough to read, so it never blinks. */
const CONNECTION_ISSUE_MIN_VISIBLE_MS = 600;

/**
 * Compact connection-status chip for the chat header. Replaces the full-size
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
}: {
  readonly environmentId: EnvironmentId;
  readonly className?: string;
}) {
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
    return null;
  }

  const visual = ISSUE_VISUALS[displayIssue];
  const Icon = visual.icon;
  const attemptLabel = isPrimaryEnvironment
    ? formatAttemptCount(status)
    : formatAttemptCountValue(savedRuntime?.reconnectAttemptCount ?? 0);
  const connectionDisplayName = isPrimaryEnvironment
    ? getConnectionDisplayName(status)
    : savedEnvironment?.label.trim() || "Saved Cafe Code Server";
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
            data-state={shown ? "open" : "closed"}
            className={cn(
              "inline-flex shrink-0 animate-enter-fade items-center gap-1.5 rounded-full border border-border bg-muted px-2 py-0.5 text-2xs font-medium transition-[background-color,opacity] duration-(--duration-fast) ease-out hover:bg-accent data-[state=closed]:pointer-events-none data-[state=closed]:opacity-0",
              visual.tone,
              className,
            )}
            aria-label={`Connection ${visual.label}. Show reconnect details.`}
          >
            <Icon className={cn("size-3", visual.spin && "animate-spin")} aria-hidden="true" />
            <span className="whitespace-nowrap">{visual.label}</span>
          </button>
        }
      />
      <PopoverPopup tooltipStyle side="bottom" align="end" className="w-max max-w-64 px-3 py-2">
        <div className="space-y-1.5 leading-tight">
          <div className="text-xs font-medium text-foreground">
            {displayIssue === "offline" ? "Offline" : `Disconnected from ${connectionDisplayName}`}
          </div>
          <div className="space-y-0.5 text-2xs text-muted-foreground">
            {displayIssue === "offline" ? (
              <div>Waiting for network.</div>
            ) : displayIssue === "exhausted" ? (
              <div>
                {attemptLabel
                  ? isPrimaryEnvironment
                    ? `Paused after ${attemptLabel}; retries when you're back.`
                    : `Retries exhausted after ${attemptLabel}.`
                  : "Retries exhausted trying to reconnect."}
              </div>
            ) : displayIssue === "disconnected" ? (
              <div>This connection is inactive.</div>
            ) : (
              <>
                <div>
                  {nextRetryAt === null
                    ? "Reconnecting now…"
                    : `Next attempt in ${formatRetryCountdown(nextRetryAt, nowMs)}`}
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
              {displayIssue === "exhausted" ? "Retry" : "Retry now"}
            </button>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
