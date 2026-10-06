import type { ProviderInstanceId, ThreadId } from "@cafecode/contracts";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export interface CodexHistorySafetyKey {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly nativeThreadId: string;
}

/** No underlying SQL error, identity or payload may escape this boundary. */
export class CodexHistorySafetyStorageError extends Data.TaggedError(
  "CodexHistorySafetyStorageError",
)<{ readonly operation: "read" | "mark" }> {}

export interface CodexHistorySafetyStore {
  readonly isBlocked: (
    key: CodexHistorySafetyKey,
  ) => Effect.Effect<boolean, CodexHistorySafetyStorageError>;
  readonly markBlocked: (
    key: CodexHistorySafetyKey,
  ) => Effect.Effect<void, CodexHistorySafetyStorageError>;
}

const REASON = "codex_history_tool_arguments_too_large";
const validKey = (key: CodexHistorySafetyKey): boolean =>
  [key.threadId, key.providerInstanceId, key.nativeThreadId].every(
    (value) => value.length > 0 && value.length <= 512 && !value.includes("\0"),
  );

/**
 * Capture the production-owned SQL client, not a profile or provider process.
 * Every access uses the entire immutable tuple; no prefix matching, account
 * fallback or in-memory-only negative cache can authorize reuse after restart.
 * There is deliberately no reset API: continuing uses a fresh native context.
 */
export const makeCodexHistorySafetyStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return {
    isBlocked: (key) =>
      Effect.gen(function* () {
        if (!validKey(key))
          return yield* Effect.fail(new CodexHistorySafetyStorageError({ operation: "read" }));
        const rows = yield* sql`
          SELECT EXISTS (
            SELECT 1 FROM hard_deleted_threads WHERE thread_id = ${key.threadId}
          ) AS retired, (
            SELECT reason FROM provider_codex_history_safety
            WHERE thread_id = ${key.threadId}
              AND provider_instance_id = ${key.providerInstanceId}
              AND native_thread_id = ${key.nativeThreadId}
          ) AS reason
        `;
        if (rows.length !== 1 || rows[0]?.retired !== 0)
          return yield* Effect.fail(new CodexHistorySafetyStorageError({ operation: "read" }));
        if (rows[0].reason === null) return false;
        // A corrupt/unrecognized stored reason is not proof that reuse is safe.
        if (rows[0].reason !== REASON)
          return yield* Effect.fail(new CodexHistorySafetyStorageError({ operation: "read" }));
        return true;
      }).pipe(Effect.mapError(() => new CodexHistorySafetyStorageError({ operation: "read" }))),
    markBlocked: (key) =>
      Effect.gen(function* () {
        if (!validKey(key))
          return yield* Effect.fail(new CodexHistorySafetyStorageError({ operation: "mark" }));
        const reportedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
        // Concurrent notifications retain the first observation. A later event
        // cannot clear the fence or replace the identity/reason/timestamp.
        yield* sql`
          INSERT INTO provider_codex_history_safety
            (thread_id, provider_instance_id, native_thread_id, reason, reported_at)
          VALUES (${key.threadId}, ${key.providerInstanceId}, ${key.nativeThreadId}, ${REASON}, ${reportedAt})
          ON CONFLICT (thread_id, provider_instance_id, native_thread_id) DO NOTHING
        `;
      }).pipe(Effect.mapError(() => new CodexHistorySafetyStorageError({ operation: "mark" }))),
  } satisfies CodexHistorySafetyStore;
});
