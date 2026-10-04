// @effect-diagnostics nodeBuiltinImport:off
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  ProviderInstanceId,
  ScheduledFollowupError,
  ThreadId,
  type ProviderDaemonClientConfig,
} from "@cafecode/contracts";
import { requestProviderDaemonJson } from "@cafecode/shared/providerDaemonHttp";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerConfig } from "../config.ts";
import { makeSchedulingSessionFiles, type SchedulingSessionFiles } from "./sessionFiles.ts";

export const SCHEDULING_SESSION_DAEMON_PATH = "/scheduling/session/authorize";
const tokenPattern = /^[a-f0-9]{64}$/;
export const SchedulingSessionAuthorizationRequest = Schema.Struct({
  token: Schema.String.check(Schema.isPattern(tokenPattern)),
});
const denied = () =>
  new ScheduledFollowupError({
    message: "This scheduling session expired. Resume the Cafe chat to reconnect.",
  });
const digest = (token: string) =>
  createHash("sha256").update("cafe-scheduling-v1\0").update(token).digest("hex");

/** Only these claims cross the internal daemon boundary. The raw capability is
 * neither a general Cafe owner credential nor authority for a model-picked ID. */
export const SchedulingSessionAuthority = Schema.Struct({
  threadId: ThreadId,
  providerInstanceId: ProviderInstanceId,
  sessionGeneration: Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/)),
  tokenDigest: Schema.String.check(Schema.isPattern(tokenPattern)),
});
export type SchedulingSessionAuthority = typeof SchedulingSessionAuthority.Type;

export interface SchedulingSessionBinding {
  readonly name: string;
  readonly launch: {
    readonly command: string;
    readonly args: readonly string[];
    readonly env: Readonly<Record<string, string>>;
  };
  /** Startup permits protocol/catalog discovery only. Activate after the new
   * runtime wins ownership, before giving it a user prompt. */
  readonly activate: () => Promise<void>;
  readonly dispose: () => Promise<void>;
}
export interface SchedulingSessionBroker {
  readonly bind: (input: {
    readonly threadId: ThreadId;
    readonly providerInstanceId: ProviderInstanceId;
    readonly provider: "codex" | "claudeAgent" | "grok";
  }) => Promise<SchedulingSessionBinding>;
}
let broker: SchedulingSessionBroker | undefined;
export const readSchedulingSessionBroker = () => broker;
export function installSchedulingSessionBroker(value: SchedulingSessionBroker) {
  broker = value;
  return () => {
    if (broker === value) broker = undefined;
  };
}

/** Call INSIDE the same SQL transaction as the proposed read/write. A no-op
 * UPDATE obtains SQLite's write reservation before checking the exact active
 * generation, so retirement/account replacement cannot race past admission.
 * Authentication in a previous HTTP/RPC step alone never authorizes a mutation. */
export function requireSchedulingSessionAuthority(
  sql: SqlClient.SqlClient,
  authority: SchedulingSessionAuthority,
) {
  return Effect.gen(function* () {
    const rows = yield* sql<{ session_generation: string }>`UPDATE scheduling_session_capabilities
      SET active = active
      WHERE thread_id = ${authority.threadId} AND provider_instance_id = ${authority.providerInstanceId}
        AND session_generation = ${authority.sessionGeneration} AND token_digest = ${authority.tokenDigest}
        AND active = 1 AND runtime_generation = (SELECT generation FROM scheduling_session_runtime WHERE singleton = 1)
        AND NOT EXISTS (SELECT 1 FROM hard_deleted_threads WHERE thread_id = ${authority.threadId})
      RETURNING session_generation`;
    if (rows.length !== 1) return yield* denied();
  }).pipe(Effect.mapError(() => denied()));
}

interface RuntimeBinding {
  readonly authority: SchedulingSessionAuthority;
  readonly previousGeneration: string | null;
  readonly provider: "codex" | "claudeAgent" | "grok";
  readonly files: SchedulingSessionFiles;
  active: boolean;
  revoked: boolean;
  disposed: boolean;
}
export interface SchedulingSessionRuntime extends SchedulingSessionBroker {
  readonly authorize: (token: string) => Promise<SchedulingSessionAuthority>;
  readonly close: () => Promise<void>;
}

