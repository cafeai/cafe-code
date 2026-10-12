import { describe, expect, it } from "vitest";
import { ArchivedToolPayloadRedactor, isArchivedPrivateToolServer } from "./archivedToolPrivacy.ts";

describe("archived private tool names", () => {
  it("recognizes only retired Cafe names", () => {
    expect(isArchivedPrivateToolServer("cafe-desktop")).toBe(true);
    expect(isArchivedPrivateToolServer("cafe-native-AAAAAAAAAAAAAAAAAAAAAA")).toBe(true);
    expect(isArchivedPrivateToolServer("cafe-native-cafe-code")).toBe(false);
    expect(isArchivedPrivateToolServer("cafe-scheduling")).toBe(false);
  });
});

describe("archived Claude private tool payloads", () => {
  const name = "mcp__cafe-native-AAAAAAAAAAAAAAAAAAAAAA__type_text";
  it("redacts archived tool inputs and correlates results while preserving other tools", () => {
    const privacy = new ArchivedToolPayloadRedactor();
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
    ).toBe("[Archived private tool result]");
    expect(
      privacy.redact({ type: "tool_result", tool_use_id: "other", content: "ordinary result" })
        .content,
    ).toBe("ordinary result");
  });
  it("redacts streamed argument deltas without hiding reused ordinary block indexes", () => {
    const privacy = new ArchivedToolPayloadRedactor();
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
