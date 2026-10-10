import { describe, expect, it } from "vitest";

import { sanitizeClaudeThinkingDiagnostics } from "./claudeThinkingDiagnostics.ts";

const publicSummary = "I found the relevant files; I will inspect the tests next.";
const opaqueSignature = "opaque-encrypted-signature-never-log";
const redactedData = "opaque-redacted-reasoning-never-log";
const childSummary = "nested-summary-not-owned-by-primary";

const assistant = (parent: unknown = null) => ({
  type: "assistant",
  parent_tool_use_id: parent,
  session_id: "session-owned-elsewhere",
  uuid: "message-owned-elsewhere",
  message: {
    id: "response-owned-elsewhere",
    role: "assistant",
    stop_reason: "tool_use",
    usage: { output_tokens: 123 },
    content: [
      { type: "thinking", thinking: publicSummary, signature: opaqueSignature },
      { type: "redacted_thinking", data: redactedData },
      { type: "text", text: "I will start with the adapter." },
      {
        type: "tool_use",
        id: "tool-owned-elsewhere",
        name: "fixture-tool",
        input: { command: "fixture inert command", signature: "ordinary-tool-input" },
      },
    ] as Record<string, unknown>[],
  },
});

function stream(delta: unknown, parent: unknown = null) {
  return {
    type: "stream_event",
    parent_tool_use_id: parent,
    uuid: "stream-owned-elsewhere",
    event: { type: "content_block_delta", index: 3, delta },
  };
}

