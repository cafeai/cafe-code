import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type * as SqlError from "effect/unstable/sql/SqlError";

/** Maximum selected activities examined in one synchronous SQLite statement. */
export const LEGACY_ACTIVITY_ORDER_BATCH_SIZE = 64;

// These are the actual historical driver keys used by ProviderRuntimeIngestion,
// not display labels or provider-instance ids. In particular, Claude is
// `claudeAgent`. Unknown extension drivers and retired Cursor retain their old
// compatibility order; neither is authority to guess a command-id spelling.
const HISTORICAL_ACTIVITY_DRIVERS = ["codex", "claudeAgent", "opencode", "grok"] as const;
const TASK_LIFECYCLE_KINDS = new Set(["task.started", "task.progress", "task.completed"]);
const MAX_LOOKUP_ID_LENGTH = 4_096;
const MAX_LOOKUP_TIMESTAMP_LENGTH = 128;

export interface LegacyActivityOrderRow {
  readonly threadId: string;
  readonly activityId: string;
  readonly turnId: string | null;
  readonly kind: string;
  readonly createdAt: string;
  readonly sequence?: number | null | undefined;
}

interface QualifiedActivityOrder {
  readonly rowIndex: number;
  readonly sequence: number;
}

function isBoundedExactId(value: string): boolean {
  // IDs are comparison material, not display text or SQL syntax. Do not trim,
  // normalize, parse their punctuation, or collapse distinct native spellings.
  // A corrupt oversized row stays compatible but cannot create huge SQL keys.
  return typeof value === "string" && value.length > 0 && value.length <= MAX_LOOKUP_ID_LENGTH;
}

function isLookupCandidate(row: LegacyActivityOrderRow): boolean {
  return (
    TASK_LIFECYCLE_KINDS.has(row.kind) &&
    isBoundedExactId(row.threadId) &&
    isBoundedExactId(row.activityId) &&
    (row.turnId === null || isBoundedExactId(row.turnId)) &&
    typeof row.createdAt === "string" &&
    row.createdAt.length > 0 &&
    row.createdAt.length <= MAX_LOOKUP_TIMESTAMP_LENGTH
  );
}

/**
 * Recover only selected historical task rows' authoritative append order.
 *
 * Old projection sequences can be null OR provider/session-local counters.
 * Only the exact server journal append can replace them. Task activities use
 * event.eventId as activity.id, and ProviderRuntimeIngestion builds its command
 * id as provider:<driver>:<thread>:<eventId>:thread-activity-append:<activityId>.
 * The indexed command lookup is therefore finite without inspecting history.
 *
 * A command witness must be unique even if a second row is malformed or belongs
 * to another stream. Each command probe admits at most two rows BEFORE JSON
 * qualification; duplicate commands fail closed rather than selecting a lucky
 * match or scanning attacker-sized duplicate ranges. The final statement reads
 * no payload, prompt, error or metadata text into JavaScript, only row positions
 * and qualified durable sequence numbers. All input values remain parameters.
 *
 * This is read-only enrichment, not a journal migration or sidecar authority.
 * Preserve unmatched rows unchanged, including their compatibility sequence;
 * callers re-sort the enriched rows before lifecycle retention/selection.
 */
