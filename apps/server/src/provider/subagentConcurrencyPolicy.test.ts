import {
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ProviderSession,
} from "@cafecode/contracts";
import { describe, expect, it } from "vitest";
import {
  hasActiveSubagentSessionWork,
  hasSubagentConcurrencyChange,
  resolveSubagentConcurrencyPolicy,
} from "./subagentConcurrencyPolicy.ts";

const session = (overrides: Partial<ProviderSession> = {}): ProviderSession => ({
  provider: ProviderDriverKind.make("codex"),
  providerInstanceId: ProviderInstanceId.make("codex"),
  threadId: ThreadId.make("limit-policy"),
  status: "ready",
  runtimeMode: "full-access",
  createdAt: "2026-10-03T00:00:00.000Z",
  updatedAt: "2026-10-03T00:00:00.000Z",
  ...overrides,
});

describe("subagent concurrency execution policy", () => {
  it("selects only the native driver key and prefers chat overrides to account and legacy defaults", () => {
    const limits = { codex: 2, claude: 8 };
    expect(
      resolveSubagentConcurrencyPolicy({
        driver: "codex",
        limits,
        instanceDefaultMaxConcurrentSubagents: 15,
        instanceConfig: { maxConcurrentSubagents: 6 },
      }),
    ).toEqual({ requested: 2, configured: 2 });
    expect(resolveSubagentConcurrencyPolicy({ driver: "claudeAgent", limits })).toEqual({
      requested: 8,
      configured: 8,
    });
    expect(
      resolveSubagentConcurrencyPolicy({
        driver: "grok",
        limits,
        instanceDefaultMaxConcurrentSubagents: 15,
        instanceConfig: { maxConcurrentSubagents: 6 },
      }),
    ).toEqual({ requested: undefined, configured: null });
  });

  it.each(["codex", "claudeAgent"])(
    "treats the %s account default as explicit numeric intent ahead of legacy configuration",
    (driver) => {
      expect(
        resolveSubagentConcurrencyPolicy({
          driver,
          limits: {},
          instanceDefaultMaxConcurrentSubagents: 15,
          instanceConfig: { maxConcurrentSubagents: 4 },
        }),
      ).toEqual({ requested: 15, configured: 15 });
      // Explicit account intent reconciles an old unknown process policy;
      // inherited native policy alone must still preserve that old context.
      expect(
        hasSubagentConcurrencyChange(
          session(),
          resolveSubagentConcurrencyPolicy({
            driver,
            instanceDefaultMaxConcurrentSubagents: 15,
          }),
        ),
      ).toBe(true);
    },
  );

  it("clearing the account default reveals legacy or native inheritance without restoring old intent", () => {
    expect(
      resolveSubagentConcurrencyPolicy({
        driver: "codex",
        limits: {},
        instanceConfig: { maxConcurrentSubagents: 4 },
      }),
    ).toEqual({ requested: undefined, configured: 4 });
    expect(resolveSubagentConcurrencyPolicy({ driver: "codex", limits: {} })).toEqual({
      requested: undefined,
      configured: null,
    });
  });

  it("rejects malformed account defaults as numeric authority while preserving validated legacy fallback", () => {
    for (const value of [0, 65, 1.5, "15", null, NaN, Infinity, {}, []]) {
      expect(
        resolveSubagentConcurrencyPolicy({
          driver: "codex",
          instanceDefaultMaxConcurrentSubagents: value,
          instanceConfig: { maxConcurrentSubagents: 4 },
        }),
      ).toEqual({ requested: undefined, configured: 4 });
    }
  });

  it("reset falls back to validated legacy configuration, never to a model-derived guess", () => {
    expect(
      resolveSubagentConcurrencyPolicy({
        driver: "codex",
        limits: {},
        instanceConfig: { maxConcurrentSubagents: 4 },
      }),
    ).toEqual({ requested: undefined, configured: 4 });
    for (const value of [0, 65, 1.5, "8", null]) {
      expect(
        resolveSubagentConcurrencyPolicy({
          driver: "codex",
          instanceConfig: { maxConcurrentSubagents: value },
        }).configured,
      ).toBeNull();
    }
  });

  it("does not replace legacy unknown sessions merely to label inheritance", () => {
    expect(
      hasSubagentConcurrencyChange(session(), { requested: undefined, configured: null }),
    ).toBe(false);
    expect(hasSubagentConcurrencyChange(session(), { requested: 2, configured: 2 })).toBe(true);
    expect(
      hasSubagentConcurrencyChange(session({ maxConcurrentSubagents: 2 }), {
        requested: undefined,
        configured: null,
      }),
    ).toBe(true);
    expect(
      hasSubagentConcurrencyChange(session({ maxConcurrentSubagents: null }), {
        requested: undefined,
        configured: null,
      }),
    ).toBe(false);
    expect(
      hasSubagentConcurrencyChange(session({ maxConcurrentSubagents: 2 }), {
        requested: 2,
        configured: 2,
      }),
    ).toBe(false);
  });

  it("treats a root turn or connecting/running status as an advisory busy fence", () => {
    expect(hasActiveSubagentSessionWork(session())).toBe(false);
    expect(hasActiveSubagentSessionWork(session({ status: "running" }))).toBe(true);
    expect(hasActiveSubagentSessionWork(session({ status: "connecting" }))).toBe(true);
    expect(hasActiveSubagentSessionWork(session({ activeTurnId: TurnId.make("active") }))).toBe(
      true,
    );
  });
});
