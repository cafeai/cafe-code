/** Private, bounded Cafe-message to native-wrapper-UUID correspondence.
 * Text and timestamps never grant native fork authority. Ambiguous or missing
 * mappings remain unavailable, including legacy conversations and split text
 * segments which have no exact provider message boundary.
 */
import type { SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_ENTRIES = 4096;
const MAX_CAFE_ID = 1024;
export type ClaudeForkMessageIds = Record<
  string,
  { nativeId: string; turnId: string; turnCount: number }
>;

export function readClaudeForkMessageIds(value: unknown): ClaudeForkMessageIds {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid Claude fork message correspondence.");
  const entries = Object.entries(value);
  if (entries.length > MAX_ENTRIES) throw new Error("Claude fork message bound exceeded.");
  const result: ClaudeForkMessageIds = Object.create(null);
  const nativeIds = new Set<string>();
  for (const [key, entry] of entries) {
    if (!key || key.length > MAX_CAFE_ID || !entry || typeof entry !== "object")
      throw new Error("Invalid Claude fork message identity.");
    const { nativeId, turnId, turnCount } = entry as {
      nativeId?: unknown;
      turnId?: unknown;
      turnCount?: unknown;
    };
    if (
      typeof nativeId !== "string" ||
      !UUID.test(nativeId) ||
      typeof turnId !== "string" ||
      !turnId ||
      turnId.length > MAX_CAFE_ID ||
      nativeIds.has(nativeId) ||
      typeof turnCount !== "number" ||
      !Number.isSafeInteger(turnCount) ||
      turnCount < 1
    )
      throw new Error("Invalid Claude fork native identity.");
    nativeIds.add(nativeId);
    result[key] = { nativeId, turnId, turnCount };
  }
  return result;
}

export function rememberClaudeForkMessage(input: {
  ids: ClaudeForkMessageIds;
  messageId: string | undefined;
  nativeId: string;
  turnId: string;
  turnCount: number;
}): void {
  const { ids, messageId, nativeId, turnId, turnCount } = input;
  if (!messageId || messageId.length > MAX_CAFE_ID || !UUID.test(nativeId)) return;
  const old = ids[messageId];
  // A remapped or reused display identity is not evidence for another native
  // message. Keep the old exact binding so subsequent validation fails closed.
  if (old) return;
  if (Object.values(ids).some((entry) => entry.nativeId === nativeId)) return;
  if (Object.keys(ids).length >= MAX_ENTRIES) delete ids[Object.keys(ids)[0]!];
  ids[messageId] = { nativeId, turnId, turnCount };
}

/** SDK remapping is the only authority for retaining identities in a branch. */
export function remapClaudeForkMessageIds(input: {
  ids: ClaudeForkMessageIds;
  entries: ReadonlyArray<SessionStoreEntry>;
  sourceSessionId: string;
  targetSessionId: string;
  targetThreadId?: string;
}): ClaudeForkMessageIds {
  const byNative = new Map<string, string>();
  const targetIds = new Set<string>();
  for (const entry of input.entries) {
    if (entry.isSidechain === true || (entry.type !== "user" && entry.type !== "assistant"))
      continue;
    const from = entry.forkedFrom as { sessionId?: unknown; messageUuid?: unknown } | undefined;
    if (
      entry.sessionId !== input.targetSessionId ||
      typeof entry.uuid !== "string" ||
      !UUID.test(entry.uuid) ||
      from?.sessionId !== input.sourceSessionId ||
      typeof from.messageUuid !== "string" ||
      !UUID.test(from.messageUuid) ||
      byNative.has(from.messageUuid) ||
      targetIds.has(entry.uuid)
    )
      throw new Error("Ambiguous Claude fork message lineage.");
    byNative.set(from.messageUuid, entry.uuid);
    targetIds.add(entry.uuid);
  }
  const prefix = input.targetThreadId ? `copy:${input.targetThreadId}:` : "";
  const result: ClaudeForkMessageIds = Object.create(null);
  for (const [messageId, entry] of Object.entries(input.ids)) {
    const nativeId = byNative.get(entry.nativeId);
    if (
      nativeId &&
      `${prefix}${messageId}`.length <= MAX_CAFE_ID &&
      `${prefix}${entry.turnId}`.length <= MAX_CAFE_ID
    ) {
      result[`${prefix}${messageId}`] = {
        nativeId,
        turnId: `${prefix}${entry.turnId}`,
        turnCount: entry.turnCount,
      };
    }
  }
  return result;
}
