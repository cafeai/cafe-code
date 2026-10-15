import { describe, expect, it } from "vitest";
import { axiomModelToCafe } from "./AxiomDriver.ts";
import type { AxiomModel } from "../acp/AxiomAcpSupport.ts";

const model: AxiomModel = {
  id: "tinfoil-deepseek-v4-1-flash",
  label: "Tinfoil · DeepSeek V4.1 Flash",
  shortLabel: "DeepSeek V4.1 Flash",
  providerId: "tinfoil",
  providerLabel: "Tinfoil",
  upstreamModel: "deepseek-v4-1-flash",
  thinkingLevels: [],
  contextWindowTokens: 100000,
  maxOutputTokens: 4000,
  autoCompactThresholdTokens: 85000,
  supportsImages: false,
  fileMimeTypes: [],
};

describe("Axiom model presentation", () => {
  it.each([
    { levels: ["disabled", "enabled"], selected: "enabled", label: "Enabled" },
    { levels: ["low", "medium", "high"], selected: "medium", label: "Medium" },
    { levels: ["high", "xhigh"], selected: "high", label: "High" },
  ])("exposes a supported concrete default for $levels", ({ levels, selected, label }) => {
    const result = axiomModelToCafe({ ...model, thinkingLevels: levels });
    expect(result.slug).toBe(model.id);
    expect(result.name).toBe("DeepSeek V4.1 Flash");
    expect(result.shortName).toBe("DeepSeek V4.1 Flash");
    expect(result.subProvider).toBeUndefined();
    const descriptor = result.capabilities?.optionDescriptors?.[0];
    expect(descriptor?.type).toBe("select");
    if (descriptor?.type !== "select") throw new Error("Thinking selector missing");
    expect(descriptor.options.filter((option) => option.isDefault)).toEqual([
      { id: selected, label, isDefault: true },
    ]);
  });

  it("does not invent thinking controls for a model without supported levels", () => {
    expect(axiomModelToCafe(model).capabilities?.optionDescriptors).toEqual([]);
  });
});
