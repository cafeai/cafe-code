import { describe, expect, it } from "vitest";
import {
  NativeDesktopPrivacy,
  NATIVE_CONTROL_TOOLS,
  isNativeControlServer,
  validateNativeToolCall,
  compactNativeToolResult,
  nativeToolArguments,
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
  it("advertises full native Mac targeting and browser refs without session substitution", () => {
    const click = NATIVE_CONTROL_TOOLS.find((tool) => tool.name === "click")!;
    expect(click.inputSchema.properties).toHaveProperty("pid");
    expect(click.inputSchema.properties).toHaveProperty("window_id");
    expect(click.inputSchema.properties).toHaveProperty("element_token");
    expect(click.inputSchema.properties).toHaveProperty("delivery_mode");
    expect(NATIVE_CONTROL_TOOLS.some((tool) => tool.name === "launch_app")).toBe(true);
    expect(NATIVE_CONTROL_TOOLS.some((tool) => tool.name === "get_browser_state")).toBe(true);
    expect(NATIVE_CONTROL_TOOLS.some((tool) => tool.name === "open_url")).toBe(true);
    expect(() => validateNativeToolCall("click", { _session_id: "foreign" })).toThrow();
    expect(() => validateNativeToolCall("move_cursor", { cursor_id: "foreign" })).toThrow();
  });
  it("keeps explicit visual grounding and caller limits over compact defaults", () => {
    expect(
      nativeToolArguments("get_window_state", {
        pid: 1,
        window_id: 2,
        include_screenshot: true,
        max_elements: 800,
        max_image_dimension: 0,
      }),
    ).toMatchObject({ include_screenshot: true, max_elements: 800, max_image_dimension: 0 });
    expect(nativeToolArguments("get_browser_state", {})).toEqual({
      snapshot_format: "semantic_v2",
      include_screenshot: false,
    });
    expect(nativeToolArguments("get_window_state", { query: "Account" })).toMatchObject({
      max_elements: 4000,
      max_depth: 25,
      timeout_ms: 3000,
      include_screenshot: false,
    });
  });
  it("advertises Cafe defaults and convenience options rather than upstream defaults", () => {
    const window = NATIVE_CONTROL_TOOLS.find((tool) => tool.name === "get_window_state")!;
    expect(window.inputSchema.properties).toHaveProperty("max_results");
    expect(window.inputSchema).toMatchObject({
      required: ["pid"],
      properties: { include_screenshot: { default: false } },
    });
    const browser = NATIVE_CONTROL_TOOLS.find((tool) => tool.name === "get_browser_state")!;
    expect(browser.inputSchema.properties).toMatchObject({
      snapshot_format: { default: "semantic_v2" },
    });
    expect(browser.inputSchema.properties).toHaveProperty("include_page_state");
    const key = NATIVE_CONTROL_TOOLS.find((tool) => tool.name === "press_key")!;
    expect(key.inputSchema.properties).toHaveProperty("auto_foreground");
    expect(key.inputSchema.properties).toHaveProperty("observe_after");
  });
  it("exposes tokens once, preserves images and passes through native errors unchanged", () => {
    const image = { type: "image", data: "fixture", mimeType: "image/png" };
    const result = compactNativeToolResult({
      content: [{ type: "text", text: "duplicate tree" }, image],
      structuredContent: {
        elements: [{ element_token: "s12345678:1", label: "Search" }],
        tree_markdown: "duplicate tree",
        truncated: true,
        capture_id: "capture",
      },
    });
    expect(result.structuredContent).toBeUndefined();
    expect(result.content[1]).toEqual(image);
    expect(JSON.parse(result.content[0]!.text as string)).toEqual({
      elements: [{ element_token: "s12345678:1", label: "Search" }],
      truncated: true,
      capture_id: "capture",
    });
    const error = {
      isError: true,
      content: [{ type: "text", text: "explicit refusal" }],
      structuredContent: { code: "refused" },
    };
    expect(compactNativeToolResult(error)).toBe(error);
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
