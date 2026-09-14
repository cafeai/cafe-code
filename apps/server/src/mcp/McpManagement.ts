import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import {
  CafeMcpError,
  type CafeMcpClientStatus,
  type CafeMcpClientUpdate,
  type CafeMcpStatus,
} from "@cafecode/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

import { ServerConfig } from "../config.ts";
import {
  SessionCredentialService,
  type SessionCredentialServiceShape,
} from "../auth/Services/SessionCredentialService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  editMcpClientConfiguration,
  isManagedMcpEntry,
  isMcpEntryReady,
  mcpClientConfigurations,
  readMcpClientEntry,
  type McpClientConfiguration,
  type McpLaunchSpec,
} from "./clientConfiguration.ts";
import { McpFileError, readMcpFile, writeMcpFile } from "./privateFiles.ts";
import { readBridgeConnection } from "./localBridge.ts";

const BRIDGE_SUBJECT = "cafe-mcp-local-bridge";
const REFRESH_INTERVAL = Duration.hours(24);
const RENEWAL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface McpManagementShape {
  readonly status: (access: {
    canManage: boolean;
    canInstall: boolean;
  }) => Effect.Effect<CafeMcpStatus, CafeMcpError>;
  readonly updateClient: (input: CafeMcpClientUpdate) => Effect.Effect<void, CafeMcpError>;
}

export class McpManagement extends Context.Service<McpManagement, McpManagementShape>()(
  "cafecode/McpManagement",
) {}

export interface McpInstallationOptions {
  readonly stateDir: string;
  readonly home: string;
  readonly env: NodeJS.ProcessEnv;
  readonly executable: string;
  readonly bridgeSource: string;
  readonly platform: NodeJS.Platform;
}

export function makeMcpInstallationFiles(options: McpInstallationOptions) {
  const bridgeDir = path.join(options.stateDir, "mcp");
  const bridgePath = path.join(bridgeDir, "bridge.mjs");
  const connectionPath = path.join(bridgeDir, "connection.json");
  const launch: McpLaunchSpec = {
    command:
      options.platform === "linux" && options.env.APPIMAGE
        ? options.env.APPIMAGE
        : options.executable,
    args: [bridgePath, connectionPath],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  };
  const clients = mcpClientConfigurations(options.home, options.env);

  async function resolveClient(client: McpClientConfiguration): Promise<McpClientConfiguration> {
    if (client.id !== "opencode" || options.env.OPENCODE_CONFIG) return client;
    // OpenCode accepts JSONC and gives it precedence. Edit the existing JSONC
    // file if present so a successful install cannot be shadowed by that file.
    const jsoncPath = client.filePath.replace(/\.json$/, ".jsonc");
    return (await readMcpFile(jsoncPath)) !== undefined
      ? { ...client, filePath: jsoncPath }
      : client;
  }

  const isSupported = (client: McpClientConfiguration) =>
    !(client.id === "grok" && options.platform === "win32");

  const targets = async (original: McpClientConfiguration) => {
    const client = await resolveClient(original);
    // Cafe's ClaudeHome explicitly sets CLAUDE_CONFIG_DIR even for the default
    // profile. Current Claude then reads .claude/.claude.json, while a plain
    // terminal launch reads ~/.claude.json. Qualify both default user surfaces
    // without changing Claude's auth-home selection or its launch environment.
    return client.id === "claude" && !options.env.CLAUDE_CONFIG_DIR
      ? [client, { ...client, filePath: path.join(options.home, ".claude", ".claude.json") }]
      : [client];
  };

  const list = async (): Promise<CafeMcpClientStatus[]> =>
    Promise.all(
      clients.map(async (original) => {
        if (!isSupported(original))
          return {
            id: original.id,
            name: original.name,
            status: "unavailable",
            detail: "This provider is not supported on this platform yet.",
          };
        try {
          const entries = await Promise.all(
            (await targets(original)).map(async (client) =>
              readMcpClientEntry(client, (await readMcpFile(client.filePath)) ?? ""),
            ),
          );
          const client = original;
          if (entries.some((entry) => entry !== undefined && !isManagedMcpEntry(entry, launch)))
            return {
              id: client.id,
              name: client.name,
              status: "conflict",
              detail: "A different cafe-code MCP registration exists. It was left unchanged.",
            };
          if (entries.some((entry) => entry === undefined))
            return {
              id: client.id,
              name: client.name,
              status: entries.some((entry) => entry !== undefined)
                ? "needs-repair"
                : "not-installed",
              detail: entries.some((entry) => entry !== undefined)
                ? "Installation is incomplete. Install to connect both Cafe and your terminal's default profile."
                : "Available to install for your default user profile.",
            };
          if (entries.some((entry) => !isMcpEntryReady(client, entry, launch)))
            return {
              id: client.id,
              name: client.name,
              status: "needs-repair",
              detail: "The Cafe MCP configuration changed. Reinstall to restore the local bridge.",
            };
          return {
            id: client.id,
            name: client.name,
            status: "installed",
            detail:
              "Installed for your user account. Reload MCP or restart the provider to pick up changes.",
          };
        } catch (error) {
          return {
            id: original.id,
            name: original.name,
            status: "unavailable",
            detail:
              error instanceof McpFileError
                ? error.message
                : "Cannot read this provider's configuration.",
          };
        }
      }),
    );

  const prepareBridge = async () => {
    const source = await fs.readFile(options.bridgeSource, "utf8").catch(() => {
      throw new McpFileError(
        "The MCP bridge is missing. Rebuild or update Cafe Code before installing.",
        "bridge_missing",
      );
    });
    const current = await readMcpFile(bridgePath);
    if (source !== current) await writeMcpFile(bridgePath, source, current);
  };

  const update = async (input: CafeMcpClientUpdate) => {
    const original = clients.find((client) => client.id === input.client);
    if (!original || !isSupported(original))
      throw new McpFileError("This provider is not supported on this platform yet.");
    // Validate every target before writing any of them. A conflict in one
    // Claude surface must not leave the other newly installed by surprise.
    const changes = await Promise.all(
      (await targets(original)).map(async (client) => {
        const current = await readMcpFile(client.filePath);
        return {
          client,
          current,
          next: editMcpClientConfiguration(client, current ?? "", launch, input.operation),
        };
      }),
    );
    const applied: typeof changes = [];
    try {
      for (const change of changes) {
        if (change.next === (change.current ?? "")) continue;
        await writeMcpFile(change.client.filePath, change.next, change.current);
        applied.push(change);
      }
    } catch (error) {
      // Compare-and-replace rollback preserves any newer edit by the provider.
      // If a rollback loses that race, status is re-read from the files and the
      // caller sees a failure rather than a fabricated successful install.
      for (const change of applied.toReversed())
        await writeMcpFile(change.client.filePath, change.current ?? "", change.next).catch(
          () => undefined,
        );
      throw error;
    }
  };

  const bridgeAvailable = async () => {
    if ((await readMcpFile(bridgePath)) === undefined) return false;
    try {
      await fs.access(launch.command);
      return true;
    } catch {
      return false;
    }
  };
  return { connectionPath, launch, list, prepareBridge, update, bridgeAvailable };
}

