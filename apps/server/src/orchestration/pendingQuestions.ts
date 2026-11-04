import {
  ApprovalRequestId,
  type OrchestrationThreadActivity,
  type ProviderUserInputAnswers,
  type ProviderUserInputUnanswered,
  type UserInputQuestion,
} from "@cafecode/contracts";

/** Question text is authenticated transcript content, never an error message. */
export interface PendingQuestionRequest {
  readonly requestId: ApprovalRequestId;
  readonly createdAt: string;
  readonly questions: readonly UserInputQuestion[];
  readonly isBlocking: boolean;
  readonly supportsUnanswered: boolean;
  readonly unsupportedReason:
    | "invalid-questions"
    | "duplicate-question-ids"
    | "provider-interaction"
    | null;
}

const MAX_QUESTIONS = 64;
const MAX_OPTIONS = 64;
const MAX_TEXT_CHARS = 65_536;
const MAX_REQUEST_CHARS = 524_288;
const MAX_ANSWER_CHARS = 65_536;

/** Do not run accessors while inspecting an untrusted or synthetic payload. */
function own(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function text(value: unknown, limit = MAX_TEXT_CHARS): value is string {
  return typeof value === "string" && value.length <= limit && value.trim().length > 0;
}

function array(value: unknown, limit: number): unknown[] | null {
  if (!Array.isArray(value)) return null;
  try {
    const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > limit) return null;
    const result: unknown[] = [];
    for (let index = 0; index < length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor)) return null;
      result.push(descriptor.value);
    }
    return result;
  } catch {
    return null;
  }
}

function readQuestions(payload: unknown): readonly UserInputQuestion[] | null {
  const raw = array(own(payload, "questions"), MAX_QUESTIONS);
  if (raw === null || raw.length === 0) return null;
  let chars = 0;
  const questions: UserInputQuestion[] = [];
  for (const row of raw) {
    const id = own(row, "id");
    const header = own(row, "header");
    const question = own(row, "question");
    const options = array(own(row, "options"), MAX_OPTIONS);
    const multiSelect = own(row, "multiSelect");
    if (
      !text(id, 16_384) ||
      !text(header) ||
      !text(question) ||
      options === null ||
      (multiSelect !== undefined && typeof multiSelect !== "boolean")
    )
      return null;
    chars += id.length + header.length + question.length;
    const parsedOptions: UserInputQuestion["options"][number][] = [];
    for (const option of options) {
      const label = own(option, "label");
      const description = own(option, "description");
      if (!text(label) || !text(description)) return null;
      chars += label.length + description.length;
      if (chars > MAX_REQUEST_CHARS) return null;
      parsedOptions.push({ label, description });
    }
    if (chars > MAX_REQUEST_CHARS) return null;
    // Empty options are a genuine free-text question, not missing metadata.
    questions.push({
      id,
      header,
      question,
      options: parsedOptions,
      multiSelect: multiSelect === true,
    });
  }
  return questions;
}

