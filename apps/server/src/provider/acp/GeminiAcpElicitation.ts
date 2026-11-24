// Native opaque-object boundary: reject proxies before reflective inspection.
import { types } from "node:util";

import {
  USER_INPUT_UNANSWERED_MAX_KEY_CHARS,
  USER_INPUT_UNANSWERED_MAX_QUESTIONS,
  USER_INPUT_UNANSWERED_MAX_TOTAL_CHARS,
  type ProviderUserInputAnswers,
  type ProviderUserInputUnanswered,
  type UserInputQuestion,
} from "@cafecode/contracts";
import * as Schema from "effect/Schema";
import * as AcpSchema from "effect-acp/schema";

const MAX_PROPERTIES = 32;
const MAX_QUESTIONS = 16;
const MAX_OPTIONS = 32;
const MAX_ID_CHARS = 128;
const MAX_QUESTION_CHARS = 8_192;
const MAX_OPTION_CHARS = 2_048;
const MAX_ANSWER_CHARS = 8_192;
const MAX_MULTI_ANSWERS = 64;

/**
 * Antigravity CLI sends ACP form elicitation on `elicitation/create` with an
 * optional `toolCallId` tying the prompt to the active `ask_question` call.
 * Extending the standard form schema keeps both `elicitation/create` and
 * standard `session/elicitation` compatible with one parser.
 */
export const GeminiElicitationRequest = Schema.Union([
  Schema.Struct({
    mode: Schema.Literal("form"),
    sessionId: Schema.String,
    message: Schema.String,
    toolCallId: Schema.optionalKey(Schema.NullOr(Schema.String)),
    requestedSchema: Schema.Struct({
      type: Schema.optionalKey(Schema.Literal("object")),
      title: Schema.optionalKey(Schema.NullOr(Schema.String)),
      description: Schema.optionalKey(Schema.NullOr(Schema.String)),
      properties: Schema.optionalKey(
        Schema.Record(Schema.String, AcpSchema.ElicitationPropertySchema),
      ),
      required: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
    }),
    _meta: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown))),
  }),
  Schema.Struct({
    mode: Schema.Literal("url"),
    sessionId: Schema.String,
    message: Schema.String,
    elicitationId: Schema.String,
    url: Schema.String,
    _meta: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown))),
  }),
]);
export type GeminiElicitationRequest = typeof GeminiElicitationRequest.Type;

export interface GeminiElicitationOption {
  readonly value: string;
  readonly label: string;
}

export interface GeminiElicitationField {
  readonly id: string;
  readonly otherFieldId: string | undefined;
  readonly multiSelect: boolean;
  readonly required: boolean;
  readonly minItems: number | undefined;
  readonly maxItems: number | undefined;
  readonly options: ReadonlyArray<GeminiElicitationOption>;
}

export interface GeminiElicitationPlan {
  readonly questions: ReadonlyArray<UserInputQuestion>;
  readonly fields: ReadonlyArray<GeminiElicitationField>;
  readonly supportsUnanswered: boolean;
}

export interface GeminiElicitationResolved {
  readonly response: AcpSchema.ElicitationAction;
  readonly answers: ProviderUserInputAnswers;
  readonly unanswered: ProviderUserInputUnanswered | undefined;
}

function extractOptions(
  property: AcpSchema.ElicitationPropertySchema,
): ReadonlyArray<GeminiElicitationOption> | undefined {
  let raw: ReadonlyArray<GeminiElicitationOption> | undefined;
  if (property.type === "string") {
    if (property.oneOf && property.oneOf.length > 0) {
      raw = property.oneOf.map((option) => ({
        value: option.const,
        label: option.title.trim() || option.const.trim(),
      }));
    } else if (property.enum && property.enum.length > 0) {
      raw = property.enum.map((value) => ({ value, label: value.trim() }));
    }
  } else if (property.type === "array") {
    if ("anyOf" in property.items && property.items.anyOf.length > 0) {
      raw = property.items.anyOf.map((option) => ({
        value: option.const,
        label: option.title.trim() || option.const.trim(),
      }));
    } else if ("enum" in property.items && property.items.enum.length > 0) {
      raw = property.items.enum.map((value) => ({ value, label: value.trim() }));
    }
  }
  if (!raw || raw.length === 0 || raw.length > MAX_OPTIONS) return undefined;
  const seenValues = new Set<string>();
  const seenLabels = new Set<string>();
  for (const option of raw) {
    if (
      option.value.trim().length === 0 ||
      option.value.length > MAX_OPTION_CHARS ||
      option.label.length === 0 ||
      option.label.length > MAX_OPTION_CHARS ||
      seenValues.has(option.value) ||
      seenLabels.has(option.label)
    ) {
      return undefined;
    }
    seenValues.add(option.value);
    seenLabels.add(option.label);
  }
  return raw;
}