/** Injectable asset/port options keep qualification entirely in synthetic
 * temporary directories and in-memory SQLite, without reading provider homes. */
export const makeSchedulingSessionRuntime = (options: {
  readonly bridgeSource: string;
  readonly mcpPort: number;
  readonly executable?: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const runtimeGeneration = randomUUID();
    const lock = yield* Semaphore.make(1);
    const context = yield* Effect.context<never>();
    const run = Effect.runPromiseWith(context);
    const bindings = new Map<string, RuntimeBinding>();
    let closed = false;
    let closeComplete = false;
    // Only the actual provider owner installs this layer. Restart invalidates all
    // older durable grants, even if a crash left private connection files behind.
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`INSERT INTO scheduling_session_runtime (singleton,generation) VALUES (1,${runtimeGeneration})
      ON CONFLICT(singleton) DO UPDATE SET generation = excluded.generation`;
        yield* sql`DELETE FROM scheduling_session_capabilities`;
      }),
    );
    const requireOwner = Effect.gen(function* () {
      const rows = yield* sql<{
        generation: string;
      }>`UPDATE scheduling_session_runtime SET generation = generation
      WHERE singleton = 1 AND generation = ${runtimeGeneration} RETURNING generation`;
      if (closed || rows.length !== 1) return yield* denied();
    });
    const serialized = <A, E>(effect: Effect.Effect<A, E>) =>
      run(
        effect.pipe(
          lock.withPermits(1),
          Effect.uninterruptible,
          Effect.mapError(() => denied()),
        ),
      );
    const dispose = (binding: RuntimeBinding) => {
      // Stop fresh admission synchronously even if a preceding SQL operation or
      // cleanup still holds the serialization permit.
      binding.revoked = true;
      return serialized(
        Effect.gen(function* () {
          if (binding.disposed) return;
          binding.revoked = true;
          // Retain the generation as a compare-and-swap tombstone. Grok stages a new
          // candidate before retiring its old session; retirement must not make the
          // candidate's captured predecessor disappear or allow a stale candidate.
          yield* sql`UPDATE scheduling_session_capabilities SET active = 0
      WHERE thread_id = ${binding.authority.threadId} AND session_generation = ${binding.authority.sessionGeneration}
        AND token_digest = ${binding.authority.tokenDigest} AND runtime_generation = ${runtimeGeneration}`;
          yield* Effect.tryPromise({ try: binding.files.remove, catch: () => denied() });
          binding.disposed = true;
          bindings.delete(binding.authority.tokenDigest);
        }),
      );
    };
    const runtime: SchedulingSessionRuntime = {
      bind: (input) =>
        serialized(
          Effect.gen(function* () {
            const provider =
              input.provider === "codex"
                ? "codex"
                : input.provider === "claudeAgent"
                  ? "claudeAgent"
                  : input.provider === "grok"
                    ? "grok"
                    : undefined;
            if (!provider) return yield* denied();
            const previous = yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* requireOwner;
                const deleted =
                  yield* sql`SELECT 1 FROM hard_deleted_threads WHERE thread_id = ${input.threadId}`;
                if (deleted.length) return yield* denied();
                const rows = yield* sql<{
                  session_generation: string;
                }>`SELECT session_generation FROM scheduling_session_capabilities WHERE thread_id = ${input.threadId}`;
                return rows[0]?.session_generation ?? null;
              }),
            );
            const token = randomBytes(32).toString("hex");
            const sessionGeneration = randomUUID();
            const authority: SchedulingSessionAuthority = {
              threadId: input.threadId,
              providerInstanceId: input.providerInstanceId,
              sessionGeneration,
              tokenDigest: digest(token),
            };
            const files = yield* Effect.tryPromise({
              try: () =>
                makeSchedulingSessionFiles({
                  bridgeSource: options.bridgeSource,
                  port: options.mcpPort,
                  token,
                }),
              catch: () => denied(),
            });
            yield* sql
              .withTransaction(requireOwner)
              .pipe(
                Effect.onError(() =>
                  Effect.tryPromise({ try: files.remove, catch: () => denied() }).pipe(
                    Effect.ignore,
                  ),
                ),
              );
            const binding: RuntimeBinding = {
              authority,
              previousGeneration: previous,
              provider,
              files,
              active: false,
              revoked: false,
              disposed: false,
            };
            bindings.set(authority.tokenDigest, binding);
            return {
              // A private random name prevents user/project TOML tables from being
              // deep-merged into this transport. Keep the complete tool name bounded.
              name: `cafe-${Buffer.from(sessionGeneration.replaceAll("-", ""), "hex").toString("base64url")}`,
              launch: {
                command: options.executable ?? process.execPath,
                args: [files.bridgePath, files.connectionPath],
                env: { ELECTRON_RUN_AS_NODE: "1" },
              },
              activate: () =>
                serialized(
                  Effect.gen(function* () {
                    if (binding.revoked || binding.disposed) return yield* denied();
                    yield* sql.withTransaction(
                      Effect.gen(function* () {
                        yield* requireOwner;
                        if (binding.active)
                          return yield* requireSchedulingSessionAuthority(sql, authority);
                        const rows = yield* sql<{
                          session_generation: string;
                        }>`SELECT session_generation FROM scheduling_session_capabilities WHERE thread_id = ${authority.threadId}`;
                        if ((rows[0]?.session_generation ?? null) !== binding.previousGeneration)
                          return yield* denied();
                        const deleted =
                          yield* sql`SELECT 1 FROM hard_deleted_threads WHERE thread_id = ${authority.threadId}`;
                        if (deleted.length || binding.revoked) return yield* denied();
                        yield* sql`INSERT INTO scheduling_session_capabilities
              (thread_id,provider_instance_id,provider,session_generation,runtime_generation,active,token_digest)
              VALUES (${authority.threadId},${authority.providerInstanceId},${binding.provider},${authority.sessionGeneration},${runtimeGeneration},1,${authority.tokenDigest})
              ON CONFLICT(thread_id) DO UPDATE SET provider_instance_id = excluded.provider_instance_id,
                provider = excluded.provider, session_generation = excluded.session_generation,
                runtime_generation = excluded.runtime_generation, active = 1, token_digest = excluded.token_digest`;
                      }),
                    );
                    binding.active = true;
                    // Revoke older active sessions and competing staged candidates only
                    // after the new generation has successfully committed.
                    for (const candidate of bindings.values())
                      if (
                        candidate !== binding &&
                        candidate.authority.threadId === authority.threadId
                      )
                        candidate.revoked = true;
                  }),
                ),
              dispose: () => dispose(binding),
            } satisfies SchedulingSessionBinding;
          }),
        ),
      authorize: (token) =>
        serialized(
          Effect.gen(function* () {
            if (!tokenPattern.test(token)) return yield* denied();
            const binding = bindings.get(digest(token));
            if (!binding || binding.revoked || binding.disposed) return yield* denied();
            yield* requireOwner;
            if (binding.revoked || binding.disposed) return yield* denied();
            // Pending sessions may initialize/list the protocol catalog. Every real
            // scheduling operation separately checks the active durable generation.
            return { ...binding.authority };
          }),
        ),
      close: () => {
        closed = true;
        for (const binding of bindings.values()) binding.revoked = true;
        return serialized(
          Effect.gen(function* () {
            if (closeComplete) return;
            yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`DELETE FROM scheduling_session_capabilities WHERE runtime_generation = ${runtimeGeneration}`;
                yield* sql`DELETE FROM scheduling_session_runtime WHERE singleton = 1 AND generation = ${runtimeGeneration}`;
              }),
            );
            // Authority is already retired even if a changed namespace prevents safe
            // cleanup. Attempt every exact scope and report only a sanitized failure.
            const retiring = [...bindings.values()];
            const results = yield* Effect.promise(() =>
              Promise.allSettled(retiring.map((binding) => binding.files.remove())),
            );
            results.forEach((result, index) => {
              if (result.status === "fulfilled") {
                const binding = retiring[index]!;
                binding.disposed = true;
                bindings.delete(binding.authority.tokenDigest);
              }
            });
            if (results.some((result) => result.status === "rejected")) return yield* denied();
            closeComplete = true;
          }),
        );
      },
    };
    return runtime;
  }).pipe(Effect.mapError(() => denied()));

