import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@cafecode/contracts";
import { describe, expect, it } from "vitest";
import {
  deriveProviderInstanceEntries,
  resolveSelectableProviderInstance,
  resolveProviderDriverKindForInstanceSelection,
  resolveComposerProviderInstance,
} from "./providerInstances";

function provider(input: {
  provider: ProviderDriverKind;
  instanceId: string;
  enabled?: boolean;
  availability?: ServerProvider["availability"];
  displayName?: string;
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: input.provider,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    enabled: input.enabled ?? true,
    installed: true,
    version: null,
    status: "ready",
    ...(input.availability ? { availability: input.availability } : {}),
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  };
}

describe("deriveProviderInstanceEntries", () => {
  it("uses explicit instance id and driver kind from the snapshot", () => {
    const snapshot = provider({
      provider: ProviderDriverKind.make("codex"),
      instanceId: "codex_personal",
    });
    const [entry] = deriveProviderInstanceEntries([snapshot]);

    expect(entry?.instanceId).toBe("codex_personal");
    expect(entry?.driverKind).toBe("codex");
    expect(entry?.isDefault).toBe(false);
  });
});

describe("resolveComposerProviderInstance", () => {
  const account = ProviderInstanceId.make("codex-session-account");
  const peer = ProviderInstanceId.make("codex-peer-account");
  const disabled = ProviderInstanceId.make("codex-disabled-account");
  const otherDriver = ProviderInstanceId.make("claude-peer-account");
  const providers = [
    provider({ provider: ProviderDriverKind.make("codex"), instanceId: account }),
    provider({ provider: ProviderDriverKind.make("codex"), instanceId: peer }),
    provider({ provider: ProviderDriverKind.make("codex"), instanceId: disabled, enabled: false }),
    provider({ provider: ProviderDriverKind.make("claudeAgent"), instanceId: otherDriver }),
  ];
  const entries = deriveProviderInstanceEntries(providers).map((entry) => ({
    ...entry,
    continuationGroupKey: entry.instanceId === account ? "retained-group" : "peer-group",
  }));
  const base = {
    entries,
    activeProvider: undefined,
    sessionInstanceId: account,
    threadInstanceId: peer,
    defaultInstanceId: peer,
    projectInstanceId: peer,
    selectedProvider: ProviderDriverKind.make("codex"),
    lockedProvider: null,
    lockedContinuationGroupKey: null,
  };

  it("retains session before durable selection, while a valid explicit peer remains first", () => {
    expect(resolveComposerProviderInstance(base)).toBe(account);
    expect(resolveComposerProviderInstance({ ...base, activeProvider: peer })).toBe(peer);
  });
  it.each([disabled, ProviderInstanceId.make("missing-account")])(
    "skips stale disabled or missing draft candidates %s without borrowing their policy",
    (activeProvider) => {
      expect(resolveComposerProviderInstance({ ...base, activeProvider })).toBe(account);
    },
  );
  it("preserves locked-driver and continuation candidate filters", () => {
    expect(
      resolveComposerProviderInstance({
        ...base,
        activeProvider: otherDriver,
        lockedProvider: ProviderDriverKind.make("codex"),
      }),
    ).toBe(account);
    expect(
      resolveComposerProviderInstance({
        ...base,
        activeProvider: peer,
        lockedProvider: ProviderDriverKind.make("codex"),
        lockedContinuationGroupKey: "retained-group",
      }),
    ).toBe(account);
  });
  it("preserves later enabled defaults and the existing explicit unavailable fallback", () => {
    expect(resolveComposerProviderInstance({ ...base, sessionInstanceId: disabled })).toBe(peer);
    expect(
      resolveComposerProviderInstance({
        ...base,
        activeProvider: disabled,
        sessionInstanceId: undefined,
        threadInstanceId: undefined,
        defaultInstanceId: undefined,
        projectInstanceId: undefined,
      }),
    ).toBe(disabled);
    expect(
      resolveComposerProviderInstance({
        ...base,
        entries: [],
        activeProvider: undefined,
        sessionInstanceId: undefined,
        threadInstanceId: undefined,
        defaultInstanceId: undefined,
        projectInstanceId: undefined,
      }),
    ).toBe("codex");
  });
});

describe("resolveSelectableProviderInstance", () => {
  it("returns the requested instance when it is enabled and available", () => {
    const requested = ProviderInstanceId.make("claude_work");
    const providers = [
      provider({ provider: ProviderDriverKind.make("codex"), instanceId: "codex" }),
      provider({ provider: ProviderDriverKind.make("claudeAgent"), instanceId: requested }),
    ];

    expect(resolveSelectableProviderInstance(providers, requested)).toBe(requested);
  });

  it("falls back to the first enabled and available instance", () => {
    const disabled = ProviderInstanceId.make("codex");
    const fallback = ProviderInstanceId.make("claudeAgent");
    const providers = [
      provider({
        provider: ProviderDriverKind.make("codex"),
        instanceId: disabled,
        enabled: false,
      }),
      provider({ provider: ProviderDriverKind.make("claudeAgent"), instanceId: fallback }),
    ];

    expect(resolveSelectableProviderInstance(providers, disabled)).toBe(fallback);
  });

  it("does not return disabled, unavailable, or unknown instances when none are sendable", () => {
    const disabled = ProviderInstanceId.make("codex");
    const unavailable = ProviderInstanceId.make("claudeAgent");
    const unknown = ProviderInstanceId.make("removed_instance");
    const providers = [
      provider({
        provider: ProviderDriverKind.make("codex"),
        instanceId: disabled,
        enabled: false,
      }),
      provider({
        provider: ProviderDriverKind.make("claudeAgent"),
        instanceId: unavailable,
        availability: "unavailable",
      }),
    ];

    expect(resolveSelectableProviderInstance(providers, disabled)).toBeUndefined();
    expect(resolveSelectableProviderInstance(providers, unavailable)).toBeUndefined();
    expect(resolveSelectableProviderInstance(providers, unknown)).toBeUndefined();
  });
});

describe("resolveProviderDriverKindForInstanceSelection", () => {
  it("maps custom provider instance ids back to their driver kind", () => {
    const providers = [
      provider({ provider: ProviderDriverKind.make("codex"), instanceId: "codex" }),
      provider({
        provider: ProviderDriverKind.make("claudeAgent"),
        instanceId: "claude_openrouter",
        displayName: "Claude OpenRouter",
      }),
    ];
    const entries = deriveProviderInstanceEntries(providers);

    expect(
      resolveProviderDriverKindForInstanceSelection(
        entries,
        providers,
        ProviderInstanceId.make("claude_openrouter"),
      ),
    ).toBe("claudeAgent");
  });

  it("does not guess a provider kind when the instance selection is unknown", () => {
    const providers = [
      provider({ provider: ProviderDriverKind.make("codex"), instanceId: "codex", enabled: false }),
      provider({ provider: ProviderDriverKind.make("claudeAgent"), instanceId: "claudeAgent" }),
    ];
    const entries = deriveProviderInstanceEntries(providers);

    expect(
      resolveProviderDriverKindForInstanceSelection(
        entries,
        providers,
        ProviderInstanceId.make("removed_instance"),
      ),
    ).toBeUndefined();
  });
});