describe("Claude thinking operational diagnostics", () => {
  it("preserves disclosed primary summaries and ordinary prose/tool metadata, never opaque payloads", () => {
    const input = assistant();
    Object.freeze(input.message.content[0]);
    Object.freeze(input.message.content[1]);
    Object.freeze(input.message.content);
    Object.freeze(input.message);
    Object.freeze(input);
    const projected = sanitizeClaudeThinkingDiagnostics(input);
    expect(projected).toEqual({
      ...input,
      message: {
        ...input.message,
        content: [
          { type: "thinking", thinking: publicSummary },
          { type: "redacted_thinking" },
          input.message.content[2],
          input.message.content[3],
        ],
      },
    });
    expect(projected).not.toBe(input);
    expect((projected as typeof input).message).not.toBe(input.message);
    expect((projected as typeof input).message.content).not.toBe(input.message.content);
    expect((projected as typeof input).message.content[2]).not.toBe(input.message.content[2]);
    expect(JSON.stringify(projected)).not.toContain(opaqueSignature);
    expect(JSON.stringify(projected)).not.toContain(redactedData);
    expect(JSON.stringify(projected)).toContain("ordinary-tool-input");
    // Conversation blocks remain intact for the provider's signature roundtrip.
    expect(input.message.content[0]).toHaveProperty("signature", opaqueSignature);
    expect(input.message.content[1]).toHaveProperty("data", redactedData);
  });

  it.each([null, undefined])("admits the exact primary marker %s", (parent) => {
    const input = assistant();
    input.parent_tool_use_id = parent;
    expect(sanitizeClaudeThinkingDiagnostics(input)).toHaveProperty(
      "message.content.0.thinking",
      publicSummary,
    );
    const delta = stream({ type: "thinking_delta", thinking: publicSummary });
    delta.parent_tool_use_id = parent;
    expect(sanitizeClaudeThinkingDiagnostics(delta)).toHaveProperty(
      "event.delta.thinking",
      publicSummary,
    );
  });

  it("admits an absent optional parent marker", () => {
    const { parent_tool_use_id: _parent, ...input } = assistant();
    expect(sanitizeClaudeThinkingDiagnostics(input)).toHaveProperty(
      "message.content.0.thinking",
      publicSummary,
    );
  });

  it.each(["child-tool", "", " ", false, 0, {}, []])(
    "suppresses nested and malformed parent summaries for %j without losing ordinary prose",
    (parent) => {
      const input = assistant(parent);
      input.message.content[0] = {
        type: "thinking",
        thinking: childSummary,
        signature: opaqueSignature,
      };
      const projected = sanitizeClaudeThinkingDiagnostics(input);
      expect(projected).toHaveProperty("message.content.0.thinking", "");
      expect(projected).toHaveProperty("message.content.2.text", "I will start with the adapter.");
      expect(JSON.stringify(projected)).not.toContain(childSummary);
      expect(
        sanitizeClaudeThinkingDiagnostics(
          stream({ type: "thinking_delta", thinking: childSummary }, parent),
        ),
      ).toHaveProperty("event.delta.thinking", "");
    },
  );

  it("fails closed for inherited/accessor parent markers without evaluating accessors", () => {
    let getterReads = 0;
    const { parent_tool_use_id: _parent, ...input } = assistant();
    const inherited = Object.assign(Object.create({ parent_tool_use_id: null }), input);
    const accessor = Object.defineProperty({ ...input }, "parent_tool_use_id", {
      enumerable: true,
      get() {
        getterReads++;
        return null;
      },
    });
    for (const value of [inherited, accessor]) {
      const projected = sanitizeClaudeThinkingDiagnostics(value);
      expect(projected).toHaveProperty("message.content.0.thinking", "");
      expect(JSON.stringify(projected)).not.toContain(publicSummary);
    }
    expect(getterReads).toBe(0);
  });

  it("strips start/delta opaque payloads and leaves text/tool JSON deltas intact", () => {
    const deltas = [
      { type: "signature_delta", signature: opaqueSignature, future: redactedData },
      {
        type: "thinking_delta",
        thinking: publicSummary,
        signature: opaqueSignature,
        future: redactedData,
      },
      { type: "text_delta", text: "public text", signature: opaqueSignature },
      { type: "input_json_delta", partial_json: '{"signature":"ordinary-tool-input"}' },
    ];
    const expected = [
      { type: "signature_delta" },
      { type: "thinking_delta", thinking: publicSummary },
      { type: "text_delta", text: "public text" },
      deltas[3],
    ];
    for (let index = 0; index < deltas.length; index++) {
      const input = stream(deltas[index]);
      expect(sanitizeClaudeThinkingDiagnostics(input)).toEqual({
        ...input,
        event: { ...input.event, delta: expected[index] },
      });
      expect(input.event.delta).toBe(deltas[index]);
    }
    const input = {
      type: "stream_event",
      parent_tool_use_id: null,
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "redacted_thinking", data: redactedData },
      },
    };
    expect(sanitizeClaudeThinkingDiagnostics(input)).toEqual({
      ...input,
      event: { ...input.event, content_block: { type: "redacted_thinking" } },
    });
  });

  it("does not traverse arbitrary nested tool objects or unrelated native envelopes", () => {
    const input = assistant();
    const toolInput = {
      signature: "ordinary-tool-input",
      nested: { type: "thinking", thinking: "tool-owned-data" },
    };
    input.message.content[3] = {
      type: "tool_use",
      id: "tool-owned-elsewhere",
      name: "fixture-tool",
      input: toolInput,
    };
    const projected = sanitizeClaudeThinkingDiagnostics(input) as typeof input;
    expect(projected.message.content[3]).toHaveProperty("input", toolInput);
    expect((projected.message.content[3] as { input: unknown }).input).toBe(toolInput);
    const unrelated = { type: "system", nested: { signature: "not-a-thinking-envelope" } };
    expect(sanitizeClaudeThinkingDiagnostics(unrelated)).toBe(unrelated);
    for (const value of [null, undefined, 0, "inert native string", ["not-an-envelope"]])
      expect(sanitizeClaudeThinkingDiagnostics(value)).toBe(value);
  });

  it("preserves ordinary message_delta stop reasons, usage and content-start text", () => {
    const delta = {
      type: "stream_event",
      parent_tool_use_id: null,
      event: {
        type: "message_delta",
        delta: { stop_reason: "max_tokens", stop_sequence: null },
        usage: { output_tokens: 64_000 },
      },
    };
    expect(sanitizeClaudeThinkingDiagnostics(delta)).toEqual(delta);
    const start = {
      type: "stream_event",
      parent_tool_use_id: null,
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "public text" },
      },
    };
    expect(sanitizeClaudeThinkingDiagnostics(start)).toEqual(start);
  });

  it("does not evaluate known-path getters, array methods, inherited entries or serializer hooks", () => {
    let getterReads = 0;
    const failGetter = () => {
      getterReads++;
      throw new Error("fixture getter must not run");
    };
    const input = assistant();
    Object.defineProperty(input.message.content[0], "signature", { get: failGetter });
    Object.defineProperty(input.message.content[0], "future", {
      enumerable: true,
      get: failGetter,
    });
    Object.defineProperty(input.message.content[0], "toJSON", {
      value: failGetter,
      enumerable: true,
    });
    Object.defineProperty(input.message.content, "1", { get: failGetter });
    Object.defineProperty(input.message.content, "map", { get: failGetter });
    Object.defineProperty(input.message.content, "constructor", { get: failGetter });
    input.message.content.length = 5;
    Object.setPrototypeOf(
      input.message.content,
      Object.assign(Object.create(Array.prototype), {
        4: { type: "thinking", thinking: childSummary, signature: opaqueSignature },
      }),
    );
    const projected = sanitizeClaudeThinkingDiagnostics(input);
    expect(projected).toHaveProperty("message.content.0.thinking", publicSummary);
    expect(projected).toHaveProperty("message.content.1", "[omitted:malformed-content-block]");
    expect(projected).toHaveProperty("message.content.4", "[omitted:malformed-content-block]");
    expect(JSON.stringify(projected)).not.toContain(opaqueSignature);
    expect(JSON.stringify(projected)).not.toContain(childSummary);
    const malformedMessage = Object.defineProperty({ type: "assistant" }, "message", {
      enumerable: true,
      get: failGetter,
    });
    expect(sanitizeClaudeThinkingDiagnostics(malformedMessage)).toEqual({
      type: "assistant",
      message: { content: [] },
    });
    const malformedEvent = Object.defineProperty({ type: "stream_event" }, "event", {
      enumerable: true,
      get: failGetter,
    });
    expect(sanitizeClaudeThinkingDiagnostics(malformedEvent)).toEqual({
      type: "stream_event",
      event: {},
    });
    expect(getterReads).toBe(0);
  });

  it("bounds content inspection and never retains an uninspected opaque tail or forged omission count", () => {
    const input = assistant();
    const blocks = Array.from({ length: 257 }, () => ({ type: "text", text: "public block" }));
    Object.defineProperty(blocks, "256", {
      get() {
        throw new Error("uninspected tail must never be read");
      },
    });
    const oversized = {
      ...input,
      message: {
        ...input.message,
        content: blocks,
        cafecode_content_blocks_omitted: opaqueSignature,
      },
    };
    const projected = sanitizeClaudeThinkingDiagnostics(oversized) as typeof oversized;
    expect(projected.message.content).toHaveLength(256);
    expect(projected.message.cafecode_content_blocks_omitted).toBe(1);
    expect(JSON.stringify(projected)).not.toContain(opaqueSignature);
    const ordinary = {
      ...input,
      message: { ...input.message, cafecode_content_blocks_omitted: 99 },
    };
    expect(sanitizeClaudeThinkingDiagnostics(ordinary)).not.toHaveProperty(
      "message.cafecode_content_blocks_omitted",
    );
    expect(blocks).toHaveLength(257);
  });

  it("keeps own prototype-shaped keys inert and returns fixed diagnostics on exceptional inspection", () => {
    const input = assistant();
    Object.defineProperty(input, "__proto__", {
      value: { signature: "inert unrelated envelope data" },
      enumerable: true,
    });
    const projected = sanitizeClaudeThinkingDiagnostics(input) as Record<string, unknown>;
    expect(Object.getPrototypeOf(projected)).toBeNull();
    expect(Object.hasOwn(projected, "__proto__")).toBe(true);
    const exceptional = new Proxy(input, {
      getOwnPropertyDescriptor() {
        throw new Error(opaqueSignature);
      },
    });
    const omitted = sanitizeClaudeThinkingDiagnostics(exceptional);
    expect(omitted).toEqual({
      type: "cafecode_diagnostic_omitted",
      reason: "malformed-sdk-envelope",
    });
    expect(JSON.stringify(omitted)).not.toContain(opaqueSignature);
  });

  it("rejects accessor or inherited SDK discriminators without evaluating them", () => {
    let getterReads = 0;
    const input = assistant();
    Object.defineProperty(input, "type", {
      enumerable: true,
      get() {
        getterReads++;
        return "assistant";
      },
    });
    const { type: _type, ...inheritedInput } = assistant();
    Object.setPrototypeOf(inheritedInput, { type: "assistant" });
    for (const value of [input, inheritedInput]) {
      expect(sanitizeClaudeThinkingDiagnostics(value)).toEqual({
        type: "cafecode_diagnostic_omitted",
        reason: "malformed-sdk-envelope",
      });
    }
    expect(getterReads).toBe(0);
  });
});
