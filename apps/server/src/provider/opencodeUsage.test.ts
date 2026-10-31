import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";
import { UsageAccountingSnapshot } from "@cafecode/contracts";
import { makeOpenCodeUsage } from "./opencodeUsage.ts";

const decodeSnapshot = Schema.decodeUnknownSync(UsageAccountingSnapshot);

const identity = {
  instanceId: "opencode-work",
  threadId: "cafe-thread",
  directory: "/synthetic/project",
  serverUrl: null,
  sessionId: "ses_native",
};
const tokens = { input: 100, output: 20, reasoning: 5, cache: { read: 30, write: 10 } };
const message = (overrides: Record<string, unknown> = {}) => ({
  id: "msg_native",
  sessionID: identity.sessionId,
  role: "assistant",
  providerID: "openrouter",
  modelID: "anthropic/claude-sonnet-4-5",
  time: { created: 1_000 },
  tokens,
  cost: 999, // Assistant cost accumulates steps; never bill this field too.
  ...overrides,
});
const step = (overrides: Record<string, unknown> = {}) => ({
  id: "prt_native",
  messageID: "msg_native",
  sessionID: identity.sessionId,
  type: "step-finish",
  tokens: { ...tokens, total: 999_999 },
  cost: 0.00123456,
  ...overrides,
});

describe("OpenCode usage", () => {
  it("normalizes disjoint buckets and reports per-step native USD without summing message cost or total", () => {
    const usage = makeOpenCodeUsage(identity);
    const observed = usage.observeMessage(message());
    expect(observed.accounting).toEqual([]);
    expect(observed.context).toEqual({
      usedTokens: 165,
      inputTokens: 140,
      cachedInputTokens: 30,
      cacheWriteInputTokens: 10,
      outputTokens: 25,
      reasoningOutputTokens: 5,
    });
    const snapshot = usage.observeStep(step());
    expect(snapshot?.models).toEqual([
      {
        model: "openrouter/anthropic/claude-sonnet-4-5",
        inputTokens: 140,
        cachedInputTokens: 30,
        cacheWriteInputTokens: 10,
        outputTokens: 25,
        reasoningOutputTokens: 5,
        reportedCostMicrousd: "1235",
      },
    ]);
    expect(decodeSnapshot(snapshot)).toEqual(snapshot);
    expect(usage.observeStep(step())).toBeUndefined();
    expect(usage.observeMessage(message()).context).toBeUndefined();
    const second = usage.observeStep(step({ id: "prt_second" }));
    expect(second?.scopeId).not.toBe(snapshot?.scopeId);
    expect(second?.models).toEqual(snapshot?.models);
    expect(JSON.stringify(snapshot)).not.toContain("ses_native");
    expect(JSON.stringify(snapshot)).not.toContain("opencode-work");
    expect(JSON.stringify(snapshot)).not.toContain(identity.directory);
  });

  it("joins part-before-message observations, scopes them to the actual session and preserves native model attribution", () => {
    const usage = makeOpenCodeUsage(identity);
    expect(usage.observeStep(step())).toBeUndefined();
    expect(usage.observeMessage(message({ role: "user" })).accounting).toEqual([]);
    expect(usage.observeMessage(message({ sessionID: "child-session" })).accounting).toEqual([]);
    expect(usage.observeStep(step({ sessionID: "child-session" }))).toBeUndefined();
    const observed = usage.observeMessage(message());
    expect(observed.accounting).toHaveLength(1);
    expect(usage.observeMessage(message({ modelID: "other-model" })).accounting).toEqual([]);
    expect(usage.observeStep(step({ id: "next" }))?.models[0]?.model).toBe(
      "openrouter/anthropic/claude-sonnet-4-5",
    );
  });

  it("deduplicates reconnects and FIFO eviction through the same opaque settlement scope", () => {
    const usage = makeOpenCodeUsage(identity);
    usage.observeMessage(message());
    const first = usage.observeStep(step());
    for (let index = 0; index < 2_048; index++) usage.observeStep(step({ id: `part-${index}` }));
    expect(usage.observeStep(step())).toEqual(first);
    const reopened = makeOpenCodeUsage(identity);
    reopened.observeMessage(message());
    expect(reopened.observeStep(step())).toEqual(first);
    for (const replacement of [
      { ...identity, sessionId: "replacement" },
      { ...identity, instanceId: "another-account" },
      { ...identity, serverUrl: "https://synthetic.invalid" },
      { ...identity, directory: "/another/project" },
      { ...identity, threadId: "another-thread" },
    ]) {
      const independent = makeOpenCodeUsage(replacement);
      independent.observeMessage(message({ sessionID: replacement.sessionId }));
      expect(independent.observeStep(step({ sessionID: replacement.sessionId }))?.scopeId).not.toBe(
        first?.scopeId,
      );
    }
  });

  it("uses the latest call's exact model limit, handles model switches and compaction reductions, and fences delayed older context", () => {
    const usage = makeOpenCodeUsage(identity);
    usage.observeMessage(message());
    expect(
      usage.updateLimits({
        all: [
          {
            id: "openrouter",
            models: {
              "anthropic/claude-sonnet-4-5": { limit: { context: 200_000 } },
              "other-model": { limit: { context: 50_000 } },
            },
          },
        ],
      })?.maxTokens,
    ).toBe(200_000);
    const next = message({
      id: "compact-summary",
      modelID: "other-model",
      time: { created: 2_000 },
      tokens: { input: 10, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
    });
    expect(usage.observeMessage(next).context).toMatchObject({ usedTokens: 12, maxTokens: 50_000 });
    expect(usage.observeMessage(message()).context).toBeUndefined();
    expect(
      usage.observeMessage(
        message({
          id: "empty-new-call",
          time: { created: 3_000 },
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
      ).context,
    ).toBeUndefined();
    expect(
      usage.observeMessage(
        message({ id: "unknown-model", modelID: "unknown", time: { created: 4_000 } }),
      ).context,
    ).not.toHaveProperty("maxTokens");
  });

  it("rejects malformed/overflowing token counts while retaining tokens with unreported models or costs", () => {
    for (const invalid of [NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER]) {
      const usage = makeOpenCodeUsage(identity);
      usage.observeMessage(message());
      expect(usage.observeStep(step({ tokens: { ...tokens, input: invalid } }))).toBeUndefined();
    }
    for (const invalid of [undefined, null, NaN, Infinity, -1, "0.5", 1e99]) {
      const usage = makeOpenCodeUsage(identity);
      usage.observeMessage(message());
      expect(usage.observeStep(step({ cost: invalid }))?.models[0]).not.toHaveProperty(
        "reportedCostMicrousd",
      );
    }
    const free = makeOpenCodeUsage(identity);
    free.observeMessage(message());
    expect(free.observeStep(step({ cost: 0 }))?.models[0]?.reportedCostMicrousd).toBe("0");
    for (const invalid of [
      undefined,
      "/private/path",
      "model with spaces",
      "a".repeat(257),
      "../secret",
    ]) {
      const usage = makeOpenCodeUsage(identity);
      expect(usage.observeMessage(message({ modelID: invalid })).context?.usedTokens).toBe(165);
      expect(usage.observeStep(step())?.models[0]?.model).toBe("unknown");
    }
  });

  it("bounds unmatched native settlements instead of retaining a transcript indefinitely", () => {
    const usage = makeOpenCodeUsage(identity);
    for (let index = 0; index < 300; index++) usage.observeStep(step({ id: `pending-${index}` }));
    expect(usage.observeMessage(message()).accounting).toHaveLength(256);
  });
});
