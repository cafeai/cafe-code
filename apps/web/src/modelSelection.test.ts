import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@cafecode/contracts";
import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@cafecode/contracts/settings";
import { describe, expect, it } from "vitest";
import { deriveProviderInstanceEntries } from "./providerInstances";
import {
  getAppModelOptionsForInstance,
  resolveAppModelSelection,
  resolveAppModelSelectionForInstance,
  resolveAppModelSelectionState,
} from "./modelSelection";

function provider(input: {
  provider?: ProviderDriverKind;
  instanceId: string;
  models?: ReadonlyArray<string>;
}): ServerProvider {
  const driver =
    input.provider ??
    (input.instanceId.startsWith("claude_")
      ? ProviderDriverKind.make("claudeAgent")
      : ProviderDriverKind.make("codex"));
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: (input.models ?? []).map((slug) => ({
      slug,
      name: slug,
      isCustom: false,
      capabilities: {},
    })),
    slashCommands: [],
    skills: [],
  };
}

function settingsWithProviderInstances(): UnifiedSettings {
  return {
    ...DEFAULT_UNIFIED_SETTINGS,
    providerInstances: {
      [ProviderInstanceId.make("claudeAgent")]: {
        driver: ProviderDriverKind.make("claudeAgent"),
        config: { customModels: [] },
      },
      [ProviderInstanceId.make("claude_openrouter")]: {
        driver: ProviderDriverKind.make("claudeAgent"),
        config: { customModels: ["openai/gpt-5.5"] },
      },
    },
  };
}

describe("model selection before provider hydration", () => {
  it.each([
    ["codex", "gpt-5.6-sol", "gpt-5.6-sol"],
    ["codex", "gpt-5.6", "gpt-5.6-sol"],
    ["claudeAgent", "claude-fable-5-1", "claude-fable-5-1"],
    ["codex", null, "gpt-6-astra"],
  ])("preserves %s selection %s without a catalog", (driver, selected, expected) => {
    expect(
      resolveAppModelSelection(
        ProviderDriverKind.make(driver),
        DEFAULT_UNIFIED_SETTINGS,
        [],
        selected,
      ),
    ).toBe(expected);
  });

  it("still validates against an available catalog", () => {
    expect(
      resolveAppModelSelection(
        ProviderDriverKind.make("codex"),
        DEFAULT_UNIFIED_SETTINGS,
        [provider({ instanceId: "codex", models: ["gpt-6-astra"] })],
        "unavailable-model",
      ),
    ).toBe("gpt-6-astra");
  });
});

