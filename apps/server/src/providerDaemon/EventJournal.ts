// @effect-diagnostics globalDate:off
import * as Crypto from "node:crypto";

import {
  EventId,
  ProviderDriverKind,
  ProviderRuntimeEvent,
  ThreadId,
  type ProviderDaemonEventRecord,
  type ProviderRuntimeEvent as ProviderRuntimeEventValue,
} from "@cafecode/contracts";
import { PROVIDER_PIPELINE_POLICY, utf8ByteLength } from "@cafecode/shared/providerPipelinePolicy";
import { compactProviderRuntimeEvent } from "@cafecode/shared/providerRuntimeEventCompaction";
import {
  recordProviderCompaction,
  recordProviderQuarantinedRow,
} from "@cafecode/shared/providerPipelineDiagnostics";
import * as DateTime from "effect/DateTime";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const encodeProviderRuntimeEventJson = Schema.encodeSync(
  Schema.fromJsonString(ProviderRuntimeEvent),
);
const decodeProviderRuntimeEventJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(ProviderRuntimeEvent),
);

class ProviderDaemonEventDecodeError extends Data.TaggedError("ProviderDaemonEventDecodeError")<{
  readonly cause: unknown;
}> {}

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
  readonly replayPageAfter: (
    cursor: number,
    limit?: number,
  ) => Effect.Effect<ReadonlyArray<ProviderDaemonEventRecord>>;
  readonly subscribe: (listener: (record: ProviderDaemonEventRecord) => void) => () => void;
  readonly snapshot: Effect.Effect<ProviderDaemonEventJournalSnapshot>;
  /** Resolves after the bounded post-startup prune, compaction, and index work completes. */
  readonly startupMaintenance: Effect.Effect<void>;
}

