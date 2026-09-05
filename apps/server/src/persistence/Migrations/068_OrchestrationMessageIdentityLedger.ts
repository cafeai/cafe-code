import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Add an append-time MessageId ledger without scanning historical JSON.
 *
 * Startup migrations must remain bounded even when `orchestration_events` is
 * tens of gigabytes. `MAX(sequence)` is an indexed right-edge lookup over the
 * INTEGER PRIMARY KEY; all older rows are intentionally left untouched here.
 * The orchestration engine hydrates one selected thread in small batches only
 * when it first needs to prove that a previously unseen MessageId is unique.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS orchestration_message_identity_state (
      singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
      legacy_cutoff_sequence INTEGER NOT NULL CHECK (legacy_cutoff_sequence >= 0)
    )
  `;

  yield* sql`
    INSERT INTO orchestration_message_identity_state (
      singleton_id,
      legacy_cutoff_sequence
    )
    SELECT 1, COALESCE(MAX(sequence), 0)
    FROM orchestration_events
    WHERE true
    ON CONFLICT (singleton_id) DO NOTHING
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS orchestration_message_identities (
      thread_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      first_sequence INTEGER NOT NULL,
      latest_sequence INTEGER NOT NULL,
      PRIMARY KEY (thread_id, message_id),
      FOREIGN KEY (first_sequence)
        REFERENCES orchestration_events(sequence)
        ON DELETE CASCADE,
      FOREIGN KEY (latest_sequence)
        REFERENCES orchestration_events(sequence)
        ON DELETE CASCADE
    ) WITHOUT ROWID
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS orchestration_message_identity_hydration (
      thread_id TEXT PRIMARY KEY,
      through_sequence INTEGER NOT NULL CHECK (through_sequence >= 0)
    ) WITHOUT ROWID
  `;

  // New message events update the ledger inside the same SQLite transaction
  // as the event append. A crash therefore cannot leave an accepted message
  // event outside the identity fence. Authorized retry generations retain the
  // first sequence and advance only the latest sequence.
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS trg_orchestration_message_identity_insert
    AFTER INSERT ON orchestration_events
    WHEN NEW.aggregate_kind = 'thread'
      AND NEW.event_type = 'thread.message-sent'
      AND json_type(NEW.payload_json, '$.messageId') = 'text'
    BEGIN
      INSERT INTO orchestration_message_identities (
        thread_id,
        message_id,
        first_sequence,
        latest_sequence
      )
      VALUES (
        NEW.stream_id,
        json_extract(NEW.payload_json, '$.messageId'),
        NEW.sequence,
        NEW.sequence
      )
      ON CONFLICT (thread_id, message_id) DO UPDATE SET
        latest_sequence = excluded.latest_sequence
      WHERE excluded.latest_sequence > orchestration_message_identities.latest_sequence;
    END
  `;
});
