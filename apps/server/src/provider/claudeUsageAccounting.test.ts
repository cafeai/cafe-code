import { describe, expect, it } from "vitest";
import {
  makeClaudeUsageAccounting,
  observeClaudeAssistantUsage,
  observeClaudeResultUsage,
} from "./claudeUsageAccounting.ts";

const SCOPE = "10000000-0000-4000-8000-000000000000";
const MODEL = "claude-sonnet-5";
const assistant = (
  id: string,
  input: number,
  options: { cached?: number; written?: number; model?: string; parent?: string } = {},
) => ({
  type: "assistant",
  parent_tool_use_id: options.parent ?? null,
  message: {
    id,
    model: options.model ?? MODEL,
    usage: {
      input_tokens: input,
      cache_read_input_tokens: options.cached ?? 0,
      cache_creation_input_tokens: options.written ?? 0,
      // This deliberately implausible placeholder must never enter accounting.
      output_tokens: 987654,
    },
  },
});
const modelUsage = (
  inputTokens: number,
  outputTokens: number,
  cacheReadInputTokens = 0,
  cacheCreationInputTokens = 0,
  thinkingTokens = 0,
) => ({
  inputTokens,
  outputTokens,
  cacheReadInputTokens,
  cacheCreationInputTokens,
  thinkingTokens,
});
const result = (models: Record<string, ReturnType<typeof modelUsage>>) => ({
  type: "result",
  modelUsage: models,
});

