import { describe, expect, it } from "vitest";

import { parseYouTubeUrlQueue, YOUTUBE_QUEUE_PARSE_POLICY } from "./youtubeQueueParser";

function withPolicy(overrides: Partial<typeof YOUTUBE_QUEUE_PARSE_POLICY>) {
  return { ...YOUTUBE_QUEUE_PARSE_POLICY, ...overrides };
}

function acceptedIds(text: string) {
  const result = parseYouTubeUrlQueue(text);
  if (!result.ok) {
    throw new Error(`expected parse to succeed, got error: ${result.error.reason}`);
  }
  return result.queue.videoIds;
}

describe("parseYouTubeUrlQueue - canonical acceptance", () => {
  it("accepts the exact shipped watch URL form", () => {
    expect(acceptedIds("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toEqual(["dQw4w9WgXcQ"]);
  });

  it("accepts the bare youtube.com host without www", () => {
    expect(acceptedIds("https://youtube.com/watch?v=dQw4w9WgXcQ")).toEqual(["dQw4w9WgXcQ"]);
  });

  it("accepts the youtu.be short host form", () => {
    expect(acceptedIds("https://youtu.be/dQw4w9WgXcQ")).toEqual(["dQw4w9WgXcQ"]);
  });

  it("preserves first-seen order across all three accepted hosts", () => {
    const text = [
      "https://www.youtube.com/watch?v=AAAAAAAAAAA",
      "https://youtu.be/BBBBBBBBBBB",
      "https://youtube.com/watch?v=CCCCCCCCCCC",
    ].join("\n");
    expect(acceptedIds(text)).toEqual(["AAAAAAAAAAA", "BBBBBBBBBBB", "CCCCCCCCCCC"]);
  });
});

describe("parseYouTubeUrlQueue - rejected shapes", () => {
  it.each([
    ["bare video ID with no URL at all", "dQw4w9WgXcQ"],
    ["playlist URLs", "https://www.youtube.com/playlist?list=PLxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"],
    ["embedded credentials", "https://user:pass@www.youtube.com/watch?v=dQw4w9WgXcQ"],
    ["an explicit port", "https://www.youtube.com:443/watch?v=dQw4w9WgXcQ"],
    ["non-HTTPS scheme", "http://www.youtube.com/watch?v=dQw4w9WgXcQ"],
    ["a look-alike suffix host", "https://www.youtube.com.evil.example/watch?v=dQw4w9WgXcQ"],
    ["a look-alike unrelated host", "https://notyoutube.com/watch?v=dQw4w9WgXcQ"],
    ["a host missing the dot before youtube.com", "https://wwwyoutube.com/watch?v=dQw4w9WgXcQ"],
    ["embed URLs", "https://www.youtube.com/embed/dQw4w9WgXcQ"],
    [
      "ambiguous watch URLs carrying a list parameter",
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    ],
    ["extra path segments before the query", "https://www.youtube.com/watch/extra?v=dQw4w9WgXcQ"],
    ["extra path segments after a youtu.be ID", "https://youtu.be/dQw4w9WgXcQ/extra"],
    ["a trailing slash on a youtu.be URL", "https://youtu.be/dQw4w9WgXcQ/"],
    [
      "a real 10-character malformed ID observed in bundled queue data",
      "https://www.youtube.com/watch?v=2_qE6o2Dqm",
    ],
    ["a 12-character ID", "https://www.youtube.com/watch?v=dQw4w9WgXcQX"],
    ["a mixed-case scheme and host", "HTTPS://WWW.YOUTUBE.COM/watch?v=dQw4w9WgXcQ"],
    [
      "trailing text after an otherwise-valid watch URL",
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ some trailing text",
    ],
  ])("rejects %s", (_description, line) => {
    const result = parseYouTubeUrlQueue(line);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.queue.videoIds).toEqual([]);
    expect(result.queue.counts.malformed).toBe(1);
    expect(result.queue.issues).toEqual([{ line: 1, reason: "invalid-url" }]);
  });
});

describe("parseYouTubeUrlQueue - blank and comment lines", () => {
  it("counts empty and whitespace-only lines as blank, not malformed", () => {
    const result = parseYouTubeUrlQueue(["", "   ", "\t"].join("\n"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.queue.counts.blank).toBe(3);
    expect(result.queue.counts.malformed).toBe(0);
  });

  it.each([
    ["#", "# a hash comment"],
    ["//", "// a slash comment"],
    [";", "; a semicolon comment"],
  ])("treats lines starting with %s as comments", (_marker, line) => {
    const result = parseYouTubeUrlQueue(line);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.queue.counts.comment).toBe(1);
    expect(result.queue.counts.malformed).toBe(0);
  });

  it("treats a leading-whitespace comment marker as a comment after trimming", () => {
    const result = parseYouTubeUrlQueue("   # indented comment");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.queue.counts.comment).toBe(1);
  });

  it("supports non-ASCII comment text", () => {
    const result = parseYouTubeUrlQueue("# 日本語コメント");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.queue.counts.comment).toBe(1);
  });

  it("treats a protocol-relative URL as a comment, since // is a supported comment marker", () => {
    // This is a deliberate interaction, not a bug: the comment check runs
    // before URL matching and applies unconditionally to any line starting
    // with "//". A protocol-relative URL would be rejected by the URL
    // grammar anyway (it requires an explicit https:// scheme), so this
    // only changes which counter it lands in, not whether it is accepted.
    const result = parseYouTubeUrlQueue("//www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.queue.videoIds).toEqual([]);
    expect(result.queue.counts.comment).toBe(1);
    expect(result.queue.counts.malformed).toBe(0);
  });
});

