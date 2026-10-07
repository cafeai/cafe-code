import { describe, expect, it } from "vitest";
import {
  NativeDesktopPrivacy,
  NATIVE_CONTROL_TOOLS,
  isNativeControlServer,
  validateNativeToolCall,
} from "./nativeControl.ts";

describe("local native catalog", () => {
  it("keeps transport authority and file outputs out of advertised schemas and calls", () => {
    const schemas = JSON.stringify(NATIVE_CONTROL_TOOLS);
    expect(schemas).not.toContain('"screenshot_out_file"');
    expect(schemas).not.toContain('"session"');
    expect(() => validateNativeToolCall("click", { target: { session: "foreign" } })).toThrow();
    expect(() => validateNativeToolCall("browser", {})).toThrow();
    expect(validateNativeToolCall("press_key", { key: "ENTER" })).toEqual({ key: "ENTER" });
  });
  it("recognizes only the bounded generated server name", () => {
    expect(isNativeControlServer("cafe-native-AAAAAAAAAAAAAAAAAAAAAA")).toBe(true);
    expect(isNativeControlServer("cafe-native-cafe-code")).toBe(false);
    expect(isNativeControlServer("cafe-scheduling")).toBe(false);
  });
});

describe("Claude native desktop privacy", () => {
  const name = "mcp__cafe-native-AAAAAAAAAAAAAAAAAAAAAA__type_text";
  it("redacts native tool inputs and correlates results while preserving other tools", () => {
    const privacy = new NativeDesktopPrivacy();
    const input = {
      type: "tool_use",
      id: "native",
      name,
      input: { text: "private typed content" },
    };
    expect(privacy.redact(input).input).toEqual({});
    expect(input.input.text).toBe("private typed content");
    expect(
      privacy.redact({ type: "tool_result", tool_use_id: "native", content: "private screenshot" })
        .content,
    ).toBe("[Native desktop result]");
    expect(
      privacy.redact({ type: "tool_result", tool_use_id: "other", content: "ordinary result" })
        .content,
    ).toBe("ordinary result");
  });
  it("redacts streamed argument deltas without hiding reused nonnative block indexes", () => {
    const privacy = new NativeDesktopPrivacy();
    privacy.redact({
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "native", name, input: {} },
    });
    expect(
      privacy.redact({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: "private" },
      }).delta.partial_json,
    ).toBe("");
    privacy.redact({
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "other", name: "Read", input: {} },
    });
    expect(
      privacy.redact({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: "ordinary" },
      }).delta.partial_json,
    ).toBe("ordinary");
  });
});
