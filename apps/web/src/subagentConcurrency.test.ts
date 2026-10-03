import { describe, expect, it } from "vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  DEFAULT_UNIFIED_SETTINGS,
} from "@cafecode/contracts";
import {
  configuredInstanceSubagentLimit,
  deriveSubagentConcurrencyPresentation,
  formatSubagentConcurrencyDetails,
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

  it("explains a selected chat limit separately from the provider-managed running session", () => {
    const presentation = deriveSubagentConcurrencyPresentation({
      provider: codex,
      limits: { codex: 5 },
      inheritedLimit: undefined,
      configuredLimit: null,
    })!;
    expect(formatSubagentConcurrencyDetails(presentation)).toEqual({
      selected: "Selected for this chat: 5 at once",
      currentSession: "Current session: Provider-managed",
      pending: "Waiting to apply — applies before a new turn when the session can safely restart.",
    });
  });

  it("retains account provenance inline after resetting a chat override", () => {
    const presentation = deriveSubagentConcurrencyPresentation({
      provider: claude,
      limits: {},
      inheritedLimit: 6,
      configuredLimit: 6,
    })!;
    expect(formatSubagentConcurrencyDetails(presentation)).toEqual({
      selected: "Account setting: 6 at once",
      currentSession: "Current session: 6 at once",
      pending: null,
    });
  });

  it("keeps an unrecorded process policy distinct from a known provider-managed policy", () => {
    const presentation = deriveSubagentConcurrencyPresentation({
      provider: codex,
      limits: {},
      inheritedLimit: undefined,
      configuredLimit: undefined,
    })!;
    expect(formatSubagentConcurrencyDetails(presentation)).toEqual({
      selected: "Selected limit: Provider-managed",
      currentSession: "Current session: Not recorded",
      pending: null,
    });
    expect(
      formatSubagentConcurrencyDetails({ ...presentation, configured: null }).currentSession,
    ).toBe("Current session: Provider-managed");
  });

  it("does not invent a pending/applied state when only the saved chat request is known", () => {
    const presentation = deriveSubagentConcurrencyPresentation({
      provider: claude,
      limits: { claude: 12 },
      inheritedLimit: undefined,
      configuredLimit: undefined,
    })!;
    expect(formatSubagentConcurrencyDetails(presentation)).toEqual({
      selected: "Selected for this chat: 12 at once",
      currentSession: "Current session: Not recorded",
      pending: null,
    });
  });

  it("describes a pending reset without pretending it immediately changes the current session", () => {
    const presentation = deriveSubagentConcurrencyPresentation({
      provider: codex,
      limits: {},
      inheritedLimit: undefined,
      configuredLimit: 8,
    })!;
    const wording = formatSubagentConcurrencyDetails(presentation);
    expect(wording.selected).toBe("Selected limit: Provider-managed");
    expect(wording.currentSession).toBe("Current session: 8 at once");
    expect(wording.pending).not.toBeNull();
  });
});