describe("parseYouTubeUrlQueue - duplicates", () => {
  it("accepts the first occurrence and counts later occurrences as duplicates", () => {
    const text = [
      "https://www.youtube.com/watch?v=AAAAAAAAAAA",
      "https://www.youtube.com/watch?v=AAAAAAAAAAA",
      "https://youtu.be/AAAAAAAAAAA",
    ].join("\n");
    const result = parseYouTubeUrlQueue(text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.queue.videoIds).toEqual(["AAAAAAAAAAA"]);
    expect(result.queue.counts.duplicate).toBe(2);
  });
});

describe("parseYouTubeUrlQueue - accepted-item cap and overflow", () => {
  it("stops accepting new IDs once the cap is reached and counts the rest as overflow", () => {
    const policy = withPolicy({ maxAcceptedItems: 2 });
    const text = [
      "https://www.youtube.com/watch?v=AAAAAAAAAAA",
      "https://www.youtube.com/watch?v=BBBBBBBBBBB",
      "https://www.youtube.com/watch?v=CCCCCCCCCCC",
    ].join("\n");
    const result = parseYouTubeUrlQueue(text, policy);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.queue.videoIds).toEqual(["AAAAAAAAAAA", "BBBBBBBBBBB"]);
    expect(result.queue.counts.overflow).toBe(1);
    expect(result.queue.counts.duplicate).toBe(0);
    expect(result.queue.counts.malformed).toBe(0);
  });

  it("still recognizes a repeat of an already-accepted ID as a duplicate after the cap is full", () => {
    // This is the subtle bound: once `maxAcceptedItems` is reached, newly
    // seen IDs must not be added to the dedupe set (or it could grow
    // without bound across a huge run of distinct post-cap lines), but a
    // repeat of an ID accepted *before* the cap must still resolve as a
    // duplicate rather than overflow or a second acceptance.
    const policy = withPolicy({ maxAcceptedItems: 2 });
    const text = [
      "https://www.youtube.com/watch?v=AAAAAAAAAAA",
      "https://www.youtube.com/watch?v=BBBBBBBBBBB",
      "https://www.youtube.com/watch?v=CCCCCCCCCCC", // new after cap -> overflow
      "https://www.youtube.com/watch?v=DDDDDDDDDDD", // new after cap -> overflow
      "https://www.youtube.com/watch?v=AAAAAAAAAAA", // repeat of an accepted ID -> duplicate
    ].join("\n");
    const result = parseYouTubeUrlQueue(text, policy);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.queue.videoIds).toEqual(["AAAAAAAAAAA", "BBBBBBBBBBB"]);
    expect(result.queue.counts.overflow).toBe(2);
    expect(result.queue.counts.duplicate).toBe(1);
  });
});

