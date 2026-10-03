import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Add compact, append-maintained subagent lifecycle authority without reading
 * historical activity payloads during startup. Pre-migration rows are filled
 * later by the exact-thread, yielding hydrator; every new qualifying activity
 * is normalized atomically by the triggers below.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE projection_subagent_lifecycle_sources (
      activity_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      -- This CHECK is a cheap code-point ceiling. Exact renderer-compatible
      -- UTF-16 length admission is enforced by both activity triggers and by
      -- the TypeScript legacy hydrator; SQLite CHECK expressions cannot use
      -- the bounded recursive scalar subquery required for astral characters.
      child_id TEXT NOT NULL CHECK (length(child_id) BETWEEN 1 AND 512),
      kind TEXT NOT NULL CHECK (kind IN ('task.started', 'task.progress', 'task.completed')),
      sequence_known INTEGER NOT NULL CHECK (sequence_known IN (0, 1)),
      sequence INTEGER CHECK (sequence IS NULL OR (typeof(sequence) = 'integer' AND sequence >= 0)),
      created_at TEXT NOT NULL,
      PRIMARY KEY (activity_id, child_id),
      CHECK (
        instr(CAST(child_id AS BLOB), X'00') = 0
        AND child_id NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || char(128) || '-' || char(159) || ']*')
        AND instr(child_id, char(1564)) = 0
        AND instr(child_id, char(8206)) = 0
        AND instr(child_id, char(8207)) = 0
        AND instr(child_id, char(8234)) = 0
        AND instr(child_id, char(8235)) = 0
        AND instr(child_id, char(8236)) = 0
        AND instr(child_id, char(8237)) = 0
        AND instr(child_id, char(8238)) = 0
        AND instr(child_id, char(8294)) = 0
        AND instr(child_id, char(8295)) = 0
        AND instr(child_id, char(8296)) = 0
        AND instr(child_id, char(8297)) = 0
      ),
      CHECK (sequence_known = CASE WHEN sequence IS NULL THEN 0 ELSE 1 END),
      FOREIGN KEY (activity_id)
        REFERENCES projection_thread_activities(activity_id)
        ON UPDATE CASCADE
        ON DELETE CASCADE
    ) WITHOUT ROWID
  `;

  yield* sql`
    CREATE INDEX idx_projection_subagent_sources_identity_order
    ON projection_subagent_lifecycle_sources(
      thread_id,
      turn_id,
      child_id,
      kind,
      sequence_known DESC,
      sequence DESC,
      created_at DESC,
      activity_id DESC
    )
  `;

  yield* sql`
    CREATE TABLE projection_subagent_lifecycle_latest (
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      child_id TEXT NOT NULL CHECK (length(child_id) BETWEEN 1 AND 512),
      kind TEXT NOT NULL CHECK (kind IN ('task.started', 'task.progress', 'task.completed')),
      activity_id TEXT NOT NULL,
      sequence_known INTEGER NOT NULL CHECK (sequence_known IN (0, 1)),
      sequence INTEGER CHECK (sequence IS NULL OR (typeof(sequence) = 'integer' AND sequence >= 0)),
      created_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, turn_id, child_id, kind),
      CHECK (sequence_known = CASE WHEN sequence IS NULL THEN 0 ELSE 1 END),
      FOREIGN KEY (activity_id, child_id)
        REFERENCES projection_subagent_lifecycle_sources(activity_id, child_id)
        ON UPDATE CASCADE
        ON DELETE CASCADE
    ) WITHOUT ROWID
  `;

  // The query reads at most three edges per admitted identity. Keeping the
  // complete canonical order before the identity columns makes the newest
  // bounded pointer prefix an index-only scan.
  yield* sql`
    CREATE INDEX idx_projection_subagent_latest_thread_order
    ON projection_subagent_lifecycle_latest(
      thread_id,
      sequence_known DESC,
      sequence DESC,
      created_at DESC,
      activity_id DESC,
      turn_id,
      child_id,
      kind
    )
  `;

  // One fixed cutoff and descending cursor per exact thread/kind makes legacy
  // hydration resumable without a global migration watermark or JSON scan.
  yield* sql`
    CREATE TABLE projection_subagent_lifecycle_hydration (
      thread_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('task.started', 'task.progress', 'task.completed')),
      cutoff_created_at TEXT,
      cutoff_activity_id TEXT,
      cursor_created_at TEXT,
      cursor_activity_id TEXT,
      completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
      PRIMARY KEY (thread_id, kind),
      CHECK ((cutoff_created_at IS NULL) = (cutoff_activity_id IS NULL)),
      CHECK ((cursor_created_at IS NULL) = (cursor_activity_id IS NULL)),
      CHECK (cutoff_created_at IS NOT NULL OR completed = 1),
      CHECK (completed = 0 OR cutoff_created_at IS NULL OR cursor_created_at IS NOT NULL),
      FOREIGN KEY (thread_id)
        REFERENCES projection_threads(thread_id)
        ON UPDATE CASCADE
        ON DELETE CASCADE
    ) WITHOUT ROWID
  `;

  // Exact source rows, rather than provider prose, maintain one newest pointer
  // per lifecycle kind. The row-value comparison is the same total ordering
  // used by thread detail snapshots.
  yield* sql`
    CREATE TRIGGER trg_projection_subagent_source_insert_latest
    AFTER INSERT ON projection_subagent_lifecycle_sources
    BEGIN
      INSERT INTO projection_subagent_lifecycle_latest (
        thread_id, turn_id, child_id, kind,
        activity_id, sequence_known, sequence, created_at
      ) VALUES (
        NEW.thread_id, NEW.turn_id, NEW.child_id, NEW.kind,
        NEW.activity_id, NEW.sequence_known, NEW.sequence, NEW.created_at
      )
      ON CONFLICT (thread_id, turn_id, child_id, kind) DO UPDATE SET
        activity_id = excluded.activity_id,
        sequence_known = excluded.sequence_known,
        sequence = excluded.sequence,
        created_at = excluded.created_at
      WHERE (
        excluded.sequence_known,
        COALESCE(excluded.sequence, -1),
        excluded.created_at,
        excluded.activity_id
      ) > (
        projection_subagent_lifecycle_latest.sequence_known,
        COALESCE(projection_subagent_lifecycle_latest.sequence, -1),
        projection_subagent_lifecycle_latest.created_at,
        projection_subagent_lifecycle_latest.activity_id
      );
    END
  `;

  yield* sql`
    CREATE TRIGGER trg_projection_subagent_source_update_latest
    AFTER UPDATE ON projection_subagent_lifecycle_sources
    BEGIN
      DELETE FROM projection_subagent_lifecycle_latest
      WHERE thread_id = OLD.thread_id
        AND turn_id = OLD.turn_id
        AND child_id = OLD.child_id
        AND kind = OLD.kind
        AND activity_id = OLD.activity_id;

      INSERT INTO projection_subagent_lifecycle_latest (
        thread_id, turn_id, child_id, kind,
        activity_id, sequence_known, sequence, created_at
      )
      SELECT
        source.thread_id, source.turn_id, source.child_id, source.kind,
        source.activity_id, source.sequence_known,
        source.sequence, source.created_at
      FROM projection_subagent_lifecycle_sources AS source
      WHERE source.thread_id = OLD.thread_id
        AND source.turn_id = OLD.turn_id
        AND source.child_id = OLD.child_id
        AND source.kind = OLD.kind
      ORDER BY
        source.sequence_known DESC,
        source.sequence DESC,
        source.created_at DESC,
        source.activity_id DESC
      LIMIT 1
      ON CONFLICT (thread_id, turn_id, child_id, kind) DO UPDATE SET
        activity_id = excluded.activity_id,
        sequence_known = excluded.sequence_known,
        sequence = excluded.sequence,
        created_at = excluded.created_at;

      INSERT INTO projection_subagent_lifecycle_latest (
        thread_id, turn_id, child_id, kind,
        activity_id, sequence_known, sequence, created_at
      ) VALUES (
        NEW.thread_id, NEW.turn_id, NEW.child_id, NEW.kind,
        NEW.activity_id, NEW.sequence_known, NEW.sequence, NEW.created_at
      )
      ON CONFLICT (thread_id, turn_id, child_id, kind) DO UPDATE SET
        activity_id = excluded.activity_id,
        sequence_known = excluded.sequence_known,
        sequence = excluded.sequence,
        created_at = excluded.created_at
      WHERE (
        excluded.sequence_known,
        COALESCE(excluded.sequence, -1),
        excluded.created_at,
        excluded.activity_id
      ) > (
        projection_subagent_lifecycle_latest.sequence_known,
        COALESCE(projection_subagent_lifecycle_latest.sequence, -1),
        projection_subagent_lifecycle_latest.created_at,
        projection_subagent_lifecycle_latest.activity_id
      );
    END
  `;

  yield* sql`
    CREATE TRIGGER trg_projection_subagent_source_delete_latest
    AFTER DELETE ON projection_subagent_lifecycle_sources
    WHEN NOT EXISTS (
      SELECT 1 FROM hard_deleted_threads WHERE thread_id = OLD.thread_id
    )
    BEGIN
      DELETE FROM projection_subagent_lifecycle_latest
      WHERE thread_id = OLD.thread_id
        AND turn_id = OLD.turn_id
        AND child_id = OLD.child_id
        AND kind = OLD.kind
        AND activity_id = OLD.activity_id;

      INSERT INTO projection_subagent_lifecycle_latest (
        thread_id, turn_id, child_id, kind,
        activity_id, sequence_known, sequence, created_at
      )
      SELECT
        source.thread_id, source.turn_id, source.child_id, source.kind,
        source.activity_id, source.sequence_known,
        source.sequence, source.created_at
      FROM projection_subagent_lifecycle_sources AS source
      WHERE source.thread_id = OLD.thread_id
        AND source.turn_id = OLD.turn_id
        AND source.child_id = OLD.child_id
        AND source.kind = OLD.kind
      ORDER BY
        source.sequence_known DESC,
        source.sequence DESC,
        source.created_at DESC,
        source.activity_id DESC
      LIMIT 1
      ON CONFLICT (thread_id, turn_id, child_id, kind) DO UPDATE SET
        activity_id = excluded.activity_id,
        sequence_known = excluded.sequence_known,
        sequence = excluded.sequence,
        created_at = excluded.created_at;
    END
  `;

  // JSON functions are evaluated only inside the valid-JSON CASE arm. This is
  // essential for old projection rows that predate strict payload decoding.
  // Structured child ids are authoritative; taskId is admitted only for an
  // explicit ambient lifecycle tombstone that may omit repeated presentation.
  yield* sql`
    CREATE TRIGGER trg_projection_activity_insert_subagent_source
    AFTER INSERT ON projection_thread_activities
    WHEN NEW.kind IN ('task.started', 'task.progress', 'task.completed')
    BEGIN
      INSERT INTO projection_subagent_lifecycle_sources (
        activity_id, thread_id, turn_id, child_id,
        kind, sequence_known, sequence, created_at
      )
      SELECT
        NEW.activity_id,
        NEW.thread_id,
        NEW.turn_id,
        identity.child_id,
        NEW.kind,
        CASE WHEN NEW.sequence IS NULL THEN 0 ELSE 1 END,
        NEW.sequence,
        NEW.created_at
      FROM (
        SELECT CASE WHEN json_valid(NEW.payload_json) THEN CASE
          WHEN json_type(NEW.payload_json, '$.subagent.threadId') = 'text'
          THEN json_extract(NEW.payload_json, '$.subagent.threadId')
          ELSE NULL
        END ELSE NULL END AS child_id
        UNION
        SELECT CASE WHEN json_valid(NEW.payload_json) THEN CASE
          WHEN json_type(NEW.payload_json, '$.visibility') = 'text'
            AND json_extract(NEW.payload_json, '$.visibility') = 'ambient'
            AND json_type(NEW.payload_json, '$.taskId') = 'text'
          THEN json_extract(NEW.payload_json, '$.taskId')
          ELSE NULL
        END ELSE NULL END AS child_id
      ) AS identity
      WHERE NEW.turn_id IS NOT NULL
        AND CASE
          WHEN length(identity.child_id) NOT BETWEEN 1 AND 512 THEN 0
          WHEN length(CAST(identity.child_id AS BLOB)) = length(identity.child_id) THEN 1
          ELSE (
            WITH RECURSIVE utf16_length(character_offset, code_units) AS (
              SELECT 0, 0
              UNION ALL
              SELECT
                character_offset + 1,
                code_units + CASE
                  WHEN unicode(substr(identity.child_id, character_offset + 1, 1)) > 65535
                  THEN 2 ELSE 1
                END
              FROM utf16_length
              WHERE character_offset < length(identity.child_id)
            )
            SELECT CASE WHEN code_units <= 512 THEN 1 ELSE 0 END
            FROM utf16_length
            WHERE character_offset = length(identity.child_id)
            LIMIT 1
          )
        END = 1
        AND instr(CAST(identity.child_id AS BLOB), X'00') = 0
        AND identity.child_id NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || char(128) || '-' || char(159) || ']*')
        AND instr(identity.child_id, char(1564)) = 0
        AND instr(identity.child_id, char(8206)) = 0
        AND instr(identity.child_id, char(8207)) = 0
        AND instr(identity.child_id, char(8234)) = 0
        AND instr(identity.child_id, char(8235)) = 0
        AND instr(identity.child_id, char(8236)) = 0
        AND instr(identity.child_id, char(8237)) = 0
        AND instr(identity.child_id, char(8238)) = 0
        AND instr(identity.child_id, char(8294)) = 0
        AND instr(identity.child_id, char(8295)) = 0
        AND instr(identity.child_id, char(8296)) = 0
        AND instr(identity.child_id, char(8297)) = 0
        AND NOT EXISTS (
          SELECT 1 FROM hard_deleted_threads WHERE thread_id = NEW.thread_id
        );
    END
  `;

  yield* sql`
    CREATE TRIGGER trg_projection_activity_update_subagent_source
    AFTER UPDATE ON projection_thread_activities
    BEGIN
      DELETE FROM projection_subagent_lifecycle_sources
      WHERE activity_id IN (OLD.activity_id, NEW.activity_id);

      INSERT INTO projection_subagent_lifecycle_sources (
        activity_id, thread_id, turn_id, child_id,
        kind, sequence_known, sequence, created_at
      )
      SELECT
        NEW.activity_id,
        NEW.thread_id,
        NEW.turn_id,
        identity.child_id,
        NEW.kind,
        CASE WHEN NEW.sequence IS NULL THEN 0 ELSE 1 END,
        NEW.sequence,
        NEW.created_at
      FROM (
        SELECT CASE WHEN json_valid(NEW.payload_json) THEN CASE
          WHEN json_type(NEW.payload_json, '$.subagent.threadId') = 'text'
          THEN json_extract(NEW.payload_json, '$.subagent.threadId')
          ELSE NULL
        END ELSE NULL END AS child_id
        UNION
        SELECT CASE WHEN json_valid(NEW.payload_json) THEN CASE
          WHEN json_type(NEW.payload_json, '$.visibility') = 'text'
            AND json_extract(NEW.payload_json, '$.visibility') = 'ambient'
            AND json_type(NEW.payload_json, '$.taskId') = 'text'
          THEN json_extract(NEW.payload_json, '$.taskId')
          ELSE NULL
        END ELSE NULL END AS child_id
      ) AS identity
      WHERE NEW.kind IN ('task.started', 'task.progress', 'task.completed')
        AND NEW.turn_id IS NOT NULL
        AND CASE
          WHEN length(identity.child_id) NOT BETWEEN 1 AND 512 THEN 0
          WHEN length(CAST(identity.child_id AS BLOB)) = length(identity.child_id) THEN 1
          ELSE (
            WITH RECURSIVE utf16_length(character_offset, code_units) AS (
              SELECT 0, 0
              UNION ALL
              SELECT
                character_offset + 1,
                code_units + CASE
                  WHEN unicode(substr(identity.child_id, character_offset + 1, 1)) > 65535
                  THEN 2 ELSE 1
                END
              FROM utf16_length
              WHERE character_offset < length(identity.child_id)
            )
            SELECT CASE WHEN code_units <= 512 THEN 1 ELSE 0 END
            FROM utf16_length
            WHERE character_offset = length(identity.child_id)
            LIMIT 1
          )
        END = 1
        AND instr(CAST(identity.child_id AS BLOB), X'00') = 0
        AND identity.child_id NOT GLOB ('*[' || char(1) || '-' || char(31) || char(127) || char(128) || '-' || char(159) || ']*')
        AND instr(identity.child_id, char(1564)) = 0
        AND instr(identity.child_id, char(8206)) = 0
        AND instr(identity.child_id, char(8207)) = 0
        AND instr(identity.child_id, char(8234)) = 0
        AND instr(identity.child_id, char(8235)) = 0
        AND instr(identity.child_id, char(8236)) = 0
        AND instr(identity.child_id, char(8237)) = 0
        AND instr(identity.child_id, char(8238)) = 0
        AND instr(identity.child_id, char(8294)) = 0
        AND instr(identity.child_id, char(8295)) = 0
        AND instr(identity.child_id, char(8296)) = 0
        AND instr(identity.child_id, char(8297)) = 0
        AND NOT EXISTS (
          SELECT 1 FROM hard_deleted_threads WHERE thread_id = NEW.thread_id
        );
    END
  `;

  // Threads created after this migration have no uncovered legacy activity.
  // Mark all three lanes complete at thread creation so their first detail
  // snapshot can use the all-turn sidecar immediately; existing threads remain
  // absent and therefore enter the bounded lazy-hydration path.
  yield* sql`
    CREATE TRIGGER trg_projection_thread_insert_subagent_hydration
    AFTER INSERT ON projection_threads
    WHEN NOT EXISTS (
      SELECT 1 FROM hard_deleted_threads WHERE thread_id = NEW.thread_id
    )
    BEGIN
      INSERT INTO projection_subagent_lifecycle_hydration(
        thread_id,
        kind,
        cutoff_created_at,
        cutoff_activity_id,
        cursor_created_at,
        cursor_activity_id,
        completed
      ) VALUES
        (NEW.thread_id, 'task.started', NULL, NULL, NULL, NULL, 1),
        (NEW.thread_id, 'task.progress', NULL, NULL, NULL, NULL, 1),
        (NEW.thread_id, 'task.completed', NULL, NULL, NULL, NULL, 1)
      ON CONFLICT (thread_id, kind) DO NOTHING;
    END
  `;

  // Purge compact rows under the same permanent tombstone that authorizes the
  // main hard-delete path. Source delete repair is disabled once this row exists.
  yield* sql`
    CREATE TRIGGER trg_projection_subagent_lifecycle_retire_thread
    AFTER INSERT ON hard_deleted_threads
    BEGIN
      DELETE FROM projection_subagent_lifecycle_latest WHERE thread_id = NEW.thread_id;
      DELETE FROM projection_subagent_lifecycle_sources WHERE thread_id = NEW.thread_id;
      DELETE FROM projection_subagent_lifecycle_hydration WHERE thread_id = NEW.thread_id;
    END
  `;
});
