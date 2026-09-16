import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Keep continuation consent separate from transcript volume and from the
 * prunable accepted-steer recovery ledger. This is schema-only: backfilling a
 * multi-million-event journal at startup would block the synchronous SQLite
 * event loop. The completeness fence makes pre-migration turns ineligible for
 * unattended synthetic continuation until fresh explicit user input arrives.
 *
 * Automatic runtime/terminal-steer recovery intents cannot release a Stop and
 * are deliberately not indexed. Repeated automatic restarts therefore neither
 * erase consent nor push its last real user intent out of the bounded window.
 * Title-only metadata is presentation, including automatic title generation;
 * only execution-affecting metadata invalidates continuation consent.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS orchestration_runtime_recovery_control_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      indexed_from_sequence INTEGER NOT NULL CHECK (indexed_from_sequence >= 0)
    )
  `;
  yield* sql`
    INSERT INTO orchestration_runtime_recovery_control_state (singleton, indexed_from_sequence)
    SELECT 1, COALESCE((SELECT MAX(sequence) + 1 FROM orchestration_events), 0)
    ON CONFLICT (singleton) DO NOTHING
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS orchestration_runtime_recovery_controls (
      sequence INTEGER PRIMARY KEY,
      thread_id TEXT NOT NULL,
      event_type TEXT NOT NULL CHECK (event_type IN (
        'thread.turn-start-requested', 'thread.turn-steer-requested',
        'thread.turn-interrupt-requested', 'thread.session-stop-requested',
        'thread.archived', 'thread.deleted', 'thread.meta-updated',
        'thread.runtime-mode-set', 'thread.interaction-mode-set',
        'thread.checkpoint-revert-requested', 'thread.reverted'
      )),
      turn_id TEXT,
      FOREIGN KEY (sequence) REFERENCES orchestration_events(sequence) ON DELETE CASCADE
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_runtime_recovery_controls_thread_sequence
    ON orchestration_runtime_recovery_controls(thread_id, sequence)
  `;
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS trg_runtime_recovery_control_event
    AFTER INSERT ON orchestration_events
    WHEN NEW.aggregate_kind = 'thread'
      AND NEW.actor_kind IN ('client', 'server')
      AND NEW.event_type IN (
        'thread.turn-start-requested', 'thread.turn-steer-requested',
        'thread.turn-interrupt-requested', 'thread.session-stop-requested',
        'thread.archived', 'thread.deleted', 'thread.meta-updated',
        'thread.runtime-mode-set', 'thread.interaction-mode-set',
        'thread.checkpoint-revert-requested', 'thread.reverted'
      )
    BEGIN
      INSERT INTO orchestration_runtime_recovery_controls (sequence, thread_id, event_type, turn_id)
      SELECT NEW.sequence, NEW.stream_id, NEW.event_type,
        CASE WHEN NEW.event_type = 'thread.turn-interrupt-requested'
          THEN json_extract(NEW.payload_json, '$.turnId') ELSE NULL END
      WHERE json_extract(NEW.payload_json, '$.threadId') = NEW.stream_id
        AND (
          (NEW.event_type IN ('thread.turn-start-requested', 'thread.turn-steer-requested')
            AND json_extract(NEW.payload_json, '$.createdAt') = NEW.occurred_at
            AND json_type(NEW.payload_json, '$.messageId') = 'text'
            AND json_type(NEW.payload_json, '$.runtimeRecovery') IS NULL
            AND json_type(NEW.payload_json, '$.terminalSteerRecovery') IS NULL)
          OR (NEW.event_type = 'thread.session-stop-requested'
            AND json_extract(NEW.payload_json, '$.createdAt') = NEW.occurred_at)
          OR (NEW.event_type = 'thread.turn-interrupt-requested'
            AND json_extract(NEW.payload_json, '$.createdAt') = NEW.occurred_at
            AND (json_type(NEW.payload_json, '$.turnId') IS NULL
              OR json_type(NEW.payload_json, '$.turnId') IN ('text', 'null')))
          OR (NEW.event_type = 'thread.meta-updated' AND (
            json_type(NEW.payload_json, '$.modelSelection') IS NOT NULL
            OR json_type(NEW.payload_json, '$.projectId') IS NOT NULL
            OR json_type(NEW.payload_json, '$.branch') IS NOT NULL
            OR json_type(NEW.payload_json, '$.worktreePath') IS NOT NULL
          ))
          OR NEW.event_type IN (
            'thread.archived', 'thread.deleted',
            'thread.runtime-mode-set', 'thread.interaction-mode-set',
            'thread.checkpoint-revert-requested', 'thread.reverted'
          )
        )
      ON CONFLICT (sequence) DO NOTHING;
    END
  `;
});
