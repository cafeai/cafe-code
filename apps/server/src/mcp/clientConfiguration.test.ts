import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  removeLegacyMcpClientConfiguration,
  mcpClientConfigurations,
  readMcpClientEntry,
  type McpLaunchSpec,
} from "./clientConfiguration.ts";
import { legacyMcpConfiguration } from "./fixtures/legacyConfiguration.ts";
import { readMcpFile, writeMcpFile } from "./privateFiles.ts";
const launch: McpLaunchSpec = {
  command: "/a path/Cafe",
  args: ["/private/bridge.mjs", "/private/connection.json"],
  env: { ELECTRON_RUN_AS_NODE: "1" },
};
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
describe("legacy MCP configuration removal", () => {
  for (const client of mcpClientConfigurations("/test-user", {})) {
    it(`removes ${client.id} without changing unrelated settings`, () => {
      const contents =
        client.format === "toml"
          ? '# Preserve me\nmodel = "mine"\n[mcp_servers.other]\ncommand = "other"\n'
          : '{\n // Preserve me\n "model": "mine", "unrelated": { "secret": "do-not-touch" }\n}\n';
      const original = legacyMcpConfiguration(client, contents, launch);
      const removed = removeLegacyMcpClientConfiguration(client, original, launch);
      expect(readMcpClientEntry(client, removed)).toBeUndefined();
      expect(removed).toContain("Preserve me");
      expect(removed).toContain('"mine"');
      if (client.format === "toml") expect(removed).toBe(contents);
      else expect(removed).toContain('"secret": "do-not-touch"');
      expect(removeLegacyMcpClientConfiguration(client, removed, launch)).toBe(removed);
    });
  }
  it("refuses a same-named server from another Cafe environment", () => {
    const client = mcpClientConfigurations("/test-user", {})[0]!;
    const original = legacyMcpConfiguration(client, "", launch);
    expect(() =>
      removeLegacyMcpClientConfiguration(client, original, {
        ...launch,
        args: ["/elsewhere/bridge.mjs", "/elsewhere/connection.json"],
      }),
    ).toThrow("different cafe-code");
    expect(() =>
      removeLegacyMcpClientConfiguration(
        client,
        '[mcp_servers.cafe-code]\nurl = "https://example.com"',
        launch,
      ),
    ).toThrow("different cafe-code");
  });
  it("preserves full-range TOML integers, dates and unrelated tool bytes", () => {
    const client = mcpClientConfigurations("/test-user", {})[0]!;
    const contents =
      '# Preserve exactly\nlargest = 9223372036854775807\nsmallest = -9223372036854775808\nhex = 0x7fff_ffff_ffff_ffff\noctal = 0o755\nbinary = 0b1101\nsafe = 3\nfloat = 1.25\ndate = 1979-05-27\n[mcp_servers.other]\ncommand = "other"\n';
    expect(
      removeLegacyMcpClientConfiguration(
        client,
        legacyMcpConfiguration(client, contents, launch),
        launch,
      ),
    ).toBe(contents);
  });
  it.each([
    'private_token = "do-not-disclose',
    "largest = 9223372036854775808\n",
    "smallest = -9223372036854775809\n",
    `nested = ${"[".repeat(81)}0${"]".repeat(81)}\n`,
    "id = 1\nid = 2\n",
  ])("rejects malformed or ambiguous TOML without exposing input (%#)", (contents) => {
    const client = mcpClientConfigurations("/test-user", {})[0]!;
    expect(() => removeLegacyMcpClientConfiguration(client, contents, launch)).toThrow(
      "configuration is invalid",
    );
    expect(() => removeLegacyMcpClientConfiguration(client, contents, launch)).not.toThrow(
      "do-not-disclose",
    );
  });
  it("refuses duplicate JSON keys", () => {
    const client = mcpClientConfigurations("/test-user", {})[1]!;
    expect(() =>
      removeLegacyMcpClientConfiguration(client, '{"mcpServers": {}, "mcpServers": {}}', launch),
    ).toThrow("invalid");
  });
  it("does not delete text between forged TOML markers", () => {
    const client = mcpClientConfigurations("/test-user", {})[0]!;
    const text =
      'prompt = """\n# BEGIN Cafe Code managed MCP\nuser content\n# END Cafe Code managed MCP\n"""\n';
    expect(removeLegacyMcpClientConfiguration(client, text, launch)).toBe(text);
    const withRealEntry = legacyMcpConfiguration(client, text, launch);
    expect(() => removeLegacyMcpClientConfiguration(client, withRealEntry, launch)).toThrow();
  });
  it("honors explicit user configuration locations for retirement", () => {
    const clients = mcpClientConfigurations("/home/test", {
      CODEX_HOME: "/custom/codex",
      CLAUDE_CONFIG_DIR: "/custom/claude",
      GROK_HOME: "/custom/grok",
      OPENCODE_CONFIG: "/custom/opencode.jsonc",
    });
    expect(clients.map((client) => client.filePath)).toEqual([
      path.join("/custom/codex", "config.toml"),
      path.join("/custom/claude", ".claude.json"),
      path.join("/custom/grok", "config.toml"),
      "/custom/opencode.jsonc",
    ]);
  });
  it("rejects linked files and stale writes, leaving the target intact", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "cafe-mcp-test-")));
    roots.push(root);
    const target = path.join(root, "target");
    await fs.writeFile(target, "original", { mode: 0o600 });
    await expect(writeMcpFile(target, "replacement", "stale")).rejects.toThrow("changed");
    expect(await fs.readFile(target, "utf8")).toBe("original");
    const link = path.join(root, "link");
    try {
      await fs.symlink(target, link);
    } catch (error) {
      if (
        process.platform === "win32" &&
        typeof error === "object" &&
        error &&
        "code" in error &&
        error.code === "EPERM"
      )
        return;
      throw error;
    }
    await expect(readMcpFile(link)).rejects.toThrow("linked");
    await expect(writeMcpFile(link, "replacement", "original")).rejects.toThrow("linked");
    expect(await fs.readFile(target, "utf8")).toBe("original");
  });
});
