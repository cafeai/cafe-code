import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Account approval is a durable user decision, not a periodically sampled
 * equality check. Switching A -> B -> A must not resurrect A's old approval.
 * Fence at the projection commit that changes the selected paying profile or
 * permission mode. Already attempted work keeps its outcome/recovery evidence;
 * this trigger never stops a provider or manufactures a completion. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TRIGGER trg_scheduled_followups_account_review
    AFTER UPDATE OF model_selection_json, runtime_mode ON projection_threads
    WHEN json_extract(OLD.model_selection_json,'$.instanceId') IS NOT json_extract(NEW.model_selection_json,'$.instanceId')
      OR OLD.runtime_mode IS NOT NEW.runtime_mode
    BEGIN
      UPDATE scheduled_followups SET state = 'needs_attention', revision = revision + 1,
        next_run_at = NULL, updated_at = NEW.updated_at
      WHERE thread_id = NEW.thread_id AND state IN ('active','paused','pending_confirmation','needs_attention');
      UPDATE scheduled_followup_runs SET state = 'skipped', error_code = 'settings-changed', completed_at = NEW.updated_at
      WHERE thread_id = NEW.thread_id AND state IN ('waiting','dispatching') AND attempt_at IS NULL;
      UPDATE scheduling_session_capabilities SET active = 0 WHERE thread_id = NEW.thread_id
        AND json_extract(OLD.model_selection_json,'$.instanceId') IS NOT json_extract(NEW.model_selection_json,'$.instanceId');
    END`;
});
