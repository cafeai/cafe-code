import { describe, expect, it } from "vitest";
import { readWebMcpInvocation, webMcpHistoryTitle } from "./webMcpPresentation";

function payload(args?: unknown) {
  return {
    itemType: "mcp_tool_call",
    data: { item: { server: "codex_apps", tool: "search_service.web_run", arguments: args } },
  };
}

describe("search-service MCP history presentation", () => {
  it("summarizes batched queries from the native invocation without exposing its transport fields", () => {
    expect(
      readWebMcpInvocation(
        payload({
          system2_search_query: [
            { q: '"timelock" "anonymity" encryption round' },
            { q: "Path ORAM" },
          ],
          response_length: "long",
        }),
      ),
    ).toEqual({
      action: "search",
      preview: '"timelock" "anonymity" encryption round · Path ORAM',
      failed: false,
    });
  });

  it.each([
    {
      item: {
        namespace: "codex_apps.search_service",
        tool: "web_run",
        arguments: { search_query: [{ q: "ORAM" }] },
      },
    },
    {
      toolName: "mcp__codex_apps__search_service.web_run",
      input: { system2_search_query: [{ q: "ORAM" }] },
    },
    {
      toolName: "mcp__codex_apps__search_service_web_run",
      input: { system2_search_query: [{ q: "ORAM" }] },
    },
    { tool: "codex_apps.search_service.web_run", input: { system2_search_query: [{ q: "ORAM" }] } },
    {
      rawInput: {
        tool_name: "mcp__codex_apps__search_service_web_run",
        tool_input: { system2_search_query: [{ q: "ORAM" }] },
      },
    },
  ])("reads structured and encoded provider invocations", (data) => {
    expect(readWebMcpInvocation({ itemType: "dynamic_tool_call", data })).toEqual({
      action: "search",
      preview: "ORAM",
      failed: false,
    });
  });

  it.each([
    [
      { open: [{ ref_id: "https://example.com/paper.pdf" }, { ref_id: "turn0search0" }] },
      "Opened web pages",
      "https://example.com/paper.pdf",
    ],
    [{ find: [{ ref_id: "turn0view0", pattern: "4.4" }] }, "Searched within web pages", "4.4"],
    [{ image_query: [{ q: "waterfalls" }] }, "Searched for images", "waterfalls"],
    [{ click: [{ ref_id: "turn0view0", id: 17 }] }, "Followed web links", undefined],
    [{ screenshot: [{ ref_id: "turn0view0", pageno: 0 }] }, "Took page screenshots", undefined],
    [{ time: [{ utc_offset: "+03:00" }] }, "Checked the time", "+03:00"],
  ] as const)("describes the requested web operation: %j", (args, title, preview) => {
    const invocation = readWebMcpInvocation(payload(args))!;
    expect(invocation.preview).toBe(preview);
    expect(webMcpHistoryTitle({ action: invocation.action!, state: "completed" })).toBe(title);
  });

  it("uses a general web label for mixed, unknown or unavailable commands", () => {
    for (const args of [
      { system2_search_query: [{ q: "ORAM" }], open: [{ ref_id: "turn0search0" }] },
      { future_command: [{ value: "unknown" }] },
      { system2_search_query: [] },
      "{incomplete",
      " ".repeat(65_537),
    ]) {
      expect(readWebMcpInvocation(payload(args))).toEqual({ action: "browse", failed: false });
    }
    expect(readWebMcpInvocation(payload())).toEqual({ failed: false });
  });

  it("bounds and sanitizes previews, including encoded JSON arguments", () => {
    const invocation = readWebMcpInvocation(
      payload(
        JSON.stringify({
          system2_search_query: [
            { q: "sk-private-example-value-1234567890" },
            { q: "\u202e\n" + "x".repeat(5_000) },
            { q: "third query" },
            { q: "fourth query" },
          ],
        }),
      ),
    )!;
    expect(invocation.action).toBe("search");
    expect(invocation.preview!.length).toBeLessThanOrEqual(400);
    expect(invocation.preview).toContain("[redacted]");
    expect(invocation.preview).not.toMatch(/private|fourth|[\p{Cc}\p{Bidi_Control}]/u);
  });

  it("requires exact invocation metadata and does not infer an invocation from received prose", () => {
    expect(
      readWebMcpInvocation({
        itemType: "mcp_tool_call",
        title: "codex_apps.search_service.web_run",
        detail: "system2_search_query: ORAM",
      }),
    ).toBeUndefined();
    for (const item of [
      { server: "foreign", tool: "search_service.web_run" },
      { server: "codex_apps", tool: "other.web_run" },
      { server: "codex_apps_evil", tool: "search_service.web_run" },
    ]) {
      expect(
        readWebMcpInvocation({
          itemType: "mcp_tool_call",
          data: { item, toolName: "mcp__codex_apps__search_service_web_run" },
        }),
      ).toBeNull();
    }
    expect(readWebMcpInvocation({ ...payload({}), itemType: "command_execution" })).toBeUndefined();
  });

  it("does not execute accessors or treat result prose as an error receipt", () => {
    const args = {
      system2_search_query: [
        {
          get q(): never {
            throw new Error("must not read getter");
          },
        },
      ],
    };
    expect(readWebMcpInvocation(payload(args))).toEqual({ action: "search", failed: false });
    const base = payload(args);
    for (const [result, failed] of [
      [{ isError: true }, true],
      [{ content: [{ text: "failed" }] }, false],
    ] as const) {
      expect(
        readWebMcpInvocation({ ...base, data: { item: { ...base.data.item, result } } })?.failed,
      ).toBe(failed);
    }
    expect(readWebMcpInvocation({ ...base, status: "declined" })?.failed).toBe(true);
    expect(webMcpHistoryTitle({ action: "search", state: "running" })).toBe("Searching the web");
    expect(webMcpHistoryTitle({ action: "search", state: "failed" })).toBe(
      "Could not search the web",
    );
  });
});
