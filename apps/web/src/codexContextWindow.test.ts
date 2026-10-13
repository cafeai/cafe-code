import { describe, expect, it } from "vitest";
import {
  DEFAULT_UNIFIED_SETTINGS,
  ProviderInstanceId,
  ProviderDriverKind,
} from "@cafecode/contracts";
import {
  buildCodexContextWindowEditorKey,
  deriveCodexContextWindowPresentation,
  formatCodexContextWindowOverride,
  formatCodexContextCompactionEstimate,
  estimateCodexContextCompactionThreshold,
  inheritedCodexContextWindowOverride,
  requestedCodexAutoCompactTokenLimit,
} from "./codexContextWindow";

describe("Codex context-window preference presentation", () => {
  const account = ProviderInstanceId.make("codex-personal");
  const settings = {
    ...DEFAULT_UNIFIED_SETTINGS,
    providerInstances: {
      [account]: {
        driver: ProviderDriverKind.make("codex"),
        defaultCodexContextWindowOverride: 500_000,
      },
    },
  };
  it("inherits only the exact enabled Codex account and never writes a guessed default", () => {
    expect(inheritedCodexContextWindowOverride(settings, account, "codex")).toBe(500_000);
    expect(inheritedCodexContextWindowOverride(settings, account, "claudeAgent")).toBeUndefined();
    expect(
      inheritedCodexContextWindowOverride(settings, ProviderInstanceId.make("codex-peer"), "codex"),
    ).toBeUndefined();
    expect(
      inheritedCodexContextWindowOverride(
        {
          ...settings,
          providerInstances: {
            [account]: {
              driver: ProviderDriverKind.make("codex"),
              defaultCodexContextWindowOverride: 500_000,
              enabled: false,
            },
          },
        },
        account,
        "codex",
      ),
    ).toBeUndefined();
  });
  it("lets chat intent win while Reset tracks later live account edits", () => {
    const first = deriveCodexContextWindowPresentation({
      requested: 1_000_000,
      inherited: 500_000,
      configured: null,
    });
    expect(first).toEqual({
      requested: 1_000_000,
      configured: null,
      pending: true,
      source: "Chat override",
    });
    expect(
      deriveCodexContextWindowPresentation({
        requested: null,
        inherited: 750_000,
        configured: 500_000,
      }),
    ).toEqual({
      requested: 750_000,
      configured: 500_000,
      pending: true,
      source: "Account default",
    });
  });
  it.each(["en", "ja", "ko"] as const)(
    "formats saved and known transitions with %s Intl without fabricating capacity",
    (locale) => {
      const expected = new Intl.NumberFormat(locale, {
        notation: "compact",
        maximumFractionDigits: 1,
      }).format(500_000);
      expect(
        formatCodexContextWindowOverride(
          deriveCodexContextWindowPresentation({ requested: 500_000, configured: undefined }),
          locale,
        ),
      ).toContain(expected);
      expect(
        formatCodexContextWindowOverride(
          deriveCodexContextWindowPresentation({ requested: null, configured: 500_000 }),
          locale,
        ),
      ).toContain(expected);
      expect(
        formatCodexContextWindowOverride(
          deriveCodexContextWindowPresentation({ requested: null, configured: undefined }),
          locale,
        ),
      ).toBeNull();
      expect(
        formatCodexContextWindowOverride(
          deriveCodexContextWindowPresentation({ requested: null, configured: null }),
          locale,
        ),
      ).toBeNull();
    },
  );
  it("keeps malformed and legacy materialization unknown, including unsafe counts", () => {
    for (const configured of [NaN, Infinity, -1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1])
      expect(
        deriveCodexContextWindowPresentation({ requested: 500_000, configured }).configured,
      ).toBeUndefined();
  });
  it("uses injective editor ownership including model and draft identity", () => {
    const input = {
      environmentId: "a|b",
      threadId: "chat",
      draftId: null,
      instanceId: "codex",
      model: "model-a",
      isServerThread: true,
    };
    const key = buildCodexContextWindowEditorKey(input);
    for (const patch of [
      { environmentId: "a" },
      { threadId: "other" },
      { draftId: "draft" },
      { instanceId: "peer" },
      { model: "model-b" },
      { isServerThread: false },
    ])
      expect(buildCodexContextWindowEditorKey({ ...input, ...patch })).not.toBe(key);
  });

  it("reads an explicit compaction request only from the exact enabled Codex account's own data", () => {
    const peer = ProviderInstanceId.make("codex-peer");
    const withConfig = (config: unknown) => ({
      ...settings,
      providerInstances: {
        [account]: { ...settings.providerInstances[account]!, config },
        [peer]: {
          driver: ProviderDriverKind.make("codex"),
          config: { autoCompactTokenLimit: 150_000 },
        },
      },
    });
    expect(
      requestedCodexAutoCompactTokenLimit(
        withConfig({ autoCompactTokenLimit: 150_000 }),
        account,
        "codex",
      ),
    ).toBe(150_000);
    for (const config of [
      undefined,
      null,
      [],
      "150000",
      {},
      { autoCompactTokenLimit: null },
      ...[NaN, Infinity, -1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1, "150000"].map((value) => ({
        autoCompactTokenLimit: value,
      })),
    ]) {
      expect(
        requestedCodexAutoCompactTokenLimit(withConfig(config), account, "codex"),
      ).toBeUndefined();
    }
    const inheritedConfig: unknown = Object.create({ autoCompactTokenLimit: 150_000 });
    expect(
      requestedCodexAutoCompactTokenLimit(withConfig(inheritedConfig), account, "codex"),
    ).toBeUndefined();
    let reads = 0;
    const accessorConfig = Object.defineProperty({}, "autoCompactTokenLimit", {
      get: () => {
        reads += 1;
        return 150_000;
      },
    });
    expect(
      requestedCodexAutoCompactTokenLimit(withConfig(accessorConfig), account, "codex"),
    ).toBeUndefined();
    expect(reads).toBe(0);
    expect(
      requestedCodexAutoCompactTokenLimit(
        withConfig({ autoCompactTokenLimit: 150_000 }),
        account,
        "claudeAgent",
      ),
    ).toBeUndefined();
    expect(
      requestedCodexAutoCompactTokenLimit(
        withConfig({}),
        ProviderInstanceId.make("missing"),
        "codex",
      ),
    ).toBeUndefined();
    for (const patch of [{ enabled: false }, { driver: ProviderDriverKind.make("claudeAgent") }]) {
      const selected = withConfig({ autoCompactTokenLimit: 150_000 });
      selected.providerInstances[account] = { ...selected.providerInstances[account]!, ...patch };
      expect(requestedCodexAutoCompactTokenLimit(selected, account, "codex")).toBeUndefined();
    }
    // The peer's valid value is never borrowed by the selected account.
    expect(requestedCodexAutoCompactTokenLimit(withConfig({}), account, "codex")).toBeUndefined();
  });

  const compactionCases: {
    requested: number | null | undefined;
    configured: number | null | undefined;
    inherited?: number;
    explicit?: number;
    expected: number | null;
  }[] = [
    { requested: 800_000, configured: undefined, expected: 720_000 },
    { requested: 800_000, configured: 500_000, expected: 720_000 },
    { requested: 800_000, configured: 800_000, explicit: 150_000, expected: 150_000 },
    { requested: 800_000, configured: 800_000, explicit: 900_000, expected: 720_000 },
    { requested: null, configured: null, inherited: 800_000, expected: 720_000 },
    { requested: null, configured: 800_000, expected: null },
    { requested: undefined, configured: undefined, expected: null },
    { requested: 1, configured: null, expected: 0 },
    { requested: Number.MAX_SAFE_INTEGER, configured: null, expected: 8_106_479_329_266_891 },
  ];
  it.each(compactionCases)(
    "estimates only saved effective intent without changing materialization ($requested/$explicit)",
    ({ requested, configured, inherited, explicit, expected }) => {
      const input = Object.freeze({
        requested,
        configured,
        inherited,
        requestedAutoCompactTokenLimit: explicit,
      });
      const presentation = deriveCodexContextWindowPresentation(input);
      expect(estimateCodexContextCompactionThreshold(presentation)).toBe(expected);
      expect(presentation.configured).toBe(configured);
      expect(Object.hasOwn(presentation, "requestedAutoCompactTokenLimit")).toBe(
        explicit !== undefined,
      );
      expect(input.requestedAutoCompactTokenLimit).toBe(explicit);
    },
  );

  it("omits invalid explicit compaction values and retains known reset versus unknown materialization", () => {
    for (const explicit of [NaN, Infinity, -1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const presentation = deriveCodexContextWindowPresentation({
        requested: 800_000,
        configured: null,
        requestedAutoCompactTokenLimit: explicit,
      });
      expect(Object.hasOwn(presentation, "requestedAutoCompactTokenLimit")).toBe(false);
      expect(estimateCodexContextCompactionThreshold(presentation)).toBe(720_000);
      const missingIntent = deriveCodexContextWindowPresentation({
        requested: explicit,
        inherited: explicit,
        configured: undefined,
        requestedAutoCompactTokenLimit: 150_000,
      });
      expect(missingIntent.requested).toBeNull();
      expect(estimateCodexContextCompactionThreshold(missingIntent)).toBeNull();
    }
    expect(estimateCodexContextCompactionThreshold(null)).toBeNull();
    expect(estimateCodexContextCompactionThreshold(undefined)).toBeNull();
    const reset = deriveCodexContextWindowPresentation({
      requested: null,
      configured: 800_000,
      requestedAutoCompactTokenLimit: 150_000,
    });
    expect(reset.pending).toBe(true);
    expect(estimateCodexContextCompactionThreshold(reset)).toBeNull();
    expect(formatCodexContextWindowOverride(reset, "en")).toBe(
      "Context override: 800K → Codex default when idle",
    );
  });

  it.each(["en", "ja", "ko"] as const)(
    "formats a distinct estimated parenthetical in %s without rewriting the exact override label",
    (locale) => {
      const presentation = deriveCodexContextWindowPresentation({
        requested: 800_000,
        configured: undefined,
      });
      const originalLabel = formatCodexContextWindowOverride(presentation, locale);
      const formatted = new Intl.NumberFormat(locale, {
        notation: "compact",
        maximumFractionDigits: 1,
      }).format(720_000);
      expect(formatCodexContextCompactionEstimate(presentation, locale)).toContain(formatted);
      expect(formatCodexContextWindowOverride(presentation, locale)).toBe(originalLabel);
      expect(
        formatCodexContextCompactionEstimate(
          deriveCodexContextWindowPresentation({ requested: null, configured: 800_000 }),
          locale,
        ),
      ).toBeNull();
    },
  );
});
