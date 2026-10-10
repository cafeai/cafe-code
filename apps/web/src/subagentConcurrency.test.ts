import { describe, expect, it } from "vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  DEFAULT_UNIFIED_SETTINGS,
} from "@cafecode/contracts";
import {
  configuredInstanceSubagentLimit,
  effectiveSubagentLimit,
  inheritedInstanceSubagentPolicy,
  deriveSubagentConcurrencyPresentation,
  formatSubagentConcurrencyLimit,
  subagentLimitKey,
  subagentLimitsEqual,
  validSubagentLimit,
  withSubagentLimit,
} from "./subagentConcurrency";

const codex = ProviderDriverKind.make("codex");
const claude = ProviderDriverKind.make("claudeAgent");
describe("subagent concurrency policy", () => {
  it.each([1, 12, 64])("accepts bounded integer %i", (value) =>
    expect(validSubagentLimit(value)).toBe(true),
  );
  it.each([0, 65, 1.5, NaN, Infinity, "12", null])("rejects malformed limit %s", (value) =>
    expect(validSubagentLimit(value)).toBe(false),
  );
  it("preserves the other driver's policy and explicit resets", () => {
    expect(withSubagentLimit({ codex: 12, claude: 20 }, codex, undefined)).toEqual({ claude: 20 });
    expect(withSubagentLimit({ claude: 20 }, claude, undefined)).toEqual({});
    expect(subagentLimitsEqual(undefined, {})).toBe(false);
    expect(subagentLimitsEqual({ codex: 12 }, { codex: 12 })).toBe(true);
    expect(subagentLimitKey("grok")).toBeNull();
    expect(() => withSubagentLimit({}, codex, 65)).toThrow();
  });
  it("distinguishes requested policy, configured evidence and unknown native defaults", () => {
    expect(
      deriveSubagentConcurrencyPresentation({
        provider: codex,
        limits: { codex: 12 },
        inheritedLimit: 6,
        configuredLimit: 3,
      }),
    ).toEqual({ requested: 12, configured: 3, source: "Chat override", pending: true });
    expect(
      deriveSubagentConcurrencyPresentation({
        provider: claude,
        limits: {},
        inheritedLimit: 20,
        configuredLimit: 20,
      })?.source,
    ).toBe("Legacy instance configuration");
    expect(
      deriveSubagentConcurrencyPresentation({
        provider: codex,
        limits: {},
        inheritedLimit: undefined,
        configuredLimit: null,
      }),
    ).toEqual({
      requested: undefined,
      configured: null,
      source: "Provider / inherited default",
      pending: false,
    });
    expect(
      deriveSubagentConcurrencyPresentation({
        provider: codex,
        limits: { codex: 12 },
        inheritedLimit: undefined,
        configuredLimit: undefined,
      })?.configured,
    ).toBeUndefined();
  });
  it("keeps live account defaults distinct from legacy runtime configuration", () => {
    const id = ProviderInstanceId.make("codex_personal");
    const settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [id]: {
          driver: codex,
          defaultMaxConcurrentSubagents: 12,
          config: { maxConcurrentSubagents: 6 },
        },
      },
    };
    expect(configuredInstanceSubagentLimit(settings, id)).toBe(6);
    expect(
      configuredInstanceSubagentLimit(
        {
          ...settings,
          providerInstances: { [id]: { driver: codex, defaultMaxConcurrentSubagents: 12 } },
        },
        id,
      ),
    ).toBeUndefined();
  });

  it("inherits live account policy without overwriting explicit chat intent", () => {
    const id = ProviderInstanceId.make("codex_personal");
    const settings = (limit: number | undefined) => ({
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [id]: {
          driver: codex,
          ...(limit !== undefined ? { defaultMaxConcurrentSubagents: limit } : {}),
          config: { maxConcurrentSubagents: 6 },
        },
      },
    });
    const resolve = (
      limit: number | undefined,
      limits: { codex?: number; claude?: number } | undefined,
    ) =>
      effectiveSubagentLimit({
        settings: settings(limit),
        instanceId: id,
        provider: codex,
        limits,
      });
    expect(resolve(12, undefined)).toBe(12);
    expect(resolve(24, undefined)).toBe(24);
    expect(resolve(24, {})).toBe(24);
    expect(resolve(24, { codex: 5 })).toBe(5);
    expect(resolve(24, { claude: 20 })).toBe(24);
    expect(resolve(undefined, {})).toBe(6);
    expect(inheritedInstanceSubagentPolicy(settings(24), id, codex)).toEqual({
      limit: 24,
      source: "Account default",
    });
    expect(inheritedInstanceSubagentPolicy(settings(undefined), id, codex)).toEqual({
      limit: 6,
      source: "Legacy instance configuration",
    });
  });

  it("never borrows another account, disabled envelope or wrong-driver numeric default", () => {
    const own = ProviderInstanceId.make("codex-own");
    const peer = ProviderInstanceId.make("codex-peer");
    const settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      providerInstances: {
        [own]: { driver: codex, defaultMaxConcurrentSubagents: 12 },
        [peer]: { driver: codex, defaultMaxConcurrentSubagents: 64 },
      },
    };
    expect(inheritedInstanceSubagentPolicy(settings, own, codex).limit).toBe(12);
    expect(inheritedInstanceSubagentPolicy(settings, peer, codex).limit).toBe(64);
    for (const instance of [
      {
        driver: codex,
        enabled: false,
        defaultMaxConcurrentSubagents: 15,
        config: { maxConcurrentSubagents: 5 },
      },
      { driver: claude, defaultMaxConcurrentSubagents: 15, config: { maxConcurrentSubagents: 5 } },
    ]) {
      expect(
        inheritedInstanceSubagentPolicy(
          { ...settings, providerInstances: { ...settings.providerInstances, [own]: instance } },
          own,
          codex,
        ).limit,
      ).toBeUndefined();
    }
    expect(
      inheritedInstanceSubagentPolicy(settings, ProviderInstanceId.make("absent"), codex).limit,
    ).toBeUndefined();
    expect(inheritedInstanceSubagentPolicy(settings, own, claude).limit).toBeUndefined();
  });

  it("exposes account source and pending materialization while preserving unknown native defaults", () => {
    const presentation = (
      inheritedLimit: number | undefined,
      configuredLimit: number | null | undefined,
      limits = {},
    ) =>
      deriveSubagentConcurrencyPresentation({
        provider: codex,
        limits,
        inheritedLimit,
        inheritedSource: "Account default",
        configuredLimit,
      });
    expect(presentation(12, 12)).toEqual({
      requested: 12,
      configured: 12,
      source: "Account default",
      pending: false,
    });
    expect(presentation(24, 12)).toEqual({
      requested: 24,
      configured: 12,
      source: "Account default",
      pending: true,
    });
    expect(presentation(24, 24)?.pending).toBe(false);
    expect(presentation(24, 12, { codex: 5 })).toMatchObject({
      requested: 5,
      source: "Chat override",
      pending: true,
    });
    expect(presentation(undefined, 12)).toMatchObject({
      requested: undefined,
      source: "Provider / inherited default",
      pending: true,
    });
    expect(formatSubagentConcurrencyLimit(presentation(undefined, 12))).toBe(
      "Subagent limit: 12 → Provider default when idle",
    );
  });

  it("shows the saved chat limit while a provider-managed session is still pending", () => {
    const presentation = deriveSubagentConcurrencyPresentation({
      provider: codex,
      limits: { codex: 5 },
      inheritedLimit: undefined,
      configuredLimit: null,
    })!;
    expect(formatSubagentConcurrencyLimit(presentation)).toBe(
      "Subagent limit: Provider default → 5 when idle",
    );
    expect(formatSubagentConcurrencyLimit({ ...presentation, configured: 3 })).toBe(
      "Subagent limit: 3 → 5 when idle",
    );
  });

  it("shows a numeric inherited account setting after resetting a chat override", () => {
    const presentation = deriveSubagentConcurrencyPresentation({
      provider: claude,
      limits: {},
      inheritedLimit: 6,
      configuredLimit: 6,
    })!;
    expect(formatSubagentConcurrencyLimit(presentation)).toBe("Subagent limit: 6");
  });

  it.each([undefined, null, 8])(
    "hides an unknown inherited number with session policy %s",
    (configuredLimit) => {
      const presentation = deriveSubagentConcurrencyPresentation({
        provider: codex,
        limits: {},
        inheritedLimit: undefined,
        configuredLimit,
      })!;
      expect(formatSubagentConcurrencyLimit(presentation)).toBe(
        configuredLimit === 8 ? "Subagent limit: 8 → Provider default when idle" : null,
      );
    },
  );

  it("shows a saved numeric choice before session configuration has been recorded", () => {
    const presentation = deriveSubagentConcurrencyPresentation({
      provider: claude,
      limits: { claude: 12 },
      inheritedLimit: undefined,
      configuredLimit: undefined,
    })!;
    expect(formatSubagentConcurrencyLimit(presentation)).toBe("Subagent limit: 12 · saved");
  });

  it.each([null, undefined])("omits missing presentation %s", (presentation) => {
    expect(formatSubagentConcurrencyLimit(presentation)).toBeNull();
  });
});
