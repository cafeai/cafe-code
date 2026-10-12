import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * A separate projection-only lookup for the latest recovery display observation.
 * The exact turn/account/runtime/session timestamp keys avoid scanning ordinary
 * warnings or old account generations when a long child stream fills the tail.
 * This index grants no retry authority: the independent immutable intent/control
 * ledgers remain the only admission evidence. It contains existing rows too,
 * without rewriting transcript history or materializing a new provider process.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_recovery_presentation_owner_order
    ON projection_thread_activities (
      thread_id, turn_id,
      json_extract(payload_json, '$.providerInstanceId'),
      json_extract(payload_json, '$.subagentRuntimeId'),
      json_extract(payload_json, '$.sessionUpdatedAt'),
      CASE WHEN sequence IS NULL THEN 0 ELSE 1 END DESC,
      sequence DESC, created_at DESC, activity_id DESC
    )
    WHERE kind = 'runtime.warning'
      AND json_extract(payload_json, '$.recovery') IN (
        'codex-transient-root-failed', 'codex-transient-recovery-waiting',
        'codex-transient-recovery-cancelled', 'codex-transient-recovery-uncertain',
        'codex-transient-continuation-attempted'
      )
  `;
});
