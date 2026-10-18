import { GlideError } from "@cafecode/contracts";
import { z } from "zod";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const unavailable = () =>
  new GlideError({ message: "Glide permissions are unavailable for this chat." });
const appsSchema = z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.-]{1,254}$/)).max(16);
export const makeGlidePolicyStore = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return {
    initialize: (threadId: string) =>
      Effect.gen(function* () {
        // First-send bootstrap may be retried. An explicit setting already saved
        // for this exact chat always wins, including a later switch-off.
        yield* sql`INSERT INTO glide_thread_preferences (thread_id,enabled,apps_json,desktop)
        SELECT ${threadId},1,'[]',1
        WHERE EXISTS(SELECT 1 FROM projection_threads WHERE thread_id=${threadId}
          AND deleted_at IS NULL AND runtime_mode='full-access')
        AND NOT EXISTS(SELECT 1 FROM hard_deleted_threads WHERE thread_id=${threadId})
        ON CONFLICT(thread_id) DO NOTHING`;
        const rows = yield* sql`SELECT thread_id FROM projection_threads WHERE thread_id=${threadId}
        AND deleted_at IS NULL AND runtime_mode='full-access'
        AND NOT EXISTS(SELECT 1 FROM hard_deleted_threads WHERE thread_id=${threadId})`;
        if (rows.length !== 1) return yield* unavailable();
      }),
    read: (threadId: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const threads = yield* sql<{
            runtime_mode: string;
          }>`SELECT runtime_mode FROM projection_threads
        WHERE thread_id = ${threadId} AND deleted_at IS NULL
        AND NOT EXISTS(SELECT 1 FROM hard_deleted_threads WHERE thread_id = ${threadId})`;
          if (threads.length !== 1) return yield* unavailable();
          const rows = yield* sql<{
            enabled: number;
            apps_json: string;
            desktop: number;
          }>`SELECT enabled, apps_json, desktop FROM glide_thread_preferences WHERE thread_id = ${threadId}`;
          const apps = yield* Effect.try({
            try: () => (rows[0] ? appsSchema.parse(JSON.parse(rows[0].apps_json)) : []),
            catch: unavailable,
          });
          return {
            fullAccess: threads[0]!.runtime_mode === "full-access",
            enabled: rows[0]?.enabled === 1,
            desktop: rows[0]?.desktop === 1,
            apps,
          };
        }),
      ),
    write: (
      threadId: string,
      policy: { enabled: boolean; apps: readonly string[]; desktop?: boolean },
    ) =>
      Effect.gen(function* () {
        const apps = yield* Effect.try({
          try: () => appsSchema.parse(policy.apps),
          catch: unavailable,
        });
        // Admission and publication are one SQLite writer statement. A previous
        // read cannot authorize a grant after deletion or an access downgrade.
        const rows = yield* sql<{
          thread_id: string;
        }>`INSERT INTO glide_thread_preferences (thread_id,enabled,apps_json,desktop)
        SELECT ${threadId},${policy.enabled ? 1 : 0},${JSON.stringify(apps)},${policy.enabled && policy.desktop === true ? 1 : 0}
        WHERE EXISTS(SELECT 1 FROM projection_threads WHERE thread_id = ${threadId} AND deleted_at IS NULL
          AND (${policy.enabled ? 1 : 0} = 0 OR runtime_mode = 'full-access'))
        AND NOT EXISTS(SELECT 1 FROM hard_deleted_threads WHERE thread_id = ${threadId})
        ON CONFLICT(thread_id) DO UPDATE SET enabled=excluded.enabled,apps_json=excluded.apps_json,desktop=excluded.desktop RETURNING thread_id`;
        if (rows.length !== 1) return yield* unavailable();
      }),
  };
});
