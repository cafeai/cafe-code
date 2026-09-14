import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const enabled = process.platform === "linux" && process.env.CAFE_CODE_CODEX_MCP_CONFIG_E2E === "1";

/**
 * Real Codex configuration qualification, deliberately outside default tests.
 * No provider credentials, MCP subprocesses, network/model calls, or live user
 * configs are needed: `mcp get/list` only inspect this temporary configuration.
 * Official contract: https://learn.chatgpt.com/docs/config-file/config-advanced
 * `-c` accepts TOML and lasts for one invocation, not an edit to config.toml.
 */
async function withIsolatedCodex(
  contents: string,
  test: (probe: (args: string[]) => Promise<unknown>, configPath: string) => Promise<void>,
) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "cafe-codex-mcp-config-")),
  );
  const configPath = path.join(root, "config.toml");
  try {
    await fs.writeFile(configPath, contents, { mode: 0o600 });
    await test(async (args) => {
      try {
        const result = await execFileAsync(process.env.CODEX_BIN || "codex", args, {
          cwd: root,
          // Do not inherit provider-home, auth, or configuration overrides from
          // the developer's real session. The executable can still use PATH.
          env: { PATH: process.env.PATH, HOME: root, CODEX_HOME: root },
          timeout: 15_000,
          maxBuffer: 1024 * 1024,
          shell: false,
        });
        return JSON.parse(result.stdout) as unknown;
      } catch {
        // execFile errors can contain argv/stderr. Keep opt-in failures bounded
        // and fixed just like production provider diagnostics.
        throw new Error(
          "Codex MCP configuration probe failed. Check CODEX_BIN and the pinned CLI version.",
        );
      }
    }, configPath);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

it.skipIf(!enabled)(
  "enables Desktop Control for one invocation while preserving both registrations",
  async () => {
    const contents =
      '[mcp_servers.cafe-code]\ncommand = "cafe-management-fixture"\n' +
      '[mcp_servers.cafe-desktop]\ncommand = "cafe-desktop-fixture"\nenabled = false\n';
    await withIsolatedCodex(contents, async (probe, configPath) => {
      const getDesktop = ["mcp", "get", "cafe-desktop", "--json"];
      expect(await probe(getDesktop)).toMatchObject({ name: "cafe-desktop", enabled: false });
      expect(
        await probe(["-c", "mcp_servers.cafe-desktop.enabled=true", ...getDesktop]),
      ).toMatchObject({
        name: "cafe-desktop",
        enabled: true,
        transport: { command: "cafe-desktop-fixture" },
      });
      expect(await probe(["mcp", "get", "cafe-code", "--json"])).toMatchObject({
        name: "cafe-code",
        enabled: true,
        transport: { command: "cafe-management-fixture" },
      });
      expect(await probe(getDesktop)).toMatchObject({ enabled: false });
      expect(await fs.readFile(configPath, "utf8")).toBe(contents);
    });
  },
);

it.skipIf(!enabled)(
  "injects a complete per-run Desktop Control definition without installing it globally",
  async () => {
    const contents = '[mcp_servers.cafe-code]\ncommand = "cafe-management-fixture"\n';
    await withIsolatedCodex(contents, async (probe, configPath) => {
      // Structured argv, not shell interpolation. Exercise spaces/quotes so the
      // launch plan does not mistake JSON object syntax for a TOML inline table.
      const command = '/fixture path/Cafe "Code"';
      const connection = '/private session/connection "fixture".json';
      const definition =
        `mcp_servers.cafe-desktop={command=${JSON.stringify(command)},` +
        `args=[${JSON.stringify(connection)}],env={ELECTRON_RUN_AS_NODE="1"},enabled=true}`;
      expect(await probe(["-c", definition, "mcp", "get", "cafe-desktop", "--json"])).toMatchObject(
        {
          name: "cafe-desktop",
          enabled: true,
          transport: { command, args: [connection], env: { ELECTRON_RUN_AS_NODE: "1" } },
        },
      );
      const later = await probe(["mcp", "list", "--json"]);
      expect(later).toEqual([expect.objectContaining({ name: "cafe-code", enabled: true })]);
      expect(await fs.readFile(configPath, "utf8")).toBe(contents);
    });
  },
);
