/** Version the policy with the renderer pin: cached images must never cross a policy upgrade. */
export const MERMAID_POLICY = "tiny-12.0.0/cafe-2";
export const MAX_MERMAID_SOURCE_BYTES = 32 * 1024;
export const MAX_MERMAID_GRAPH_ITEMS = 250;
export const MAX_MERMAID_SVG_BYTES = 2 * 1024 * 1024;
export const MERMAID_FAILURE = "Diagram unavailable. View or copy the source instead.";

export function admitMermaidSource(source: string): void {
  // Reject oversized transcripts before scanning or allocating an encoded copy.
  if (
    source.length > MAX_MERMAID_SOURCE_BYTES ||
    new TextEncoder().encode(source).byteLength > MAX_MERMAID_SOURCE_BYTES
  ) {
    throw new Error(MERMAID_FAILURE);
  }
  const family =
    /^(?:\s|%%[^\r\n]*(?:\r?\n|$))*(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|xychart(?:-beta)?|pie)\b/.exec(
      source,
    )?.[1];
  // Source remains inert text. The runtime separately binds these checks to
  // the actual parsed type before layout, rather than trusting this header.
  if (
    /%%\s*\{/.test(source) ||
    /(?:^|[;\r\n])\s*click\s/i.test(source) ||
    // Flowchart's linkStyle/click syntax has no standalone link/links directive;
    // LINK is a valid node ID there. Preserve the existing directive ban for
    // every other family, including sequence and class link declarations.
    (family !== "flowchart" && family !== "graph" && /(?:^|[;\r\n])\s*links?\s/i.test(source)) ||
    // Stop at either brace: repeated malformed openers must not repeatedly
    // rescan the rest of the source. Parsed graph admission also rejects images.
    /@\s*\{[^{}]*["']?\bimg\b["']?\s*:/i.test(source) ||
    source.trimStart().startsWith("---") ||
    !family
  ) {
    throw new Error(MERMAID_FAILURE);
  }
}