function isCompanionOtherField(property: AcpSchema.ElicitationPropertySchema | undefined): boolean {
  return (
    property !== undefined &&
    property.type === "string" &&
    (property.oneOf == null || property.oneOf.length === 0) &&
    (property.enum == null || property.enum.length === 0)
  );
}

/**
 * Parses an ACP form elicitation request into Cafe Code's structured user-input
 * questions. Companion `<id>_other` free-text string properties emitted by
 * Antigravity CLI are folded into their parent question so Cafe's built-in
 * free-text input writes directly to `<id>_other`.
 */
export function parseGeminiElicitation(
  request: GeminiElicitationRequest | AcpSchema.ElicitationRequest,
): GeminiElicitationPlan | undefined {
  if (request.mode !== "form") return undefined;
  const properties = request.requestedSchema.properties;
  if (!properties) return undefined;
  const entries = Object.entries(properties);
  if (entries.length === 0 || entries.length > MAX_PROPERTIES) return undefined;

  const propertyMap = new Map(entries);
  const consumedOtherIds = new Set<string>();
  for (const [id, property] of entries) {
    const otherId = `${id}_other`;
    if (extractOptions(property) && isCompanionOtherField(propertyMap.get(otherId))) {
      consumedOtherIds.add(otherId);
    }
  }

  const requiredSet = new Set(request.requestedSchema.required ?? []);
  const questions: UserInputQuestion[] = [];
  const fields: GeminiElicitationField[] = [];
  let keyCharTotal = 0;

  for (const [id, property] of entries) {
    if (consumedOtherIds.has(id)) continue;
    const trimmedId = id.trim();
    if (trimmedId.length === 0 || trimmedId !== id || id.length > MAX_ID_CHARS) return undefined;
    if (property.type !== "string" && property.type !== "array") return undefined;

    const options = extractOptions(property);
    if (!options) return undefined;

    const questionText = (
      property.title?.trim() ||
      property.description?.trim() ||
      request.message.trim()
    ).trim();
    if (questionText.length === 0 || questionText.length > MAX_QUESTION_CHARS) return undefined;

    const otherId = `${id}_other`;
    const otherFieldId = consumedOtherIds.has(otherId) ? otherId : undefined;
    const required =
      requiredSet.has(id) || (otherFieldId !== undefined && requiredSet.has(otherId));

    questions.push({
      id,
      header: "Question",
      question: questionText,
      multiSelect: property.type === "array",
      options: options.map(({ label }) => ({ label, description: label })),
    });
    fields.push({
      id,
      otherFieldId,
      multiSelect: property.type === "array",
      required,
      minItems: property.type === "array" ? (property.minItems ?? undefined) : undefined,
      maxItems: property.type === "array" ? (property.maxItems ?? undefined) : undefined,
      options,
    });
    keyCharTotal += id.length;
  }

  if (questions.length === 0 || questions.length > MAX_QUESTIONS) return undefined;

  const supportsUnanswered =
    fields.every(
      (field) => !field.required && field.id.length <= USER_INPUT_UNANSWERED_MAX_KEY_CHARS,
    ) &&
    fields.length <= USER_INPUT_UNANSWERED_MAX_QUESTIONS &&
    keyCharTotal <= USER_INPUT_UNANSWERED_MAX_TOTAL_CHARS;

  return { questions, fields, supportsUnanswered };
}

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

function readAnswerValues(answer: unknown): ReadonlyArray<string> | undefined {
  if (typeof answer === "string") {
    const trimmed = answer.trim();
    return trimmed.length > 0 && answer.length <= MAX_ANSWER_CHARS ? [trimmed] : undefined;
  }
  let list: unknown = answer;
  if (
    answer !== null &&
    typeof answer === "object" &&
    !types.isProxy(answer) &&
    !Array.isArray(answer)
  ) {
    const entries = ownEntries(answer);
    if (!entries || entries.length !== 1 || entries[0]?.[0] !== "answers") return undefined;
    list = entries[0][1];
  }
  if (
    types.isProxy(list) ||
    !Array.isArray(list) ||
    list.length === 0 ||
    list.length > MAX_MULTI_ANSWERS ||
    Object.getPrototypeOf(list) !== Array.prototype ||
    Reflect.ownKeys(list).length !== list.length + 1
  ) {
    return undefined;
  }
  const values: string[] = [];
  for (let index = 0; index < list.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(list, index);
    const entry =
      descriptor && descriptor.enumerable && "value" in descriptor ? descriptor.value : undefined;
    if (typeof entry !== "string" || entry.trim().length === 0 || entry.length > MAX_ANSWER_CHARS) {
      return undefined;
    }
    values.push(entry.trim());
  }
  return values;
}

