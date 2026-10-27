import type { EnvironmentId, ScheduledFollowupRecord, ThreadId } from "@cafecode/contracts";
import { useEffect } from "react";
import { create } from "zustand";

import {
  readEnvironmentConnection,
  subscribeEnvironmentConnections,
} from "../../environments/runtime";
import { ensureEnvironmentApi } from "../../environmentApi";

/**
 * Navigation-only presence of enabled schedules: which chats have an upcoming
 * scheduled follow-up, and when. Sidebar rows, Desk tabs and project rollups
 * show a clock instead of an idle/completed dot for these chats.
 *
 * Schedule mutations are not orchestration events, so the shell stream cannot
 * carry this. One ref-counted read per environment polls the server's bounded,
 * instruction-free summary while the document is visible, and every successful
 * per-chat schedule read (including after an owner's own edit) updates that
 * chat immediately. Presence is display data only: it grants no review,
 * approval or execution authority, and an unsuccessful read keeps the last
 * known state rather than guessing.
 */
const REFRESH_INTERVAL_MS = 30_000;
const EMPTY_PRESENCE: Readonly<Record<ThreadId, string>> = Object.freeze({});

interface PresenceState {
  readonly byEnvironment: Readonly<Record<EnvironmentId, Readonly<Record<ThreadId, string>>>>;
}

const usePresenceStore = create<PresenceState>(() => ({ byEnvironment: {} }));

function publishEnvironment(
  environmentId: EnvironmentId,
  next: Readonly<Record<ThreadId, string>> | null,
): void {
  usePresenceStore.setState((state) => {
    const byEnvironment = { ...state.byEnvironment };
    if (next === null) delete byEnvironment[environmentId];
    else byEnvironment[environmentId] = next;
    return { byEnvironment };
  });
}

/** Earliest upcoming occurrence among a chat's enabled schedules, if any. */
export function earliestScheduledFollowupAt(
  schedules: readonly Pick<ScheduledFollowupRecord, "state" | "nextRunAt">[],
): string | null {
  let earliest: string | null = null;
  for (const record of schedules) {
    if (record.state !== "active" || record.nextRunAt === null) continue;
    // Canonical ISO-8601 UTC timestamps order lexically.
    if (earliest === null || record.nextRunAt < earliest) earliest = record.nextRunAt;
  }
  return earliest;
}

/**
 * Applies one exact chat's authoritative schedule list. Called by the per-chat
 * schedule resource so an owner's create/pause/delete is reflected at once,
 * without waiting for the next environment-wide summary poll.
 */
export function noteScheduledFollowupsForThread(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  schedules: readonly Pick<ScheduledFollowupRecord, "state" | "nextRunAt">[],
): void {
  const current = usePresenceStore.getState().byEnvironment[environmentId];
  // Without an active environment read there is nothing to keep consistent;
  // creating an entry here would outlive its owners and go stale.
  if (current === undefined) return;
  const nextAt = earliestScheduledFollowupAt(schedules);
  if ((current[threadId] ?? null) === nextAt) return;
  const next = { ...current };
  if (nextAt === null) delete next[threadId];
  else next[threadId] = nextAt;
  publishEnvironment(environmentId, next);
}

interface PresenceResource {
  owners: number;
  readonly stop: () => void;
}

const resources = new Map<EnvironmentId, PresenceResource>();