let authorizeInProviderRuntime:
  | ((token: string) => Promise<SchedulingSessionAuthority>)
  | undefined;
/** Register both acquisition and verification in the owning process. The
 * identity-checked release makes old-layer finalization safe after replacement. */
export function installSchedulingSessionRuntime(runtime: SchedulingSessionRuntime) {
  const uninstallBroker = installSchedulingSessionBroker(runtime);
  authorizeInProviderRuntime = runtime.authorize;
  return () => {
    uninstallBroker();
    if (authorizeInProviderRuntime === runtime.authorize) authorizeInProviderRuntime = undefined;
  };
}
export async function dispatchSchedulingSessionAuthorization(
  token: string,
): Promise<SchedulingSessionAuthority> {
  if (!tokenPattern.test(token) || !authorizeInProviderRuntime) throw denied();
  return authorizeInProviderRuntime(token);
}
const decodeAuthority = Schema.decodeUnknownSync(SchedulingSessionAuthority);
async function remoteAuthorize(
  endpoint: ProviderDaemonClientConfig,
  token: string,
  signal?: AbortSignal,
) {
  if (!tokenPattern.test(token)) throw denied();
  const response = await requestProviderDaemonJson(endpoint, SCHEDULING_SESSION_DAEMON_PATH, {
    method: "POST",
    body: JSON.stringify({ token }),
    timeoutMs: 10_000,
    maxResponseBytes: 16 * 1024,
    ...(signal ? { signal } : {}),
  });
  if (response.statusCode !== 200) throw denied();
  return decodeAuthority(JSON.parse(response.body));
}
/** Dedicated authenticated RPC, outside the durable command ledger. Capabilities
 * are neither logged as provider events nor replayed after interrupted requests. */
