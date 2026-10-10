import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Append-time lookup only: never scan old transcript JSON during startup.
 * Every entry is reauthenticated against its immutable source before use.
 * This retains ambiguous submission evidence across arbitrarily long turns;
 * a missing ACK must not disappear from a bounded transcript window and turn
 * into permission to submit a new continuation.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS orchestration_codex_transient_recovery_intents (
      sequence INTEGER PRIMARY KEY REFERENCES orchestration_events(sequence) ON DELETE CASCADE,
      thread_id TEXT NOT NULL,
      source_kind TEXT NOT NULL DEFAULT 'intent' CHECK (source_kind IN ('intent', 'failure'))
    )
  `;
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS trg_codex_transient_recovery_failure_insert
    AFTER INSERT ON orchestration_events
    WHEN NEW.aggregate_kind = 'thread' AND NEW.actor_kind = 'server'
      AND NEW.event_type = 'thread.activity-appended'
      AND json_extract(NEW.payload_json, '$.threadId') = NEW.stream_id
      AND json_extract(NEW.payload_json, '$.activity.kind') = 'runtime.warning'
      AND json_type(NEW.payload_json, '$.activity.turnId') = 'text'
      AND json_extract(NEW.payload_json, '$.activity.payload.recovery') = 'codex-transient-root-failed'
    BEGIN
      INSERT INTO orchestration_codex_transient_recovery_intents(sequence, thread_id, source_kind)
      VALUES (NEW.sequence, NEW.stream_id, 'failure');
    END
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_codex_transient_recovery_intents_thread_sequence
    ON orchestration_codex_transient_recovery_intents(thread_id, sequence)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_codex_transient_recovery_intents_thread_kind_sequence
    ON orchestration_codex_transient_recovery_intents(thread_id, source_kind, sequence)
  `;
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS trg_codex_transient_recovery_intent_insert
    AFTER INSERT ON orchestration_events
    WHEN NEW.aggregate_kind = 'thread' AND NEW.actor_kind = 'server'
      AND NEW.event_type = 'thread.turn-start-requested'
      AND json_extract(NEW.payload_json, '$.threadId') = NEW.stream_id
      AND json_type(NEW.payload_json, '$.runtimeRecovery.codexTransientFailure') = 'object'
    BEGIN
      INSERT INTO orchestration_codex_transient_recovery_intents(sequence, thread_id)
      VALUES (NEW.sequence, NEW.stream_id);
    END
  `;
});
