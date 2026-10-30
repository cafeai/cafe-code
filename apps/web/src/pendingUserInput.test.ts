import { describe, expect, it } from "vitest";

import {
  buildPendingUserInputAnswers,
  buildPendingUserInputResponse,
  countAnsweredPendingUserInputQuestions,
  derivePendingUserInputProgress,
  findFirstUnansweredPendingUserInputQuestionIndex,
  resolvePendingUserInputAnswer,
  setPendingUserInputCustomAnswer,
  skipPendingUserInputQuestion,
  togglePendingUserInputOptionSelection,
} from "./pendingUserInput";

const singleSelectQuestion = {
  id: "scope",
  header: "Scope",
  question: "What should the plan target first?",
  options: [
    {
      label: "Orchestration-first",
      description: "Focus on orchestration first",
    },
  ],
  multiSelect: false,
} as const;

const multiSelectQuestion = {
  id: "areas",
  header: "Areas",
  question: "Which areas should this change cover?",
  options: [
    {
      label: "Server",
      description: "Server",
    },
    {
      label: "Web",
      description: "Web",
    },
  ],
  multiSelect: true,
} as const;

describe("resolvePendingUserInputAnswer", () => {
  it("prefers a custom answer over selected options", () => {
    expect(
      resolvePendingUserInputAnswer(singleSelectQuestion, {
        selectedOptionLabels: ["Orchestration-first"],
        customAnswer: "Keep the existing envelope for one release",
      }),
    ).toBe("Keep the existing envelope for one release");
  });

  it("falls back to the selected option for single-select questions", () => {
    expect(
      resolvePendingUserInputAnswer(singleSelectQuestion, {
        selectedOptionLabels: ["Orchestration-first"],
      }),
    ).toBe("Orchestration-first");
  });

  it("returns all selected labels for multi-select questions", () => {
    expect(
      resolvePendingUserInputAnswer(multiSelectQuestion, {
        selectedOptionLabels: ["Server", "Web"],
      }),
    ).toEqual(["Server", "Web"]);
  });

  it("clears the preset selection when a custom answer is entered", () => {
    expect(
      setPendingUserInputCustomAnswer(
        {
          selectedOptionLabels: ["Server", "Web"],
        },
        "doesn't matter",
      ),
    ).toEqual({
      customAnswer: "doesn't matter",
    });
  });
});

describe("togglePendingUserInputOptionSelection", () => {
  it("toggles options for multi-select questions", () => {
    expect(togglePendingUserInputOptionSelection(multiSelectQuestion, undefined, "Server")).toEqual(
      {
        customAnswer: "",
        selectedOptionLabels: ["Server"],
      },
    );

    expect(
      togglePendingUserInputOptionSelection(
        multiSelectQuestion,
        {
          selectedOptionLabels: ["Server", "Web"],
        },
        "Server",
      ),
    ).toEqual({
      customAnswer: "",
      selectedOptionLabels: ["Web"],
    });
  });
});

