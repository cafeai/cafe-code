import type { ProviderOptionDescriptor } from "@cafecode/contracts";
import { describe, expect, it } from "vitest";
import { getTraitsTriggerLabel } from "./TraitsPicker";

function selectDescriptor(
  id: string,
  label: string,
  options: ReadonlyArray<{ id: string; label: string; isDefault?: boolean }>,
  currentValue: string,
): Extract<ProviderOptionDescriptor, { type: "select" }> {
  return {
    id,
    label,
    type: "select",
    options: [...options],
    currentValue,
  };
}

describe("getTraitsTriggerLabel", () => {
  it("keeps the Claude reasoning and context summary compact", () => {
    const effort = selectDescriptor(
      "effort",
      "Reasoning",
      [
        { id: "high", label: "High", isDefault: true },
        { id: "max", label: "Max" },
      ],
      "max",
    );
    const contextWindow = selectDescriptor(
      "contextWindow",
      "Context Window",
      [{ id: "1m", label: "1M", isDefault: true }],
      "1m",
    );
    const outputStyle = selectDescriptor(
      "outputStyle",
      "Output Style",
      [{ id: "providerDefault", label: "Provider Default", isDefault: true }],
      "providerDefault",
    );
    const progressSummaries: Extract<ProviderOptionDescriptor, { type: "boolean" }> = {
      id: "agentProgressSummaries",
      label: "Subagent Progress Summaries",
      type: "boolean",
      currentValue: true,
    };

    expect(
      getTraitsTriggerLabel([effort, contextWindow, outputStyle, progressSummaries], effort, false),
    ).toBe("Max · 1M");
  });

  it("continues to summarize non-menu-only boolean controls", () => {
    const effort = selectDescriptor(
      "effort",
      "Reasoning",
      [{ id: "high", label: "High", isDefault: true }],
      "high",
    );
    const fastMode: Extract<ProviderOptionDescriptor, { type: "boolean" }> = {
      id: "fastMode",
      label: "Fast Mode",
      type: "boolean",
      currentValue: true,
    };

    expect(getTraitsTriggerLabel([effort, fastMode], effort, false)).toBe("High · Fast");
  });
});
