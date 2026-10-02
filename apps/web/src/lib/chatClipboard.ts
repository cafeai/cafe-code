import type { ProviderDriverKind } from "@cafecode/contracts";
import type { ChatCopyFormat } from "@cafecode/contracts/settings";
import { normalizeChatMarkdownMath } from "./chatMarkdownMath";
import { normalizeAroundMermaidFences } from "./chatMarkdownMermaid";
import { normalizeCodexCitationMarkers } from "./codexCitations";

export function prepareChatMessageMarkdownCopyText(
  text: string,
  options: { provider: ProviderDriverKind | null },
): string {
  // Whole-message copy shares the diagram source boundary with rendering and
  // the diagram's own Copy action. Literal TeX/citation-shaped Mermaid labels
  // must survive copying, including inside list and blockquote containers.
  return normalizeAroundMermaidFences(text, (source) => {
    const providerNormalized =
      options.provider === "codex"
        ? normalizeCodexCitationMarkers(source, { mode: "strip" })
        : source;

    return normalizeChatMarkdownMath(providerNormalized);
  });
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
