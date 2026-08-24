import type { OrchestrationSessionStatus } from "@cafecode/contracts";

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
