import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Schema-only: scheduling never backfills or scans conversation transcripts. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE scheduled_followups (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES projection_threads(thread_id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK (revision > 0),
    state TEXT NOT NULL CHECK (state IN ('pending_confirmation','active','paused','completed','needs_attention','deleted')),
    definition_json TEXT NOT NULL CHECK (json_valid(definition_json)),
    authorized_instance_id TEXT NOT NULL,
    permission_ceiling TEXT NOT NULL,
    next_run_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    run_count INTEGER NOT NULL DEFAULT 0 CHECK (run_count >= 0)
  )`;
  yield* sql`CREATE INDEX idx_scheduled_followups_due ON scheduled_followups(state,next_run_at)`;
  yield* sql`CREATE INDEX idx_scheduled_followups_thread ON scheduled_followups(thread_id,created_at,id)`;
  yield* sql`CREATE TABLE scheduled_followup_runs (
    id TEXT PRIMARY KEY,
    schedule_id TEXT NOT NULL REFERENCES scheduled_followups(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL,
    thread_id TEXT NOT NULL,
    due_at TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('waiting','dispatching','running','completed','failed','interrupted','unknown','skipped')),
    command_id TEXT NOT NULL UNIQUE,
    message_id TEXT NOT NULL UNIQUE,
    intent_sequence INTEGER,
    turn_id TEXT,
    model_json TEXT CHECK (model_json IS NULL OR json_valid(model_json)),
    created_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    result TEXT CHECK (result IS NULL OR result IN ('no-change','changed')),
    summary TEXT,
    error_code TEXT,
    attempt_at TEXT,
    command_json TEXT CHECK (command_json IS NULL OR json_valid(command_json)),
    inspected_at TEXT NOT NULL DEFAULT '',
    reported_finish INTEGER NOT NULL DEFAULT 0 CHECK (reported_finish IN (0,1)),
    UNIQUE(schedule_id,revision,due_at)
  )`;
  yield* sql`CREATE INDEX idx_scheduled_followup_runs_history ON scheduled_followup_runs(schedule_id,created_at DESC,id DESC)`;
  yield* sql`CREATE INDEX idx_scheduled_followup_runs_thread_turn ON scheduled_followup_runs(thread_id,turn_id)`;
  yield* sql`CREATE INDEX idx_scheduled_followup_runs_thread_message ON scheduled_followup_runs(thread_id,message_id)`;
  // Exact pending-message reconciliation must remain cheap in mature chats;
  // the preexisting native-turn index does not cover this restart lookup.
  yield* sql`CREATE INDEX idx_projection_turns_thread_pending_message ON projection_turns(thread_id,pending_message_id)`;
  yield* sql`CREATE INDEX idx_scheduled_followup_runs_state ON scheduled_followup_runs(state,inspected_at,created_at)`;
  yield* sql`CREATE INDEX idx_scheduled_followup_runs_unattempted_intent ON scheduled_followup_runs(intent_sequence)
    WHERE state = 'dispatching' AND attempt_at IS NULL`;
  yield* sql`CREATE INDEX idx_scheduled_followup_runs_active_thread ON scheduled_followup_runs(thread_id)
    WHERE state IN ('dispatching','running','unknown')`;
  // One unfinished occurrence per schedule, across revisions. Editing a running
  // schedule cannot create a second run alongside the already accepted one.
  yield* sql`CREATE UNIQUE INDEX idx_scheduled_followup_runs_unfinished ON scheduled_followup_runs(schedule_id)
    WHERE state IN ('waiting','dispatching','running','unknown')`;
  // Stop is accepted before its provider side effect. Fence schedules in that
  // same durable commit, rather than waiting for a timer or renderer callback.
  // Pausing does not kill a provider: ordinary Stop owns that separate action.
  yield* sql`CREATE TRIGGER trg_scheduled_followups_stop
    AFTER INSERT ON orchestration_runtime_recovery_controls
    WHEN NEW.event_type IN ('thread.turn-interrupt-requested','thread.session-stop-requested','thread.archived','thread.deleted')
    BEGIN
      UPDATE scheduled_followups SET state = CASE WHEN NEW.event_type = 'thread.deleted' THEN 'deleted' ELSE 'paused' END,
        revision = revision + 1, next_run_at = NULL,
        updated_at = (SELECT occurred_at FROM orchestration_events WHERE sequence = NEW.sequence)
      WHERE thread_id = NEW.thread_id AND state IN ('active','pending_confirmation','needs_attention');
      UPDATE scheduled_followup_runs SET state = 'skipped', error_code = 'user-control',
        completed_at = (SELECT occurred_at FROM orchestration_events WHERE sequence = NEW.sequence)
      WHERE thread_id = NEW.thread_id AND state IN ('waiting','dispatching') AND attempt_at IS NULL;
    END`;
});
