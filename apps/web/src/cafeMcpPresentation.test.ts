import { describe, expect, it } from "vitest";
import { cafeMcpHistoryTitle, readCafeMcpInvocation } from "./cafeMcpPresentation";

describe("Cafe MCP history presentation", () => {
  it.each([
    { item: { server: "cafe-code-0123456789abcdef", tool: "list_threads" } },
    { toolName: "mcp__cafe-code-0123456789abcdef__list_threads" },
    { toolName: "mcp__cafe_code_0123456789abcdef__list_threads" },
    { tool: "cafe-code-0123456789abcdef_list_threads" },
    { rawInput: { variant: "mcp", tool_name: "cafe-code__list_threads" } },
  ])(
    "recognizes retained provider invocation metadata: $item $toolName $tool $rawInput",
    (data) => {
      expect(readCafeMcpInvocation({ itemType: "dynamic_tool_call", data })).toEqual({
        tool: "list_threads",
        failed: false,
      });
    },
  );

  it("keeps foreign/unknown tools and received title or argument prose out of Cafe action labels", () => {
    expect(
      readCafeMcpInvocation({
        itemType: "mcp_tool_call",
        data: { item: { server: "foreign", tool: "list_threads" } },
      })?.tool,
    ).toBeNull();
    expect(
      readCafeMcpInvocation({
        itemType: "mcp_tool_call",
        data: { toolName: "mcp__cafe-code-evil__list_threads" },
      })?.tool,
    ).toBeNull();
    expect(
      readCafeMcpInvocation({
        itemType: "mcp_tool_call",
        title: "cafe-code__list_threads",
        data: { input: { toolName: "cafe-code__list_threads" } },
      }),
    ).toBeUndefined();
    expect(
      readCafeMcpInvocation({
        itemType: "mcp_tool_call",
        data: { item: { server: "cafe-code", tool: "future_unknown_action" } },
      })?.tool,
    ).toBeNull();
    expect(
      readCafeMcpInvocation({
        itemType: "command_execution",
        data: { toolName: "cafe-code__list_threads" },
      }),
    ).toBeUndefined();
  });

  it("uses lifecycle wording and preserves asynchronous mutation semantics", () => {
    expect(cafeMcpHistoryTitle({ tool: "list_threads", state: "running" })).toBe(
      "Viewing Cafe Code threads",
    );
    expect(cafeMcpHistoryTitle({ tool: "list_threads", state: "completed" })).toBe(
      "Viewed Cafe Code threads",
    );
    expect(cafeMcpHistoryTitle({ tool: "list_threads", state: "failed" })).toBe(
      "Could not view Cafe Code threads",
    );
    expect(cafeMcpHistoryTitle({ tool: "restart_provider", state: "completed" })).toBe(
      "Requested Cafe Code provider restart",
    );
    expect(cafeMcpHistoryTitle({ tool: "answer_thread_question", state: "completed" })).toBe(
      "Submitted Cafe Code answer",
    );
  });

  it("recognizes structured MCP refusal without interpreting result prose", () => {
    const item = { server: "cafe-code", tool: "create_thread" };
    expect(
      readCafeMcpInvocation({
        itemType: "mcp_tool_call",
        data: { item: { ...item, result: { isError: true } } },
      })?.failed,
    ).toBe(true);
    expect(
      readCafeMcpInvocation({
        itemType: "mcp_tool_call",
        data: { item: { ...item, result: { content: [{ type: "text", text: "failed" }] } } },
      })?.failed,
    ).toBe(false);
  });

  it("does not execute accessor metadata", () => {
    const payload = {
      itemType: "mcp_tool_call",
      get data(): never {
        throw new Error("must not read getters");
      },
    };
    expect(readCafeMcpInvocation(payload)).toBeUndefined();
  });
});
