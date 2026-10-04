import type { EnvironmentId, ThreadId } from "@cafecode/contracts";
import { useCallback, useSyncExternalStore } from "react";

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
  return { ...snapshot, refresh };
}
