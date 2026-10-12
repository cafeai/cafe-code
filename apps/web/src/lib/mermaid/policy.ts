import { uiText } from "@cafecode/shared/i18n";
/** Version the policy with the renderer pin: cached images must never cross a policy upgrade. */
export const MERMAID_POLICY = "full-12.0.0/cafe-4";
export const MAX_MERMAID_SOURCE_BYTES = 32 * 1024;
export const MAX_MERMAID_GRAPH_ITEMS = 250;
export const MAX_MERMAID_SVG_BYTES = 2 * 1024 * 1024;
export const MERMAID_FAILURE = "Diagram unavailable. View or copy the source instead.";
// Only reviewed native headers enter the queue. The opaque runtime separately
// binds their actual parsed types to family-specific admission before layout.
// Keep the names explicit: a future engine is not implicitly qualified by the
// top-level distribution merely adding another detector.
const FAMILY_HEADERS = new Set([
  "flowchart",
  "graph",
  "sequenceDiagram",
  "classDiagram",
  "classDiagram-v2",
  "stateDiagram",
  "stateDiagram-v2",
  "erDiagram",
  "xychart",
  "xychart-beta",
  "pie",
  "gantt",
  "journey",
  "quadrantChart",
  "requirementDiagram",
  "gitGraph",
  "mindmap",
  "timeline",
  "sankey-beta",
  "block-beta",
  "packet",
  "packet-beta",
  "kanban",
  "architecture-beta",
  "radar-beta",
  "treemap-beta",
  "swimlane-beta",
  "usecase-beta",
  "eventmodeling",
  "venn-beta",
  "ishikawa",
  "ishikawa-beta",
  "wardley-beta",
  "cynefin-beta",
  "C4Context",
  "C4Container",
  "C4Component",
  "C4Dynamic",
  "C4Deployment",
  "treeView-beta",
  "agentflow-beta",
  "railroad-beta",
  "railroad-ebnf-beta",
  "railroad-abnf-beta",
  "railroad-peg-beta",
  "info",
]);
const FLOW_NODE_HEADERS = new Set(["flowchart", "graph", "swimlane-beta", "agentflow-beta"]);
export function getMERMAID_FAILURE() {
  return uiText("Diagram unavailable. View or copy the source instead.");
}

export function admitMermaidSource(source: string): void {
  // Reject oversized transcripts before scanning or allocating an encoded copy.
  if (
    source.length > MAX_MERMAID_SOURCE_BYTES ||
    new TextEncoder().encode(source).byteLength > MAX_MERMAID_SOURCE_BYTES
  ) {
    throw new Error(getMERMAID_FAILURE());
  }
  const family = /^(?:\s|%%[^\r\n]*(?:\r?\n|$))*([\w-]+)\b/.exec(source)?.[1];
  // Source remains inert text. The runtime separately binds these checks to
  // the actual parsed type before layout, rather than trusting this header.
  if (
    /%%\s*\{/.test(source) ||
    /(?:^|[;\r\n])\s*click\s/i.test(source) ||
    // Flowchart and its swimlane/agentflow native grammars have no standalone
    // link/links directive; LINK is a valid node ID there. Preserve the ban for
    // every other family, including sequence and class link declarations.
    (!FLOW_NODE_HEADERS.has(family ?? "") && /(?:^|[;\r\n])\s*links?\s/i.test(source)) ||
    // Stop at either brace: repeated malformed openers must not repeatedly
    // rescan the rest of the source. Parsed graph admission also rejects images.
    /@\s*\{[^{}]*["']?\bimg\b["']?\s*:/i.test(source) ||
    source.trimStart().startsWith("---") ||
    !family ||
    !FAMILY_HEADERS.has(family)
  ) {
    throw new Error(getMERMAID_FAILURE());
  }
}
