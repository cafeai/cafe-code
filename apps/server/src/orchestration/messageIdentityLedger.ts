import type { MessageId, ThreadId } from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as SqlError from "effect/unstable/sql/SqlError";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import { isSqliteBusySnapshotError } from "../persistence/sqliteLockRetry.ts";

// Journal payloads can approach the per-event byte limit. A 64-row page keeps
// each synchronous node:sqlite materialization conservatively bounded while
// retaining good index locality and resumable watermark progress.
const LEGACY_HYDRATION_PAGE_SIZE = 64;
const LEGACY_HYDRATION_LOCK_RETRIES = 8;
const LEGACY_HYDRATION_LOCK_RETRY_BASE_DELAY = "10 millis";

export interface PersistedMessageIdentity {
  readonly sequence: number;
  readonly payloadJson: string;
}

export class MessageIdentityLedgerInvariantError extends Schema.TaggedErrorClass<MessageIdentityLedgerInvariantError>()(
  "MessageIdentityLedgerInvariantError",
  {
    issue: Schema.Literals([
      "missing-migration-state",
      "invalid-migration-state",
      "invalid-hydration-state",
      "identity-event-mismatch",
    ]),
  },
) {
  override get message(): string {
    return `Message identity ledger integrity check failed: ${this.issue}`;
  }
}

interface PersistedSequenceRow {
  readonly sequence: number;
}

interface PersistedIdentityJoinRow {
  readonly identityLatestSequence: number;
  readonly eventSequence: number | null;
  readonly aggregateKind: string | null;
  readonly streamId: string | null;
  readonly eventType: string | null;
  readonly actorKind: string | null;
  readonly occurredAt: string | null;
  readonly payloadJson: string | null;
  readonly payloadMessageId: string | null;
  readonly payloadThreadId: string | null;
  readonly payloadRole: string | null;
  readonly payloadCreatedAt: string | null;
}

interface IdentityStateRow {
  readonly legacyCutoffSequence: number;
}

interface HydrationStateRow {
  readonly throughSequence: number;
}

interface TombstoneRow {
  readonly retired: number;
}

function readLedgerAuthority(
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
): Effect.Effect<
  {
    readonly legacyCutoffSequence: number;
    readonly hydratedThroughSequence: number | undefined;
  },
  SqlError.SqlError | MessageIdentityLedgerInvariantError
> {
  return Effect.gen(function* () {
    const [identityState] = yield* sql<IdentityStateRow>`
      SELECT legacy_cutoff_sequence AS "legacyCutoffSequence"
      FROM orchestration_message_identity_state
      WHERE singleton_id = 1
      LIMIT 1
    `;
    if (identityState === undefined) {
      return yield* new MessageIdentityLedgerInvariantError({
        issue: "missing-migration-state",
      });
    }
    const legacyCutoffSequence = identityState.legacyCutoffSequence;
    if (!Number.isSafeInteger(legacyCutoffSequence) || legacyCutoffSequence < 0) {
      return yield* new MessageIdentityLedgerInvariantError({
        issue: "invalid-migration-state",
      });
    }

    const [hydrationState] = yield* sql<HydrationStateRow>`
      SELECT through_sequence AS "throughSequence"
      FROM orchestration_message_identity_hydration
      WHERE thread_id = ${threadId}
      LIMIT 1
    `;
    const hydratedThroughSequence = hydrationState?.throughSequence;
    if (
      hydratedThroughSequence !== undefined &&
      (!Number.isSafeInteger(hydratedThroughSequence) ||
        hydratedThroughSequence < 0 ||
        hydratedThroughSequence > legacyCutoffSequence)
    ) {
      return yield* new MessageIdentityLedgerInvariantError({
        issue: "invalid-hydration-state",
      });
    }
    return { legacyCutoffSequence, hydratedThroughSequence };
  });
}

/**
 * Resolve the latest generation of a MessageId through the compact ledger.
 * The payload remains authoritative in `orchestration_events`; the ledger
 * stores only stable keys and sequence pointers so it does not duplicate user
 * prompts or attachment metadata.
 */
export function readLatestMessageIdentity(
  sql: SqlClient.SqlClient,
  input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
  },
): Effect.Effect<
  PersistedMessageIdentity | undefined,
  SqlError.SqlError | MessageIdentityLedgerInvariantError
