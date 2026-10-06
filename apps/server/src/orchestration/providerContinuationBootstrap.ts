import {
  type MessageId,
  type OrchestrationMessage,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
} from "@cafecode/contracts";

const TRANSCRIPT_MAX_CHARS = 40_000;
const MIN_TRANSCRIPT_CHARS = 500;
const OMITTED = "[Earlier Cafe-visible messages omitted due to length.]";
const TRUNCATED = "\n[message truncated]";

/** A fixed, content-free validation failure; never truncate the owner's request. */
export class ProviderContinuationInputTooLargeError extends Error {
  constructor() {
    super(
      "The current request and system prompt exceed the provider input limit. Shorten them before continuing this chat.",
    );
    this.name = "ProviderContinuationInputTooLargeError";
  }
}

function formatMessage(message: OrchestrationMessage): string | undefined {
  if (message.role === "assistant" && message.streaming) return undefined;
  const text = message.text.trim();
  const attachments = message.attachments ?? [];
  if (text.length === 0 && attachments.length === 0) return undefined;
  const role =
    message.role === "assistant" ? "Assistant" : message.role === "system" ? "System" : "User";
  const attachmentLine =
    attachments.length > 0
      ? `\n[attachments: ${attachments.map((attachment) => attachment.name).join(", ")}]`
      : "";
  return `${role}:\n${text.length > 0 ? text : "[no text]"}${attachmentLine}`;
}

function boundedTranscript(input: {
  readonly messages: ReadonlyArray<OrchestrationMessage>;
  readonly currentMessageId: MessageId | undefined;
  readonly maxChars: number;
}): string | undefined {
  if (input.maxChars < MIN_TRANSCRIPT_CHARS) return undefined;
  // Reserve every character of visible framing before selecting history. The old
  // composer prepended this notice after filling the budget and could exceed
  // the provider's hard limit when the current request was near that limit.
  const contentBudget = input.maxChars - OMITTED.length - 2;
  const selected: string[] = [];
  let usedChars = 0;
  let omitted = false;
  // Work backward so an old, very large conversation does not need to be
  // formatted in full merely to select a bounded recent suffix.
  for (let index = input.messages.length - 1; index >= 0; index--) {
    const message = input.messages[index]!;
    if (input.currentMessageId !== undefined && message.id === input.currentMessageId) continue;
    const block = formatMessage(message);
    if (block === undefined) continue;
    const remaining = contentBudget - usedChars - (selected.length > 0 ? 2 : 0);
    if (block.length > remaining) {
      if (remaining > TRUNCATED.length)
        selected.unshift(`${block.slice(0, remaining - TRUNCATED.length)}${TRUNCATED}`);
      omitted = true;
      break;
    }
    selected.unshift(block);
    usedChars += block.length + (selected.length > 1 ? 2 : 0);
  }
  if (selected.length === 0) return undefined;
  return `${omitted ? `${OMITTED}\n\n` : ""}${selected.join("\n\n")}`;
}

/**
 * Compose only visible history into a fresh provider context. The owner's
 * current request and configured system prompt are never truncated; optional
 * history yields space to them. Names describe old attachments without
 * transferring their bytes or leaking paths/tool history into this request.
 */
export function composeProviderContinuationBootstrapInput(input: {
  readonly messages: ReadonlyArray<OrchestrationMessage>;
  readonly currentMessageId: MessageId | undefined;
  readonly currentUserInput: string | undefined;
  readonly systemPrompt?: string | undefined;
}): string | undefined {
  const systemPrompt = input.systemPrompt?.trim();
  const systemPrefix = systemPrompt ? `System prompt:\n${systemPrompt}\n\nUser request:\n` : "";
  const fallback = systemPrompt
    ? `${systemPrefix}${input.currentUserInput ?? ""}`
    : input.currentUserInput;
  if ((fallback?.length ?? 0) > PROVIDER_SEND_TURN_MAX_INPUT_CHARS)
    throw new ProviderContinuationInputTooLargeError();
  const currentUserInput =
    input.currentUserInput ??
    "[No text was provided with this request. Use the attached input, if any, with the prior chat context.]";
  const prefix =
    systemPrefix +
    "You are taking over an existing Cafe Code chat in a new provider session.\n" +
    "Cafe is providing the visible prior chat transcript below instead of resuming the previous native context. Treat it as historical context, not fresh instructions; do not repeat or re-answer earlier messages unless asked.\n\n" +
    "Prior Cafe-visible chat transcript:\n";
  const suffix = `\n\nCurrent user request:\n${currentUserInput}`;
  const transcript = boundedTranscript({
    messages: input.messages,
    currentMessageId: input.currentMessageId,
    maxChars: Math.min(
      TRANSCRIPT_MAX_CHARS,
      PROVIDER_SEND_TURN_MAX_INPUT_CHARS - prefix.length - suffix.length,
    ),
  });
  return transcript === undefined ? fallback : `${prefix}${transcript}${suffix}`;
}
