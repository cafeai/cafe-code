import { describe, expect, it } from "vitest";
import { normalizeNativeComputerSchema } from "./nativeComputerSchema.ts";
import {
  NATIVE_CONTROL_DEFAULT_TOOLS,
  nativeControlValidationError,
  validateNativeToolCall,
} from "./nativeControl.ts";

describe("published computer contracts", () => {
  it("folds bounds without weakening intersections or definitions", () => {
    expect(
      normalizeNativeComputerSchema({
        type: "array",
        minItems: 2,
        allOf: [{ minItems: 1 }, { maxItems: 16 }, { contains: { type: "string" } }],
        $defs: { id: { type: "string", allOf: [{ minLength: 1 }] } },
      }),
    ).toEqual({
      type: "array",
      minItems: 2,
      maxItems: 16,
      allOf: [{ contains: { type: "string" } }],
      $defs: { id: { type: "string", minLength: 1 } },
    });
  });
  it("publishes typed action variants with directly readable bounds", () => {
    const schema = NATIVE_CONTROL_DEFAULT_TOOLS.find((t) => t.name === "computer_act")!
      .inputSchema as Record<string, any>;
    const actions = schema.properties.actions;
    expect(actions.type).toBe("array");
    expect(actions.minItems).toBe(1);
    expect(actions.maxItems).toBe(16);
    expect(actions.allOf).toBeUndefined();
    expect(
      actions.items.anyOf.map((a: any) => a.properties.type.const ?? a.properties.type.enum[0]),
    ).toEqual(expect.arrayContaining(["click", "type", "key", "drag", "set_value"]));
    expect(() =>
      validateNativeToolCall("computer_act", {
        target: "t",
        input_policy: "background-only",
        actions: [{ type: "click", input_route: "pointer", point: { x: 1, y: 2 } }],
      }),
    ).not.toThrow();
  });
  it("returns only curated validation paths and never values or arbitrary keys", () => {
    const result = nativeControlValidationError(
      new Error('secret typed text at ["actions"][0]["x"]'),
    );
    expect(result.structuredContent).toMatchObject({
      code: "invalid_arguments",
      path: '["actions"][0]["x"]',
    });
    expect(JSON.stringify(result)).not.toContain("secret typed text");
    expect(
      nativeControlValidationError(new Error('at ["password"]')).structuredContent,
    ).not.toHaveProperty("path");
  });
});
