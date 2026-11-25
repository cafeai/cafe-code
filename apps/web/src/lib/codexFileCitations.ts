import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

import { formatMarkdownFileCitation } from "../markdown-links";
import { remarkChatMath } from "./remarkChatMath";

const CITATION_PREFIX = /:{1,3}codex-file-citation\{/g;
const MAX_ATTRIBUTES_LENGTH = 32_768;
const ATTRIBUTE_KEY_OR_END = /[ \t]*(?:\}|([A-Za-z0-9_-]+)[ \t]*=[ \t]*)/y;
const BARE_VALUE = /[^\s"'{}]+/y;
const LITERAL_QUOTED_VALUE = /"([^"\r\n]*)"|'([^'\r\n]*)'/y;
const ESCAPED_QUOTED_VALUE = /"((?:[^"\\\r\n]|\\(?!")|\\")*)"|'((?:[^'\\\r\n]|\\(?!')|\\')*)'/y;

const sourceParser = unified().use(remarkParse).use(remarkGfm).use(remarkChatMath).freeze();
const LITERAL_NODE_TYPES = new Set([
  "code",
  "inlineCode",
  "math",
  "inlineMath",
  "html",
  "link",
  "linkReference",
  "image",
  "imageReference",
  "definition",
]);

function parseCitationAttributes(source: string, escapeQuotes: boolean) {
  const keys = new Set<string>();
  let path: string | undefined;
  let offset = 0;

  while (offset < source.length) {
    ATTRIBUTE_KEY_OR_END.lastIndex = offset;
    const attribute = ATTRIBUTE_KEY_OR_END.exec(source);
    if (!attribute) return null;
    const key = attribute[1];
    if (key === undefined) {
      return path ? { path, length: ATTRIBUTE_KEY_OR_END.lastIndex } : null;
    }
    if (keys.has(key)) return null;
    keys.add(key);

    const start = ATTRIBUTE_KEY_OR_END.lastIndex;
    const delimiter = source[start];
    const quoted = delimiter === '"' || delimiter === "'";
    const pattern = quoted
      ? escapeQuotes
        ? ESCAPED_QUOTED_VALUE
        : LITERAL_QUOTED_VALUE
      : BARE_VALUE;
    pattern.lastIndex = start;
    const match = pattern.exec(source);
    if (!match) return null;
    offset = pattern.lastIndex;
    if (source[offset] !== "}" && source[offset] !== " " && source[offset] !== "\t") return null;

    if (key === "path") {
      const value = quoted ? (match[1] ?? match[2] ?? "") : match[0];
      path = quoted && escapeQuotes ? value.replaceAll(`\\${delimiter}`, delimiter) : value;
    }
  }

  return null;
}

function literalSourceRanges(source: string): Array<{ start: number; end: number }> {
  const root = sourceParser.parse(source);
  const pending: Array<typeof root | (typeof root.children)[number]> = [root];
  const ranges: Array<{ start: number; end: number }> = [];

  while (pending.length > 0) {
    const node = pending.pop()!;
    if (LITERAL_NODE_TYPES.has(node.type)) {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined) ranges.push({ start, end });
    } else if ("children" in node) {
      for (let index = node.children.length - 1; index >= 0; index -= 1) {
        pending.push(node.children[index]!);
      }
    }
  }

  return ranges;
}

function isEscaped(source: string, offset: number): boolean {
  let start = offset;
  while (start > 0 && source[start - 1] === "\\") start -= 1;
  return (offset - start) % 2 === 1;
}

/** Convert complete citations in assistant prose to ordinary Markdown links. */
export function normalizeCodexFileCitations(source: string, cwd?: string): string {
  if (!source.includes(":codex-file-citation{")) return source;

  // Use parser positions to keep examples and existing links literal. Read
  // the directive from original source because Markdown may interpret path
  // punctuation as emphasis, an escape, or a character reference.
  const literalRanges = literalSourceRanges(source);
  let rangeIndex = 0;
  let cursor = 0;
  const pieces: string[] = [];

  for (const match of source.matchAll(CITATION_PREFIX)) {
    const start = match.index;
    // A preceding bare bang would turn the generated link into an image.
    if (start < cursor || source[start - 1] === ":" || source[start - 1] === "!") continue;
    if (isEscaped(source, start)) continue;

    while (literalRanges[rangeIndex] && literalRanges[rangeIndex]!.end <= start) rangeIndex += 1;
    const range = literalRanges[rangeIndex];
    if (range && range.start <= start) continue;

    const attributesStart = start + match[0].length;
    const attributes = source.slice(attributesStart, attributesStart + MAX_ATTRIBUTES_LENGTH);
    // Keep raw Windows separators. Try escaped quotes only when literal
    // quoting cannot parse the complete directive.
    const citation =
      parseCitationAttributes(attributes, false) ?? parseCitationAttributes(attributes, true);
    if (!citation) continue;
    const link = formatMarkdownFileCitation(citation.path, cwd);
    if (!link) continue;

    pieces.push(source.slice(cursor, start), link);
    cursor = attributesStart + citation.length;
  }

  if (pieces.length === 0) return source;
  pieces.push(source.slice(cursor));
  return pieces.join("");
}
