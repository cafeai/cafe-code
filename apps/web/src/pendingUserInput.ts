import type {
  ProviderUserInputUnanswered,
  ProviderUserInputUnansweredDisposition,
  UserInputQuestion,
} from "@cafecode/contracts";

export interface PendingUserInputDraftAnswer {
  selectedOptionLabels?: string[];
  customAnswer?: string;
  /** An explicit local choice, never an empty or fabricated answer. */
  unanswered?: "skipped";
}

export interface PendingUserInputResponse {
  answers: Record<string, string | string[]>;
  unanswered?: ProviderUserInputUnanswered;
}

export interface PendingUserInputProgress {
  questionIndex: number;
  activeQuestion: UserInputQuestion | null;
  activeDraft: PendingUserInputDraftAnswer | undefined;
  selectedOptionLabels: string[];
  customAnswer: string;
  resolvedAnswer: string | string[] | null;
  usingCustomAnswer: boolean;
  answeredQuestionCount: number;
  isLastQuestion: boolean;
  isComplete: boolean;
  canAdvance: boolean;
}

function normalizeDraftAnswer(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeSelectedOptionLabels(value: string[] | undefined): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return Array.from(new Set(normalized));
}

export function resolvePendingUserInputAnswer(
  question: UserInputQuestion,
  draft: PendingUserInputDraftAnswer | undefined,
): string | string[] | null {
  if (draft?.unanswered !== undefined) return null;
  const customAnswer = normalizeDraftAnswer(draft?.customAnswer);
  if (customAnswer) {
    return customAnswer;
  }

  const selectedOptionLabels = normalizeSelectedOptionLabels(draft?.selectedOptionLabels);
  if (question.multiSelect) {
    return selectedOptionLabels.length > 0 ? selectedOptionLabels : null;
  }

  return selectedOptionLabels[0] ?? null;
}

/** Replacing an answer with Skip deliberately removes both answer sources. */
export function skipPendingUserInputQuestion(): PendingUserInputDraftAnswer {
  return { unanswered: "skipped" };
}

/**
 * Only a capability advertised on this exact pending request permits omitted
 * answers. Dismiss preserves completed answers and explicit prior skips; it
 * dismisses only the questions that still have no answer. Unknown draft keys
 * never enter the wire response, and duplicate question identities refuse it.
 */
export function buildPendingUserInputResponse(
  questions: ReadonlyArray<UserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
  supportsUnanswered: boolean,
  dismissUnanswered = false,
): PendingUserInputResponse | null {
  const answers: Array<[string, string | string[]]> = [];
  const unanswered: Array<[string, ProviderUserInputUnansweredDisposition]> = [];
  const seen = new Set<string>();
  for (const question of questions) {
    if (seen.has(question.id)) return null;
    seen.add(question.id);
    const draft = draftAnswers[question.id];
    if (draft?.unanswered !== undefined) {
      // Do not let a stale or malformed draft silently win over an answer.
      if (
        !supportsUnanswered ||
        draft.unanswered !== "skipped" ||
        normalizeDraftAnswer(draft.customAnswer) !== null ||
        normalizeSelectedOptionLabels(draft.selectedOptionLabels).length > 0
      )
        return null;
      unanswered.push([question.id, "skipped"]);
      continue;
    }
    const answer = resolvePendingUserInputAnswer(question, draft);
    if (answer !== null) answers.push([question.id, answer]);
    else if (supportsUnanswered && dismissUnanswered) unanswered.push([question.id, "dismissed"]);
    else return null;
  }
  // Object.fromEntries creates own data properties even for provider-authored
  // ids such as __proto__; assignment into {} would invoke its legacy setter.
  return {
    answers: Object.fromEntries(answers),
    ...(unanswered.length > 0 ? { unanswered: Object.fromEntries(unanswered) } : {}),
  };
}