describe("parseYouTubeUrlQueue - malformed line reporting", () => {
  it("reports one-based line numbers and a fixed reason, never the offending text", () => {
    const marker = "TOTALLY-NOT-A-CANONICAL-URL-MARKER";
    const text = ["https://www.youtube.com/watch?v=AAAAAAAAAAA", marker, "not a url either"].join(
      "\n",
    );
    const result = parseYouTubeUrlQueue(text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.queue.issues).toEqual([
      { line: 2, reason: "invalid-url" },
      { line: 3, reason: "invalid-url" },
    ]);
    expect(JSON.stringify(result)).not.toContain(marker);
  });

  it("bounds the issue detail list independently of the exact malformed count", () => {
    const policy = withPolicy({ maxIssueDetails: 2 });
    const text = ["bad one", "bad two", "bad three", "bad four"].join("\n");
    const result = parseYouTubeUrlQueue(text, policy);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.queue.counts.malformed).toBe(4);
    expect(result.queue.issues).toEqual([
      { line: 1, reason: "invalid-url" },
      { line: 2, reason: "invalid-url" },
    ]);
    expect(result.queue.issuesTruncated).toBe(true);
  });

  it("does not report truncation when malformed count exactly matches the detail cap", () => {
    const policy = withPolicy({ maxIssueDetails: 2 });
    const result = parseYouTubeUrlQueue(["bad one", "bad two"].join("\n"), policy);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.queue.issuesTruncated).toBe(false);
  });

  it("classifies an over-length line as malformed without matching it against the URL grammar", () => {
    const policy = withPolicy({ maxLineLength: 20 });
    const longLine = "https://www.youtube.com/watch?v=AAAAAAAAAAA"; // 44 chars, over the 20-char cap
    const result = parseYouTubeUrlQueue(longLine, policy);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.queue.videoIds).toEqual([]);
    expect(result.queue.issues).toEqual([{ line: 1, reason: "line-too-long" }]);
  });
});

describe("parseYouTubeUrlQueue - per-line length boundary", () => {
  const canonicalUrl = "https://www.youtube.com/watch?v=AAAAAAAAAAA";

  it("accepts a line exactly at maxLineLength", () => {
    const policy = withPolicy({ maxLineLength: canonicalUrl.length });
    const result = parseYouTubeUrlQueue(canonicalUrl, policy);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.queue.videoIds).toEqual(["AAAAAAAAAAA"]);
    expect(result.queue.counts.malformed).toBe(0);
  });

  it("rejects a line one code unit past maxLineLength", () => {
    const policy = withPolicy({ maxLineLength: canonicalUrl.length - 1 });
    const result = parseYouTubeUrlQueue(canonicalUrl, policy);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.queue.videoIds).toEqual([]);
    expect(result.queue.issues).toEqual([{ line: 1, reason: "line-too-long" }]);
  });

  it("measures the raw line before trimming, so surrounding whitespace counts toward the cap", () => {
    // The cap is a bound on work and retained state, so it applies to the
    // line as it appeared in the input; an over-length line is rejected even
    // when its trimmed form would have matched the URL grammar.
    const policy = withPolicy({ maxLineLength: canonicalUrl.length });
    const result = parseYouTubeUrlQueue(`${canonicalUrl} `, policy);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.queue.videoIds).toEqual([]);
    expect(result.queue.issues).toEqual([{ line: 1, reason: "line-too-long" }]);
  });

  it("never echoes an over-length line's text into the result", () => {
    const marker = "LINE-TOO-LONG-LEAK-MARKER";
    const result = parseYouTubeUrlQueue(marker, withPolicy({ maxLineLength: 10 }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.queue.issues).toEqual([{ line: 1, reason: "line-too-long" }]);
    expect(JSON.stringify(result)).not.toContain(marker);
  });
});

