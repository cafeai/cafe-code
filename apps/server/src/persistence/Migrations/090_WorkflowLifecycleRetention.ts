import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Extend the existing bounded lifecycle sidecar to inert workflow roots.
 * Replace both activity triggers together: a second UPDATE trigger would
 * race the original trigger's delete/reinsert ordering. Existing child and
 * ambient identities, exact UTF-16 bounds and hard-delete guards are retained.
 * No history scan/backfill or provider state mutation occurs at startup.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const operation of ["insert", "update"] as const) {
    // Identifiers and fragments come only from this finite source allowlist,
    // never provider payloads or user input. Values inside activity JSON remain
    // SQLite data and cannot become executable SQL.
    const name = `trg_projection_activity_${operation}_subagent_source`;
    yield* sql.unsafe(`DROP TRIGGER ${name}`);
    yield* sql.unsafe(`
      CREATE TRIGGER ${name}
      AFTER ${operation.toUpperCase()} ON projection_thread_activities
      ${operation === "insert" ? "WHEN NEW.kind IN ('task.started', 'task.progress', 'task.completed')" : ""}
      BEGIN
        ${operation === "update" ? "DELETE FROM projection_subagent_lifecycle_sources WHERE activity_id IN (OLD.activity_id, NEW.activity_id);" : ""}
        INSERT INTO projection_subagent_lifecycle_sources (
          activity_id, thread_id, turn_id, child_id, kind, sequence_known, sequence, created_at
        )
        SELECT NEW.activity_id, NEW.thread_id, NEW.turn_id, identity.child_id, NEW.kind,
          CASE WHEN NEW.sequence IS NULL THEN 0 ELSE 1 END, NEW.sequence, NEW.created_at
        FROM (
          SELECT CASE WHEN json_valid(NEW.payload_json) THEN CASE
            WHEN json_type(NEW.payload_json, '$.subagent.threadId') = 'text'
            THEN json_extract(NEW.payload_json, '$.subagent.threadId') ELSE NULL
          END ELSE NULL END AS child_id
          UNION
          SELECT CASE WHEN json_valid(NEW.payload_json) THEN CASE
            WHEN json_type(NEW.payload_json, '$.visibility') = 'text'
              AND json_extract(NEW.payload_json, '$.visibility') = 'ambient'
              AND json_type(NEW.payload_json, '$.taskId') = 'text'
            THEN json_extract(NEW.payload_json, '$.taskId') ELSE NULL
          END ELSE NULL END AS child_id
          UNION
          SELECT CASE WHEN json_valid(NEW.payload_json) THEN CASE
            WHEN json_type(NEW.payload_json, '$.workflow.runtimeId') = 'text'
              AND length(json_extract(NEW.payload_json, '$.workflow.runtimeId')) BETWEEN 1 AND 128
              AND instr(CAST(json_extract(NEW.payload_json, '$.workflow.runtimeId') AS BLOB), X'00') = 0
              AND json_extract(NEW.payload_json, '$.workflow.runtimeId') NOT GLOB '*[^A-Za-z0-9_-]*'
              AND json_type(NEW.payload_json, '$.workflow.providerInstanceId') = 'text'
              AND length(json_extract(NEW.payload_json, '$.workflow.providerInstanceId')) BETWEEN 1 AND 128
              AND instr(CAST(json_extract(NEW.payload_json, '$.workflow.providerInstanceId') AS BLOB), X'00') = 0
              AND json_extract(NEW.payload_json, '$.workflow.providerInstanceId') NOT GLOB '*[^A-Za-z0-9_-]*'
              AND json_type(NEW.payload_json, '$.workflowRetentionId') = 'text'
              AND length(json_extract(NEW.payload_json, '$.workflowRetentionId')) = 80
              AND instr(CAST(json_extract(NEW.payload_json, '$.workflowRetentionId') AS BLOB), X'00') = 0
              AND substr(json_extract(NEW.payload_json, '$.workflowRetentionId'), 1, 16) = 'sha256:workflow:'
              AND substr(json_extract(NEW.payload_json, '$.workflowRetentionId'), 17) NOT GLOB '*[^a-f0-9]*'
            THEN json_extract(NEW.payload_json, '$.workflowRetentionId') ELSE NULL
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
                SELECT character_offset + 1, code_units + CASE
                  WHEN unicode(substr(identity.child_id, character_offset + 1, 1)) > 65535
                  THEN 2 ELSE 1 END
                FROM utf16_length WHERE character_offset < length(identity.child_id)
              )
              SELECT CASE WHEN code_units <= 512 THEN 1 ELSE 0 END FROM utf16_length
              WHERE character_offset = length(identity.child_id) LIMIT 1
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
          AND NOT EXISTS (SELECT 1 FROM hard_deleted_threads WHERE thread_id = NEW.thread_id);
      END
    `);
  }
});
