import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Index both child keys used by the message-identity ledger's event FKs.
 *
 * Migration 68 was exercised against a real development database before this
 * hardening review completed. Adding the indexes under a new durable migration
 * id makes the repair reach those already-migrated databases as well as fresh
 * installations. The ledger is intentionally compact, so these index builds
 * stay bounded by accepted user-message identities rather than by the much
 * larger orchestration event journal.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // SQLite probes child tables by each FK independently while deleting a
  // parent event. The WITHOUT ROWID primary key is (thread_id, message_id), so
  // it cannot satisfy either sequence lookup on its own.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_orchestration_message_identities_first_sequence
    ON orchestration_message_identities(first_sequence)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_orchestration_message_identities_latest_sequence
    ON orchestration_message_identities(latest_sequence)
  `;
});
