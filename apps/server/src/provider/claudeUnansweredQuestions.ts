// Native opaque-object boundary: Effect has no proxy-identification primitive;
// reject proxies before any reflective operation can execute an attacker trap.
import { types } from "node:util";
import {
  USER_INPUT_UNANSWERED_MAX_KEY_CHARS,
  USER_INPUT_UNANSWERED_MAX_QUESTIONS,
  USER_INPUT_UNANSWERED_MAX_TOTAL_CHARS,
  type ProviderUserInputAnswers,
  type ProviderUserInputUnanswered,
  type UserInputQuestion,
} from "@cafecode/contracts";

export const CLAUDE_UNANSWERED_QUESTION_CAPABILITY = "ask_user_question_unanswered_v1";

/** Inspect only own data fields. A callback invoked in process must obey the
 * same finite JSON-shaped boundary as a response delivered over transport;
 * accessors and inherited answers must never resolve an outstanding question. */
function ownEntries(value: unknown): Array<readonly [string, unknown]> | undefined {
  if (value === null || typeof value !== "object" || types.isProxy(value) || Array.isArray(value))
    return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const keys = Reflect.ownKeys(value);
  if (keys.length > USER_INPUT_UNANSWERED_MAX_QUESTIONS) return undefined;
  const result: Array<readonly [string, unknown]> = [];
  for (const key of keys) {
    if (typeof key !== "string") return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return undefined;
    result.push([key, descriptor.value]);
  }
  return result;
}

/** Native questions use the full question text as the exact answer key.
 * Ambiguous duplicate or oversized input keeps the existing answers-only UX;
 * it cannot mint an annotation capability for a different/native question. */
export function supportsClaudeUnansweredQuestions(questions: ReadonlyArray<UserInputQuestion>) {
  if (questions.length === 0 || questions.length > USER_INPUT_UNANSWERED_MAX_QUESTIONS)
    return false;
  const ids = new Set<string>();
  let total = 0;
  for (const question of questions) {
    if (
      question.id.length === 0 ||
      question.id !== question.question ||
      question.id.length > USER_INPUT_UNANSWERED_MAX_KEY_CHARS ||
      ids.has(question.id)
    )
      return false;
    ids.add(question.id);
    total += question.id.length;
    if (total > USER_INPUT_UNANSWERED_MAX_TOTAL_CHARS) return false;
  }
  return true;
}

export interface ClaudeUnansweredQuestionResponse {
  readonly answers: ProviderUserInputAnswers;
  readonly unanswered: ProviderUserInputUnanswered;
  readonly annotations: Record<string, { readonly unanswered: "skipped" | "dismissed" }>;
}

/** This validates a response, not native authority. Callers must separately
 * bind the exact pending request, query, native session and init capability.
 * Every pending question must have exactly one real answer or explicit
 * disposition. Metadata never fabricates text for the model to consume. */
export function prepareClaudeUnansweredQuestionResponse(
  questions: ReadonlyArray<UserInputQuestion>,
  answers: unknown,
  unanswered: unknown,
): ClaudeUnansweredQuestionResponse | undefined {
  try {
    return prepareResponse(questions, answers, unanswered);
  } catch {
    // A hostile in-process value may throw from a proxy trap. Transport JSON
    // cannot contain one, but it must not turn validation into callback loss.
    return undefined;
  }
}

function prepareResponse(
  questions: ReadonlyArray<UserInputQuestion>,
  answers: unknown,
  unanswered: unknown,
): ClaudeUnansweredQuestionResponse | undefined {
  if (!supportsClaudeUnansweredQuestions(questions)) return undefined;
  const answerEntries = ownEntries(answers);
  const unansweredEntries = ownEntries(unanswered);
  if (!answerEntries || !unansweredEntries) return undefined;
  const pending = new Set(questions.map((question) => question.id));
  const answered = new Set<string>();
  let total = 0;
  const canonicalAnswers: Array<readonly [string, string | string[]]> = [];
  for (const [id, answer] of answerEntries) {
    if (!pending.has(id)) return undefined;
    const values = typeof answer === "string" ? [answer] : answer;
    if (
      types.isProxy(values) ||
      !Array.isArray(values) ||
      values.length === 0 ||
      values.length > 64
    )
      return undefined;
    // Only dense ordinary own-data arrays are JSON answer lists. Extra symbols,
    // inherited indices and accessor elements are not silently stripped.
    if (
      Object.getPrototypeOf(values) !== Array.prototype ||
      Reflect.ownKeys(values).length !== values.length + 1
    )
      return undefined;
    const canonical: string[] = [];
    for (let index = 0; index < values.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(values, index);
      const value =
        descriptor && descriptor.enumerable && "value" in descriptor ? descriptor.value : undefined;
      if (typeof value !== "string" || value.trim().length === 0) return undefined;
      total += value.length;
      if (total > USER_INPUT_UNANSWERED_MAX_TOTAL_CHARS) return undefined;
      canonical.push(value);
    }
    total += id.length;
    answered.add(id);
    canonicalAnswers.push([id, typeof answer === "string" ? canonical[0]! : canonical]);
  }
  const canonicalUnanswered: Array<readonly [string, "skipped" | "dismissed"]> = [];
  for (const [id, disposition] of unansweredEntries) {
    if (
      !pending.has(id) ||
      answered.has(id) ||
      (disposition !== "skipped" && disposition !== "dismissed")
    )
      return undefined;
    total += id.length;
    answered.add(id);
    canonicalUnanswered.push([id, disposition]);
  }
  if (answered.size !== pending.size || total > USER_INPUT_UNANSWERED_MAX_TOTAL_CHARS)
    return undefined;
  // fromEntries defines own properties even for a question literally named
  // __proto__; assignment into {} would turn that text into prototype mutation.
  return {
    answers: Object.fromEntries(canonicalAnswers),
    unanswered: Object.fromEntries(canonicalUnanswered),
    annotations: Object.fromEntries(
      canonicalUnanswered.map(([id, disposition]) => [id, { unanswered: disposition }]),
    ),
  };
}
