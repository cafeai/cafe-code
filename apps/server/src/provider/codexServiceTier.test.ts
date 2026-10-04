import { describe, expect, it } from "vitest";
import {
  ProviderInstanceId,
  type ModelSelection,
  type ServerProviderModel,
} from "@cafecode/contracts";
import { resolveCodexServiceTier } from "./codexServiceTier.ts";
const instance = ProviderInstanceId.make("codex-personal");
const models: ServerProviderModel[] = [
  {
    slug: "sol",
    name: "Sol",
    isCustom: false,
    capabilities: {
      optionDescriptors: [
        {
          id: "serviceTier",
          label: "Service tier",
          type: "select",
          options: [
            { id: "default", label: "Standard" },
            { id: "priority", label: "Fast" },
            { id: "ultrafast", label: "Ultra fast" },
          ],
        },
      ],
    },
  },
];
const selection = (options: ModelSelection["options"], model = "sol"): ModelSelection => ({
  instanceId: instance,
  model,
  ...(options ? { options } : {}),
});
describe("exact Codex service tier admission", () => {
  it.each(["default", "priority", "ultrafast"])(
    "retains the advertised wire id %s through JSON resume",
    (tier) => {
      const saved = JSON.parse(JSON.stringify(selection([{ id: "serviceTier", value: tier }])));
      expect(resolveCodexServiceTier(saved, instance, models)).toEqual({ serviceTier: tier });
    },
  );
  it("migrates Fast without upgrading it and distinguishes omission from explicit Off", () => {
    expect(resolveCodexServiceTier(selection(undefined), instance, models)).toEqual({});
    expect(
      resolveCodexServiceTier(selection([{ id: "fastMode", value: true }]), instance, models),
    ).toEqual({ serviceTier: "priority" });
    expect(
      resolveCodexServiceTier(selection([{ id: "fastMode", value: false }]), instance, models),
    ).toEqual({ serviceTier: "default" });
    expect(
      resolveCodexServiceTier(
        selection([
          { id: "fastMode", value: true },
          { id: "serviceTier", value: "default" },
        ]),
        instance,
        models,
      ),
    ).toEqual({ serviceTier: "default" });
  });
  it("rejects unknown/removed model/account tiers without borrowing another capability", () => {
    const requested = selection([{ id: "serviceTier", value: "ultrafast" }]);
    expect(resolveCodexServiceTier(requested, instance, []).error).toContain(
      "no longer advertises",
    );
    expect(
      resolveCodexServiceTier({ ...requested, model: "bedrock/sol" }, instance, models).error,
    ).toBeDefined();
    expect(resolveCodexServiceTier(requested, ProviderInstanceId.make("other"), models)).toEqual(
      {},
    );
    expect(
      resolveCodexServiceTier(
        selection([{ id: "serviceTier", value: "unknown" }]),
        instance,
        models,
      ).error,
    ).toBeDefined();
    expect(
      resolveCodexServiceTier(selection([{ id: "serviceTier", value: true }]), instance, models)
        .error,
    ).toContain("invalid");
  });
  it("preserves legacy fallback Fast but rejects a revoked modern Fast choice", () => {
    const legacy = selection([{ id: "fastMode", value: true }]);
    expect(resolveCodexServiceTier(legacy, instance, undefined)).toEqual({
      serviceTier: "priority",
    });
    expect(
      resolveCodexServiceTier(legacy, instance, [
        {
          ...models[0]!,
          capabilities: {
            optionDescriptors: [{ id: "serviceTier", label: "Tier", type: "select", options: [] }],
          },
        },
      ]).error,
    ).toBeDefined();
  });
});
