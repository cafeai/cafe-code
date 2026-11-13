import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  createEditor,
  RootNode,
} from "lexical";
import { expect, it } from "vitest";
import { $normalizeComposerCafeSecrets } from "./composerCafeSecretHighlight";
import { ComposerCafeSecretNode } from "./composerCafeSecretNode";

function editorWith(text: string, cursor = text.length) {
  const editor = createEditor({
    nodes: [ComposerCafeSecretNode],
    onError: (error) => {
      throw error;
    },
  });
  editor.registerNodeTransform(RootNode, $normalizeComposerCafeSecrets);
  editor.update(
    () => {
      const node = $createTextNode(text);
      $getRoot().append($createParagraphNode().append(node));
      node.select(cursor, cursor);
    },
    { discrete: true },
  );
  return editor;
}

it("isolates complete/incomplete secrets and references while leaving ordinary and escaped text alone", () => {
  const reference = "[CAFE_SECRET_0123456789abcdef0123456789abcdef]";
  const text = `prose [sec:key] words \\[sec:literal] ${reference} tail [sec:typing`;
  const editor = editorWith(text);
  editor.getEditorState().read(() => {
    expect($getRoot().getTextContent()).toBe(text);
    expect(
      $getRoot()
        .getAllTextNodes()
        .filter((node) => node instanceof ComposerCafeSecretNode)
        .map((node) => node.getTextContent()),
    ).toEqual(["[sec:key]", reference, "[sec:typing"]);
  });
});

it("keeps an interior caret when secret syntax becomes ordinary text and when it is restored", () => {
  const text = "before [sec:value] after";
  const editor = editorWith(text, 11);
  editor.getEditorState().read(() => {
    const selection = $getSelection();
    expect($isRangeSelection(selection) && selection.anchor.offset).toBe(4);
    expect($isRangeSelection(selection) && selection.anchor.getNode().getTextContent()).toBe(
      "[sec:value]",
    );
  });
  editor.update(
    () => {
      const node = $getRoot()
        .getAllTextNodes()
        .find((node) => node instanceof ComposerCafeSecretNode)!;
      node.setTextContent("[sex:value]").select(4, 4);
    },
    { discrete: true },
  );
  editor.getEditorState().read(() => {
    expect(
      $getRoot()
        .getAllTextNodes()
        .some((node) => node instanceof ComposerCafeSecretNode),
    ).toBe(false);
    const selection = $getSelection();
    expect($isRangeSelection(selection) && selection.anchor.offset).toBe(11);
  });
  editor.update(
    () => {
      const node = $getRoot().getAllTextNodes()[0]!;
      node.setTextContent(text).select(11, 11);
    },
    { discrete: true },
  );
  editor.getEditorState().read(() => {
    const selection = $getSelection();
    expect($isRangeSelection(selection) && selection.anchor.offset).toBe(4);
  });
});

it("recognizes markers across adjacent text pieces and coalesces secret fragments", () => {
  const editor = editorWith("");
  editor.update(
    () => {
      $getRoot()
        .clear()
        .append(
          $createParagraphNode().append(
            $createTextNode("before [se"),
            $createTextNode("c:key] after"),
          ),
        );
    },
    { discrete: true },
  );
  editor.getEditorState().read(() => {
    expect($getRoot().getTextContent()).toBe("before [sec:key] after");
    expect(
      $getRoot()
        .getAllTextNodes()
        .filter((node) => node instanceof ComposerCafeSecretNode)
        .map((node) => node.getTextContent()),
    ).toEqual(["[sec:key]"]);
  });
});

it.each(["[sec:first][sec:second]", "[sec:[CAFE_SECRET_0123456789abcdef0123456789abcdef]tail]"])(
  "reaches a stable model for adjoining or overlapping secret syntax: %s",
  (text) => {
    const editor = editorWith(text);
    editor.getEditorState().read(() => {
      expect($getRoot().getTextContent()).toBe(text);
      expect(
        $getRoot()
          .getAllTextNodes()
          .filter((node) => node instanceof ComposerCafeSecretNode),
      ).toHaveLength(1);
    });
    editor.update(() => $getRoot().markDirty(), { discrete: true });
    editor.getEditorState().read(() => expect($getRoot().getTextContent()).toBe(text));
  },
);
