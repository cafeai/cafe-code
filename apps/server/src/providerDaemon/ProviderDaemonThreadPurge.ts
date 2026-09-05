import {
  ProviderDaemonRpcRequest,
  ProviderRuntimeEvent,
  type ProviderDaemonRpcRequest as ProviderDaemonRpcRequestValue,
  type ProviderRuntimeEvent as ProviderRuntimeEventValue,
  type ThreadId,
} from "@cafecode/contracts";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { providerDaemonRequestThreadIds } from "./ProviderDaemonThreadIdentity.ts";

const decodeRuntimeEventJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(ProviderRuntimeEvent),
);
const decodeRpcRequestJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(ProviderDaemonRpcRequest),
);

const LEGACY_EVENT_PAGE_SIZE = 1;
const LEGACY_COMMAND_PAGE_SIZE = 16;

interface LegacyEventRow {
  readonly cursor: number;
  readonly eventJson: string;
}

interface LegacyCommandRow {
  readonly commandId: string;
  readonly requestJson: string;
}

/**
 * Deliberately redacted failure. Historical bodies may contain prompts,
 * outputs, paths, or provider identifiers, so neither the JSON nor the SQL
 * cause may cross the authenticated daemon RPC boundary or enter debug logs.
 */
export class ProviderDaemonThreadPurgeError extends Data.TaggedError(
  "ProviderDaemonThreadPurgeError",
)<{
  readonly operation:
    | "install-fence"
    | "decode-legacy-event"
    | "hydrate-legacy-event"
    | "decode-legacy-command"
    | "hydrate-legacy-command"
    | "purge-indexed-bodies";
}> {}

function decodeLegacyEvent(row: LegacyEventRow): ProviderRuntimeEventValue {
  try {
    return decodeRuntimeEventJson(row.eventJson);
  } catch {
    // Deleting a schema-invalid row would make untrusted JSON the deletion
    // authority. Abort instead: the permanent fence is already installed, no
    // new material can arrive, and an operator can repair/quarantine the row.
    throw new ProviderDaemonThreadPurgeError({ operation: "decode-legacy-event" });
  }
}

function decodeLegacyCommand(row: LegacyCommandRow): ProviderDaemonRpcRequestValue {
  try {
    return decodeRpcRequestJson(row.requestJson);
  } catch {
    throw new ProviderDaemonThreadPurgeError({ operation: "decode-legacy-command" });
  }
}

const isThreadRetired = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly retired: number }>`
      SELECT 1 AS retired
      FROM hard_deleted_threads
      WHERE thread_id = ${threadId}
      LIMIT 1
    `;
    return rows.length > 0;
  });

/**
 * Purge prompt/output-bearing daemon persistence for one permanently retired
 * thread.
 *
 * New rows have typed identities in sidecar tables and are removed with exact
 * indexed equality. Old installations have no sidecars; those retained rows
 * are decoded through the shared protocol schemas in bounded pages, with an
 * event-loop yield after every page. This work is invoked only by hard delete,
 * never by migration or readiness startup.
 */
