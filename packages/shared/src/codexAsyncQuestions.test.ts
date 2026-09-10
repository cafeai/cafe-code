import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from "@cafecode/contracts";
import { describe, expect, it } from "vitest";

import {
  formatCodexAsyncQuestionAnswer,
  normalizeCodexAsyncQuestions,
} from "./codexAsyncQuestions.ts";

describe("normalizeCodexAsyncQuestions", () => {
  it.each([undefined, null, true, 123, "question", { title: "Question?" }])(
    "ignores a non-array payload: %s",
    (value) => {
      expect(normalizeCodexAsyncQuestions(value)).toEqual([]);
    },
  );

  it("keeps exact titles, optional suggestions, and provider order", () => {
    const input = [
      { title: "  Which\r\nrelease?  ", options: [" Stable ", "Preview"], ignored: true },
      { title: "Describe your preference." },
      { title: "Anything else?", options: null },
    ];
    expect(normalizeCodexAsyncQuestions(input)).toEqual([
      { title: "  Which\r\nrelease?  ", options: [" Stable ", "Preview"] },
      { title: "Describe your preference.", options: [] },
      { title: "Anything else?", options: [] },
    ]);
    expect(input[0]?.options).toEqual([" Stable ", "Preview"]);
  });

  it("rejects malformed rows and uses only the actual title field", () => {
    expect(
      normalizeCodexAsyncQuestions([
        null,
        true,
        "Question?",
        ["Question?"],
        {},
        { title: 7 },
        { title: " \t\r\n" },
        { question: "Legacy-looking title" },
        { title: "Question?", options: "all" },
        { title: "Question?", options: {} },
        { title: "Question?", options: [] },
      ]),
    ).toEqual([{ title: "Question?", options: [] }]);
  });

  it("discards invalid suggestions and deduplicates exact valid suggestions", () => {
    expect(
      normalizeCodexAsyncQuestions([
        {
          title: "Choose",
          options: ["Yes", "No", "Yes", "", " \n ", null, 1, {}, ["Yes"], "no"],
        },
      ]),
    ).toEqual([{ title: "Choose", options: ["Yes", "No", "no"] }]);
  });

  it("bounds question titles by UTF-8 bytes without truncating their content", () => {
    const exact = "é".repeat(2_048);
    expect(
      normalizeCodexAsyncQuestions([
        { title: exact },
        { title: `${exact}x` },
        { title: "🙂".repeat(1_024) },
        { title: `${"🙂".repeat(1_024)}x` },
        { title: `${" ".repeat(4_096)}x` },
      ]),
    ).toEqual([
      { title: exact, options: [] },
      { title: "🙂".repeat(1_024), options: [] },
    ]);
  });

  it("bounds complete suggestion labels before trimming or display", () => {
    const exact = "界".repeat(170) + "ab";
    const emoji = "🙂".repeat(128);
    expect(
      normalizeCodexAsyncQuestions([
        {
          title: "Choose",
          options: [exact, `${exact}x`, emoji, `${emoji}x`, " ".repeat(512) + "x"],
        },
      ]),
    ).toEqual([{ title: "Choose", options: [exact, emoji] }]);
  });

  it("inspects only the first 16 questions and first 32 suggestion entries", () => {
    const questions = Array.from({ length: 18 }, (_, index) => ({ title: `Question ${index}` }));
    expect(normalizeCodexAsyncQuestions(questions).map((row) => row.title)).toEqual(
      questions.slice(0, 16).map((row) => row.title),
    );
    expect(
      normalizeCodexAsyncQuestions([...Array.from({ length: 16 }, () => null), questions[0]]),
    ).toEqual([]);
    expect(
      normalizeCodexAsyncQuestions([
        { title: "Choose", options: [...Array.from({ length: 32 }, () => "One"), "Hidden"] },
      ]),
    ).toEqual([{ title: "Choose", options: ["One"] }]);
  });

  it.each([
    "\u0000",
    "\u001b",
    "\u007f",
    "\u0085",
    "\u061c",
    "\u200e",
    "\u202e",
    "\u2066",
    "\ud800",
    "\udfff",
  ])("rejects control, bidi, or malformed Unicode labels: %j", (hidden) => {
    expect(normalizeCodexAsyncQuestions([{ title: `Approve${hidden}?` }])).toEqual([]);
    expect(
      normalizeCodexAsyncQuestions([{ title: "Choose", options: [`Yes${hidden}`, "No"] }]),
    ).toEqual([{ title: "Choose", options: ["No"] }]);
  });

  it("preserves non-Latin text, combining marks and joined emoji", () => {
    const title = "日本語 e\u0301 👩‍💻 مرحبا";
    expect(normalizeCodexAsyncQuestions([{ title, options: [title] }])).toEqual([
      { title, options: [title] },
    ]);
  });
});