describe("parseYouTubeUrlQueue - atomic size limits", () => {
  it("preserves the 4c9907c5 queue limits", () => {
    expect(YOUTUBE_QUEUE_PARSE_POLICY).toEqual({
      maxInputBytes: 256 * 1_024,
      maxInputLines: 1_000,
      maxLineLength: 2_048,
      maxAcceptedItems: 200,
      maxIssueDetails: 50,
    });
    expect(Object.isFrozen(YOUTUBE_QUEUE_PARSE_POLICY)).toBe(true);
  });

  it("rejects input over the byte cap atomically, with no partial result", () => {
    const policy = withPolicy({ maxInputBytes: 10 });
    const result = parseYouTubeUrlQueue("https://www.youtube.com/watch?v=AAAAAAAAAAA", policy);
    expect(result).toEqual({ ok: false, error: { reason: "input-too-many-bytes" } });
  });

  it("rejects multi-byte UTF-8 input whose encoded size exceeds the cap even though .length does not", () => {
    // Each hiragana character below is one UTF-16 code unit (so `.length`
    // is small) but three UTF-8 bytes, so this only fails the precise
    // byte-length check, not the cheap `.length` pre-check.
    const policy = withPolicy({ maxInputBytes: 5 });
    const text = "ああ"; // length 2, 6 UTF-8 bytes
    expect(text.length).toBeLessThan(policy.maxInputBytes);
    const result = parseYouTubeUrlQueue(text, policy);
    expect(result).toEqual({ ok: false, error: { reason: "input-too-many-bytes" } });
  });

  it("accepts input exactly at the byte cap", () => {
    const text = "https://youtu.be/AAAAAAAAAAA"; // 29 ASCII bytes
    const policy = withPolicy({ maxInputBytes: text.length });
    const result = parseYouTubeUrlQueue(text, policy);
    expect(result.ok).toBe(true);
  });

  it("counts a stripped byte order mark against the byte cap", () => {
    const byteOrderMark = String.fromCharCode(0xfeff);
    const textWithoutMark = "https://youtu.be/AAAAAAAAAAA";
    const policy = withPolicy({ maxInputBytes: textWithoutMark.length });
    const result = parseYouTubeUrlQueue(`${byteOrderMark}${textWithoutMark}`, policy);
    expect(result).toEqual({ ok: false, error: { reason: "input-too-many-bytes" } });
  });

  it("rejects input over the line cap atomically, with no partial result", () => {
    const policy = withPolicy({ maxInputLines: 3 });
    const text = ["a", "b", "c", "d"].join("\n");
    const result = parseYouTubeUrlQueue(text, policy);
    expect(result).toEqual({ ok: false, error: { reason: "input-too-many-lines" } });
  });

  it("accepts input exactly at the line cap", () => {
    const policy = withPolicy({ maxInputLines: 3 });
    const text = ["a", "b", "c"].join("\n");
    const result = parseYouTubeUrlQueue(text, policy);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.queue.counts.totalLines).toBe(3);
  });

  it("accepts input exactly at the line cap when it ends with a terminal newline", () => {
    // The terminal newline must not manufacture a phantom fourth line that
    // pushes an exactly-at-cap input over the line bound.
    const policy = withPolicy({ maxInputLines: 3 });
    const result = parseYouTubeUrlQueue("a\nb\nc\n", policy);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.queue.counts.totalLines).toBe(3);
  });

  it("does not let a huge run of blank lines bypass the line cap while under the byte cap", () => {
    // A blank line is a single byte, so a byte-only bound would let this
    // input through; the independent line-count bound must still catch it.
    const policy = withPolicy({ maxInputBytes: 1_048_576, maxInputLines: 100 });
    const text = "\n".repeat(200);
    const result = parseYouTubeUrlQueue(text, policy);
    expect(result).toEqual({ ok: false, error: { reason: "input-too-many-lines" } });
  });

  it.each([
    ["negative", -1],
    ["fractional", 1.5],
    ["not-a-number", Number.NaN],
    ["infinite", Number.POSITIVE_INFINITY],
    ["unsafe integer", Number.MAX_SAFE_INTEGER + 1],
  ])("rejects a %s parser limit before parsing", (_description, invalidLimit) => {
    expect(() =>
      parseYouTubeUrlQueue("", withPolicy({ maxIssueDetails: invalidLimit })),
    ).toThrowError(
      new RangeError("YouTube queue parser limits must be non-negative safe integers."),
    );
  });
});

