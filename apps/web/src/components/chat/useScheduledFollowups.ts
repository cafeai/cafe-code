import type { EnvironmentId, ThreadId } from "@cafecode/contracts";
import { uiText } from "@cafecode/shared/i18n";
import { useCallback, useSyncExternalStore } from "react";
import { useUiLocale } from "~/i18n";

import {
  EMPTY_SCHEDULED_FOLLOWUPS,
  readScheduledFollowupsSnapshot,
  refreshScheduledFollowups,
  subscribeScheduledFollowups,
} from "./scheduledFollowupsResource";

const NOOP = () => undefined;

/**
 * Tasks and inline cards read one backend-owned schedule projection per exact
 * environment/chat, with one single-flight poller while any view is subscribed.
 * External-store snapshots change synchronously with the selected scope; React
 * can never render the previous chat's instructions while an effect catches up.
 * Disabled/unsupported views subscribe to nothing and retain no cached rows.
 */
export function useScheduledFollowups(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  enabled = true,
) {
  const uiLocale = useUiLocale();
  const subscribe = useCallback(
    (listener: () => void) =>
      enabled ? subscribeScheduledFollowups(environmentId, threadId, listener) : NOOP,
    [enabled, environmentId, threadId],
  );
  const getSnapshot = useCallback(
    () =>
      enabled ? readScheduledFollowupsSnapshot(environmentId, threadId) : EMPTY_SCHEDULED_FOLLOWUPS,
    [enabled, environmentId, threadId],
  );
  const refresh = useCallback(() => {
    if (enabled) refreshScheduledFollowups(environmentId, threadId);
  }, [enabled, environmentId, threadId]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return {
    ...snapshot,
    // Locale is presentation only: it cannot enter any subscription, refresh,
    // generation or request dependency above. Received failures remain opaque.
    error:
      snapshot.error === "refresh-unconfirmed"
        ? uiText(
            "Schedules could not be refreshed. Reconnect or try again.",
            undefined,
            undefined,
            uiLocale,
          )
        : null,
    refresh,
  };
}

// Finite source-owned labels/helpers only; no received or user data.
