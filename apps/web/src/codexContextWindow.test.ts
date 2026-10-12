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
  inheritedCodexContextWindowOverride,
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
});
