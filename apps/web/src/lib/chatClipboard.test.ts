import { describe, expect, it } from "vitest";
import { ProviderDriverKind } from "@cafecode/contracts";
import {
  isWholeMessageSelection,
  normalizeClipboardComparisonText,
  prepareChatMessageMarkdownCopyText,
} from "./chatClipboard";

describe("chatClipboard", () => {
  it("normalizes provider math syntax into Markdown math for clipboard copy", () => {
    expect(
      prepareChatMessageMarkdownCopyText("```math\nx^2 + y^2 = z^2\n```", {
        provider: ProviderDriverKind.make("claude"),
      }),
    ).toBe("$$\nx^2 + y^2 = z^2\n$$");
  });

  it("strips hidden Codex citation markers from Markdown clipboard copy", () => {
    expect(
      prepareChatMessageMarkdownCopyText("See this \uE200cite\uE202turn1search0\uE201.", {
        provider: ProviderDriverKind.make("codex"),
      }),
    ).toBe("See this.");
  });

  it("copies file citations as ordinary links and preserves math in the same message", () => {
    const citation = ':codex-file-citation{path="reports/price $5.pdf" purpose="source"}';
    expect(
      prepareChatMessageMarkdownCopyText(`See ${citation} for \\(x^2\\).`, {
        provider: ProviderDriverKind.make("claude"),
        cwd: "/repo/project",
      }),
    ).toBe("See [price &#36;5.pdf](<./reports/price%20%245.pdf>) for $x^2$.");
  });

  it.each(["codex", "claude"])(
    "preserves nested Mermaid DSL in whole-message %s clipboard copy",
    (provider) => {
      const diagram = [
        "> 1. ~~~~mermaid",
        ">    graph TD",
        '>      A["\\(x\\) \\[y\\] $\\texttt{a_b}$"] --> B',
        '>      B["\uE200cite\uE202turn1search0\uE201 $& \\path"]',
        ">    ~~~~",
      ].join("\n");
      const text = `${diagram}\n\nHere is math \\(z^2\\) and a citation \uE200cite\uE202turn1search1\uE201.`;
      expect(
        prepareChatMessageMarkdownCopyText(text, {
          provider: ProviderDriverKind.make(provider),
        }),
      ).toBe(
        `${diagram}\n\nHere is math $z^2$ and a citation${provider === "codex" ? "" : " \uE200cite\uE202turn1search1\uE201"}.`,
      );
    },
  );

  it("compares selected visible text with normalized whitespace", () => {
    expect(normalizeClipboardComparisonText("  A\u00a0  B\nC  ")).toBe("A B C");
    expect(isWholeMessageSelection({ selectedText: "A\u00a0B", visibleText: "A B" })).toBe(true);
    expect(isWholeMessageSelection({ selectedText: "A", visibleText: "A B" })).toBe(false);
  });
});
