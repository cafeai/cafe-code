import type { OrchestrationSession, OrchestrationSessionStatus } from "@cafecode/contracts";

export const SESSION_LIFECYCLE_SUPERSEDED =
  "Provider session lifecycle observation was superseded.";

/** Capture only the lifecycle tuple used by server-side compare-and-set. */
export function sessionLifecycleSnapshot(session: OrchestrationSession | null) {
  return session === null
    ? null
    : {
        status: session.status,
        activeTurnId: session.activeTurnId,
        providerName: session.providerName,
        providerInstanceId: session.providerInstanceId ?? null,
        ...(session.subagentRuntimeId !== undefined
          ? { subagentRuntimeId: session.subagentRuntimeId }
          : {}),
        updatedAt: session.updatedAt,
      };
}

/**
 * The rejected command receipt preserves the same fixed error across replay.
 * Only this exact lifecycle-CAS rejection is benign; unrelated persistence,
 * validation, and command failures must still fail ingestion normally.
 */
export function isSupersededSessionLifecycle(error: {
  readonly _tag: string;
  readonly detail?: string;
}): boolean {
  return (
    (error._tag === "OrchestrationCommandInvariantError" &&
      error.detail === SESSION_LIFECYCLE_SUPERSEDED) ||
    (error._tag === "OrchestrationCommandPreviouslyRejectedError" &&
      error.detail ===
        `Orchestration command invariant failed (thread.session.set): ${SESSION_LIFECYCLE_SUPERSEDED}`) ||
    (error._tag === "OrchestrationCommandPreviouslyRejectedError" &&
      error.detail ===
        `Orchestration command invariant failed (thread.activity.append): ${SESSION_LIFECYCLE_SUPERSEDED}`)
  );
}

interface ProjectedSessionLifecycle {
  readonly status: OrchestrationSessionStatus;
  readonly activeTurnId: string | null;
  readonly updatedAt: string;
}

/**
 * Detects the restart-replay shape that can resurrect a provider spinner
 * without any provider-owned turn behind it.
 *
 * Provider timestamps are not a universal ordering clock: a legitimate
 * terminal event can carry an older provider timestamp than Cafe's local turn
 * request. Consequently, this guard is deliberately limited to provisional
 * `starting` state. A start without an active turn is only local intent; once a
 * newer projection exists, replaying that intent cannot prove that provider
 * work is alive and must not replace the newer lifecycle state.
 */
export function isStaleProvisionalSessionReplay(input: {
  readonly current: ProjectedSessionLifecycle;
  readonly incoming: ProjectedSessionLifecycle;
}): boolean {
  return (
    input.incoming.status === "starting" &&
    input.incoming.activeTurnId === null &&
    input.incoming.updatedAt < input.current.updatedAt
  );
}