describe("formatCodexAsyncQuestionAnswer", () => {
  it("matches upstream quote framing, flattens each CR/LF, and trims only the answer", () => {
    expect(
      formatCodexAsyncQuestionAnswer("  First\r\nsecond\tline  ", " \n Keep\r\nthis. \t"),
    ).toBe(">   First  second\tline  \n\nKeep\r\nthis.");
  });

  it.each(["", " \n\r\t "])("rejects a blank answer: %j", (answer) => {
    expect(formatCodexAsyncQuestionAnswer("Question?", answer)).toBeNull();
  });

  it.each(["", " \t\n", "x".repeat(4_097), "Question\u202e?", "Question\ud800?"])(
    "rejects an invalid or oversized question before framing: %j",
    (title) => {
      expect(formatCodexAsyncQuestionAnswer(title, "Yes")).toBeNull();
    },
  );

  it.each([
    ["x".repeat(513), "x".repeat(512)],
    ["é".repeat(257), "é".repeat(256)],
    ["界".repeat(171), "界".repeat(170)],
    ["🙂".repeat(129), "🙂".repeat(128)],
    ["x".repeat(511) + "é", "x".repeat(511)],
    ["é\n".repeat(1_000), ("é\n".repeat(170) + "é").replaceAll("\n", " ")],
  ])("cuts title %j at a complete UTF-8 scalar boundary", (title, prefix) => {
    expect(formatCodexAsyncQuestionAnswer(title, "Yes")).toBe(`> ${prefix}\n\nYes`);
  });

  it("counts question framing against the exact provider user-text limit", () => {
    const title = "Question?";
    const prefixLength = `> ${title}\n\n`.length;
    const answer = "a".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS - prefixLength);
    expect(formatCodexAsyncQuestionAnswer(title, answer)?.length).toBe(
      PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
    );
    expect(formatCodexAsyncQuestionAnswer(title, `${answer}a`)).toBeNull();
    expect(
      formatCodexAsyncQuestionAnswer(title, "a".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS + 1)),
    ).toBeNull();
  });

  it("uses UTF-16 code units for user-text admission but UTF-8 bytes for question framing", () => {
    const title = "🙂";
    const prefix = `> ${title}\n\n`;
    const answer = "🙂".repeat((PROVIDER_SEND_TURN_MAX_INPUT_CHARS - prefix.length) / 2);
    expect(formatCodexAsyncQuestionAnswer(title, answer)).toBe(prefix + answer);
    expect(formatCodexAsyncQuestionAnswer(title, answer + "x")).toBeNull();
  });

  it("leaves shell syntax, Markdown and user-authored answer content inert and exact", () => {
    const answer = "`$(touch /tmp/unwanted)`; ${secret}\n> literal quote";
    expect(formatCodexAsyncQuestionAnswer("Run `echo $HOME`?", answer)).toBe(
      "> Run `echo $HOME`?\n\n" + answer,
    );
  });
});
