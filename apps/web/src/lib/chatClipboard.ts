import type { ProviderDriverKind } from "@cafecode/contracts";
import type { ChatCopyFormat } from "@cafecode/contracts/settings";
import { normalizeChatMarkdownMath } from "./chatMarkdownMath";
import { normalizeCodexCitationMarkers } from "./codexCitations";

export function prepareChatMessageMarkdownCopyText(
  text: string,
  options: { provider: ProviderDriverKind | null },
): string {
  const providerNormalized =
    options.provider === "codex" ? normalizeCodexCitationMarkers(text, { mode: "strip" }) : text;

  return normalizeChatMarkdownMath(providerNormalized);
}

export function normalizeClipboardComparisonText(value: string): string {
  return value
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isWholeMessageSelection({
  selectedText,
  visibleText,
}: {
  selectedText: string;
  visibleText: string;
}): boolean {
  const normalizedSelectedText = normalizeClipboardComparisonText(selectedText);
  const normalizedVisibleText = normalizeClipboardComparisonText(visibleText);

  return normalizedSelectedText.length > 0 && normalizedSelectedText === normalizedVisibleText;
}

export function shouldUseMarkdownSelectionCopy(format: ChatCopyFormat): boolean {
  return format === "markdown";
}
