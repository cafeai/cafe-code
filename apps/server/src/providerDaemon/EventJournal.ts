// @effect-diagnostics globalDate:off
import {
  ProviderRuntimeEvent,
  type ProviderDaemonEventRecord,
  type ProviderRuntimeEvent as ProviderRuntimeEventValue,
} from "@cafecode/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const encodeProviderRuntimeEventJson = Schema.encodeSync(
  Schema.fromJsonString(ProviderRuntimeEvent),
);
const decodeProviderRuntimeEventJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(ProviderRuntimeEvent),
);

export interface ProviderDaemonEventJournalSnapshot {
  readonly eventCursor: number;
  readonly retainedEventCount: number;
  readonly oldestCursor: number | null;
  readonly newestCursor: number | null;
}

export interface ProviderDaemonEventJournal {
  readonly publish: (event: ProviderRuntimeEventValue) => ProviderDaemonEventRecord;
  readonly replayAfter: (cursor: number) => ReadonlyArray<ProviderDaemonEventRecord>;
  readonly subscribe: (listener: (record: ProviderDaemonEventRecord) => void) => () => void;
  readonly snapshot: () => ProviderDaemonEventJournalSnapshot;
}

export interface ProviderDaemonPersistentEventJournal {
  readonly publish: (event: ProviderRuntimeEventValue) => Effect.Effect<ProviderDaemonEventRecord>;
  readonly replayAfter: (cursor: number) => Effect.Effect<ReadonlyArray<ProviderDaemonEventRecord>>;
  readonly subscribe: (listener: (record: ProviderDaemonEventRecord) => void) => () => void;
  readonly snapshot: Effect.Effect<ProviderDaemonEventJournalSnapshot>;
}

export function createProviderDaemonEventJournal(options?: {
  readonly capacity?: number;
}): ProviderDaemonEventJournal {
  const capacity = Math.max(1, Math.trunc(options?.capacity ?? 50_000));
  const records: ProviderDaemonEventRecord[] = [];
  const listeners = new Set<(record: ProviderDaemonEventRecord) => void>();
  let nextCursor = 1;

  const publish = (event: ProviderRuntimeEventValue): ProviderDaemonEventRecord => {
    const record: ProviderDaemonEventRecord = {
      cursor: nextCursor,
      emittedAt: new Date().toISOString(),
      event,
    };
    nextCursor += 1;
    records.push(record);
    if (records.length > capacity) {
      records.splice(0, records.length - capacity);
    }
    for (const listener of listeners) {
      listener(record);
    }
    return record;
  };

  const replayAfter = (cursor: number): ReadonlyArray<ProviderDaemonEventRecord> => {
    const normalizedCursor = Number.isFinite(cursor) ? Math.max(0, Math.trunc(cursor)) : 0;
    return records.filter((record) => record.cursor > normalizedCursor);
  };

  const subscribe = (listener: (record: ProviderDaemonEventRecord) => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const snapshot = (): ProviderDaemonEventJournalSnapshot => ({
    eventCursor: nextCursor - 1,
    retainedEventCount: records.length,
    oldestCursor: records[0]?.cursor ?? null,
    newestCursor: records.at(-1)?.cursor ?? null,
  });

  return {
    publish,
    replayAfter,
    subscribe,
    snapshot,
  };
}

function normalizeOwnerKey(ownerKey: string | undefined): string {
  const normalized = (ownerKey ?? "provider-daemon").trim();
  return normalized.length === 0 ? "provider-daemon" : normalized;
}

const PERSISTENT_JOURNAL_PRUNE_INTERVAL = 1_000;
const PERSISTENT_JOURNAL_PRUNE_BATCH_SIZE = 10_000;
const PERSISTENT_JOURNAL_PRUNE_BATCH_PAUSE_MS = 25;
const PERSISTENT_JOURNAL_STARTUP_PRUNE_DELAY_MS = 5_000;
const PROVIDER_DAEMON_EVENT_ID_INDEX_NAME = "idx_provider_daemon_events_owner_event_id";

interface PersistedEventRow {
  readonly cursor: number;
  readonly emittedAt: string;
  readonly eventJson: string;
}

function normalizeCursor(cursor: number): number {
  return Number.isFinite(cursor) ? Math.max(0, Math.trunc(cursor)) : 0;
}

function normalizeSqlNumber(value: unknown, fallback: number): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : fallback;
  }
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function normalizeSqlNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  return normalizeSqlNumber(value, 0);
}