export function setPendingUserInputCustomAnswer(
  draft: PendingUserInputDraftAnswer | undefined,
  customAnswer: string,
): PendingUserInputDraftAnswer {
  const selectedOptionLabels =
    customAnswer.trim().length > 0
      ? undefined
      : normalizeSelectedOptionLabels(draft?.selectedOptionLabels);

  return {
    customAnswer,
    ...(selectedOptionLabels && selectedOptionLabels.length > 0 ? { selectedOptionLabels } : {}),
  };
}

export function togglePendingUserInputOptionSelection(
  question: UserInputQuestion,
  draft: PendingUserInputDraftAnswer | undefined,
  optionLabel: string,
): PendingUserInputDraftAnswer {
  if (question.multiSelect) {
    const selectedOptionLabels = normalizeSelectedOptionLabels(draft?.selectedOptionLabels);
    const nextSelectedOptionLabels = selectedOptionLabels.includes(optionLabel)
      ? selectedOptionLabels.filter((label) => label !== optionLabel)
      : [...selectedOptionLabels, optionLabel];

    return {
      customAnswer: "",
      ...(nextSelectedOptionLabels.length > 0
        ? { selectedOptionLabels: nextSelectedOptionLabels }
        : {}),
    };
  }

  return {
    customAnswer: "",
    selectedOptionLabels: [optionLabel],
  };
}

export function buildPendingUserInputAnswers(
  questions: ReadonlyArray<UserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
): Record<string, string | string[]> | null {
  const answers: Array<[string, string | string[]]> = [];

  for (const question of questions) {
    const answer = resolvePendingUserInputAnswer(question, draftAnswers[question.id]);
    if (!answer) {
      return null;
    }
    answers.push([question.id, answer]);
  }

  // Preserve the legacy last-answer-wins handling of duplicate ids while
  // treating every provider-authored id as an inert own data property.
  return Object.fromEntries(answers);
}

export function countAnsweredPendingUserInputQuestions(
  questions: ReadonlyArray<UserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
): number {
  return questions.reduce((count, question) => {
    return resolvePendingUserInputAnswer(question, draftAnswers[question.id]) ? count + 1 : count;
  }, 0);
}

export function findFirstUnansweredPendingUserInputQuestionIndex(
  questions: ReadonlyArray<UserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
): number {
  const unansweredIndex = questions.findIndex(
    (question) => !resolvePendingUserInputAnswer(question, draftAnswers[question.id]),
  );

  return unansweredIndex === -1 ? Math.max(questions.length - 1, 0) : unansweredIndex;
}

export function derivePendingUserInputProgress(
  questions: ReadonlyArray<UserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
  questionIndex: number,
  supportsUnanswered = false,
): PendingUserInputProgress {
  const normalizedQuestionIndex =
    questions.length === 0 ? 0 : Math.max(0, Math.min(questionIndex, questions.length - 1));
  const activeQuestion = questions[normalizedQuestionIndex] ?? null;
  const activeDraft = activeQuestion ? draftAnswers[activeQuestion.id] : undefined;
  const resolvedAnswer = activeQuestion
    ? resolvePendingUserInputAnswer(activeQuestion, activeDraft)
    : null;
  const customAnswer = activeDraft?.customAnswer ?? "";
  const answeredQuestionCount = countAnsweredPendingUserInputQuestions(questions, draftAnswers);
  const isLastQuestion =
    questions.length === 0 ? true : normalizedQuestionIndex >= questions.length - 1;

  return {
    questionIndex: normalizedQuestionIndex,
    activeQuestion,
    activeDraft,
    selectedOptionLabels: normalizeSelectedOptionLabels(activeDraft?.selectedOptionLabels),
    customAnswer,
    resolvedAnswer,
    usingCustomAnswer: customAnswer.trim().length > 0,
    answeredQuestionCount,
    isLastQuestion,
    isComplete: buildPendingUserInputResponse(questions, draftAnswers, supportsUnanswered) !== null,
    canAdvance:
      Boolean(resolvedAnswer) || (supportsUnanswered && activeDraft?.unanswered === "skipped"),
  };
}