export function enrichLegacyActivityOrder<Row extends LegacyActivityOrderRow>(
  sql: SqlClient.SqlClient,
  rows: ReadonlyArray<Row>,
): Effect.Effect<ReadonlyArray<Row>, SqlError.SqlError> {
  return Effect.gen(function* () {
    const candidates = rows
      .map((row, rowIndex) => ({ row, rowIndex }))
      .filter(({ row }) => isLookupCandidate(row));
    const sequenceByIndex = new Map<number, number>();
    for (let offset = 0; offset < candidates.length; offset += LEGACY_ACTIVITY_ORDER_BATCH_SIZE) {
      const batch = candidates.slice(offset, offset + LEGACY_ACTIVITY_ORDER_BATCH_SIZE);
      const selectedValues = sql.join(
        ",",
        false,
      )(
        batch.map(
          ({ row, rowIndex }) => sql`(
          ${rowIndex}, ${row.threadId}, ${row.activityId}, ${row.turnId}, ${row.kind}, ${row.createdAt}
        )`,
        ),
      );
      const requestedValues = sql.join(
        ",",
        false,
      )(
        batch.flatMap(({ row, rowIndex }) =>
          HISTORICAL_ACTIVITY_DRIVERS.map(
            (driver) => sql`(
            ${rowIndex}, ${`provider:${driver}:${row.threadId}:${row.activityId}:thread-activity-append:${row.activityId}`}
          )`,
          ),
        ),
      );
      const qualified = yield* sql<QualifiedActivityOrder>`
        WITH selected(row_index, thread_id, activity_id, turn_id, kind, created_at) AS (
          VALUES ${selectedValues}
        ), requested(row_index, command_id) AS (
          VALUES ${requestedValues}
        ), matched AS (
          SELECT requested.row_index, event.sequence
          FROM requested
          JOIN orchestration_events AS event
            ON event.sequence IN (
              SELECT candidate.sequence
              FROM orchestration_events AS candidate INDEXED BY idx_orch_events_command_id
              WHERE candidate.command_id = requested.command_id
              LIMIT 2
            )
        ), unique_event AS (
          SELECT row_index, MIN(sequence) AS sequence
          FROM matched
          GROUP BY row_index
          HAVING COUNT(*) = 1
        )
        SELECT selected.row_index AS "rowIndex", event.sequence
        FROM selected
        JOIN unique_event ON unique_event.row_index = selected.row_index
        JOIN orchestration_events AS event ON event.sequence = unique_event.sequence
        WHERE event.aggregate_kind = 'thread'
          AND event.stream_id = selected.thread_id
          AND event.event_type = 'thread.activity-appended'
          AND event.actor_kind = 'provider'
          AND event.occurred_at = selected.created_at
          AND CASE WHEN json_valid(event.payload_json) THEN (
            json_type(event.payload_json, '$.threadId') = 'text'
            AND json_extract(event.payload_json, '$.threadId') = selected.thread_id
            AND json_type(event.payload_json, '$.activity.id') = 'text'
            AND json_extract(event.payload_json, '$.activity.id') = selected.activity_id
            AND json_type(event.payload_json, '$.activity.kind') = 'text'
            AND json_extract(event.payload_json, '$.activity.kind') = selected.kind
            AND json_type(event.payload_json, '$.activity.createdAt') = 'text'
            AND json_extract(event.payload_json, '$.activity.createdAt') = selected.created_at
            AND json_type(event.payload_json, '$.activity.turnId') =
              CASE WHEN selected.turn_id IS NULL THEN 'null' ELSE 'text' END
            AND json_extract(event.payload_json, '$.activity.turnId') IS selected.turn_id
          ) ELSE 0 END
        LIMIT ${LEGACY_ACTIVITY_ORDER_BATCH_SIZE}
      `;
      for (const witness of qualified) {
        // SQLite INTEGER may outgrow JavaScript's safe range in a damaged or
        // exhausted journal. Never manufacture a comparator from unsafe data.
        if (
          Number.isSafeInteger(witness.rowIndex) &&
          Number.isSafeInteger(witness.sequence) &&
          witness.sequence > 0 &&
          batch.some(({ rowIndex }) => rowIndex === witness.rowIndex)
        ) {
          sequenceByIndex.set(witness.rowIndex, witness.sequence);
        }
      }
      // node:sqlite executes synchronously. A real Node event-loop turn between
      // finite pages lets unrelated readiness/WebSocket work run; Effect's
      // scheduler-only yield is not an I/O fairness boundary.
      yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));
    }
    if (sequenceByIndex.size === 0) return rows;
    return rows.map((row, rowIndex) => {
      const sequence = sequenceByIndex.get(rowIndex);
      return sequence === undefined || sequence === row.sequence ? row : { ...row, sequence };
    });
  });
}
