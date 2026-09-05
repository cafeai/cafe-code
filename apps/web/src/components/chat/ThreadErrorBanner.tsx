import { memo, useCallback, useState } from "react";
import type { EnvironmentId, ThreadId } from "@cafecode/contracts";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { CircleAlertIcon, XIcon } from "lucide-react";

import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { useStore } from "../../store";
import {
  buildThreadErrorDismissal,
  mergeTaskAtriumErrorDismissals,
} from "../atrium/taskAtriumData";

export const ThreadErrorBanner = memo(function ThreadErrorBanner({
  error,
  scopeKey,
  environmentId,
  threadId,
}: {
  error: string | null;
  /** Stable environment/thread identity; error text supplies the occurrence key. */
  scopeKey: string;
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const [dismissedErrorsByScope, setDismissedErrorsByScope] = useState<
    Readonly<Record<string, string>>
  >({});
  const dismissedTaskAtriumErrors = useSettings((settings) => settings.dismissedTaskAtriumErrors);
  const { updateSettings } = useUpdateSettings();

  const dismiss = useCallback(() => {
    if (!error) return;
    setDismissedErrorsByScope((current) =>
      current[scopeKey] === error ? current : { ...current, [scopeKey]: error },
    );

    // Acknowledging a failure here also clears it from the Task Atrium. The
    // error is read once, in the place that actually shows what went wrong;
    // having to dismiss the same failure a second time somewhere else is what
    // made the Atrium look permanently broken.
    const environment = useStore.getState().environmentStateById[environmentId];
    const summary = environment?.sidebarThreadSummaryById[threadId];
    if (!summary) return;
    const dismissal = buildThreadErrorDismissal({
      environmentId,
      threadId,
      session: environment?.threadSessionById[threadId] ?? summary.session ?? null,
      latestTurn: environment?.threadTurnStateById[threadId]?.latestTurn ?? summary.latestTurn,
      summary,
    });
    updateSettings({
      dismissedTaskAtriumErrors: mergeTaskAtriumErrorDismissals(dismissedTaskAtriumErrors, [
        dismissal,
      ]),
    });
  }, [dismissedTaskAtriumErrors, environmentId, error, scopeKey, threadId, updateSettings]);

  // Session snapshots are authoritative and may repeat unchanged lastError
  // values. Dismissal is presentation state: retain the exact dismissed error
  // per thread instead of mutating the projected snapshot and having the next
  // poll immediately restore it. A different error for the same thread still
  // appears, and no error strings are written to browser persistence.
  if (!error || dismissedErrorsByScope[scopeKey] === error) return null;
  return (
    <div className="pt-3 mx-auto max-w-3xl">
      <Alert variant="error">
        <CircleAlertIcon />
        <AlertDescription className="line-clamp-3" title={error}>
          {error}
        </AlertDescription>
        <AlertAction>
          <button
            type="button"
            aria-label="Dismiss error"
            className="inline-flex size-6 items-center justify-center rounded-md text-destructive/60 transition-colors hover:text-destructive"
            onClick={dismiss}
          >
            <XIcon className="size-3.5" />
          </button>
        </AlertAction>
      </Alert>
    </div>
  );
});
