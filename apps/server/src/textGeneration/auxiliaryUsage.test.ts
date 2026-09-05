import { describe, expect, it } from "vitest";
import { makeCodexAuxiliaryUsageReader, readClaudeAuxiliaryUsage } from "./auxiliaryUsage.ts";

const scopeId = "11111111-1111-4111-8111-111111111111";
const claudeUsage = {
  inputTokens: 10,
  cacheReadInputTokens: 20,
  cacheCreationInputTokens: 30,
  outputTokens: 40,
  thinkingTokens: 5,
};
const codexUsage = {
  input_tokens: 60,
  cached_input_tokens: 20,
  cache_write_input_tokens: 10,
  output_tokens: 40,
  reasoning_output_tokens: 5,
};
const readCodex = (value: string) => {
  const reader = makeCodexAuxiliaryUsageReader(scopeId);
  reader.push(value);
  return reader.finish();
};

describe("auxiliary terminal usage", () => {
  it("prefers whole-tree Claude model totals without adding main-loop usage", () => {
    const result = readClaudeAuxiliaryUsage(
      JSON.stringify({
        type: "result",
        modelUsage: {
          "claude-sonnet-4-6": claudeUsage,
          "claude-haiku-4-5": { ...claudeUsage, inputTokens: 5 },
        },
        usage: { input_tokens: 999, output_tokens: 999 },
      }),
      scopeId,
    );
    expect(result?.completeness).toBe("complete");
    expect(result?.models).toHaveLength(2);
    expect(result?.models.find((row) => row.model === "claude-sonnet-4-6")).toEqual({
      model: "claude-sonnet-4-6",
      inputTokens: 60,
      cachedInputTokens: 20,
      cacheWriteInputTokens: 30,
      outputTokens: 40,
      reasoningOutputTokens: 5,
    });
  });

  it("retains explicit legacy Claude counts only when modelUsage is absent", () => {
    const usage = {
      input_tokens: 10,
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 30,
      output_tokens: 40,
    };
    const result = readClaudeAuxiliaryUsage(JSON.stringify({ type: "result", usage }), scopeId);
    expect(result).toMatchObject({
      completeness: "input-only",
      models: [{ model: "unknown", inputTokens: 60, outputTokens: 40 }],
    });
    for (const modelUsage of [
      null,
      {},
      { "claude-sonnet-4-6": { ...claudeUsage, outputTokens: -1 } },
    ]) {
      expect(
        readClaudeAuxiliaryUsage(JSON.stringify({ type: "result", modelUsage, usage }), scopeId),
      ).toBeUndefined();
    }
  });

  it.each([undefined, -1, 1.5, "10", Number.MAX_SAFE_INTEGER + 1])(
    "rejects malformed Claude token metadata %s",
    (inputTokens) => {
      expect(
        readClaudeAuxiliaryUsage(
          JSON.stringify({
            type: "result",
            modelUsage: { "claude-sonnet-4-6": { ...claudeUsage, inputTokens } },
          }),
          scopeId,
        ),
      ).toBeUndefined();
    },
  );

  it("does not mistake Claude structured output for provider usage", () => {
    expect(
      readClaudeAuxiliaryUsage(
        JSON.stringify({ structured_output: { modelUsage: { "claude-sonnet-4-6": claudeUsage } } }),
        scopeId,
      ),
    ).toBeUndefined();
    expect(readClaudeAuxiliaryUsage("not json", scopeId)).toBeUndefined();
  });

  it("takes the last Codex terminal total once, not item fields or repeated totals", () => {
    const terminal = JSON.stringify({ type: "turn.completed", usage: codexUsage });
    const result = readCodex(
      [
        JSON.stringify({ type: "item.completed", usage: { ...codexUsage, input_tokens: 999 } }),
        terminal,
        terminal,
        // A fresh one-shot invocation has no legitimate counter reset. A
        // zeroed/late result cannot erase already-observed terminal usage.
        JSON.stringify({
          type: "turn.completed",
          usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 },
        }),
      ].join("\n"),
    );
    expect(result).toEqual({
      scopeId,
      revision: 1,
      completeness: "complete",
      models: [
        {
          model: "unknown",
          inputTokens: 60,
          cachedInputTokens: 20,
          cacheWriteInputTokens: 10,
          outputTokens: 40,
          reasoningOutputTokens: 5,
        },
      ],
    });
  });

  it("parses chunk boundaries and recovers after oversized content without retaining it", () => {
    const reader = makeCodexAuxiliaryUsageReader(scopeId);
    reader.push('{"type":"item.completed","text":"' + "x".repeat(20_000));
    reader.push('"}\n{"type":"turn.com');
    reader.push('pleted","usage":' + JSON.stringify(codexUsage) + "}\r\n");
    expect(reader.finish()?.models[0]?.inputTokens).toBe(60);
  });

  it.each([
    { input_tokens: -1 },
    { input_tokens: 1.5 },
    { output_tokens: "40" },
    { cached_input_tokens: 100 },
    { cache_write_input_tokens: -1 },
    { reasoning_output_tokens: 41 },
    { output_tokens: Number.MAX_SAFE_INTEGER + 1 },
  ])("rejects malformed or inconsistent Codex counters %j", (override) => {
    expect(
      readCodex(JSON.stringify({ type: "turn.completed", usage: { ...codexUsage, ...override } })),
    ).toBeUndefined();
  });

  it("does not infer usage from failed Codex events or missing metadata", () => {
    expect(
      readCodex('{"type":"turn.failed","error":{"message":"failure"}}\nnot json'),
    ).toBeUndefined();
    expect(readCodex('{"type":"turn.completed"}')).toBeUndefined();
  });
});
