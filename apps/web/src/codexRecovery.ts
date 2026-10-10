import type { OrchestrationThreadActivity } from "@cafecode/contracts";
import type { WorkLogEntry } from "./session-logic";
import type { Thread } from "./types";

/** Received operational metadata, never provider-enforcement or retry authority. */
export interface CodexRecoveryPresentation {
  readonly activeAgentCount: number;
  readonly stage: "reconnecting" | "backoff" | "reconciling" | "uncertain" | null;
  readonly retryAtMs: number | null;
  /** Cafe continuation number, distinct from the native provider's retry cycle. */
  readonly continuationOrdinal?: number;
  /** Older durable chains can establish only a lower bound; never invent an exact total. */
  readonly continuationOrdinalLowerBound?: true;
}

/** Copy only own data properties: presentation must not execute payload getters. */
function ownRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.values(descriptors).some((descriptor) => !("value" in descriptor))) return null;
    return Object.defineProperties(Object.create(null), descriptors) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function continuationCount(payload: Record<string, unknown>): {
  readonly continuationOrdinal?: number;
  readonly continuationOrdinalLowerBound?: true;
} {
  const ordinal = payload.continuationOrdinal;
  return Number.isSafeInteger(ordinal) &&
    (ordinal as number) > 0 &&
    (!Object.hasOwn(payload, "continuationOrdinalLowerBound") ||
      payload.continuationOrdinalLowerBound === true)
    ? {
        continuationOrdinal: ordinal as number,
        ...(payload.continuationOrdinalLowerBound === true
          ? { continuationOrdinalLowerBound: true as const }
          : {}),
      }
    : {};
}

/** A received wait is operational display data, not proof of provider dispatch. */
export function readCodexRecoveryWait(activity: OrchestrationThreadActivity): {
  readonly stage: "backoff" | "reconciling";
  readonly retryAtMs: number;
  readonly backoffSeconds: number;
  readonly continuationOrdinal?: number;
  readonly continuationOrdinalLowerBound?: true;
} | null {
  if (activity.kind !== "runtime.warning") return null;
  const payload = ownRecord(activity.payload);
  if (
    payload?.recovery !== "codex-transient-recovery-waiting" ||
    (payload.stage !== "backoff" && payload.stage !== "reconciling") ||
    !Number.isSafeInteger(payload.retryAttempt) ||
    (payload.retryAttempt as number) < 0 ||
    (payload.retryAttempt as number) > 30 ||
    typeof payload.retryAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(payload.retryAt)
  )
    return null;
  const retryAtMs = Date.parse(payload.retryAt);
  const observedAtMs = Date.parse(activity.createdAt);
  if (
    !Number.isFinite(retryAtMs) ||
    !Number.isFinite(observedAtMs) ||
    retryAtMs < observedAtMs ||
    retryAtMs - observedAtMs > 60_000
  )
    return null;
  return {
    stage: payload.stage,
    retryAtMs,
    backoffSeconds: Math.ceil((retryAtMs - observedAtMs) / 1_000),
    ...continuationCount(payload),
  };
}

/**
 * Shared owner match for the notice and the bounded activity-retention exception.
 * A foreign/newer-looking marker cannot evict current operational metadata.
 * This admits no provider action and deliberately preserves the strict native
 * account/generation/session-time tuple used by the existing notice.
 */
export function isCurrentCodexRecoveryMarker(
  activity: OrchestrationThreadActivity,
  turnId: OrchestrationThreadActivity["turnId"],
  session: Thread["session"],
): boolean {
  if (
    !turnId ||
    activity.turnId !== turnId ||
    activity.kind !== "runtime.warning" ||
    session?.provider !== "codex" ||
    !session.providerInstanceId ||
    !session.subagentRuntimeId
  )
    return false;
  const payload = ownRecord(activity.payload);
  return (
    payload !== null &&
    payload.providerInstanceId === session.providerInstanceId &&
    payload.subagentRuntimeId === session.subagentRuntimeId &&
    payload.sessionUpdatedAt === session.updatedAt &&
    (payload.recovery === "codex-transient-root-failed" ||
      payload.recovery === "codex-transient-continuation-attempted" ||
      payload.recovery === "codex-transient-recovery-cancelled" ||
      payload.recovery === "codex-transient-recovery-uncertain" ||
      readCodexRecoveryWait(activity) !== null)
  );
}

