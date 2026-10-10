import type { OrchestrationThreadActivity } from "@cafecode/contracts";
import type { WorkLogEntry } from "./session-logic";
import type { Thread } from "./types";

/** Received operational metadata, never provider-enforcement or retry authority. */
export interface CodexRecoveryPresentation {
  readonly activeAgentCount: number;
  readonly stage: "reconnecting" | "backoff" | "reconciling" | "uncertain" | null;
  readonly retryAtMs: number | null;
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
  // Activities are the canonical chronological thread stream. Reverse scanning
  // chooses one latest exact-owner marker without copying history or displaying
  // raw provider errors, native identities, or ambiguous acknowledgement data.
  for (let index = input.activities.length - 1; index >= 0; index -= 1) {
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
    if (payload.recovery !== "codex-transient-recovery-waiting") continue;
    if (
      (payload.stage !== "backoff" && payload.stage !== "reconciling") ||
      !Number.isSafeInteger(payload.retryAttempt) ||
      (payload.retryAttempt as number) < 0 ||
      (payload.retryAttempt as number) > 30 ||
      typeof payload.retryAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(payload.retryAt)
    )
      continue;
    const retryAt = Date.parse(payload.retryAt);
    const observedAt = Date.parse(activity.createdAt);
    // Reject impossible/unbounded public countdowns rather than manufacturing a
    // provider state from arbitrary payload text. The server's maximum wait is 60s.
    if (
      !Number.isFinite(retryAt) ||
      !Number.isFinite(observedAt) ||
      retryAt < observedAt ||
      retryAt - observedAt > 60_000
    )
      continue;
    stage = payload.stage;
    retryAtMs = retryAt;
    break;
  }
  return activeAgentCount > 0 || stage !== null ? { activeAgentCount, stage, retryAtMs } : null;
}

/** Deadline expiry is only a presentation boundary, never proof of dispatch. */
export function codexRecoveryLabel(presentation: CodexRecoveryPresentation, nowMs: number): string {
  if (presentation.stage === "uncertain") return "Needs reconciliation";
  if (presentation.stage === "reconciling") return "Checking recovery";
  if (presentation.retryAtMs !== null && presentation.retryAtMs > nowMs) {
    return `Retry in ${Math.ceil((presentation.retryAtMs - nowMs) / 1_000)}s`;
  }
  return presentation.stage === null ? "" : "Reconnecting";
}
