import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // The existing runtime-mode trigger handles retired access settings. A chat
  // that already said Full access could also have selected native Auto.
  yield* sql`UPDATE scheduled_followups
    SET state = 'needs_attention', revision = revision + 1, next_run_at = NULL,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE state IN ('active', 'paused', 'pending_confirmation', 'needs_attention')
      AND EXISTS (
        SELECT 1 FROM projection_threads
        WHERE thread_id = scheduled_followups.thread_id AND runtime_mode = 'full-access'
          AND interaction_mode NOT IN ('default', 'plan')
      )`;
  yield* sql`UPDATE scheduled_followup_runs
    SET state = 'skipped', error_code = 'settings-changed',
      completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE state IN ('waiting', 'dispatching') AND attempt_at IS NULL
      AND EXISTS (
        SELECT 1 FROM projection_threads
        WHERE thread_id = scheduled_followup_runs.thread_id AND runtime_mode = 'full-access'
          AND interaction_mode NOT IN ('default', 'plan')
      )`;
  // Chat intent is distinct from recorded native sessions, turn snapshots and
  // already-attempted deliveries. Keep those records as observed.
  yield* sql`UPDATE projection_threads
    SET runtime_mode = 'full-access',
      interaction_mode = CASE WHEN interaction_mode = 'plan' THEN 'plan' ELSE 'default' END
    WHERE runtime_mode <> 'full-access' OR interaction_mode NOT IN ('default', 'plan')`;
});
