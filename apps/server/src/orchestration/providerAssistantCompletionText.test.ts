import { describe, expect, it } from "vitest";

import {
  completedAssistantTextDelta,
  prefixSafeAssistantRepairSuffix,
} from "./providerAssistantCompletionText.ts";

describe("provider assistant completion text helpers", () => {
  it("appends the missing suffix when projected text is a provider-completion prefix", () => {
    expect(
      prefixSafeAssistantRepairSuffix({
        projectedText: "visible prefix",
        completionText: "visible prefix plus recovered suffix",
      }),
    ).toEqual({
      type: "append",
      suffix: " plus recovered suffix",
    });
  });

  it("reports unchanged when the projected text already matches retained provider output", () => {
    expect(
      prefixSafeAssistantRepairSuffix({
        projectedText: "complete answer",
        completionText: "complete answer",
      }),
    ).toEqual({ type: "unchanged" });
  });

  it("rejects divergent provider output without producing a suffix", () => {
    expect(
      prefixSafeAssistantRepairSuffix({
        projectedText: "current visible answer",
        completionText: "different provider answer",
      }),
    ).toEqual({ type: "diverged" });
  });

  it("keeps forward ingestion append-only when a buffered tail precedes completion detail", () => {
    expect(
      completedAssistantTextDelta({
        projectedText: "hello",
        bufferedText: " world",
        fallbackText: "hello world from item.completed",
      }),
    ).toBe(" world from item.completed");
  });

  it("does not duplicate streamed text when the durable projection still has only the first chunk", () => {
    const completedText = "First streamed paragraph. A second sentence follows.";

    expect(
      completedAssistantTextDelta({
        projectedText: "First",
        bufferedText: "",
        fallbackText: completedText,
        streamObserved: true,
      }),
    ).toBe("");
  });
});
