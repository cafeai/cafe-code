import type { ProviderSession, ProviderSubagentPolicySession } from "@cafecode/contracts";

/**
 * Numeric configuration alone is not evidence that an unknown CLI supports a
 * new limit. This predicate only recognizes the exact still-open Codex process
 * in which the identical policy is already materialized. Callers additionally
 * require the Cafe owner's continuation-fence guarantee and prohibit recovery;
 * native send/steer admission repeats this comparison under its lifecycle lock.
 */
export function matchesSubagentPolicySession(
  session: ProviderSession | undefined,
  expected: ProviderSubagentPolicySession,
): boolean {
  return (
    session?.provider === "codex" &&
    (session.status === "ready" || session.status === "running") &&
    session.threadId === expected.threadId &&
    session.providerInstanceId === expected.providerInstanceId &&
    session.subagentRuntimeId === expected.subagentRuntimeId &&
    session.maxConcurrentSubagents === expected.maxConcurrentSubagents
  );
}
