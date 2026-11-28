import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // A schedule reviewed for Plan needs fresh approval before it can run under
  // the current workflow. Older restricted ceilings were retired by migration 110.
  yield* sql`UPDATE scheduled_followups
    SET state = 'needs_attention', revision = revision + 1, next_run_at = NULL,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE state IN ('active', 'paused', 'pending_confirmation', 'needs_attention')
      AND permission_ceiling = 'full-access'
      AND EXISTS (
        SELECT 1 FROM projection_threads
        WHERE thread_id = scheduled_followups.thread_id AND interaction_mode = 'plan'
      )`;
  yield* sql`UPDATE scheduled_followup_runs
    SET state = 'skipped', error_code = 'settings-changed',
      completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE state IN ('waiting', 'dispatching') AND attempt_at IS NULL
      AND EXISTS (
        SELECT 1 FROM projection_threads
        WHERE thread_id = scheduled_followup_runs.thread_id AND interaction_mode = 'plan'
      )`;
  yield* sql`UPDATE projection_threads SET interaction_mode = 'default'
    WHERE interaction_mode = 'plan'`;
});
