import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as Toml from "toml";
import { afterEach, describe, expect, it } from "vitest";

import {
  editMcpClientConfiguration,
  mcpClientConfigurations,
  readMcpClientEntry,
  type McpLaunchSpec,
} from "./clientConfiguration.ts";
import { makeMcpInstallationFiles } from "./McpManagement.ts";
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

describe("MCP user configuration", () => {
  for (const client of mcpClientConfigurations("/test-user", {})) {
    it(`installs and removes ${client.id} without changing other settings`, () => {
      const contents =
        client.format === "toml"
          ? '# Keep my model\nmodel = "mine"\n[mcp_servers.other]\ncommand = "other"\n'
          : '{\n  // Keep my model\n  "model": "mine",\n  "unrelated": { "secret": "do-not-touch" },\n}\n';
      const installed = editMcpClientConfiguration(client, contents, launch, "install");
      expect(installed).toContain("Keep my model");
      expect(installed).toContain('"mine"');
      expect(readMcpClientEntry(client, installed)).toBeDefined();
      expect(editMcpClientConfiguration(client, installed, launch, "install")).toBe(installed);
      const removed = editMcpClientConfiguration(client, installed, launch, "remove");
      expect(readMcpClientEntry(client, removed)).toBeUndefined();
      expect(removed).toContain("Keep my model");
      if (client.format === "toml") expect(removed).toBe(contents);
      else expect(removed).toContain('"secret": "do-not-touch"');
    });
  }

  it("refuses a same-named server from another Cafe environment", () => {
    const client = mcpClientConfigurations("/test-user", {})[0]!;
    const installed = editMcpClientConfiguration(client, "", launch, "install");
    expect(() =>
      editMcpClientConfiguration(
        client,
        installed,
        { ...launch, args: ["/elsewhere/bridge.mjs", "/elsewhere/connection.json"] },
        "install",
      ),
    ).toThrow("different cafe-code");
    expect(() =>
      editMcpClientConfiguration(
        client,
        '[mcp_servers.cafe-code]\nurl = "https://example.com"',
        launch,
        "remove",
      ),
    ).toThrow("different cafe-code");
  });

  it("leaves a separately configured Desktop Control MCP untouched", () => {
    const client = mcpClientConfigurations("/test-user", {})[0]!;
    const contents =
      "# Desktop Control is enabled per run, never by the Cafe installer.\n" +
      '[mcp_servers.cafe-desktop]\ncommand = "desktop-bridge"\nenabled = false\n' +
      'args = ["/private/desktop-session.json"]\n';
    const original: unknown = Toml.parse(contents);
    const installed = editMcpClientConfiguration(client, contents, launch, "install");
    const withCafe: unknown = Toml.parse(installed);
    expect(withCafe).toMatchObject(original as object);
    expect(readMcpClientEntry(client, installed)).toBeDefined();
    expect(editMcpClientConfiguration(client, installed, launch, "remove")).toBe(contents);
  });

  it("refuses malformed input without echoing secrets", () => {
    const client = mcpClientConfigurations("/test-user", {})[0]!;
    expect(() =>
      editMcpClientConfiguration(client, 'token = "private-secret', launch, "install"),
    ).toThrow("configuration is invalid");
    expect(() =>
      editMcpClientConfiguration(client, 'token = "private-secret', launch, "install"),
    ).not.toThrow("private-secret");
  });

  it("refuses duplicate JSON keys instead of updating an ambiguous server map", () => {
    const client = mcpClientConfigurations("/test-user", {})[1]!;
    expect(() =>
      editMcpClientConfiguration(client, '{"mcpServers": {}, "mcpServers": {}}', launch, "install"),
    ).toThrow("invalid");
  });

  it("installs both default Claude config locations and checks all conflicts before writing", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "cafe-mcp-test-")));
    roots.push(root);
    const files = makeMcpInstallationFiles({
      stateDir: path.join(root, "state"),
      home: root,
      env: {},
      executable: process.execPath,
      bridgeSource: "unused",
      platform: process.platform,
    });
    const cliConfig = path.join(root, ".claude.json");
    const cafeConfig = path.join(root, ".claude", ".claude.json");
    await fs.mkdir(path.dirname(cafeConfig), { mode: 0o700 });
    const conflict = '{"mcpServers":{"cafe-code":{"command":"another-server"}}}';
    await fs.writeFile(cafeConfig, conflict);
    await expect(files.update({ client: "claude", operation: "install" })).rejects.toThrow(
      "different cafe-code",
    );
    expect(await readMcpFile(cliConfig)).toBeUndefined();
    expect(await fs.readFile(cafeConfig, "utf8")).toBe(conflict);
    await fs.writeFile(cafeConfig, "{}");
    await files.update({ client: "claude", operation: "install" });
    expect(await fs.readFile(cliConfig, "utf8")).toContain("cafe-code");
    expect(await fs.readFile(cafeConfig, "utf8")).toContain("cafe-code");
    await fs.writeFile(cliConfig, "{}");
    expect((await files.list()).find((client) => client.id === "claude")?.status).toBe(
      "needs-repair",
    );
    await files.update({ client: "claude", operation: "remove" });
    expect((await files.list()).find((client) => client.id === "claude")?.status).toBe(
      "not-installed",
    );
  });

  it("will not delete text hidden between forged TOML markers", () => {
    const client = mcpClientConfigurations("/test-user", {})[0]!;
    const original =
      'prompt = """\n# BEGIN Cafe Code managed MCP\nuser content\n# END Cafe Code managed MCP\n"""\n';
    expect(() => editMcpClientConfiguration(client, original, launch, "install")).toThrow();
  });

  it("honors explicit user configuration locations", () => {
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

  it("installs a private bridge, detects actual config state, and supports removal", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "cafe-mcp-test-")));
    roots.push(root);
    const source = path.join(root, "source.mjs");
    await fs.writeFile(source, "// bridge fixture\n");
    const files = makeMcpInstallationFiles({
      stateDir: path.join(root, "state"),
      home: path.join(root, "home"),
      env: { APPIMAGE: "/apps/Cafe Code.AppImage" },
      executable: "/temporary/mount/cafe",
      bridgeSource: source,
      platform: "linux",
    });
    expect(files.launch.command).toBe("/apps/Cafe Code.AppImage");
    await files.prepareBridge();
    await files.update({ client: "codex", operation: "install" });
    expect((await files.list()).find((client) => client.id === "codex")?.status).toBe("installed");
    const config = path.join(root, "home", ".codex", "config.toml");
    const contents = await fs.readFile(config, "utf8");
    expect(contents).not.toContain("token");
    if (process.platform !== "win32") expect((await fs.stat(config)).mode & 0o777).toBe(0o600);
    await files.update({ client: "codex", operation: "remove" });
    expect((await files.list()).find((client) => client.id === "codex")?.status).toBe(
      "not-installed",
    );
  });

  it("edits an existing OpenCode JSONC file instead of creating a shadowed JSON file", async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "cafe-mcp-test-")));
    roots.push(root);
    const dir = path.join(root, ".config", "opencode");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "opencode.jsonc"), '{ // custom\n "mcp": {}\n}');
    const files = makeMcpInstallationFiles({
      stateDir: path.join(root, "state"),
      home: root,
      env: {},
      executable: process.execPath,
      bridgeSource: "unused",
      platform: process.platform,
    });
    await files.update({ client: "opencode", operation: "install" });
    expect(await fs.readFile(path.join(dir, "opencode.jsonc"), "utf8")).toContain("cafe-code");
    expect(await readMcpFile(path.join(dir, "opencode.json"))).toBeUndefined();
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
