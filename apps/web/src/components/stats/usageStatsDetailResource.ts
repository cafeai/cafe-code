import type { UsageStatsGetResult } from "@cafecode/contracts";
import { useSyncExternalStore } from "react";

import { isTransportConnectionErrorMessage } from "~/rpc/transportError";

const DETAIL_REFRESH_INTERVAL_MS = 5_000;
const NOOP = () => undefined;

export type UsageStatsDetailPhase = "error" | "idle" | "loading" | "ready" | "stale";
export type UsageStatsDetailErrorCategory = "disposed" | "timeout" | "transport" | "unknown";

export interface UsageStatsDetailSnapshot {
  readonly data: UsageStatsGetResult | null;
  readonly phase: UsageStatsDetailPhase;
  readonly lastErrorCategory: UsageStatsDetailErrorCategory | null;
  readonly lastSuccessAt: string | null;
}

export interface UsageStatsDetailDiagnostics {
  readonly active: boolean;
  readonly consumerCount: number;
  readonly cacheAvailable: boolean;
  readonly inFlight: boolean;
  readonly attemptCount: number;
  readonly successCount: number;
  readonly failureCount: number;
  readonly reconnectRefreshCount: number;
  readonly lastStartedAt: string | null;
  readonly lastFinishedAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly lastDurationMs: number | null;
  readonly lastOutcome: "error" | "success" | null;
  readonly lastErrorCategory: UsageStatsDetailErrorCategory | null;
  readonly lastDayCount: number | null;
  readonly lastTokenBreakdownCount: number | null;
}

const EMPTY_SNAPSHOT: UsageStatsDetailSnapshot = Object.freeze({
  data: null,
  phase: "idle",
  lastErrorCategory: null,
  lastSuccessAt: null,
});

let snapshot: UsageStatsDetailSnapshot = EMPTY_SNAPSHOT;
let active = false;
let intervalId: number | null = null;
let unsubscribeConnectionOpened: (() => void) | null = null;
let connectionPromise: Promise<
  ReturnType<(typeof import("~/environments/runtime"))["getPrimaryEnvironmentConnection"]>
> | null = null;
let inFlight: Promise<void> | null = null;
let refreshAfterFlight = false;
const listeners = new Set<() => void>();

let diagnostics: UsageStatsDetailDiagnostics = {
  active: false,
  consumerCount: 0,
  cacheAvailable: false,
  inFlight: false,
  attemptCount: 0,
  successCount: 0,
  failureCount: 0,
  reconnectRefreshCount: 0,
  lastStartedAt: null,
  lastFinishedAt: null,
  lastSuccessAt: null,
  lastDurationMs: null,
  lastOutcome: null,
  lastErrorCategory: null,
  lastDayCount: null,
  lastTokenBreakdownCount: null,
};

function visible(): boolean {
  return typeof document === "undefined" || document.visibilityState === "visible";
}

function emit(): void {
  for (const listener of listeners) listener();
}

function updateSnapshot(next: UsageStatsDetailSnapshot): void {
  snapshot = next;
  emit();
}

function classifyError(error: unknown): UsageStatsDetailErrorCategory {
  const name = error instanceof Error ? error.name.toLowerCase() : "";
  const message = error instanceof Error ? error.message : String(error);
  if (name.includes("abort") || name.includes("interrupt") || message === "Transport disposed") {
    return "disposed";
  }
  if (name.includes("timeout") || message.toLowerCase().includes("timed out")) {
    return "timeout";
  }
  return isTransportConnectionErrorMessage(message) ? "transport" : "unknown";
}

async function getConnection() {
  connectionPromise ??= import("~/environments/runtime").then((runtime) =>
    runtime.getPrimaryEnvironmentConnection(),
  );
  try {
    const connection = await connectionPromise;
    if (active && unsubscribeConnectionOpened === null) {
      // Observe the exact primary transport used by this resource. The global
      // connection atom also receives saved-environment events, so using it
      // here could make an unrelated remote reconnect refresh (or mask) local
      // usage data.
      unsubscribeConnectionOpened = connection.client.subscribeConnectionOpened((event) => {
        if (event.reconnected) requestRefresh("reconnect");
      });
    }
    return connection;
  } catch (error) {
    // A bootstrap failure must not poison every future refresh. The next
    // bounded attempt gets a fresh environment-runtime resolution.
    connectionPromise = null;
    throw error;
  }
}

