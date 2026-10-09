import type { ThreadId } from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type * as SqlError from "effect/unstable/sql/SqlError";

import { isSqliteLockTimeoutError, readSqliteResultCode } from "../persistence/sqliteLockRetry.ts";
import { enrichLegacyActivityOrder } from "./legacyActivityOrder.ts";

/**
 * A hydration page is deliberately small because node:sqlite materializes it
 * synchronously on the server event loop. The exact thread/kind index keeps
 * each read finite; a real Node turn between pages protects socket liveness.
 */
export const SUBAGENT_LIFECYCLE_HYDRATION_PAGE_SIZE = 64;
const HYDRATION_LOCK_RETRIES = 2;
const HYDRATION_LOCK_RETRY_BASE_DELAY = "10 millis";
const LIFECYCLE_KINDS = ["task.started", "task.progress", "task.completed"] as const;

interface HydrationStateRow {
  readonly kind: (typeof LIFECYCLE_KINDS)[number];
  readonly cutoffCreatedAt: string | null;
  readonly cutoffActivityId: string | null;
  readonly cursorCreatedAt: string | null;
  readonly cursorActivityId: string | null;
}

interface HydrationStatusRow {
  readonly stateCount: number;
  readonly completedCount: number;
}

interface LegacyActivityRow {
  readonly threadId: string;
  readonly activityId: string;
  readonly turnId: string | null;
  readonly kind: string;
  readonly payloadJson: string;
  readonly createdAt: string;
  readonly sequence: number | null;
}

interface SourceCandidate extends Omit<LegacyActivityRow, "turnId"> {
  readonly turnId: string;
  readonly childId: string;
  readonly persistedSequence: number | null;
}

interface WriteAdmissionRow {
  readonly admitted: number;
}

export interface SubagentLifecycleHydrationResult {
  readonly complete: boolean;
  readonly retired: boolean;
  readonly advanced: boolean;
}

function isExactChildIdentity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    !/[\p{Cc}\p{Bidi_Control}]/u.test(value)
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Return every exact renderer lifecycle key carried by one activity.
 *
 * Ambient rows can deliberately carry both a presentation child and a
 * distinct task id. Both are authoritative deletion targets, so normalization
 * must retain both without trimming or case-folding either opaque identity.
 */
function lifecycleChildIds(row: LegacyActivityRow): ReadonlyArray<string> {
  // The renderer deliberately has no lifecycle identity for a null turn. Null
  // rows still participate in the hydration cursor so a large legacy prefix
  // cannot defeat the ordered index bound by forcing SQLite to search past it.
  if (row.turnId === null) return [];
  let decoded: unknown;
  try {
    decoded = JSON.parse(row.payloadJson) as unknown;
  } catch {
    return [];
  }
  const payload = asRecord(decoded);
  const subagent = asRecord(payload?.subagent);
  const presentationId = isExactChildIdentity(subagent?.threadId) ? subagent.threadId : undefined;
  const ambientTaskId =
    payload?.visibility === "ambient" && isExactChildIdentity(payload.taskId)
      ? payload.taskId
      : undefined;
  const workflow = asRecord(payload?.workflow);
  // Host-generated runtime UUIDs and configured account slugs are ASCII.
  // Match the narrow SQL sidecar gate without changing ordinary child IDs.
  const isWorkflowOwner = (value: unknown): value is string =>
    typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
  const workflowTaskId =
    isWorkflowOwner(workflow?.runtimeId) &&
    isWorkflowOwner(workflow?.providerInstanceId) &&
    typeof payload?.workflowRetentionId === "string" &&
    /^sha256:workflow:[a-f0-9]{64}$/.test(payload.workflowRetentionId)
      ? payload.workflowRetentionId
      : undefined;
  return [presentationId, ambientTaskId, workflowTaskId].filter(
    (identity, index, all): identity is string =>
      identity !== undefined && all.indexOf(identity) === index,
  );
}

function compareCanonicalNewest(left: LegacyActivityRow, right: LegacyActivityRow): number {
  const leftKnown = left.sequence === null ? 0 : 1;
  const rightKnown = right.sequence === null ? 0 : 1;
  return (
    rightKnown - leftKnown ||
    (right.sequence ?? -1) - (left.sequence ?? -1) ||
    right.createdAt.localeCompare(left.createdAt) ||
    right.activityId.localeCompare(left.activityId)
  );
}