export const purgeProviderDaemonThreadPersistence = Effect.fn(
  "purgeProviderDaemonThreadPersistence",
)(function* (input: { readonly threadId: ThreadId }) {
  const sql = yield* SqlClient.SqlClient;
  const deletedAt = DateTime.formatIso(yield* DateTime.now);

  yield* sql`
    INSERT INTO hard_deleted_threads (thread_id, deleted_at)
    VALUES (${input.threadId}, ${deletedAt})
    ON CONFLICT(thread_id) DO NOTHING
  `.pipe(Effect.mapError(() => new ProviderDaemonThreadPurgeError({ operation: "install-fence" })));

  // Hydrate all retained legacy events. Cursor pagination uses the existing
  // primary key and reads at most one potentially-large JSON value at a time;
  // historical Codex diff events can be tens of megabytes.
  let afterCursor = 0;
  while (true) {
    const rows = (yield* sql`
      SELECT
        event.cursor,
        event.event_json AS "eventJson"
      FROM provider_daemon_events AS event
      WHERE event.cursor > ${afterCursor}
        AND NOT EXISTS (
          SELECT 1
          FROM provider_daemon_event_threads AS identity
          WHERE identity.cursor = event.cursor
        )
      ORDER BY event.cursor ASC
      LIMIT ${LEGACY_EVENT_PAGE_SIZE}
    `.pipe(
      Effect.mapError(
        () => new ProviderDaemonThreadPurgeError({ operation: "hydrate-legacy-event" }),
      ),
    )) as unknown as ReadonlyArray<LegacyEventRow>;
    const row = rows[0];
    if (row === undefined) {
      break;
    }
    afterCursor = Number(row.cursor);
    const event = yield* Effect.try({
      try: () => decodeLegacyEvent(row),
      catch: (error) =>
        error instanceof ProviderDaemonThreadPurgeError
          ? error
          : new ProviderDaemonThreadPurgeError({ operation: "decode-legacy-event" }),
    });
    if (event.threadId === input.threadId || (yield* isThreadRetired(event.threadId))) {
      // A pre-71 event has no identity sidecar, so final indexed cleanup
      // cannot recover its cursor after the body disappears. Strict decoding
      // above is the deletion authority; remove any exact quarantine
      // commitment and the body atomically while that cursor is still known.
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`
              DELETE FROM provider_daemon_event_quarantine
              WHERE cursor = ${row.cursor}
            `;
            yield* sql`DELETE FROM provider_daemon_events WHERE cursor = ${row.cursor}`;
          }),
        )
        .pipe(
          Effect.mapError(
            () => new ProviderDaemonThreadPurgeError({ operation: "hydrate-legacy-event" }),
          ),
        );
    } else {
      yield* sql`
        INSERT INTO provider_daemon_event_threads (cursor, thread_id)
        VALUES (${row.cursor}, ${event.threadId})
        ON CONFLICT(cursor) DO NOTHING
      `.pipe(
        Effect.mapError(
          () => new ProviderDaemonThreadPurgeError({ operation: "hydrate-legacy-event" }),
        ),
      );
    }
    yield* Effect.yieldNow;
  }

  // Commands are much smaller than runtime diff events, so a small page keeps
  // the number of SQLite round trips bounded without retaining an unbounded
  // collection of prompt bodies in the JS heap.
  let afterCommandId = "";
  while (true) {
    const rows = (yield* sql`
      SELECT
        command.command_id AS "commandId",
        command.request_json AS "requestJson"
      FROM provider_daemon_commands AS command
      WHERE command.command_id > ${afterCommandId}
        AND NOT EXISTS (
          SELECT 1
          FROM provider_daemon_indexed_commands AS indexed
          WHERE indexed.command_id = command.command_id
        )
      ORDER BY command.command_id ASC
      LIMIT ${LEGACY_COMMAND_PAGE_SIZE}
    `.pipe(
      Effect.mapError(
        () => new ProviderDaemonThreadPurgeError({ operation: "hydrate-legacy-command" }),
      ),
    )) as unknown as ReadonlyArray<LegacyCommandRow>;
    if (rows.length === 0) {
      break;
    }
    for (const row of rows) {
      afterCommandId = row.commandId;
      const request = yield* Effect.try({
        try: () => decodeLegacyCommand(row),
        catch: (error) =>
          error instanceof ProviderDaemonThreadPurgeError
            ? error
            : new ProviderDaemonThreadPurgeError({ operation: "decode-legacy-command" }),
      });
      const threadIds = providerDaemonRequestThreadIds(request);
      let mustDelete = threadIds.includes(input.threadId);
      if (!mustDelete) {
        for (const threadId of threadIds) {
          if (yield* isThreadRetired(threadId)) {
            mustDelete = true;
            break;
          }
        }
      }
      if (mustDelete) {
        yield* sql`DELETE FROM provider_daemon_commands WHERE command_id = ${row.commandId}`.pipe(
          Effect.mapError(
            () => new ProviderDaemonThreadPurgeError({ operation: "hydrate-legacy-command" }),
          ),
        );
        continue;
      }
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            for (const threadId of threadIds) {
              yield* sql`
                INSERT INTO provider_daemon_command_threads (command_id, thread_id)
                VALUES (${row.commandId}, ${threadId})
                ON CONFLICT(command_id, thread_id) DO NOTHING
              `;
            }
            yield* sql`
              INSERT INTO provider_daemon_indexed_commands (command_id)
              VALUES (${row.commandId})
              ON CONFLICT(command_id) DO NOTHING
            `;
          }),
        )
        .pipe(
          Effect.mapError(
            () => new ProviderDaemonThreadPurgeError({ operation: "hydrate-legacy-command" }),
          ),
        );
    }
    yield* Effect.yieldNow;
  }

  yield* sql
    .withTransaction(
      Effect.gen(function* () {
        // Quarantine retains bounded commitments rather than raw event JSON,
        // but its cursor/hash/size/timestamp still belongs to the deleted
        // thread. Resolve it through the exact typed sidecar before the base
        // event DELETE trigger removes that identity.
        yield* sql`
          DELETE FROM provider_daemon_event_quarantine
          WHERE cursor IN (
            SELECT cursor
            FROM provider_daemon_event_threads
            WHERE thread_id = ${input.threadId}
          )
        `;
        yield* sql`
          DELETE FROM provider_daemon_events
          WHERE cursor IN (
            SELECT cursor
            FROM provider_daemon_event_threads
            WHERE thread_id = ${input.threadId}
          )
        `;
        yield* sql`
          DELETE FROM provider_daemon_commands
          WHERE command_id IN (
            SELECT command_id
            FROM provider_daemon_command_threads
            WHERE thread_id = ${input.threadId}
          )
        `;
        // Cleanup remains explicit even though migration 071 installs DELETE
        // triggers; some legacy/test SQLite openers disable foreign keys.
        yield* sql`
          DELETE FROM provider_daemon_event_threads
          WHERE thread_id = ${input.threadId}
        `;
        yield* sql`
          DELETE FROM provider_daemon_command_threads
          WHERE thread_id = ${input.threadId}
        `;

        // ProviderService and the optional supervisor can own a separate
        // database from orchestration. These exact thread-keyed rows contain
        // private resume cursors, runtime payloads, child-history roots, paths,
        // and provider diagnostics, so daemon purge cannot defer them to the
        // main backend's later local cleanup. Child rows are deleted explicitly
        // before parents because some legacy/test SQLite openers disable FKs.
        yield* sql`
          DELETE FROM provider_subagent_history_bindings
          WHERE thread_id = ${input.threadId}
        `;
        yield* sql`
          DELETE FROM provider_subagent_history_roots
          WHERE thread_id = ${input.threadId}
        `;
        yield* sql`
          DELETE FROM provider_supervisor_ownership_events
          WHERE session_id IN (
            SELECT session_id
            FROM provider_supervisor_sessions
            WHERE thread_id = ${input.threadId}
          )
        `;
        yield* sql`
          DELETE FROM provider_supervisor_io_events
          WHERE session_id IN (
            SELECT session_id
            FROM provider_supervisor_sessions
            WHERE thread_id = ${input.threadId}
          )
        `;
        yield* sql`
          DELETE FROM provider_supervisor_sessions
          WHERE thread_id = ${input.threadId}
        `;
        yield* sql`
          DELETE FROM provider_session_runtime
          WHERE thread_id = ${input.threadId}
        `;
      }),
    )
    .pipe(
      Effect.mapError(
        () => new ProviderDaemonThreadPurgeError({ operation: "purge-indexed-bodies" }),
      ),
    );
});