/**
 * Validates a Cafe user-input submission against the exact pending Gemini
 * elicitation schema and translates it into the ACP ElicitationResponse wire
 * payload. Omitted questions are skipped by Antigravity CLI; declining when
 * every question is unanswered avoids sending an empty accepted form.
 */
export function buildGeminiElicitationResponse(
  plan: GeminiElicitationPlan,
  answers: unknown,
  unanswered?: unknown,
): GeminiElicitationResolved | undefined {
  try {
    return buildResponse(plan, answers, unanswered);
  } catch {
    return undefined;
  }
}

function buildResponse(
  plan: GeminiElicitationPlan,
  answers: unknown,
  unanswered?: unknown,
): GeminiElicitationResolved | undefined {
  const answerEntries = ownEntries(answers);
  if (!answerEntries) return undefined;

  let unansweredEntries: Array<readonly [string, unknown]> = [];
  if (unanswered !== undefined) {
    if (!plan.supportsUnanswered) return undefined;
    const parsed = ownEntries(unanswered);
    if (!parsed) return undefined;
    unansweredEntries = parsed;
  }

  const fieldById = new Map(plan.fields.map((field) => [field.id, field]));
  const answerMap = new Map<string, ReadonlyArray<string>>();
  const canonicalAnswers: Array<readonly [string, string | string[]]> = [];
  let totalChars = 0;

  for (const [id, rawAnswer] of answerEntries) {
    if (!fieldById.has(id)) return undefined;
    const values = readAnswerValues(rawAnswer);
    if (!values) return undefined;
    for (const value of values) {
      totalChars += value.length;
      if (totalChars > USER_INPUT_UNANSWERED_MAX_TOTAL_CHARS) return undefined;
    }
    answerMap.set(id, values);
    canonicalAnswers.push([id, typeof rawAnswer === "string" ? values[0]! : [...values]]);
  }

  const canonicalUnanswered: Array<readonly [string, "skipped" | "dismissed"]> = [];
  const unansweredIds = new Set<string>();
  for (const [id, disposition] of unansweredEntries) {
    if (
      !fieldById.has(id) ||
      answerMap.has(id) ||
      (disposition !== "skipped" && disposition !== "dismissed")
    ) {
      return undefined;
    }
    unansweredIds.add(id);
    canonicalUnanswered.push([id, disposition]);
  }

  if (answerMap.size + unansweredIds.size !== plan.fields.length) return undefined;

  const contentEntries: Array<readonly [string, string | string[]]> = [];
  for (const field of plan.fields) {
    const values = answerMap.get(field.id);
    if (!values) continue;

    const optionByLabel = new Map(field.options.map((option) => [option.label, option.value]));
    const optionByValue = new Map(field.options.map((option) => [option.value, option.value]));
    const matchedValues: string[] = [];
    const customValues: string[] = [];

    for (const value of values) {
      const matched = optionByLabel.get(value) ?? optionByValue.get(value);
      if (matched !== undefined) {
        if (!matchedValues.includes(matched)) matchedValues.push(matched);
      } else {
        customValues.push(value);
      }
    }

    if (!field.multiSelect) {
      if (values.length !== 1) return undefined;
      if (matchedValues.length === 1) {
        contentEntries.push([field.id, matchedValues[0]!]);
      } else if (field.otherFieldId && customValues.length === 1) {
        contentEntries.push([field.otherFieldId, customValues[0]!]);
      } else {
        return undefined;
      }
      continue;
    }

    if (customValues.length > 0 && !field.otherFieldId) return undefined;
    if (matchedValues.length > 0) {
      if (
        (field.minItems !== undefined && matchedValues.length < field.minItems) ||
        (field.maxItems !== undefined && matchedValues.length > field.maxItems)
      ) {
        return undefined;
      }
      contentEntries.push([field.id, matchedValues]);
    }
    if (customValues.length > 0 && field.otherFieldId) {
      contentEntries.push([field.otherFieldId, customValues.join("\n")]);
    }
    if (matchedValues.length === 0 && customValues.length === 0) return undefined;
  }

  const response: AcpSchema.ElicitationAction =
    contentEntries.length === 0
      ? { action: "decline" }
      : { action: "accept", content: Object.fromEntries(contentEntries) };

  return {
    response,
    answers: Object.fromEntries(canonicalAnswers),
    unanswered:
      canonicalUnanswered.length > 0 ? Object.fromEntries(canonicalUnanswered) : undefined,
  };
}
