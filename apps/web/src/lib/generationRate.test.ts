import { describe, expect, it } from "vitest";
import { EventId, type OrchestrationThreadActivity, TurnId } from "@cafecode/contracts";

import { deriveGenerationRate, GENERATION_RATE_WINDOW_MS } from "./generationRate";

let nextId = 0;
function usageActivity(
  createdAt: string,
  responseGeneration?: unknown,
  kind = "context-window.updated",
): OrchestrationThreadActivity {
  nextId += 1;
  return {
    id: EventId.make(`activity-${nextId}`),
    tone: "info",
    kind,
    summary: kind,
    payload: {
      usedTokens: 1_000,
      ...(responseGeneration !== undefined ? { responseGeneration } : {}),
    },
    turnId: TurnId.make("turn-1"),
    createdAt,
  };
}

describe("deriveGenerationRate", () => {
  it("returns null when no response was measured", () => {
    expect(deriveGenerationRate([])).toBeNull();
    expect(deriveGenerationRate([usageActivity("2026-10-12T00:00:00.000Z")])).toBeNull();
  });

  it("weights responses by their decode time, newest first", () => {
    const rate = deriveGenerationRate([
      usageActivity("2026-10-12T00:00:01.000Z", { outputTokens: 100, durationMs: 1_000 }),
      usageActivity("2026-10-12T00:00:02.000Z", { outputTokens: 300, durationMs: 2_000 }),
    ]);
    // (100 + 300) tokens over 3 s, not the mean of 100 and 150 tok/s.
    expect(rate?.tokensPerSecond).toBeCloseTo(133.33, 2);
    expect(rate?.measuredMs).toBe(3_000);
  });

  it("averages only the most recent five seconds of decoding", () => {
    const rate = deriveGenerationRate([
      // An old, slow model must not drag down the current figure.
      usageActivity("2026-10-12T00:00:00.000Z", { outputTokens: 100, durationMs: 10_000 }),
      // Straddles the window edge: only one of its three seconds counts.
      usageActivity("2026-10-12T00:00:10.000Z", { outputTokens: 300, durationMs: 3_000 }),
      usageActivity("2026-10-12T00:00:20.000Z", { outputTokens: 400, durationMs: 4_000 }),
    ]);
    expect(rate?.measuredMs).toBe(GENERATION_RATE_WINDOW_MS);
    expect(rate?.tokensPerSecond).toBeCloseTo((400 + 100) / 5, 6);
  });

  it("ignores non-usage activities and malformed or implausible samples", () => {
    const rate = deriveGenerationRate([
      usageActivity("2026-10-12T00:00:00.000Z", { outputTokens: 80, durationMs: 1_000 }),
      usageActivity("2026-10-12T00:00:01.000Z", { outputTokens: 1_000_000, durationMs: 100 }),
      usageActivity("2026-10-12T00:00:02.000Z", { outputTokens: "90", durationMs: 1_000 }),
      usageActivity("2026-10-12T00:00:03.000Z", { outputTokens: 90, durationMs: 0 }),
      usageActivity(
        "2026-10-12T00:00:04.000Z",
        { outputTokens: 90, durationMs: 1_000 },
        "tool.completed",
      ),
    ]);
    expect(rate).toEqual({ tokensPerSecond: 80, measuredMs: 1_000 });
  });

  it("restricts samples to activity observed since a given instant", () => {
    const activities = [
      usageActivity("2026-10-12T00:00:00.000Z", { outputTokens: 500, durationMs: 1_000 }),
      usageActivity("2026-10-12T00:01:00.000Z", { outputTokens: 60, durationMs: 1_000 }),
    ];
    expect(deriveGenerationRate(activities, { since: "2026-10-12T00:00:30.000Z" })).toEqual({
      tokensPerSecond: 60,
      measuredMs: 1_000,
    });
    expect(deriveGenerationRate(activities, { since: "2026-10-12T00:02:00.000Z" })).toBeNull();
  });
});
