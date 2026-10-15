// @effect-diagnostics nodeBuiltinImport:off
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { ProviderInstanceId, ThreadId, type ProviderDaemonClientConfig } from "@cafecode/contracts";
import {
  GeneratedVisualizationNativeWitness,
  VisualizationApiError,
  type VisualizationTimelineEntry,
} from "@cafecode/contracts/visualizationApi";
import { VisualizationGenerationId } from "@cafecode/contracts/visualizations";
import { requestProviderDaemonJson } from "@cafecode/shared/providerDaemonHttp";
import { readVisualizationHost } from "@cafecode/shared/visualizationHostClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { ServerConfig } from "../config.ts";
import { makeSessionMcpFiles } from "../mcp/sessionFiles.ts";
import { claimVisualizationCompletion } from "./store.ts";

export const VISUALIZATION_SESSION_DAEMON_PATH = "/visualizations/session/authorize";
const tokenSchema = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));
const strict = { parseOptions: { onExcessProperty: "error" as const } };
export const VisualizationSessionAuthorizationRequest = Schema.Struct({
  token: tokenSchema,
}).annotate(strict);
export const VisualizationSessionAuthority = Schema.Struct({
  threadId: ThreadId,
  providerInstanceId: ProviderInstanceId,
  sessionGeneration: VisualizationGenerationId,
  runtimeGeneration: VisualizationGenerationId,
  tokenDigest: tokenSchema,
  serverName: Schema.String.check(Schema.isPattern(/^cafe-visualizations-[A-Za-z0-9_-]{22}$/)),
}).annotate(strict);
export type VisualizationSessionAuthority = typeof VisualizationSessionAuthority.Type;
export const visualizationDenied = () =>
  new VisualizationApiError({ message: "Visualization is unavailable or this session expired." });
const digest = (token: string) =>
  createHash("sha256").update("cafe-visual-session-v1\0").update(token).digest("hex");
const validToken = Schema.is(tokenSchema);
const decodeAuthority = Schema.decodeUnknownResult(VisualizationSessionAuthority);
const decodeWitness = Schema.decodeUnknownResult(GeneratedVisualizationNativeWitness);

export interface VisualizationSessionBinding {
  readonly name: string;
  readonly authority: VisualizationSessionAuthority;
  readonly launch: {
    readonly command: string;
    readonly args: readonly string[];
    readonly env: Readonly<Record<string, string>>;
  };
  readonly activate: () => Promise<void>;
  readonly dispose: () => Promise<void>;
  /** Internal native observer only. This method is never an HTTP/RPC/tool route. */
  readonly claimNativeCompletion: (
    witness: GeneratedVisualizationNativeWitness,
    proof: string,
  ) => Promise<VisualizationTimelineEntry | undefined>;
}
export interface VisualizationSessionBroker {
  readonly bind: (input: {
    readonly threadId: ThreadId;
    readonly providerInstanceId: ProviderInstanceId;
    readonly provider: "codex" | "claudeAgent" | "grok";
  }) => Promise<VisualizationSessionBinding | undefined>;
}
export interface VisualizationSessionRuntime extends VisualizationSessionBroker {
  readonly authorize: (token: string) => Promise<VisualizationSessionAuthority>;
  readonly close: () => Promise<void>;
}
let broker: VisualizationSessionBroker | undefined;
let authorizeInOwner: VisualizationSessionRuntime["authorize"] | undefined;
export const readVisualizationSessionBroker = () => broker;
export function installVisualizationSessionRuntime(runtime: VisualizationSessionRuntime) {
  broker = runtime;
  authorizeInOwner = runtime.authorize;
  return () => {
    if (broker === runtime) broker = undefined;
    if (authorizeInOwner === runtime.authorize) authorizeInOwner = undefined;
  };
}

/** Acquire the writer reservation inside the same transaction as the mutation.
 * Backend preauthentication and a surviving token never replace this check. */