> {
  return Effect.gen(function* () {
    // The compact pointer is useful only under a valid migration authority.
    // Validate the singleton and this thread's hydration watermark even when
    // a row is already present; otherwise deleting/corrupting migration state
    // turns a forged compact row into an admission bypass.
    const authority = yield* readLedgerAuthority(sql, input.threadId);
    const [row] = yield* sql<PersistedIdentityJoinRow>`
    SELECT
      identity.latest_sequence AS "identityLatestSequence",
      event.sequence AS "eventSequence",
      event.aggregate_kind AS "aggregateKind",
      event.stream_id AS "streamId",
      event.event_type AS "eventType",
      event.actor_kind AS "actorKind",
      event.occurred_at AS "occurredAt",
      event.payload_json AS "payloadJson",
      json_extract(event.payload_json, '$.messageId') AS "payloadMessageId",
      json_extract(event.payload_json, '$.threadId') AS "payloadThreadId",
      json_extract(event.payload_json, '$.role') AS "payloadRole",
      json_extract(event.payload_json, '$.createdAt') AS "payloadCreatedAt"
    FROM orchestration_message_identities AS identity
    LEFT JOIN orchestration_events AS event
      ON event.sequence = identity.latest_sequence
    WHERE identity.thread_id = ${input.threadId}
      AND identity.message_id = ${input.messageId}
    LIMIT 1
  `;
    if (row === undefined) {
      return undefined;
    }

    // A dangling or misbound sequence must never be treated as an unused
    // identity. Foreign keys protect the ordinary write path, while these
    // explicit checks keep admission fail-closed if a database was opened with
    // FK enforcement disabled, manually altered, or partially recovered.
    if (
      !Number.isSafeInteger(row.identityLatestSequence) ||
      row.identityLatestSequence < 0 ||
      row.eventSequence !== row.identityLatestSequence ||
      row.aggregateKind !== "thread" ||
      row.streamId !== input.threadId ||
      row.eventType !== "thread.message-sent" ||
      (row.actorKind !== "client" && row.actorKind !== "server") ||
      row.occurredAt === null ||
      typeof row.payloadJson !== "string" ||
      row.payloadMessageId !== input.messageId ||
      row.payloadThreadId !== input.threadId ||
      row.payloadRole !== "user" ||
      row.payloadCreatedAt !== row.occurredAt ||
      (row.identityLatestSequence <= authority.legacyCutoffSequence &&
        (authority.hydratedThroughSequence === undefined ||
          authority.hydratedThroughSequence < row.identityLatestSequence))
    ) {
      return yield* new MessageIdentityLedgerInvariantError({
        issue: "identity-event-mismatch",
      });
    }

    return {
      sequence: row.eventSequence,
      payloadJson: row.payloadJson,
    };
  });
}

/**
 * Hydrate pre-migration MessageIds for one selected thread in bounded pages.
 *
 * Migration 68 records a cutoff before installing its append trigger. Events
 * after that cutoff are already covered atomically by the trigger. Older rows
 * are deliberately not scanned at application startup. When an authenticated
 * command presents a MessageId absent from the new ledger, the serialized
 * orchestration worker calls this function once for that thread, advancing a
 * durable watermark after each small transaction. A crash or competing
 * process can therefore resume without repeating completed pages, while a
 * caller cannot bypass historical identity checks during the transition.
 */