function requestRefresh(reason: "interval" | "mount" | "reconnect" | "visible"): void {
  if (!active || !visible()) return;
  if (inFlight !== null) {
    // A timer tick does not add information while an equally fresh request is
    // already pending. A reconnect is different: the in-flight request may
    // belong to an obsolete transport session, so retain one (and only one)
    // follow-up refresh. Mount and visibility signals merely join the current
    // request and must not create a sequential duplicate.
    if (reason === "reconnect") refreshAfterFlight = true;
    return;
  }

  const startedAtMs = performance.now();
  const startedAt = new Date().toISOString();
  diagnostics = {
    ...diagnostics,
    inFlight: true,
    attemptCount: diagnostics.attemptCount + 1,
    reconnectRefreshCount: diagnostics.reconnectRefreshCount + (reason === "reconnect" ? 1 : 0),
    lastStartedAt: startedAt,
  };
  if (snapshot.data === null) {
    updateSnapshot({ ...snapshot, phase: "loading", lastErrorCategory: null });
  }

  let request!: Promise<void>;
  request = (async () => {
    try {
      const connection = await getConnection();
      const result = await connection.client.server.getUsageStats();
      const finishedAt = new Date().toISOString();
      diagnostics = {
        ...diagnostics,
        inFlight: false,
        cacheAvailable: true,
        successCount: diagnostics.successCount + 1,
        lastFinishedAt: finishedAt,
        lastSuccessAt: finishedAt,
        lastDurationMs: Math.max(0, Math.round(performance.now() - startedAtMs)),
        lastOutcome: "success",
        lastErrorCategory: null,
        lastDayCount: result.days.length,
        lastTokenBreakdownCount: result.tokenBreakdown.length,
      };
      updateSnapshot({
        data: result,
        phase: "ready",
        lastErrorCategory: null,
        lastSuccessAt: finishedAt,
      });
    } catch (error) {
      const category = classifyError(error);
      diagnostics = {
        ...diagnostics,
        inFlight: false,
        failureCount: diagnostics.failureCount + 1,
        lastFinishedAt: new Date().toISOString(),
        lastDurationMs: Math.max(0, Math.round(performance.now() - startedAtMs)),
        lastOutcome: "error",
        lastErrorCategory: category,
      };
      updateSnapshot({
        ...snapshot,
        phase: snapshot.data === null ? "error" : "stale",
        lastErrorCategory: category,
      });
    } finally {
      if (inFlight === request) inFlight = null;
      const shouldRefreshAgain = refreshAfterFlight;
      refreshAfterFlight = false;
      if (shouldRefreshAgain && active && visible()) {
        queueMicrotask(() => requestRefresh("reconnect"));
      }
    }
  })();
  inFlight = request;
}

function stopInterval(): void {
  if (intervalId === null) return;
  window.clearInterval(intervalId);
  intervalId = null;
}

function syncVisibility(): void {
  if (!active || !visible()) {
    stopInterval();
    return;
  }
  if (intervalId !== null) return;
  requestRefresh(snapshot.data === null ? "mount" : "visible");
  intervalId = window.setInterval(() => requestRefresh("interval"), DETAIL_REFRESH_INTERVAL_MS);
}

function start(): void {
  if (active || typeof window === "undefined") return;
  active = true;
  diagnostics = { ...diagnostics, active: true, consumerCount: listeners.size };
  document.addEventListener("visibilitychange", syncVisibility);
  syncVisibility();
}

function stop(): void {
  if (!active) return;
  active = false;
  refreshAfterFlight = false;
  stopInterval();
  unsubscribeConnectionOpened?.();
  unsubscribeConnectionOpened = null;
  document.removeEventListener("visibilitychange", syncVisibility);
  diagnostics = { ...diagnostics, active: false, consumerCount: listeners.size };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  diagnostics = { ...diagnostics, consumerCount: listeners.size };
  start();
  return () => {
    listeners.delete(listener);
    diagnostics = { ...diagnostics, consumerCount: listeners.size };
    if (listeners.size === 0) stop();
  };
}

export function useUsageStatsDetail(enabled: boolean): UsageStatsDetailSnapshot {
  const current = useSyncExternalStore(
    enabled ? subscribe : () => NOOP,
    () => snapshot,
    () => snapshot,
  );
  return enabled ? current : EMPTY_SNAPSHOT;
}

/**
 * Payload-free diagnostic for the local desktop debug endpoint. Counts and
 * timings are safe to retain; usage rows, provider/model names, URLs, and
 * transport error messages deliberately never enter this object.
 */
export function getUsageStatsDetailDiagnostics(): UsageStatsDetailDiagnostics {
  return { ...diagnostics };
}

/** Test-only reset. Production intentionally retains the last good detail across unmounts. */
export function resetUsageStatsDetailResourceForTests(): void {
  listeners.clear();
  stop();
  snapshot = EMPTY_SNAPSHOT;
  connectionPromise = null;
  unsubscribeConnectionOpened = null;
  inFlight = null;
  refreshAfterFlight = false;
  diagnostics = {
    active: false,
    consumerCount: 0,
    cacheAvailable: false,
    inFlight: false,
    attemptCount: 0,
    successCount: 0,
    failureCount: 0,
    reconnectRefreshCount: 0,
    lastStartedAt: null,
    lastFinishedAt: null,
    lastSuccessAt: null,
    lastDurationMs: null,
    lastOutcome: null,
    lastErrorCategory: null,
    lastDayCount: null,
    lastTokenBreakdownCount: null,
  };
}
