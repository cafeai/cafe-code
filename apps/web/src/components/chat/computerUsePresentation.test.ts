import { describe, expect, it } from "vitest";
import { readComputerUsePresentation } from "./computerUsePresentation";

const nativeTool = (kind: string, tool: string) => ({
  kind,
  tone: "info" as const,
  summary: "MCP tool call",
  payload: { data: { item: { server: "cafe-native-private-id", tool } } },
});

describe("computer-use work-log copy", () => {
  it("labels the bound interface without exposing target handles or batch contents", () => {
    expect(readComputerUsePresentation(nativeTool("tool.started", "computer_select"))?.label).toBe(
      "Selecting an app…",
    );
    expect(
      readComputerUsePresentation(nativeTool("tool.completed", "computer_observe"))?.label,
    ).toBe("Read the app");
    expect(readComputerUsePresentation(nativeTool("tool.started", "computer_act"))?.label).toBe(
      "Using the app…",
    );
  });
  it("describes actions and completion without exposing private server names or input", () => {
    expect(readComputerUsePresentation(nativeTool("tool.started", "click"))?.label).toBe(
      "Clicking…",
    );
    expect(
      readComputerUsePresentation(nativeTool("tool.completed", "get_window_state"))?.label,
    ).toBe("Read the window");
    expect(
      readComputerUsePresentation(nativeTool("tool.completed", "release_control"))?.label,
    ).toBe("Released computer control");
    expect(
      readComputerUsePresentation({
        kind: "tool.completed",
        tone: "info",
        summary: "MCP tool call",
        payload: { detail: "cafe-native-private-id.type_text: secret typed text" },
      })?.label,
    ).toBe("Typed text");
  });
  it("supports saved bridge spellings, marks failures and leaves unrelated MCP tools alone", () => {
    expect(
      readComputerUsePresentation({
        kind: "tool.updated",
        tone: "info",
        summary: "Tool call",
        payload: {
          data: { rawInput: { tool_name: "mcp__cafe-native-private-id__bring_to_front" } },
        },
      })?.label,
    ).toBe("Bringing the window forward…");
    expect(
      readComputerUsePresentation({ ...nativeTool("tool.completed", "click"), tone: "error" })
        ?.label,
    ).toBe("Clicking failed");
    expect(
      readComputerUsePresentation({
        ...nativeTool("tool.completed", "click"),
        payload: { data: { item: { server: "other-server", tool: "click" } } },
      }),
    ).toBeNull();
    expect(
      readComputerUsePresentation({
        kind: "task.progress",
        tone: "info",
        summary: "cafe-native-private-id.click",
        payload: {},
      }),
    ).toBeNull();
  });
});
