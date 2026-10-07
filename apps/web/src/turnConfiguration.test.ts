import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderTurnConfiguration,
} from "@cafecode/contracts";
import { describe, expect, it } from "vitest";
import {
  presentTurnConfiguration,
  presentTurnConfigurationSummary,
  readTurnConfiguration,
} from "./turnConfiguration";

const configuration: ProviderTurnConfiguration = {
  version: 1,
  provider: ProviderDriverKind.make("codex"),
  providerInstanceId: ProviderInstanceId.make("codex_personal"),
  providerDisplayName: "Codex Personal",
  model: "gpt-6.1-sol",
  modelDisplayName: "GPT-6.1 Sol",
  effort: "ultra",
  fastMode: true,
  runtimeMode: "full-access",
  interactionMode: "default",
  settingsSource: "submitted",
};

describe("accepted turn configuration presentation", () => {
  it("displays Fast state with the frozen exact tier instead of a stale legacy toggle", () => {
    for (const [serviceTier, label] of [
      ["ultrafast", "Ultra fast"],
      ["default", "Standard"],
    ]) {
      const decoded = readTurnConfiguration({
        turnConfiguration: { ...configuration, serviceTier },
      });
      expect(decoded?.serviceTier).toBe(serviceTier);
      const settings = presentTurnConfiguration(decoded!).settings;
      expect(settings).toContain(`Service tier: ${label}`);
      expect(settings).toContain(serviceTier === "default" ? "Fast off" : "Fast on");
    }
  });

  it.each([
    ["default", "Fast off · Service tier: Standard"],
    ["priority", "Fast on · Service tier: Fast"],
    ["fast", "Fast on · Service tier: Fast"],
    ["ultrafast", "Fast on · Service tier: Ultra fast"],
    ["future_tier", "Service tier: future_tier"],
  ])("uses frozen native %s routing when no override was submitted", (tier, label) => {
    const { fastMode: _fast, ...inherited } = configuration;
    const snapshot = readTurnConfiguration({
      turnConfiguration: { ...inherited, resolvedServiceTier: tier },
    });
    expect(snapshot?.resolvedServiceTier).toBe(tier);
    expect(presentTurnConfiguration(snapshot!).settings).toBe(
      `GPT-6.1 Sol · Effort: Ultra · ${label}`,
    );
    expect(presentTurnConfiguration(snapshot!).sourceDescription).toContain(
      "native session routing",
    );
  });

  it("prefers resolved native routing over conflicting submitted options", () => {
    expect(
      presentTurnConfiguration({
        ...configuration,
        serviceTier: "ultrafast",
        resolvedServiceTier: "default",
      }).settings,
    ).toBe("GPT-6.1 Sol · Effort: Ultra · Fast off · Service tier: Standard");
  });

  it("shows frozen model, Ultra, explicit Fast on, account, and modes", () => {
    const snapshot = readTurnConfiguration({ turnConfiguration: configuration });
    expect(snapshot).toEqual(configuration);
    expect(presentTurnConfiguration(snapshot!)).toEqual({
      settings: "GPT-6.1 Sol · Effort: Ultra · Fast on",
      account: "Account: Codex Personal",
      modes: "Build · Full access",
      source: "Submitted settings",
      sourceDescription:
        "Settings Cafe submitted for this accepted turn. Provider defaults may be inherited; this is not independent execution or billing confirmation.",
    });
  });

  it("does not confuse explicit Fast off with inherited provider defaults", () => {
    expect(presentTurnConfiguration({ ...configuration, fastMode: false }).settings).toBe(
      "GPT-6.1 Sol · Effort: Ultra · Fast off",
    );
    const { fastMode: _fast, effort: _effort, ...defaults } = configuration;
    expect(presentTurnConfiguration(defaults).settings).toBe(
      "GPT-6.1 Sol · Effort: provider default · Fast status not recorded",
    );
  });

  it("uses the frozen slug or explicit default when an old inventory label is absent", () => {
    const { modelDisplayName: _label, ...slugOnly } = configuration;
    expect(presentTurnConfiguration(slugOnly).settings).toContain("gpt-6.1-sol");
    const { model: _model, ...defaults } = slugOnly;
    expect(presentTurnConfiguration(defaults).settings).toContain("Model: provider default");
  });

  it("keeps model and account labels stable across a same-instance rename", () => {
    const snapshot = readTurnConfiguration({ turnConfiguration: configuration })!;
    const renamed = readTurnConfiguration({
      turnConfiguration: {
        ...configuration,
        providerDisplayName: "Renamed Codex",
        modelDisplayName: "New catalog label",
        effort: "max",
        fastMode: false,
      },
    })!;
    expect(renamed.providerInstanceId).toBe(snapshot.providerInstanceId);
    expect(presentTurnConfiguration(snapshot).account).toBe("Account: Codex Personal");
    expect(presentTurnConfiguration(snapshot).settings).toBe(
      "GPT-6.1 Sol · Effort: Ultra · Fast on",
    );
    expect(presentTurnConfiguration(renamed).account).toBe("Account: Renamed Codex");
  });

  it("preserves provider-owned future effort names without prototype property lookup", () => {
    expect(
      presentTurnConfiguration({ ...configuration, effort: "future effort" }).settings,
    ).toContain("Effort: future effort");
    expect(
      presentTurnConfiguration({ ...configuration, effort: "constructor" }).settings,
    ).toContain("Effort: constructor");
  });

  it("discards unrelated fields rather than exposing credential-like metadata", () => {
    expect(
      readTurnConfiguration({
        turnConfiguration: {
          ...configuration,
          authEmail: "private@example.invalid",
          apiKey: "synthetic-secret",
          options: { hidden: "unbounded provider options" },
        },
      }),
    ).toEqual(configuration);
  });

  it.each([
    null,
    undefined,
    [],
    { detail: "Legacy accepted turn/start" },
    { turnConfiguration: null },
    { turnConfiguration: { ...configuration, version: 2 } },
    { turnConfiguration: { ...configuration, fastMode: "false" } },
    { turnConfiguration: { ...configuration, resolvedServiceTier: "priority\nforged" } },
    { turnConfiguration: { ...configuration, resolvedServiceTier: "a".repeat(65) } },
    { turnConfiguration: { ...configuration, runtimeMode: "unsafe" } },
    { turnConfiguration: { ...configuration, providerDisplayName: "name\u0000forged" } },
    { turnConfiguration: { ...configuration, modelDisplayName: "model\u202Eforged" } },
    { turnConfiguration: { ...configuration, modelDisplayName: "model\u2028forged" } },
    { turnConfiguration: { ...configuration, providerDisplayName: "account\u2029forged" } },
    { turnConfiguration: { ...configuration, providerDisplayName: "a".repeat(201) } },
    { turnConfiguration: { ...configuration, model: "m".repeat(201) } },
    { turnConfiguration: { ...configuration, effort: "x".repeat(81) } },
  ])("rejects absent, legacy, or malformed snapshots: %j", (payload) => {
    expect(readTurnConfiguration(payload)).toBeUndefined();
  });

  it("formats non-Codex modes from the same provider-neutral snapshot", () => {
    expect(
      presentTurnConfiguration({
        ...configuration,
        provider: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: ProviderInstanceId.make("claude_work"),
        providerDisplayName: "Claude Work",
        modelDisplayName: "Opus 5.5",
        effort: "max",
        runtimeMode: "auto-accept-edits",
        interactionMode: "plan",
        settingsSource: "session",
      }),
    ).toEqual({
      settings: "Opus 5.5 · Effort: Max · Fast on",
      account: "Account: Claude Work",
      modes: "Plan · Auto-accept edits",
      source: "Existing session settings",
      sourceDescription:
        "Settings of the existing session that accepted this input. Provider defaults may be inherited; this is not independent execution or billing confirmation.",
    });
  });

  it("shows OpenCode variant without inventing an unsupported Fast setting", () => {
    const presentation = presentTurnConfiguration({
      ...configuration,
      provider: ProviderDriverKind.make("opencode"),
      modelDisplayName: "Local OpenCode model",
      effort: "balanced",
    });
    expect(presentation.settings).toBe("Local OpenCode model · Variant: balanced");
    expect(presentation.settings).not.toContain("Fast");
  });

  it("shows Grok effort without inventing an unsupported Fast setting", () => {
    const { effort: _effort, ...providerDefaults } = configuration;
    expect(
      presentTurnConfiguration({
        ...providerDefaults,
        provider: ProviderDriverKind.make("grok"),
        modelDisplayName: "Grok Build",
      }).settings,
    ).toBe("Grok Build · Effort: provider default");
  });
});

