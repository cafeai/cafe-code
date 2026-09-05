import { describe, expect, it } from "vitest";

import { deriveToolActivityPresentation, summarizeToolArguments } from "./toolActivity.ts";

describe("toolActivity", () => {
  it("normalizes command tools to a stable ran-command label", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "command_execution",
        title: "Terminal",
        detail: "Terminal",
        data: {
          command: "yarn lint",
        },
        fallbackSummary: "Terminal",
      }),
    ).toEqual({
      summary: "Ran command",
      detail: "yarn lint",
    });
  });

  it("uses structured file paths for read-file tools when available", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "dynamic_tool_call",
        title: "Read File",
        detail: "Read File",
        data: {
          kind: "read",
          locations: [{ path: "/tmp/app.ts" }],
        },
        fallbackSummary: "Read File",
      }),
    ).toEqual({
      summary: "Read file",
      detail: "/tmp/app.ts",
    });
  });

  it("drops duplicated generic read-file detail when no path is available", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "dynamic_tool_call",
        title: "Read File",
        detail: "Read File",
        data: {
          kind: "read",
          rawInput: {},
        },
        fallbackSummary: "Read File",
      }),
    ).toEqual({
      summary: "Read file",
    });
  });

  it("uses completed Grok web-search output when the input omits the query", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "web_search",
        title: "Web search:",
        detail: "Web search:",
        data: {
          kind: "search",
          rawInput: { backend: true, variant: "web_search" },
          rawOutput: {
            action: {
              type: "search",
              query: "current ACP release",
              sources: [],
            },
          },
        },
        fallbackSummary: "Web search:",
      }),
    ).toEqual({
      summary: "Searched files",
      detail: "current ACP release",
    });
  });

  it("shows nested custom-tool arguments after dropping duplicate title detail", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "dynamic_tool_call",
        title: "cafe-code__list_threads",
        detail: "cafe-code__list_threads",
        data: {
          kind: "other",
          rawInput: {
            variant: "mcp",
            tool_name: "cafe-code__list_threads",
            tool_input: { state: "active" },
          },
        },
        fallbackSummary: "cafe-code__list_threads",
      }),
    ).toEqual({
      summary: "cafe-code__list_threads",
      detail: '{"state":"active"}',
    });
  });

  it("bounds tool arguments and redacts common credential fields", () => {
    expect(summarizeToolArguments(null)).toBeUndefined();
    expect(
      summarizeToolArguments({
        query: "active pull requests",
        apiKey: "sk-example-secret-value-1234567890",
        headers: { Authorization: "Bearer example-secret-value-1234567890" },
      }),
    ).toBe('{"query":"active pull requests","apiKey":"[redacted]","headers":"[redacted]"}');
    expect(summarizeToolArguments({ query: "x".repeat(500) })?.length).toBe(400);
  });
});
