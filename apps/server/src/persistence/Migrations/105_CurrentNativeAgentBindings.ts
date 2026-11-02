import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { NonNegativeInt } from "@cafecode/contracts";

import { ProjectionThreadActivity } from "../Services/ProjectionThreadActivities.ts";
import {
  MAX_NATIVE_AGENT_BINDING_PAYLOAD_BYTES,
  upsertNativeAgentBinding,
} from "../nativeAgentBindings.ts";

const PAGE_SIZE = 64;
const encodePointersJson = Schema.encodeSync(Schema.UnknownFromJsonString);
const isActivity = Schema.is(ProjectionThreadActivity);

/**
 * Replace repeated historical start hydration with a private, append-maintained
 * native binding. The one-time backfill visits only normalized latest-start
 * pointers and NULL-turn starts in keyset pages. Its working set is bounded; total migration work
 * still depends on the existing pointer count and holds the migrator's outer
 * transaction until completion. No history or native provider is modified.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE projection_native_agent_bindings (
      thread_id TEXT NOT NULL,
      runtime_id TEXT NOT NULL CHECK (length(runtime_id) = 36),
      work_id TEXT NOT NULL CHECK (length(work_id) BETWEEN 1 AND 512),
      turn_id TEXT,
      activity_id TEXT NOT NULL,
      sequence_known INTEGER NOT NULL CHECK (sequence_known IN (0, 1)),
      sequence INTEGER CHECK (sequence IS NULL OR (typeof(sequence) = 'integer' AND sequence >= 0)),
      activity_sequence INTEGER CHECK (activity_sequence IS NULL OR
        (typeof(activity_sequence) = 'integer' AND activity_sequence >= 0)),
      created_at TEXT NOT NULL,
      payload_json TEXT NOT NULL CHECK (
        -- SQLite DDL cannot bind parameters. This literal is the same private
        -- witness byte ceiling as MAX_NATIVE_AGENT_BINDING_PAYLOAD_BYTES.
        json_valid(payload_json) AND length(CAST(payload_json AS BLOB)) <= 1048576
      ),
      valid INTEGER NOT NULL CHECK (valid IN (0, 1)),
      CHECK (sequence_known = CASE WHEN sequence IS NULL THEN 0 ELSE 1 END),
      PRIMARY KEY (thread_id, runtime_id, work_id),
      FOREIGN KEY (thread_id) REFERENCES projection_threads(thread_id) ON DELETE CASCADE
    ) WITHOUT ROWID
  `;
  // Activity updates are a high-rate path. Exact invalidation must be an
  // indexed source-id lookup rather than a scan of every thread's bindings.
  yield* sql`
    CREATE INDEX idx_projection_native_agent_bindings_activity
      ON projection_native_agent_bindings(activity_id)
  `;
  // The same exact-source invalidation retires ordinary task/tool heads too.
  // Keep these high-rate activity updates/deletes on their admitted source-id
  // range instead of scanning all retained per-turn work for every refresh.
  yield* sql`
    CREATE INDEX idx_projection_live_work_activity
      ON projection_live_work(activity_id)
  `;
  yield* sql`
    CREATE TRIGGER trg_native_agent_bindings_hard_deleted_insert
    BEFORE INSERT ON projection_native_agent_bindings
    WHEN EXISTS (SELECT 1 FROM hard_deleted_threads WHERE thread_id = NEW.thread_id)
    BEGIN
      SELECT RAISE(ABORT, 'hard-deleted thread is permanently retired');
    END
  `;
  yield* sql`
    CREATE TRIGGER trg_native_agent_bindings_hard_deleted_update
    BEFORE UPDATE ON projection_native_agent_bindings
    WHEN EXISTS (SELECT 1 FROM hard_deleted_threads WHERE thread_id = NEW.thread_id)
    BEGIN
      SELECT RAISE(ABORT, 'hard-deleted thread is permanently retired');
    END
  `;
  // Keep the last owner/order watermark after evidence is edited or removed.
  // Deleting it would let a delayed older start refill an apparently empty
  // slot. Invalid means unconfirmed presentation, never provider completion.
  // Drop the invalidated payload witness while keeping only owner/order
  // metadata. A fully qualified replay of the same exact owner, or a newer
  // admitted explicit start, can renew it in the repository transaction.
  // A work head cannot survive changes to its source identity/payload either.
  // Normal repository writes update the activity first, then qualify/reinsert
  // its prepared exact work observation in that same transaction. Unsupported
  // or direct source edits leave unknown presentation, never stale liveness.
  yield* sql`
    CREATE TRIGGER trg_native_agent_binding_source_update
    AFTER UPDATE OF activity_id, thread_id, turn_id, kind, sequence, created_at, payload_json
      ON projection_thread_activities
    WHEN (NEW.activity_id IS NOT OLD.activity_id OR NEW.thread_id IS NOT OLD.thread_id
      OR NEW.turn_id IS NOT OLD.turn_id OR NEW.kind IS NOT OLD.kind
      OR NEW.sequence IS NOT OLD.sequence OR NEW.created_at IS NOT OLD.created_at
      OR NEW.payload_json IS NOT OLD.payload_json)
    BEGIN
      DELETE FROM projection_live_work WHERE activity_id = OLD.activity_id;
      UPDATE projection_native_agent_bindings SET valid = 0, payload_json = 'null'
      WHERE activity_id = OLD.activity_id AND NOT EXISTS (
        SELECT 1 FROM hard_deleted_threads
        WHERE thread_id = projection_native_agent_bindings.thread_id
      );
    END
  `;
  yield* sql`
    CREATE TRIGGER trg_native_agent_binding_source_delete
    AFTER DELETE ON projection_thread_activities
    BEGIN
      DELETE FROM projection_live_work WHERE activity_id = OLD.activity_id;
      UPDATE projection_native_agent_bindings SET valid = 0, payload_json = 'null'
      WHERE activity_id = OLD.activity_id AND NOT EXISTS (
        SELECT 1 FROM hard_deleted_threads
        WHERE thread_id = projection_native_agent_bindings.thread_id
      );
    END
  `;
  // The hard-delete implementation also supports legacy FK-disabled handles.
  // This trigger retains ownership cleanup even on those connections.
  yield* sql`
    CREATE TRIGGER trg_native_agent_bindings_thread_delete
    AFTER DELETE ON projection_threads
    BEGIN
      DELETE FROM projection_native_agent_bindings WHERE thread_id = OLD.thread_id;
    END
  `;

  // Kind is the final column of the normalized table's primary key. This
  // migration-owned covering index makes a page mean at most 64 START pointers,
  // rather than an unbounded walk through progress-only identities. Building
  // it is one-time metadata work; remove it after the backfill so ordinary
  // lifecycle ingestion does not maintain an otherwise-unused index.
  yield* sql`
    CREATE INDEX idx_native_agent_binding_backfill_starts
      ON projection_subagent_lifecycle_latest(thread_id, turn_id, child_id, activity_id, sequence)
      WHERE kind = 'task.started'
  `;
  // The older normalized lifecycle table deliberately omitted NULL-turn work.
  // Its pointers therefore cannot discover an inter-root start that superseded
  // an older turn-bound owner. This temporary partial index visits only those
  // missing START candidates, without hydrating ordinary activity payloads.
  yield* sql`
    CREATE INDEX idx_native_agent_binding_backfill_null_starts
      ON projection_thread_activities(thread_id, activity_id)
      WHERE kind = 'task.started' AND turn_id IS NULL
  `;

  const pagePointers = SqlSchema.findAll({
    Request: Schema.Struct({
      threadId: Schema.String,
      turnId: Schema.String,
      childId: Schema.String,
    }),
    Result: Schema.Struct({
      threadId: Schema.String,
      turnId: Schema.String,
      childId: Schema.String,
      activityId: Schema.String,
      sequence: Schema.NullOr(NonNegativeInt),
      sequenceValid: Schema.Number,
    }),
    execute: (cursor) => sql`
      SELECT thread_id AS "threadId", turn_id AS "turnId", child_id AS "childId",
        activity_id AS "activityId",
        CASE WHEN sequence IS NULL OR sequence BETWEEN 0 AND 9007199254740991
          THEN sequence ELSE NULL END AS sequence,
        CASE WHEN sequence IS NULL OR sequence BETWEEN 0 AND 9007199254740991
          THEN 1 ELSE 0 END AS "sequenceValid"
      FROM projection_subagent_lifecycle_latest INDEXED BY idx_native_agent_binding_backfill_starts
      WHERE kind = 'task.started'
        AND (thread_id, turn_id, child_id) > (${cursor.threadId}, ${cursor.turnId}, ${cursor.childId})
      ORDER BY thread_id, turn_id, child_id LIMIT ${PAGE_SIZE}
    `,
  });
  const pageSources = SqlSchema.findAll({
    Request: Schema.String,
    Result: Schema.Struct({
      activityId: Schema.String,
      threadId: Schema.String,
      turnId: Schema.NullOr(Schema.String),
      sequence: Schema.NullOr(NonNegativeInt),
      payloadJson: Schema.String,
      activitySequence: Schema.NullOr(NonNegativeInt),
      activitySequenceValid: Schema.Number,
      createdAt: Schema.String,
    }),
    execute: (pointersJson) => sql`
      SELECT activity.activity_id AS "activityId", activity.thread_id AS "threadId",
        activity.turn_id AS "turnId",
        CASE WHEN typeof(activity.payload_json) = 'text'
          AND length(CAST(activity.payload_json AS BLOB)) <= ${MAX_NATIVE_AGENT_BINDING_PAYLOAD_BYTES}
          THEN activity.payload_json ELSE 'null' END AS "payloadJson",
        json_extract(pointer.value, '$.sequence') AS sequence,
        CASE WHEN activity.sequence IS NULL OR
          (typeof(activity.sequence) = 'integer' AND activity.sequence BETWEEN 0 AND 9007199254740991)
          THEN activity.sequence ELSE NULL END AS "activitySequence",
        CASE WHEN activity.sequence IS NULL OR
          (typeof(activity.sequence) = 'integer' AND activity.sequence BETWEEN 0 AND 9007199254740991)
          THEN 1 ELSE 0 END AS "activitySequenceValid",
        CASE WHEN length(activity.created_at) <= 128 THEN activity.created_at ELSE '' END AS "createdAt"
      FROM json_each(${pointersJson}) AS pointer
      JOIN projection_thread_activities AS activity
        ON activity.activity_id = json_extract(pointer.value, '$.activityId')
          AND activity.thread_id = json_extract(pointer.value, '$.threadId')
          AND activity.turn_id IS json_extract(pointer.value, '$.turnId')
          AND activity.kind = 'task.started'
      WHERE json_extract(pointer.value, '$.sequenceValid') = 1 AND NOT EXISTS (
        SELECT 1 FROM hard_deleted_threads WHERE thread_id = activity.thread_id
      )
    `,
  });
  const pageNullPointers = SqlSchema.findAll({
    Request: Schema.Struct({ threadId: Schema.String, activityId: Schema.String }),
    Result: Schema.Struct({
      threadId: Schema.String,
      turnId: Schema.Null,
      activityId: Schema.String,
      sequence: Schema.NullOr(NonNegativeInt),
      sequenceValid: Schema.Number,
    }),
    execute: (cursor) => sql`
      SELECT thread_id AS "threadId", NULL AS "turnId", activity_id AS "activityId",
        CASE WHEN sequence IS NULL OR
          (typeof(sequence) = 'integer' AND sequence BETWEEN 0 AND 9007199254740991)
          THEN sequence ELSE NULL END AS sequence,
        CASE WHEN sequence IS NULL OR
          (typeof(sequence) = 'integer' AND sequence BETWEEN 0 AND 9007199254740991)
          THEN 1 ELSE 0 END AS "sequenceValid"
      FROM projection_thread_activities INDEXED BY idx_native_agent_binding_backfill_null_starts
      WHERE kind = 'task.started' AND turn_id IS NULL
        AND (thread_id, activity_id) > (${cursor.threadId}, ${cursor.activityId})
      ORDER BY thread_id, activity_id LIMIT ${PAGE_SIZE}
    `,
  });
  const admitPage = (pointersJson: string) =>
    Effect.gen(function* () {
      const rows = yield* pageSources(pointersJson);
      for (const row of rows) {
        // Legacy/corrupt metadata is not native evidence. Validate a minimal
        // source DTO without hydrating historical prose, and leave unsupported
        // records unknown while advancing the independent pointer cursor.
        const source = {
          activityId: row.activityId,
          threadId: row.threadId,
          turnId: row.turnId,
          tone: "info",
          kind: "task.started",
          summary: "Native agent binding",
          payload: null,
          createdAt: row.createdAt,
          ...(row.sequence === null ? {} : { sequence: row.sequence }),
        };
        if (row.activitySequenceValid !== 1 || !isActivity(source)) continue;
        yield* upsertNativeAgentBinding(sql, source, row.payloadJson, row.activitySequence);
      }
    });
  let cursor = { threadId: "", turnId: "", childId: "" };
  while (true) {
    const pointers = yield* pagePointers(cursor);
    if (pointers.length === 0) break;
    yield* admitPage(encodePointersJson(pointers));
    // Advance by admitted pointers even when a whole page is tombstoned,
    // missing or malformed. Filtering source rows must never stop discovery of
    // later pointers or spin on an unqualified page.
    const last = pointers[pointers.length - 1]!;
    cursor = {
      threadId: last.threadId,
      turnId: last.turnId,
      childId: last.childId,
    };
    // Node's SQLite client executes synchronously. A native callback boundary
    // between pages lets timers, HTTP and the migration progress pipe run;
    // a fiber-only yield does not establish that event-loop opportunity.
    yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));
  }
  let nullCursor = { threadId: "", activityId: "" };
  while (true) {
    const pointers = yield* pageNullPointers(nullCursor);
    if (pointers.length === 0) break;
    yield* admitPage(encodePointersJson(pointers));
    // Advance from discovered metadata even if every candidate is malformed,
    // tombstoned or oversized. Reuse the exact bounded qualification above.
    const last = pointers[pointers.length - 1]!;
    nullCursor = { threadId: last.threadId, activityId: last.activityId };
    yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));
  }
  yield* sql`DROP INDEX idx_native_agent_binding_backfill_starts`;
  yield* sql`DROP INDEX idx_native_agent_binding_backfill_null_starts`;
});
