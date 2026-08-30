import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  /**
   * Attachment ids are intentionally random storage handles, so they cannot
   * prove that a renderer reload uploaded the same bytes. Keep the byte
   * commitment in a private server table instead of the public attachment/event
   * contracts: retry admission can bind content exactly without disclosing a
   * reusable file fingerprint to browser clients or provider transports.
   *
   * Existing attachments have no trustworthy digest to backfill from mutable
   * files. They therefore remain absent and fail closed if a new command tries
   * to reuse their MessageId.
   */
  yield* sql`
    CREATE TABLE IF NOT EXISTS attachment_content_commitments (
      attachment_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      content_sha256 TEXT NOT NULL
        CHECK (
          length(content_sha256) = 64
          AND content_sha256 NOT GLOB '*[^0-9a-f]*'
        ),
      size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
      FOREIGN KEY (thread_id) REFERENCES projection_threads(thread_id) ON DELETE CASCADE
    ) WITHOUT ROWID
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_attachment_content_commitments_thread
    ON attachment_content_commitments(thread_id, attachment_id)
  `;
});
