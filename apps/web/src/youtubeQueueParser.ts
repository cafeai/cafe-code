// Pure, dependency-free parser for session-only YouTube URL queue text (for
// example, a pasted or bundled list of one canonical watch URL per line). It
// performs no network calls, logging, persistence, or browser/DOM access,
// and it never retains raw URL text or other input fragments in its result
// -- only normalized video IDs and coarse, bounded diagnostics survive
// parsing. Callers own reading files/text into memory; this module
// only ever sees the decoded `string` they hand it.
//
// Security note: lines are matched with fully anchored regular expressions
// against literal host/path text instead of being routed through a
// general-purpose URL parser (e.g. the WHATWG `URL` class). A general
// parser normalizes its input as a side effect of parsing it -- case
// folding the host, decoding percent escapes, rewriting backslashes to
// slashes for "special" schemes, IDNA/punycode conversion, trimming
// control characters -- and each of those steps has historically been a
// source of host-confusion parser-differential bugs (the parser accepts a
// string that *looks* wrong but normalizes to something that *is* trusted,
// or vice versa). An anchored literal-string match has no normalization
// step for an attacker to exploit: the trimmed line must already look
// exactly like one of the two canonical shapes below, byte for byte.

/**
 * Bounds applied while parsing queue text. All limits are inclusive: a
 * value exactly at the limit is accepted, one past it is not. Exposed as a
 * policy object (rather than module-level constants) so tests can exercise
 * every bound with small fixtures instead of megabyte-scale input.
 */
export interface YouTubeQueueParsePolicy {
  /** Maximum UTF-8 encoded size of the whole input text, in bytes. */
  readonly maxInputBytes: number;
  /** Maximum number of logical lines (see `parseYouTubeUrlQueue` for how a "line" is defined for CRLF/LF/terminal-newline purposes). */
  readonly maxInputLines: number;
  /** Maximum length of a single line, in UTF-16 code units, before it is rejected without being matched against the URL grammar. */
  readonly maxLineLength: number;
  /** Maximum number of normalized video IDs the result may contain. */
  readonly maxAcceptedItems: number;
  /** Maximum number of per-line issue entries kept in the bounded `issues` list; `counts.malformed` itself is never capped. */
  readonly maxIssueDetails: number;
}

// These limits preserve the 4c9907c5 queue contract while bounding all
// attacker-controlled work and retained state.
export const YOUTUBE_QUEUE_PARSE_POLICY: YouTubeQueueParsePolicy = Object.freeze({
  maxInputBytes: 256 * 1_024,
  maxInputLines: 1_000,
  maxLineLength: 2_048,
  maxAcceptedItems: 200,
  maxIssueDetails: 50,
});

export type YouTubeQueueParseErrorReason = "input-too-many-bytes" | "input-too-many-lines";

/** Atomic, safe-to-display rejection of the whole input. Never carries any input text. */
export interface YouTubeQueueParseError {
  readonly reason: YouTubeQueueParseErrorReason;
}

// Fixed, closed set of malformed-line reasons. Every value here must stay
// safe to surface verbatim to a user or diagnostic log: no URL, ID,
// filename, or other input-derived text may ever be added alongside these.
export type YouTubeQueueLineIssueReason =
  | "line-too-long" // line exceeded `maxLineLength` before grammar matching was attempted
  | "invalid-url"; // line did not match the exact canonical single-video watch URL grammar

export interface YouTubeQueueLineIssue {
  /** One-based source line number. */
  readonly line: number;
  readonly reason: YouTubeQueueLineIssueReason;
}

export interface YouTubeQueueParseCounts {
  readonly totalLines: number;
  readonly blank: number;
  readonly comment: number;
  /** Equal to `videoIds.length`; included so callers can log/display one summary object. */
  readonly accepted: number;
  readonly duplicate: number;
  readonly malformed: number;
  readonly overflow: number;
}

export interface ParsedYouTubeUrlQueue {
  /** Normalized video IDs in first-seen order, capped at `maxAcceptedItems`. Never the original URL text. */
  readonly videoIds: readonly string[];
  readonly counts: YouTubeQueueParseCounts;
  /**
   * Bounded detail for malformed lines only (never duplicate/overflow/blank/
   * comment lines, which are fully described by `counts`). Capped at
   * `maxIssueDetails` entries regardless of how many malformed lines exist;
   * `counts.malformed` remains the exact total.
   */
  readonly issues: readonly YouTubeQueueLineIssue[];
  /** True when `issues` omits entries because `maxIssueDetails` was reached. */
  readonly issuesTruncated: boolean;
}

