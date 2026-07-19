import { describe, expect, it } from "vitest";
import katex from "katex";
import { normalizeChatMarkdownMath } from "./chatMarkdownMath";

describe("normalizeChatMarkdownMath", () => {
  it("converts Codex-style fenced math blocks to display math", () => {
    expect(
      normalizeChatMarkdownMath(
        [
          "The equation is:",
          "",
          "```math",
          "E = mc^2",
          "```",
          "",
          "and the related identity is:",
          "",
          "```tex",
          "a^2 + b^2 = c^2",
          "```",
        ].join("\n"),
      ),
    ).toBe(
      [
        "The equation is:",
        "",
        "$$",
        "E = mc^2",
        "$$",
        "",
        "and the related identity is:",
        "",
        "$$",
        "a^2 + b^2 = c^2",
        "$$",
      ].join("\n"),
    );
  });

  it("leaves non-math code fences alone", () => {
    const markdown = ["```text", "input -> transform -> output", "```"].join("\n");
    expect(normalizeChatMarkdownMath(markdown)).toBe(markdown);
  });

  it("converts Claude-style slash delimiters to dollar delimiters", () => {
    expect(
      normalizeChatMarkdownMath(
        "For every \\(x\\), the quadratic formula is \\[x=\\frac{-b\\pm\\sqrt{b^2-4ac}}{2a}.\\]",
      ),
    ).toBe(
      [
        "For every $x$, the quadratic formula is ",
        "",
        "$$",
        "x=\\frac{-b\\pm\\sqrt{b^2-4ac}}{2a}.",
        "$$",
      ].join("\n"),
    );
  });

  it("preserves list indentation around standalone slash display math", () => {
    expect(
      normalizeChatMarkdownMath(
        [
          "1. **Readback equality**",
          "   \\[",
          "   \\mathrm{CvSOrdinaryLimit}(f,\\lambda)",
          "   =",
          "   \\mathrm{WeilPacket}(f,\\lambda)",
          "   \\]",
          "   for the actual zeta test-function class.",
        ].join("\n"),
      ),
    ).toBe(
      [
        "1. **Readback equality**",
        "   $$",
        "   \\mathrm{CvSOrdinaryLimit}(f,\\lambda)",
        "   =",
        "   \\mathrm{WeilPacket}(f,\\lambda)",
        "   $$",
        "   for the actual zeta test-function class.",
      ].join("\n"),
    );
  });

  it("wraps standalone raw TeX paragraphs as display math", () => {
    expect(
      normalizeChatMarkdownMath(
        ["More explicitly:", "", "\\sum_{i=1}^n i = \\frac{n(n+1)}{2}", ""].join("\n"),
      ),
    ).toBe(["More explicitly:", "", "$$", "\\sum_{i=1}^n i = \\frac{n(n+1)}{2}", "$$"].join("\n"));
  });

  it("normalizes multiline dollar-display blocks with inline delimiters", () => {
    expect(
      normalizeChatMarkdownMath(
        [
          "Substituting this in:",
          "",
          "$$\\int_1^\\infty \\left[\\frac{\\sqrt t-1}{2}+\\sqrt t\\,\\psi(t)\\right]t^{-s/2-1}\\,dt",
          "= \\frac12\\int_1^\\infty\\!\\left(t^{-\\frac{s+1}{2}}-t^{-\\frac{s}{2}-1}\\right)dt \\;+\\; \\int_1^\\infty \\psi(t)\\,t^{-\\frac{s+1}{2}}\\,dt.$$",
        ].join("\n"),
      ),
    ).toBe(
      [
        "Substituting this in:",
        "",
        "$$",
        "\\int_1^\\infty \\left[\\frac{\\sqrt t-1}{2}+\\sqrt t\\,\\psi(t)\\right]t^{-s/2-1}\\,dt",
        "= \\frac12\\int_1^\\infty\\!\\left(t^{-\\frac{s+1}{2}}-t^{-\\frac{s}{2}-1}\\right)dt \\;+\\; \\int_1^\\infty \\psi(t)\\,t^{-\\frac{s+1}{2}}\\,dt.",
        "$$",
      ].join("\n"),
    );
  });

  it("does not rewrite dollar display delimiters inside non-math code fences", () => {
    const markdown = ["```text", "$$x=1", "y=2$$", "```"].join("\n");
    expect(normalizeChatMarkdownMath(markdown)).toBe(markdown);
  });

  it("keeps normal prose with incidental TeX macros as prose", () => {
    const markdown =
      "A short inline expression \\(x+1\\) should not turn the paragraph into a block.";
    expect(normalizeChatMarkdownMath(markdown)).toBe(
      "A short inline expression $x+1$ should not turn the paragraph into a block.",
    );
  });

  it("keeps display-style math inside GFM table rows inline", () => {
    expect(
      normalizeChatMarkdownMath(
        [
          "| Case | Expression |",
          "|---|---|",
          "| Display dollars | $$\\prod_{j=1}^{1234567890}\\frac{a_j}{b_j}$$ |",
          "| Slash display | \\[x=\\frac{-b\\pm\\sqrt{b^2-4ac}}{2a}\\] |",
        ].join("\n"),
      ),
    ).toBe(
      [
        "| Case | Expression |",
        "|---|---|",
        "| Display dollars | $\\prod_{j=1}^{1234567890}\\frac{a_j}{b_j}$ |",
        "| Slash display | $x=\\frac{-b\\pm\\sqrt{b^2-4ac}}{2a}$ |",
      ].join("\n"),
    );
  });

  it("does not rewrite display math delimiters inside non-math code fences", () => {
    const markdown = ["```text", "| Literal | $$x=1$$ |", "```"].join("\n");
    expect(normalizeChatMarkdownMath(markdown)).toBe(markdown);
  });

  it("does not rewrite slash display delimiters inside non-math code fences", () => {
    const markdown = ["```text", "\\[", "x=1", "\\]", "```"].join("\n");
    expect(normalizeChatMarkdownMath(markdown)).toBe(markdown);
  });

  it("repairs literal provider identifiers inside texttt math commands", () => {
    const normalized = normalizeChatMarkdownMath(
      [
        "\\[",
        "\\rho^{\\rm structural}_{ij}",
        " =S^{\\rm structural}_{ij}",
        "  \\frac{\\eta}{1-\\eta},",
        "\\qquad",
        "\\eta=\\texttt{composed_relative_uncertainty}.",
        "\\]",
        "",
        "\\[",
        "m_-=\\texttt{probability_denominator_lower},",
        "\\qquad d_-=\\texttt{denominator_lower}.",
        "\\]",
      ].join("\n"),
    );

    expect(normalized).toBe(
      [
        "$$",
        "\\rho^{\\rm structural}_{ij}",
        " =S^{\\rm structural}_{ij}",
        "  \\frac{\\eta}{1-\\eta},",
        "\\qquad",
        "\\eta=\\texttt{composed\\_relative\\_uncertainty}.",
        "$$",
        "",
        "$$",
        "m_-=\\texttt{probability\\_denominator\\_lower},",
        "\\qquad d_-=\\texttt{denominator\\_lower}.",
        "$$",
      ].join("\n"),
    );

    const displayExpressions = normalized
      .split("$$")
      .filter((segment) => segment.trim().length > 0)
      .map((segment) => segment.trim());
    for (const expression of displayExpressions) {
      expect(() =>
        katex.renderToString(expression, { strict: false, throwOnError: true, trust: false }),
      ).not.toThrow();
    }
  });

  it("limits texttt repairs to math and preserves existing escapes", () => {
    const markdown = [
      "Literal prose: \\texttt{prose_identifier}.",
      "Inline code: `$\\texttt{code_identifier}$`.",
      "",
      "```text",
      "$\\texttt{fenced_identifier}$",
      "```",
      "",
      "Math: $\\texttt{new_identifier} + \\texttt{already\\_escaped}$.",
    ].join("\n");

    expect(normalizeChatMarkdownMath(markdown)).toBe(
      [
        "Literal prose: \\texttt{prose_identifier}.",
        "Inline code: `$\\texttt{code_identifier}$`.",
        "",
        "```text",
        "$\\texttt{fenced_identifier}$",
        "```",
        "",
        "Math: $\\texttt{new\\_identifier} + \\texttt{already\\_escaped}$.",
      ].join("\n"),
    );
  });
});
