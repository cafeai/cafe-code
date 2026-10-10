import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** A small, incremental projection: shell subscriptions never hydrate tool history. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE projection_live_work (
    thread_id TEXT NOT NULL,
    runtime_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    lane TEXT NOT NULL,
    work_id TEXT NOT NULL,
    is_agent INTEGER NOT NULL,
    active INTEGER NOT NULL,
    sequence INTEGER,
    created_at TEXT NOT NULL,
    activity_id TEXT NOT NULL,
    PRIMARY KEY (thread_id, runtime_id, turn_id, lane, work_id)
  )`;
  yield* sql`CREATE INDEX idx_projection_live_work_active
    ON projection_live_work (thread_id, runtime_id, active)`;
  // Upgrade existing, exactly bound work too. This is a one-time SQL metadata
  // backfill, not renderer history hydration or a scan on each subscription.
  // Rank all lifecycle edges before filtering runtimes so an old terminal
  // edge lacking runtime metadata cannot resurrect its earlier start.
  yield* sql`INSERT INTO projection_live_work
    (thread_id, runtime_id, turn_id, lane, work_id, is_agent, active, sequence, created_at, activity_id)
    WITH observations AS (
      SELECT activity_id, thread_id, COALESCE(turn_id, '') AS turn_id, sequence, created_at, kind,
        CASE WHEN kind LIKE 'task.%' THEN 'task' ELSE 'tool' END AS lane,
        CASE WHEN kind LIKE 'task.%' THEN json_extract(payload_json, '$.taskId') ELSE json_extract(payload_json, '$.itemId') END AS work_id,
        COALESCE(json_extract(payload_json, '$.nativeWorkRuntimeId'), json_extract(payload_json, '$.individualTaskControl.runtimeId'), json_extract(payload_json, '$.subagent.runtimeId')) AS runtime_id,
        CASE WHEN kind LIKE 'task.%' AND json_type(payload_json, '$.subagent') = 'object' THEN 1 ELSE 0 END AS is_agent,
        CASE WHEN kind NOT LIKE '%.completed'
          AND COALESCE(json_extract(payload_json, '$.visibility'), '') != 'ambient'
          AND COALESCE(json_extract(payload_json, '$.status'), json_extract(payload_json, '$.subagent.status'), 'active') IN ('active', 'waiting', 'inProgress')
          AND (json_type(payload_json, '$.individualTaskControl') = 'object' OR json_type(payload_json, '$.subagent') = 'object')
          THEN 1 ELSE 0 END AS active
      FROM projection_thread_activities
      WHERE kind IN ('task.started', 'task.progress', 'task.completed', 'tool.started', 'tool.updated', 'tool.completed')
    ), heads AS (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY thread_id, turn_id, lane, work_id
        ORDER BY CASE WHEN sequence IS NULL THEN 0 ELSE 1 END DESC, sequence DESC, created_at DESC, activity_id DESC) AS position
      FROM observations WHERE work_id IS NOT NULL
    )
    SELECT heads.thread_id, heads.runtime_id, heads.turn_id, lane, work_id, is_agent, active, sequence, created_at, activity_id
    FROM heads JOIN projection_thread_sessions AS sessions
      ON sessions.thread_id = heads.thread_id AND sessions.subagent_runtime_id = heads.runtime_id
    WHERE position = 1 AND length(heads.runtime_id) = 36 AND sessions.status NOT IN ('stopped', 'error')`;
});
