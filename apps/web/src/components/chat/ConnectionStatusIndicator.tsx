import { useEffect, useState } from "react";
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
    tone: "text-amber-600 dark:text-amber-500",
    icon: LoaderCircleIcon,
    spin: true,
  },
  offline: { label: "Offline", tone: "text-muted-foreground", icon: WifiOffIcon },
  exhausted: {
    label: "Disconnected",
    tone: "text-rose-600 dark:text-rose-500",
    icon: CircleAlertIcon,
  },
  disconnected: {
    label: "Disconnected",
    tone: "text-muted-foreground",
    icon: CircleAlertIcon,
  },
};

/**
 * Compact connection-status chip for the chat header. Replaces the full-size
 * reconnect toast: the chip shows only a spinner + short label, and the retry
 * countdown / attempt detail lives in a popover opened on hover (desktop) or
 * tap (mobile). Renders nothing while the socket is healthy.
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

  if (issue === null) {
    return null;
  }

  const visual = ISSUE_VISUALS[issue];
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
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 rounded-full border border-border/60 bg-muted/20 px-2 py-0.5 text-[11px] font-medium transition-colors hover:bg-muted/50",
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
      <PopoverPopup
        tooltipStyle
        side="bottom"
        align="end"
        className="w-max max-w-[260px] px-3 py-2"
      >
        <div className="space-y-1.5 leading-tight">
          <div className="text-[12px] font-medium text-foreground">
            {issue === "offline" ? "Offline" : `Disconnected from ${connectionDisplayName}`}
          </div>
          <div className="space-y-0.5 text-[11px] text-muted-foreground">
            {issue === "offline" ? (
              <div>Waiting for network.</div>
            ) : issue === "exhausted" ? (
              <div>
                {attemptLabel
                  ? isPrimaryEnvironment
                    ? `Backoff stopped after ${attemptLabel} — retrying on activity.`
                    : `Retries exhausted after ${attemptLabel}.`
                  : "Retries exhausted trying to reconnect."}
              </div>
            ) : issue === "disconnected" ? (
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
            {lastError ? <div className="text-muted-foreground/80">{lastError}</div> : null}
          </div>
          {issue !== "offline" ? (
            <button
              type="button"
              onClick={handleRetry}
              className="mt-1 inline-flex items-center gap-1 rounded-md border border-border/60 bg-background px-2 py-1 text-[11px] font-medium text-foreground transition-colors hover:bg-muted"
            >
              <RefreshCwIcon className="size-3" aria-hidden="true" />
              {issue === "exhausted" ? "Retry" : "Retry now"}
            </button>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
