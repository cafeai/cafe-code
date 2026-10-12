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
  it("preserves nullable context materialization without borrowing a foreign binding", () => {
    const previous = { ...binding, codexContextWindowOverride: 500_000 };
    expect(materializedSubagentLimitFields(binding, previous)).toEqual({
      codexContextWindowOverride: 500_000,
    });
    expect(
      materializedSubagentLimitFields({ ...binding, codexContextWindowOverride: null }, previous),
    ).toEqual({ codexContextWindowOverride: null });
    expect(
      materializedSubagentLimitFields(
        { ...binding, subagentRuntimeId: newId },
        { ...previous, subagentRuntimeId: oldId },
      ),
    ).toEqual({ subagentRuntimeId: newId });
    expect(
      materializedSubagentLimitFields(
        { ...binding, subagentRuntimeId: null },
        { ...previous, subagentRuntimeId: oldId },
      ),
    ).toEqual({ subagentRuntimeId: null });
    for (const change of [
      { providerInstanceId: ProviderInstanceId.make("other") },
      { providerName: "claudeAgent" },
      { threadId: ThreadId.make("other") },
    ]) {
      expect(materializedSubagentLimitFields({ ...binding, ...change }, previous)).toEqual({});
    }
  });
  it("retains unchanged legacy-null context evidence but clears known generations on retirement", () => {
    for (const prior of [undefined, null] as const)
      for (const next of [undefined, null] as const) {
        const previous = {
          ...binding,
          ...(prior !== undefined ? { subagentRuntimeId: prior } : {}),
          codexContextWindowOverride: 500_000,
        };
        const incoming = { ...binding, ...(next !== undefined ? { subagentRuntimeId: next } : {}) };
        const expectedRuntimeId = next !== undefined ? next : prior;
        expect(materializedSubagentLimitFields(incoming, previous)).toEqual({
          ...(expectedRuntimeId !== undefined ? { subagentRuntimeId: expectedRuntimeId } : {}),
          codexContextWindowOverride: 500_000,
        });
      }
    const legacy = { ...binding, subagentRuntimeId: null, codexContextWindowOverride: 500_000 };
    expect(
      materializedSubagentLimitFields(
        { ...binding, subagentRuntimeId: null },
        { ...legacy, subagentRuntimeId: oldId },
      ),
    ).toEqual({ subagentRuntimeId: null });
    expect(
      materializedSubagentLimitFields({ ...binding, subagentRuntimeId: newId }, legacy),
    ).toEqual({ subagentRuntimeId: newId });
  });
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
