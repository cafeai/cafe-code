import { describe, expect, it, vi } from "vitest";
import { validateMcpAppToolArguments as valid } from "./mcpAppToolSchema.ts";
describe("finite MCP App tool schema", () => {
  const schema = {
    type: "object",
    properties: {
      count: { type: "integer", minimum: 1, maximum: 10 },
      label: { type: "string", maxLength: 20 },
    },
    required: ["count"],
    additionalProperties: false,
  };
  it("refuses non-JSON hooks and nonfinite input without executing received code", () => {
    const hook = vi.fn(() => ({ count: 1 }));
    const getter = vi.fn(() => 1);
    expect(valid(schema, { toJSON: hook })).toBe(false);
    expect(valid({ toJSON: hook }, { count: 1 })).toBe(false);
    expect(
      valid(schema, Object.defineProperty({}, "count", { enumerable: true, get: getter })),
    ).toBe(false);
    expect(valid({ type: "null" }, NaN)).toBe(false);
    expect(hook).not.toHaveBeenCalled();
    expect(getter).not.toHaveBeenCalled();
  });
  it("refuses oversized received catalogues before whole-object serialization", () => {
    const oversized = { type: "object", description: "x".repeat(128 * 1024) };
    const stringify = vi.spyOn(JSON, "stringify");
    try {
      expect(valid(oversized, {})).toBe(false);
      // The streaming encoder escapes only these already bounded scalars; it
      // never serializes the received object or its excessive description.
      expect(stringify.mock.calls.map(([value]) => value)).toEqual([
        "type",
        "object",
        "description",
      ]);
    } finally {
      stringify.mockRestore();
    }
  });
  it("enforces required, type, numeric, string and excess-property constraints", () => {
    expect(valid(schema, { count: 3, label: "fixture" })).toBe(true);
    for (const input of [
      {},
      { count: 11 },
      { count: 1.1 },
      { count: "3" },
      { count: 2, extra: true },
      { count: 2, label: "x".repeat(21) },
    ])
      expect(valid(schema, input)).toBe(false);
  });
  it("refuses regex, remote refs, unsupported constraints and recursive work", () => {
    expect(valid({ type: "string", pattern: "(a+)+$" }, "aaa")).toBe(false);
    expect(valid({ $ref: "https://example.com/schema" }, {})).toBe(false);
    expect(valid({ $defs: { loop: { $ref: "#/$defs/loop" } }, $ref: "#/$defs/loop" }, {})).toBe(
      false,
    );
    expect(valid({ type: "object", unevaluatedProperties: false }, {})).toBe(false);
  });
  it("supports finite branches/local defs without inherited property lookup", () => {
    expect(valid({ $defs: { count: { type: "integer" } }, $ref: "#/$defs/count" }, 3)).toBe(true);
    expect(valid({ oneOf: [{ type: "string" }, { type: "integer" }] }, "label")).toBe(true);
    expect(valid({ oneOf: [{ type: "number" }, { type: "integer" }] }, 3)).toBe(false);
    expect(
      valid(
        { type: "object", properties: {}, additionalProperties: false },
        JSON.parse('{"constructor":1}'),
      ),
    ).toBe(false);
  });
  it("preflights unexercised branches, definitions, properties and malformed bounds", () => {
    for (const schema of [
      { anyOf: [{ type: "object" }, { pattern: "(a+)+$" }] },
      { type: ["object", "unknown"] },
      { type: ["object", "object"] },
      { type: "object", properties: { unused: { format: "uri" } } },
      { type: "object", $defs: { unused: { $ref: "https://example.com/private" } } },
      { type: "object", maxLength: -1 },
      { type: "object", required: ["x", "x"] },
    ])
      expect(valid(schema, { x: 1 })).toBe(false);
  });
});
