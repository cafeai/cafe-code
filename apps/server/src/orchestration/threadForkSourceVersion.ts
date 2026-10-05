import type { ThreadId } from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

/** Server-authored event authority includes both the exact conversation and
 * its current project. It detects source ABA changes and project-root changes
 * without making unrelated streaming conversations invalidate every fork.
 * The commit caller holds SQLite's writer before checking this value.
 */
export const threadForkSourceVersionStatement = (sql: SqlClient.SqlClient, threadId: ThreadId) =>
  sql<{ readonly sequence: number }>`
    SELECT MAX(
      COALESCE((SELECT sequence FROM orchestration_events INDEXED BY idx_orch_events_stream_sequence
        WHERE aggregate_kind = 'thread' AND stream_id = ${threadId}
        ORDER BY sequence DESC LIMIT 1), 0),
      COALESCE((SELECT sequence FROM orchestration_events INDEXED BY idx_orch_events_stream_sequence
        WHERE aggregate_kind = 'project' AND stream_id = (
          SELECT project_id FROM projection_threads WHERE thread_id = ${threadId}
        ) ORDER BY sequence DESC LIMIT 1), 0)
    ) AS sequence
  `;

export const readThreadForkSourceVersion = (sql: SqlClient.SqlClient, threadId: ThreadId) =>
  threadForkSourceVersionStatement(sql, threadId).pipe(Effect.map((rows) => rows[0]!.sequence));
