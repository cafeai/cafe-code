import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Thread organization (agent-created groups owned by a parent thread) and
 * editable origin metadata.
 *
 * Schema-only: no backfill. Historical threads have no metadata row, which
 * reads as top level with an Unknown/unrecorded origin. Metadata lives in a
 * sidecar keyed by thread so the hot `projection_threads` upsert path is
 * unchanged and cannot accidentally clear these fields.
 *
 * Neither table grants authority: rows are organisation and recorded facts,
 * never permission, native ownership or retry evidence.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_metadata (
      thread_id TEXT PRIMARY KEY,
      group_id TEXT CHECK (group_id IS NULL OR length(group_id) <= 128),
      origin_classification TEXT
        CHECK (origin_classification IS NULL OR origin_classification IN ('human', 'agent', 'unknown')),
      origin_source TEXT CHECK (origin_source IS NULL OR origin_source IN ('recorded', 'user')),
      origin_updated_at TEXT,
      description TEXT CHECK (description IS NULL OR length(description) <= 2000),
      provenance_json TEXT
        CHECK (provenance_json IS NULL OR (json_valid(provenance_json) AND length(provenance_json) <= 4096)),
      deletion_id TEXT,
      archive_cascade_id TEXT,
      updated_at TEXT NOT NULL
    ) WITHOUT ROWID
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_metadata_group
    ON projection_thread_metadata(group_id)
    WHERE group_id IS NOT NULL
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_groups (
      group_id TEXT PRIMARY KEY CHECK (length(group_id) <= 128),
      owner_thread_id TEXT NOT NULL,
      title TEXT NOT NULL CHECK (length(title) <= 200),
      description TEXT CHECK (description IS NULL OR length(description) <= 2000),
      provenance_json TEXT NOT NULL
        CHECK (json_valid(provenance_json) AND length(provenance_json) <= 4096),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      deletion_id TEXT
    ) WITHOUT ROWID
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_groups_owner
    ON projection_thread_groups(owner_thread_id, deleted_at)
  `;

  // Permanent identity fences, mirroring migration 65. A stale writer cannot
  // resurrect metadata or a group for a hard-deleted thread/owner.
  for (const [table, column] of [
    ["projection_thread_metadata", "thread_id"],
    ["projection_thread_groups", "owner_thread_id"],
  ] as const) {
    yield* sql.unsafe(`
      CREATE TRIGGER IF NOT EXISTS trg_${table}_hard_deleted_thread_insert
      BEFORE INSERT ON ${table}
      WHEN EXISTS (SELECT 1 FROM hard_deleted_threads WHERE thread_id = NEW.${column})
      BEGIN
        SELECT RAISE(ABORT, 'hard-deleted thread is permanently retired');
      END
    `);
    yield* sql.unsafe(`
      CREATE TRIGGER IF NOT EXISTS trg_${table}_hard_deleted_thread_update
      BEFORE UPDATE ON ${table}
      WHEN EXISTS (SELECT 1 FROM hard_deleted_threads WHERE thread_id = NEW.${column})
      BEGIN
        SELECT RAISE(ABORT, 'hard-deleted thread is permanently retired');
      END
    `);
  }
});