export type YouTubeQueueParseResult =
  | { readonly ok: true; readonly queue: ParsedYouTubeUrlQueue }
  | { readonly ok: false; readonly error: YouTubeQueueParseError };

// YouTube video IDs are exactly 11 characters from a base64url-like
// alphabet. Both accepted URL shapes require the ID to consume the rest of
// the line (anchored `$`), so appending extra characters or query
// parameters after a valid ID -- including `&list=...`, which would make a
// /watch URL ambiguous with a playlist -- fails to match rather than
// silently truncating to the first 11 characters.
const CANONICAL_WATCH_URL_PATTERN =
  /^https:\/\/(?:www\.)?youtube\.com\/watch\?v=([A-Za-z0-9_-]{11})$/;
const CANONICAL_SHORT_URL_PATTERN = /^https:\/\/youtu\.be\/([A-Za-z0-9_-]{11})$/;

// Deliberately excluded by the patterns above (none of these are
// special-cased -- they simply fail to match): bare video IDs; `/playlist`
// and `/embed/` paths; embedded userinfo (`user:pass@host`); explicit
// ports; extra path segments or trailing slashes; and any host besides the
// exact three above, including look-alike suffixes such as
// `www.youtube.com.evil.example`. Matching is case-sensitive by design: a
// technically-equivalent mixed-case spelling (`HTTPS://WWW.YOUTUBE.COM/...`)
// is treated as non-canonical rather than case-folded, which keeps the
// matcher a plain literal comparison instead of locale-aware text
// processing.

const QUEUE_COMMENT_PREFIXES = ["#", "//", ";"] as const;

// Written via `fromCharCode` rather than a literal/escaped character so the
// BOM is not an invisible byte sequence sitting in the middle of this file.
const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);

