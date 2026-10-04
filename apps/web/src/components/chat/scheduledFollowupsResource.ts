import type { EnvironmentId, ScheduledFollowupRecord, ThreadId } from "@cafecode/contracts";

import {
  readEnvironmentConnection,
  subscribeEnvironmentConnections,
} from "../../environments/runtime";
import { ensureScheduledFollowupsApi } from "../../lib/scheduledFollowupsApi";

const REFRESH_INTERVAL_MS = 15_000;
const REFRESH_ERROR = "Schedules could not be refreshed. Reconnect or try again.";
const EMPTY_SCHEDULES: readonly ScheduledFollowupRecord[] = Object.freeze([]);

export interface ScheduledFollowupsSnapshot {
  readonly schedules: readonly ScheduledFollowupRecord[];
  readonly loading: boolean;
  readonly error: string | null;
}

/** Stable empty snapshots also cover renders before React commits a subscriber.
 * Reading a snapshot must not create a cached owner or start network activity. */
export const EMPTY_SCHEDULED_FOLLOWUPS: ScheduledFollowupsSnapshot = Object.freeze({
  schedules: EMPTY_SCHEDULES,
  loading: false,
  error: null,
});
const LOADING_SNAPSHOT: ScheduledFollowupsSnapshot = Object.freeze({
  ...EMPTY_SCHEDULED_FOLLOWUPS,
  loading: true,
});

interface ScheduledFollowupsResource {
  snapshot: ScheduledFollowupsSnapshot;
  readonly listeners: Set<() => void>;
  readonly start: () => void;
  readonly stop: () => void;
  readonly refresh: () => void;
}

/** Exact tuple keys avoid delimiter collisions between independently minted
 * environment and chat identifiers. Only committed, subscribed views own an
 * entry; the last unsubscribe removes all cached instructions immediately. */
const resources = new Map<EnvironmentId, Map<ThreadId, ScheduledFollowupsResource>>();

function createResource(environmentId: EnvironmentId, threadId: ThreadId) {
  let disposed = false;
  let generation = 0;
  let inFlight = false;
  let trailing = false;
  let interval: number | null = null;
  let unsubscribeOpened: (() => void) | undefined;
  let unsubscribeConnections: (() => void) | undefined;
  let boundConnection = readEnvironmentConnection(environmentId);

  const publish = (snapshot: ScheduledFollowupsSnapshot) => {
    resource.snapshot = snapshot;
    for (const listener of resource.listeners) listener();
  };

  const read = async () => {
    if (disposed || document.visibilityState === "hidden") return;
    if (inFlight) {
      // A slow request, repeated refresh presses, and simultaneous consumers
      // share at most one trailing read instead of building an unbounded queue.
      trailing = true;
      return;
    }
    inFlight = true;
    const requestGeneration = generation;
    try {
      const response = await ensureScheduledFollowupsApi(environmentId).list({ threadId });
      if (!disposed && generation === requestGeneration) {
        publish({
          // The backend scopes this read too. Keep the client projection bound
          // to its exact chat if malformed or stale rows ever cross that layer.
          schedules: response.schedules.filter((record) => record.threadId === threadId),
          loading: false,
          error: null,
        });
      }
    } catch {
      if (!disposed && generation === requestGeneration) {
        // An unsuccessful refresh is inconclusive. Retain the last successful
        // rows and expose fixed copy, never server error bodies or credentials.
        publish({ ...resource.snapshot, loading: false, error: REFRESH_ERROR });
      }
    } finally {
      inFlight = false;
      if (!disposed && trailing) {
        trailing = false;
        void read();
      }
    }
  };

  const requestRead = () => {
    void read();
  };

  const refresh = () => {
    if (disposed) return;
    // Manual refresh follows a reviewed mutation; reconnect follows a new
    // transport generation. Neither may publish an older in-flight response.
    // The existing request must settle before the coalesced fresh read starts.
    generation += 1;
    if (!resource.snapshot.loading || resource.snapshot.error !== null) {
      // Review flows wait for this fresh authoritative read before resolving a
      // selected schedule ID. Keep cached rows available to other consumers,
      // but never present them as a completed refresh of the reviewed revision.
      publish({ ...resource.snapshot, loading: true, error: null });
    }
    requestRead();
  };

  const bindConnection = () => {
    if (disposed) return;
    const nextConnection = readEnvironmentConnection(environmentId);
    if (nextConnection === boundConnection && unsubscribeOpened) return;
    if (nextConnection === null && boundConnection === null) return;
    unsubscribeOpened?.();
    boundConnection = nextConnection;
    unsubscribeOpened = nextConnection?.client.subscribeConnectionOpened(refresh);
    refresh();
  };

  const stopInterval = () => {
    if (interval === null) return;
    window.clearInterval(interval);
    interval = null;
  };

  const syncVisibility = () => {
    if (disposed || document.visibilityState === "hidden") {
      stopInterval();
      return;
    }
    if (interval !== null) return;
    requestRead();
    interval = window.setInterval(requestRead, REFRESH_INTERVAL_MS);
  };

  const resource: ScheduledFollowupsResource = {
    snapshot: LOADING_SNAPSHOT,
    listeners: new Set(),
    refresh,
    start: () => {
      // Listen before the initial read so a replacement connection cannot land
      // between discovery and subscribing. Unrelated environment changes only
      // compare identity; they do not trigger another schedule request.
      unsubscribeConnections = subscribeEnvironmentConnections(bindConnection);
      unsubscribeOpened = boundConnection?.client.subscribeConnectionOpened(refresh);
      document.addEventListener("visibilitychange", syncVisibility);
      syncVisibility();
    },
    stop: () => {
      disposed = true;
      generation += 1;
      trailing = false;
      stopInterval();
      unsubscribeOpened?.();
      unsubscribeConnections?.();
      document.removeEventListener("visibilitychange", syncVisibility);
      resource.snapshot = LOADING_SNAPSHOT;
    },
  };
  return resource;
}

export function readScheduledFollowupsSnapshot(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): ScheduledFollowupsSnapshot {
  return resources.get(environmentId)?.get(threadId)?.snapshot ?? LOADING_SNAPSHOT;
}

export function subscribeScheduledFollowups(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  listener: () => void,
): () => void {
  let environmentResources = resources.get(environmentId);
  if (!environmentResources) {
    environmentResources = new Map();
    resources.set(environmentId, environmentResources);
  }
  let resource = environmentResources.get(threadId);
  if (!resource) {
    resource = createResource(environmentId, threadId);
    environmentResources.set(threadId, resource);
  }
  // A subscription owns a unique token even when two callers supply the same
  // function, so retiring one view cannot retire another view's read ownership.
  const subscription = () => listener();
  resource.listeners.add(subscription);
  if (resource.listeners.size === 1) resource.start();
  return () => {
    if (!resource.listeners.delete(subscription) || resource.listeners.size > 0) return;
    resource.stop();
    environmentResources.delete(threadId);
    if (environmentResources.size === 0) resources.delete(environmentId);
  };
}

export function refreshScheduledFollowups(environmentId: EnvironmentId, threadId: ThreadId): void {
  resources.get(environmentId)?.get(threadId)?.refresh();
}
