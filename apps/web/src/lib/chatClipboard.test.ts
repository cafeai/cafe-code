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

  it("compares selected visible text with normalized whitespace", () => {
    expect(normalizeClipboardComparisonText("  A\u00a0  B\nC  ")).toBe("A B C");
    expect(isWholeMessageSelection({ selectedText: "A\u00a0B", visibleText: "A B" })).toBe(true);
    expect(isWholeMessageSelection({ selectedText: "A", visibleText: "A B" })).toBe(false);
  });
});
