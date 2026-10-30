import { describe, expect, it } from "vitest";
import type { UserInputQuestion } from "@cafecode/contracts";
import {
  prepareClaudeUnansweredQuestionResponse,
  supportsClaudeUnansweredQuestions,
} from "./claudeUnansweredQuestions.ts";

const question = (id: string): UserInputQuestion => ({
  id,
  question: id,
  header: "Choice",
  options: [],
  multiSelect: false,
});
const questions = [question("Framework?"), question("Theme?"), question("Deploy?")];

describe("Claude explicitly unanswered questions", () => {
  it("keeps real answers separate from native Skip and Dismiss annotations", () => {
    const answers = { "Framework?": "React" };
    const unanswered = { "Theme?": "skipped", "Deploy?": "dismissed" };
    expect(prepareClaudeUnansweredQuestionResponse(questions, answers, unanswered)).toEqual({
      answers,
      unanswered,
      annotations: {
        "Theme?": { unanswered: "skipped" },
        "Deploy?": { unanswered: "dismissed" },
      },
    });
    expect(answers).toEqual({ "Framework?": "React" });
    expect(unanswered).toEqual({ "Theme?": "skipped", "Deploy?": "dismissed" });
  });

  it.each([
    [{ "Framework?": "React" }, { "Theme?": "skipped" }],
    [
      { "Framework?": "React", "Theme?": "Blue" },
      { "Theme?": "skipped", "Deploy?": "dismissed" },
    ],
    [
      { "Framework?": "React" },
      { "Theme?": "skipped", "Deploy?": "dismissed", foreign: "skipped" },
    ],
    [{ "Framework?": "React" }, { "Theme?": "replied_in_chat", "Deploy?": "dismissed" }],
    [{ "Framework?": " " }, { "Theme?": "skipped", "Deploy?": "dismissed" }],
    [
      { "Framework?": "React", foreign: "answer" },
      { "Theme?": "skipped", "Deploy?": "dismissed" },
    ],
    [{ "Framework?": [] }, { "Theme?": "skipped", "Deploy?": "dismissed" }],
  ])(
    "rejects partial, overlapping, foreign, blank or unsupported response %#",
    (answers, unanswered) => {
      expect(
        prepareClaudeUnansweredQuestionResponse(questions, answers, unanswered),
      ).toBeUndefined();
    },
  );

  it("accepts selected labels and prototype-looking literal question text without mutation", () => {
    const answers = Object.fromEntries([["constructor", ["One", "Two"]]]);
    const unanswered = Object.fromEntries([["__proto__", "skipped"]]);
    const result = prepareClaudeUnansweredQuestionResponse(
      [question("constructor"), question("__proto__")],
      answers,
      unanswered,
    );
    expect(Object.getPrototypeOf(result!.annotations)).toBe(Object.prototype);
    expect(Object.hasOwn(result!.annotations, "__proto__")).toBe(true);
    expect(result!.annotations.__proto__).toEqual({ unanswered: "skipped" });
    expect(result!.answers.constructor).toEqual(["One", "Two"]);
  });

  it("does not execute accessors or admit inherited, nonenumerable or symbolic answers", () => {
    let calls = 0;
    const getter = Object.defineProperty({}, "Framework?", {
      enumerable: true,
      get() {
        calls += 1;
        return "React";
      },
    });
    for (const answers of [
      getter,
      Object.create({ "Framework?": "React" }),
      Object.defineProperty({}, "Framework?", { value: "React" }),
      { "Framework?": "React", [Symbol("private")]: "value" },
      new Proxy(
        {},
        {
          getPrototypeOf: () => {
            throw new Error("opaque");
          },
        },
      ),
    ]) {
      expect(
        prepareClaudeUnansweredQuestionResponse(questions, answers, {
          "Theme?": "skipped",
          "Deploy?": "dismissed",
        }),
      ).toBeUndefined();
    }
    expect(calls).toBe(0);
  });

  it("rejects live and revoked proxies before any user trap executes", () => {
    let traps = 0;
    const handler = {
      getPrototypeOf() {
        traps += 1;
        return Object.prototype;
      },
      ownKeys() {
        traps += 1;
        return [];
      },
      get() {
        traps += 1;
        return undefined;
      },
      getOwnPropertyDescriptor() {
        traps += 1;
        return undefined;
      },
    };
    const revoked = Proxy.revocable({}, handler);
    revoked.revoke();
    const map = { "Theme?": "skipped", "Deploy?": "dismissed" };
    for (const answers of [
      new Proxy({}, handler),
      revoked.proxy,
      { "Framework?": new Proxy([], handler) },
    ]) {
      expect(prepareClaudeUnansweredQuestionResponse(questions, answers, map)).toBeUndefined();
    }
    expect(
      prepareClaudeUnansweredQuestionResponse(
        questions,
        { "Framework?": "React" },
        new Proxy(map, handler),
      ),
    ).toBeUndefined();
    expect(traps).toBe(0);
  });

  it("does not execute array accessors or silently strip non-JSON list properties", () => {
    let reads = 0;
    const getter = Object.defineProperty(["React"], 0, {
      enumerable: true,
      get() {
        reads += 1;
        return "React";
      },
    });
    const symbol = Object.assign(["React"], { [Symbol("opaque")]: "value" });
    const hidden = Object.defineProperty(["React"], "extra", { value: "private" });
    const sparse = new Array(1);
    const inherited = Object.setPrototypeOf(["React"], { 0: "Vue" });
    for (const value of [getter, symbol, hidden, sparse, inherited]) {
      expect(
        prepareClaudeUnansweredQuestionResponse(
          questions,
          { "Framework?": value },
          {
            "Theme?": "skipped",
            "Deploy?": "dismissed",
          },
        ),
      ).toBeUndefined();
    }
    expect(reads).toBe(0);
  });

  it("refuses duplicate IDs and finite question/answer size overflows", () => {
    expect(supportsClaudeUnansweredQuestions([])).toBe(false);
    expect(supportsClaudeUnansweredQuestions([{ ...question("q-0"), question: "" }])).toBe(false);
    expect(
      supportsClaudeUnansweredQuestions([{ ...question("short-id"), question: "Full text?" }]),
    ).toBe(false);
    expect(supportsClaudeUnansweredQuestions([question("same"), question("same")])).toBe(false);
    expect(supportsClaudeUnansweredQuestions([question("x".repeat(16_385))])).toBe(false);
    expect(
      supportsClaudeUnansweredQuestions(Array.from({ length: 65 }, (_, i) => question(`${i}`))),
    ).toBe(false);
    expect(
      supportsClaudeUnansweredQuestions(
        Array.from({ length: 5 }, (_, i) => question(`${i}${"x".repeat(16_000)}`)),
      ),
    ).toBe(false);
    expect(
      prepareClaudeUnansweredQuestionResponse(
        questions,
        {
          "Framework?": "x".repeat(65_536),
        },
        { "Theme?": "skipped", "Deploy?": "dismissed" },
      ),
    ).toBeUndefined();
  });
});