function rowToRecord(row: PersistedEventRow): ProviderDaemonEventRecord {
  return {
    cursor: normalizeSqlNumber(row.cursor, 0),
    emittedAt: row.emittedAt,
    event: decodeProviderRuntimeEventJson(row.eventJson),
  };
}

function runtimeEventId(event: ProviderRuntimeEventValue): string {
  return String(event.eventId);
}

export const makePersistentProviderDaemonEventJournal = (options?: {
  readonly capacity?: number;
  readonly ownerKey?: string;
  readonly startupPruneDelayMs?: number;
}): Effect.Effect<ProviderDaemonPersistentEventJournal, never, Scope.Scope | SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const capacity = Math.max(1, Math.trunc(options?.capacity ?? 50_000));
    const pruneInterval =
      capacity <= PERSISTENT_JOURNAL_PRUNE_INTERVAL ? 1 : PERSISTENT_JOURNAL_PRUNE_INTERVAL;
    const startupPruneDelayMs = Math.max(
      0,
      Math.trunc(options?.startupPruneDelayMs ?? PERSISTENT_JOURNAL_STARTUP_PRUNE_DELAY_MS),
    );
    const ownerKey = normalizeOwnerKey(options?.ownerKey);
    const listeners = new Set<(record: ProviderDaemonEventRecord) => void>();
    let eventsSincePrune = 0;
    let eventIdIndexReady = false;

    const refreshEventIdIndexState = Effect.gen(function* () {
      const rows = (yield* sql`
        SELECT 1 AS "exists"
        FROM sqlite_master
        WHERE type = 'index'
          AND name = ${PROVIDER_DAEMON_EVENT_ID_INDEX_NAME}
        LIMIT 1
      `.pipe(Effect.orDie)) as unknown as ReadonlyArray<{ readonly exists: number }>;
      eventIdIndexReady = rows.length > 0;
    });

    yield* refreshEventIdIndexState;

    const ensureEventIdIndex = Effect.fn("ProviderDaemonPersistentEventJournal.ensureEventIdIndex")(
      function* () {
        // Build this after startup pruning rather than as a migration. On large
        // inherited journals, expression-index creation over every historical
        // event can exceed the desktop daemon readiness deadline; after pruning,
        // the index is small and lets restart replay dedupe by canonical eventId.
        yield* sql`
          CREATE INDEX IF NOT EXISTS idx_provider_daemon_events_owner_event_id
          ON provider_daemon_events(owner_key, json_extract(event_json, '$.eventId'))
        `.pipe(Effect.orDie);
        eventIdIndexReady = true;
      },
    );

    const pruneToCapacity = Effect.fn("ProviderDaemonPersistentEventJournal.pruneToCapacity")(
      function* () {
        // The in-memory journal has always pruned itself, but the durable journal
        // originally only limited replay queries. That let SQLite accumulate
        // every provider runtime event forever, which is not how the Codex CLI
        // keeps its live session state bounded. Keep the newest `capacity`
        // events per runtime owner and delete older rows from the same owner.
        const boundaryRows = (yield* sql`
          SELECT cursor
          FROM provider_daemon_events
          WHERE owner_key = ${ownerKey}
          ORDER BY cursor DESC
          LIMIT 1 OFFSET ${capacity - 1}
        `.pipe(Effect.orDie)) as unknown as ReadonlyArray<{ readonly cursor: number }>;
        const oldestRetainedCursor = normalizeSqlNullableNumber(boundaryRows[0]?.cursor);
        if (oldestRetainedCursor === null) {
          return;
        }

        let deletedCount = PERSISTENT_JOURNAL_PRUNE_BATCH_SIZE;
        while (deletedCount >= PERSISTENT_JOURNAL_PRUNE_BATCH_SIZE) {
          const deletedRows = (yield* sql`
            DELETE FROM provider_daemon_events
            WHERE cursor IN (
              SELECT cursor
              FROM provider_daemon_events
              WHERE owner_key = ${ownerKey}
                AND cursor < ${oldestRetainedCursor}
              ORDER BY cursor ASC
              LIMIT ${PERSISTENT_JOURNAL_PRUNE_BATCH_SIZE}
            )
            RETURNING cursor
          `.pipe(Effect.orDie)) as unknown as ReadonlyArray<{ readonly cursor: number }>;
          deletedCount = deletedRows.length;
          if (deletedCount >= PERSISTENT_JOURNAL_PRUNE_BATCH_SIZE) {
            yield* Effect.sleep(Duration.millis(PERSISTENT_JOURNAL_PRUNE_BATCH_PAUSE_MS));
          }
        }
      },
    );

    yield* Effect.sleep(Duration.millis(startupPruneDelayMs)).pipe(
      Effect.andThen(pruneToCapacity()),
      Effect.andThen(ensureEventIdIndex()),
      Effect.ignoreCause({ log: true }),
      Effect.forkScoped,
      Effect.asVoid,
    );

    const replayAfter = (cursor: number): Effect.Effect<ReadonlyArray<ProviderDaemonEventRecord>> =>
      Effect.gen(function* () {
        const normalizedCursor = normalizeCursor(cursor);
        const rows = (yield* sql`
          SELECT
            cursor,
            emitted_at AS "emittedAt",
            event_json AS "eventJson"
          FROM provider_daemon_events
          WHERE owner_key = ${ownerKey}
            AND cursor > ${normalizedCursor}
          ORDER BY cursor ASC
          LIMIT ${capacity}
        `.pipe(Effect.orDie)) as unknown as ReadonlyArray<PersistedEventRow>;
        return rows.map(rowToRecord);
      });

    const snapshot: Effect.Effect<ProviderDaemonEventJournalSnapshot> = Effect.gen(function* () {
      const rows = (yield* sql`
        SELECT
          COALESCE(MAX(cursor), 0) AS "eventCursor",
          COUNT(*) AS "retainedEventCount",
          MIN(cursor) AS "oldestCursor",
          MAX(cursor) AS "newestCursor"
        FROM provider_daemon_events
        WHERE owner_key = ${ownerKey}
      `.pipe(Effect.orDie)) as unknown as ReadonlyArray<{
        readonly eventCursor: number;
        readonly retainedEventCount: number;
        readonly oldestCursor: number | null;
        readonly newestCursor: number | null;
      }>;
      const row = rows[0];
      return {
        eventCursor: normalizeSqlNumber(row?.eventCursor, 0),
        retainedEventCount: normalizeSqlNumber(row?.retainedEventCount, 0),
        oldestCursor: normalizeSqlNullableNumber(row?.oldestCursor),
        newestCursor: normalizeSqlNullableNumber(row?.newestCursor),
      };
    });

    const publish = (event: ProviderRuntimeEventValue): Effect.Effect<ProviderDaemonEventRecord> =>
      Effect.gen(function* () {
        const eventId = runtimeEventId(event);
        if (eventIdIndexReady) {
          const existingRows = (yield* sql`
            SELECT
              cursor,
              emitted_at AS "emittedAt",
              event_json AS "eventJson"
            FROM provider_daemon_events
            WHERE owner_key = ${ownerKey}
              AND json_extract(event_json, '$.eventId') = ${eventId}
            ORDER BY cursor DESC
            LIMIT 1
          `.pipe(Effect.orDie)) as unknown as ReadonlyArray<PersistedEventRow>;
          const existingRow = existingRows[0];
          if (existingRow !== undefined) {
            return rowToRecord(existingRow);
          }
        }

        const emittedAt = DateTime.formatIso(yield* DateTime.now);
        const rows = (yield* sql`
          INSERT INTO provider_daemon_events (
            owner_key,
            emitted_at,
            event_json
          )
          VALUES (
            ${ownerKey},
            ${emittedAt},
            ${encodeProviderRuntimeEventJson(event)}
          )
          RETURNING
            cursor,
            emitted_at AS "emittedAt",
            event_json AS "eventJson"
        `.pipe(Effect.orDie)) as unknown as ReadonlyArray<PersistedEventRow>;
        const row = rows[0];
        if (row === undefined) {
          return yield* Effect.die(new Error("provider daemon event insert did not return a row"));
        }
        const record = rowToRecord(row);
        for (const listener of listeners) {
          listener(record);
        }
        eventsSincePrune += 1;
        if (eventsSincePrune >= pruneInterval) {
          eventsSincePrune = 0;
          yield* pruneToCapacity();
        }
        return record;
      });

    const subscribe = (listener: (record: ProviderDaemonEventRecord) => void): (() => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    };

    return {
      publish,
      replayAfter,
      subscribe,
      snapshot,
    };
  }).pipe(Effect.orDie);