function retryHydrationWrite<A>(
  effect: Effect.Effect<A, SqlError.SqlError>,
  operation: string,
): Effect.Effect<A, SqlError.SqlError> {
  let attempt = 0;
  return Effect.suspend(() => {
    attempt += 1;
    return effect.pipe(
      Effect.tapError((error) => {
        const sqliteResultCode = readSqliteResultCode(error);
        return Effect.logWarning(operation).pipe(
          Effect.annotateLogs({
            attempt,
            reason: error.reason._tag,
            ...(sqliteResultCode === undefined ? {} : { sqliteResultCode }),
          }),
        );
      }),
    );
  }).pipe(
    Effect.retry({
      schedule: Schedule.jittered(Schedule.exponential(HYDRATION_LOCK_RETRY_BASE_DELAY)),
      times: HYDRATION_LOCK_RETRIES,
      while: isSqliteLockTimeoutError,
    }),
  );
}

function initializeHydrationState(
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
): Effect.Effect<void, SqlError.SqlError> {
  const initialize = sql.withTransaction(
    sql`
      WITH lifecycle_kinds(kind) AS (
        VALUES ('task.started'), ('task.progress'), ('task.completed')
      ), cutoffs AS (
        SELECT
          thread.thread_id,
          lifecycle_kinds.kind,
          activity.created_at AS cutoff_created_at,
          activity.activity_id AS cutoff_activity_id
        FROM projection_threads AS thread
        CROSS JOIN lifecycle_kinds
        LEFT JOIN projection_thread_activities AS activity
          ON activity.activity_id = (
            SELECT candidate.activity_id
            FROM projection_thread_activities AS candidate
              INDEXED BY idx_projection_thread_activities_thread_kind_created_id
            WHERE candidate.thread_id = thread.thread_id
              AND candidate.kind = lifecycle_kinds.kind
            ORDER BY candidate.created_at DESC, candidate.activity_id DESC
            LIMIT 1
          )
        WHERE thread.thread_id = ${threadId}
          AND NOT EXISTS (
            SELECT 1 FROM hard_deleted_threads WHERE thread_id = thread.thread_id
          )
      )
      INSERT INTO projection_subagent_lifecycle_hydration(
        thread_id,
        kind,
        cutoff_created_at,
        cutoff_activity_id,
        cursor_created_at,
        cursor_activity_id,
        completed
      )
      SELECT
        thread_id,
        kind,
        cutoff_created_at,
        cutoff_activity_id,
        NULL,
        NULL,
        CASE WHEN cutoff_activity_id IS NULL THEN 1 ELSE 0 END
      FROM cutoffs
      WHERE 1
      ON CONFLICT (thread_id, kind) DO NOTHING
    `.pipe(Effect.asVoid),
  );
  return retryHydrationWrite(
    initialize,
    "SQLite subagent lifecycle hydration initialization failed",
  );
}

function readHydrationResult(
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
): Effect.Effect<SubagentLifecycleHydrationResult, SqlError.SqlError> {
  return Effect.gen(function* () {
    const status = yield* readHydrationStatus(sql, threadId);
    const stateCount = status?.stateCount ?? 0;
    const complete = stateCount === LIFECYCLE_KINDS.length && status?.completedCount === stateCount;
    return {
      complete,
      retired: stateCount === 0,
      advanced: false,
    };
  });
}

function readHydrationStatus(
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
): Effect.Effect<HydrationStatusRow | undefined, SqlError.SqlError> {
  return sql<HydrationStatusRow>`
    SELECT
      COUNT(*) AS "stateCount",
      COALESCE(SUM(completed), 0) AS "completedCount"
    FROM projection_subagent_lifecycle_hydration
    WHERE thread_id = ${threadId}
  `.pipe(Effect.map((rows) => rows[0]));
}

/** Read whether the compact all-turn lifecycle view is safe to expose. */
export function isSubagentLifecycleHydrationComplete(
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
): Effect.Effect<boolean, SqlError.SqlError> {
  return readHydrationResult(sql, threadId).pipe(Effect.map((result) => result.complete));
}

/**
 * Hydrate at most one exact-thread/kind page.
 *
 * The cutoff/cursor scan never parses rows outside the selected thread. The
 * page is enriched from exact indexed journal witnesses before source rows are
 * written. The write transaction begins by claiming the durable cursor row;
 * a hard-delete that wins first removes that row, while a purge that waits
 * removes every sidecar row after this transaction commits.
 */