/** Finite native observations have no received backoff timing or total ceiling. */
export function nativeRetryWorkLogLabel(payloadValue: unknown): string | null {
  const payload = ownRecord(payloadValue);
  if (payload?.retrying !== true) return null;
  const retry = ownRecord(payload.nativeRetry);
  if (
    retry?.timing !== "unknown" ||
    !Number.isSafeInteger(retry.observedCount) ||
    (retry.observedCount as number) < 1 ||
    (retry.observedCount as number) > 1_024 ||
    (Object.hasOwn(retry, "countLimited") && retry.countLimited !== true)
  )
    return "Provider retry";
  return `Provider retry · ${retry.observedCount}${retry.countLimited === true ? "+" : ""}`;
}

/** Saved rows stay static; historical waits must not acquire live countdown timers. */
export function codexRecoveryWorkLogLabel(activity: OrchestrationThreadActivity): string | null {
  const payload = activity.kind === "runtime.warning" ? ownRecord(activity.payload) : null;
  if (payload?.recovery === "codex-transient-continuation-attempted") {
    const count = continuationCount(payload);
    return `Cafe recovery${count.continuationOrdinal === undefined ? "" : ` · Retry #${count.continuationOrdinal}${count.continuationOrdinalLowerBound ? "+" : ""}`}`;
  }
  const wait = readCodexRecoveryWait(activity);
  if (!wait) return null;
  const count = wait.continuationOrdinal;
  return `Cafe recovery${count === undefined ? "" : ` · Retry #${count}${wait.continuationOrdinalLowerBound ? "+" : ""}`} · ${wait.stage === "reconciling" ? "check in" : "backoff"} ${wait.backoffSeconds}s`;
}

/**
 * A failed root is not a dead native context. The ready session and exact native
 * generation below are independently verified by ingestion; the failed turn is
 * never rewritten as Working. A replacement/error/stopped/unknown session must
 * not inherit old children or an old recovery timer.
 */
export function deriveCodexRecoveryPresentation(input: {
  readonly thread: Pick<Thread, "session" | "latestTurn" | "archivedAt"> | undefined;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly activeSubagents: ReadonlyArray<WorkLogEntry>;
}): CodexRecoveryPresentation | null {
  const thread = input.thread;
  const session = thread?.session;
  const failedTurn = thread?.latestTurn;
  if (
    !thread ||
    thread.archivedAt !== null ||
    failedTurn?.state !== "error" ||
    session?.provider !== "codex" ||
    session.status !== "ready" ||
    session.orchestrationStatus !== "ready" ||
    session.activeTurnId !== undefined ||
    !session.providerInstanceId ||
    !session.subagentRuntimeId
  )
    return null;

  const activeAgentCount = input.activeSubagents.reduce((count, entry) => {
    const child = entry.subagent;
    return (
      count +
      (child !== undefined &&
      child.runtimeId === session.subagentRuntimeId &&
      (child.status === "active" || child.status === "waiting")
        ? 1
        : 0)
    );
  }, 0);
  let stage: CodexRecoveryPresentation["stage"] = null;
  let retryAtMs: number | null = null;
  let ordinal: ReturnType<typeof continuationCount> = {};
  // Activities are the canonical chronological thread stream. Reverse scanning
  // chooses one latest exact-owner marker without copying history or displaying
  // raw provider errors, native identities, or ambiguous acknowledgement data.
  for (let index = input.activities.length - 1; index >= 0; index -= 1) {
    const activity = input.activities[index]!;
    if (!isCurrentCodexRecoveryMarker(activity, failedTurn.turnId, session)) continue;
    const payload = ownRecord(activity.payload);
    if (
      !payload ||
      payload.providerInstanceId !== session.providerInstanceId ||
      payload.subagentRuntimeId !== session.subagentRuntimeId ||
      payload.sessionUpdatedAt !== session.updatedAt
    )
      continue;
    if (payload.recovery === "codex-transient-recovery-cancelled") break;
    if (payload.recovery === "codex-transient-recovery-uncertain") {
      // A missing ACK is not permission to retry, nor evidence that no native
      // request exists. Keep explicit context Stop available without claiming
      // that the failed root or an automatic retry is running.
      stage = "uncertain";
      break;
    }
    if (payload.recovery === "codex-transient-root-failed") {
      stage = "reconnecting";
      break;
    }
    if (payload.recovery === "codex-transient-continuation-attempted") {
      // The pre-I/O ledger ends an older countdown, but is not a native ACK.
      // Keep an honest connecting label until definite accepted/terminal state
      // arrives; no display observation may manufacture a running root.
      stage = "reconnecting";
      ordinal = continuationCount(payload);
      break;
    }
    const wait = readCodexRecoveryWait(activity);
    if (!wait) continue;
    stage = wait.stage;
    retryAtMs = wait.retryAtMs;
    ordinal = continuationCount(payload);
    break;
  }
  return activeAgentCount > 0 || stage !== null
    ? { activeAgentCount, stage, retryAtMs, ...ordinal }
    : null;
}

