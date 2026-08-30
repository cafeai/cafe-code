import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // User MessageIds are durable idempotency identities, including after a
  // checkpoint revert removes the message from the detail projection. Keep
  // engine admission on an exact indexed lookup over the append-only ledger
  // instead of scanning a long-running thread's entire event history.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_orch_events_thread_message_identity
    ON orchestration_events(
      stream_id,
      json_extract(payload_json, '$.messageId'),
      sequence DESC
    )
    WHERE aggregate_kind = 'thread'
      AND event_type = 'thread.message-sent'
  `;

  // Retry authority and successful delivery receipts carry the same identity
  // one level deeper inside an activity payload. This companion partial index
  // keeps recovery authorization proportional to one MessageId rather than to
  // every tool/work-log activity accumulated by the thread.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_orch_events_thread_activity_message_identity
    ON orchestration_events(
      stream_id,
      json_extract(payload_json, '$.activity.payload.messageId'),
      sequence DESC
    )
    WHERE aggregate_kind = 'thread'
      AND event_type = 'thread.activity-appended'
  `;
});