describe("instance-scoped model selection", () => {
  it("keeps custom models on the provider instance that declared them", () => {
    const providers = [
      provider({
        instanceId: "claudeAgent",
        models: ["claude-sonnet-4-6"],
      }),
      provider({
        instanceId: "claude_openrouter",
        models: ["claude-sonnet-4-6"],
      }),
    ];
    const entries = deriveProviderInstanceEntries(providers);
    const stock = entries.find((entry) => entry.instanceId === "claudeAgent")!;
    const openrouter = entries.find((entry) => entry.instanceId === "claude_openrouter")!;

    expect(
      getAppModelOptionsForInstance(settingsWithProviderInstances(), stock).map(
        (option) => option.slug,
      ),
    ).not.toContain("openai/gpt-5.5");
    expect(
      getAppModelOptionsForInstance(settingsWithProviderInstances(), openrouter).map(
        (option) => option.slug,
      ),
    ).toContain("openai/gpt-5.5");
  });

  it("resolves a custom slug against the selected custom instance", () => {
    const providers = [
      provider({ provider: ProviderDriverKind.make("claudeAgent"), instanceId: "claudeAgent" }),
      provider({
        provider: ProviderDriverKind.make("claudeAgent"),
        instanceId: "claude_openrouter",
      }),
    ];

    expect(
      resolveAppModelSelectionForInstance(
        ProviderInstanceId.make("claude_openrouter"),
        settingsWithProviderInstances(),
        providers,
        "openai/gpt-5.5",
      ),
    ).toBe("openai/gpt-5.5");
  });

  it("hides server models from the instance option list", () => {
    const providers = [
      provider({
        instanceId: "claudeAgent",
        models: ["claude-opus-4-6", "claude-sonnet-4-6"],
      }),
    ];
    const settings: UnifiedSettings = {
      ...settingsWithProviderInstances(),
      providerModelPreferences: {
        [ProviderInstanceId.make("claudeAgent")]: {
          hiddenModels: ["claude-opus-4-6"],
          modelOrder: [],
        },
      },
    };
    const stock = deriveProviderInstanceEntries(providers).find(
      (entry) => entry.instanceId === "claudeAgent",
    )!;

    expect(getAppModelOptionsForInstance(settings, stock).map((option) => option.slug)).toEqual([
      "claude-sonnet-4-6",
    ]);
  });

  it("applies persisted per-instance model ordering", () => {
    const providers = [
      provider({
        instanceId: "claudeAgent",
        models: ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"],
      }),
    ];
    const settings: UnifiedSettings = {
      ...settingsWithProviderInstances(),
      providerModelPreferences: {
        [ProviderInstanceId.make("claudeAgent")]: {
          hiddenModels: [],
          modelOrder: ["claude-haiku-4-5", "claude-opus-4-6"],
        },
      },
    };
    const stock = deriveProviderInstanceEntries(providers).find(
      (entry) => entry.instanceId === "claudeAgent",
    )!;

    expect(getAppModelOptionsForInstance(settings, stock).map((option) => option.slug)).toEqual([
      "claude-haiku-4-5",
      "claude-opus-4-6",
      "claude-sonnet-4-6",
    ]);
  });

  it("falls back when the selected model is hidden", () => {
    const providers = [
      provider({
        instanceId: "claudeAgent",
        models: ["claude-opus-4-6", "claude-sonnet-4-6"],
      }),
    ];
    const settings: UnifiedSettings = {
      ...settingsWithProviderInstances(),
      providerModelPreferences: {
        [ProviderInstanceId.make("claudeAgent")]: {
          hiddenModels: ["claude-opus-4-6"],
          modelOrder: [],
        },
      },
    };

    expect(
      resolveAppModelSelectionForInstance(
        ProviderInstanceId.make("claudeAgent"),
        settings,
        providers,
        "claude-opus-4-6",
      ),
    ).toBe("claude-sonnet-4-6");
  });

  it("falls back instead of resolving a custom slug against the wrong instance", () => {
    const providers = [
      provider({
        instanceId: "claudeAgent",
        models: ["claude-sonnet-4-6"],
      }),
      provider({
        instanceId: "claude_openrouter",
        models: ["claude-sonnet-4-6"],
      }),
    ];

    expect(
      resolveAppModelSelectionForInstance(
        ProviderInstanceId.make("claudeAgent"),
        settingsWithProviderInstances(),
        providers,
        "openai/gpt-5.5",
      ),
    ).toBe("claude-sonnet-4-6");
  });

  it("preserves custom provider instances in settings model selection", () => {
    const providers = [
      provider({
        instanceId: "claudeAgent",
        models: ["claude-sonnet-4-6"],
      }),
      provider({
        instanceId: "claude_openrouter",
        models: ["claude-sonnet-4-6"],
      }),
    ];
    const settings: UnifiedSettings = {
      ...settingsWithProviderInstances(),
      textGenerationModelSelection: {
        instanceId: ProviderInstanceId.make("claude_openrouter"),
        model: "openai/gpt-5.5",
      },
    };

    expect(resolveAppModelSelectionState(settings, providers)).toEqual({
      instanceId: ProviderInstanceId.make("claude_openrouter"),
      model: "openai/gpt-5.5",
    });
  });
});