export function createProviderDaemonEventJournal(options?: {
  readonly capacity?: number;
}): ProviderDaemonEventJournal {
  const capacity = Math.max(1, Math.trunc(options?.capacity ?? 50_000));
  const records: ProviderDaemonEventRecord[] = [];
  const listeners = new Set<(record: ProviderDaemonEventRecord) => void>();
  let nextCursor = 1;

  const publish = (event: ProviderRuntimeEventValue): ProviderDaemonEventRecord => {
    const compactedEvent = compactEventForJournal(event);
    const record: ProviderDaemonEventRecord = {
      cursor: nextCursor,
      emittedAt: new Date().toISOString(),
      event: compactedEvent,
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
const TURN_DIFF_JOURNAL_PREVIEW_CHARS = 4_096;
export const TURN_DIFF_JOURNAL_COMPACT_THRESHOLD_CHARS = 256 * 1024;
const TURN_DIFF_JOURNAL_COMPACT_BATCH_SIZE = 1;

interface PersistedEventRow {
  readonly cursor: number;
  readonly emittedAt: string;
  readonly eventJson: string;
}

const PROVIDER_DAEMON_QUARANTINE_THREAD_ID = ThreadId.make("provider-daemon-quarantine");

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

function hashTextSha256(text: string): string {
  return Crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function readRecordPayload(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function compactTurnDiffEventForJournal(
  event: ProviderRuntimeEventValue,
): ProviderRuntimeEventValue {
  if (event.type !== "turn.diff.updated") {
    return event;
  }

  const diff = event.payload.unifiedDiff;
  const rawPayload = readRecordPayload(event.raw?.payload);
  const rawDiff = typeof rawPayload.diff === "string" ? rawPayload.diff : undefined;
  const sourceDiff = rawDiff ?? diff;
  if (
    sourceDiff.length <= TURN_DIFF_JOURNAL_COMPACT_THRESHOLD_CHARS &&
    rawDiff === undefined &&
    diff.length <= TURN_DIFF_JOURNAL_PREVIEW_CHARS
  ) {
    return event;
  }

  const safeRawPayload = { ...rawPayload };
  delete safeRawPayload.diff;
  const diffPreview = sourceDiff.slice(0, TURN_DIFF_JOURNAL_PREVIEW_CHARS);
  return {
    ...event,
    payload: {
      unifiedDiff: diffPreview,
    },
    raw: {
      ...(event.raw ?? { source: "codex.app-server.notification" as const }),
      payload: {
        ...safeRawPayload,
        diffPreview,
        diffCharLength: sourceDiff.length,
        diffSha256: hashTextSha256(sourceDiff),
        diffTruncated: sourceDiff.length > TURN_DIFF_JOURNAL_PREVIEW_CHARS,
        compactedForProviderJournal: true,
      },
    },
  };
}

function compactEventForJournal(
  event: ProviderRuntimeEventValue,
  options?: { readonly historicalRepair?: boolean },
): ProviderRuntimeEventValue {
  // Keep the historical Codex diff metadata shape for compatibility with
  // existing diagnostics, then apply the canonical type-independent boundary
  // so command output and future provider payloads receive the same protection.
  const compacted = compactProviderRuntimeEvent(compactTurnDiffEventForJournal(event));
  recordProviderCompaction({
    originalBytes: compacted.stats.originalEncodedBytes,
    canonicalBytes: compacted.stats.compactedEncodedBytes,
    compacted: compacted.stats.compacted,
    ...(options?.historicalRepair === undefined
      ? {}
      : { historicalRepair: options.historicalRepair }),
  });
  return compacted.event;
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
    const startupMaintenanceReady = yield* Deferred.make<void>();
    let eventsSincePrune = 0;
    let eventIdIndexReady = false;

    // Quarantine stores metadata only. The malformed body is replaced in place
    // by a schema-valid cursor tombstone so replay can always advance without
    // retaining prompts, command output, credentials, paths, or raw errors in a
    // second forensic table.
    yield* sql`
      CREATE TABLE IF NOT EXISTS provider_daemon_event_quarantine (
        owner_key TEXT NOT NULL,
        cursor INTEGER NOT NULL,
        emitted_at TEXT NOT NULL,
        encoded_bytes INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        category TEXT NOT NULL,
        quarantined_at TEXT NOT NULL,
        PRIMARY KEY (owner_key, cursor)
      )
    `.pipe(Effect.orDie);

    const quarantinePersistedRow = Effect.fn(
      "ProviderDaemonPersistentEventJournal.quarantinePersistedRow",
    )(function* (row: PersistedEventRow, category: "schema-decode-failed") {
      const cursor = normalizeSqlNumber(row.cursor, 0);
      const sha256 = hashTextSha256(row.eventJson);
      const encodedBytes = utf8ByteLength(row.eventJson);
      const quarantinedAt = DateTime.formatIso(yield* DateTime.now);
      const tombstone: ProviderRuntimeEventValue = {
        eventId: EventId.make(`provider-daemon-quarantine-${cursor}-${sha256.slice(0, 16)}`),
        provider: ProviderDriverKind.make("provider-daemon"),
        threadId: PROVIDER_DAEMON_QUARANTINE_THREAD_ID,
        createdAt: row.emittedAt,
        type: "runtime.warning",
        payload: {
          message: "Provider daemon quarantined an incompatible event record",
          detail: {
            category: "provider-daemon-quarantine-gap",
            cursor,
            encodedBytes,
            sha256,
          },
        },
      };
      const tombstoneJson = encodeProviderRuntimeEventJson(tombstone);
      yield* sql`
        INSERT INTO provider_daemon_event_quarantine (
          owner_key,
          cursor,
          emitted_at,
          encoded_bytes,
          sha256,
          category,
          quarantined_at
        )
        VALUES (
          ${ownerKey},
          ${cursor},
          ${row.emittedAt},
          ${encodedBytes},
          ${sha256},
          ${category},
          ${quarantinedAt}
        )
        ON CONFLICT(owner_key, cursor) DO UPDATE SET
          encoded_bytes = excluded.encoded_bytes,
          sha256 = excluded.sha256,
          category = excluded.category,
          quarantined_at = excluded.quarantined_at
      `.pipe(Effect.orDie);
      yield* sql`
        UPDATE provider_daemon_events
        SET event_json = ${tombstoneJson}
        WHERE owner_key = ${ownerKey}
          AND cursor = ${cursor}
      `.pipe(Effect.orDie);
      recordProviderQuarantinedRow();
      return {
        cursor,
        emittedAt: row.emittedAt,
        event: tombstone,
      } satisfies ProviderDaemonEventRecord;
    });

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

    const compactLargeProviderEventRows = Effect.fn(
      "ProviderDaemonPersistentEventJournal.compactLargeProviderEventRows",
    )(function* (options?: { readonly afterCursor?: number }) {
      // This is intentionally a post-readiness bounded maintenance task, not a
      // migration. Older Cafe builds persisted repeated full Codex diffs and
      // arbitrarily large provider command payloads into the daemon journal.
      // Replaying those rows puts user-message and steer-processing events
      // behind megabytes of synchronous JSON work. Keep retained records
      // cryptographically identifiable while removing full bodies from the hot
      // restart/replay path.
      //
      // The batch size is deliberately one row. The inherited bad rows can be
      // roughly 30 MB each, and selecting many of them into JS before compaction
      // can OOM the daemon before the normal post-readiness maintenance gets a
      // chance to run. A one-row repair is slower, but it makes replay memory
      // bounded and preserves the complete event stream.
      const afterCursor = normalizeCursor(options?.afterCursor ?? 0);
      let compactedCount = TURN_DIFF_JOURNAL_COMPACT_BATCH_SIZE;
      while (compactedCount >= TURN_DIFF_JOURNAL_COMPACT_BATCH_SIZE) {
        const rows = (yield* sql`
          SELECT
            cursor,
            emitted_at AS "emittedAt",
            event_json AS "eventJson"
          FROM provider_daemon_events
          WHERE owner_key = ${ownerKey}
            AND cursor > ${afterCursor}
            AND length(event_json) > ${PROVIDER_PIPELINE_POLICY.canonicalEventMaxBytes}
          ORDER BY cursor ASC
          LIMIT ${TURN_DIFF_JOURNAL_COMPACT_BATCH_SIZE}
        `.pipe(Effect.orDie)) as unknown as ReadonlyArray<PersistedEventRow>;

        compactedCount = 0;
        for (const row of rows) {
          const originalEvent = yield* Effect.option(
            Effect.try({
              try: () => decodeProviderRuntimeEventJson(row.eventJson),
              catch: (cause) => new ProviderDaemonEventDecodeError({ cause }),
            }),
          );
          if (Option.isNone(originalEvent)) {
            yield* quarantinePersistedRow(row, "schema-decode-failed");
            compactedCount += 1;
            continue;
          }
          const compactedEvent = compactEventForJournal(originalEvent.value, {
            historicalRepair: true,
          });
          const compactedJson = encodeProviderRuntimeEventJson(compactedEvent);
          if (compactedJson === row.eventJson) {
            continue;
          }
          yield* sql`
            UPDATE provider_daemon_events
            SET event_json = ${compactedJson}
            WHERE owner_key = ${ownerKey}
              AND cursor = ${normalizeSqlNumber(row.cursor, 0)}
          `.pipe(Effect.orDie);
          compactedCount += 1;
        }

        if (compactedCount >= TURN_DIFF_JOURNAL_COMPACT_BATCH_SIZE) {
          yield* Effect.sleep(Duration.millis(PERSISTENT_JOURNAL_PRUNE_BATCH_PAUSE_MS));
        }
      }
    });

    yield* Effect.sleep(Duration.millis(startupPruneDelayMs)).pipe(
      Effect.andThen(pruneToCapacity()),
      Effect.andThen(compactLargeProviderEventRows()),
      Effect.andThen(ensureEventIdIndex()),
      Effect.ignoreCause({ log: true }),
      Effect.ensuring(Deferred.succeed(startupMaintenanceReady, undefined)),
      Effect.forkScoped,
      Effect.asVoid,
    );

    const replayPageAfter = (
      cursor: number,
      limit: number = PROVIDER_PIPELINE_POLICY.daemonReplayPageRecords,
    ): Effect.Effect<ReadonlyArray<ProviderDaemonEventRecord>> =>
      Effect.gen(function* () {
        const normalizedCursor = normalizeCursor(cursor);
        const normalizedLimit = Math.max(
          1,
          Math.min(
            capacity,
            Math.trunc(limit),
            Math.max(
              1,
              Math.floor(
                PROVIDER_PIPELINE_POLICY.daemonReplayPageBytes /
                  PROVIDER_PIPELINE_POLICY.canonicalEventMaxBytes,
              ),
            ),
          ),
        );
        // Reconnect replay is on the daemon request hot path. Do not decode
        // inherited giant Codex diff rows here; compact them first in bounded
        // one-row repairs so the replay remains complete without risking a
        // multi-gigabyte JS heap spike.
        yield* compactLargeProviderEventRows({ afterCursor: normalizedCursor });
        const rows = (yield* sql`
          SELECT
            cursor,
            emitted_at AS "emittedAt",
            event_json AS "eventJson"
          FROM provider_daemon_events
          WHERE owner_key = ${ownerKey}
            AND cursor > ${normalizedCursor}
          ORDER BY cursor ASC
          LIMIT ${normalizedLimit}
        `.pipe(Effect.orDie)) as unknown as ReadonlyArray<PersistedEventRow>;
        const records: ProviderDaemonEventRecord[] = [];
        for (const row of rows) {
          const record = yield* Effect.option(
            Effect.try({
              try: () => rowToRecord(row),
              catch: (cause) => new ProviderDaemonEventDecodeError({ cause }),
            }),
          );
          if (Option.isSome(record)) {
            records.push(record.value);
          } else {
            records.push(yield* quarantinePersistedRow(row, "schema-decode-failed"));
          }
        }
        return records;
      });

    const replayAfter = (cursor: number): Effect.Effect<ReadonlyArray<ProviderDaemonEventRecord>> =>
      replayPageAfter(cursor, capacity);

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
        const compactedEvent = compactEventForJournal(event);
        const eventId = runtimeEventId(compactedEvent);
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
            ${encodeProviderRuntimeEventJson(compactedEvent)}
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
      replayPageAfter,
      subscribe,
      snapshot,
      startupMaintenance: Deferred.await(startupMaintenanceReady),
    };
  }).pipe(Effect.orDie);
