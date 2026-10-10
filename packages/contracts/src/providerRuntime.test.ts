import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";

import {
  ItemLifecyclePayload,
  ProviderRuntimeEvent,
  UsageAccountingSnapshot,
  ProviderNativeRetryProgress,
  isCodexNativeRetryWarningPayload,
} from "./providerRuntime.ts";

const decodeRuntimeEvent = Schema.decodeUnknownSync(ProviderRuntimeEvent);
const decodeAccountingSnapshot = Schema.decodeUnknownSync(UsageAccountingSnapshot);
const runtimeEventJson = Schema.fromJsonString(ProviderRuntimeEvent);
const encodeRuntimeEventJson = Schema.encodeSync(runtimeEventJson);
const decodeRuntimeEventJson = Schema.decodeUnknownSync(runtimeEventJson);
const lifecyclePayloadJson = Schema.fromJsonString(ItemLifecyclePayload);
const encodeLifecyclePayloadJson = Schema.encodeSync(lifecyclePayloadJson);
const decodeLifecyclePayloadJson = Schema.decodeUnknownSync(lifecyclePayloadJson);
const decodeLifecyclePayload = Schema.decodeUnknownSync(ItemLifecyclePayload);

// These are source-text fixtures, not display labels. Boundary whitespace,
// literal CRLF, Markdown indentation, UTF-16 surrogate pairs and lone units
// all contribute to the ingestion commitment and must survive both schema
// codec directions.
const exactItemDetails = [
  { label: "leading spaces", detail: "  The complete answer." },
  { label: "trailing spaces", detail: "I finished the work.  " },
  { label: "trailing newlines", detail: "Both entries remain.\n\n" },
  { label: "CRLF", detail: "\r\nThe first line.\r\nThe second line.\r\n" },
  { label: "tabs and indentation", detail: "\t    const answer = 42;\n\t" },
  { label: "surrogate pairs", detail: "  Both \uD83D\uDE80 and \uD83E\uDDEA remain.\r\n" },
  // A provider can expose lone units independently of well-formed Unicode.
  // JSON escaping must retain both units rather than replace them with U+FFFD.
  { label: "lone surrogate units", detail: "  High \uD83D and low \uDE80 remain.\r\n" },
  { label: "Unicode source", detail: "\u00a0\u3000日本語と e\u0301 remain.\u2003\n" },
];

describe("ItemLifecyclePayload source text", () => {
  it.each(exactItemDetails)("retains exact $label through object and JSON codecs", ({ detail }) => {
    const payload = { itemType: "assistant_message", detail } as const;
    expect(decodeLifecyclePayload(payload)).toEqual(payload);

    // Encode the original typed value independently of decoding: a lossy
    // encode transform can otherwise be hidden by a prior decode transform.
    const encoded = encodeLifecyclePayloadJson(payload);
    expect(JSON.parse(encoded)).toEqual(payload);
    expect(decodeLifecyclePayloadJson(encoded)).toEqual(payload);
  });

  it.each(["", " ", "\t\r\n", "\u00a0\u2003\u3000"])(
    "rejects empty or whitespace-only detail %j in both codec directions",
    (detail) => {
      const payload = { itemType: "assistant_message", detail } as const;
      expect(() => decodeLifecyclePayload(payload)).toThrow();
      expect(() => decodeLifecyclePayloadJson(JSON.stringify(payload))).toThrow();
      expect(() => encodeLifecyclePayloadJson(payload)).toThrow();
    },
  );

  it("still normalizes title without normalizing source detail", () => {
    const input = {
      itemType: "assistant_message",
      title: " \tAssistant message\r\n",
      detail: "  The complete answer.\r\n",
    } as const;
    const expected = { ...input, title: "Assistant message" };
    expect(decodeLifecyclePayload(input)).toEqual(expected);
    expect(JSON.parse(encodeLifecyclePayloadJson(input))).toEqual(expected);
    expect(decodeLifecyclePayloadJson(JSON.stringify(input))).toEqual(expected);
  });
});