function managementError(error: unknown): CafeMcpError {
  if (error instanceof CafeMcpError) return error;
  return new CafeMcpError({
    code: error instanceof McpFileError ? error.code : "unavailable",
    message:
      error instanceof McpFileError
        ? error.message
        : "Cafe MCP configuration could not be updated.",
  });
}

export function refreshMcpBridgeCredential(input: {
  readonly connectionPath: string;
  readonly url: string;
  readonly sessions: Pick<SessionCredentialServiceShape, "issue" | "verify" | "revoke">;
  readonly reissueInvalid?: boolean;
}) {
  return Effect.gen(function* () {
    const previous = yield* Effect.tryPromise(() =>
      readMcpFile(input.connectionPath, { private: true, maxBytes: 16 * 1024 }),
    );
    const connection = previous
      ? yield* Effect.tryPromise(() => readBridgeConnection(input.connectionPath)).pipe(
          Effect.option,
        )
      : undefined;
    const existing =
      connection && connection._tag === "Some"
        ? yield* input.sessions.verify(connection.value.token).pipe(Effect.option)
        : undefined;
    const now = yield* DateTime.now;
    const valid =
      existing?._tag === "Some" &&
      existing.value.subject === BRIDGE_SUBJECT &&
      existing.value.role === "owner";
    // Revocation through Cafe's access settings is authoritative. A background
    // refresh must not undo it by minting a replacement owner credential. A
    // deliberate reinstall can repair a revoked or long-expired connection.
    if (previous !== undefined && !valid && !input.reissueInvalid) {
      return yield* new CafeMcpError({
        code: "not_authorized",
        message: "The local MCP credential needs repair. Reinstall from Settings → MCP.",
      });
    }
    if (
      existing?._tag === "Some" &&
      existing.value.subject === BRIDGE_SUBJECT &&
      existing.value.expiresAt &&
      DateTime.toEpochMillis(existing.value.expiresAt) >
        DateTime.toEpochMillis(now) + RENEWAL_WINDOW_MS
    ) {
      yield* Effect.tryPromise(() =>
        writeMcpFile(
          input.connectionPath,
          JSON.stringify({ url: input.url, token: existing.value.token }),
          previous,
        ),
      );
      return;
    }
    const issued = yield* input.sessions.issue({
      subject: BRIDGE_SUBJECT,
      role: "owner",
      method: "bearer-session-token",
      ttl: Duration.days(30),
      client: { deviceType: "desktop", label: "Cafe MCP (local providers)" },
    });
    yield* Effect.tryPromise(() =>
      writeMcpFile(
        input.connectionPath,
        JSON.stringify({ url: input.url, token: issued.token }),
        previous,
      ),
    ).pipe(Effect.onError(() => input.sessions.revoke(issued.sessionId).pipe(Effect.ignore)));
    // Leave the previous, expiring credential valid for requests already in
    // flight. New calls read the replacement file. Tokens expire in the auth
    // ledger normally; no immortal token or renderer-owned renewal is used.
  }).pipe(Effect.mapError(managementError));
}

