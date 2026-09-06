import { describe, expect, it } from "vitest";
import { createModelCapabilities } from "@cafecode/shared/model";
import { getClaudeModelCapabilities } from "./Layers/ClaudeProvider.ts";
import {
  findClaudeNativeModel,
  normalizeClaudeNativeModels,
  reconcileClaudeModelCapabilities,
  reconcileClaudeModels,
} from "./claudeModelMetadata.ts";
import { resolveClaudeModelSessionOptions } from "./Layers/ClaudeAdapter.ts";
import { createModelSelection } from "@cafecode/shared/model";
import { ProviderInstanceId } from "@cafecode/contracts";

describe("Claude native model metadata", () => {
  it("bounds metadata and ignores malformed rows/options", () => {
    expect(normalizeClaudeNativeModels(Array.from({ length: 129 }, () => ({})))).toBeUndefined();
    expect(
      normalizeClaudeNativeModels([{ value: "private\nvalue", displayName: "bad" }]),
    ).toBeUndefined();
    expect(
      normalizeClaudeNativeModels([
        { value: "opus", displayName: "Opus", supportedEffortLevels: ["high", "injected", "max"] },
      ])?.[0]?.supportedEffortLevels,
    ).toEqual(["high", "max"]);
  });
  it("matches explicit persisted IDs through native aliases", () => {
    const models = normalizeClaudeNativeModels([
      {
        value: "opus",
        resolvedModel: "claude-opus-5",
        displayName: "Opus",
        supportsFastMode: false,
        supportsEffort: true,
        supportedEffortLevels: ["low", "high"],
      },
    ]);
    const caps = reconcileClaudeModelCapabilities(
      getClaudeModelCapabilities("claude-opus-5"),
      findClaudeNativeModel(models, "claude-opus-5[1m]"),
    );
    expect(caps.optionDescriptors?.some((option) => option.id === "fastMode")).toBe(false);
    const effort = caps.optionDescriptors?.find((option) => option.id === "effort");
    expect(effort?.type === "select" ? effort.options.map((option) => option.id) : []).toEqual([
      "low",
      "high",
      "ultrathink",
    ]);
    const actual = resolveClaudeModelSessionOptions(
      createModelSelection(ProviderInstanceId.make("claudeAgent"), "claude-opus-5", [
        { id: "fastMode", value: true },
        { id: "effort", value: "max" },
      ]),
      caps,
    );
    expect(actual.settings.fastMode).toBeUndefined();
    expect(actual.effectiveEffort).toBe("high");
  });
  it("removes unsupported effort and retains unrelated settings", () => {
    const caps = reconcileClaudeModelCapabilities(getClaudeModelCapabilities("claude-opus-5"), {
      value: "opus",
      displayName: "Opus",
      supportsEffort: false,
    });
    expect(caps.optionDescriptors?.some((option) => option.id === "effort")).toBe(false);
    expect(caps.optionDescriptors?.some((option) => option.id === "outputStyle")).toBe(true);
  });
  it("preserves historical/custom entries and adds a newly discovered model once", () => {
    const fallback = createModelCapabilities({ optionDescriptors: [] });
    const original = [
      { slug: "claude-opus-5", name: "Opus", isCustom: false, capabilities: fallback },
      { slug: "custom", name: "Custom", isCustom: true, capabilities: fallback },
    ];
    const native = normalizeClaudeNativeModels([
      { value: "opus", resolvedModel: "claude-opus-5", displayName: "Opus" },
      { value: "new-model", displayName: "New", supportsFastMode: true },
    ]);
    const result = reconcileClaudeModels(original, native, fallback);
    expect(result.map((row) => row.slug)).toEqual(["claude-opus-5", "custom", "new-model"]);
    expect(
      result[2]?.capabilities?.optionDescriptors?.some((option) => option.id === "fastMode"),
    ).toBe(true);
    expect(reconcileClaudeModels(original, undefined, fallback)).toBe(original);
  });
  it("preserves an authoritative Auto-mode exclusion without inventing one", () => {
    const fallback = createModelCapabilities({ optionDescriptors: [] });
    const models = normalizeClaudeNativeModels([
      { value: "native", displayName: "Native", supportsAutoMode: false },
    ]);
    expect(reconcileClaudeModelCapabilities(fallback, models?.[0]).supportsAutoMode).toBe(false);
    expect(reconcileClaudeModelCapabilities(fallback, undefined).supportsAutoMode).toBeUndefined();
  });
});