describe("one-line work-log turn configuration summary", () => {
  it("keeps model, effort, Fast, the exact account label and both modes on one line", () => {
    expect(presentTurnConfigurationSummary(configuration)).toEqual({
      summary: "GPT-6.1 Sol · Ultra · Fast on · Codex Personal · Build · Full access",
      detail:
        "Submitted settings. Settings Cafe submitted for this accepted turn. Provider defaults may be inherited; this is not independent execution or billing confirmation.",
    });
  });

  it.each([
    ["default", "Fast off", "Standard"],
    ["priority", "Fast on", "Fast"],
    ["fast", "Fast on", "Fast"],
    ["ultrafast", "Ultra fast", "Ultra fast"],
  ])("collapses native %s routing to %s and keeps the tier in the tooltip", (tier, fast, name) => {
    const { fastMode: _fast, ...inherited } = configuration;
    const presentation = presentTurnConfigurationSummary({
      ...inherited,
      resolvedServiceTier: tier,
    });
    expect(presentation.summary).toBe(
      `GPT-6.1 Sol · Ultra · ${fast} · Codex Personal · Build · Full access`,
    );
    expect(presentation.summary).not.toContain("Service tier");
    expect(presentation.detail).toContain(`Service tier: ${name}.`);
    expect(presentation.detail).toContain("native session routing");
  });

  it("keeps unknown future tiers exact on the line", () => {
    expect(
      presentTurnConfigurationSummary({ ...configuration, resolvedServiceTier: "future_tier" })
        .summary,
    ).toContain("Service tier: future_tier");
  });

  it("states unknown Fast and provider defaults explicitly", () => {
    const { fastMode: _fast, effort: _effort, interactionMode: _mode, ...defaults } = configuration;
    const { model: _model, modelDisplayName: _label, ...noModel } = defaults;
    expect(presentTurnConfigurationSummary(noModel).summary).toBe(
      "Default model · Default effort · Fast status not recorded · Codex Personal · Default mode · Full access",
    );
  });

  it("uses the composer's Supervised access name for approval-required turns", () => {
    expect(
      presentTurnConfigurationSummary({ ...configuration, runtimeMode: "approval-required" })
        .summary,
    ).toBe("GPT-6.1 Sol · Ultra · Fast on · Codex Personal · Build · Supervised");
    expect(
      presentTurnConfiguration({ ...configuration, runtimeMode: "approval-required" }).modes,
    ).toBe("Build · Supervised");
  });

  it.each([
    ["default", "approval-required", "Ask permissions"],
    ["default", "auto-accept-edits", "Accept edits"],
    ["default", "full-access", "Bypass permissions"],
    ["plan", "auto-accept-edits", "Plan"],
    ["auto", "full-access", "Auto"],
  ] as const)(
    "names the single native Claude mode for %s + %s",
    (interactionMode, runtimeMode, label) => {
      const summary = presentTurnConfigurationSummary({
        ...configuration,
        provider: ProviderDriverKind.make("claudeAgent"),
        providerDisplayName: "Claude Work",
        modelDisplayName: "Opus 5.5",
        effort: "max",
        interactionMode,
        runtimeMode,
      }).summary;
      expect(summary).toBe(`Opus 5.5 · Max · Fast on · Claude Work · ${label}`);
    },
  );

  it("keeps the generic pair when a Claude snapshot has no interaction mode", () => {
    const { interactionMode: _mode, ...providerDefault } = configuration;
    expect(
      presentTurnConfigurationSummary({
        ...providerDefault,
        provider: ProviderDriverKind.make("claudeAgent"),
        providerDisplayName: "Claude Work",
        modelDisplayName: "Opus 5.5",
        runtimeMode: "approval-required",
      }).summary,
    ).toBe("Opus 5.5 · Ultra · Fast on · Claude Work · Default mode · Supervised");
  });

  it("names Grok's native mode from its own option list", () => {
    const { fastMode: _fast, ...noFast } = configuration;
    expect(
      presentTurnConfigurationSummary({
        ...noFast,
        provider: ProviderDriverKind.make("grok"),
        providerDisplayName: "Grok",
        modelDisplayName: "Grok Build",
        interactionMode: "default",
        runtimeMode: "auto-accept-edits",
      }).summary,
    ).toBe("Grok Build · Ultra · Grok · Accept edits");
  });

  it("omits Fast for providers without it and keeps the session source in the tooltip", () => {
    const presentation = presentTurnConfigurationSummary({
      ...configuration,
      provider: ProviderDriverKind.make("opencode"),
      modelDisplayName: "Local OpenCode model",
      effort: "balanced",
      settingsSource: "session",
    });
    expect(presentation.summary).toBe(
      "Local OpenCode model · balanced · Codex Personal · Build · Full access",
    );
    expect(presentation.detail.startsWith("Existing session settings.")).toBe(true);
  });
});
