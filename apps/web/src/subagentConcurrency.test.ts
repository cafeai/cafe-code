import { describe, expect, it } from "vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  DEFAULT_UNIFIED_SETTINGS,
} from "@cafecode/contracts";
import {
  configuredInstanceSubagentLimit,
  deriveSubagentConcurrencyPresentation,
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
  it("does not treat the new-chat default as a legacy runtime override", () => {
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
});
