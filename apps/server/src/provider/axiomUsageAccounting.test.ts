import { describe, expect, it } from "vitest";
import { axiomUsageAccounting } from "./axiomUsageAccounting.ts";

const usage = {
  requestId: "private-request",
  modelId: "near:model-v1",
  providerId: "near",
  turnId: "private-turn",
  purpose: "conversation",
  state: "completed",
  completeness: "final",
  inputTokens: "100",
  cachedInputTokens: "80",
  outputTokens: "20",
  reasoningTokens: "5",
  costMicrousd: "9007199254740993",
  settled: true,
  responseVerified: false,
  startedAtMs: "1",
  finishedAtMs: "2",
};

describe("Axiom settled request accounting", () => {
  it("retains exact cost strings and stable opaque request identity independently of reply authentication", () => {
    const first = axiomUsageAccounting("private-account", "private-thread", usage)!;
    expect(first.models[0]).toMatchObject({
      model: usage.modelId,
      inputTokens: 100,
      outputTokens: 20,
      cachedInputTokens: 80,
      reasoningOutputTokens: 5,
      reportedCostMicrousd: "9007199254740993",
    });
    expect(
      axiomUsageAccounting("private-account", "private-thread", {
        ...usage,
        responseVerified: true,
      }),
    ).toEqual(first);
    expect(axiomUsageAccounting("other-account", "private-thread", usage)?.scopeId).not.toBe(
      first.scopeId,
    );
    expect(JSON.stringify(first)).not.toContain("private-");
  });
  it("requires terminal native settlement and rejects malformed or unsafe counters", () => {
    for (const patch of [
      { settled: false },
      { state: "running" },
      { completeness: "live" },
      { costMicrousd: "-1" },
      { costMicrousd: "1e6" },
      { cachedInputTokens: "101" },
      { reasoningTokens: "21" },
      { inputTokens: "9007199254740992" },
      { modelId: "/private/account" },
      { inputTokens: null },
    ])
      expect(axiomUsageAccounting("account", "thread", { ...usage, ...patch })).toBeUndefined();
  });
  it("includes zero-cost waived, cancelled, title and compaction settlements without upgrading verification", () => {
    for (const purpose of ["conversation", "title", "compaction"]) {
      const snapshot = axiomUsageAccounting("account", "thread", {
        ...usage,
        purpose,
        state: "cancelled",
        completeness: "partial",
        costMicrousd: "0",
      });
      expect(snapshot?.completeness).toBe("partial");
      expect(snapshot?.models[0]?.reportedCostMicrousd).toBe("0");
    }
  });
});
