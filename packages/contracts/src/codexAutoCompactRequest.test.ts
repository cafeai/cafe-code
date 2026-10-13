import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { OrchestrationSession, ClientOrchestrationCommand } from "./orchestration.ts";
import { ProviderSession, ProviderSessionStartInput } from "./provider.ts";

describe("native Codex auto-compaction request provenance", () => {
  const now = "2026-10-14T00:00:00.000Z";
  const provider = {
    provider: "codex",
    threadId: "chat",
    status: "ready",
    runtimeMode: "full-access",
    createdAt: now,
    updatedAt: now,
    codexContextWindowOverride: 800_000,
  };
  const projection = {
    threadId: "chat",
    status: "ready",
    providerName: "codex",
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: null,
    updatedAt: now,
    codexContextWindowOverride: 800_000,
  };
  it("does not infer pairing from legacy context and retains positive omission or exact request", () => {
    const parseProvider = Schema.decodeUnknownSync(ProviderSession);
    const parseProjection = Schema.decodeUnknownSync(OrchestrationSession);
    expect(parseProvider(provider)).not.toHaveProperty("codexAutoCompactTokenLimit");
    expect(parseProjection(projection)).not.toHaveProperty("codexAutoCompactTokenLimit");
    for (const value of [null, 1, 800_000, Number.MAX_SAFE_INTEGER]) {
      expect(parseProvider({ ...provider, codexAutoCompactTokenLimit: value })).toHaveProperty(
        "codexAutoCompactTokenLimit",
        value,
      );
      expect(parseProjection({ ...projection, codexAutoCompactTokenLimit: value })).toHaveProperty(
        "codexAutoCompactTokenLimit",
        value,
      );
    }
  });
  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "800000", false])(
    "rejects malformed received request evidence %s",
    (value) => {
      expect(() =>
        Schema.decodeUnknownSync(ProviderSession)({
          ...provider,
          codexAutoCompactTokenLimit: value,
        }),
      ).toThrow();
      expect(() =>
        Schema.decodeUnknownSync(OrchestrationSession)({
          ...projection,
          codexAutoCompactTokenLimit: value,
        }),
      ).toThrow();
    },
  );
  it("does not accept request proof as provider-start or public metadata intent", () => {
    expect(
      Schema.decodeUnknownSync(ProviderSessionStartInput)({
        threadId: "chat",
        runtimeMode: "full-access",
        codexAutoCompactTokenLimit: 800_000,
      }),
    ).not.toHaveProperty("codexAutoCompactTokenLimit");
    expect(
      Schema.decodeUnknownSync(ClientOrchestrationCommand)({
        type: "thread.meta.update",
        commandId: "not-proof",
        threadId: "chat",
        codexAutoCompactTokenLimit: 800_000,
      }),
    ).not.toHaveProperty("codexAutoCompactTokenLimit");
  });
});
