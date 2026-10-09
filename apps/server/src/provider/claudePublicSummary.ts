import { createHash } from "node:crypto";

// These are presentation/resource bounds, never provider token/effort settings.
export const CLAUDE_PUBLIC_SUMMARY_CHARS = 4_096;
export const CLAUDE_PUBLIC_SUMMARY_SNAPSHOT_CHARS = 65_536;
export const CLAUDE_PUBLIC_SUMMARY_BLOCKS = 64;
export const CLAUDE_PUBLIC_SUMMARY_ACTIVE_BLOCKS = 16;
export const CLAUDE_PUBLIC_SUMMARY_INTERVAL_MS = 1_000;

/** Display only received printable public summary text, never hidden controls. */
export function claudePublicSummaryDisplayText(text: string): string {
  return text
    .replace(/\p{Cc}/gu, (char) => (char === "\n" || char === "\r" || char === "\t" ? char : ""))
    .replace(/\p{Bidi_Control}/gu, "");
}

/** Never evict an old identity into becoming a new snapshot-only block. */
export function retireClaudePublicSummaryKey(keys: Set<string>, key: string): boolean {
  if (keys.has(key)) return true;
  if (keys.size >= CLAUDE_PUBLIC_SUMMARY_BLOCKS) return false;
  keys.add(key);
  return true;
}

export interface ClaudePublicSummaryText {
  text: string;
  receivedLength: number;
  readonly receivedHash: ReturnType<typeof createHash>;
  truncated: boolean;
}

export function makeClaudePublicSummaryText(): ClaudePublicSummaryText {
  return { text: "", receivedLength: 0, receivedHash: createHash("sha256"), truncated: false };
}

/** Keep the disclosed prefix only, but commit every received UTF-16 unit. */
export function appendClaudePublicSummary(state: ClaudePublicSummaryText, delta: string): void {
  state.receivedHash.update(delta, "utf16le");
  state.receivedLength += delta.length;
  const room = Math.max(0, CLAUDE_PUBLIC_SUMMARY_CHARS - state.text.length);
  state.text += delta.slice(0, room);
  state.truncated ||= state.receivedLength > CLAUDE_PUBLIC_SUMMARY_CHARS;
}

/**
 * A final disclosed snapshot may repair a missing suffix only after proving
 * its entire streamed prefix. Divergence/oversize cannot replace source text.
 */
export function mergeClaudePublicSummarySnapshot(
  state: ClaudePublicSummaryText,
  snapshot: string,
): boolean {
  if (snapshot.length > CLAUDE_PUBLIC_SUMMARY_SNAPSHOT_CHARS) return false;
  if (snapshot.length < state.receivedLength) return false;
  const prefix = createHash("sha256")
    .update(snapshot.slice(0, state.receivedLength), "utf16le")
    .digest("hex");
  if (prefix !== state.receivedHash.copy().digest("hex")) return false;
  appendClaudePublicSummary(state, snapshot.slice(state.receivedLength));
  return true;
}

/**
 * Inspection text is not a general secret detector. Remove known credential
 * spellings and render control/bidi characters visibly; never execute it.
 * The native tool input/result itself is untouched for provider roundtrips.
 */
export function claudeCommandInspectionText(text: string, limit: number): string {
  return claudeCommandInspectionPreview(text, limit).text;
}

export function claudeCommandInspectionPreview(
  text: string,
  limit: number,
): {
  readonly text: string;
  readonly truncated: boolean;
} {
  const sanitized = text
    .slice(0, limit)
    .replace(
      /\b(?:sk-ant-[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]+)\b/g,
      "[redacted credential]",
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted credential]")
    .replace(/[\p{Cc}\p{Bidi_Control}]/gu, (char) =>
      char === "\n" || char === "\r" || char === "\t"
        ? char
        : `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
  return {
    text: sanitized.slice(0, limit),
    truncated: text.length > limit || sanitized.length > limit,
  };
}
