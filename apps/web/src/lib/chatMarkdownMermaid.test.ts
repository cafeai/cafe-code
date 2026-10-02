import { describe, expect, it, vi } from "vitest";

import { normalizeChatMarkdownMath } from "./chatMarkdownMath";
import { normalizeAroundMermaidFences } from "./chatMarkdownMermaid";
import { normalizeCodexCitationMarkers } from "./codexCitations";

const normalize = (source: string) =>
  normalizeChatMarkdownMath(normalizeCodexCitationMarkers(source, { mode: "display" }));

describe("normalizeAroundMermaidFences", () => {
  it.each([
    "Ordinary prose, \\(x^2\\), and [file](src/file.ts)",
    "The word mermaid alone does not change **$3.36 per push** or \\(x^2\\).",
    "```text\nmermaid graph LR\n```\n\n\\(x^2\\)",
    "$$\n\\text{mermaid}\n$$",
  ])("preserves the existing normalizer path outside diagrams: %s", (source) => {
    const callback = vi.fn(normalize);
    expect(normalizeAroundMermaidFences(source, callback)).toBe(normalize(source));
    expect(callback).toHaveBeenCalledExactlyOnceWith(source);
  });

  it.each(["```", "~~~", "````", "~~~~"])(
    "preserves nested %s fence bytes, including TeX and citation-looking DSL",
    (marker) => {
      const source = [
        `> 1. ${marker}mermaid`,
        ">    graph TD",
        '>      A["\\(x^2\\) \\[y\\] $\\texttt{a_b}$"] --> B',
        '>      B["\uE200cite\uE202turn3view0\uE201 $& $\' $` \\path"]',
        `>    ${marker}`,
      ].join("\n");
      const text = `Before this formula \\(z^2\\).\n\n${source}\n\nAfter this formula \\(w^2\\).`;
      expect(normalizeAroundMermaidFences(text, normalize)).toBe(
        `Before this formula $z^2$.\n\n${source}\n\nAfter this formula $w^2$.`,
      );
    },
  );

  it("keeps original line endings, indentation, trailing spaces and incomplete source", () => {
    const source =
      '> - ~~~~mermaid  title  \r\n>   graph TD\r\n>     A["\\(literal\\)"] --> B  \r\n>   ~~~';
    expect(normalizeAroundMermaidFences(source, normalize)).toBe(source);
  });

  it("protects incomplete quoted source without preventing normalization after its container", () => {
    const source = '> ```mermaid\n> graph TD\n> A["\\(literal\\)"] --> B';
    const text = `${source}\n\nAfter this formula \\(x^2\\).`;
    expect(normalizeAroundMermaidFences(text, normalize)).toBe(
      `${source}\n\nAfter this formula $x^2$.`,
    );
  });

  it("restores repeated diagrams in source order while normalizing citations only outside them", () => {
    const source = '~~~mermaid\ngraph TD\n  A["\uE200cite\uE202turn3view0\uE201"] --> B\n~~~';
    const text = `${source}\n\nSee \uE200cite\uE202turn3view1\uE201.\n\n${source}`;
    expect(normalizeAroundMermaidFences(text, normalize)).toBe(
      `${source}\n\nSee [1].\n\n${source}`,
    );
  });

  it("preserves surrounding paragraph context instead of normalizing isolated slices", () => {
    const source = "x = y\n```mermaid\ngraph TD\n  A --> B\n```\nz = w";
    expect(normalizeAroundMermaidFences(source, normalize)).toBe(normalize(source));
  });

  it("regenerates an internal placeholder if the source already contains its prefix", () => {
    const source = '~~~mermaid\ngraph TD\n  A["CAFE_MERMAID_LITERAL_1_2_3_4_"] --> B\n~~~';
    const random = vi.spyOn(crypto, "getRandomValues");
    random.mockReturnValueOnce(new Uint32Array([1, 2, 3, 4]));
    try {
      expect(normalizeAroundMermaidFences(source, normalize)).toBe(source);
      expect(random).toHaveBeenCalledTimes(2);
    } finally {
      random.mockRestore();
    }
  });
});
