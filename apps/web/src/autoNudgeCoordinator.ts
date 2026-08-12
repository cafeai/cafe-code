import {
  DEFAULT_THREAD_AUTO_NUDGE_SUMMARY,
  type EnvironmentId,
  type MessageId,
  type ThreadAutoNudgeDispatchSource,
  type ThreadAutoNudgeSummary,
  type ThreadId,
  type TurnId,
} from "@cafecode/contracts";
import { useSyncExternalStore } from "react";

import type { EnvironmentState } from "./store";

const AUTO_NUDGE_LEDGER_STORAGE_KEY = "cafe-code.auto-nudge.completed-turns.v1";
const MAX_LEDGER_ENTRIES = 256;
const MAX_LEDGER_KEY_CHARS = 768;

export interface AutoNudgeThreadRef {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

export interface ProjectedAutoNudgeAuthority extends AutoNudgeThreadRef {
  readonly authorityRevision: ThreadAutoNudgeSummary["authorityRevision"];
  readonly completedTurnId: TurnId;
  readonly dispatchSource: ThreadAutoNudgeDispatchSource;
  readonly terminalKey: string;
}

export type AutoNudgeCoordinatorStatus = "waiting" | "dispatching" | "failed";

export function autoNudgeTerminalKey(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly completedTurnId: TurnId;
}): string {
  return JSON.stringify([input.environmentId, input.threadId, input.completedTurnId]);
}

export function autoNudgeRouteKey(input: AutoNudgeThreadRef): string {
  return JSON.stringify([input.environmentId, input.threadId]);
}

/** Tracks projection edges. The first value is hydration, not a completion event. */
export class AutoNudgeCompletionTracker {
  private readonly observedByRoute = new Map<string, string | null>();

  observe(routeKey: string, completionKey: string | null): string | null {
    if (!this.observedByRoute.has(routeKey)) {
      this.observedByRoute.set(routeKey, completionKey);
      return null;
    }
    if (this.observedByRoute.get(routeKey) === completionKey) return null;
    this.observedByRoute.set(routeKey, completionKey);
    return completionKey;
  }

  remove(routeKey: string): void {
    this.observedByRoute.delete(routeKey);
  }

  retain(routeKeys: ReadonlySet<string>): void {
    for (const routeKey of this.observedByRoute.keys()) {
      if (!routeKeys.has(routeKey)) this.observedByRoute.delete(routeKey);
    }
  }
}

export function projectedCompletedTurnKey(
  environment: EnvironmentState | undefined,
  threadId: ThreadId,
): string | null {
  if (!environment?.bootstrapComplete) return null;
  const shell = environment.threadShellById[threadId];
  const summary = environment.sidebarThreadSummaryById[threadId];
  const latestTurn =
    environment.threadTurnStateById[threadId]?.latestTurn ?? summary?.latestTurn ?? null;
  return shell && latestTurn?.state === "completed" && latestTurn.completedAt !== null
    ? autoNudgeTerminalKey({
        environmentId: shell.environmentId,
        threadId,
        completedTurnId: latestTurn.turnId,
      })
    : null;
}

/**
 * Read authority only from one exact thread projection. A clock is not an
 * input, so elapsed idle time cannot create a dispatch.
 */
export function projectedAutoNudgeAuthority(input: {
  readonly environment: EnvironmentState | undefined;
  readonly threadId: ThreadId;
  readonly foregroundThread: AutoNudgeThreadRef | null;
}): ProjectedAutoNudgeAuthority | null {
  const { environment, threadId, foregroundThread } = input;
  if (!environment?.bootstrapComplete) return null;
  const shell = environment.threadShellById[threadId];
  const summary = environment.sidebarThreadSummaryById[threadId];
  if (!shell || !summary) return null;
  const config = shell.autoNudge ?? summary.autoNudge ?? DEFAULT_THREAD_AUTO_NUDGE_SUMMARY;
  const session = environment.threadSessionById[threadId] ?? summary.session;
  const latestTurn = environment.threadTurnStateById[threadId]?.latestTurn ?? summary.latestTurn;
  const isForeground =
    foregroundThread?.environmentId === shell.environmentId &&
    foregroundThread.threadId === threadId;
  const dispatchSource = config.backgroundContinuation
    ? "background"
    : isForeground
      ? "foreground"
      : null;
  if (
    dispatchSource === null ||
    config.mode === "off" ||
    config.armedAt === null ||
    config.roundsDispatched >= config.maxRounds ||
    shell.archivedAt !== null ||
    shell.error !== null ||
    (summary.manualFollowUpCount ?? 0) !== 0 ||
    summary.hasPendingApprovals ||
    summary.hasPendingUserInput ||
    summary.hasActionableProposedPlan ||
    session?.status !== "ready" ||
    latestTurn?.state !== "completed" ||
    latestTurn.completedAt === null ||
    latestTurn.turnId === config.baselineSettledTurnId ||
    latestTurn.turnId === config.lastDispatchedSettledTurnId
  ) {
    return null;
  }
  return {
    environmentId: shell.environmentId,
    threadId,
    authorityRevision: config.authorityRevision,
    completedTurnId: latestTurn.turnId,
    dispatchSource,
    terminalKey: autoNudgeTerminalKey({
      environmentId: shell.environmentId,
      threadId,
      completedTurnId: latestTurn.turnId,
    }),
  };
}

