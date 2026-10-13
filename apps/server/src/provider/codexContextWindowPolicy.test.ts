import { describe, expect, it } from "vitest";
import {
  hasCodexContextWindowChange,
  readCodexAutoCompactTokenLimit,
  resolveCodexContextWindowPolicy,
} from "./codexContextWindowPolicy.ts";
import { ProviderDriverKind, ThreadId, type ProviderSession } from "@cafecode/contracts";

function contextSession(): ProviderSession {
  return {
    provider: ProviderDriverKind.make("codex"),
    threadId: ThreadId.make("synthetic-context-policy"),
    runtimeMode: "full-access",
    status: "ready",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("Codex context-window requested policy", () => {
  it("admits only own numeric data configuration without executing accessors", () => {
    expect(readCodexAutoCompactTokenLimit({ autoCompactTokenLimit: 150_000 })).toBe(150_000);
    for (const invalid of [
      null,
      undefined,
      [],
      "150000",
      0,
      -1,
      1.5,
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(readCodexAutoCompactTokenLimit(invalid)).toBeUndefined();
      expect(readCodexAutoCompactTokenLimit({ autoCompactTokenLimit: invalid })).toBeUndefined();
    }
    const inherited = Object.create({ autoCompactTokenLimit: 150_000 });
    expect(readCodexAutoCompactTokenLimit(inherited)).toBeUndefined();
    let accessorCalls = 0;
    const accessor = Object.defineProperty({}, "autoCompactTokenLimit", {
      get() {
        accessorCalls++;
        throw new Error("Configuration accessors must not execute.");
      },
    });
    expect(readCodexAutoCompactTokenLimit(accessor)).toBeUndefined();
    expect(accessorCalls).toBe(0);
  });

  it("resolves chat override, current account default, then native inheritance without seeding", () => {
    expect(
      resolveCodexContextWindowPolicy({
        driver: "codex",
        chatOverride: 500_000,
        accountDefault: 700_000,
      }),
    ).toEqual({
      requested: 500_000,
      configured: 500_000,
      configuredAutoCompactTokenLimit: 500_000,
    });
    expect(
      resolveCodexContextWindowPolicy({
        driver: "codex",
        chatOverride: null,
        accountDefault: 700_000,
      }),
    ).toEqual({
      requested: 700_000,
      configured: 700_000,
      configuredAutoCompactTokenLimit: 700_000,
    });
    expect(resolveCodexContextWindowPolicy({ driver: "codex", accountDefault: 700_000 })).toEqual({
      requested: 700_000,
      configured: 700_000,
      configuredAutoCompactTokenLimit: 700_000,
    });
    expect(resolveCodexContextWindowPolicy({ driver: "codex", chatOverride: null })).toEqual({
      requested: undefined,
      configured: null,
      configuredAutoCompactTokenLimit: null,
    });
    expect(
      resolveCodexContextWindowPolicy({
        driver: "claudeAgent",
        chatOverride: 500_000,
        accountDefault: 700_000,
      }),
    ).toEqual({ requested: undefined, configured: null, configuredAutoCompactTokenLimit: null });
    for (const invalid of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "500000"])
      expect(resolveCodexContextWindowPolicy({ driver: "codex", accountDefault: invalid })).toEqual(
        { requested: undefined, configured: null, configuredAutoCompactTokenLimit: null },
      );
  });
  it("distinguishes unknown materialization from an explicit saved numeric intent", () => {
    const session = contextSession();
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
        {
          ...session,
          codexContextWindowOverride: 500_000,
          codexAutoCompactTokenLimit: 500_000,
        },
        resolveCodexContextWindowPolicy({ driver: "codex", chatOverride: 500_000 }),
      ),
    ).toBe(false);
  });

  it("resolves exact-account compaction precedence without manufacturing effective native capacity", () => {
    expect(
      resolveCodexContextWindowPolicy({
        driver: "codex",
        chatOverride: 800_000,
        accountAutoCompactTokenLimit: 150_000,
      }),
    ).toEqual({
      requested: 800_000,
      configured: 800_000,
      configuredAutoCompactTokenLimit: 150_000,
    });
    expect(
      resolveCodexContextWindowPolicy({ driver: "codex", accountAutoCompactTokenLimit: 150_000 }),
    ).toEqual({ requested: undefined, configured: null, configuredAutoCompactTokenLimit: 150_000 });
    expect(
      resolveCodexContextWindowPolicy({
        driver: "claudeAgent",
        chatOverride: 800_000,
        accountAutoCompactTokenLimit: 150_000,
      }),
    ).toEqual({ requested: undefined, configured: null, configuredAutoCompactTokenLimit: null });
    for (const invalid of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "150000"])
      expect(
        resolveCodexContextWindowPolicy({
          driver: "codex",
          chatOverride: 800_000,
          accountAutoCompactTokenLimit: invalid,
        }).configuredAutoCompactTokenLimit,
      ).toBe(800_000);
  });

  it("reconciles identical legacy context intent only when compaction request evidence is missing or differs", () => {
    const session = { ...contextSession(), codexContextWindowOverride: 800_000 };
    const paired = resolveCodexContextWindowPolicy({ driver: "codex", chatOverride: 800_000 });
    expect(hasCodexContextWindowChange(session, paired)).toBe(true);
    expect(
      hasCodexContextWindowChange({ ...session, codexAutoCompactTokenLimit: null }, paired),
    ).toBe(true);
    expect(
      hasCodexContextWindowChange({ ...session, codexAutoCompactTokenLimit: 472_000 }, paired),
    ).toBe(true);
    expect(
      hasCodexContextWindowChange({ ...session, codexAutoCompactTokenLimit: 800_000 }, paired),
    ).toBe(false);
    const explicit = resolveCodexContextWindowPolicy({
      driver: "codex",
      chatOverride: 800_000,
      accountAutoCompactTokenLimit: 150_000,
    });
    expect(
      hasCodexContextWindowChange({ ...session, codexAutoCompactTokenLimit: 800_000 }, explicit),
    ).toBe(true);
    expect(
      hasCodexContextWindowChange({ ...session, codexAutoCompactTokenLimit: 150_000 }, explicit),
    ).toBe(false);
    const inherited = resolveCodexContextWindowPolicy({ driver: "codex" });
    expect(hasCodexContextWindowChange(contextSession(), inherited)).toBe(false);
    expect(
      hasCodexContextWindowChange(
        { ...contextSession(), codexContextWindowOverride: null, codexAutoCompactTokenLimit: null },
        inherited,
      ),
    ).toBe(false);
    expect(
      hasCodexContextWindowChange(
        {
          ...contextSession(),
          codexContextWindowOverride: null,
          codexAutoCompactTokenLimit: 150_000,
        },
        inherited,
      ),
    ).toBe(false);
  });

  it("leaves explicit-only compaction on its existing account configuration path", () => {
    const explicitOnly = resolveCodexContextWindowPolicy({
      driver: "codex",
      accountAutoCompactTokenLimit: 150_000,
    });
    expect(hasCodexContextWindowChange(contextSession(), explicitOnly)).toBe(false);
    expect(
      hasCodexContextWindowChange(
        { ...contextSession(), codexContextWindowOverride: null },
        explicitOnly,
      ),
    ).toBe(false);
    expect(
      hasCodexContextWindowChange(
        {
          ...contextSession(),
          codexContextWindowOverride: null,
          codexAutoCompactTokenLimit: 600_000,
        },
        explicitOnly,
      ),
    ).toBe(false);
  });
});