describe("buildPendingUserInputAnswers", () => {
  it("preserves a prototype-like question id as an own ordinary answer", () => {
    const answers = buildPendingUserInputAnswers(
      [{ ...singleSelectQuestion, id: "__proto__" }],
      Object.fromEntries([["__proto__", { customAnswer: "Keep the original provider" }]]),
    );
    expect(answers).toEqual(JSON.parse('{"__proto__":"Keep the original provider"}'));
    expect(Object.hasOwn(answers!, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(answers!)).toBe(Object.prototype);
  });

  it("retains legacy last-question handling for repeated ordinary identities", () => {
    expect(
      buildPendingUserInputAnswers(
        [{ ...singleSelectQuestion, multiSelect: true }, singleSelectQuestion],
        { scope: { selectedOptionLabels: ["First", "Second"] } },
      ),
    ).toEqual({ scope: "First" });
  });

  it("returns a canonical answer map for complete prompts", () => {
    expect(
      buildPendingUserInputAnswers(
        [
          singleSelectQuestion,
          {
            id: "compat",
            header: "Compat",
            question: "How strict should compatibility be?",
            options: [
              {
                label: "Keep current envelope",
                description: "Preserve current wire format",
              },
            ],
            multiSelect: false,
          },
        ],
        {
          scope: {
            selectedOptionLabels: ["Orchestration-first"],
          },
          compat: {
            customAnswer: "Keep the current envelope for one release window",
          },
        },
      ),
    ).toEqual({
      scope: "Orchestration-first",
      compat: "Keep the current envelope for one release window",
    });
  });

  it("returns arrays for answered multi-select prompts", () => {
    expect(
      buildPendingUserInputAnswers([multiSelectQuestion], {
        areas: {
          selectedOptionLabels: ["Server", "Web"],
        },
      }),
    ).toEqual({
      areas: ["Server", "Web"],
    });
  });

  it("returns null when any question is unanswered", () => {
    expect(buildPendingUserInputAnswers([singleSelectQuestion], {})).toBeNull();
  });
});

describe("pending user input question progress", () => {
  const questions = [
    singleSelectQuestion,
    {
      id: "compat",
      header: "Compat",
      question: "How strict should compatibility be?",
      options: [
        {
          label: "Keep current envelope",
          description: "Preserve current wire format",
        },
      ],
      multiSelect: false,
    },
  ] as const;

  it("counts only answered questions", () => {
    expect(
      countAnsweredPendingUserInputQuestions(questions, {
        scope: {
          selectedOptionLabels: ["Orchestration-first"],
        },
      }),
    ).toBe(1);
  });

  it("finds the first unanswered question", () => {
    expect(
      findFirstUnansweredPendingUserInputQuestionIndex(questions, {
        scope: {
          selectedOptionLabels: ["Orchestration-first"],
        },
      }),
    ).toBe(1);
  });

  it("returns the last question index when all answers are complete", () => {
    expect(
      findFirstUnansweredPendingUserInputQuestionIndex(questions, {
        scope: {
          selectedOptionLabels: ["Orchestration-first"],
        },
        compat: {
          customAnswer: "Keep it for one release window",
        },
      }),
    ).toBe(1);
  });

  it("derives the active question and advancement state", () => {
    expect(
      derivePendingUserInputProgress(
        questions,
        {
          scope: {
            selectedOptionLabels: ["Orchestration-first"],
          },
        },
        0,
      ),
    ).toMatchObject({
      questionIndex: 0,
      activeQuestion: questions[0],
      selectedOptionLabels: ["Orchestration-first"],
      customAnswer: "",
      resolvedAnswer: "Orchestration-first",
      answeredQuestionCount: 1,
      isLastQuestion: false,
      isComplete: false,
      canAdvance: true,
    });
  });

  it("treats multi-select questions as answered when they have selected options", () => {
    expect(
      derivePendingUserInputProgress(
        [multiSelectQuestion],
        {
          areas: {
            selectedOptionLabels: ["Server", "Web"],
          },
        },
        0,
      ),
    ).toMatchObject({
      selectedOptionLabels: ["Server", "Web"],
      resolvedAnswer: ["Server", "Web"],
      canAdvance: true,
      isComplete: true,
    });
  });
});

describe("explicit unanswered question responses", () => {
  const questions = [singleSelectQuestion, multiSelectQuestion];

  it("keeps the legacy answers-only response free of optional metadata", () => {
    expect(
      buildPendingUserInputResponse(
        questions,
        {
          scope: { customAnswer: "Keep current behavior" },
          areas: { selectedOptionLabels: ["Server", "Web"] },
        },
        false,
      ),
    ).toEqual({ answers: { scope: "Keep current behavior", areas: ["Server", "Web"] } });
    expect(buildPendingUserInputResponse(questions, {}, false, true)).toBeNull();
    expect(
      buildPendingUserInputResponse(
        questions,
        {
          scope: skipPendingUserInputQuestion(),
          areas: { customAnswer: "Web" },
        },
        false,
      ),
    ).toBeNull();
  });

  it("keeps skips separate from actual answers and ignores unknown draft keys", () => {
    expect(
      buildPendingUserInputResponse(
        questions,
        {
          scope: skipPendingUserInputQuestion(),
          areas: { selectedOptionLabels: ["Web"] },
          unrelated: { customAnswer: "Do not send this old draft" },
        },
        true,
      ),
    ).toEqual({ answers: { areas: ["Web"] }, unanswered: { scope: "skipped" } });
    expect(
      buildPendingUserInputAnswers([singleSelectQuestion], {
        scope: skipPendingUserInputQuestion(),
      }),
    ).toBeNull();
  });

  it("dismisses only unanswered questions and retains completed answers and prior skips", () => {
    const third = { ...singleSelectQuestion, id: "remaining" };
    expect(
      buildPendingUserInputResponse(
        [...questions, third],
        {
          scope: skipPendingUserInputQuestion(),
          areas: { customAnswer: "Keep the existing adapter" },
        },
        true,
        true,
      ),
    ).toEqual({
      answers: { areas: "Keep the existing adapter" },
      unanswered: { scope: "skipped", remaining: "dismissed" },
    });
    expect(buildPendingUserInputResponse(questions, {}, true)).toBeNull();
  });

  it("removes a skip when a user types or selects an actual answer", () => {
    const skipped = skipPendingUserInputQuestion();
    expect(setPendingUserInputCustomAnswer(skipped, "Use the existing model")).toEqual({
      customAnswer: "Use the existing model",
    });
    expect(
      togglePendingUserInputOptionSelection(singleSelectQuestion, skipped, "Orchestration-first"),
    ).toEqual({ customAnswer: "", selectedOptionLabels: ["Orchestration-first"] });
    expect(
      buildPendingUserInputResponse(
        [singleSelectQuestion],
        {
          scope: { ...skipped, customAnswer: "Conflicting draft" },
        },
        true,
      ),
    ).toBeNull();
    expect(
      buildPendingUserInputResponse(
        [singleSelectQuestion],
        {
          scope: { ...skipped, selectedOptionLabels: ["Orchestration-first"] },
        },
        true,
        true,
      ),
    ).toBeNull();
  });

  it("treats an explicit supported skip as resolved without counting it as an answer", () => {
    const draft = { scope: skipPendingUserInputQuestion() };
    expect(derivePendingUserInputProgress([singleSelectQuestion], draft, 0, true)).toMatchObject({
      canAdvance: true,
      isComplete: true,
      answeredQuestionCount: 0,
      resolvedAnswer: null,
    });
    expect(derivePendingUserInputProgress([singleSelectQuestion], draft, 0, false)).toMatchObject({
      canAdvance: false,
      isComplete: false,
      answeredQuestionCount: 0,
    });
  });

  it("refuses duplicate identities and creates inert own response properties", () => {
    expect(
      buildPendingUserInputResponse([singleSelectQuestion, singleSelectQuestion], {}, true, true),
    ).toBeNull();
    const response = buildPendingUserInputResponse(
      [{ ...singleSelectQuestion, id: "__proto__" }],
      {},
      true,
      true,
    );
    expect(response?.unanswered).toEqual(JSON.parse('{"__proto__":"dismissed"}'));
    expect(Object.getPrototypeOf(response!.unanswered!)).toBe(Object.prototype);
    expect(Object.hasOwn(response!.unanswered!, "__proto__")).toBe(true);
  });
});
