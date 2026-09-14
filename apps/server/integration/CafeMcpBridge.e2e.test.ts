import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import electron from "electron";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { expect, it } from "vitest";

// Explicitly opt-in: launches Electron in Node mode, or the exact packaged
// executable selected by the artifact smoke. Copy only the entrypoint into an
// otherwise empty directory, exactly as provider registration/session binding
// does. Running it next to dist's shared chunks would hide a broken bundle.
it.skipIf(process.env.CAFE_CODE_MCP_BRIDGE_E2E !== "1").each([
  { audience: "cafe-code", endpoint: "/mcp", entry: "mcp-bridge.mjs" },
  { audience: "cafe-desktop", endpoint: "/mcp/desktop", entry: "desktop-mcp-bridge.mjs" },
])(
  "runs the isolated $audience bridge through Cafe's Electron runtime",
  async ({ audience, endpoint, entry }) => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "cafe-mcp-e2e-")));
    const token = randomBytes(48).toString("base64url");
    const server = createServer((request, response) => {
      void (async () => {
        if (request.url !== endpoint || request.headers.authorization !== `Bearer ${token}`) {
          response.writeHead(401).end();
          return;
        }
        const mcp = new McpServer({ name: "cafe-mcp-fixture", version: "1" });
        mcp.registerTool(
          "probe",
          { description: "Return a fixture image", inputSchema: {} },
          async () => ({
            content: [
              { type: "text", text: "bridge-ok" },
              {
                type: "image",
                mimeType: "image/png",
                data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
              },
            ],
          }),
        );
        const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
        response.on("close", () => {
          void mcp.close();
          void transport.close();
        });
        // SDK 1.29's Node transport declares callback accessors as `T | undefined`
        // while its Transport interface uses optional keys. They are equivalent
        // at runtime but differ under this repository's exactOptionalPropertyTypes.
        await mcp.connect(transport as Parameters<McpServer["connect"]>[0]);
        await transport.handleRequest(request, response);
      })().catch(() => response.destroy());
    });
    const client = new Client({ name: "cafe-mcp-e2e", version: "1" });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing test listener");
      const bridge = path.join(root, "bridge.mjs");
      const bridgeDirectory =
        process.env.CAFE_CODE_MCP_BRIDGE_DIR ?? fileURLToPath(new URL("../dist", import.meta.url));
      await fs.copyFile(path.join(bridgeDirectory, entry), bridge);
      await fs.chmod(bridge, 0o600);
      const connectionPath = path.join(root, "connection.json");
      await fs.writeFile(
        connectionPath,
        JSON.stringify({ audience, url: `http://127.0.0.1:${address.port}${endpoint}`, token }),
        { mode: 0o600 },
      );
      const transport = new StdioClientTransport({
        command: process.env.CAFE_CODE_MCP_BRIDGE_EXECUTABLE ?? String(electron),
        args: [bridge, connectionPath],
        env: { ELECTRON_RUN_AS_NODE: "1" },
        stderr: "pipe",
      });
      await client.connect(transport);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["probe"]);
      const result = await client.callTool({ name: "probe", arguments: {} });
      expect(result.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "text", text: "bridge-ok" }),
          expect.objectContaining({ type: "image", mimeType: "image/png" }),
        ]),
      );
    } finally {
      await client.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(root, { recursive: true, force: true });
    }
  },
);