function codexProvider(instanceId = "codex"): ServerProvider {
  const snapshot = provider({
    instanceId,
    // Deliberately advertise the chat default first. The helper fallback
    // must select its own default without changing the conversation picker.
    models: ["gpt-6-astra", "gpt-6.1-sol", "gpt-5.6-luna"],
  });
  return {
    ...snapshot,
    models: snapshot.models.map(({ slug, name, isCustom }) => ({
      slug,
      name,
      isCustom,
      capabilities: {
        optionDescriptors: [
          {
            id: "reasoningEffort",
            label: "Reasoning",
            type: "select",
            options: [
              { id: "low", label: "Low", isDefault: true },
              { id: "medium", label: "Medium" },
              { id: "high", label: "High" },
              { id: "ultra", label: "Ultra" },
            ],
            currentValue: "low",
          },
          { id: "fastMode", label: "Fast", type: "boolean", currentValue: false },
        ],
      },
    })),
  };
}

describe("text-generation helper selection", () => {
  it("uses Sol 6.1 Medium instead of the native chat model and Low effort defaults", () => {
    expect(resolveAppModelSelectionState(DEFAULT_UNIFIED_SETTINGS, [codexProvider()])).toEqual({
      instanceId: "codex",
      model: "gpt-6.1-sol",
      options: [
        { id: "reasoningEffort", value: "medium" },
        { id: "fastMode", value: false },
      ],
    });
    expect(
      resolveAppModelSelection(
        ProviderDriverKind.make("codex"),
        DEFAULT_UNIFIED_SETTINGS,
        [codexProvider()],
        null,
      ),
    ).toBe("gpt-6-astra");
  });

  it("fills a genuinely absent helper selection with the same model and effort", () => {
    const settings = { ...DEFAULT_UNIFIED_SETTINGS };
    // Exercise the bootstrap/legacy absence branch even though decoded modern
    // settings always materialize the contracts-level default.
    Reflect.deleteProperty(settings, "textGenerationModelSelection");
    const result = resolveAppModelSelectionState(settings, [codexProvider()]);
    expect(result.model).toBe("gpt-6.1-sol");
    expect(result.options).toContainEqual({ id: "reasoningEffort", value: "medium" });
  });

  it("preserves an explicitly saved model, effort, and Fast setting on its exact account", () => {
    const selection = {
      instanceId: ProviderInstanceId.make("codex_work"),
      model: "gpt-5.6-luna",
      options: [
        { id: "reasoningEffort", value: "ultra" },
        { id: "fastMode", value: true },
      ],
    };
    expect(
      resolveAppModelSelectionState(
        { ...DEFAULT_UNIFIED_SETTINGS, textGenerationModelSelection: selection },
        [codexProvider(), codexProvider("codex_work")],
      ),
    ).toEqual(selection);
  });

  it("defaults only omitted helper effort without replacing a saved model or Fast choice", () => {
    const result = resolveAppModelSelectionState(
      {
        ...DEFAULT_UNIFIED_SETTINGS,
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.6-luna",
          options: [{ id: "fastMode", value: true }],
        },
      },
      [codexProvider()],
    );
    expect(result.model).toBe("gpt-5.6-luna");
    expect(result.options).toEqual([
      { id: "reasoningEffort", value: "medium" },
      { id: "fastMode", value: true },
    ]);
  });

  it("prefers the helper default when a disabled account falls back to available Codex", () => {
    const result = resolveAppModelSelectionState(
      {
        ...DEFAULT_UNIFIED_SETTINGS,
        textGenerationModelSelection: {
          instanceId: ProviderInstanceId.make("codex_disabled"),
          model: "gpt-5.6-luna",
          options: [{ id: "reasoningEffort", value: "ultra" }],
        },
      },
      [{ ...codexProvider("codex_disabled"), enabled: false }, codexProvider()],
    );
    expect(result.instanceId).toBe("codex");
    expect(result.model).toBe("gpt-6.1-sol");
    expect(result.options).toContainEqual({ id: "reasoningEffort", value: "medium" });
  });

  it("displays the requested helper default even when the catalog does not list it", () => {
    const snapshot = codexProvider();
    const result = resolveAppModelSelectionState(DEFAULT_UNIFIED_SETTINGS, [
      { ...snapshot, models: snapshot.models.filter((model) => model.slug !== "gpt-6.1-sol") },
    ]);
    expect(result).toEqual({
      instanceId: "codex",
      model: "gpt-6.1-sol",
      options: [{ id: "reasoningEffort", value: "medium" }],
    });
  });

  it.each(["codex", "claudeAgent"])(
    "preserves a saved uncatalogued %s helper model and options on its exact account",
    (driver) => {
      const selection = {
        instanceId: ProviderInstanceId.make("custom_account"),
        model: "gateway/private-helper-model",
        options: [
          { id: "reasoningEffort", value: "high" },
          { id: "customOption", value: "saved-choice" },
        ],
      };
      expect(
        resolveAppModelSelectionState(
          { ...DEFAULT_UNIFIED_SETTINGS, textGenerationModelSelection: selection },
          [
            codexProvider(),
            provider({
              provider: ProviderDriverKind.make(driver),
              instanceId: selection.instanceId,
              models: ["different-catalog-model"],
            }),
          ],
        ),
      ).toEqual(selection);
    },
  );

  it.each([{}, null])("preserves explicit helper options with capabilities %j", (capabilities) => {
    const selection = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-6.1-sol",
      options: [{ id: "reasoningEffort", value: "high" }],
    };
    expect(
      resolveAppModelSelectionState(
        { ...DEFAULT_UNIFIED_SETTINGS, textGenerationModelSelection: selection },
        [
          {
            ...provider({ instanceId: "codex" }),
            models: [
              {
                slug: selection.model,
                name: selection.model,
                isCustom: false,
                capabilities,
              },
            ],
          },
        ],
      ),
    ).toEqual(selection);
  });

  it("keeps the existing non-Codex fallback without injecting Codex effort", () => {
    expect(
      resolveAppModelSelectionState(DEFAULT_UNIFIED_SETTINGS, [
        provider({
          provider: ProviderDriverKind.make("claudeAgent"),
          instanceId: "claudeAgent",
          models: ["claude-sonnet-4-6", "claude-haiku-4-5"],
        }),
      ]),
    ).toEqual({ instanceId: "claudeAgent", model: "claude-sonnet-4-6" });
  });

  it("retains the helper default while the provider catalog has not hydrated", () => {
    const settings = { ...DEFAULT_UNIFIED_SETTINGS };
    Reflect.deleteProperty(settings, "textGenerationModelSelection");
    expect(resolveAppModelSelectionState(settings, [])).toEqual({
      instanceId: "codex",
      model: "gpt-6.1-sol",
      options: [{ id: "reasoningEffort", value: "medium" }],
    });
  });

  it.each(["codex", "claudeAgent", "custom_unknown"])(
    "preserves all saved %s helper choices before catalog hydration",
    (instanceId) => {
      const selection = {
        instanceId: ProviderInstanceId.make(instanceId),
        model: "saved-model",
        options: [
          { id: "reasoningEffort", value: "high" },
          { id: "customOption", value: "saved-choice" },
        ],
      };
      expect(
        resolveAppModelSelectionState(
          { ...DEFAULT_UNIFIED_SETTINGS, textGenerationModelSelection: selection },
          [],
        ),
      ).toEqual(selection);
    },
  );

  it("seeds missing effort only for an exactly configured custom Codex account during hydration", () => {
    const selection = {
      instanceId: ProviderInstanceId.make("custom_account"),
      model: "saved-model",
    };
    const settings = { ...DEFAULT_UNIFIED_SETTINGS, textGenerationModelSelection: selection };
    expect(resolveAppModelSelectionState(settings, [])).toEqual(selection);
    expect(
      resolveAppModelSelectionState(
        {
          ...settings,
          providerInstances: {
            [selection.instanceId]: { driver: ProviderDriverKind.make("codex"), config: {} },
          },
        },
        [],
      ),
    ).toEqual({ ...selection, options: [{ id: "reasoningEffort", value: "medium" }] });
  });
});