export function autoNudgeForegroundThreadFromPathname(pathname: string): AutoNudgeThreadRef | null {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length !== 2 || segments[0] === "settings" || segments[0] === "draft") return null;
  try {
    return {
      environmentId: decodeURIComponent(segments[0] ?? "") as EnvironmentId,
      threadId: decodeURIComponent(segments[1] ?? "") as ThreadId,
    };
  } catch {
    return null;
  }
}

interface LedgerStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function safeLedgerKey(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_LEDGER_KEY_CHARS;
}

export class AutoNudgeCompletionLedger {
  private readonly keys: string[];
  private readonly keySet: Set<string>;

  constructor(private readonly storage: LedgerStorage | null) {
    let stored: unknown = [];
    try {
      stored = JSON.parse(storage?.getItem(AUTO_NUDGE_LEDGER_STORAGE_KEY) ?? "[]");
    } catch {
      stored = [];
    }
    this.keys = Array.isArray(stored)
      ? stored.filter(safeLedgerKey).slice(-MAX_LEDGER_ENTRIES)
      : [];
    this.keySet = new Set(this.keys);
  }

  has(key: string): boolean {
    return this.keySet.has(key);
  }

  mark(key: string): void {
    if (!safeLedgerKey(key) || this.keySet.has(key)) return;
    this.keys.push(key);
    this.keySet.add(key);
    while (this.keys.length > MAX_LEDGER_ENTRIES) {
      const removed = this.keys.shift();
      if (removed !== undefined) this.keySet.delete(removed);
    }
    try {
      this.storage?.setItem(AUTO_NUDGE_LEDGER_STORAGE_KEY, JSON.stringify(this.keys));
    } catch {
      // The in-memory fail-closed ledger remains valid for this renderer.
    }
  }
}

function resolveSessionStorage(): LedgerStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

let sharedLedger: AutoNudgeCompletionLedger | null = null;

export function getAutoNudgeCompletionLedger(): AutoNudgeCompletionLedger {
  sharedLedger ??= new AutoNudgeCompletionLedger(resolveSessionStorage());
  return sharedLedger;
}

const statusByRoute = new Map<string, AutoNudgeCoordinatorStatus>();
const statusListeners = new Set<() => void>();

export function setAutoNudgeCoordinatorStatus(
  thread: AutoNudgeThreadRef,
  status: AutoNudgeCoordinatorStatus,
): void {
  const key = autoNudgeRouteKey(thread);
  if (statusByRoute.get(key) === status) return;
  statusByRoute.set(key, status);
  for (const listener of statusListeners) listener();
}

export function useAutoNudgeCoordinatorStatus(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): AutoNudgeCoordinatorStatus {
  const key = autoNudgeRouteKey({ environmentId, threadId });
  return useSyncExternalStore(
    (listener) => {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
    () => statusByRoute.get(key) ?? "waiting",
    () => "waiting",
  );
}

export function autoNudgeMessageBelongsToTurn(input: {
  readonly environment: EnvironmentState;
  readonly threadId: ThreadId;
  readonly messageId: MessageId | null;
  readonly turnId: TurnId;
}): boolean {
  return input.messageId === null
    ? false
    : input.environment.messageByThreadId[input.threadId]?.[input.messageId]?.turnId ===
        input.turnId;
}

export function __resetAutoNudgeCoordinatorForTests(): void {
  sharedLedger = null;
  statusByRoute.clear();
}
