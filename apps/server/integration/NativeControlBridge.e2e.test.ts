import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import electron from "electron";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, it } from "vitest";
import { ProviderInstanceId, ThreadId } from "@cafecode/contracts";
import { NativeControlHost } from "../../desktop/src/nativeControl/NativeControlHost.ts";
import { makeNativeControlSessionBroker } from "../src/nativeControl/sessionRuntime.ts";

// Explicit process qualification: real copied bundled stdio transport and the
// real Cafe authority, with only native OS operations replaced by a fixture.
// No installed provider, user credentials, desktop capture or paid inference.
it.skipIf(process.env.CAFE_CODE_MCP_BRIDGE_E2E !== "1")(
  "routes the copied native bridge through authenticated Cafe sessions and preserves provider screenshots",
  async () => {
    const root = await fs.mkdtemp(join(tmpdir(), "cafe-native-mcp-"));
    const image =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
    const host = new NativeControlHost({
      stateDirectory: root,
      runtimeRoot: "unused",
      hostBundleId: "fixture",
      platform: "darwin",
      controller: {
        start: async () => {},
        stop: async () => {},
        health: async () => ({ content: [{ type: "text", text: "fixture health" }] }),
        session: async () => ({
          close: () => {},
          request: async (body) =>
            body.method === "trusted_session_end"
              ? { closed: true }
              : {
                  content: [
                    { type: "text", text: "fixture observation" },
                    { type: "image", mimeType: "image/png", data: image },
                  ],
                },
        }),
      },
    });
    const broker = makeNativeControlSessionBroker({
      stateDirectory: root,
      platform: "darwin",
      executable: String(electron),
      bridgeSource: fileURLToPath(
        new URL("../dist/native-desktop-mcp-bridge.mjs", import.meta.url),
      ),
    });
    const client = new Client({ name: "synthetic-provider", version: "1" });
    try {
      await host.listen();
      await host.setEnabled(true);
      const binding = await broker.bind({
        threadId: ThreadId.make("synthetic-thread"),
        providerInstanceId: ProviderInstanceId.make("synthetic-account"),
        provider: "codex",
      });
      expect(binding).toBeDefined();
      const transport = new StdioClientTransport({
        ...binding!.launch,
        args: [...binding!.launch.args],
        env: { ...binding!.launch.env },
        stderr: "pipe",
      });
      await client.connect(transport);
      const names = (await client.listTools()).tools.map((v) => v.name);
      expect(names).toContain("get_desktop_state");
      expect(names).not.toContain("install_extension");
      expect((await client.callTool({ name: "get_desktop_state", arguments: {} })).isError).toBe(
        true,
      );
      await binding!.activate();
      await binding!.beginTurn();
      const result = await client.callTool({ name: "get_desktop_state", arguments: {} });
      expect(result.content).toContainEqual({ type: "image", mimeType: "image/png", data: image });
      await binding!.endTurn();
      expect((await client.callTool({ name: "click", arguments: { x: 10, y: 20 } })).isError).toBe(
        true,
      );
    } finally {
      await client.close();
      await broker.close();
      await host.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);