export function hydrateLegacyMessageIdentitiesForThread(
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
): Effect.Effect<void, SqlError.SqlError | MessageIdentityLedgerInvariantError> {
  return Effect.gen(function* () {
    const authority = yield* readLedgerAuthority(sql, threadId);
    const legacyCutoffSequence = authority.legacyCutoffSequence;
    let throughSequence = authority.hydratedThroughSequence ?? 0;

    while (throughSequence < legacyCutoffSequence) {
      // Read only sequence keys first. The existing
      // (aggregate_kind, stream_id, sequence) index makes this page bounded and
      // avoids materializing large tool/activity payloads merely to advance a
      // watermark.
      const page = yield* sql<PersistedSequenceRow>`
        SELECT sequence
        FROM orchestration_events
        WHERE aggregate_kind = 'thread'
          AND stream_id = ${threadId}
          AND sequence > ${throughSequence}
          AND sequence <= ${legacyCutoffSequence}
        ORDER BY sequence ASC
        LIMIT ${LEGACY_HYDRATION_PAGE_SIZE}
      `;
      const pageEndSequence = page.at(-1)?.sequence ?? legacyCutoffSequence;

      let retryAttempt = 0;
      const hydratePage = Effect.suspend(() => {
        retryAttempt += 1;
        return sql
          .withTransaction(
            Effect.gen(function* () {
              // Hard-delete tombstones are permanent. Check from inside the same
              // transaction as the compact writes so an older overlapping backend
              // cannot recreate standalone hydration state after purge. If this
              // transaction wins first, the later purge removes its rows; if the
              // tombstone wins first, this branch writes nothing.
              const [tombstone] = yield* sql<TombstoneRow>`
            SELECT 1 AS retired
            FROM hard_deleted_threads
            WHERE thread_id = ${threadId}
            LIMIT 1
          `;
              if (tombstone !== undefined) {
                return true;
              }
              if (page.length > 0) {
                yield* sql`
              INSERT INTO orchestration_message_identities (
                thread_id,
                message_id,
                first_sequence,
                latest_sequence
              )
              SELECT
                stream_id,
                json_extract(payload_json, '$.messageId'),
                MIN(sequence),
                MAX(sequence)
              FROM orchestration_events
              WHERE aggregate_kind = 'thread'
                AND stream_id = ${threadId}
                AND event_type = 'thread.message-sent'
                AND actor_kind IN ('client', 'server')
                AND sequence > ${throughSequence}
                AND sequence <= ${pageEndSequence}
                AND json_type(payload_json, '$.messageId') = 'text'
                AND json_extract(payload_json, '$.threadId') = stream_id
                AND json_extract(payload_json, '$.role') = 'user'
                AND json_extract(payload_json, '$.createdAt') = occurred_at
              GROUP BY stream_id, json_extract(payload_json, '$.messageId')
              ON CONFLICT (thread_id, message_id) DO UPDATE SET
                first_sequence = MIN(
                  orchestration_message_identities.first_sequence,
                  excluded.first_sequence
                ),
                latest_sequence = MAX(
                  orchestration_message_identities.latest_sequence,
                  excluded.latest_sequence
                )
            `;
              }

              yield* sql`
            INSERT INTO orchestration_message_identity_hydration (
              thread_id,
              through_sequence
            )
            VALUES (${threadId}, ${pageEndSequence})
            ON CONFLICT (thread_id) DO UPDATE SET
              through_sequence = MAX(
                orchestration_message_identity_hydration.through_sequence,
                excluded.through_sequence
              )
          `;
              return false;
            }),
          )
          .pipe(
            Effect.tapError((error) =>
              isSqliteBusySnapshotError(error)
                ? Effect.logWarning(
                    "SQLite message identity hydration lock contention observed",
                  ).pipe(
                    Effect.annotateLogs({
                      attempt: retryAttempt,
                      reason: error.reason._tag,
                    }),
                  )
                : Effect.void,
            ),
          );
      });

      // Provider-daemon ingestion and the main backend intentionally share
      // this WAL database. A daemon commit between the tombstone read and the
      // first compact-ledger write invalidates a deferred snapshot immediately;
      // SQLite's busy timeout cannot wait that state away. Retry only this
      // idempotent page transaction from a fresh BEGIN/snapshot. Never retry
      // the surrounding user command, which could duplicate durable events.
      // Every retry rechecks the permanent tombstone, and failed transactions
      // cannot advance the monotonic watermark or expose partial identities.
      const retired = yield* hydratePage.pipe(
        Effect.retry({
          schedule: Schedule.jittered(Schedule.exponential(LEGACY_HYDRATION_LOCK_RETRY_BASE_DELAY)),
          times: LEGACY_HYDRATION_LOCK_RETRIES,
          while: isSqliteBusySnapshotError,
        }),
      );

      if (retired) {
        return;
      }

      throughSequence = pageEndSequence;
      if (throughSequence < legacyCutoffSequence) {
        // `node:sqlite` is synchronous. Effect.yieldNow alone can hand control
        // to another fiber while still starving Node's timer, socket, and IPC
        // queues. Cross an actual event-loop boundary between pages so legacy
        // hydration remains responsive to readiness probes and provider I/O.
        // The engine remains fail-closed for this command until the durable
        // per-thread watermark reaches the migration cutoff.
        yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));
      }
    }
  });
}
