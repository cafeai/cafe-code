import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Prospective schema/control indexing only: do not scan/rewrite historical commands or infer
 * requested/native policy for existing conversations. The known bits preserve
 * absent legacy evidence versus an explicit inherited/reset policy on both the
 * requested chat and the exact materialized session.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const table of ["projection_threads", "projection_thread_sessions"] as const) {
    yield* sql.unsafe(`ALTER TABLE ${table} ADD COLUMN codex_context_window_override INTEGER
      CHECK (codex_context_window_override IS NULL OR
        (typeof(codex_context_window_override) = 'integer' AND
          codex_context_window_override BETWEEN 1 AND 9007199254740991))`);
    yield* sql.unsafe(`ALTER TABLE ${table} ADD COLUMN codex_context_window_override_known INTEGER NOT NULL DEFAULT 0
      CHECK (codex_context_window_override_known IN (0, 1) AND
        (codex_context_window_override_known = 1 OR codex_context_window_override IS NULL))`);
  }
  // Context preference changes are explicit user configuration, so they must
  // cancel previously authorized automatic recovery just like model changes.
  // Add one narrow prospective index trigger without rewriting migration 77,
  // its prior controls, its completeness boundary, or any retained transcript.
  yield* sql`
    CREATE TRIGGER trg_codex_context_window_recovery_control
    AFTER INSERT ON orchestration_events
    WHEN NEW.aggregate_kind = 'thread'
      AND NEW.actor_kind IN ('client', 'server')
      AND NEW.event_type = 'thread.meta-updated'
      AND json_extract(NEW.payload_json, '$.threadId') = NEW.stream_id
      AND json_type(NEW.payload_json, '$.codexContextWindowOverride') IS NOT NULL
    BEGIN
      INSERT INTO orchestration_runtime_recovery_controls (sequence, thread_id, event_type, turn_id)
      VALUES (NEW.sequence, NEW.stream_id, NEW.event_type, NULL)
      ON CONFLICT (sequence) DO NOTHING;
    END
  `;
});
