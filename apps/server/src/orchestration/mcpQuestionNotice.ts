import {
  EventId,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  type MessageId,
  type OrchestrationThreadActivity,
  type ProviderUserInputAnswers,
  type ProviderUserInputUnanswered,
  type UserInputQuestion,
} from "@cafecode/contracts";
import * as Schema from "effect/Schema";

export type McpQuestionResolutionAction = "answered" | "skipped" | "cleared";

export interface McpResolvedQuestion {
  readonly id: string;
  readonly header: string;
  readonly question: string;
}

export type McpQuestionResolutionItem =
  | {
      readonly question: McpResolvedQuestion;
      readonly answer: string | readonly string[];
      readonly disposition?: never;
    }
  | {
      readonly question: McpResolvedQuestion;
      readonly answer?: never;
      readonly disposition: "skipped" | "dismissed";
    };

const MAX_ITEMS = 64;
const MAX_TEXT_LENGTH = 65_536;
const MAX_PAYLOAD_BYTES = 1_048_576;
const encodeJson = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);

function invalid(): never {
  // Callback, saved activity and command contents must never become errors.
  throw new Error("Invalid or oversized MCP question resolution details.");
}

/** Copy only bounded own data. Accessors and sparse/proxy failures refuse the
 * receipt instead of executing arbitrary properties during durable writing. */
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid();
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.length > MAX_ITEMS) return invalid();
    const entries: Array<[string, unknown]> = [];
    for (const key of keys) {
      if (typeof key !== "string") return invalid();
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor)) return invalid();
      entries.push([key, descriptor.value]);
    }
    return Object.fromEntries(entries);
  } catch {
    return invalid();
  }
}

function array(value: unknown, limit: number): readonly unknown[] {
  if (!Array.isArray(value)) return invalid();
  try {
    const length = Object.getOwnPropertyDescriptor(value, "length");
    if (
      !length ||
      !("value" in length) ||
      !Number.isSafeInteger(length.value) ||
      length.value < 0 ||
      length.value > limit
    )
      return invalid();
    const result: unknown[] = [];
    for (let index = 0; index < length.value; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor)) return invalid();
      result.push(descriptor.value);
    }
    return result;
  } catch {
    return invalid();
  }
}

function text(value: unknown, limit: number, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > limit || (!allowEmpty && !value.trim()))
    return invalid();
  return value;
}

function resolvedQuestion(value: unknown): McpResolvedQuestion {
  const question = record(value);
  return {
    id: text(question.id, 16_384),
    // Async questions have no provider header. An empty header preserves that
    // absence instead of manufacturing provider-authored wording.
    header: text(question.header, MAX_TEXT_LENGTH, true),
    question: text(question.question, MAX_TEXT_LENGTH),
  };
}

function answer(value: unknown): string | readonly string[] {
  // Native complete responses have already passed the stricter 64 KiB map
  // validator. Inline answers retain the normal composer text budget; the
  // shared encoded receipt budget below remains a separate aggregate guard.
  if (typeof value === "string") return text(value, PROVIDER_SEND_TURN_MAX_INPUT_CHARS);
  const values = array(value, MAX_ITEMS);
  if (values.length === 0) return invalid();
  return values.map((entry) => text(entry, PROVIDER_SEND_TURN_MAX_INPUT_CHARS));
}

/** Join the already validated complete response with its exact saved native
 * questionnaire. The same join is checked before intent publication and used
 * after native settlement: receipt construction cannot newly fail after a
 * callback has been consumed. Each actual action gets its own truthful group. */
export function makeNativeMcpQuestionResolutionItems(input: {
  readonly questions: readonly UserInputQuestion[];
  readonly answers: ProviderUserInputAnswers;
  readonly unanswered?: ProviderUserInputUnanswered;
  readonly action: McpQuestionResolutionAction;
}): readonly McpQuestionResolutionItem[] {
  if (input.action !== "answered" && input.action !== "skipped" && input.action !== "cleared")
    return invalid();
  const questions = array(input.questions, MAX_ITEMS);
  if (questions.length === 0) return invalid();
  const answers = record(input.answers);
  const unanswered = input.unanswered === undefined ? {} : record(input.unanswered);
  const answerKeys = new Set(Object.keys(answers));
  const unansweredKeys = new Set(Object.keys(unanswered));
  const seen = new Set<string>();
  const items: McpQuestionResolutionItem[] = [];
  for (const rawQuestion of questions) {
    const question = resolvedQuestion(rawQuestion);
    if (seen.has(question.id)) return invalid();
    seen.add(question.id);
    const hasAnswer = answerKeys.has(question.id);
    const hasDisposition = unansweredKeys.has(question.id);
    if (hasAnswer === hasDisposition) return invalid();
    if (hasAnswer) {
      const value = answer(answers[question.id]);
      answerKeys.delete(question.id);
      if (input.action === "answered") items.push({ question, answer: value });
    } else {
      const disposition = unanswered[question.id];
      if (disposition !== "skipped" && disposition !== "dismissed") return invalid();
      unansweredKeys.delete(question.id);
      if (
        (input.action === "skipped" && disposition === "skipped") ||
        (input.action === "cleared" && disposition === "dismissed")
      )
        items.push({ question, disposition });
    }
  }
  if (answerKeys.size !== 0 || unansweredKeys.size !== 0) return invalid();
  return items;
}

/** Construct bounded presentation data, not a model message or instruction.
 * The complete encoded payload is checked before any question is consumed;
 * actionable text is never silently truncated to satisfy its storage budget. */
export function makeMcpQuestionResolutionActivity(input: {
  readonly noticeMessageId: MessageId;
  readonly action: McpQuestionResolutionAction;
  readonly items: readonly McpQuestionResolutionItem[];
  readonly createdAt: string;
}): OrchestrationThreadActivity {
  if (input.action !== "answered" && input.action !== "skipped" && input.action !== "cleared")
    return invalid();
  const rawItems = array(input.items, MAX_ITEMS);
  if (rawItems.length === 0) return invalid();
  const seen = new Set<string>();
  const items = rawItems.map((raw): McpQuestionResolutionItem => {
    const item = record(raw);
    const question = resolvedQuestion(item.question);
    if (seen.has(question.id)) return invalid();
    seen.add(question.id);
    const hasAnswer = Object.hasOwn(item, "answer");
    const hasDisposition = Object.hasOwn(item, "disposition");
    if (hasAnswer === hasDisposition) return invalid();
    if (hasAnswer) {
      if (input.action !== "answered") return invalid();
      return { question, answer: answer(item.answer) };
    }
    if (
      (input.action === "skipped" && item.disposition !== "skipped") ||
      (input.action === "cleared" && item.disposition !== "dismissed") ||
      input.action === "answered"
    )
      return invalid();
    return { question, disposition: input.action === "skipped" ? "skipped" : "dismissed" };
  });
  const payload = {
    version: 2,
    source: "mcp",
    action: input.action,
    questionCount: items.length,
    items,
  };
  if (Buffer.byteLength(encodeJson(payload), "utf8") > MAX_PAYLOAD_BYTES) return invalid();
  return {
    id: EventId.make(`mcp-question-resolution:${input.noticeMessageId}:${input.action}`),
    turnId: null,
    tone: "info",
    kind: "mcp.question.resolved",
    summary: "Question resolved via MCP",
    payload,
    createdAt: input.createdAt,
  };
}
