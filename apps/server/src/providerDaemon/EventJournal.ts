// @effect-diagnostics globalDate:off
import {
  ProviderRuntimeEvent,
  type ProviderDaemonEventRecord,
  type ProviderRuntimeEvent as ProviderRuntimeEventValue,
} from "@cafecode/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
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

export const makePersistentProviderDaemonEventJournal = (options?: {
  readonly capacity?: number;
  readonly ownerKey?: string;
}): Effect.Effect<ProviderDaemonPersistentEventJournal, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const capacity = Math.max(1, Math.trunc(options?.capacity ?? 50_000));
    const ownerKey = normalizeOwnerKey(options?.ownerKey);
    const listeners = new Set<(record: ProviderDaemonEventRecord) => void>();

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