export const requireVisualizationSessionAuthority = (
  sql: SqlClient.SqlClient,
  authority: VisualizationSessionAuthority,
) =>
  Effect.gen(function* () {
    const rows = yield* sql`UPDATE visualization_session_capabilities SET active = active
    WHERE thread_id = ${authority.threadId} AND provider_instance_id = ${authority.providerInstanceId}
      AND session_generation = ${authority.sessionGeneration} AND runtime_generation = ${authority.runtimeGeneration}
      AND token_digest = ${authority.tokenDigest} AND server_name = ${authority.serverName} AND active = 1
      AND runtime_generation = (SELECT generation FROM visualization_session_runtime WHERE singleton = 1)
      AND NOT EXISTS(SELECT 1 FROM hard_deleted_threads WHERE thread_id = ${authority.threadId})
    RETURNING thread_id`;
    if (rows.length !== 1) return yield* visualizationDenied();
  }).pipe(Effect.mapError(() => visualizationDenied()));

/** The detached native owner mints generations. UI/backend reconnects never
 * install a competitor or invalidate the surviving owner's capabilities. */
export const makeVisualizationSessionRuntime = (options: {
  readonly bridgeSource: string;
  readonly mcpPort: number;
  readonly executable?: string;
  readonly available?: () => Promise<boolean>;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const runtimeGeneration = VisualizationGenerationId.make(randomUUID());
    const lock = yield* Semaphore.make(1);
    const context = yield* Effect.context<never>();
    const run = Effect.runPromiseWith(context);
    type Candidate = {
      authority: VisualizationSessionAuthority;
      predecessor: string | null;
      files: Awaited<ReturnType<typeof makeSessionMcpFiles>>;
      revoked: boolean;
      disposed: boolean;
      active: boolean;
    };
    const candidates = new Map<string, Candidate>();
    let closed = false;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`INSERT INTO visualization_session_runtime(singleton,generation) VALUES(1,${runtimeGeneration})
      ON CONFLICT(singleton) DO UPDATE SET generation = excluded.generation`;
        yield* sql`DELETE FROM visualization_session_capabilities`;
      }),
    );
    const currentOwner = Effect.gen(function* () {
      const rows = yield* sql`UPDATE visualization_session_runtime SET generation = generation
      WHERE singleton = 1 AND generation = ${runtimeGeneration} RETURNING generation`;
      if (closed || rows.length !== 1) return yield* visualizationDenied();
    });
    const serialized = <A, E>(effect: Effect.Effect<A, E>) =>
      run(
        effect.pipe(
          lock.withPermits(1),
          Effect.uninterruptible,
          Effect.mapError(() => visualizationDenied()),
        ),
      );
    const dispose = (candidate: Candidate) => {
      candidate.revoked = true;
      return serialized(
        Effect.gen(function* () {
          if (candidate.disposed) return;
          yield* sql`UPDATE visualization_session_capabilities SET active = 0
        WHERE thread_id = ${candidate.authority.threadId} AND session_generation = ${candidate.authority.sessionGeneration}
          AND runtime_generation = ${runtimeGeneration} AND token_digest = ${candidate.authority.tokenDigest}`;
          yield* Effect.tryPromise({
            try: candidate.files.remove,
            catch: () => visualizationDenied(),
          });
          candidate.disposed = true;
          candidates.delete(candidate.authority.tokenDigest);
        }),
      );
    };
    const runtime: VisualizationSessionRuntime = {
      bind: (input) =>
        serialized(
          Effect.gen(function* () {
            if (input.provider === "grok") return undefined;
            if (
              options.available &&
              !(yield* Effect.tryPromise({
                try: options.available,
                catch: () => visualizationDenied(),
              }))
            )
              return undefined;
            if (candidates.size >= 128 || !["codex", "claudeAgent"].includes(input.provider))
              return yield* visualizationDenied();
            const predecessor = yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* currentOwner;
                const retired =
                  yield* sql`SELECT 1 FROM hard_deleted_threads WHERE thread_id = ${input.threadId}`;
                if (retired.length) return yield* visualizationDenied();
                const previous = yield* sql<{
                  session_generation: string;
                }>`SELECT session_generation FROM visualization_session_capabilities WHERE thread_id = ${input.threadId}`;
                return previous[0]?.session_generation ?? null;
              }),
            );
            const token = randomBytes(32).toString("hex");
            const sessionGeneration = VisualizationGenerationId.make(randomUUID());
            const serverName = `cafe-visualizations-${Buffer.from(sessionGeneration.replaceAll("-", ""), "hex").toString("base64url")}`;
            const authority: VisualizationSessionAuthority = {
              threadId: input.threadId,
              providerInstanceId: input.providerInstanceId,
              sessionGeneration,
              runtimeGeneration,
              tokenDigest: digest(token),
              serverName,
            };
            const files = yield* Effect.tryPromise({
              try: () =>
                makeSessionMcpFiles({
                  bridgeSource: options.bridgeSource,
                  port: options.mcpPort,
                  token,
                  audience: "cafe-visualizations",
                }),
              catch: () => visualizationDenied(),
            });
            yield* sql
              .withTransaction(currentOwner)
              .pipe(Effect.onError(() => Effect.promise(files.remove).pipe(Effect.ignore)));
            const candidate: Candidate = {
              authority,
              predecessor,
              files,
              revoked: false,
              disposed: false,
              active: false,
            };
            candidates.set(authority.tokenDigest, candidate);
            return {
              name: serverName,
              authority,
              launch: {
                command: options.executable ?? process.execPath,
                args: [files.bridgePath, files.connectionPath],
                env: { ELECTRON_RUN_AS_NODE: "1" },
              },
              activate: () =>
                serialized(
                  Effect.gen(function* () {
                    if (candidate.revoked || candidate.disposed)
                      return yield* visualizationDenied();
                    yield* sql.withTransaction(
                      Effect.gen(function* () {
                        yield* currentOwner;
                        if (candidate.active)
                          return yield* requireVisualizationSessionAuthority(sql, authority);
                        const previous = yield* sql<{
                          session_generation: string;
                        }>`SELECT session_generation FROM visualization_session_capabilities WHERE thread_id = ${input.threadId}`;
                        if ((previous[0]?.session_generation ?? null) !== predecessor)
                          return yield* visualizationDenied();
                        const retired =
                          yield* sql`SELECT 1 FROM hard_deleted_threads WHERE thread_id = ${input.threadId}`;
                        if (retired.length || candidate.revoked)
                          return yield* visualizationDenied();
                        yield* sql`INSERT INTO visualization_session_capabilities(thread_id,provider_instance_id,session_generation,runtime_generation,token_digest,server_name,active)
              VALUES(${authority.threadId},${authority.providerInstanceId},${sessionGeneration},${runtimeGeneration},${authority.tokenDigest},${serverName},1)
              ON CONFLICT(thread_id) DO UPDATE SET provider_instance_id=excluded.provider_instance_id,
                session_generation=excluded.session_generation,runtime_generation=excluded.runtime_generation,
                token_digest=excluded.token_digest,server_name=excluded.server_name,active=1`;
                      }),
                    );
                    candidate.active = true;
                    for (const other of candidates.values())
                      if (other !== candidate && other.authority.threadId === input.threadId)
                        other.revoked = true;
                  }),
                ),
              dispose: () => dispose(candidate),
              claimNativeCompletion: async (witness, proof) => {
                const admitted = decodeWitness(witness);
                if (
                  candidate.revoked ||
                  !candidate.active ||
                  candidate.disposed ||
                  Result.isFailure(admitted) ||
                  !validToken(proof) ||
                  admitted.success.provider !== input.provider
                )
                  return undefined;
                return run(
                  claimVisualizationCompletion(sql, authority, admitted.success, proof).pipe(
                    Effect.catch(() => Effect.succeed(undefined)),
                  ),
                );
              },
            } satisfies VisualizationSessionBinding;
          }),
        ),
      authorize: (token) =>
        serialized(
          Effect.gen(function* () {
            if (!validToken(token)) return yield* visualizationDenied();
            const candidate = candidates.get(digest(token));
            if (!candidate || candidate.revoked || candidate.disposed)
              return yield* visualizationDenied();
            yield* currentOwner;
            return candidate.authority;
          }),
        ),
      close: () => {
        closed = true;
        for (const candidate of candidates.values()) candidate.revoked = true;
        return serialized(
          Effect.gen(function* () {
            yield* sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`DELETE FROM visualization_session_capabilities WHERE runtime_generation = ${runtimeGeneration}`;
                yield* sql`DELETE FROM visualization_session_runtime WHERE singleton = 1 AND generation = ${runtimeGeneration}`;
              }),
            );
            const results = yield* Effect.promise(() =>
              Promise.allSettled(
                [...candidates.values()].map((candidate) => candidate.files.remove()),
              ),
            );
            if (results.some((result) => result.status === "rejected"))
              return yield* visualizationDenied();
            candidates.clear();
          }),
        );
      },
    };
    return runtime;
  });

