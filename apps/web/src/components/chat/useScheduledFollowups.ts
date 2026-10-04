import type { EnvironmentId, ScheduledFollowupRecord, ThreadId } from "@cafecode/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { ensureScheduledFollowupsApi } from "../../lib/scheduledFollowupsApi";
import {
  readEnvironmentConnection,
  subscribeEnvironmentConnections,
} from "../../environments/runtime";

const REFRESH_INTERVAL_MS = 15_000;

/**
 * This is an on-demand read projection, never the scheduler itself. It exists
 * only while the Tasks surface is visible. Token events do not invalidate it,
 * hidden documents stop polling, and each exact-thread owner admits at most one
 * read with one trailing refresh after a concurrent user mutation/reconnect.
 */
export function useScheduledFollowups(environmentId: EnvironmentId, threadId: ThreadId) {
  const [schedules, setSchedules] = useState<readonly ScheduledFollowupRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refreshRef = useRef<() => void>(() => undefined);
  const refresh = useCallback(() => refreshRef.current(), []);

  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    let trailing = false;
    let unsubscribeOpened: (() => void) | undefined;
    let boundConnection = readEnvironmentConnection(environmentId);

    const read = async () => {
      if (disposed || document.visibilityState === "hidden") return;
      if (inFlight) {
        trailing = true;
        return;
      }
      inFlight = true;
      try {
        const response = await ensureScheduledFollowupsApi(environmentId).list({
          threadId,
        });
        if (!disposed) {
          // A response belongs to this exact selection only. The server also
          // scopes the read, but a malformed/stale row must not appear beneath
          // another chat's controls even if an upstream regression emits it.
          setSchedules(response.schedules.filter((record) => record.threadId === threadId));
          setError(null);
        }
      } catch {
        if (!disposed) setError("Schedules could not be refreshed. Reconnect or try again.");
      } finally {
        inFlight = false;
        if (!disposed) {
          setLoading(false);
          if (trailing) {
            trailing = false;
            void read();
          }
        }
      }
    };

    const requestRead = () => {
      void read();
    };
    refreshRef.current = requestRead;
    const bindConnection = () => {
      const nextConnection = readEnvironmentConnection(environmentId);
      if (nextConnection === boundConnection && unsubscribeOpened) return;
      unsubscribeOpened?.();
      boundConnection = nextConnection;
      unsubscribeOpened = nextConnection?.client.subscribeConnectionOpened(requestRead);
      requestRead();
    };
    bindConnection();
    const unsubscribeConnections = subscribeEnvironmentConnections(bindConnection);
    const interval = window.setInterval(requestRead, REFRESH_INTERVAL_MS);
    document.addEventListener("visibilitychange", requestRead);
    return () => {
      disposed = true;
      refreshRef.current = () => undefined;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", requestRead);
      unsubscribeOpened?.();
      unsubscribeConnections();
    };
  }, [environmentId, threadId]);

  return { schedules, loading, error, refresh };
}
