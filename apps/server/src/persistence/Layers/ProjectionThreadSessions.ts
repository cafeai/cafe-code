import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { toPersistenceSqlError } from "../Errors.ts";

import {
  ProjectionThreadSession,
  ProjectionThreadSessionSqlRow,
  ProjectionThreadSessionRepository,
  type ProjectionThreadSessionRepositoryShape,
  DeleteProjectionThreadSessionInput,
  GetProjectionThreadSessionInput,
} from "../Services/ProjectionThreadSessions.ts";

const makeProjectionThreadSessionRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionThreadSessionRow = SqlSchema.void({
    Request: ProjectionThreadSession,
    execute: (row) =>
      sql`
        INSERT INTO projection_thread_sessions (
          thread_id,
          status,
          provider_name,
          provider_instance_id,
          runtime_mode,
          subagent_runtime_id,
          max_concurrent_subagents,
          max_concurrent_subagents_known,
          codex_context_window_override,
          codex_context_window_override_known,
          codex_auto_compact_token_limit,
          codex_auto_compact_token_limit_known,
          active_turn_id,
          last_error,
          updated_at
        )
        VALUES (
          ${row.threadId},
          ${row.status},
          ${row.providerName},
          ${row.providerInstanceId},
          ${row.runtimeMode},
          ${row.subagentRuntimeId ?? null},
          ${row.maxConcurrentSubagents ?? null},
          ${row.maxConcurrentSubagents === undefined ? 0 : 1},
          ${row.codexContextWindowOverride ?? null},
          ${row.codexContextWindowOverride === undefined ? 0 : 1},
          ${row.codexAutoCompactTokenLimit ?? null},
          ${row.codexAutoCompactTokenLimit === undefined ? 0 : 1},
          ${row.activeTurnId},
          ${row.lastError},
          ${row.updatedAt}
        )
        ON CONFLICT (thread_id)
        DO UPDATE SET
          status = excluded.status,
          provider_name = excluded.provider_name,
          provider_instance_id = excluded.provider_instance_id,
          runtime_mode = excluded.runtime_mode,
          subagent_runtime_id = excluded.subagent_runtime_id,
          max_concurrent_subagents = excluded.max_concurrent_subagents,
          max_concurrent_subagents_known = excluded.max_concurrent_subagents_known,
          codex_context_window_override = excluded.codex_context_window_override,
          codex_context_window_override_known = excluded.codex_context_window_override_known,
          codex_auto_compact_token_limit = excluded.codex_auto_compact_token_limit,
          codex_auto_compact_token_limit_known = excluded.codex_auto_compact_token_limit_known,
          active_turn_id = excluded.active_turn_id,
          last_error = excluded.last_error,
          updated_at = excluded.updated_at
      `,
  });

  const getProjectionThreadSessionRow = SqlSchema.findOneOption({
    Request: GetProjectionThreadSessionInput,
    Result: ProjectionThreadSessionSqlRow,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          status,
          provider_name AS "providerName",
          provider_instance_id AS "providerInstanceId",
          runtime_mode AS "runtimeMode",
          subagent_runtime_id AS "subagentRuntimeId",
          max_concurrent_subagents AS "maxConcurrentSubagents",
          max_concurrent_subagents_known AS "maxConcurrentSubagentsKnown",
          codex_context_window_override AS "codexContextWindowOverride",
          codex_context_window_override_known AS "codexContextWindowOverrideKnown",
          codex_auto_compact_token_limit AS "codexAutoCompactTokenLimit",
          codex_auto_compact_token_limit_known AS "codexAutoCompactTokenLimitKnown",
          active_turn_id AS "activeTurnId",
          last_error AS "lastError",
          updated_at AS "updatedAt"
        FROM projection_thread_sessions
        WHERE thread_id = ${threadId}
      `,
  });

  const deleteProjectionThreadSessionRow = SqlSchema.void({
    Request: DeleteProjectionThreadSessionInput,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM projection_thread_sessions
        WHERE thread_id = ${threadId}
      `,
  });

  const upsert: ProjectionThreadSessionRepositoryShape["upsert"] = (row) =>
    upsertProjectionThreadSessionRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadSessionRepository.upsert:query")),
    );

  const getByThreadId: ProjectionThreadSessionRepositoryShape["getByThreadId"] = (input) =>
    getProjectionThreadSessionRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadSessionRepository.getByThreadId:query"),
      ),
    );

  const deleteByThreadId: ProjectionThreadSessionRepositoryShape["deleteByThreadId"] = (input) =>
    deleteProjectionThreadSessionRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadSessionRepository.deleteByThreadId:query"),
      ),
    );

  return {
    upsert,
    getByThreadId,
    deleteByThreadId,
  } satisfies ProjectionThreadSessionRepositoryShape;
});

export const ProjectionThreadSessionRepositoryLive = Layer.effect(
  ProjectionThreadSessionRepository,
  makeProjectionThreadSessionRepository,
);
