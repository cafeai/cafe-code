import { describe, expect, it } from "vitest";
import {
  hasCodexContextWindowChange,
  resolveCodexContextWindowPolicy,
} from "./codexContextWindowPolicy.ts";
import type { ProviderSession } from "@cafecode/contracts";

describe("Codex context-window requested policy", () => {
  it("resolves chat override, current account default, then native inheritance without seeding", () => {
    expect(
      resolveCodexContextWindowPolicy({
        driver: "codex",
        chatOverride: 500_000,
        accountDefault: 700_000,
      }),
    ).toEqual({ requested: 500_000, configured: 500_000 });
    expect(
      resolveCodexContextWindowPolicy({
        driver: "codex",
        chatOverride: null,
        accountDefault: 700_000,
      }),
    ).toEqual({ requested: 700_000, configured: 700_000 });
    expect(resolveCodexContextWindowPolicy({ driver: "codex", accountDefault: 700_000 })).toEqual({
      requested: 700_000,
      configured: 700_000,
    });
    expect(resolveCodexContextWindowPolicy({ driver: "codex", chatOverride: null })).toEqual({
      requested: undefined,
      configured: null,
    });
    expect(
      resolveCodexContextWindowPolicy({
        driver: "claudeAgent",
        chatOverride: 500_000,
        accountDefault: 700_000,
      }),
    ).toEqual({ requested: undefined, configured: null });
    for (const invalid of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "500000"])
      expect(resolveCodexContextWindowPolicy({ driver: "codex", accountDefault: invalid })).toEqual(
        { requested: undefined, configured: null },
      );
  });
  it("distinguishes unknown materialization from an explicit saved numeric intent", () => {
    const session = {} as ProviderSession;
    expect(
      hasCodexContextWindowChange(session, resolveCodexContextWindowPolicy({ driver: "codex" })),
    ).toBe(false);
    expect(
      hasCodexContextWindowChange(
        session,
        resolveCodexContextWindowPolicy({ driver: "codex", accountDefault: 500_000 }),
      ),
    ).toBe(true);
    expect(
      hasCodexContextWindowChange(
        { ...session, codexContextWindowOverride: 500_000 },
        resolveCodexContextWindowPolicy({ driver: "codex" }),
      ),
    ).toBe(true);
    expect(
      hasCodexContextWindowChange(
        { ...session, codexContextWindowOverride: 500_000 },
        resolveCodexContextWindowPolicy({ driver: "codex", chatOverride: 500_000 }),
      ),
    ).toBe(false);
  });
});
