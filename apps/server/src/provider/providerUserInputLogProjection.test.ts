import { describe, expect, it } from "vitest";
import type { ProviderRuntimeEvent } from "@cafecode/contracts";
import { projectProviderEventForOperationalLog } from "./providerUserInputLogProjection.ts";

const envelope = {
  eventId: "event-input-privacy",
  provider: "claudeAgent",
  providerInstanceId: "claude-instance",
  subagentRuntimeId: "runtime-input-privacy",
  threadId: "thread-input-privacy",
  requestId: "request-input-privacy",
  turnId: "turn-input-privacy",
  createdAt: "2026-10-30T05:00:00.000Z",
};
const fixture = (type: string, payload: unknown): ProviderRuntimeEvent =>
  ({
    ...envelope,
    type,
    payload,
    raw: { source: "claude.sdk.permission", payload: { secret: "raw-copy-sentinel" } },
    diagnostic: { secret: "private-diagnostic-sentinel" },
    providerRefs: { secret: "future-provider-ref-sentinel" },
    future: { secret: "future-extra-sentinel" },
  }) as unknown as ProviderRuntimeEvent;

describe("structured user-input operational logging", () => {
  it("logs routing/count/capability metadata without questions, form data or raw aliases", () => {
    const source = fixture("user-input.requested", {
      questions: [
        {
          id: "private-question-id",
          question: "private-question-text",
          options: ["private-option"],
        },
      ],
      isBlocking: true,
      supportsUnanswered: true,
      interaction: { url: "https://example.test/?secret=private-auth-url" },
      future: "private-payload-extra",
    });
    const before = JSON.stringify(source);
    const result = projectProviderEventForOperationalLog(source);
    expect(result).toEqual({
      ...envelope,
      type: "user-input.requested",
      payload: {
        contentOmitted: true,
        questionCount: 1,
        isBlocking: true,
        supportsUnanswered: true,
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/private-|raw-copy|future-/);
    expect(JSON.stringify(source)).toBe(before);
  });

  it("omits real answers, full-text unanswered keys and resolution raw copies", () => {
    const source = fixture("user-input.resolved", {
      answers: { "private-answered-question": "private-answer-text" },
      unanswered: {
        "private-skipped-question": "skipped",
        "private-dismissed-question": "dismissed",
      },
      autoResolved: false,
      cancelled: false,
      future: "private-resolution-extra",
    });
    const before = JSON.stringify(source);
    const result = projectProviderEventForOperationalLog(source);
    expect(result).toEqual({
      ...envelope,
      type: "user-input.resolved",
      payload: {
        contentOmitted: true,
        autoResolved: false,
        cancelled: false,
        hasExplicitUnanswered: true,
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/private-|raw-copy|future-|skipped|dismissed/);
    expect(JSON.stringify(source)).toBe(before);
  });

  it("does not read secret-bearing accessors, toJSON hooks or question elements", () => {
    let reads = 0;
    const secret = {
      enumerable: true,
      get() {
        reads += 1;
        return "private-getter";
      },
    };
    const questions = [Object.defineProperty({}, "question", secret)];
    const payload = Object.defineProperties(
      { questions },
      { answers: secret, unanswered: secret, toJSON: secret },
    );
    const source = Object.defineProperties(
      { ...envelope, type: "user-input.requested", payload },
      {
        raw: secret,
        diagnostic: secret,
        future: secret,
        toJSON: secret,
      },
    ) as unknown as ProviderRuntimeEvent;
    expect(projectProviderEventForOperationalLog(source)).toEqual({
      ...envelope,
      type: "user-input.requested",
      payload: { contentOmitted: true, questionCount: 1 },
    });
    const resolved = {
      ...envelope,
      type: "user-input.resolved",
      payload,
    } as unknown as ProviderRuntimeEvent;
    expect(projectProviderEventForOperationalLog(resolved)).toEqual({
      ...envelope,
      type: "user-input.resolved",
      payload: { contentOmitted: true },
    });
    expect(reads).toBe(0);
  });

  it("refuses proxy envelopes and skips proxy payload/list internals without traps", () => {
    let traps = 0;
    const handler = {
      get() {
        traps += 1;
        return undefined;
      },
      ownKeys() {
        traps += 1;
        return [];
      },
      getOwnPropertyDescriptor() {
        traps += 1;
        return undefined;
      },
      getPrototypeOf() {
        traps += 1;
        return null;
      },
    };
    const event = fixture("user-input.requested", {});
    const revoked = Proxy.revocable(event, handler);
    revoked.revoke();
    for (const source of [new Proxy(event, handler), revoked.proxy])
      expect(projectProviderEventForOperationalLog(source)).toEqual({
        observation: "omitted-unsafe-provider-event",
      });
    for (const payload of [new Proxy({}, handler), { questions: new Proxy([], handler) }])
      expect(
        projectProviderEventForOperationalLog(fixture("user-input.requested", payload)),
      ).toEqual({
        ...envelope,
        type: "user-input.requested",
        payload: { contentOmitted: true },
      });
    expect(traps).toBe(0);
  });

  it("keeps only finite own routing primitives and emits serialization-safe records", () => {
    let reads = 0;
    const source = Object.defineProperty(
      {
        ...fixture("user-input.resolved", { cancelled: true }),
        itemId: "x".repeat(513),
      },
      "providerInstanceId",
      {
        enumerable: true,
        get() {
          reads += 1;
          return "private-instance";
        },
      },
    );
    const result = projectProviderEventForOperationalLog(source) as Record<string, unknown>;
    expect(result).not.toHaveProperty("itemId");
    expect(result).not.toHaveProperty("providerInstanceId");
    expect(Object.getPrototypeOf(result)).toBeNull();
    expect(Object.getPrototypeOf(result.payload)).toBeNull();
    expect(reads).toBe(0);
  });

  it("preserves ordinary event observability and the original native/control payload objects", () => {
    const source = fixture("item.started", {
      itemType: "tool_call",
      toolName: "Read",
      input: { file_path: "visible-tool-input" },
    });
    const result = projectProviderEventForOperationalLog(source) as ProviderRuntimeEvent;
    expect(result).toEqual({ ...source, diagnostic: undefined });
    expect(result.payload).toBe(source.payload);
    expect(result.raw).toBe(source.raw);
    expect(source.diagnostic).toEqual({ secret: "private-diagnostic-sentinel" });
  });
});