describe("Claude billing accounting", () => {
  it("counts equal/growing independent requests fully and deduplicates parallel assistant copies by API ID", () => {
    const state = makeClaudeUsageAccounting(SCOPE);
    observeClaudeAssistantUsage(state, assistant("a", 100000));
    expect(observeClaudeAssistantUsage(state, assistant("a", 100000))).toBeUndefined();
    observeClaudeAssistantUsage(state, assistant("b", 100000));
    const snapshot = observeClaudeAssistantUsage(state, assistant("c", 101000));
    expect(snapshot?.models[0]).toMatchObject({ inputTokens: 301000, outputTokens: 0 });
    expect(snapshot?.completeness).toBe("input-only");
  });

  it("keeps cache reads/writes as input subsets and thinking as an output subset", () => {
    const state = makeClaudeUsageAccounting(SCOPE);
    observeClaudeAssistantUsage(state, assistant("a", 100, { cached: 800, written: 100 }));
    observeClaudeAssistantUsage(state, assistant("b", 100, { cached: 800, written: 100 }));
    const snapshot = observeClaudeResultUsage(
      state,
      result({ [MODEL]: modelUsage(200, 500, 1600, 200, 300) }),
    );
    expect(snapshot?.models[0]).toEqual({
      model: MODEL,
      inputTokens: 2000,
      cachedInputTokens: 1600,
      cacheWriteInputTokens: 200,
      outputTokens: 500,
      reasoningOutputTokens: 300,
    });
    expect(snapshot?.completeness).toBe("complete");
  });

  it("settles full per-model query totals including children and sidechains once across streaming turns", () => {
    const state = makeClaudeUsageAccounting(SCOPE);
    observeClaudeAssistantUsage(state, assistant("a", 100));
    expect(
      observeClaudeAssistantUsage(state, assistant("child", 300, { parent: "tool-agent" })),
    ).toBeUndefined();
    const first = result({ [MODEL]: modelUsage(100, 20), "claude-haiku-4-5": modelUsage(300, 50) });
    expect(observeClaudeResultUsage(state, first)?.models).toHaveLength(2);
    expect(observeClaudeResultUsage(state, first)).toBeUndefined();
    expect(observeClaudeAssistantUsage(state, assistant("a", 100))).toBeUndefined();
    expect(
      observeClaudeAssistantUsage(state, assistant("b", 150))?.models.find(
        (row) => row.model === MODEL,
      )?.inputTokens,
    ).toBe(250);
    const final = observeClaudeResultUsage(
      state,
      result({ [MODEL]: modelUsage(250, 70), "claude-haiku-4-5": modelUsage(600, 100) }),
    );
    expect(final?.models).toEqual([
      {
        model: "claude-haiku-4-5",
        inputTokens: 600,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 100,
        reasoningOutputTokens: 0,
      },
      {
        model: MODEL,
        inputTokens: 250,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        outputTokens: 70,
        reasoningOutputTokens: 0,
      },
    ]);
  });

  it("retains prior settlement and input-only crash fallback when the final result is zeroed", () => {
    const state = makeClaudeUsageAccounting(SCOPE);
    observeClaudeResultUsage(state, result({ [MODEL]: modelUsage(100, 30) }));
    const fallback = observeClaudeAssistantUsage(state, assistant("after-settlement", 120));
    expect(observeClaudeResultUsage(state, result({}))).toBeUndefined();
    expect(observeClaudeResultUsage(state, result({ [MODEL]: modelUsage(0, 0) }))).toBeUndefined();
    expect(fallback?.models[0]).toMatchObject({ inputTokens: 220, outputTokens: 30 });
    expect(fallback?.completeness).toBe("input-only");
  });

  it("does not treat a lower delayed result as reset or add the same pending request twice", () => {
    const state = makeClaudeUsageAccounting(SCOPE);
    observeClaudeResultUsage(state, result({ [MODEL]: modelUsage(100, 30) }));
    observeClaudeAssistantUsage(state, assistant("b", 120));
    expect(
      observeClaudeResultUsage(state, result({ [MODEL]: modelUsage(110, 31) })),
    ).toBeUndefined();
    const final = observeClaudeResultUsage(state, result({ [MODEL]: modelUsage(220, 50) }));
    expect(final?.models[0]).toMatchObject({ inputTokens: 220, outputTokens: 50 });
  });

  it("fresh query/reset scopes count their own totals even when the new value is larger", () => {
    const old = makeClaudeUsageAccounting(SCOPE);
    const fresh = makeClaudeUsageAccounting("20000000-0000-4000-8000-000000000000");
    expect(
      observeClaudeResultUsage(old, result({ [MODEL]: modelUsage(100, 30) }))?.models[0]
        ?.inputTokens,
    ).toBe(100);
    expect(
      observeClaudeResultUsage(fresh, result({ [MODEL]: modelUsage(150, 40) }))?.models[0]
        ?.inputTokens,
    ).toBe(150);
  });

  it("matches canonical model metadata and combines alias rows without losing child/output settlement", () => {
    const state = makeClaudeUsageAccounting(SCOPE);
    observeClaudeAssistantUsage(state, assistant("a", 100));
    const snapshot = observeClaudeResultUsage(state, {
      type: "result",
      modelUsage: {
        "gateway-alias": { ...modelUsage(100, 30), canonicalModel: MODEL },
        "another-alias": { ...modelUsage(200, 40), canonicalModel: MODEL },
        "cloud:provider:private-account:inference-profile": {
          ...modelUsage(300, 50),
          canonicalModel: "claude-haiku-4-5",
        },
      },
    });
    expect(snapshot?.models).toHaveLength(2);
    expect(snapshot?.models.find((row) => row.model === MODEL)).toMatchObject({
      inputTokens: 300,
      outputTokens: 70,
    });
    expect(JSON.stringify(snapshot)).not.toContain("private-account");
  });

  it("does not emit a retroactive fresh/cache or output/thinking redistribution as new billed tokens", () => {
    const state = makeClaudeUsageAccounting(SCOPE);
    observeClaudeResultUsage(state, result({ [MODEL]: modelUsage(100, 50) }));
    expect(
      observeClaudeResultUsage(state, result({ [MODEL]: modelUsage(20, 50, 80) })),
    ).toBeUndefined();
    expect(
      observeClaudeResultUsage(state, result({ [MODEL]: modelUsage(100, 50, 0, 0, 40) })),
    ).toBeUndefined();
  });

  it("rejects malformed counts/models and never infers output from assistant placeholders", () => {
    const state = makeClaudeUsageAccounting(SCOPE);
    for (const invalid of [-1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(observeClaudeAssistantUsage(state, assistant("bad", invalid))).toBeUndefined();
      expect(
        observeClaudeResultUsage(state, result({ [MODEL]: modelUsage(invalid, 5) })),
      ).toBeUndefined();
    }
    expect(
      observeClaudeResultUsage(state, result({ [MODEL]: modelUsage(10, 1, 0, 0, 2) })),
    ).toBeUndefined();
    expect(
      observeClaudeAssistantUsage(state, assistant("bad-model", 1, { model: "x".repeat(257) })),
    ).toBeUndefined();
    expect(
      observeClaudeAssistantUsage(state, assistant("okay", 100))?.models[0]?.outputTokens,
    ).toBe(0);
  });

  it("bounds model cardinality and falls back to results without evicting request dedup identities", () => {
    const state = makeClaudeUsageAccounting(SCOPE);
    for (let index = 0; index < 16384; index += 1)
      observeClaudeAssistantUsage(state, assistant(`request-${index}`, 1));
    expect(observeClaudeAssistantUsage(state, assistant("overflow", 1))).toBeUndefined();
    expect(observeClaudeAssistantUsage(state, assistant("request-0", 1))).toBeUndefined();
    const complete = observeClaudeResultUsage(state, result({ [MODEL]: modelUsage(16385, 5) }));
    expect(complete?.models[0]?.inputTokens).toBe(16385);
    const oversized = Object.fromEntries(
      Array.from({ length: 65 }, (_, index) => [`model-${index}`, modelUsage(1, 1)]),
    );
    expect(
      observeClaudeResultUsage(makeClaudeUsageAccounting(SCOPE), result(oversized)),
    ).toBeUndefined();
  });
});
