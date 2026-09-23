import type { ProviderSession } from "@cafecode/contracts";

/**
 * Consume only proof supplied by a freshly queried Codex runtime. Persisted
 * snapshots and renderer state are not inputs: native start/compact admission
 * revokes this proof immediately, even before a new native turn id exists.
 * The aggregate activeTurnId remains intact while routed children work.
 *
 * Match the native thread as well as the turn so a stale proof copied across
 * resume/provider routing can never authorize input to another conversation.
 */
export function getCodexRootTurnCompletion(
  session: ProviderSession | undefined,
): NonNullable<ProviderSession["codexRootTurnCompletion"]> | undefined {
  const proof = session?.codexRootTurnCompletion;
  if (
    session?.provider !== "codex" ||
    session.status !== "running" ||
    proof === undefined ||
    session.activeTurnId !== proof.turnId
  ) {
    return undefined;
  }
  const cursor = session.resumeCursor;
  return cursor !== null &&
    typeof cursor === "object" &&
    "threadId" in cursor &&
    cursor.threadId === proof.providerThreadId
    ? proof
    : undefined;
}
