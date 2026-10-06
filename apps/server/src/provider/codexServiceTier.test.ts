import { describe, expect, it } from "vitest";
import {
  ProviderInstanceId,
  type ModelSelection,
  type ServerProviderModel,
} from "@cafecode/contracts";
import {
  acknowledgeCodexServiceTier,
  observeCodexServiceTier,
  resolveCodexServiceTier,
  resolveCodexTurnServiceTier,
} from "./codexServiceTier.ts";
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

describe("native Codex turn routing evidence", () => {
  it.each([
    [null, "default"],
    [undefined, undefined],
    ["priority", "priority"],
    ["ultrafast", "ultrafast"],
    ["future_tier", "future_tier"],
    ["priority\nforged", undefined],
    ["a".repeat(65), undefined],
  ])("distinguishes native %s from absent or invalid evidence", (serviceTier, expected) => {
    const snapshot = observeCodexServiceTier({
      current: undefined,
      providerThreadId: "root",
      serviceTier,
    });
    expect(
      resolveCodexTurnServiceTier({ providerThreadId: "root", snapshot, requestedTier: undefined }),
    ).toBe(expected);
    expect(
      resolveCodexTurnServiceTier({
        providerThreadId: "other",
        snapshot,
        requestedTier: undefined,
      }),
    ).toBeUndefined();
    expect(
      resolveCodexTurnServiceTier({ providerThreadId: "root", snapshot, requestedTier: "default" }),
    ).toBe("default");
  });

  it("preserves inherited Fast across absent settings but clears it on explicit native standard", () => {
    const fast = observeCodexServiceTier({
      current: undefined,
      providerThreadId: "root",
      serviceTier: "priority",
    });
    expect(
      observeCodexServiceTier({ current: fast, providerThreadId: "root", serviceTier: undefined }),
    ).toBe(fast);
    const standard = observeCodexServiceTier({
      current: fast,
      providerThreadId: "root",
      serviceTier: null,
    });
    expect(standard.serviceTier).toBe("default");
    expect(
      observeCodexServiceTier({
        current: fast,
        providerThreadId: "replacement",
        serviceTier: undefined,
      }).serviceTier,
    ).toBeUndefined();
    expect(
      acknowledgeCodexServiceTier({
        current: standard,
        admitted: fast,
        providerThreadId: "root",
        requestedTier: "ultrafast",
      }),
    ).toBe(standard);
  });

  it("retains an accepted explicit override for later inherited turns without rewriting the frozen snapshot", () => {
    const fast = observeCodexServiceTier({
      current: undefined,
      providerThreadId: "root",
      serviceTier: "priority",
    });
    const standard = acknowledgeCodexServiceTier({
      current: fast,
      admitted: fast,
      providerThreadId: "root",
      requestedTier: "default",
    });
    expect(standard?.serviceTier).toBe("default");
    expect(fast.serviceTier).toBe("priority");
    expect(
      acknowledgeCodexServiceTier({
        current: fast,
        admitted: fast,
        providerThreadId: "root",
        requestedTier: undefined,
      }),
    ).toBe(fast);
  });
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
