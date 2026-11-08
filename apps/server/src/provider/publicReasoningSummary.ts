/**
 * Provider-neutral bounds for the version-1 public reasoning summary contract.
 *
 * Adapters publish disclosed reasoning text as `item.updated` /
 * `item.completed` reasoning items whose `data` carries the exact markers
 * below. Ingestion promotes only those markers, from an admitted provider,
 * into replace-in-place `reasoning.summary` activities. The renderer and the
 * historical work-log SQL predicate apply the same bounds and provider list.
 *
 * These are presentation/resource bounds, never provider token/effort
 * settings, and they do not request reasoning a provider would not send.
 */
export const PUBLIC_REASONING_SUMMARY_VERSION = 1;
export const PUBLIC_REASONING_SUMMARY_STREAM_KIND = "reasoning_summary_text";
export const PUBLIC_REASONING_SUMMARY_CHARS = 4_096;
/** Per canonical turn: retained identities, and identities still receiving text. */
export const PUBLIC_REASONING_SUMMARY_BLOCKS = 64;
export const PUBLIC_REASONING_SUMMARY_ACTIVE_BLOCKS = 16;
/** Live updates coalesce rather than appending a durable row per token. */
export const PUBLIC_REASONING_SUMMARY_INTERVAL_MS = 1_000;

/**
 * Keep the latest received text visible after a long block fills its preview.
 * A fixed prefix or lifetime publication count makes healthy streaming look
 * stuck. Bound retained text and refresh frequency instead; each block still
 * updates the same activity. Sanitize only this bounded window at display.
 */
export function publicReasoningSummaryTail(text: string): string {
  return text.slice(-PUBLIC_REASONING_SUMMARY_CHARS);
}

// The admitted provider list is shared with the renderer and SQL history.
export {
  isPublicReasoningSummaryProvider,
  PUBLIC_REASONING_SUMMARY_PROVIDERS,
  type PublicReasoningSummaryProvider,
} from "@cafecode/shared/providerWorkLog";

/** Display only received printable text, never terminal or bidi controls. */
export function publicReasoningSummaryDisplayText(text: string): string {
  return text
    .replace(/\p{Cc}/gu, (char) => (char === "\n" || char === "\r" || char === "\t" ? char : ""))
    .replace(/\p{Bidi_Control}/gu, "");
}