export const makeSchedulingSessionService = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const endpoint = config.providerDaemon ?? config.providerSupervisor;
  return {
    authorize: (token: string) =>
      Effect.tryPromise({
        try: (signal) =>
          endpoint
            ? remoteAuthorize(endpoint, token, signal)
            : dispatchSchedulingSessionAuthorization(token),
        catch: () => denied(),
      }),
  };
});

export const SchedulingSessionRuntimeLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    // The UI/backend must not invalidate the detached provider's grants when a
    // window/backend restarts. A supervising daemon proxies to its actual owner.
    if (config.providerDaemon) return;
    if (config.providerSupervisor) {
      const endpoint = config.providerSupervisor;
      const forward = (token: string) => remoteAuthorize(endpoint, token);
      authorizeInProviderRuntime = forward;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (authorizeInProviderRuntime === forward) authorizeInProviderRuntime = undefined;
        }),
      );
      return;
    }
    const runtime = yield* makeSchedulingSessionRuntime({
      mcpPort: config.cafeMcpPort ?? config.port,
      executable:
        process.platform === "linux" && process.env.APPIMAGE
          ? process.env.APPIMAGE
          : process.execPath,
      bridgeSource: fileURLToPath(
        new URL(
          import.meta.url.endsWith(".ts")
            ? "../../dist/scheduling-mcp-bridge.mjs"
            : "./scheduling-mcp-bridge.mjs",
          import.meta.url,
        ),
      ),
    });
    const uninstall = installSchedulingSessionRuntime(runtime);
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        uninstall();
        yield* Effect.tryPromise({ try: runtime.close, catch: () => denied() }).pipe(
          Effect.catch(() =>
            Effect.logWarning("Private scheduling session cleanup could not finish safely."),
          ),
        );
      }),
    );
  }),
);