function stripLeadingByteOrderMark(text: string): string {
  // A leading UTF-8 BOM is a common artifact of Windows text editors and is
  // not semantic content. Left in place, it would silently attach itself to
  // line 1 and make an otherwise-canonical first URL fail to match.
  return text.startsWith(BYTE_ORDER_MARK) ? text.slice(BYTE_ORDER_MARK.length) : text;
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function assertValidPolicy(policy: YouTubeQueueParsePolicy): void {
  const limits = [
    policy.maxInputBytes,
    policy.maxInputLines,
    policy.maxLineLength,
    policy.maxAcceptedItems,
    policy.maxIssueDetails,
  ];
  if (!limits.every((limit) => Number.isSafeInteger(limit) && limit >= 0)) {
    throw new RangeError("YouTube queue parser limits must be non-negative safe integers.");
  }
}

function extractCanonicalVideoId(trimmedLine: string): string | null {
  return (
    CANONICAL_WATCH_URL_PATTERN.exec(trimmedLine)?.[1] ??
    CANONICAL_SHORT_URL_PATTERN.exec(trimmedLine)?.[1] ??
    null
  );
}

interface BoundedLineSplit {
  readonly lines: readonly string[];
  readonly overflowed: boolean;
}

/**
 * Splits queue text into logical lines, treating `\r\n` and `\n` as
 * equivalent terminators (a lone `\r` is not treated as a terminator and
 * simply remains embedded in whatever line contains it, which will then
 * fail the URL grammar rather than being silently misread).
 *
 * Two properties are deliberately different from `String.prototype.split`:
 *  - empty input yields zero lines, not one, since there is no content to
 *    report;
 *  - a single terminal newline does not create a phantom trailing blank
 *    line, so a well-formed file (ending in `\n`, as most editors write)
 *    reports the same line count as its visible content.
 *
 * Stops the moment more than `maxLines` lines have been found so a
 * pathological input cannot force scanning/allocating arbitrarily far past
 * the bound.
 */
function splitBoundedLines(text: string, maxLines: number): BoundedLineSplit {
  if (text.length === 0) {
    return { lines: [], overflowed: false };
  }

  const lines: string[] = [];
  let start = 0;
  for (;;) {
    const lineFeedIndex = text.indexOf("\n", start);
    const hasMoreLines = lineFeedIndex !== -1;
    const lineEndExclusive = hasMoreLines
      ? lineFeedIndex > start && text[lineFeedIndex - 1] === "\r"
        ? lineFeedIndex - 1
        : lineFeedIndex
      : text.length;
    lines.push(text.slice(start, lineEndExclusive));

    if (lines.length > maxLines) {
      return { lines, overflowed: true };
    }
    if (!hasMoreLines) {
      return { lines, overflowed: false };
    }
    start = lineFeedIndex + 1;
    if (start === text.length) {
      // Text ended exactly on a newline: do not emit a phantom empty line.
      return { lines, overflowed: false };
    }
  }
}

/**
 * Parses session-only YouTube URL queue text into normalized video IDs plus
 * bounded, safe-to-display diagnostics. See the module-level comment for
 * why matching is regex-based rather than routed through a URL parser, and
 * the field comments on `YouTubeQueueParsePolicy` for what each bound
 * covers. An input that exceeds the byte or line bound is rejected
 * atomically: no lines are parsed and no partial result is returned.
 */
export function parseYouTubeUrlQueue(
  text: string,
  policy: YouTubeQueueParsePolicy = YOUTUBE_QUEUE_PARSE_POLICY,
): YouTubeQueueParseResult {
  assertValidPolicy(policy);

  // UTF-8 encodes every UTF-16 code unit as at least one byte (a surrogate
  // pair -- two code units -- becomes four bytes), so the encoded byte
  // length is always >= `.length`. Checking `.length` first lets grossly
  // oversized input get rejected without ever handing it to `TextEncoder`.
  if (text.length > policy.maxInputBytes) {
    return { ok: false, error: { reason: "input-too-many-bytes" } };
  }
  if (utf8ByteLength(text) > policy.maxInputBytes) {
    return { ok: false, error: { reason: "input-too-many-bytes" } };
  }

  const normalizedText = stripLeadingByteOrderMark(text);
  const { lines, overflowed } = splitBoundedLines(normalizedText, policy.maxInputLines);
  if (overflowed) {
    return { ok: false, error: { reason: "input-too-many-lines" } };
  }

  const videoIds: string[] = [];
  // Only ever contains IDs that made it into `videoIds`, so it is bounded
  // by `maxAcceptedItems` for the lifetime of the call. A newly-seen ID
  // encountered after the cap is reached is counted as overflow and is
  // intentionally never inserted here -- otherwise a huge run of distinct
  // post-cap IDs would grow this set without bound even though none of
  // them are accepted.
  const seenVideoIds = new Set<string>();
  const issues: YouTubeQueueLineIssue[] = [];
  let blankCount = 0;
  let commentCount = 0;
  let duplicateCount = 0;
  let malformedCount = 0;
  let overflowCount = 0;

  const recordMalformedLine = (lineNumber: number, reason: YouTubeQueueLineIssueReason): void => {
    malformedCount += 1;
    if (issues.length < policy.maxIssueDetails) {
      issues.push({ line: lineNumber, reason });
    }
  };

  let lineNumber = 0;
  for (const rawLine of lines) {
    lineNumber += 1;

    if (rawLine.length > policy.maxLineLength) {
      recordMalformedLine(lineNumber, "line-too-long");
      continue;
    }

    const trimmedLine = rawLine.trim();
    if (trimmedLine.length === 0) {
      blankCount += 1;
      continue;
    }
    // Checked unconditionally, before grammar matching: a line starting
    // with "//" is always a comment, even though it also happens to be the
    // shape of a protocol-relative URL. That is harmless here because the
    // accepted grammar always requires an explicit "https://" scheme, so
    // such a line could never have been accepted anyway.
    if (QUEUE_COMMENT_PREFIXES.some((prefix) => trimmedLine.startsWith(prefix))) {
      commentCount += 1;
      continue;
    }

    const videoId = extractCanonicalVideoId(trimmedLine);
    if (videoId === null) {
      recordMalformedLine(lineNumber, "invalid-url");
      continue;
    }

    if (seenVideoIds.has(videoId)) {
      duplicateCount += 1;
      continue;
    }
    if (videoIds.length >= policy.maxAcceptedItems) {
      overflowCount += 1;
      continue;
    }
    videoIds.push(videoId);
    seenVideoIds.add(videoId);
  }

  return {
    ok: true,
    queue: {
      videoIds,
      counts: {
        totalLines: lines.length,
        blank: blankCount,
        comment: commentCount,
        accepted: videoIds.length,
        duplicate: duplicateCount,
        malformed: malformedCount,
        overflow: overflowCount,
      },
      issues,
      issuesTruncated: malformedCount > issues.length,
    },
  };
}
