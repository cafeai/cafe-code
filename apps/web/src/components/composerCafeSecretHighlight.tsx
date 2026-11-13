/**
 * Paints Cafe Secret syntax (`[sec:...]`, complete or still being typed) in
 * the composer. Editable secret text nodes suppress native spellcheck, while
 * the CSS Custom Highlight API styles live DOM Ranges without inline styles
 * that could fight controlled prompt updates or provider-error tones.
 *
 * Every mounted editor (Desk can show several panes) contributes its ranges to
 * one shared registry, and the two document-wide highlights are rebuilt from
 * the union. Browsers without `CSS.highlights` simply show no highlight; the
 * inline composer error and send blocking still apply.
 */
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { findCafeSecretRanges, findCafeSecretReferenceRanges } from "@cafecode/shared/cafeSecrets";
import {
  $getRoot,
  $isElementNode,
  $isLineBreakNode,
  $isTextNode,
  RootNode,
  type LexicalNode,
  type TextNode,
} from "lexical";
import { useEffect, useRef } from "react";
import { $setComposerCafeSecret, ComposerCafeSecretNode } from "./composerCafeSecretNode";

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
  readonly node: TextNode;
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
  if ($isTextNode(node) && (node.getType() === "text" || node instanceof ComposerCafeSecretNode)) {
    const text = node.getTextContent();
    state.segments.push({
      node,
      key: node.getKey(),
      start: state.text.length,
      length: text.length,
    });
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

/** Split only at syntax boundaries, preserving Lexical text and selection. */
export function $normalizeComposerCafeSecrets() {
  const state = { text: "", segments: [] as TextSegment[] };
  for (const child of $getRoot().getChildren()) collectSegments(child, state);
  const syntaxRanges = [
    ...findCafeSecretRanges(state.text),
    ...findCafeSecretReferenceRanges(state.text),
  ].toSorted((left, right) => left.start - right.start);
  const ranges: { start: number; end: number }[] = [];
  for (const range of syntaxRanges) {
    const previous = ranges.at(-1);
    // Spelling has one state across adjoining/overlapping protected syntax.
    // Union it before splitting so coalescing below reaches a stable model.
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else ranges.push({ start: range.start, end: range.end });
  }
  for (const segment of state.segments) {
    const cuts = new Set<number>();
    for (const range of ranges) {
      for (const offset of [range.start - segment.start, range.end - segment.start]) {
        if (offset > 0 && offset < segment.length) cuts.add(offset);
      }
    }
    let offset = segment.start;
    const parts = cuts.size ? segment.node.splitText(...cuts) : [segment.node];
    for (const part of parts) {
      const secret = ranges.some((range) => range.start <= offset && offset < range.end);
      offset += part.getTextContentSize();
      $setComposerCafeSecret(part, secret && part.getTextContentSize() > 0);
    }
  }
  // Custom text nodes do not participate in Lexical's ordinary text merging.
  // Coalesce adjacent pieces after edits/paste so fragmentation stays bounded.
  for (const node of $getRoot().getAllTextNodes()) {
    if (!(node instanceof ComposerCafeSecretNode) || !node.isAttached()) continue;
    let next = node.getNextSibling();
    while (
      next instanceof ComposerCafeSecretNode &&
      node.getFormat() === next.getFormat() &&
      node.getStyle() === next.getStyle() &&
      node.getDetail() === next.getDetail()
    ) {
      node.mergeWithSibling(next);
      next = node.getNextSibling();
    }
  }
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
    const unregisterTransform = editor.registerNodeTransform(
      RootNode,
      $normalizeComposerCafeSecrets,
    );
    editor.update($normalizeComposerCafeSecrets);
    return () => {
      unregisterTransform();
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
