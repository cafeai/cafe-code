// @effect-diagnostics nodeBuiltinImport:off
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { ProviderInstanceId, ThreadId } from "@cafecode/contracts";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { readProviderMcpCredentialIssuer } from "../auth/ProviderMcpCredentialBroker.ts";
import type { SessionCredentialServiceShape } from "../auth/Services/SessionCredentialService.ts";
import { ServerConfig } from "../config.ts";
import { makeSessionMcpFiles } from "./sessionFiles.ts";

export class McpSessionError extends Data.TaggedError("McpSessionError")<{
  readonly message: string;
}> {}
const unavailable = () =>
  new McpSessionError({ message: "Cafe management tools are unavailable." });

export interface ManagementMcpBinding {
  readonly name: string;
  readonly launch: {
    readonly command: string;
    readonly args: readonly string[];
    readonly env: Readonly<Record<string, string>>;
  };
  readonly dispose: Effect.Effect<void>;
}

/** The same owner authority as Grok's existing launch-time management MCP.
 * This is separate from the narrower scheduling and visualization capabilities.
 * A private session connection never edits a provider home or approval policy. */
export const makeManagementMcpSession = (input: {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly credentials?: Pick<SessionCredentialServiceShape, "issue" | "revoke" | "verify">;
  readonly bridgeSource?: string;
  readonly port?: number;
  readonly executable?: string;
}) =>
  Effect.gen(function* () {
    const credentials = input.credentials ?? readProviderMcpCredentialIssuer();
    // Registry-only/metadata runtimes do not install the owner auth broker.
    if (!credentials) return undefined;
    const config = yield* ServerConfig;
    const scope = yield* Scope.make();
    const subject = `provider:cafe-management:${randomUUID()}`;
    const issuedIds = new Set<Parameters<typeof credentials.revoke>[0]>();
    const issue = credentials
      .issue({
        subject,
        role: "owner",
        method: "bearer-session-token",
        ttl: Duration.days(30),
        client: {
          label: "Cafe management tools",
          deviceType: "bot",
          userAgent: "cafe-code-session-mcp",
        },
      })
      .pipe(
        Effect.tap((session) =>
          Effect.sync(() => {
            issuedIds.add(session.sessionId);
          }),
        ),
      );
    yield* Scope.addFinalizer(
      scope,
      Effect.suspend(() =>
        Effect.forEach([...issuedIds], (id) => credentials.revoke(id).pipe(Effect.ignore), {
          discard: true,
        }),
      ),
    );
    const result = yield* Effect.gen(function* () {
      let credential = yield* issue;
      const files = yield* Effect.tryPromise({
        try: () =>
          makeSessionMcpFiles({
            bridgeSource:
              input.bridgeSource ??
              fileURLToPath(
                new URL(
                  import.meta.url.endsWith(".ts")
                    ? "../../dist/mcp-bridge.mjs"
                    : "./mcp-bridge.mjs",
                  import.meta.url,
                ),
              ),
            port: input.port ?? config.cafeMcpPort ?? config.port,
            token: credential.token,
            audience: "cafe-code",
          }),
        catch: unavailable,
      });
      yield* Scope.addFinalizer(
        scope,
        Effect.tryPromise({ try: files.remove, catch: unavailable }).pipe(
          Effect.catch(() =>
            Effect.logWarning("Private management MCP cleanup remains incomplete."),
          ),
        ),
      );
      // Revocation is authoritative: an invalid credential is never repaired by
      // this background task. New calls read the atomically replaced private file.
      const refresh = Effect.gen(function* () {
        const verified = yield* credentials.verify(credential.token);
        if (verified.subject !== subject || verified.role !== "owner") return yield* unavailable();
        const now = yield* DateTime.now;
        if (
          DateTime.toEpochMillis(credential.expiresAt) - DateTime.toEpochMillis(now) >
          7 * 86400_000
        )
          return;
        const next = yield* issue;
        yield* Effect.tryPromise({
          try: () => files.replaceToken(next.token),
          catch: unavailable,
        }).pipe(Effect.onError(() => credentials.revoke(next.sessionId).pipe(Effect.ignore)));
        credential = next;
      }).pipe(
        Effect.catch(() => Effect.logWarning("Management MCP credential refresh is unavailable.")),
      );
      yield* Effect.forever(Effect.sleep("1 day").pipe(Effect.andThen(refresh))).pipe(
        Effect.forkIn(scope),
      );
      return {
        // Random names prevent config-table merging with a user/project server.
        name: `cafe-code-${randomUUID().replaceAll("-", "").slice(0, 16)}`,
        launch: {
          command:
            input.executable ??
            (process.platform === "linux" && process.env.APPIMAGE
              ? process.env.APPIMAGE
              : process.execPath),
          args: [files.bridgePath, files.connectionPath],
          env: { ELECTRON_RUN_AS_NODE: "1" },
        },
        // Revoke before touching files; a changed namespace cannot retain authority.
        dispose: Effect.gen(function* () {
          yield* Effect.forEach(
            [...issuedIds],
            (id) => credentials.revoke(id).pipe(Effect.ignore),
            { discard: true },
          );
          yield* Scope.close(scope, Exit.void);
        }),
      } satisfies ManagementMcpBinding;
    }).pipe(
      Effect.onError(() => Scope.close(scope, Exit.void)),
      Effect.mapError(unavailable),
    );
    return result;
  }).pipe(Effect.uninterruptible);
