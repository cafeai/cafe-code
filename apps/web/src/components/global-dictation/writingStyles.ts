import { uiText } from "@cafecode/shared/i18n";
/**
 * Local dictation styles are intentionally mechanical. Realtime transcription
 * hints are not exact formatting controls, while a text-model rewrite crosses
 * a separate privacy and cost boundary. Keep the local transforms predictable
 * and always apply them to an immutable source transcript in the review UI.
 */
import { DICTATION_REWRITE_INSTRUCTIONS_MAX_CHARS } from "@cafecode/contracts";

export type LocalWritingStyle =
  | "as-transcribed"
  | "lowercase"
  | "no-punctuation"
  | "lowercase-no-punctuation";

export type WritingStyle = LocalWritingStyle | "formal" | "custom";

export const writingStyleLabels: Readonly<Record<WritingStyle, string>> = {
  get "as-transcribed"() {
    return uiText("As transcribed");
  },
  get lowercase() {
    return uiText("lowercase");
  },
  get "no-punctuation"() {
    return uiText("no punctuation");
  },
  get "lowercase-no-punctuation"() {
    return uiText("lowercase + no punctuation");
  },
  get formal() {
    return uiText("Formal");
  },
  get custom() {
    return uiText("Custom");
  },
};

export function applyLocalWritingStyle(source: string, style: LocalWritingStyle): string {
  switch (style) {
    case "as-transcribed":
      return source;
    case "lowercase":
      return source.toLowerCase();
    case "no-punctuation":
      // Deliberately preserve the remaining whitespace and casing. Removing
      // punctuation can damage URLs, decimals, contractions, or source code;
      // the user must see and approve the resulting draft before insertion.
      return source.replace(/\p{P}/gu, "");
    case "lowercase-no-punctuation":
      return source.toLowerCase().replace(/\p{P}/gu, "");
  }
}

/** Only finalized audio from an explicitly armed command recording may call this. */
export type OneShotVoiceCommand =
  | { readonly type: "style"; readonly style: Exclude<WritingStyle, "custom"> }
  | { readonly type: "custom-style"; readonly instructions: string }
  | { readonly type: "cancel-command" };

export function parseOneShotVoiceCommand(transcript: string): OneShotVoiceCommand | null {
  // Only the finite built-in phrases can apply a style immediately. A custom
  // suffix is inert text for a separately reviewed input: parsing it never
  // authorizes an API request or an external clipboard/field action.
  if (transcript.length > DICTATION_REWRITE_INSTRUCTIONS_MAX_CHARS + 32) return null;
  const phrase = transcript
    .trim()
    .toLowerCase()
    .replace(/[.!?。！？]$/u, "")
    .trim()
    .replace(/\s+/gu, " ");

  switch (phrase) {
    case "style as transcribed":
      return { type: "style", style: "as-transcribed" };
    case "style lowercase":
      return { type: "style", style: "lowercase" };
    case "style no punctuation":
      return { type: "style", style: "no-punctuation" };
    case "style lowercase no punctuation":
    case "style lowercase and no punctuation":
      return { type: "style", style: "lowercase-no-punctuation" };
    case "style formal":
      return { type: "style", style: "formal" };
    case "cancel command":
      return { type: "cancel-command" };
  }

  const candidate = /^style\s+([\s\S]+)$/iu.exec(transcript.trim())?.[1]?.trim();
  if (
    !candidate ||
    candidate.length > DICTATION_REWRITE_INSTRUCTIONS_MAX_CHARS ||
    /\p{Cc}/u.test(candidate.replace(/[\t\r\n]/gu, "")) ||
    /^(?:insert|paste|copy|save|reset|submit|send|cancel)\b/iu.test(candidate) ||
    /(?:\b(?:and|then)\s+|[.!?;]\s*)(?:insert|paste|copy|save|reset|submit|send)\b/iu.test(
      candidate,
    )
  ) {
    return null;
  }
  // Preserve spelling, punctuation and Unicode exactly for user review. The
  // normalized phrase above is only for matching the built-in grammar.
  return { type: "custom-style", instructions: candidate };
}