describe("parseYouTubeUrlQueue - zero-valued policy bounds", () => {
  it("treats every valid URL as overflow under a zero item cap, never as a duplicate", () => {
    // Nothing is ever accepted under a zero cap, so the dedupe set stays
    // empty and a repeated URL is overflow both times; only IDs that were
    // actually accepted can later resolve as duplicates.
    const text = [
      "https://www.youtube.com/watch?v=AAAAAAAAAAA",
      "https://www.youtube.com/watch?v=AAAAAAAAAAA",
    ].join("\n");
    const result = parseYouTubeUrlQueue(text, withPolicy({ maxAcceptedItems: 0 }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.queue.videoIds).toEqual([]);
    expect(result.queue.counts.overflow).toBe(2);
    expect(result.queue.counts.duplicate).toBe(0);
  });

  it("accepts empty input under a zero line cap and rejects any non-empty input", () => {
    const policy = withPolicy({ maxInputLines: 0 });
    const empty = parseYouTubeUrlQueue("", policy);
    expect(empty.ok).toBe(true);
    if (empty.ok) {
      expect(empty.queue.counts.totalLines).toBe(0);
    }
    expect(parseYouTubeUrlQueue("\n", policy)).toEqual({
      ok: false,
      error: { reason: "input-too-many-lines" },
    });
  });

  it("accepts empty input under a zero byte cap and rejects a single byte", () => {
    const policy = withPolicy({ maxInputBytes: 0 });
    expect(parseYouTubeUrlQueue("", policy).ok).toBe(true);
    expect(parseYouTubeUrlQueue("a", policy)).toEqual({
      ok: false,
      error: { reason: "input-too-many-bytes" },
    });
  });

  it("keeps issues empty under a zero detail cap while still counting malformed lines", () => {
    const result = parseYouTubeUrlQueue("not a url", withPolicy({ maxIssueDetails: 0 }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.queue.counts.malformed).toBe(1);
    expect(result.queue.issues).toEqual([]);
    expect(result.queue.issuesTruncated).toBe(true);
  });

  it("still classifies empty lines as blank under a zero line-length cap, while a whitespace-only line is too long", () => {
    // Raw length is measured before trimming: an empty line has raw length
    // zero and stays blank, while a single space exceeds the zero cap.
    const result = parseYouTubeUrlQueue(" \n\n", withPolicy({ maxLineLength: 0 }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.queue.counts.totalLines).toBe(2);
    expect(result.queue.counts.blank).toBe(1);
    expect(result.queue.issues).toEqual([{ line: 1, reason: "line-too-long" }]);
  });
});

describe("parseYouTubeUrlQueue - CRLF/LF and newline semantics", () => {
  it("treats empty text as zero lines", () => {
    const result = parseYouTubeUrlQueue("");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.queue.counts.totalLines).toBe(0);
  });

  it("treats a single newline character as exactly one blank line", () => {
    const result = parseYouTubeUrlQueue("\n");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.queue.counts.totalLines).toBe(1);
    expect(result.queue.counts.blank).toBe(1);
  });

  it("does not count a terminal newline as an extra trailing blank line", () => {
    const withTrailingNewline = parseYouTubeUrlQueue("https://youtu.be/AAAAAAAAAAA\n");
    const withoutTrailingNewline = parseYouTubeUrlQueue("https://youtu.be/AAAAAAAAAAA");
    expect(withTrailingNewline.ok).toBe(true);
    expect(withoutTrailingNewline.ok).toBe(true);
    if (!withTrailingNewline.ok || !withoutTrailingNewline.ok) return;
    expect(withTrailingNewline.queue.counts.totalLines).toBe(1);
    expect(withTrailingNewline.queue.counts).toEqual(withoutTrailingNewline.queue.counts);
  });

  it("still counts a genuine blank line before a terminal newline", () => {
    const result = parseYouTubeUrlQueue("https://youtu.be/AAAAAAAAAAA\n\n");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.queue.counts.totalLines).toBe(2);
    expect(result.queue.counts.blank).toBe(1);
  });

  it("treats CRLF and LF line endings identically", () => {
    const crlf = parseYouTubeUrlQueue(
      "https://www.youtube.com/watch?v=AAAAAAAAAAA\r\nhttps://www.youtube.com/watch?v=BBBBBBBBBBB\r\n",
    );
    const lf = parseYouTubeUrlQueue(
      "https://www.youtube.com/watch?v=AAAAAAAAAAA\nhttps://www.youtube.com/watch?v=BBBBBBBBBBB\n",
    );
    expect(crlf.ok).toBe(true);
    expect(lf.ok).toBe(true);
    if (!crlf.ok || !lf.ok) return;
    expect(crlf.queue.videoIds).toEqual(["AAAAAAAAAAA", "BBBBBBBBBBB"]);
    expect(crlf.queue).toEqual(lf.queue);
  });

  it("does not treat a lone carriage return as a line terminator", () => {
    // A lone \r stays embedded in its logical line, which then fails the
    // URL grammar; it must never silently split one physical line into two
    // accepted URLs.
    const result = parseYouTubeUrlQueue(
      "https://youtu.be/AAAAAAAAAAA\rhttps://youtu.be/BBBBBBBBBBB",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.queue.counts.totalLines).toBe(1);
    expect(result.queue.videoIds).toEqual([]);
    expect(result.queue.issues).toEqual([{ line: 1, reason: "invalid-url" }]);
  });

  it("handles mixed CRLF and LF endings within the same input", () => {
    const text = "https://youtu.be/AAAAAAAAAAA\r\n# comment\nhttps://youtu.be/BBBBBBBBBBB";
    const result = parseYouTubeUrlQueue(text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.queue.videoIds).toEqual(["AAAAAAAAAAA", "BBBBBBBBBBB"]);
    expect(result.queue.counts.comment).toBe(1);
    expect(result.queue.counts.totalLines).toBe(3);
  });
});

