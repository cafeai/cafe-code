import { createHash } from "node:crypto";

import {
  PUBLIC_REASONING_SUMMARY_ACTIVE_BLOCKS,
  PUBLIC_REASONING_SUMMARY_BLOCKS,
  PUBLIC_REASONING_SUMMARY_CHARS,
  PUBLIC_REASONING_SUMMARY_INTERVAL_MS,
  publicReasoningSummaryDisplayText,
  publicReasoningSummaryTail,
} from "./publicReasoningSummary.ts";

// These are presentation/resource bounds, never provider token/effort settings.
// The shared contract bounds live in publicReasoningSummary.ts; Claude keeps
// its own names for the native-block bookkeeping below.
export const CLAUDE_PUBLIC_SUMMARY_CHARS = PUBLIC_REASONING_SUMMARY_CHARS;
export const CLAUDE_PUBLIC_SUMMARY_SNAPSHOT_CHARS = 65_536;
export const CLAUDE_PUBLIC_SUMMARY_BLOCKS = PUBLIC_REASONING_SUMMARY_BLOCKS;
export const CLAUDE_PUBLIC_SUMMARY_ACTIVE_BLOCKS = PUBLIC_REASONING_SUMMARY_ACTIVE_BLOCKS;
export const CLAUDE_PUBLIC_SUMMARY_INTERVAL_MS = PUBLIC_REASONING_SUMMARY_INTERVAL_MS;

/** Display only received printable public summary text, never hidden controls. */
export const claudePublicSummaryDisplayText = publicReasoningSummaryDisplayText;

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

/** Keep a rolling disclosed preview, but commit every received UTF-16 unit. */
export function appendClaudePublicSummary(state: ClaudePublicSummaryText, delta: string): void {
  state.receivedHash.update(delta, "utf16le");
  state.receivedLength += delta.length;
  // Avoid concatenating an oversized incoming delta merely to discard its head.
  // Hashing above still proves the complete original stream for snapshot repair.
  state.text = publicReasoningSummaryTail(
    delta.length >= CLAUDE_PUBLIC_SUMMARY_CHARS ? delta : state.text + delta,
  );
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
