import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    DROP INDEX IF EXISTS idx_projection_thread_messages_thread_created
  `;

  yield* sql`
    DROP INDEX IF EXISTS idx_projection_thread_messages_thread_created_id
  `;

  yield* sql`
    CREATE TABLE projection_thread_messages_next (
      message_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      turn_id TEXT,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      attachments_json TEXT,
      is_streaming INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, message_id)
    )
  `;

  yield* sql`
    INSERT INTO projection_thread_messages_next (
      message_id,
      thread_id,
      turn_id,
      role,
      text,
      attachments_json,
      is_streaming,
      created_at,
      updated_at
    )
    SELECT
      message_id,
      thread_id,
      turn_id,
      role,
      text,
      attachments_json,
      is_streaming,
      created_at,
      updated_at
    FROM projection_thread_messages
  `;

  yield* sql`
    DROP TABLE projection_thread_messages
  `;

  yield* sql`
    ALTER TABLE projection_thread_messages_next
    RENAME TO projection_thread_messages
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_messages_thread_created
    ON projection_thread_messages(thread_id, created_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_messages_thread_created_id
    ON projection_thread_messages(thread_id, created_at, message_id)
  `;
});
