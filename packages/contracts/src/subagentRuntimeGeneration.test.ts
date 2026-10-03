import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";
import { ProviderEvent, ProviderSession } from "./provider.ts";
import { ProviderRuntimeEvent, RuntimeSubagentPresentation } from "./providerRuntime.ts";
import { OrchestrationSession } from "./orchestration.ts";

const runtimeId = "00000000-0000-4000-8000-000000000001";
const at = "2026-10-04T00:00:00.000Z";
const shapes = [
  [
    ProviderSession,
    {
      provider: "codex",
      threadId: "thread",
      status: "ready",
      runtimeMode: "full-access",
      createdAt: at,
      updatedAt: at,
    },
    "subagentRuntimeId",
  ],
  [
    ProviderEvent,
    {
      id: "event",
      provider: "codex",
      threadId: "thread",
      kind: "session",
      method: "session/ready",
      createdAt: at,
    },
    "subagentRuntimeId",
  ],
  [
    ProviderRuntimeEvent,
    {
      type: "session.started",
      eventId: "event",
      provider: "codex",
      threadId: "thread",
      createdAt: at,
      payload: {},
    },
    "subagentRuntimeId",
  ],
  [RuntimeSubagentPresentation, { threadId: "child", status: "active" }, "runtimeId"],
] as const;

describe("native subagent runtime generation contracts", () => {
  it("roundtrips optional exact UUID evidence and keeps legacy omission unknown", () => {
    for (const [schema, input, field] of shapes) {
      const decode = Schema.decodeUnknownSync(schema);
      expect(decode(input)).toEqual(input);
      expect(decode(JSON.parse(JSON.stringify({ ...input, [field]: runtimeId })))).toMatchObject({
        [field]: runtimeId,
      });
      for (const invalid of [
        "",
        "runtime-1",
        ` ${runtimeId}`,
        `${runtimeId}\n`,
        null,
        "x".repeat(512),
      ]) {
        expect(() => decode({ ...input, [field]: invalid })).toThrow();
      }
    }
  });
  it("allows explicit unknown only in projected session replacement", () => {
    const decode = Schema.decodeUnknownSync(OrchestrationSession);
    const input = {
      threadId: "thread",
      status: "ready",
      providerName: "codex",
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: null,
      updatedAt: at,
    };
    expect(decode({ ...input, subagentRuntimeId: null }).subagentRuntimeId).toBeNull();
    expect(decode({ ...input, subagentRuntimeId: runtimeId }).subagentRuntimeId).toBe(runtimeId);
  });
});
