import { describe, expect, it } from "vitest";
import { EventId, type OrchestrationThreadActivity, TurnId } from "@cafecode/contracts";

import { deriveLatestContextWindowSnapshot, formatContextWindowTokens } from "./contextWindow";

function makeActivity(id: string, kind: string, payload: unknown): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    tone: "info",
    kind,
    summary: kind,
    payload,
    turnId: TurnId.make("turn-1"),
    createdAt: "2026-03-23T00:00:00.000Z",
  };
}

describe("contextWindow", () => {
  it("formats compact token counts", () => {
    expect(formatContextWindowTokens(999)).toBe("999");
    expect(formatContextWindowTokens(1400)).toBe("1.4k");
    expect(formatContextWindowTokens(14_000)).toBe("14k");
    expect(formatContextWindowTokens(258_000)).toBe("258k");
  });

  it("carries the chat-wide generation rate with the latest snapshot", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 2_000,
        responseGeneration: { outputTokens: 240, durationMs: 3_000 },
      }),
      makeActivity("activity-2", "context-window.updated", { usedTokens: 2_400 }),
    ]);

    expect(snapshot?.usedTokens).toBe(2_400);
    expect(snapshot?.compactsAutomatically).toBe(false);
    expect(snapshot?.generationRate).toEqual({ tokensPerSecond: 80, measuredMs: 3_000 });
    expect(
      deriveLatestContextWindowSnapshot([
        makeActivity("activity-3", "context-window.updated", { usedTokens: 2_400 }),
      ])?.generationRate,
    ).toBeNull();
  });
});