export async function dispatchVisualizationSessionAuthorization(
  token: string,
): Promise<VisualizationSessionAuthority> {
  if (!validToken(token) || !authorizeInOwner) throw visualizationDenied();
  return authorizeInOwner(token);
}
const remoteAuthorize = async (
  endpoint: ProviderDaemonClientConfig,
  token: string,
  signal?: AbortSignal,
) => {
  if (!validToken(token)) throw visualizationDenied();
  const response = await requestProviderDaemonJson(endpoint, VISUALIZATION_SESSION_DAEMON_PATH, {
    method: "POST",
    body: JSON.stringify({ token }),
    timeoutMs: 10_000,
    maxResponseBytes: 16 * 1024,
    ...(signal ? { signal } : {}),
  });
  if (response.statusCode !== 200) throw visualizationDenied();
  const decoded = decodeAuthority(JSON.parse(response.body));
  if (Result.isFailure(decoded)) throw visualizationDenied();
  return decoded.success;
};
export const makeVisualizationSessionService = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const endpoint = config.providerDaemon ?? config.providerSupervisor;
  return {
    authorize: (token: string) =>
      Effect.tryPromise({
        try: (signal) =>
          endpoint
            ? remoteAuthorize(endpoint, token, signal)
            : dispatchVisualizationSessionAuthorization(token),
        catch: () => visualizationDenied(),
      }),
  };
});
export const VisualizationSessionRuntimeLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    if (config.providerDaemon) return;
    if (config.providerSupervisor) {
      const forward = (token: string) => remoteAuthorize(config.providerSupervisor!, token);
      authorizeInOwner = forward;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (authorizeInOwner === forward) authorizeInOwner = undefined;
        }),
      );
      return;
    }
    const runtime = yield* makeVisualizationSessionRuntime({
      available: () => readVisualizationHost(config.stateDir).then((host) => host !== null),
      mcpPort: config.cafeMcpPort ?? config.port,
      executable:
        process.platform === "linux" && process.env.APPIMAGE
          ? process.env.APPIMAGE
          : process.execPath,
      bridgeSource: fileURLToPath(
        new URL(
          import.meta.url.endsWith(".ts")
            ? "../../dist/visualization-mcp-bridge.mjs"
            : "./visualization-mcp-bridge.mjs",
          import.meta.url,
        ),
      ),
    });
    const uninstall = installVisualizationSessionRuntime(runtime);
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        uninstall();
        yield* Effect.tryPromise({ try: runtime.close, catch: () => visualizationDenied() }).pipe(
          Effect.catch(() =>
            Effect.logWarning("Private visualization session cleanup remains incomplete."),
          ),
        );
      }),
    );
  }),
);
