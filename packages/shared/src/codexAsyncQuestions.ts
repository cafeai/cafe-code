import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from "@cafecode/contracts";

export interface CodexAsyncQuestion {
  readonly title: string;
  readonly options: ReadonlyArray<string>;
}

const MAX_QUESTIONS = 16;
const MAX_QUESTION_BYTES = 4_096;
const MAX_OPTIONS = 32;
const MAX_OPTION_BYTES = 512;
const ANSWER_QUESTION_PREFIX_BYTES = 512;

function codePointBytes(codePoint: number): number {
  return codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
}

/**
 * Provider-authored labels are displayed as text and may later frame a user's
 * answer. Reject hidden control/bidi instructions and invalid Unicode instead
 * of silently changing that wording. Newlines and tabs remain normal question
 * text; the answer formatter applies upstream's separate CR/LF flattening.
 * Check the cheap UTF-16 bound first so an oversized input is never encoded or
 * scanned in full merely to discover that it exceeds the smaller byte budget.
 */
function isBoundedQuestionText(value: unknown, maxBytes: number): value is string {
  if (typeof value !== "string" || value.length > maxBytes || value.trim().length === 0) {
    return false;
  }
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (
      (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
      (codePoint < 0x20 && codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d) ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x061c ||
      codePoint === 0x200e ||
      codePoint === 0x200f ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069)
    ) {
      return false;
    }
    bytes += codePointBytes(codePoint);
    if (bytes > maxBytes) return false;
  }
  return true;
}

/**
 * Codex 0.154.0 asynchronous assistant metadata uses `title` with optional
 * string suggestions. These are ordinary questions, never approval requests or
 * executable instructions. Keep accepted text exact and discard oversized
 * labels: truncating a displayed suggestion could conceal what the user sends.
 * Bounds apply to the first input entries, not the first valid entries, so a
 * malformed provider array cannot force an unbounded search for usable rows.
 */
export function normalizeCodexAsyncQuestions(value: unknown): ReadonlyArray<CodexAsyncQuestion> {
  if (!Array.isArray(value)) return [];
  const questions: CodexAsyncQuestion[] = [];
  for (const candidate of value.slice(0, MAX_QUESTIONS)) {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
      continue;
    }
    const row = candidate as Record<string, unknown>;
    if (!isBoundedQuestionText(row.title, MAX_QUESTION_BYTES)) continue;
    if (row.options != null && !Array.isArray(row.options)) continue;

    const options: string[] = [];
    const seen = new Set<string>();
    if (Array.isArray(row.options)) {
      for (const option of row.options.slice(0, MAX_OPTIONS)) {
        if (!isBoundedQuestionText(option, MAX_OPTION_BYTES) || seen.has(option)) continue;
        seen.add(option);
        options.push(option);
      }
    }
    questions.push({ title: row.title, options });
  }
  return questions;
}

/**
 * Match rust-v0.154.0 `context-fragments/src/answered_question.rs`: take the
 * first 512 UTF-8 bytes on a Unicode scalar boundary, replace each CR/LF with a
 * space, then prefix the submitted answer with that quoted question. This is
 * message text only; callers still submit through the normal authenticated,
 * durable user-message/steer path and must not evaluate either string.
 */
export function formatCodexAsyncQuestionAnswer(title: string, answer: string): string | null {
  if (
    !isBoundedQuestionText(title, MAX_QUESTION_BYTES) ||
    typeof answer !== "string" ||
    answer.length > PROVIDER_SEND_TURN_MAX_INPUT_CHARS
  ) {
    return null;
  }
  const trimmedAnswer = answer.trim();
  if (trimmedAnswer.length === 0) return null;

  let prefix = "";
  let bytes = 0;
  for (const character of title) {
    bytes += codePointBytes(character.codePointAt(0)!);
    if (bytes > ANSWER_QUESTION_PREFIX_BYTES) break;
    prefix += character === "\r" || character === "\n" ? " " : character;
  }
  const message = `> ${prefix}\n\n${trimmedAnswer}`;
  // The shared provider schema uses string.length (UTF-16 code units), not
  // bytes or code points. Count the quote and separators too, otherwise an
  // answer at the input limit would fail only after its UI draft was cleared.
  return message.length <= PROVIDER_SEND_TURN_MAX_INPUT_CHARS ? message : null;
}