function startResource(environmentId: EnvironmentId): () => void {
  let disposed = false;
  let generation = 0;
  let inFlight = false;
  let trailing = false;
  let interval: number | null = null;
  let boundConnection = readEnvironmentConnection(environmentId);
  let unsubscribeOpened: (() => void) | undefined;

  const read = async () => {
    if (disposed || document.visibilityState === "hidden") return;
    if (inFlight) {
      trailing = true;
      return;
    }
    const summary = (() => {
      try {
        return ensureEnvironmentApi(environmentId).scheduledFollowups?.summary;
      } catch {
        return undefined;
      }
    })();
    // Older backends have no summary; show no clocks rather than emulating one.
    if (!summary) return;
    inFlight = true;
    const requestGeneration = generation;
    try {
      const response = await summary({});
      if (disposed || generation !== requestGeneration) return;
      const next: Record<ThreadId, string> = {};
      for (const entry of response.threads) next[entry.threadId] = entry.nextRunAt;
      publishEnvironment(environmentId, next);
    } catch {
      // Inconclusive: retain the last known presence.
    } finally {
      inFlight = false;
      if (!disposed && trailing) {
        trailing = false;
        void read();
      }
    }
  };

  const refresh = () => {
    if (disposed) return;
    // A new transport generation must not publish an older in-flight answer.
    generation += 1;
    void read();
  };

  const syncVisibility = () => {
    if (disposed || document.visibilityState === "hidden") {
      if (interval !== null) window.clearInterval(interval);
      interval = null;
      return;
    }
    if (interval !== null) return;
    void read();
    interval = window.setInterval(() => void read(), REFRESH_INTERVAL_MS);
  };

  const bindConnection = () => {
    if (disposed) return;
    const nextConnection = readEnvironmentConnection(environmentId);
    if (nextConnection === boundConnection && unsubscribeOpened) return;
    unsubscribeOpened?.();
    boundConnection = nextConnection;
    unsubscribeOpened = nextConnection?.client.subscribeConnectionOpened(refresh);
    refresh();
  };

  // Seed an empty map so per-chat reads can apply updates before the first
  // summary response arrives.
  if (usePresenceStore.getState().byEnvironment[environmentId] === undefined) {
    publishEnvironment(environmentId, EMPTY_PRESENCE);
  }
  const unsubscribeConnections = subscribeEnvironmentConnections(bindConnection);
  unsubscribeOpened = boundConnection?.client.subscribeConnectionOpened(refresh);
  document.addEventListener("visibilitychange", syncVisibility);
  syncVisibility();

  return () => {
    disposed = true;
    generation += 1;
    if (interval !== null) window.clearInterval(interval);
    unsubscribeOpened?.();
    unsubscribeConnections();
    document.removeEventListener("visibilitychange", syncVisibility);
    publishEnvironment(environmentId, null);
  };
}

function retainPresence(environmentId: EnvironmentId): () => void {
  let resource = resources.get(environmentId);
  if (!resource) {
    resource = { owners: 0, stop: startResource(environmentId) };
    resources.set(environmentId, resource);
  }
  resource.owners += 1;
  const owned = resource;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    owned.owners -= 1;
    if (owned.owners > 0 || resources.get(environmentId) !== owned) return;
    resources.delete(environmentId);
    owned.stop();
  };
}

/**
 * Environment-wide presence map (thread id to earliest upcoming run). Every
 * mounted consumer shares one read; the last unmount stops polling.
 */
export function useScheduledFollowupPresence(
  environmentId: EnvironmentId | null | undefined,
): Readonly<Record<ThreadId, string>> {
  useEffect(() => (environmentId ? retainPresence(environmentId) : undefined), [environmentId]);
  return usePresenceStore((state) =>
    environmentId ? (state.byEnvironment[environmentId] ?? EMPTY_PRESENCE) : EMPTY_PRESENCE,
  );
}

/**
 * Presence for several environments (for example a project whose members live
 * on different servers). Pass a stable, deduplicated id list; read entries
 * with `readScheduledFollowUpAtFrom`.
 */
export function useScheduledFollowupPresenceByEnvironment(
  environmentIds: readonly EnvironmentId[],
): ScheduledFollowupPresenceByEnvironment {
  const key = [...new Set(environmentIds)].toSorted().join("\u0000");
  useEffect(() => {
    if (key === "") return undefined;
    const releases = key.split("\u0000").map((id) => retainPresence(id as EnvironmentId));
    return () => {
      for (const release of releases) release();
    };
  }, [key]);
  return usePresenceStore((state) => state.byEnvironment);
}

export type ScheduledFollowupPresenceByEnvironment = PresenceState["byEnvironment"];

export function readScheduledFollowUpAtFrom(
  presence: ScheduledFollowupPresenceByEnvironment,
  environmentId: EnvironmentId,
  threadId: ThreadId,
): string | undefined {
  return presence[environmentId]?.[threadId];
}

/** One chat's earliest upcoming scheduled run, or undefined when none. */
export function useScheduledFollowUpAt(
  environmentId: EnvironmentId | null | undefined,
  threadId: ThreadId | null | undefined,
): string | undefined {
  useEffect(() => (environmentId ? retainPresence(environmentId) : undefined), [environmentId]);
  return usePresenceStore((state) =>
    environmentId && threadId ? state.byEnvironment[environmentId]?.[threadId] : undefined,
  );
}

/** Snapshot read for event handlers; creates no subscription or request. */
export function readScheduledFollowUpAt(
  environmentId: EnvironmentId | null | undefined,
  threadId: ThreadId | null | undefined,
): string | undefined {
  if (!environmentId || !threadId) return undefined;
  return usePresenceStore.getState().byEnvironment[environmentId]?.[threadId];
}
