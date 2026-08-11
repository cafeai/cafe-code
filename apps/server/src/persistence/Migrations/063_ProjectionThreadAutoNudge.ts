import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export const DEFAULT_THREAD_AUTO_NUDGE_JSON =
  '{"authorityRevision":0,"mode":"off","prompt":"","backgroundContinuation":false,"maxRounds":5,"armedAt":null,"baselineSettledTurnId":null,"lastDispatchedSettledTurnId":null,"lastDispatchedMessageId":null,"roundsDispatched":0,"lastDispatchedAt":null}';

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN auto_nudge_json TEXT NOT NULL
    DEFAULT '{"authorityRevision":0,"mode":"off","prompt":"","backgroundContinuation":false,"maxRounds":5,"armedAt":null,"baselineSettledTurnId":null,"lastDispatchedSettledTurnId":null,"lastDispatchedMessageId":null,"roundsDispatched":0,"lastDispatchedAt":null}'
  `;
});
