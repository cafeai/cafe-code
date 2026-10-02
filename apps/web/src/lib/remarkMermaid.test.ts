import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { describe, expect, it } from "vitest";

import { remarkChatMath } from "./remarkChatMath";
import { remarkMermaid } from "./remarkMermaid";

function renderMarkdown(text: string) {
  const fences: Array<{ source: string; complete: boolean }> = [];
  const html = renderToStaticMarkup(
    createElement(
      ReactMarkdown,
      {
        remarkPlugins: [remarkGfm, remarkChatMath, remarkMermaid],
        components: {
          code({ node, children }) {
            const source = node?.properties["data-mermaid-source"];
            if (typeof source === "string") {
              fences.push({
                source,
                complete: node?.properties["data-mermaid-complete"] === "true",
              });
            }
            return createElement("code", {}, children);
          },
        },
      },
      text,
    ),
  );
  return { html, fences };
}

describe("remarkMermaid", () => {
  it.each(["```", "~~~", "````", "~~~~"])(
    "recognizes a matching or longer %s closer independently of following output",
    (marker) => {
      const result = renderMarkdown(
        `${marker}mermaid title\ngraph TD\n  A --> B\n${marker}${marker[0]}\n\nMore output`,
      );
      expect(result.fences).toEqual([{ source: "graph TD\n  A --> B", complete: true }]);
      expect(result.html).toContain("<p>More output</p>");
    },
  );

  it("tracks each diagram's fence independently while later content remains incomplete", () => {
    expect(
      renderMarkdown(
        "```mermaid\ngraph TD\n  A --> B\n```\n\nStill writing\n\n~~~mermaid\nsequenceDiagram",
      ).fences,
    ).toEqual([
      { source: "graph TD\n  A --> B", complete: true },
      { source: "sequenceDiagram", complete: false },
    ]);
  });

  it("waits for the whole closing marker as a fence streams in", () => {
    const prefix = "````mermaid\ngraph LR\n  A --> B\n";
    for (let markerLength = 0; markerLength <= 4; markerLength += 1) {
      expect(renderMarkdown(prefix + "`".repeat(markerLength)).fences).toEqual([
        {
          source: `graph LR\n  A --> B${markerLength > 0 && markerLength < 4 ? `\n${"`".repeat(markerLength)}` : ""}`,
          complete: markerLength === 4,
        },
      ]);
    }
  });

  it.each(["``", "~~~", "``` followed by text", "    ```", '  A["```"] --> B', "%% ```"])(
    "does not treat closing-like source as a fence: %s",
    (line) => {
      expect(renderMarkdown(`\`\`\`mermaid\ngraph LR\n${line}`).fences).toEqual([
        { source: `graph LR\n${line}`, complete: false },
      ]);
    },
  );

  it("uses container-aware parser evidence for nested blockquote/list fences", () => {
    expect(
      renderMarkdown(
        "> 1. Diagram\n>\n>    ~~~~mermaid\n>    graph TD\n>      A --> B\n>    ~~~~~\n>\n>    Continued",
      ).fences,
    ).toEqual([{ source: "graph TD\n  A --> B", complete: true }]);
  });

  it("keeps a diagram incomplete when its container ends without a closer", () => {
    const result = renderMarkdown(
      "> ```mermaid\n> graph TD\n>   A --> B\n\nOutside the quote\n\n```text\nordinary\n```",
    );
    expect(result.fences).toEqual([{ source: "graph TD\n  A --> B", complete: false }]);
    expect(result.html).toContain("<p>Outside the quote</p>");
  });

  it("preserves source whitespace and escapes without the HAST display newline", () => {
    const source = 'graph TD\n  A["<b>literal</b> & \\path $5"] --> B\n\n';
    const result = renderMarkdown(`\`\`\`mermaid\n${source}\n\`\`\``);
    expect(result.fences).toEqual([{ source, complete: true }]);
    expect(result.html).toContain("&lt;b&gt;literal&lt;/b&gt;");
    expect(result.html).not.toContain("<b>");
  });

  it("retains empty and unterminated fences as explicitly tagged source", () => {
    expect(renderMarkdown("```mermaid\n```").fences).toEqual([{ source: "", complete: true }]);
    expect(renderMarkdown("```mermaid").fences).toEqual([{ source: "", complete: false }]);
  });

  it("does not infer diagrams from unlabeled code, other languages or inline source", () => {
    const result = renderMarkdown(
      [
        "```",
        "graph TD",
        "  A --> B",
        "```",
        "",
        "```text",
        "graph TD",
        "  A --> B",
        "```",
        "",
        "```mermaid-extra",
        "graph TD",
        "  A --> B",
        "```",
        "",
        "```merm&#97;id",
        "graph TD",
        "  A --> B",
        "```",
        "",
        "`mermaid graph TD`",
        "",
        "    graph TD",
        "      A --> B",
        "",
        "$x^2$ and [guide](https://example.com/guide)",
      ].join("\n"),
    );
    expect(result.fences).toEqual([]);
    expect(result.html).toContain('href="https://example.com/guide"');
  });
});