export function hydrateSubagentLifecyclePage(
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
): Effect.Effect<SubagentLifecycleHydrationResult, SqlError.SqlError> {
  return Effect.gen(function* () {
    const existingStatus = yield* readHydrationStatus(sql, threadId);
    if (
      existingStatus?.stateCount === LIFECYCLE_KINDS.length &&
      existingStatus.completedCount === LIFECYCLE_KINDS.length
    ) {
      return { complete: true, retired: false, advanced: false };
    }
    // A valid initialization transaction creates all three rows atomically.
    // Skip a needless writer acquisition on every incomplete page, while still
    // repairing an absent/externally damaged partial set idempotently.
    if (existingStatus?.stateCount !== LIFECYCLE_KINDS.length) {
      yield* initializeHydrationState(sql, threadId);
    }
    const [state] = yield* sql<HydrationStateRow>`
      SELECT
        kind,
        cutoff_created_at AS "cutoffCreatedAt",
        cutoff_activity_id AS "cutoffActivityId",
        cursor_created_at AS "cursorCreatedAt",
        cursor_activity_id AS "cursorActivityId"
      FROM projection_subagent_lifecycle_hydration
      WHERE thread_id = ${threadId}
        AND completed = 0
      ORDER BY CASE kind
        WHEN 'task.started' THEN 0
        WHEN 'task.progress' THEN 1
        ELSE 2
      END
      LIMIT 1
    `;
    if (state === undefined) {
      return yield* readHydrationResult(sql, threadId);
    }

    // Keep the initial and resumed predicates as separate static statements.
    // An `OR cursor IS NULL` shape prevents SQLite from applying a direct tuple
    // range and can rescan an ever-growing newest prefix on later pages.
    const page =
      state.cursorCreatedAt === null
        ? yield* sql<LegacyActivityRow>`
            SELECT
              thread_id AS "threadId",
              activity_id AS "activityId",
              turn_id AS "turnId",
              kind,
              payload_json AS "payloadJson",
              created_at AS "createdAt",
              sequence
            FROM projection_thread_activities
              INDEXED BY idx_projection_thread_activities_thread_kind_created_id
            WHERE thread_id = ${threadId}
              AND kind = ${state.kind}
              AND (created_at, activity_id) <= (${state.cutoffCreatedAt}, ${state.cutoffActivityId})
            ORDER BY created_at DESC, activity_id DESC
            LIMIT ${SUBAGENT_LIFECYCLE_HYDRATION_PAGE_SIZE}
          `
        : yield* sql<LegacyActivityRow>`
            SELECT
              thread_id AS "threadId",
              activity_id AS "activityId",
              turn_id AS "turnId",
              kind,
              payload_json AS "payloadJson",
              created_at AS "createdAt",
              sequence
            FROM projection_thread_activities
              INDEXED BY idx_projection_thread_activities_thread_kind_created_id
            WHERE thread_id = ${threadId}
              AND kind = ${state.kind}
              AND (created_at, activity_id) < (${state.cursorCreatedAt}, ${state.cursorActivityId})
            ORDER BY created_at DESC, activity_id DESC
            LIMIT ${SUBAGENT_LIFECYCLE_HYDRATION_PAGE_SIZE}
          `;
    const enriched = yield* enrichLegacyActivityOrder(sql, page);
    const originalSequenceByActivityId = new Map(
      page.map((row) => [row.activityId, row.sequence] as const),
    );
    const candidates: SourceCandidate[] = enriched
      .toSorted(compareCanonicalNewest)
      .flatMap((row) => {
        const turnId = row.turnId;
        if (turnId === null) return [];
        return lifecycleChildIds(row).map((childId) => ({
          threadId: row.threadId,
          activityId: row.activityId,
          turnId,
          kind: row.kind,
          payloadJson: row.payloadJson,
          createdAt: row.createdAt,
          sequence: row.sequence,
          childId,
          persistedSequence: originalSequenceByActivityId.get(row.activityId) ?? null,
        }));
      });
    const lastPageRow = page.at(-1);
    const nextCursorCreatedAt =
      lastPageRow?.createdAt ?? state.cursorCreatedAt ?? state.cutoffCreatedAt;
    const nextCursorActivityId =
      lastPageRow?.activityId ?? state.cursorActivityId ?? state.cutoffActivityId;
    const pageCompleted = page.length < SUBAGENT_LIFECYCLE_HYDRATION_PAGE_SIZE;

    const writePage = sql.withTransaction(
      Effect.gen(function* () {
        // This no-op UPDATE is intentionally the first statement in the
        // transaction. It acquires SQLite's sole writer before any tombstone
        // observation and rejects a stale competing page by matching the exact
        // durable cursor that produced the bounded read above.
        const admission = yield* sql<WriteAdmissionRow>`
          UPDATE projection_subagent_lifecycle_hydration
          SET completed = completed
          WHERE thread_id = ${threadId}
            AND kind = ${state.kind}
            AND completed = 0
            AND cutoff_created_at IS ${state.cutoffCreatedAt}
            AND cutoff_activity_id IS ${state.cutoffActivityId}
            AND cursor_created_at IS ${state.cursorCreatedAt}
            AND cursor_activity_id IS ${state.cursorActivityId}
            AND NOT EXISTS (
              SELECT 1 FROM hard_deleted_threads WHERE thread_id = ${threadId}
            )
          RETURNING 1 AS admitted
        `;
        if (admission.length === 0) return false;

        if (candidates.length > 0) {
          const candidateValues = sql.join(
            ",",
            false,
          )(
            candidates.map(
              (candidate) => sql`(
                ${candidate.activityId},
                ${candidate.threadId},
                ${candidate.turnId},
                ${candidate.childId},
                ${candidate.kind},
                ${candidate.sequence},
                ${candidate.createdAt},
                ${candidate.payloadJson},
                ${candidate.persistedSequence}
              )`,
            ),
          );
          yield* sql`
            WITH candidate(
              activity_id,
              thread_id,
              turn_id,
              child_id,
              kind,
              recovered_sequence,
              created_at,
              payload_json,
              persisted_sequence
            ) AS (VALUES ${candidateValues})
            INSERT INTO projection_subagent_lifecycle_sources(
              activity_id,
              thread_id,
              turn_id,
              child_id,
              kind,
              sequence_known,
              sequence,
              created_at
            )
            SELECT
              candidate.activity_id,
              candidate.thread_id,
              candidate.turn_id,
              candidate.child_id,
              candidate.kind,
              CASE WHEN candidate.recovered_sequence IS NULL THEN 0 ELSE 1 END,
              candidate.recovered_sequence,
              candidate.created_at
            FROM candidate
            INNER JOIN projection_thread_activities AS activity
              ON activity.activity_id = candidate.activity_id
              AND activity.thread_id = candidate.thread_id
              AND activity.turn_id = candidate.turn_id
              AND activity.kind = candidate.kind
              AND activity.created_at = candidate.created_at
              AND activity.payload_json = candidate.payload_json
              AND activity.sequence IS candidate.persisted_sequence
            WHERE NOT EXISTS (
              SELECT 1 FROM hard_deleted_threads WHERE thread_id = ${threadId}
            )
            ON CONFLICT (activity_id, child_id) DO NOTHING
          `;
        }

        yield* sql`
          UPDATE projection_subagent_lifecycle_hydration
          SET
            cursor_created_at = ${nextCursorCreatedAt},
            cursor_activity_id = ${nextCursorActivityId},
            completed = CASE WHEN ${pageCompleted ? 1 : 0} = 1 THEN 1 ELSE completed END
          WHERE thread_id = ${threadId}
            AND kind = ${state.kind}
        `;
        return true;
      }),
    );
    const advanced = yield* retryHydrationWrite(
      writePage,
      "SQLite subagent lifecycle hydration page failed",
    );
    const result = yield* readHydrationResult(sql, threadId);
    return { ...result, advanced };
  });
}

/** Finish one selected thread with finite pages and real event-loop yields. */
export function hydrateSubagentLifecycleForThread(
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
): Effect.Effect<SubagentLifecycleHydrationResult, SqlError.SqlError> {
  return Effect.gen(function* () {
    let result = yield* hydrateSubagentLifecyclePage(sql, threadId);
    while (!result.complete && !result.retired) {
      yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));
      result = yield* hydrateSubagentLifecyclePage(sql, threadId);
    }
    return result;
  });
}
