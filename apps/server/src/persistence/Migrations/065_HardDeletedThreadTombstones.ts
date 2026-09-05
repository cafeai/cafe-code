import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Make a hard-deleted thread id permanently non-reusable.
 *
 * Provider daemons and orchestration workers can be separate processes. A
 * process that was already holding an event when the UI requested deletion
 * must therefore meet a database-level fence, not merely a process-local Set.
 * The tombstone is intentionally tiny and append-only; it contains no prompt,
 * provider cursor, workspace path, or other private provider material.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS hard_deleted_threads (
      thread_id TEXT PRIMARY KEY,
      deleted_at TEXT NOT NULL
    ) WITHOUT ROWID
  `;

  // A hard-delete tombstone is a permanent identity fence. Updates or deletes
  // would let a stale daemon reuse an old Cafe thread id after a restart.
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS trg_hard_deleted_threads_no_update
    BEFORE UPDATE ON hard_deleted_threads
    BEGIN
      SELECT RAISE(ABORT, 'hard-deleted thread tombstones are immutable');
    END
  `;
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS trg_hard_deleted_threads_no_delete
    BEFORE DELETE ON hard_deleted_threads
    BEGIN
      SELECT RAISE(ABORT, 'hard-deleted thread tombstones are permanent');
    END
  `;

  // Orchestration events and receipts are the authoritative command ingress.
  // Guard both because an invariant-rejected command can write a receipt
  // without first appending an event.
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS trg_orchestration_events_hard_deleted_thread_insert
    BEFORE INSERT ON orchestration_events
    WHEN NEW.aggregate_kind = 'thread'
      AND EXISTS (
        SELECT 1 FROM hard_deleted_threads WHERE thread_id = NEW.stream_id
      )
    BEGIN
      SELECT RAISE(ABORT, 'hard-deleted thread is permanently retired');
    END
  `;
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS trg_orchestration_command_receipts_hard_deleted_thread_insert
    BEFORE INSERT ON orchestration_command_receipts
    WHEN NEW.aggregate_kind = 'thread'
      AND EXISTS (
        SELECT 1 FROM hard_deleted_threads WHERE thread_id = NEW.aggregate_id
      )
    BEGIN
      SELECT RAISE(ABORT, 'hard-deleted thread is permanently retired');
    END
  `;

  // These repositories can be written by provider/checkpoint workers outside
  // the orchestration event transaction. INSERT guards also cover SQLite
  // UPSERT paths before conflict resolution; UPDATE guards close direct-update
  // paths while a hard-delete purge is waiting behind another engine command.
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS trg_provider_session_runtime_hard_deleted_thread_insert
    BEFORE INSERT ON provider_session_runtime
    WHEN EXISTS (
      SELECT 1 FROM hard_deleted_threads WHERE thread_id = NEW.thread_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'hard-deleted thread is permanently retired');
    END
  `;
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS trg_provider_session_runtime_hard_deleted_thread_update
    BEFORE UPDATE ON provider_session_runtime
    WHEN EXISTS (
      SELECT 1 FROM hard_deleted_threads WHERE thread_id = NEW.thread_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'hard-deleted thread is permanently retired');
    END
  `;
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS trg_provider_supervisor_sessions_hard_deleted_thread_insert
    BEFORE INSERT ON provider_supervisor_sessions
    WHEN NEW.thread_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM hard_deleted_threads WHERE thread_id = NEW.thread_id
      )
    BEGIN
      SELECT RAISE(ABORT, 'hard-deleted thread is permanently retired');
    END
  `;
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS trg_provider_supervisor_sessions_hard_deleted_thread_update
    BEFORE UPDATE ON provider_supervisor_sessions
    WHEN NEW.thread_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM hard_deleted_threads WHERE thread_id = NEW.thread_id
      )
    BEGIN
      SELECT RAISE(ABORT, 'hard-deleted thread is permanently retired');
    END
  `;
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS trg_provider_subagent_roots_hard_deleted_thread_insert
    BEFORE INSERT ON provider_subagent_history_roots
    WHEN EXISTS (
      SELECT 1 FROM hard_deleted_threads WHERE thread_id = NEW.thread_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'hard-deleted thread is permanently retired');
    END
  `;
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS trg_provider_subagent_roots_hard_deleted_thread_update
    BEFORE UPDATE ON provider_subagent_history_roots
    WHEN EXISTS (
      SELECT 1 FROM hard_deleted_threads WHERE thread_id = NEW.thread_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'hard-deleted thread is permanently retired');
    END
  `;
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS trg_provider_subagent_bindings_hard_deleted_thread_insert
    BEFORE INSERT ON provider_subagent_history_bindings
    WHEN EXISTS (
      SELECT 1 FROM hard_deleted_threads WHERE thread_id = NEW.thread_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'hard-deleted thread is permanently retired');
    END
  `;
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS trg_provider_subagent_bindings_hard_deleted_thread_update
    BEFORE UPDATE ON provider_subagent_history_bindings
    WHEN EXISTS (
      SELECT 1 FROM hard_deleted_threads WHERE thread_id = NEW.thread_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'hard-deleted thread is permanently retired');
    END
  `;

  // Checkpoint workers persist turn state and diff blobs independently of the
  // command queue, so both their insert and update paths need the same fence.
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS trg_projection_turns_hard_deleted_thread_insert
    BEFORE INSERT ON projection_turns
    WHEN EXISTS (
      SELECT 1 FROM hard_deleted_threads WHERE thread_id = NEW.thread_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'hard-deleted thread is permanently retired');
    END
  `;
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS trg_projection_turns_hard_deleted_thread_update
    BEFORE UPDATE ON projection_turns
    WHEN EXISTS (
      SELECT 1 FROM hard_deleted_threads WHERE thread_id = NEW.thread_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'hard-deleted thread is permanently retired');
    END
  `;
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS trg_checkpoint_diff_blobs_hard_deleted_thread_insert
    BEFORE INSERT ON checkpoint_diff_blobs
    WHEN EXISTS (
      SELECT 1 FROM hard_deleted_threads WHERE thread_id = NEW.thread_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'hard-deleted thread is permanently retired');
    END
  `;
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS trg_checkpoint_diff_blobs_hard_deleted_thread_update
    BEFORE UPDATE ON checkpoint_diff_blobs
    WHEN EXISTS (
      SELECT 1 FROM hard_deleted_threads WHERE thread_id = NEW.thread_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'hard-deleted thread is permanently retired');
    END
  `;

  // Projection writes normally share the event transaction. These guards are
  // defense in depth for maintenance/recovery jobs and ensure an absent thread
  // cannot be partially recreated by a stale writer.
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS trg_projection_threads_hard_deleted_thread_insert
    BEFORE INSERT ON projection_threads
    WHEN EXISTS (
      SELECT 1 FROM hard_deleted_threads WHERE thread_id = NEW.thread_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'hard-deleted thread is permanently retired');
    END
  `;
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS trg_projection_threads_hard_deleted_thread_update
    BEFORE UPDATE ON projection_threads
    WHEN EXISTS (
      SELECT 1 FROM hard_deleted_threads WHERE thread_id = NEW.thread_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'hard-deleted thread is permanently retired');
    END
  `;
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS trg_projection_messages_hard_deleted_thread_insert
    BEFORE INSERT ON projection_thread_messages
    WHEN EXISTS (
      SELECT 1 FROM hard_deleted_threads WHERE thread_id = NEW.thread_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'hard-deleted thread is permanently retired');
    END
  `;
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS trg_projection_messages_hard_deleted_thread_update
    BEFORE UPDATE ON projection_thread_messages
    WHEN EXISTS (
      SELECT 1 FROM hard_deleted_threads WHERE thread_id = NEW.thread_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'hard-deleted thread is permanently retired');
    END
  `;
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS trg_projection_activities_hard_deleted_thread_insert
    BEFORE INSERT ON projection_thread_activities
    WHEN EXISTS (
      SELECT 1 FROM hard_deleted_threads WHERE thread_id = NEW.thread_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'hard-deleted thread is permanently retired');
    END
  `;
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS trg_projection_activities_hard_deleted_thread_update
    BEFORE UPDATE ON projection_thread_activities
    WHEN EXISTS (
      SELECT 1 FROM hard_deleted_threads WHERE thread_id = NEW.thread_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'hard-deleted thread is permanently retired');
    END
  `;
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS trg_projection_sessions_hard_deleted_thread_insert
    BEFORE INSERT ON projection_thread_sessions
    WHEN EXISTS (
      SELECT 1 FROM hard_deleted_threads WHERE thread_id = NEW.thread_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'hard-deleted thread is permanently retired');
    END
  `;
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS trg_projection_sessions_hard_deleted_thread_update
    BEFORE UPDATE ON projection_thread_sessions
    WHEN EXISTS (
      SELECT 1 FROM hard_deleted_threads WHERE thread_id = NEW.thread_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'hard-deleted thread is permanently retired');
    END
  `;
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS trg_projection_goals_hard_deleted_thread_insert
    BEFORE INSERT ON projection_thread_goals
    WHEN EXISTS (
      SELECT 1 FROM hard_deleted_threads WHERE thread_id = NEW.thread_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'hard-deleted thread is permanently retired');
    END
  `;
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS trg_projection_goals_hard_deleted_thread_update
    BEFORE UPDATE ON projection_thread_goals
    WHEN EXISTS (
      SELECT 1 FROM hard_deleted_threads WHERE thread_id = NEW.thread_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'hard-deleted thread is permanently retired');
    END
  `;
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS trg_projection_approvals_hard_deleted_thread_insert
    BEFORE INSERT ON projection_pending_approvals
    WHEN EXISTS (
      SELECT 1 FROM hard_deleted_threads WHERE thread_id = NEW.thread_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'hard-deleted thread is permanently retired');
    END
  `;
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS trg_projection_approvals_hard_deleted_thread_update
    BEFORE UPDATE ON projection_pending_approvals
    WHEN EXISTS (
      SELECT 1 FROM hard_deleted_threads WHERE thread_id = NEW.thread_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'hard-deleted thread is permanently retired');
    END
  `;
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS trg_projection_plans_hard_deleted_thread_insert
    BEFORE INSERT ON projection_thread_proposed_plans
    WHEN EXISTS (
      SELECT 1 FROM hard_deleted_threads WHERE thread_id = NEW.thread_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'hard-deleted thread is permanently retired');
    END
  `;
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS trg_projection_plans_hard_deleted_thread_update
    BEFORE UPDATE ON projection_thread_proposed_plans
    WHEN EXISTS (
      SELECT 1 FROM hard_deleted_threads WHERE thread_id = NEW.thread_id
    )
    BEGIN
      SELECT RAISE(ABORT, 'hard-deleted thread is permanently retired');
    END
  `;
});
