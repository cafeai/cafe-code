export const CODEX_CITATION_START = "\uE200";
export const CODEX_CITATION_SEPARATOR = "\uE202";
export const CODEX_CITATION_END = "\uE201";

export type CodexCitationRenderMode = "display" | "strip";

const CODEX_CITATION_PREFIX = `${CODEX_CITATION_START}cite${CODEX_CITATION_SEPARATOR}`;
const CODEX_CITATION_HANDLE_REGEX = /^[A-Za-z0-9_-]{1,160}$/;

function isLikelyCodexCitationHandle(value: string): boolean {
  return CODEX_CITATION_HANDLE_REGEX.test(value);
}

/**
 * ChatGPT/Codex web-search output can contain private-use citation delimiters,
 * e.g. "\uE200cite\uE202turn4search3\uE201". Upstream Codex strips hidden citation
 * payloads before presenting assistant text. Cafe keeps the provider bytes
 * persisted for diagnostics, but normalizes them at the renderer/copy boundary
 * so private-use delimiters never show up as mojibake-looking glyphs.
 */
export function normalizeCodexCitationMarkers(
  text: string,
  options: { mode: CodexCitationRenderMode },
): string {
  if (!text.includes(CODEX_CITATION_START)) {
    return text;
  }

  const citationNumberByHandle = new Map<string, number>();
  let nextCitationNumber = 1;
  let cursor = 0;
  let output = "";

  while (cursor < text.length) {
    const startIndex = text.indexOf(CODEX_CITATION_PREFIX, cursor);
    if (startIndex === -1) {
      output += text.slice(cursor);
      break;
    }

    output += text.slice(cursor, startIndex);
    const handleStart = startIndex + CODEX_CITATION_PREFIX.length;
    const endIndex = text.indexOf(CODEX_CITATION_END, handleStart);

    if (endIndex === -1) {
      // Streaming can expose a prefix before the app-server emits the closing
      // delimiter. Treat the partial marker like upstream hidden citation text
      // and suppress it until a complete marker exists in a later render.
      break;
    }

    const handle = text.slice(handleStart, endIndex);
    if (options.mode === "display" && isLikelyCodexCitationHandle(handle)) {
      const citationNumber =
        citationNumberByHandle.get(handle) ??
        (() => {
          const value = nextCitationNumber;
          nextCitationNumber += 1;
          citationNumberByHandle.set(handle, value);
          return value;
        })();
      output += `[${citationNumber}]`;
    }

    cursor = endIndex + CODEX_CITATION_END.length;
    if (options.mode === "strip") {
      while (text[cursor] === " " && output.endsWith(" ")) {
        cursor += 1;
      }
      if (output.endsWith(" ") && cursor < text.length && /[.,;:!?)]/.test(text[cursor]!)) {
        output = output.slice(0, -1);
      }
    }
  }

  return output;
}
