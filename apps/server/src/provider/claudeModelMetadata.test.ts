import { describe, expect, it } from "vitest";
import { createModelCapabilities } from "@cafecode/shared/model";
import {
  formatClaudeModelUpgradeMessage,
  getBuiltInClaudeModelsForVersion,
  getClaudeModelCapabilities,
  resolveClaudeEffort,
} from "./Layers/ClaudeProvider.ts";
import {
  findClaudeNativeModel,
  gateClaudeUltracodeCapabilities,
  normalizeClaudeNativeModels,
  reconcileClaudeModelCapabilities,
  reconcileClaudeModels,
  supportsClaudeUltracode,
} from "./claudeModelMetadata.ts";
import { resolveClaudeModelSessionOptions } from "./Layers/ClaudeAdapter.ts";
import { createModelSelection } from "@cafecode/shared/model";
import { ProviderInstanceId } from "@cafecode/contracts";

describe("Claude native model metadata", () => {
  it("gates Haiku 5.5 on its native CLI release and preserves Haiku 4.5", () => {
    for (const version of [
      undefined,
      null,
      "unknown",
      "2.1.292",
      "2.1.293-beta.1",
      "2.2.0-beta.1",
      "2.1.293+build",
      "v2.1.293",
      "02.1.293",
      "2.1",
      "2.1.293 ",
      "2.1.293" + " ".repeat(64),
      "9007199254740992.1.293",
    ]) {
      const models = getBuiltInClaudeModelsForVersion(version);
      expect(models.some((model) => model.slug === "claude-haiku-5-5")).toBe(false);
      expect(models.some((model) => model.slug === "claude-haiku-4-5")).toBe(true);
    }
    for (const version of ["2.1.293", "2.1.294", "2.2.0"]) {
      const models = getBuiltInClaudeModelsForVersion(version);
      expect(models.filter((model) => model.slug === "claude-haiku-5-5")).toHaveLength(1);
      expect(models.some((model) => model.slug === "claude-haiku-4-5")).toBe(true);
    }
    expect(formatClaudeModelUpgradeMessage("2.1.292")).toBe(
      "Claude Code v2.1.292 is too old for Claude Haiku 5.5. Upgrade to v2.1.293 or newer to access it.",
    );
    expect(formatClaudeModelUpgradeMessage("2.1.293")).toBeUndefined();
  });

  it("uses Haiku 5.5's Medium default without inventing a context variant or disabling thinking", () => {
    const caps = getClaudeModelCapabilities("claude-haiku-5-5");
    const descriptors = caps.optionDescriptors ?? [];
    const effort = descriptors.find((option) => option.id === "effort");
    expect(effort?.type === "select" ? effort.options.map((option) => option.id) : []).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(effort?.currentValue).toBe("medium");
    expect(
      effort?.type === "select" ? effort.options.filter((option) => option.isDefault) : [],
    ).toEqual([{ id: "medium", label: "Medium", isDefault: true }]);
    expect(resolveClaudeEffort(caps, undefined)).toBe("medium");
    expect(resolveClaudeEffort(caps, "high")).toBe("high");
    expect(resolveClaudeEffort(caps, "max")).toBe("max");
    expect(
      descriptors.some((option) => ["contextWindow", "thinking", "fastMode"].includes(option.id)),
    ).toBe(false);
    expect(
      descriptors.some((option) => option.id === "ultracode" && option.type === "boolean"),
    ).toBe(true);
    expect(descriptors.some((option) => option.id === "outputStyle")).toBe(true);
  });

  it("keeps live Haiku metadata authoritative over the new static fallback", () => {
    const caps = getClaudeModelCapabilities("claude-haiku-5-5");
    const native = normalizeClaudeNativeModels([
      {
        value: "haiku",
        resolvedModel: "claude-haiku-5-5",
        displayName: "Account Haiku",
        supportsEffort: true,
        supportedEffortLevels: ["low", "high"],
        supportsFastMode: false,
      },
    ]);
    const narrowed = reconcileClaudeModelCapabilities(
      caps,
      findClaudeNativeModel(native, "claude-haiku-5-5"),
    );
    const effort = narrowed.optionDescriptors?.find((option) => option.id === "effort");
    expect(effort?.type === "select" ? effort.options.map((option) => option.id) : []).toEqual([
      "low",
      "high",
    ]);
    expect(resolveClaudeEffort(narrowed, undefined)).toBe("high");
    expect(narrowed.optionDescriptors?.some((option) => option.id === "ultracode")).toBe(false);
    expect(narrowed.optionDescriptors?.some((option) => option.id === "fastMode")).toBe(false);
    const allLevels = reconcileClaudeModelCapabilities(caps, {
      value: "haiku",
      displayName: "Account Haiku",
      supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    });
    expect(resolveClaudeEffort(allLevels, undefined)).toBe("medium");
  });

  it("qualifies independent Ultracode against the actual CLI version", () => {
    for (const version of [
      undefined,
      null,
      "unknown",
      "2.1.283",
      "2.1.284-beta.1",
      "2.1.288-rc.1",
      "2.2.0-beta.1",
      "2.1.288" + " ".repeat(64),
    ]) {
      expect(supportsClaudeUltracode(version)).toBe(false);
      expect(
        gateClaudeUltracodeCapabilities(
          getClaudeModelCapabilities("claude-opus-5"),
          version,
        ).optionDescriptors?.some((descriptor) => descriptor.id === "ultracode"),
      ).toBe(false);
    }
    for (const version of ["2.1.284", "2.1.288", "2.2.0"]) {
      expect(supportsClaudeUltracode(version)).toBe(true);
      expect(
        gateClaudeUltracodeCapabilities(
          getClaudeModelCapabilities("claude-opus-5"),
          version,
        ).optionDescriptors?.some((descriptor) => descriptor.id === "ultracode"),
      ).toBe(true);
    }
  });

  it("adds a distinct workflow Boolean only for affirmative native xhigh support", () => {
    const fallback = createModelCapabilities({ optionDescriptors: [] });
    const discovered = reconcileClaudeModelCapabilities(fallback, {
      value: "custom-native",
      displayName: "Custom",
      supportsEffort: true,
      supportedEffortLevels: ["low", "high", "xhigh", "max"],
    });
    expect(
      discovered.optionDescriptors?.find((descriptor) => descriptor.id === "ultracode"),
    ).toMatchObject({ id: "ultracode", type: "boolean" });
    const effort = discovered.optionDescriptors?.find((descriptor) => descriptor.id === "effort");
    expect(effort?.type === "select" ? effort.options.map((entry) => entry.id) : []).toEqual([
      "low",
      "high",
      "xhigh",
      "max",
    ]);
    expect(
      reconcileClaudeModelCapabilities(fallback, {
        value: "custom-native",
        displayName: "Custom",
        supportsEffort: true,
      }).optionDescriptors?.some((descriptor) => descriptor.id === "ultracode"),
    ).toBe(false);
    expect(
      getClaudeModelCapabilities("claude-haiku-4-5").optionDescriptors?.some(
        (descriptor) => descriptor.id === "ultracode",
      ),
    ).toBe(false);
  });
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
    expect(caps.optionDescriptors?.some((option) => option.id === "ultracode")).toBe(false);
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
    expect(caps.optionDescriptors?.some((option) => option.id === "ultracode")).toBe(false);
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
