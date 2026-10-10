import { ProviderInstanceId, type ServerProviderModel } from "@cafecode/contracts";
import { createModelSelection } from "@cafecode/shared/model";
import { describe, expect, it } from "vitest";
import { makeCodexDaybreakDescriptor, resolveCodexDaybreak } from "./codexDaybreak.ts";

const account = ProviderInstanceId.make("codex-test");
const models: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "blue",
    name: "Blue-capable",
    isCustom: false,
    capabilities: {
      optionDescriptors: [makeCodexDaybreakDescriptor(["standard", "daybreakBlue"])!],
    },
  },
  {
    slug: "red",
    name: "Red-capable",
    isCustom: false,
    capabilities: {
      optionDescriptors: [
        makeCodexDaybreakDescriptor(["standard", "daybreakBlue", "daybreakRed"])!,
      ],
    },
  },
  {
    slug: "red-only",
    name: "Program-only",
    isCustom: false,
    capabilities: {
      optionDescriptors: [makeCodexDaybreakDescriptor(["daybreakRed"])!],
    },
  },
];
const selection = (model: string, value: string | boolean) =>
  createModelSelection(account, model, [{ id: "cyberAccessProgram", value }]);

describe("Codex Daybreak", () => {
  it("does not infer account access from absent or Standard-only metadata", () => {
    expect(makeCodexDaybreakDescriptor(undefined)).toBeUndefined();
    expect(makeCodexDaybreakDescriptor([])).toBeUndefined();
    expect(makeCodexDaybreakDescriptor(["standard"])).toBeUndefined();
  });
  it("offers Off/On and chooses the strongest supported program without opting in", () => {
    expect(models[0]?.capabilities?.optionDescriptors?.[0]).toMatchObject({
      currentValue: "standard",
      options: [
        { id: "standard", label: "Off" },
        { id: "daybreakBlue", label: "On" },
      ],
    });
    expect(models[1]?.capabilities?.optionDescriptors?.[0]).toMatchObject({
      currentValue: "standard",
      options: [
        { id: "standard", label: "Off" },
        { id: "daybreakRed", label: "On" },
      ],
    });
    expect(resolveCodexDaybreak(selection("blue", "daybreakBlue"), account, models)).toEqual({
      cyberAccessProgram: "daybreakBlue",
    });
    expect(resolveCodexDaybreak(selection("red", "daybreakRed"), account, models)).toEqual({
      cyberAccessProgram: "daybreakRed",
    });
  });
  it("requests explicit Standard for Off, including old catalogs, and preserves omission", () => {
    expect(resolveCodexDaybreak(selection("blue", "standard"), account, models)).toEqual({
      cyberAccessProgram: "standard",
    });
    expect(resolveCodexDaybreak(selection("unknown", "standard"), account, undefined)).toEqual({
      cyberAccessProgram: "standard",
    });
    expect(resolveCodexDaybreak(createModelSelection(account, "blue"), account, models)).toEqual(
      {},
    );
  });
  it("keeps On across models, using Red where supported and Blue otherwise", () => {
    expect(resolveCodexDaybreak(selection("blue", "daybreakRed"), account, models)).toEqual({
      cyberAccessProgram: "daybreakBlue",
    });
    expect(resolveCodexDaybreak(selection("red", "daybreakBlue"), account, models)).toEqual({
      cyberAccessProgram: "daybreakRed",
    });
    expect(resolveCodexDaybreak(selection("red-only", "daybreakBlue"), account, models)).toEqual({
      cyberAccessProgram: "daybreakRed",
    });
  });
  it("does not borrow another model or account's approval or manufacture Standard for a program-only model", () => {
    for (const [model, value] of [
      ["unknown", "daybreakBlue"],
      ["red-only", "standard"],
      ["blue", true],
      ["blue", "arbitrary"],
    ] as const) {
      expect(resolveCodexDaybreak(selection(model, value), account, models).error).toBeDefined();
    }
    expect(
      resolveCodexDaybreak(
        selection("red", "daybreakRed"),
        ProviderInstanceId.make("another-account"),
        models,
      ),
    ).toEqual({});
    expect(resolveCodexDaybreak(selection("blue", "daybreakBlue"), account, [])).toHaveProperty(
      "error",
    );
    expect(models[2]?.capabilities?.optionDescriptors?.[0]).not.toHaveProperty("currentValue");
  });
});
