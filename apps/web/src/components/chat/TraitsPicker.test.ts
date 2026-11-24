import type { ProviderOptionDescriptor } from "@cafecode/contracts";
import { describe, expect, it } from "vitest";
import { getTraitsTriggerEffortLabel } from "./TraitsPicker";

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

describe("getTraitsTriggerEffortLabel", () => {
  it("keeps requested native Ultracode out of the thinking label", () => {
    const effort = selectDescriptor("effort", "Reasoning", [{ id: "max", label: "Max" }], "max");
    const ultracode: Extract<ProviderOptionDescriptor, { type: "boolean" }> = {
      id: "ultracode",
      label: "Ultracode",
      type: "boolean",
    };
    expect(getTraitsTriggerEffortLabel([effort, ultracode], false)).toBe("Max");
    expect(getTraitsTriggerEffortLabel([effort, { ...ultracode, currentValue: true }], false)).toBe(
      "Max",
    );
    expect(
      getTraitsTriggerEffortLabel([effort, { ...ultracode, currentValue: false }], false),
    ).toBe("Max");
  });
  it("keeps context and provider-wide preferences out of the thinking label", () => {
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
      getTraitsTriggerEffortLabel([effort, contextWindow, outputStyle, progressSummaries], false),
    ).toBe("Max");
  });

  it("keeps speed out of the thinking label", () => {
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

    expect(getTraitsTriggerEffortLabel([effort, fastMode], false)).toBe("High");
  });
});

describe("getTraitsTriggerEffortLabel", () => {
  const effort = selectDescriptor(
    "effort",
    "Reasoning",
    [
      { id: "high", label: "High", isDefault: true },
      { id: "xhigh", label: "Extra high" },
    ],
    "xhigh",
  );
  const contextWindow = selectDescriptor(
    "contextWindow",
    "Context Window",
    [{ id: "1m", label: "1M", isDefault: true }],
    "1m",
  );
  const fastMode: Extract<ProviderOptionDescriptor, { type: "boolean" }> = {
    id: "fastMode",
    label: "Fast Mode",
    type: "boolean",
    currentValue: false,
  };
  const serviceTier = selectDescriptor(
    "serviceTier",
    "Service tier",
    [{ id: "default", label: "Standard" }],
    "default",
  );

  it("names only the thinking level, leaving service tier, speed and context to the menu", () => {
    expect(getTraitsTriggerEffortLabel([serviceTier, fastMode, contextWindow, effort], false)).toBe(
      "Extra high",
    );
  });

  it("shows Ultrathink when the prompt controls the effort", () => {
    expect(getTraitsTriggerEffortLabel([effort, contextWindow], true)).toBe("Ultrathink");
  });

  it("leaves Ultracode and Daybreak to the menu", () => {
    const ultracode: Extract<ProviderOptionDescriptor, { type: "boolean" }> = {
      id: "ultracode",
      label: "Ultracode",
      type: "boolean",
      currentValue: true,
    };
    const daybreak = selectDescriptor(
      "cyberAccessProgram",
      "Daybreak",
      [{ id: "daybreakRed", label: "Red" }],
      "daybreakRed",
    );
    expect(getTraitsTriggerEffortLabel([daybreak, effort, ultracode], false)).toBe("Extra high");
  });

  it("is empty when there is no thinking setting, so the caller can name the menu", () => {
    expect(getTraitsTriggerEffortLabel([serviceTier, fastMode, contextWindow], false)).toBe("");
  });
});