/**
 * Hide only the current provider-error banner while Cafe has received exact
 * owned automatic-recovery bookkeeping for that same failed root. This is a
 * reversible presentation decision, not dismissal, successful recovery, or
 * permission to resend. Unknown ACKs, cancellation, an unprepared root marker,
 * another account/generation, and local command errors remain actionable.
 */
export function shouldSuppressCodexRecoveryErrorNotification(input: {
  readonly thread:
    | Pick<Thread, "session" | "latestTurn" | "archivedAt" | "error" | "modelSelection">
    | undefined;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
}): boolean {
  const thread = input.thread;
  const session = thread?.session;
  const failedTurn = thread?.latestTurn;
  if (
    !thread?.error ||
    !session ||
    thread.error !== session?.lastError ||
    failedTurn?.completedAt == null ||
    failedTurn.completedAt !== session.updatedAt ||
    thread.modelSelection.instanceId !== session.providerInstanceId ||
    deriveCodexRecoveryPresentation({ ...input, activeSubagents: [] }) === null
  )
    return false;

  // A newer exact-owner cancellation/uncertain/malformed row must never borrow
  // an earlier wait. Foreign rows cannot retire this owner's pending display.
  for (let index = input.activities.length - 1; index >= 0; index--) {
    const activity = input.activities[index]!;
    if (activity.kind !== "runtime.warning" || activity.turnId !== failedTurn.turnId) continue;
    const payload = ownRecord(activity.payload);
    if (
      !payload ||
      payload.providerInstanceId !== session.providerInstanceId ||
      payload.subagentRuntimeId !== session.subagentRuntimeId ||
      payload.sessionUpdatedAt !== session.updatedAt
    )
      continue;
    if (payload.recovery === "codex-transient-recovery-waiting")
      return readCodexRecoveryWait(activity) !== null;
    if (payload.recovery === "codex-transient-continuation-attempted") {
      // The pre-I/O intent records its exact source and server-minted owner.
      // It remains pending, not acknowledged. Only a later explicit uncertain
      // record can communicate that the automatic decision needs user action.
      return (
        Number.isSafeInteger(payload.sourceEventSequence) &&
        (payload.sourceEventSequence as number) > 0 &&
        typeof payload.attemptOwnerId === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
          payload.attemptOwnerId,
        )
      );
    }
    if (
      payload.recovery === "codex-transient-root-failed" ||
      payload.recovery === "codex-transient-recovery-cancelled" ||
      payload.recovery === "codex-transient-recovery-uncertain" ||
      payload.recovery === "codex-transient-continuation-accepted"
    )
      return false;
  }
  return false;
}

/** Deadline expiry is only a presentation boundary, never proof of dispatch. */
export function codexRecoveryLabel(presentation: CodexRecoveryPresentation, nowMs: number): string {
  if (presentation.stage === "uncertain") return "Needs reconciliation";
  if (presentation.stage === "reconciling") return "Checking recovery";
  const count = presentation.continuationOrdinal;
  const retry =
    count === undefined
      ? "Retry"
      : `Retry #${count}${presentation.continuationOrdinalLowerBound ? "+" : ""}`;
  if (presentation.retryAtMs !== null && presentation.retryAtMs > nowMs) {
    return `${retry} in ${Math.ceil((presentation.retryAtMs - nowMs) / 1_000)}s`;
  }
  if (count !== undefined) return retry;
  return presentation.stage === null ? "" : "Reconnecting";
}
