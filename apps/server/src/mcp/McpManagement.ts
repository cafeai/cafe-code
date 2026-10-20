// Native namespace boundary retains host drive, separator and canonical path semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as path from "node:path";
import * as os from "node:os";
import { CafeMcpError, type CafeMcpStatus } from "@cafecode/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ServerConfig } from "../config.ts";
import { SessionCredentialService } from "../auth/Services/SessionCredentialService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  removeLegacyMcpClientConfiguration,
  isManagedMcpEntry,
  mcpClientConfigurations,
  readMcpClientEntry,
  type McpClientConfiguration,
  type McpLaunchSpec,
} from "./clientConfiguration.ts";
import { readMcpFile, writeMcpFile } from "./privateFiles.ts";
import { readBridgeConnection } from "./localBridge.ts";

export interface McpManagementShape {
  readonly status: (access: { canManage: boolean }) => Effect.Effect<CafeMcpStatus, CafeMcpError>;
}
export class McpManagement extends Context.Service<McpManagement, McpManagementShape>()(
  "cafecode/McpManagement",
) {}

/** Compatibility retirement only: never creates a registration or edits an
 * unrecognized cafe-code entry. Each write compares the complete observed file.
 * A conflict is preserved and reported without disclosing configuration data. */
export async function retireLegacyMcpRegistrations(options: {
  readonly home: string;
  readonly env: NodeJS.ProcessEnv;
  readonly stateDir: string;
  readonly executable: string;
  readonly platform: NodeJS.Platform;
}) {
  const bridgeDir = path.join(options.stateDir, "mcp");
  const connectionPath = path.join(bridgeDir, "connection.json");
  const launch: McpLaunchSpec = {
    command:
      options.platform === "linux" && options.env.APPIMAGE
        ? options.env.APPIMAGE
        : options.executable,
    args: [path.join(bridgeDir, "bridge.mjs"), connectionPath],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  };
  let incomplete = false;
  for (const original of mcpClientConfigurations(options.home, options.env)) {
    const targets: McpClientConfiguration[] = [original];
    if (original.id === "claude" && !options.env.CLAUDE_CONFIG_DIR)
      targets.push({ ...original, filePath: path.join(options.home, ".claude", ".claude.json") });
    if (original.id === "opencode" && !options.env.OPENCODE_CONFIG)
      targets.push({ ...original, filePath: original.filePath.replace(/\.json$/, ".jsonc") });
    for (const client of targets) {
      try {
        const current = await readMcpFile(client.filePath);
        if (current === undefined) continue;
        const entry = readMcpClientEntry(client, current);
        if (entry === undefined) continue;
        if (!isManagedMcpEntry(entry, launch)) {
          incomplete = true;
          continue;
        }
        const next = removeLegacyMcpClientConfiguration(client, current, launch);
        if (next !== current) await writeMcpFile(client.filePath, next, current);
      } catch {
        incomplete = true;
      }
    }
  }
  return { incomplete };
}

export const makeMcpManagement = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const settings = yield* ServerSettingsService;
  const sessions = yield* SessionCredentialService;
  // Old profile registrations stop granting authority even if a user-edited or
  // unsafe config cannot be removed. No renewal/reinstall loop survives migration.
  if (config.mode === "desktop") {
    const previousSessions = yield* sessions.listActive().pipe(Effect.option);
    if (previousSessions._tag === "Some") {
      yield* Effect.forEach(
        previousSessions.value.filter((session) => session.subject === "cafe-mcp-local-bridge"),
        (session) =>
          sessions
            .revoke(session.sessionId)
            .pipe(
              Effect.catch(() =>
                Effect.logWarning("A legacy MCP credential could not be retired."),
              ),
            ),
        { discard: true },
      );
    } else yield* Effect.logWarning("Legacy MCP credential retirement is unavailable.");
    const connectionPath = path.join(config.stateDir, "mcp", "connection.json");
    const old = yield* Effect.tryPromise(() => readBridgeConnection(connectionPath)).pipe(
      Effect.option,
    );
    if (old._tag === "Some") {
      const result = yield* Effect.tryPromise(() =>
        retireLegacyMcpRegistrations({
          home: os.homedir(),
          env: process.env,
          stateDir: config.stateDir,
          executable: process.execPath,
          platform: process.platform,
        }),
      ).pipe(Effect.option);
      if (result._tag === "None" || result.value.incomplete)
        yield* Effect.logWarning(
          "A legacy Cafe MCP registration was left unchanged because safe retirement could not be verified.",
        );
    }
  }
  return McpManagement.of({
    status: (access) =>
      settings.getSettings.pipe(
        Effect.map((settings) => ({ enabled: settings.mcpEnabled, canManage: access.canManage })),
        Effect.mapError(
          () =>
            new CafeMcpError({
              code: "unavailable",
              message: "Cafe management settings are unavailable.",
            }),
        ),
      ),
  });
});
export const McpManagementLive = Layer.effect(McpManagement, makeMcpManagement);
