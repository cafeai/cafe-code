import { memo, useCallback, useRef, useState } from "react";
import type { EnvironmentId, TaskAtriumErrorDismissal, ThreadId } from "@cafecode/contracts";
import { isCodexHistoryRecoveryRequiredError } from "@cafecode/shared/codexHistorySafety";
import { isClaudeResponseLimitError } from "@cafecode/shared/claudeResponseLimits";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { CircleAlertIcon, XIcon } from "lucide-react";

import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { getClientSettingsSnapshot } from "../../hooks/clientSettingsState";
import { useStore } from "../../store";
import {
  buildThreadErrorDismissal,
  collectCodexAppServerExitDismissals,
  isCodexAppServerExitError,
  isSameErrorDismissal,
  mergeTaskAtriumErrorDismissals,
} from "../atrium/taskAtriumData";

export const ThreadErrorBanner = memo(function ThreadErrorBanner({
  error,
  scopeKey,
  environmentId,
  threadId,
  canContinueInNewChat = false,
  onContinueInNewChat,
  canPrepareShorterResponse = false,
  onPrepareShorterResponse,
}: {
  error: string | null;
  /** Stable environment/thread identity for immediate local dismissal feedback. */
  scopeKey: string;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  canContinueInNewChat?: boolean;
  onContinueInNewChat?: () => Promise<void>;
  canPrepareShorterResponse?: boolean;
  /** Prepare editable text only; ChatView revalidates current ownership and content. */
  onPrepareShorterResponse?: (() => void) | undefined;
}) {
  const [dismissedErrorsByScope, setDismissedErrorsByScope] = useState<
    Readonly<Record<string, { error: string; occurrence: TaskAtriumErrorDismissal | null }>>
  >({});
  const dismissedTaskAtriumErrors = useSettings((settings) => settings.dismissedTaskAtriumErrors);
  const { updateSettings } = useUpdateSettings();
  const summary = useStore(
    (state) => state.environmentStateById[environmentId]?.sidebarThreadSummaryById[threadId],
  );
  const session = useStore(
    (state) =>
      state.environmentStateById[environmentId]?.threadSessionById[threadId] ??
      summary?.session ??
      null,
  );
  const latestTurn = useStore(
    (state) =>
      state.environmentStateById[environmentId]?.threadTurnStateById[threadId]?.latestTurn ??
      summary?.latestTurn ??
      null,
  );
  const occurrence = summary
    ? buildThreadErrorDismissal({ environmentId, threadId, session, latestTurn, summary })
    : null;
  const isProviderFailure = Boolean(error && error === session?.lastError);
  const isClaudeResponseLimitFailure =
    isProviderFailure &&
    error !== null &&
    isClaudeResponseLimitError(error) &&
    session?.provider === "claudeAgent" &&
    session.orchestrationStatus === "error" &&
    session.activeTurnId === undefined &&
    latestTurn?.state === "error" &&
    latestTurn.completedAt !== null;

  const [recoveryState, setRecoveryState] = useState<{
    scopeKey: string;
    error: string;
    pending: boolean;
    failed: boolean;
  } | null>(null);
  const pendingRecovery = useRef<{ scopeKey: string; error: string } | null>(null);
  const recover = useCallback(async () => {
    if (
      !error ||
      !isCodexHistoryRecoveryRequiredError(error) ||
      !canContinueInNewChat ||
      !onContinueInNewChat ||
      (pendingRecovery.current?.scopeKey === scopeKey && pendingRecovery.current.error === error)
    )
      return;
    const occurrence = { scopeKey, error, pending: true, failed: false };
    pendingRecovery.current = occurrence;
    setRecoveryState(occurrence);
    try {
      await onContinueInNewChat();
      setRecoveryState((current) => (current === occurrence ? null : current));
    } catch {
      // Transport diagnostics can contain private native details. Keep the
      // original error and an explicit uncertain-copy notice, never replay work.
      setRecoveryState((current) =>
        current === occurrence ? { ...occurrence, pending: false, failed: true } : current,
      );
    } finally {
      if (pendingRecovery.current === occurrence) pendingRecovery.current = null;
    }
  }, [canContinueInNewChat, error, onContinueInNewChat, scopeKey]);

  const dismiss = useCallback(() => {
    if (!error) return;
    setDismissedErrorsByScope((current) => ({ ...current, [scopeKey]: { error, occurrence } }));

    // Restart-related app-server exits can be repeated across this server's
    // shell catalog. Capture and acknowledge those current copies together;
    // later failures still require their own gesture. All writes remain the
    // existing presentation-only, bounded Atrium occurrence watermarks.
    // Local command rejections share the provider's lifecycle slices, but
    // dismissing them must not acknowledge an unrelated provider failure.
    if (!occurrence || !isProviderFailure) return;
    const copies = collectCodexAppServerExitDismissals(useStore.getState(), environmentId, error);
    updateSettings({
      dismissedTaskAtriumErrors: mergeTaskAtriumErrorDismissals(
        getClientSettingsSnapshot().dismissedTaskAtriumErrors,
        [...copies, occurrence],
      ),
    });
  }, [environmentId, error, isProviderFailure, occurrence, scopeKey, updateSettings]);

  // Switching servers remounts this banner. Read the same bounded persisted
  // occurrence watermarks that dismissal already writes for the Atrium, so a
  // remount or reload cannot resurrect that acknowledged failure. Subscribe
  // only to this thread's lifecycle slices so a later failure becomes visible
  // without subscribing the banner to message/token updates.
  const locallyDismissed = dismissedErrorsByScope[scopeKey];
  const sameLocalOccurrence =
    locallyDismissed &&
    (!locallyDismissed.occurrence ||
      !occurrence ||
      isSameErrorDismissal(locallyDismissed.occurrence, occurrence));
  const persistedDismissal =
    isProviderFailure &&
    occurrence &&
    dismissedTaskAtriumErrors.some((saved) => isSameErrorDismissal(saved, occurrence));
  // Another pane can acknowledge the shared exit warning. Preserve local
  // exact-text handling for ordinary diagnostics, while honoring that shared
  // acknowledgement even if this pane previously dismissed a different error.
  const dismissed = sameLocalOccurrence
    ? locallyDismissed.error === error || (isCodexAppServerExitError(error) && persistedDismissal)
    : persistedDismissal;
  // Apply saved lifecycle watermarks only to the matching provider diagnostic,
  // so a different local error stays visible even after remount. Persistence
  // contains identities/timestamps only, never
  // provider error text, and acknowledging it cannot mutate provider truth.
  if (!error || dismissed) return null;
  const recoveryForScope =
    recoveryState?.scopeKey === scopeKey && recoveryState.error === error ? recoveryState : null;
  return (
    <div className="pt-3 mx-auto max-w-3xl animate-enter-rise">
      <Alert variant="error">
        <CircleAlertIcon />
        <AlertDescription>
          <span className="line-clamp-3" title={error}>
            {error}
          </span>
          {isClaudeResponseLimitFailure && onPrepareShorterResponse ? (
            <div className="flex flex-col items-start gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!canPrepareShorterResponse}
                onClick={() => {
                  if (canPrepareShorterResponse) onPrepareShorterResponse();
                }}
              >
                Prepare shorter response
              </Button>
              <span className="text-muted-foreground text-xs">
                Review effort, then send from the composer.
              </span>
            </div>
          ) : null}
          {isCodexHistoryRecoveryRequiredError(error) && onContinueInNewChat ? (
            <div className="flex flex-col items-start gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!canContinueInNewChat || recoveryForScope?.pending === true}
                onClick={() => {
                  void recover();
                }}
              >
                {recoveryForScope?.pending ? "Continuing…" : "Continue in new chat"}
              </Button>
              {recoveryForScope?.failed ? (
                <span role="status">
                  Couldn&apos;t confirm the new chat. No prompt was sent — check your chat list
                  before trying again.
                </span>
              ) : null}
            </div>
          ) : null}
        </AlertDescription>
        <AlertAction>
          <button
            type="button"
            aria-label="Dismiss error"
            className="focus-ring inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors duration-(--duration-fast) hover:text-foreground"
            onClick={dismiss}
          >
            <XIcon className="size-3.5" />
          </button>
        </AlertAction>
      </Alert>
    </div>
  );
});
