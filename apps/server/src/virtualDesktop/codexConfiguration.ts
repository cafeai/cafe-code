// @effect-diagnostics nodeBuiltinImport:off
import { spawn } from "node:child_process";
import { desktopError } from "./nativeClient.ts";

export interface DesktopMcpLaunch {
  readonly bridgePath: string;
  readonly connectionPath: string | null;
}
const quote = (text: string) => JSON.stringify(text);
/** Codex 0.153.4 CLI overrides are TOML, and tables deep-merge. Supply a
 * complete transport even when disabled; preflight rejects inherited names.
 * The user enables unrestricted desktop input explicitly. Only this server
 * receives approval mode "approve"; "auto" can still prompt on destructive
 * annotations, even with thread approvalPolicy=never. A required enabled MCP
 * also avoids Codex's one-second optional startup/catalog race.
 * https://learn.chatgpt.com/docs/extend/mcp
 * https://github.com/openai/codex/blob/rust-v0.153.4/codex-rs/config/src/mcp_types.rs */
export function desktopMcpOverride(launch: DesktopMcpLaunch): string {
  return `mcp_servers.cafe-desktop={command=${quote(process.env.APPIMAGE || process.execPath)},args=[${quote(launch.bridgePath)},${quote(launch.connectionPath ?? "disabled")}],env={ELECTRON_RUN_AS_NODE="1"},enabled=${launch.connectionPath !== null},required=${launch.connectionPath !== null},default_tools_approval_mode="approve",startup_timeout_sec=15,tool_timeout_sec=50}`;
}

/** Configuration-only CLI command: does not connect to MCPs or contact a model.
 * Read both process and project cwd; project-layer HTTP transport fields must
 * not survive a CLI stdio-table merge and break app-server bootstrap. */
export async function preflightDesktopMcp(input: {
  binaryPath: string;
  homePath?: string;
  environment?: NodeJS.ProcessEnv;
  directories: readonly string[];
}) {
  for (const cwd of new Set(input.directories)) {
    const value: unknown = await new Promise((resolve, reject) => {
      const child = spawn(input.binaryPath, ["mcp", "list", "--json"], {
        cwd,
        env: {
          ...(input.environment ?? process.env),
          ...(input.homePath ? { CODEX_HOME: input.homePath } : {}),
        },
        stdio: ["ignore", "pipe", "ignore"],
        shell: false,
        detached: true,
      });
      const chunks: Buffer[] = [];
      let count = 0,
        failed = false;
      const fail = () => {
        failed = true;
        if (child.pid) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            /* already exited */
          }
        }
        reject(
          desktopError(
            "configuration_conflict",
            "Could not verify Codex MCP configuration. Check this provider's CLI and settings.",
          ),
        );
      };
      const timer = setTimeout(fail, 10_000);
      child.on("error", () => {
        clearTimeout(timer);
        fail();
      });
      child.stdout.on("data", (b: Buffer) => {
        count += b.length;
        if (count > 1024 * 1024) fail();
        else chunks.push(b);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (failed) return;
        if (code !== 0) {
          fail();
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          fail();
        }
      });
    });
    if (!Array.isArray(value))
      throw desktopError(
        "configuration_conflict",
        "Codex returned an unsupported MCP configuration.",
      );
    if (
      value.some(
        (entry: unknown) =>
          typeof entry === "object" &&
          entry !== null &&
          "name" in entry &&
          entry.name === "cafe-desktop",
      )
    )
      throw desktopError(
        "configuration_conflict",
        "Codex already has a cafe-desktop registration. Remove or rename that registration so Cafe can attach Desktop Control per conversation.",
      );
  }
}