describe("ProviderRuntimeEvent", () => {
  it("admits only inert content-free native retry bookkeeping without invoking accessors", () => {
    const payload = {
      message: "Provider reconnecting",
      retrying: true,
      detail: { willRetry: true },
      nativeRetry: { observedCount: 12, timing: "unknown" },
    };
    expect(isCodexNativeRetryWarningPayload(payload)).toBe(true);
    expect(
      isCodexNativeRetryWarningPayload({
        ...payload,
        nativeRetry: { ...payload.nativeRetry, countLimited: true },
      }),
    ).toBe(true);
    const { nativeRetry: _retry, ...legacy } = payload;
    expect(isCodexNativeRetryWarningPayload(legacy)).toBe(true);
    for (const malformed of [
      { ...payload, retrying: false },
      { ...payload, message: "Other warning" },
      { ...payload, detail: { willRetry: true, private: "must not qualify" } },
      { ...payload, nativeRetry: { observedCount: 12, timing: "guessed" } },
      { ...payload, nativeRetry: { ...payload.nativeRetry, countLimited: false } },
      { ...payload, nativeRetry: undefined },
      { ...payload, private: "unknown" },
      Object.create(payload),
    ])
      expect(isCodexNativeRetryWarningPayload(malformed)).toBe(false);
    let reads = 0;
    const accessor = Object.defineProperty({}, "message", {
      get() {
        reads += 1;
        return payload.message;
      },
    });
    expect(isCodexNativeRetryWarningPayload(accessor)).toBe(false);
    const detailAccessor = {
      ...payload,
      detail: Object.defineProperty({}, "willRetry", {
        get() {
          reads += 1;
          return true;
        },
      }),
    };
    expect(isCodexNativeRetryWarningPayload(detailAccessor)).toBe(false);
    expect(reads).toBe(0);
  });
  it("keeps bounded native retry observations separate from scheduling authority", () => {
    const decode = Schema.decodeUnknownSync(ProviderNativeRetryProgress);
    expect(decode({ observedCount: 12, timing: "unknown" })).toEqual({
      observedCount: 12,
      timing: "unknown",
    });
    expect(decode({ observedCount: 1024, timing: "unknown", countLimited: true })).toEqual({
      observedCount: 1024,
      timing: "unknown",
      countLimited: true,
    });
    for (const observedCount of [0, -1, 1.5, 1025, Number.MAX_SAFE_INTEGER, "12", null])
      expect(() => decode({ observedCount, timing: "unknown" })).toThrow();
    expect(() => decode({ observedCount: 12, timing: "scheduled" })).toThrow();
    expect(() => decode({ observedCount: 12, timing: "unknown", countLimited: false })).toThrow();
    const warning = {
      type: "runtime.warning",
      eventId: "retry-display",
      provider: "codex",
      providerInstanceId: "exact-account",
      createdAt: "2026-10-10T11:01:00Z",
      threadId: "thread-1",
      turnId: "root",
      payload: {
        message: "Provider reconnecting",
        detail: { willRetry: true },
        nativeRetry: { observedCount: 12, timing: "unknown" },
      },
    };
    expect(decodeRuntimeEventJson(encodeRuntimeEventJson(decodeRuntimeEvent(warning)))).toEqual(
      warning,
    );
    // Old providers have neither count nor native deadline and stay valid.
    expect(
      decodeRuntimeEvent({ ...warning, payload: { message: "Provider reconnecting" } }).payload,
    ).toEqual({ message: "Provider reconnecting" });
  });
  it("round trips content-free failed-root evidence and rejects permissive availability flags", () => {
    const input = {
      type: "turn.completed",
      eventId: "failed-root-evidence",
      provider: "codex",
      providerInstanceId: "exact-account",
      createdAt: "2026-10-10T11:01:00Z",
      threadId: "thread-1",
      turnId: "failed-root",
      payload: { state: "failed" },
    };
    expect(decodeRuntimeEvent(input).payload).toEqual({ state: "failed" });
    for (const category of ["server", "transport", "rate-limit"]) {
      const value = {
        ...input,
        payload: { state: "failed", codexTransientFailure: category, nativeContextAvailable: true },
      };
      const decoded = decodeRuntimeEvent(value);
      expect(decodeRuntimeEventJson(encodeRuntimeEventJson(decoded))).toEqual(value);
    }
    for (const payload of [
      { state: "failed", codexTransientFailure: "permanent" },
      { state: "failed", nativeContextAvailable: false },
      { state: "failed", nativeContextAvailable: "true" },
      { state: "failed", nativeContextAvailable: 1 },
    ])
      expect(() => decodeRuntimeEvent({ ...input, payload })).toThrow();
  });
  it.each(["codex", "claudeAgent", "grok", "opencode", "ollama"])(
    "preserves lifecycle source detail for %s through runtime event JSON round trips",
    (provider) => {
      // The contract is shared by every built-in driver and is intentionally
      // open to fork-provided drivers. Exercise all item lifecycle variants,
      // not only completion, so a different event wrapper cannot trim source.
      for (const type of ["item.started", "item.updated", "item.completed"] as const) {
        for (const { detail } of exactItemDetails) {
          const input = {
            type,
            eventId: "event-exact-source",
            provider,
            providerInstanceId: "source_fixture",
            createdAt: "2026-10-08T00:00:00.000Z",
            threadId: "thread-exact-source",
            turnId: "turn-exact-source",
            itemId: "item-exact-source",
            payload: { itemType: "assistant_message", detail },
          };
          const decoded = decodeRuntimeEvent(input);
          expect(decoded).toEqual(input);
          const encoded = encodeRuntimeEventJson(decoded);
          expect(JSON.parse(encoded)).toEqual(input);
          expect(decodeRuntimeEventJson(encoded)).toEqual(input);
        }
      }
    },
  );

  it("retains runtime identifier and title normalization while preserving exact detail", () => {
    const input = {
      type: "item.completed",
      eventId: " \tevent-exact-source\n",
      provider: " codex ",
      providerInstanceId: " source_fixture ",
      createdAt: "2026-10-08T00:00:00.000Z",
      threadId: " thread-exact-source\r\n",
      turnId: "\tturn-exact-source ",
      itemId: " item-exact-source\n",
      providerRefs: {
        providerTurnId: " native-turn ",
        providerItemId: "\tnative-item\r\n",
      },
      payload: {
        itemType: "assistant_message",
        title: "\tAssistant message\r\n",
        detail: "  The complete answer.\r\n",
      },
    };
    const expected = {
      ...input,
      eventId: "event-exact-source",
      provider: "codex",
      providerInstanceId: "source_fixture",
      threadId: "thread-exact-source",
      turnId: "turn-exact-source",
      itemId: "item-exact-source",
      providerRefs: { providerTurnId: "native-turn", providerItemId: "native-item" },
      payload: { ...input.payload, title: "Assistant message" },
    };
    const decoded = decodeRuntimeEvent(input);
    expect(decoded).toEqual(expected);
    expect(JSON.parse(encodeRuntimeEventJson(decoded))).toEqual(expected);
    expect(decodeRuntimeEventJson(JSON.stringify(input))).toEqual(expected);
  });

  it("bounds independent billing snapshots and rejects unsafe aggregate counts or identifiers", () => {
    const decode = decodeAccountingSnapshot;
    const model = {
      model: "claude-sonnet-5",
      inputTokens: 100,
      cachedInputTokens: 80,
      cacheWriteInputTokens: 10,
      outputTokens: 20,
      reasoningOutputTokens: 5,
    };
    const snapshot = {
      scopeId: "10000000-0000-4000-8000-000000000000",
      revision: 1,
      completeness: "complete",
      models: [model],
    };
    expect(decode(snapshot)).toEqual(snapshot);
    for (const invalid of [
      { ...snapshot, scopeId: "provider-account-id" },
      { ...snapshot, revision: Infinity },
      { ...snapshot, models: [model, model] },
      { ...snapshot, models: [{ ...model, cachedInputTokens: 101 }] },
      { ...snapshot, models: [{ ...model, model: "/private/account/path" }] },
      // Separately safe input/output columns must also fit the processed total,
      // both within one row and when independent model rows are combined.
      { ...snapshot, models: [{ ...model, inputTokens: Number.MAX_SAFE_INTEGER }] },
      {
        ...snapshot,
        models: [
          { ...model, inputTokens: Number.MAX_SAFE_INTEGER - 120 },
          { ...model, model: "claude-haiku-4-5" },
        ],
      },
      {
        ...snapshot,
        models: [
          { ...model, outputTokens: Number.MAX_SAFE_INTEGER },
          { ...model, model: "claude-haiku-4-5", outputTokens: 1 },
        ],
      },
    ])
      expect(() => decode(invalid)).toThrow();
    expect(
      decodeRuntimeEvent({
        type: "thread.usage-accounting.updated",
        provider: "claudeAgent",
        threadId: "thread-1",
        eventId: "event-accounting-1",
        createdAt: "2026-09-05T00:00:00Z",
        payload: snapshot,
      }).type,
    ).toBe("thread.usage-accounting.updated");
  });
  it("accepts fork-provided driver kinds as branded slugs", () => {
    const parsed = decodeRuntimeEvent({
      type: "session.started",
      eventId: "event-ollama-session",
      provider: "ollama",
      providerInstanceId: "ollama_local",
      createdAt: "2026-02-28T00:00:00.000Z",
      threadId: "thread-1",
      payload: {
        message: "started",
      },
    });

    expect(parsed.provider).toBe("ollama");
    expect(parsed.providerInstanceId).toBe("ollama_local");
  });

  it("decodes turn.plan.updated for plan rendering", () => {
    const parsed = decodeRuntimeEvent({
      type: "turn.plan.updated",
      eventId: "event-1",
      provider: "claudeAgent",
      sessionId: "runtime-session-1",
      createdAt: "2026-02-28T00:00:00.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      payload: {
        explanation: "Implement schema updates",
        plan: [
          { step: "Define event union", status: "completed" },
          { step: "Wire adapter mapping", status: "inProgress" },
        ],
      },
    });

    expect(parsed.type).toBe("turn.plan.updated");
    if (parsed.type !== "turn.plan.updated") {
      throw new Error("expected turn.plan.updated");
    }
    expect(parsed.payload.plan).toHaveLength(2);
    expect(parsed.payload.plan[1]?.status).toBe("inProgress");
  });

  it("enforces bounded structured subagent presentation text", () => {
    const baseEvent = {
      type: "task.started",
      eventId: "event-bounded-subagent",
      provider: "codex",
      createdAt: "2026-02-28T00:00:00.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      payload: {
        taskId: "child-1",
        subagent: {
          threadId: "x".repeat(512),
          historyId: "h".repeat(512),
          label: "l".repeat(96),
          path: "p".repeat(256),
          role: "r".repeat(80),
          objective: "o".repeat(240),
          status: "active",
        },
      },
    };

    expect(decodeRuntimeEvent(baseEvent).type).toBe("task.started");
    expect(() =>
      decodeRuntimeEvent({
        ...baseEvent,
        payload: {
          ...baseEvent.payload,
          subagent: { ...baseEvent.payload.subagent, threadId: "x".repeat(513) },
        },
      }),
    ).toThrow();
    expect(() =>
      decodeRuntimeEvent({
        ...baseEvent,
        payload: {
          ...baseEvent.payload,
          subagent: { ...baseEvent.payload.subagent, historyId: "h".repeat(513) },
        },
      }),
    ).toThrow();
    expect(() =>
      decodeRuntimeEvent({
        ...baseEvent,
        payload: {
          ...baseEvent.payload,
          subagent: { ...baseEvent.payload.subagent, objective: "o".repeat(241) },
        },
      }),
    ).toThrow();
  });

  it("decodes proposed-plan completion events", () => {
    const parsed = decodeRuntimeEvent({
      type: "turn.proposed.completed",
      eventId: "event-proposed-plan-1",
      provider: "codex",
      createdAt: "2026-02-28T00:00:00.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      payload: {
        planMarkdown: "# Ship it",
      },
    });

    expect(parsed.type).toBe("turn.proposed.completed");
    if (parsed.type !== "turn.proposed.completed") {
      throw new Error("expected turn.proposed.completed");
    }
    expect(parsed.payload.planMarkdown).toBe("# Ship it");
  });

  it("decodes user-input.requested with structured questions", () => {
    const parsed = decodeRuntimeEvent({
      type: "user-input.requested",
      eventId: "event-2",
      provider: "claudeAgent",
      sessionId: "runtime-session-2",
      createdAt: "2026-02-28T00:00:01.000Z",
      threadId: "thread-2",
      requestId: "request-1",
      payload: {
        questions: [
          {
            id: "sandbox_mode",
            header: "Sandbox",
            question: "Which mode should be used?",
            options: [
              {
                label: "workspace-write",
                description: "Allow edits in workspace only",
              },
              {
                label: "danger-full-access",
                description: "Allow unrestricted access",
              },
            ],
          },
        ],
      },
    });

    expect(parsed.type).toBe("user-input.requested");
    if (parsed.type !== "user-input.requested") {
      throw new Error("expected user-input.requested");
    }
    expect(parsed.payload.questions[0]?.id).toBe("sandbox_mode");
    expect(parsed.payload.questions[0]?.options).toHaveLength(2);
  });

  it("decodes user-input.resolved with answer map", () => {
    const parsed = decodeRuntimeEvent({
      type: "user-input.resolved",
      eventId: "event-3",
      provider: "claudeAgent",
      sessionId: "runtime-session-2",
      createdAt: "2026-02-28T00:00:02.000Z",
      threadId: "thread-2",
      requestId: "request-1",
      payload: {
        answers: {
          sandbox_mode: "workspace-write",
        },
      },
    });

    expect(parsed.type).toBe("user-input.resolved");
    if (parsed.type !== "user-input.resolved") {
      throw new Error("expected user-input.resolved");
    }
    expect(parsed.payload.answers.sandbox_mode).toBe("workspace-write");
  });

  it("rejects unsupported runtime event types", () => {
    expect(() =>
      decodeRuntimeEvent({
        type: "unsupported.event",
        eventId: "event-4",
        provider: "codex",
        sessionId: "runtime-session-3",
        createdAt: "2026-02-28T00:00:03.000Z",
        payload: {},
      }),
    ).toThrow();
  });

  it("rejects empty branded canonical ids", () => {
    expect(() =>
      decodeRuntimeEvent({
        type: "runtime.error",
        eventId: "event-5",
        provider: "codex",
        sessionId: "runtime-session-3",
        createdAt: "2026-02-28T00:00:03.000Z",
        threadId: "   ",
        payload: { message: "boom" },
      }),
    ).toThrow();
  });

  it("decodes normalized thread token usage snapshots", () => {
    const parsed = decodeRuntimeEvent({
      type: "thread.token-usage.updated",
      eventId: "event-token-usage-1",
      provider: "claudeAgent",
      createdAt: "2026-02-28T00:00:04.000Z",
      threadId: "thread-1",
      payload: {
        usage: {
          usedTokens: 31251,
          maxTokens: 200000,
          toolUses: 25,
          durationMs: 43567,
        },
      },
    });

    expect(parsed.type).toBe("thread.token-usage.updated");
    if (parsed.type !== "thread.token-usage.updated") {
      throw new Error("expected thread.token-usage.updated");
    }
    expect(parsed.payload.usage.maxTokens).toBe(200000);
    expect(parsed.payload.usage.usedTokens).toBe(31251);
  });

  it("decodes provider VCS invalidation hints without a filesystem path", () => {
    const parsed = decodeRuntimeEvent({
      type: "vcs.state.changed",
      eventId: "event-vcs-state-changed-1",
      provider: "claudeAgent",
      createdAt: "2026-08-18T00:00:00.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      payload: {
        kind: "commit",
        branch: "main",
      },
    });

    expect(parsed.type).toBe("vcs.state.changed");
    if (parsed.type !== "vcs.state.changed") {
      throw new Error("expected vcs.state.changed");
    }
    expect(parsed.payload).toEqual({ kind: "commit", branch: "main" });
    expect("cwd" in parsed.payload).toBe(false);
  });
});
