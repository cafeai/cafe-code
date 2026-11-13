import {
  $applyNodeReplacement,
  $createTextNode,
  $getSelection,
  $isRangeSelection,
  type EditorConfig,
  type NodeKey,
  type SerializedTextNode,
  TextNode,
} from "lexical";

/** Editable text, never an atomic token. Native spelling ignores only secrets. */
export class ComposerCafeSecretNode extends TextNode {
  static override getType(): string {
    return "composer-cafe-secret";
  }
  static override clone(node: ComposerCafeSecretNode) {
    return new ComposerCafeSecretNode(node.__text, node.__key);
  }
  static override importJSON(node: SerializedTextNode) {
    return $applyNodeReplacement(new ComposerCafeSecretNode()).updateFromJSON(node);
  }
  constructor(text = "", key?: NodeKey) {
    super(text, key);
  }
  override createDOM(config: EditorConfig): HTMLElement {
    const dom = super.createDOM(config);
    dom.spellcheck = false;
    return dom;
  }
}

export function $setComposerCafeSecret(node: TextNode, secret: boolean): TextNode {
  if (node instanceof ComposerCafeSecretNode === secret) return node;
  const selection = $getSelection();
  const points = $isRangeSelection(selection)
    ? [selection.anchor, selection.focus]
        .filter((point) => point.key === node.getKey())
        .map((point) => ({ point, offset: point.offset }))
    : [];
  const replacement = secret
    ? $applyNodeReplacement(new ComposerCafeSecretNode(node.getTextContent()))
    : $createTextNode(node.getTextContent());
  replacement.setFormat(node.getFormat()).setStyle(node.getStyle()).setDetail(node.getDetail());
  node.replace(replacement);
  // Lexical's generic replace moves text points to the end; preserve each
  // exact caret/range offset when a marker starts, changes or becomes literal.
  for (const { point, offset } of points) point.set(replacement.getKey(), offset, "text");
  return replacement;
}
