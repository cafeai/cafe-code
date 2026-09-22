import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { describe, expect, it } from "vitest";

import { normalizeChatMarkdownMath } from "./chatMarkdownMath";
import { remarkChatMath } from "./remarkChatMath";

const renderMarkdown = (text: string) =>
  renderToStaticMarkup(
    createElement(
      ReactMarkdown,
      {
        remarkPlugins: [remarkGfm, remarkChatMath],
      },
      normalizeChatMarkdownMath(text),
    ),
  );

describe("remarkChatMath", () => {
  it.each([
    "$5 and $10",
    "$3.36 per push and $0.06 per check",
    "$12.13 of recorded usage, with $0 net charges",
    "$1,200.50–$2,000.00",
    "$0.13, $0.33, and $1.05",
  ])("keeps currency literal: %s", (text) => {
    expect(renderMarkdown(text)).toBe(`<p>${text}</p>`);
  });

  it("preserves bold prices and links instead of swallowing Markdown into math", () => {
    expect(
      renderMarkdown(
        "**$3.36 per push**—see [pricing](https://example.com/prices). A check costs **$0.06**.",
      ),
    ).toBe(
      '<p><strong>$3.36 per push</strong>—see <a href="https://example.com/prices">pricing</a>. A check costs <strong>$0.06</strong>.</p>',
    );
  });

  it.each([
    "$x$",
    "$2$",
    "$2 + 2 = 4$",
    "$ x + 1 $",
    "$2\\pi r$",
    "$2 ** 3$",
    "$2 \\text{** literal stars **}$",
    "$\\text{price is }5$",
    "\\(x + 1\\)",
  ])("preserves inline formulas: %s", (text) => {
    expect(renderMarkdown(`An inline formula: ${text}.`)).toContain(
      'class="language-math math-inline"',
    );
  });

  it.each([
    "$5 and $x$",
    "**$5** and **$x$**",
    "**$5 per item** and **$x$**",
    "$x$ costs $5, while $y$ costs $10.",
    "$5 and $10; compute $2 + 2 = 4$.",
  ])("keeps prices separate from formulas: %s", (text) => {
    const rendered = renderMarkdown(text);
    expect(rendered).toContain("$5");
    expect(rendered).toContain('class="language-math math-inline"');
    expect(rendered).not.toMatch(/math-inline">5/u);
  });

  it("preserves currency through partial streamed messages", () => {
    const text = "Cost **$3.36 per push** and **$0.06** per check.";
    for (let length = 1; length <= text.length; length += 1) {
      expect(renderMarkdown(text.slice(0, length))).not.toContain("language-math");
    }
  });

  it("leaves escaped dollars, code, link destinations, and display equations intact", () => {
    const rendered = renderMarkdown(
      [
        "Escaped: \\$5 and \\$10. Code: `$5 and $10`.",
        "",
        "[price](https://example.com/$5) and <https://example.com/$10>",
        "",
        "```text",
        "$5 and $10",
        "```",
        "",
        "$$",
        "2 + 2 = 4",
        "$$",
      ].join("\n"),
    );
    expect(rendered).toContain("Escaped: $5 and $10. Code: <code>$5 and $10</code>.");
    expect(rendered).toContain('href="https://example.com/$5"');
    expect(rendered).toContain('href="https://example.com/$10"');
    expect(rendered).toContain('<code class="language-text">$5 and $10\n</code>');
    expect(rendered).toContain('<code class="language-math math-display">2 + 2 = 4</code>');
  });
});
