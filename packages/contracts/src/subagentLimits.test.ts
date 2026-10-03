import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { SubagentLimits, MaxConcurrentSubagents } from "./subagentLimits.ts";
import { ClientOrchestrationCommand, OrchestrationSession } from "./orchestration.ts";
import { ProviderSessionStartInput } from "./provider.ts";
import { ProviderInstanceConfig } from "./providerInstance.ts";

describe("per-chat subagent policy contracts", () => {
  const decode = Schema.decodeUnknownSync(SubagentLimits);
  it("retains both families and an explicit whole-object reset", () => {
    expect(decode({ codex: 1, claude: 64 })).toEqual({ codex: 1, claude: 64 });
    expect(decode({})).toEqual({});
    expect(Schema.encodeSync(SubagentLimits)({})).toEqual({});
  });
  it.each([0, -1, 1.5, 65, Infinity, NaN, "4", null, false])(
    "rejects malformed explicit limit %s",
    (value) => {
      expect(() => Schema.decodeUnknownSync(MaxConcurrentSubagents)(value)).toThrow();
      expect(() => decode({ codex: value })).toThrow();
      expect(() => decode({ claude: value })).toThrow();
    },
  );
  it("rejects misspelled/foreign keys instead of silently interpreting them as reset", () => {
    expect(() => decode({ claudeAgent: 4 })).toThrow();
    expect(() => decode({ codex: 4, environment: { PATH: "untrusted" } })).toThrow();
  });
  it("distinguishes omitted metadata from a canonical explicit reset", () => {
    const base = { type: "thread.meta.update", commandId: "limits-update", threadId: "chat" };
    const parse = Schema.decodeUnknownSync(ClientOrchestrationCommand);
    expect(parse(base)).not.toHaveProperty("subagentLimits");
    expect(parse({ ...base, subagentLimits: {} })).toHaveProperty("subagentLimits", {});
  });
  it("keeps new-chat default separate from opaque runtime configuration", () => {
    const parse = Schema.decodeUnknownSync(ProviderInstanceConfig);
    expect(parse({ driver: "codex", defaultMaxConcurrentSubagents: 4 })).toEqual({
      driver: "codex",
      defaultMaxConcurrentSubagents: 4,
    });
    expect(() => parse({ driver: "codex", defaultMaxConcurrentSubagents: 65 })).toThrow();
  });
  it("decodes nullable process evidence and the internal idle-admission guard", () => {
    const start = Schema.decodeUnknownSync(ProviderSessionStartInput);
    const base = { threadId: "chat", runtimeMode: "approval-required" };
    expect(start(base)).not.toHaveProperty("maxConcurrentSubagents");
    expect(start({ ...base, maxConcurrentSubagents: null })).toHaveProperty(
      "maxConcurrentSubagents",
      null,
    );
    expect(
      start({ ...base, maxConcurrentSubagents: 4, requireIdleForSubagentLimitChange: true }),
    ).toMatchObject({ maxConcurrentSubagents: 4, requireIdleForSubagentLimitChange: true });
    const session = {
      ...base,
      status: "ready",
      providerName: "codex",
      activeTurnId: null,
      lastError: null,
      updatedAt: "2026-10-03T00:00:00.000Z",
    };
    expect(Schema.decodeUnknownSync(OrchestrationSession)(session)).not.toHaveProperty(
      "maxConcurrentSubagents",
    );
    expect(
      Schema.decodeUnknownSync(OrchestrationSession)({ ...session, maxConcurrentSubagents: null }),
    ).toHaveProperty("maxConcurrentSubagents", null);
  });
});
