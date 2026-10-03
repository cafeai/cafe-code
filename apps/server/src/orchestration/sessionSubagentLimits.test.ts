import { describe, expect, it } from "vitest";
import { ThreadId, ProviderInstanceId } from "@cafecode/contracts";
import { materializedSubagentLimitFields } from "./sessionSubagentLimits.ts";

describe("materialized native subagent generation", () => {
  const binding = {
    threadId: ThreadId.make("thread"),
    providerName: "codex",
    providerInstanceId: ProviderInstanceId.make("codex"),
  };
  const oldId = "00000000-0000-4000-8000-000000000001";
  const newId = "00000000-0000-4000-8000-000000000002";
  it("preserves ordinary same-context updates and accepts explicit replacement or unknown", () => {
    const previous = { ...binding, subagentRuntimeId: oldId };
    expect(materializedSubagentLimitFields(binding, previous)).toEqual({
      subagentRuntimeId: oldId,
    });
    expect(
      materializedSubagentLimitFields({ ...binding, subagentRuntimeId: newId }, previous),
    ).toEqual({ subagentRuntimeId: newId });
    expect(
      materializedSubagentLimitFields({ ...binding, subagentRuntimeId: null }, previous),
    ).toEqual({ subagentRuntimeId: null });
  });
  it("does not borrow a different account, thread or driver context", () => {
    for (const change of [
      { providerInstanceId: ProviderInstanceId.make("other") },
      { providerName: "claudeAgent" },
      { threadId: ThreadId.make("other") },
    ]) {
      expect(
        materializedSubagentLimitFields(
          { ...binding, ...change },
          { ...binding, subagentRuntimeId: oldId },
        ),
      ).toEqual({});
    }
  });
});
