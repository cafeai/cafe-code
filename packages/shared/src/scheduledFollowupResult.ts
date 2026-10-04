import * as Schema from "effect/Schema";

/**
 * A result is read only from the canonical completed assistant message already
 * bound to the scheduled run's exact thread, native turn and pending message.
 * This parser is NOT an authorization check; arbitrary MCP callers or renderer
 * text must never be allowed to invoke settlement with its return value.
 */
const ScheduledFollowupResult = Schema.Struct({
  runId: Schema.String.check(Schema.isUUID()),
  result: Schema.Literals(["no-change", "changed"]),
  summary: Schema.String.check(
    Schema.isMaxLength(1_000),
    Schema.isPattern(/\S/),
    // Keep notification summaries ordinary printable text. Newlines and tabs
    // are harmless presentation; control and bidi formatting bytes are not.
    Schema.isPattern(/^[^\p{Bidi_Control}\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]*$/u),
  ),
  finish: Schema.Boolean,
}).annotate({ parseOptions: { onExcessProperty: "error" } });

export type ScheduledFollowupResult = typeof ScheduledFollowupResult.Type;
const decode = Schema.decodeUnknownSync(ScheduledFollowupResult);
const MAX_RESULT_TAIL_CHARS = 8_192;
const PREFIX = "<!-- cafe-scheduled-followup: ";

/**
 * Recognize one final, standalone, exact marker. Inspect at most a bounded tail
 * even if the assistant wrote a large answer; never parse arbitrary embedded
 * JSON or infer "no change" from natural language. Ambiguous/malformed results
 * are unavailable and must leave notification behavior conservative.
 */
function resultFooter(
  text: string,
): { readonly result: ScheduledFollowupResult; readonly start: number } | null {
  const offset = Math.max(0, text.length - MAX_RESULT_TAIL_CHARS);
  const tail = text.slice(offset);
  const start = tail.lastIndexOf(PREFIX);
  if (start < 0 || (start === 0 && offset > 0) || (start > 0 && tail[start - 1] !== "\n")) {
    return null;
  }
  const footer = tail.slice(start);
  const match = /^<!-- cafe-scheduled-followup: (\{[^\r\n]*\}) -->[\t \r\n]*$/.exec(footer);
  if (!match?.[1]) return null;
  try {
    const parsed = decode(JSON.parse(match[1]));
    return { result: parsed, start: offset + start };
  } catch {
    return null;
  }
}

/** Only the backend's exact occurrence binding supplies expectedRunId. */
export function parseScheduledFollowupResult(
  text: string,
  expectedRunId: string,
): ScheduledFollowupResult | null {
  const parsed = resultFooter(text);
  return parsed?.result.runId === expectedRunId ? parsed.result : null;
}

/**
 * Presentation only: omit a valid final metadata footer from rendered Markdown
 * without modifying, trimming or reserializing the stored assistant message.
 * This function never grants authority to settle a schedule.
 */
export function stripScheduledFollowupResultForDisplay(text: string): string {
  const parsed = resultFooter(text);
  return parsed === null ? text : text.slice(0, parsed.start);
}