/** Match persisted ordering without locale-sensitive comparisons of opaque IDs. */
function compareText(left: string, right: string): number {
  const a = [...left];
  const b = [...right];
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    const difference = a[index]!.codePointAt(0)! - b[index]!.codePointAt(0)!;
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

/** Root completion, age, error prose and a read never consume a callback. */
export function derivePendingQuestionRequests(
  activities: readonly OrchestrationThreadActivity[],
): PendingQuestionRequest[] {
  const pending = new Map<ApprovalRequestId, PendingQuestionRequest>();
  const ordered = [...activities].sort(
    (left, right) =>
      (left.sequence ?? -1) - (right.sequence ?? -1) ||
      compareText(left.createdAt, right.createdAt) ||
      // Legacy activity rows can share both ordering fields. A terminal
      // callback must win that tie regardless of its opaque event ID.
      Number(left.kind === "user-input.resolved") - Number(right.kind === "user-input.resolved") ||
      compareText(left.id, right.id),
  );
  for (const activity of ordered) {
    if (activity.kind !== "user-input.requested" && activity.kind !== "user-input.resolved")
      continue;
    const requestId = own(activity.payload, "requestId");
    if (!text(requestId, 4_096)) continue;
    const id = ApprovalRequestId.make(requestId);
    if (activity.kind === "user-input.resolved") {
      pending.delete(id);
      continue;
    }
    const questions = readQuestions(activity.payload);
    const interaction = own(activity.payload, "interaction");
    const unsupportedReason =
      interaction !== undefined && interaction !== null
        ? "provider-interaction"
        : questions === null
          ? "invalid-questions"
          : new Set(questions.map((entry) => entry.id)).size !== questions.length
            ? "duplicate-question-ids"
            : null;
    pending.set(id, {
      requestId: id,
      createdAt: activity.createdAt,
      questions: questions ?? [],
      isBlocking: own(activity.payload, "isBlocking") !== false,
      supportsUnanswered: own(activity.payload, "supportsUnanswered") === true,
      unsupportedReason,
    });
  }
  return [...pending.values()].sort((left, right) => compareText(left.createdAt, right.createdAt));
}

type QuestionResponseValidation =
  | {
      readonly ok: true;
      readonly answers: ProviderUserInputAnswers;
      readonly unanswered?: ProviderUserInputUnanswered;
    }
  | { readonly ok: false; readonly reason: string };

/**
 * An MCP owner can answer a questionnaire, never manufacture an approval or
 * silently drop a question from a native multi-question callback. Run this
 * both before tool dispatch and at the engine's serialized decision boundary.
 * The provider still owns final native callback/capability validation.
 */
export function validatePendingQuestionResponse(
  request: PendingQuestionRequest | undefined,
  input: {
    readonly expectedRequestCreatedAt: string;
    readonly answers: unknown;
    readonly unanswered?: unknown;
  },
): QuestionResponseValidation {
  const fail = (reason: string): QuestionResponseValidation => ({ ok: false, reason });
  if (!request || request.createdAt !== input.expectedRequestCreatedAt)
    return fail("This question request is no longer pending. Read its current details first.");
  if (request.unsupportedReason !== null)
    return fail(
      "This request cannot be answered through the question tools. Use the Cafe interface.",
    );
  const entries = (value: unknown): readonly [string, unknown][] | null => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    try {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const keys = Object.keys(descriptors);
      if (keys.length > MAX_QUESTIONS) return null;
      const result: [string, unknown][] = [];
      for (const key of keys) {
        const descriptor = descriptors[key]!;
        if (!("value" in descriptor) || !text(key, 16_384)) return null;
        result.push([key, descriptor.value]);
      }
      return result;
    } catch {
      return null;
    }
  };
  const answers = entries(input.answers);
  const unanswered = input.unanswered === undefined ? [] : entries(input.unanswered);
  if (answers === null || unanswered === null) return fail("The question response is invalid.");
  if (unanswered.length > 0 && !request.supportsUnanswered)
    return fail("This provider question does not support skipping or clearing.");
  const remaining = new Map(request.questions.map((question) => [question.id, question]));
  const answerRows: [string, string | string[]][] = [];
  const unansweredRows: [string, "skipped" | "dismissed"][] = [];
  let chars = 0;
  for (const [id, answer] of answers) {
    const question = remaining.get(id);
    if (!question) return fail("The response contains an unknown or overlapping question ID.");
    if (typeof answer === "string") {
      if (!text(answer, MAX_ANSWER_CHARS)) return fail("Each answer must contain nonempty text.");
      chars += id.length + answer.length;
      answerRows.push([id, answer]);
    } else {
      const selected = array(answer, MAX_OPTIONS);
      if (
        selected === null ||
        selected.length === 0 ||
        (!question.multiSelect && selected.length > 1) ||
        selected.some((value) => !text(value, MAX_ANSWER_CHARS)) ||
        new Set(selected).size !== selected.length
      )
        return fail("Each answer must contain a valid selection or nonempty text.");
      const strings = selected as string[];
      chars += id.length + strings.reduce((count, value) => count + value.length, 0);
      answerRows.push([id, strings]);
    }
    if (chars > MAX_ANSWER_CHARS) return fail("The question response exceeds its size limit.");
    remaining.delete(id);
  }
  for (const [id, disposition] of unanswered) {
    if (!remaining.has(id))
      return fail("The response contains an unknown or overlapping question ID.");
    if (disposition !== "skipped" && disposition !== "dismissed")
      return fail("The unanswered question action is invalid.");
    chars += id.length;
    if (chars > MAX_ANSWER_CHARS) return fail("The question response exceeds its size limit.");
    unansweredRows.push([id, disposition]);
    remaining.delete(id);
  }
  if (remaining.size > 0) return fail("Answer, skip or clear every question in this request.");
  const parsedAnswers = Object.fromEntries(answerRows);
  const parsedUnanswered = Object.fromEntries(unansweredRows);
  // Bound the actual encoded native answer too, including keys, Unicode and
  // JSON escaping; a UTF-16 character counter is not a 64 KiB transport bound.
  if (
    Buffer.byteLength(
      JSON.stringify({ answers: parsedAnswers, unanswered: parsedUnanswered }),
      "utf8",
    ) > MAX_ANSWER_CHARS
  )
    return fail("The question response exceeds its size limit.");
  return {
    ok: true,
    answers: parsedAnswers,
    // Presence itself is capability-sensitive in legacy native adapters.
    // An empty disposition map has no action and must not opt into that lane.
    ...(unansweredRows.length > 0 ? { unanswered: parsedUnanswered } : {}),
  };
}