export const makeMcpManagement = (installationOptions?: McpInstallationOptions) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const settings = yield* ServerSettingsService;
    const sessions = yield* SessionCredentialService;
    const lock = yield* Semaphore.make(1);
    const scope = yield* Effect.scope;
    const files = makeMcpInstallationFiles(
      installationOptions ?? {
        stateDir: config.stateDir,
        home: os.homedir(),
        env: process.env,
        executable: process.execPath,
        // The bundled server and standalone bridge are siblings. In source mode
        // the bridge is produced by the normal server build; no runtime compiler.
        bridgeSource: fileURLToPath(
          new URL(
            import.meta.url.endsWith(".ts") ? "../../dist/mcp-bridge.mjs" : "./mcp-bridge.mjs",
            import.meta.url,
          ),
        ),
        platform: process.platform,
      },
    );

    const refresh = (reissueInvalid = false) =>
      refreshMcpBridgeCredential({
        connectionPath: files.connectionPath,
        url: `http://127.0.0.1:${config.port}/mcp`,
        sessions,
        reissueInvalid,
      });
    const refreshIfInstalled = Effect.gen(function* () {
      if (config.mode !== "desktop") return;
      const existing = yield* Effect.tryPromise(() =>
        readMcpFile(files.connectionPath, { private: true, maxBytes: 16 * 1024 }),
      );
      if (existing === undefined) return;
      yield* Effect.tryPromise(files.prepareBridge);
      yield* refresh();
    }).pipe(
      Effect.uninterruptible,
      lock.withPermits(1),
      Effect.catch(() =>
        Effect.logWarning("Cafe MCP bridge refresh failed; repair it in Settings > MCP."),
      ),
    );

    // One scope per backend, never one per WebSocket or settings-page mount.
    // Initial publication updates the address after a backend port change. Daily
    // refresh keeps multi-day provider runs alive without a browser being open.
    yield* refreshIfInstalled;
    if (config.mode === "desktop")
      yield* Effect.forever(
        Effect.sleep(REFRESH_INTERVAL).pipe(Effect.andThen(refreshIfInstalled)),
      ).pipe(Effect.forkScoped);

    return McpManagement.of({
      status: (access) =>
        Effect.gen(function* () {
          const enabled = (yield* settings.getSettings).mcpEnabled;
          const bridgeReady = yield* Effect.gen(function* () {
            if (!(yield* Effect.tryPromise(files.bridgeAvailable))) return false;
            const connection = yield* Effect.tryPromise(() =>
              readBridgeConnection(files.connectionPath),
            );
            const verified = yield* sessions.verify(connection.token);
            return (
              verified.role === "owner" &&
              verified.subject === BRIDGE_SUBJECT &&
              connection.url === `http://127.0.0.1:${config.port}/mcp`
            );
          }).pipe(Effect.orElseSucceed(() => false));
          const clients = access.canInstall ? yield* Effect.tryPromise(files.list) : [];
          return { enabled, ...access, bridgeReady, clients };
        }).pipe(Effect.mapError(managementError)),
      updateClient: (input) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            // Once admitted, configuration writes belong to this backend scope.
            // Closing the requesting WebSocket must neither cancel half an install
            // nor release the lock while a non-cancellable filesystem write drains.
            const worker = yield* Effect.gen(function* () {
              if (config.mode !== "desktop")
                return yield* new CafeMcpError({
                  code: "not_authorized",
                  message: "Install Cafe MCP from the local desktop app.",
                });
              if (input.operation === "install") {
                yield* Effect.tryPromise(files.prepareBridge);
                yield* refresh(true);
              }
              yield* Effect.tryPromise(() => files.update(input));
            }).pipe(
              Effect.uninterruptible,
              lock.withPermits(1),
              Effect.mapError(managementError),
              Effect.forkIn(scope),
            );
            return yield* restore(Fiber.join(worker));
          }),
        ),
    });
  });

export const McpManagementLive = Layer.effect(McpManagement, makeMcpManagement());
