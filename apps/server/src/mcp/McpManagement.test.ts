import { legacyMcpConfiguration } from "./fixtures/legacyConfiguration.ts";
// Native fixture retains actual host file/socket identity and exact owned cleanup.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as fs from "node:fs/promises";
import * as os from "node:os";
// Native fixture retains actual host file/socket identity and exact owned cleanup.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { retireLegacyMcpRegistrations } from "./McpManagement.ts";
import { mcpClientConfigurations, readMcpClientEntry } from "./clientConfiguration.ts";
import { readMcpFile, writeMcpFile } from "./privateFiles.ts";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "cafe-mcp-retirement-")));
  roots.push(root);
  const options = {
    home: root,
    stateDir: path.join(root, "state"),
    env: {},
    executable: process.execPath,
    platform: process.platform,
  };
  const launch = {
    command: process.execPath,
    args: [
      path.join(options.stateDir, "mcp", "bridge.mjs"),
      path.join(options.stateDir, "mcp", "connection.json"),
    ],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  };
  return { root, options, launch };
}
describe("legacy MCP retirement", () => {
  it("removes only exact Cafe-owned entries across all old profile locations and remains idempotent", async () => {
    const f = await fixture();
    const clients = mcpClientConfigurations(f.root, {});
    const claude = clients.find((client) => client.id === "claude")!;
    const opencode = clients.find((client) => client.id === "opencode")!;
    clients.push(
      { ...claude, filePath: path.join(f.root, ".claude", ".claude.json") },
      { ...opencode, filePath: opencode.filePath.replace(/\.json$/, ".jsonc") },
    );
    const originals = new Map<string, string>();
    for (const client of clients) {
      const contents =
        client.format === "toml"
          ? '# Preserve me\nmodel = "mine"\nlargest = 9223372036854775807\n[mcp_servers.other]\ncommand = "other"\n'
          : '{ // Preserve me\n "model": "mine", "mcpServers": {"other": {"command":"other"}}\n}';
      originals.set(client.filePath, contents);
      await writeMcpFile(
        client.filePath,
        legacyMcpConfiguration(client, contents, f.launch),
        undefined,
      );
    }
    expect(await retireLegacyMcpRegistrations(f.options)).toEqual({ incomplete: false });
    for (const client of clients) {
      const contents = await fs.readFile(client.filePath, "utf8");
      expect(readMcpClientEntry(client, contents)).toBeUndefined();
      expect(contents).toContain("Preserve me");
      expect(contents).toContain('"mine"');
      expect(contents).toContain('"other"');
      if (client.format === "toml") expect(contents).toBe(originals.get(client.filePath));
    }
    expect(await retireLegacyMcpRegistrations(f.options)).toEqual({ incomplete: false });
  });
  it("preserves conflicts, malformed files and absent profiles without creating configuration", async () => {
    const f = await fixture();
    const [codex, claude, grok] = mcpClientConfigurations(f.root, {});
    const conflict = '[mcp_servers.cafe-code]\ncommand = "someone-else"\n';
    const malformed = '{"private_token":"do-not-disclose",';
    await writeMcpFile(codex!.filePath, conflict, undefined);
    await writeMcpFile(claude!.filePath, malformed, undefined);
    expect(await retireLegacyMcpRegistrations(f.options)).toEqual({ incomplete: true });
    expect(await fs.readFile(codex!.filePath, "utf8")).toBe(conflict);
    expect(await fs.readFile(claude!.filePath, "utf8")).toBe(malformed);
    expect(await readMcpFile(grok!.filePath)).toBeUndefined();
  });
});
