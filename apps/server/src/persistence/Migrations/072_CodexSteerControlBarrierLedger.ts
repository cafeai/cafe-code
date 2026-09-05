import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Index Stop controls at append time so accepted-steer terminal recovery never
 * scans an arbitrarily old thread event suffix on node:sqlite's synchronous
 * main thread. This migration is deliberately schema-only: the production
 * event journal can contain tens of millions of rows, so backfilling historical
 * controls during startup would recreate the WebSocket starvation this ledger
 * exists to prevent.
 *
 * `indexed_from_sequence` is a durable completeness fence. Exact accepted
 * steers whose original intent predates this migration are not automatically
 * recovered unless another trusted path settles them; callers fail closed
 * rather than assuming the absent compact row proves that no historical Stop
 * occurred. New events are indexed transactionally by the trigger below.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS orchestration_codex_steer_control_barrier_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      indexed_from_sequence INTEGER NOT NULL CHECK (indexed_from_sequence >= 0)
    )
  `;
  yield* sql`
    INSERT INTO orchestration_codex_steer_control_barrier_state (
      singleton,
      indexed_from_sequence
    )
    SELECT
      1,
      COALESCE((SELECT MAX(sequence) + 1 FROM orchestration_events), 0)
    ON CONFLICT (singleton) DO NOTHING
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS orchestration_codex_steer_control_barriers (
      sequence INTEGER PRIMARY KEY,
      thread_id TEXT NOT NULL,
      barrier_kind TEXT NOT NULL CHECK (
        barrier_kind IN (
          'thread.turn-interrupt-requested',
          'thread.session-stop-requested'
        )
      ),
      turn_id TEXT,
      occurred_at TEXT NOT NULL,
      FOREIGN KEY (sequence)
        REFERENCES orchestration_events(sequence)
        ON DELETE CASCADE
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_codex_steer_control_thread_kind_turn_sequence
    ON orchestration_codex_steer_control_barriers(
      thread_id,
      barrier_kind,
      turn_id,
      sequence
    )
  `;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS trg_codex_steer_control_barrier_event
    AFTER INSERT ON orchestration_events
    WHEN NEW.aggregate_kind = 'thread'
      AND NEW.event_type IN (
        'thread.turn-interrupt-requested',
        'thread.session-stop-requested'
      )
      AND NEW.actor_kind IN ('client', 'server')
    BEGIN
      INSERT INTO orchestration_codex_steer_control_barriers (
        sequence,
        thread_id,
        barrier_kind,
        turn_id,
        occurred_at
      )
      SELECT
        NEW.sequence,
        NEW.stream_id,
        NEW.event_type,
        CASE
          WHEN NEW.event_type = 'thread.turn-interrupt-requested'
          THEN json_extract(NEW.payload_json, '$.turnId')
          ELSE NULL
        END,
        NEW.occurred_at
      WHERE json_extract(NEW.payload_json, '$.threadId') = NEW.stream_id
        AND json_extract(NEW.payload_json, '$.createdAt') = NEW.occurred_at
        AND (
          NEW.event_type = 'thread.session-stop-requested'
          OR json_type(NEW.payload_json, '$.turnId') IS NULL
          OR json_type(NEW.payload_json, '$.turnId') IN ('text', 'null')
        )
      ON CONFLICT (sequence) DO NOTHING;
    END
  `;
});
