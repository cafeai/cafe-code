/**
 * Fixed, content-free copy shared by the provider admission guard and its
 * explicit recovery action. Never recognize arbitrary provider prose as
 * authority to copy, reset, or mutate a conversation.
 */
export const CODEX_HISTORY_RECOVERY_REQUIRED_MESSAGE =
  "Codex rejected an oversized tool call in this conversation's saved context. Cafe has blocked further requests to this native conversation to avoid repeated failures. Continue in a new chat to preserve this chat and your workspace, or obtain a verified history repair. Restarting, compacting, or forking this native conversation does not repair it.";

export function isCodexHistoryRecoveryRequiredError(message: string): boolean {
  return message === CODEX_HISTORY_RECOVERY_REQUIRED_MESSAGE;
}
