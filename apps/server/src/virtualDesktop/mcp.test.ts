import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { makeDesktopMcpServer } from "./mcp.ts";

describe("separate Desktop Control MCP", () => {
  it("exposes desktop tools and returns observations as image content", async () => {
    const observation = {
      id: "24ff9ac9-1d98-4bb9-9d3f-1e868663a064",
      capturedAt: "2026-09-09T00:00:00.000Z",
      width: 1280,
      height: 800,
      frame: 4,
      humanControl: false,
      storage: "saved",
    };
    const invoke = vi
      .fn()
      .mockResolvedValue({ image: "aW1hZ2U=", width: 1280, height: 800, frame: 4, observation });
    const server = makeDesktopMcpServer(invoke),
      client = new Client({ name: "fixture", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    await client.connect(b);
    try {
      expect((await client.listTools()).tools.map((t) => t.name).toSorted()).toEqual([
        "act",
        "focus",
        "get_display",
        "launch",
        "layout",
        "list_apps",
        "observe",
        "set_display",
        "sway_command",
        "sway_query",
        "take_control",
        "window",
        "windows",
        "workspace",
        "workspaces",
      ]);
      expect(await client.callTool({ name: "observe", arguments: {} })).toMatchObject({
        structuredContent: { desktopObservation: observation },
        content: [{ type: "text" }, { type: "image", mimeType: "image/png", data: "aW1hZ2U=" }],
      });
      const combined = await client.callTool({
        name: "act",
        arguments: {
          actions: [
            { kind: "text", text: "bamboo" },
            { kind: "key", keys: ["Return"] },
          ],
          observeAfter: "if_changed",
        },
      });
      expect(combined).toMatchObject({
        structuredContent: { desktopObservation: observation },
        content: [{ type: "text" }, { type: "image" }],
      });
      if (!Array.isArray(combined.content)) throw Error("Expected MCP content blocks.");
      expect(JSON.stringify(combined.content[0])).not.toContain("storage");
      const takeControl = (await client.listTools()).tools.find(
        (tool) => tool.name === "take_control",
      );
      expect(takeControl?.annotations?.readOnlyHint).toBe(false);
      await client.callTool({ name: "take_control", arguments: {} });
      expect(invoke).toHaveBeenLastCalledWith("take_control", {}, expect.any(AbortSignal));
      await client.callTool({ name: "act", arguments: { kind: "click", x: -1, y: 20 } });
      expect(invoke).toHaveBeenCalledTimes(3);
      invoke.mockRejectedValueOnce(new Error("private bearer and typed text"));
      const failed = await client.callTool({
        name: "act",
        arguments: { kind: "click", x: 1, y: 20 },
      });
      expect(failed.isError).toBe(true);
      expect(JSON.stringify(failed)).not.toContain("private bearer");
      invoke.mockResolvedValueOnce({
        success: false,
        partialFailure: true,
        results: [{ success: true }, { success: false, error: "No matching node." }],
      });
      const partial = await client.callTool({
        name: "sway_command",
        arguments: { command: "nop; [con_id=999] focus" },
      });
      expect(partial.isError).toBe(true);
      expect(partial.content).toEqual([
        {
          type: "text",
          text: JSON.stringify({
            success: false,
            partialFailure: true,
            results: [{ success: true }, { success: false, error: "No matching node." }],
          }),
        },
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