describe("parseYouTubeUrlQueue - byte order mark handling", () => {
  it("strips a leading BOM so the first line still parses as a canonical URL", () => {
    // Built via `fromCharCode` rather than a literal/escaped character so
    // the BOM is not an invisible byte sequence sitting in this test file.
    const byteOrderMark = String.fromCharCode(0xfeff);
    const result = parseYouTubeUrlQueue(
      `${byteOrderMark}https://www.youtube.com/watch?v=AAAAAAAAAAA`,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.queue.videoIds).toEqual(["AAAAAAAAAAA"]);
    expect(result.queue.counts.malformed).toBe(0);
  });

  it("treats BOM-only input as empty after stripping", () => {
    const result = parseYouTubeUrlQueue(String.fromCharCode(0xfeff));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.queue.counts.totalLines).toBe(0);
  });
});

describe("parseYouTubeUrlQueue - deterministic accounting invariant", () => {
  it("always sums every line category back to the total line count", () => {
    const text = [
      "https://www.youtube.com/watch?v=AAAAAAAAAAA",
      "https://www.youtube.com/watch?v=AAAAAAAAAAA", // duplicate
      "",
      "# a comment",
      "not a url",
      "https://youtu.be/BBBBBBBBBBB",
    ].join("\n");
    const policy = withPolicy({ maxAcceptedItems: 1 });
    const result = parseYouTubeUrlQueue(text, policy);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { counts } = result.queue;
    expect(
      counts.blank +
        counts.comment +
        counts.accepted +
        counts.duplicate +
        counts.malformed +
        counts.overflow,
    ).toBe(counts.totalLines);
    // Sanity check that this fixture actually exercises every category, so
    // the invariant above is not trivially satisfied by all-zero counts.
    expect(counts).toEqual({
      totalLines: 6,
      blank: 1,
      comment: 1,
      accepted: 1,
      duplicate: 1,
      malformed: 1,
      overflow: 1,
    });
  });
});
