import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { createGlideMcpServer } from "./mcp.ts";
import { glideChildEnvironment } from "./runtime.ts";

describe("Glide MCP boundary", () => {
  it("advertises OpenAI's native interface without starting an execution runtime", async () => {
    const runtime = {
      execute: vi.fn(async () => ({ content: [] })),
      reset: vi.fn(async () => undefined),
    };
    const server = createGlideMcpServer(runtime),
      client = new Client({ name: "computer-catalogue-fixture", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    await client.connect(a);
    try {
      const description = (await client.listTools()).tools.find(
        (tool) => tool.name === "js",
      )?.description;
      expect(description).toContain("OpenAI");
      expect(description).toContain("@oai/sky");
      expect(description).toContain("Full access");
      expect(runtime.execute).not.toHaveBeenCalled();
      expect(runtime.reset).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("uses strict cells, returns text/images and resets through the actual MCP protocol", async () => {
    const runtime = {
      execute: vi.fn(async () => ({
        content: [
          { type: "text" as const, text: "observed" },
          { type: "image" as const, mimeType: "image/png" as const, data: "fixture" },
        ],
      })),
      reset: vi.fn(async () => undefined),
    };
    const server = createGlideMcpServer(runtime),
      client = new Client({ name: "glide-fixture", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    await client.connect(a);
    try {
      const result = await client.callTool({
        name: "js",
        arguments: { code: "await cua.listApps()", title: "Inspect apps" },
      });
      expect(result.content).toEqual([
        { type: "text", text: "observed" },
        { type: "image", mimeType: "image/png", data: "fixture" },
      ]);
      expect(runtime.execute).toHaveBeenCalledTimes(1);
      for (const args of [
        { code: "1", extra: true },
        { code: "1", title: " " },
        { code: "1", timeout_ms: 0 },
        { code: "1", timeout_ms: 60_001 },
      ]) {
        expect((await client.callTool({ name: "js", arguments: args })).isError).toBe(true);
      }
      expect(runtime.execute).toHaveBeenCalledTimes(1);
      expect(
        (await client.callTool({ name: "js_reset", arguments: { extra: true } })).isError,
      ).toBe(true);
      expect(runtime.reset).not.toHaveBeenCalled();
      await client.callTool({ name: "js_reset", arguments: {} });
      expect(runtime.reset).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
      await server.close();
    }
  });
  it("does not inherit provider credentials, Node hooks or dynamic loader settings", () => {
    const result = glideChildEnvironment({
      PATH: "fixture-path",
      HOME: "fixture-home",
      ANTHROPIC_API_KEY: "secret",
      OPENAI_API_KEY: "secret",
      NODE_OPTIONS: "--require=hook",
      NODE_PATH: "private",
      DYLD_INSERT_LIBRARIES: "hook",
      ELECTRON_RUN_AS_NODE: "0",
    });
    expect(result).toEqual({
      PATH: "fixture-path",
      HOME: "fixture-home",
      ELECTRON_RUN_AS_NODE: "1",
    });
  });
});
