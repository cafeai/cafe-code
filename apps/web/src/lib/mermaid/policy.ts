/** Version the policy with the renderer pin: cached images must never cross a policy upgrade. */
export const MERMAID_POLICY = "tiny-12.0.0/cafe-1";
export const MAX_MERMAID_SOURCE_BYTES = 32 * 1024;
export const MAX_MERMAID_GRAPH_ITEMS = 250;
export const MAX_MERMAID_SVG_BYTES = 2 * 1024 * 1024;
export const MERMAID_FAILURE = "Diagram unavailable. View or copy the source instead.";

export function admitMermaidSource(source: string): void {
  // Check UTF-16 length first so a giant transcript cannot allocate an equally
  // giant encoded copy before the limit is applied. Source remains inert text.
  if (
    source.length > MAX_MERMAID_SOURCE_BYTES ||
    new TextEncoder().encode(source).byteLength > MAX_MERMAID_SOURCE_BYTES ||
    /%%\s*\{/.test(source) ||
    /(?:^|[;\r\n])\s*(?:click|links?)\s/i.test(source) ||
    // Stop at either brace: repeated malformed openers must not repeatedly
    // rescan the rest of the source. Parsed graph admission also rejects images.
    /@\s*\{[^{}]*["']?\bimg\b["']?\s*:/i.test(source) ||
    source.trimStart().startsWith("---") ||
    !/^(?:\s|%%[^\r\n]*(?:\r?\n|$))*(?:flowchart|graph|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram)\b/.test(
      source,
    )
  ) {
    throw new Error(MERMAID_FAILURE);
  }
}
