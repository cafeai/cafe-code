import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

import { remarkChatMath } from "./remarkChatMath";

// Match the renderer's block grammar when locating source that must remain
// literal. The processor is immutable and reused; parsing retains no history.
const mermaidSourceParser = unified().use(remarkParse).use(remarkGfm).use(remarkChatMath).freeze();

interface SourceRange {
  start: number;
  end: number;
}

/** Keep Mermaid DSL and its Markdown container syntax outside display normalization. */
export function normalizeAroundMermaidFences(
  source: string,
  normalize: (text: string) => string,
): string {
  // Most streamed messages have no diagrams. Do not add another parse to
  // their token-to-screen path just to discover that there is nothing to save.
  if (!source.includes("mermaid")) return normalize(source);

  const tree = mermaidSourceParser.parse(source);
  const pending: Array<typeof tree | (typeof tree.children)[number]> = [tree];
  const ranges: SourceRange[] = [];
  while (pending.length > 0) {
    const node = pending.pop();
    if (!node) continue;
    if (node.type === "code" && node.lang === "mermaid") {
      let start = node.position?.start.offset;
      let end = node.position?.end.offset;
      if (start === undefined || end === undefined) continue;

      // mdast starts a nested code node after the list/blockquote prefix.
      // Protect whole physical lines, including opening/closing syntax, so
      // preprocessors cannot move the fence out of its original container.
      // Walk only the two boundary lines instead of repeatedly scanning the
      // complete message for line breaks for every diagram.
      while (start > 0 && source[start - 1] !== "\n" && source[start - 1] !== "\r") start -= 1;
      while (end < source.length && source[end] !== "\n" && source[end] !== "\r") end += 1;
      ranges.push({ start, end });
    } else if ("children" in node) {
      for (let index = node.children.length - 1; index >= 0; index -= 1) {
        const child = node.children[index];
        if (child) pending.push(child);
      }
    }
  }
  if (ranges.length === 0) return normalize(source);

  // Mask only parser-proven spans while running the normalizers once over the
  // whole message. Normalizing separate chunks would change whether adjacent
  // prose is a standalone math paragraph. Randomness is only a collision-
  // avoidance aid; the explicit source check guarantees placeholders cannot
  // replace provider-authored text, even if that text resembles our marker.
  let markerPrefix: string;
  do {
    markerPrefix = `CAFE_MERMAID_LITERAL_${crypto.getRandomValues(new Uint32Array(4)).join("_")}_`;
  } while (source.includes(markerPrefix));

  const pieces: string[] = [];
  const originalsByMarker = new Map<string, string>();
  let cursor = 0;
  for (let index = 0; index < ranges.length; index += 1) {
    const range = ranges[index]!;
    const marker = `${markerPrefix}${index}_END`;
    originalsByMarker.set(marker, source.slice(range.start, range.end));
    pieces.push(source.slice(cursor, range.start), marker);
    cursor = range.end;
  }
  pieces.push(source.slice(cursor));

  // Restore in one scan, not one complete-message replacement per diagram.
  // The prefix contains only application-generated ASCII letters/digits and
  // underscores; no provider-authored text becomes a regular expression.
  return normalize(pieces.join("")).replace(
    new RegExp(`${markerPrefix}\\d+_END`, "g"),
    // A callback keeps "$&", "$`" and "$'" in provider DSL literal instead
    // of interpreting them as String.replace substitution instructions.
    (marker) => originalsByMarker.get(marker) ?? marker,
  );
}
