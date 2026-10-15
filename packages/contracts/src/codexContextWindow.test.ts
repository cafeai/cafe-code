import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import {
  CodexContextWindowOverride,
  validCodexContextWindowOverride,
} from "./codexContextWindow.ts";
import { ClientOrchestrationCommand, OrchestrationSession } from "./orchestration.ts";
import { ProviderSessionStartInput } from "./provider.ts";
import { ProviderInstanceConfig } from "./providerInstance.ts";
import { ProviderDaemonAdapterCapabilities } from "./providerDaemon.ts";

describe("Codex context-window override transport", () => {
  it.each([1, 500_000, Number.MAX_SAFE_INTEGER])(
    "preserves the exact requested safe integer %s",
    (value) => {
      expect(Schema.decodeUnknownSync(CodexContextWindowOverride)(value)).toBe(value);
      expect(validCodexContextWindowOverride(value)).toBe(true);
    },
  );
  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "500000", null, false])(
    "refuses malformed or inexact token counts %s",
    (value) => {
      expect(() => Schema.decodeUnknownSync(CodexContextWindowOverride)(value)).toThrow();
      if (typeof value === "number") expect(validCodexContextWindowOverride(value)).toBe(false);
    },
  );
  it("distinguishes omitted metadata from explicit inheritance and does not create a default", () => {
    const parse = Schema.decodeUnknownSync(ClientOrchestrationCommand);
    const base = { type: "thread.meta.update", commandId: "context-save", threadId: "chat" };
    expect(parse(base)).not.toHaveProperty("codexContextWindowOverride");
    expect(parse({ ...base, codexContextWindowOverride: null })).toHaveProperty(
      "codexContextWindowOverride",
      null,
    );
    expect(parse({ ...base, codexContextWindowOverride: 500_000 })).toHaveProperty(
      "codexContextWindowOverride",
      500_000,
    );
    expect(() => parse({ ...base, codexContextWindowOverride: 0 })).toThrow();
  });
  it("preserves unknown versus known inherited materialization and the internal idle guard", () => {
    const start = Schema.decodeUnknownSync(ProviderSessionStartInput);
    const base = { threadId: "chat", runtimeMode: "approval-required" };
    expect(start(base)).not.toHaveProperty("codexContextWindowOverride");
    expect(start({ ...base, codexContextWindowOverride: null })).toHaveProperty(
      "codexContextWindowOverride",
      null,
    );
    expect(
      start({
        ...base,
        codexContextWindowOverride: 500_000,
        requireIdleForCodexContextWindowChange: true,
      }),
    ).toMatchObject({
      codexContextWindowOverride: 500_000,
      requireIdleForCodexContextWindowChange: true,
    });
    const session = {
      ...base,
      status: "ready",
      providerName: "codex",
      activeTurnId: null,
      lastError: null,
      updatedAt: "2026-10-12T00:00:00.000Z",
    };
    expect(Schema.decodeUnknownSync(OrchestrationSession)(session)).not.toHaveProperty(
      "codexContextWindowOverride",
    );
    expect(
      Schema.decodeUnknownSync(OrchestrationSession)({
        ...session,
        codexContextWindowOverride: null,
      }),
    ).toHaveProperty("codexContextWindowOverride", null);
  });
  it("keeps the live account default separate from runtime config and old capability unknown", () => {
    const parse = Schema.decodeUnknownSync(ProviderInstanceConfig);
    expect(parse({ driver: "codex", defaultCodexContextWindowOverride: 500_000 })).toEqual({
      driver: "codex",
      defaultCodexContextWindowOverride: 500_000,
    });
    expect(() => parse({ driver: "codex", defaultCodexContextWindowOverride: 0 })).toThrow();
    const caps = { sessionModelSwitch: "restart-resume", liveSteer: "supported" };
    expect(Schema.decodeUnknownSync(ProviderDaemonAdapterCapabilities)(caps)).not.toHaveProperty(
      "codexContextWindow",
    );
    expect(
      Schema.decodeUnknownSync(ProviderDaemonAdapterCapabilities)({
        ...caps,
        codexContextWindow: false,
      }),
    ).toHaveProperty("codexContextWindow", false);
    const decode = Schema.decodeUnknownSync(ProviderDaemonAdapterCapabilities);
    expect(decode({ ...caps, codexContextWindow: true })).not.toHaveProperty(
      "codexContextCompaction",
    );
    for (const paired of [true, false]) {
      expect(decode({ ...caps, codexContextCompaction: paired })).toHaveProperty(
        "codexContextCompaction",
        paired,
      );
    }
    for (const malformed of ["true", 1, null]) {
      expect(() => decode({ ...caps, codexContextCompaction: malformed })).toThrow();
    }
  });
});
