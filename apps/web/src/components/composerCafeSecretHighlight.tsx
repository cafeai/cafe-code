/**
 * Paints Cafe Secret syntax (`[sec:...]`, complete or still being typed) in
 * the composer without changing the editor model. Lexical owns the DOM text
 * nodes, so decorating through node transforms would fight the controlled
 * prompt updates; the CSS Custom Highlight API instead styles live DOM Ranges.
 *
 * Every mounted editor (Desk can show several panes) contributes its ranges to
 * one shared registry, and the two document-wide highlights are rebuilt from
 * the union. Browsers without `CSS.highlights` simply show no highlight; the
 * inline composer error and send blocking still apply.
 */
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { findCafeSecretRanges, findCafeSecretReferenceRanges } from "@cafecode/shared/cafeSecrets";
import { $getRoot, $isElementNode, $isLineBreakNode, $isTextNode, type LexicalNode } from "lexical";
import { useEffect, useRef } from "react";

export type CafeSecretHighlightTone = "secret" | "error";

const HIGHLIGHT_NAME: Record<CafeSecretHighlightTone, string> = {
  secret: "cafe-secret",
  error: "cafe-secret-error",
};

interface HighlightRegistryLike {
  set(name: string, value: unknown): void;
  delete(name: string): void;
}

function readHighlightApi(): {
  registry: HighlightRegistryLike;
  Highlight: new (...ranges: Range[]) => unknown;
} | null {
  const cssApi = (globalThis as { CSS?: { highlights?: HighlightRegistryLike } }).CSS;
  const Highlight = (globalThis as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  if (!cssApi?.highlights || typeof Highlight !== "function") return null;
  return { registry: cssApi.highlights, Highlight };
}

const rangesByOwner = new Map<object, { tone: CafeSecretHighlightTone; ranges: Range[] }>();

function publishHighlights() {
  const api = readHighlightApi();
  if (!api) return;
  for (const tone of ["secret", "error"] as const) {
    const ranges: Range[] = [];
    for (const entry of rangesByOwner.values()) {
      if (entry.tone === tone) ranges.push(...entry.ranges);
    }
    if (ranges.length === 0) api.registry.delete(HIGHLIGHT_NAME[tone]);
    else api.registry.set(HIGHLIGHT_NAME[tone], new api.Highlight(...ranges));
  }
}

interface TextSegment {
  readonly key: string;
  readonly start: number;
  readonly length: number;
}

/**
 * Builds a plain string mirror of the editor. Inline file/skill tokens become
 * one opaque character so their expanded paths can never form or close a
 * marker; line breaks/paragraphs become newlines.
 */
function collectSegments(node: LexicalNode, state: { text: string; segments: TextSegment[] }) {
  if ($isTextNode(node) && node.getType() === "text") {
    const text = node.getTextContent();
    state.segments.push({ key: node.getKey(), start: state.text.length, length: text.length });
    state.text += text;
    return;
  }
  if ($isLineBreakNode(node)) {
    state.text += "\n";
    return;
  }
  if ($isElementNode(node)) {
    const children = node.getChildren();
    for (const child of children) collectSegments(child, state);
    if (node.getParent() !== null && node.getNextSibling() !== null) state.text += "\n";
    return;
  }
  state.text += "￼";
}

export function ComposerCafeSecretHighlightPlugin(props: { tone: CafeSecretHighlightTone }) {
  const [editor] = useLexicalComposerContext();
  const ownerRef = useRef<object>({});
  const toneRef = useRef(props.tone);

  useEffect(() => {
    const owner = ownerRef.current;
    const refresh = () => {
      const ranges: Range[] = [];
      editor.getEditorState().read(() => {
        const state = { text: "", segments: [] as TextSegment[] };
        for (const child of $getRoot().getChildren()) collectSegments(child, state);
        for (const secret of [
          ...findCafeSecretRanges(state.text),
          // Exact unescaped references also need admission; teaching examples
          // such as [CAFE_SECRET_<id>] and escaped references stay plain text.
          ...findCafeSecretReferenceRanges(state.text),
        ]) {
          for (const segment of state.segments) {
            const from = Math.max(secret.start, segment.start);
            const to = Math.min(secret.end, segment.start + segment.length);
            if (from >= to) continue;
            const domText = editor.getElementByKey(segment.key)?.firstChild;
            if (!domText || domText.nodeType !== Node.TEXT_NODE) continue;
            const range = document.createRange();
            range.setStart(domText, from - segment.start);
            range.setEnd(domText, to - segment.start);
            ranges.push(range);
          }
        }
      });
      if (ranges.length === 0) rangesByOwner.delete(owner);
      else rangesByOwner.set(owner, { tone: toneRef.current, ranges });
      publishHighlights();
    };
    refresh();
    const unregister = editor.registerUpdateListener(refresh);
    return () => {
      unregister();
      rangesByOwner.delete(owner);
      publishHighlights();
    };
  }, [editor]);

  // Tone changes (provider switch, send issue) repaint without a text edit.
  useEffect(() => {
    toneRef.current = props.tone;
    const entry = rangesByOwner.get(ownerRef.current);
    if (!entry || entry.tone === props.tone) return;
    rangesByOwner.set(ownerRef.current, { ...entry, tone: props.tone });
    publishHighlights();
  }, [props.tone]);

  return null;
}
