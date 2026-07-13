import { describe, expect, it } from "vitest";

import { AssistantStreamTextCommitment } from "./providerAssistantStreamCommitment.ts";

describe("AssistantStreamTextCommitment", () => {
  it("matches completed text independently of provider delta boundaries", () => {
    const commitment = new AssistantStreamTextCommitment();
    commitment.append("First");
    commitment.append(" streamed paragraph complete.");

    expect(commitment.codeUnitLength).toBe("First streamed paragraph complete.".length);
    expect(commitment.matchesPrefixOf("First streamed paragraph complete.")).toBe(true);
  });

  it("accepts a completion that adds an unstreamed suffix", () => {
    const commitment = new AssistantStreamTextCommitment();
    commitment.append("visible prefix");

    expect(commitment.matchesPrefixOf("visible prefix plus recovered suffix")).toBe(true);
  });

  it("rejects divergent and truncated completion text", () => {
    const commitment = new AssistantStreamTextCommitment();
    commitment.append("streamed provider text");

    expect(commitment.matchesPrefixOf("different provider text")).toBe(false);
    expect(commitment.matchesPrefixOf("streamed")).toBe(false);
  });

  it("commits UTF-16 code units consistently across surrogate-pair boundaries", () => {
    const text = "math 𝔸 output";
    const commitment = new AssistantStreamTextCommitment();
    commitment.append(text.slice(0, 6));
    commitment.append(text.slice(6));

    expect(commitment.matchesPrefixOf(text)).toBe(true);
  });
});
