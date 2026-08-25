import {
  IsoDateTime,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@cafecode/contracts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import {
  PersistenceDecodeError,
  PersistenceSqlError,
  ProviderSubagentHistoryBindingConflictError,
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type ProviderSessionRuntimeRepositoryError,
} from "../Errors.ts";
import {
  ProviderSessionRuntime,
  ProviderSessionRuntimeRepository,
  ProviderSubagentHistoryBinding,
  type ProviderSessionRuntimeRepositoryShape,
} from "../Services/ProviderSessionRuntime.ts";

const isPersistenceSqlError = Schema.is(PersistenceSqlError);
const isPersistenceDecodeError = Schema.is(PersistenceDecodeError);
const isProviderSubagentHistoryBindingConflictError = Schema.is(
  ProviderSubagentHistoryBindingConflictError,
);

const ProviderSessionRuntimeDbRowSchema = ProviderSessionRuntime.mapFields(
  Struct.assign({
    resumeCursor: Schema.NullOr(Schema.fromJsonString(Schema.Unknown)),
    runtimePayload: Schema.NullOr(Schema.fromJsonString(Schema.Unknown)),
  }),
);

const decodeRuntime = Schema.decodeUnknownEffect(ProviderSessionRuntime);
const decodeSubagentHistoryBinding = Schema.decodeUnknownEffect(ProviderSubagentHistoryBinding);

const ProviderSubagentHistoryRootDbRowSchema = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  providerName: ProviderDriverKind,
  providerInstanceId: ProviderInstanceId,
  resumeCursor: Schema.NullOr(Schema.fromJsonString(Schema.Unknown)),
  cwd: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

const ProviderSubagentHistoryChildDbRowSchema = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  subagentId: Schema.String,
  // SQLite primary-key columns are kept non-null. An empty history id means
  // the exact child lifecycle has not exposed its provider history id yet; it
  // is not a wildcard and never authorizes a different child tuple.
  historyId: Schema.String,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

const ProviderSubagentHistoryBindingDbRowSchema = Schema.Struct({
  ...ProviderSubagentHistoryRootDbRowSchema.fields,
  ...ProviderSubagentHistoryChildDbRowSchema.fields,
});

const GetRuntimeRequestSchema = Schema.Struct({
  threadId: ThreadId,
});

const DeleteRuntimeRequestSchema = GetRuntimeRequestSchema;

const GetSubagentHistoryBindingRequestSchema = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  subagentId: Schema.String,
  historyId: Schema.String,
});

/** Child identity rows are small; cap them independently from private roots. */
export const MAX_SUBAGENT_HISTORY_BINDINGS_PER_THREAD = 4_096;
/** Keep at most this many distinct provider roots for one Cafe thread. */
export const MAX_SUBAGENT_HISTORY_ROOTS_PER_THREAD = 512;
/**
 * Aggregate UTF-8 bytes retained for private resume cursors and cwd values.
 * The newest prefix wins, so even maximum-sized provider payloads stay within
 * a practical per-thread disk budget instead of multiplying by child count.
 */
export const MAX_SUBAGENT_HISTORY_ROOT_BYTES_PER_THREAD = 8 * 1024 * 1024;

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): ProviderSessionRuntimeRepositoryError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeProviderSessionRuntimeRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertRuntimeRow = SqlSchema.void({
    Request: ProviderSessionRuntimeDbRowSchema,
    execute: (runtime) =>
      sql`
        INSERT INTO provider_session_runtime (
          thread_id,
          provider_name,
          provider_instance_id,
          adapter_key,
          runtime_mode,
          status,
          last_seen_at,
          resume_cursor_json,
          runtime_payload_json
        )
        VALUES (
          ${runtime.threadId},
          ${runtime.providerName},
          ${runtime.providerInstanceId},
          ${runtime.adapterKey},
          ${runtime.runtimeMode},
          ${runtime.status},
          ${runtime.lastSeenAt},
          ${runtime.resumeCursor},
          ${runtime.runtimePayload}
        )
        ON CONFLICT (thread_id)
        DO UPDATE SET
          provider_name = excluded.provider_name,
          provider_instance_id = excluded.provider_instance_id,
          adapter_key = excluded.adapter_key,
          runtime_mode = excluded.runtime_mode,
          status = excluded.status,
          last_seen_at = excluded.last_seen_at,
          resume_cursor_json = excluded.resume_cursor_json,
          runtime_payload_json = excluded.runtime_payload_json
      `,
  });

  const getRuntimeRowByThreadId = SqlSchema.findOneOption({
    Request: GetRuntimeRequestSchema,
    Result: ProviderSessionRuntimeDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          provider_name AS "providerName",
          provider_instance_id AS "providerInstanceId",
          adapter_key AS "adapterKey",
          runtime_mode AS "runtimeMode",
          status,
          last_seen_at AS "lastSeenAt",
          resume_cursor_json AS "resumeCursor",
          runtime_payload_json AS "runtimePayload"
        FROM provider_session_runtime
        WHERE thread_id = ${threadId}
      `,
  });

  const listRuntimeRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProviderSessionRuntimeDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          provider_name AS "providerName",
          provider_instance_id AS "providerInstanceId",
          adapter_key AS "adapterKey",
          runtime_mode AS "runtimeMode",
          status,
          last_seen_at AS "lastSeenAt",
          resume_cursor_json AS "resumeCursor",
          runtime_payload_json AS "runtimePayload"
        FROM provider_session_runtime
        ORDER BY last_seen_at ASC, thread_id ASC
      `,
  });

  const deleteRuntimeByThreadId = SqlSchema.void({
    Request: DeleteRuntimeRequestSchema,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM provider_session_runtime
        WHERE thread_id = ${threadId}
      `,
  });

  const upsertSubagentHistoryRootRow = SqlSchema.findOneOption({
    Request: ProviderSubagentHistoryRootDbRowSchema,
    Result: ProviderSubagentHistoryRootDbRowSchema,
    execute: (binding) =>
      sql`
        INSERT INTO provider_subagent_history_roots (
          thread_id,
          turn_id,
          provider_name,
          provider_instance_id,
          resume_cursor_json,
          cwd,
          created_at,
          updated_at
        )
        VALUES (
          ${binding.threadId},
          ${binding.turnId},
          ${binding.providerName},
          ${binding.providerInstanceId},
          ${binding.resumeCursor},
          ${binding.cwd},
          ${binding.createdAt},
          ${binding.updatedAt}
        )
        ON CONFLICT (thread_id, turn_id)
        DO UPDATE SET
          updated_at = CASE
            WHEN excluded.updated_at > provider_subagent_history_roots.updated_at
              THEN excluded.updated_at
            ELSE provider_subagent_history_roots.updated_at
          END
        WHERE provider_subagent_history_roots.provider_name = excluded.provider_name
          AND provider_subagent_history_roots.provider_instance_id = excluded.provider_instance_id
          AND provider_subagent_history_roots.resume_cursor_json IS excluded.resume_cursor_json
          AND provider_subagent_history_roots.cwd IS excluded.cwd
        RETURNING
          thread_id AS "threadId",
          turn_id AS "turnId",
          provider_name AS "providerName",
          provider_instance_id AS "providerInstanceId",
          resume_cursor_json AS "resumeCursor",
          cwd,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
      `,
  });

  const upsertSubagentHistoryChildRow = SqlSchema.void({
    Request: ProviderSubagentHistoryChildDbRowSchema,
    execute: (binding) =>
      sql`
        INSERT INTO provider_subagent_history_bindings (
          thread_id,
          turn_id,
          subagent_id,
          history_id,
          created_at,
          updated_at
        )
        VALUES (
          ${binding.threadId},
          ${binding.turnId},
          ${binding.subagentId},
          ${binding.historyId},
          ${binding.createdAt},
          ${binding.updatedAt}
        )
        ON CONFLICT (thread_id, turn_id, subagent_id, history_id)
        DO UPDATE SET
          updated_at = CASE
            WHEN excluded.updated_at > provider_subagent_history_bindings.updated_at
              THEN excluded.updated_at
            ELSE provider_subagent_history_bindings.updated_at
          END
      `,
  });

  const pruneSubagentHistoryBindings = SqlSchema.void({
    Request: GetRuntimeRequestSchema,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM provider_subagent_history_bindings
        WHERE rowid IN (
          SELECT rowid
          FROM provider_subagent_history_bindings
          WHERE thread_id = ${threadId}
          ORDER BY updated_at DESC, rowid DESC
          LIMIT -1 OFFSET ${MAX_SUBAGENT_HISTORY_BINDINGS_PER_THREAD}
        )
      `,
  });

  const deleteOrphanedSubagentHistoryRoots = SqlSchema.void({
    Request: GetRuntimeRequestSchema,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM provider_subagent_history_roots
        WHERE thread_id = ${threadId}
          AND NOT EXISTS (
            SELECT 1
            FROM provider_subagent_history_bindings
            WHERE provider_subagent_history_bindings.thread_id = provider_subagent_history_roots.thread_id
              AND provider_subagent_history_bindings.turn_id = provider_subagent_history_roots.turn_id
          )
      `,
  });

  const pruneSubagentHistoryRoots = SqlSchema.void({
    Request: GetRuntimeRequestSchema,
    execute: ({ threadId }) =>
      sql`
        WITH ranked_roots AS (
          SELECT
            rowid,
            ROW_NUMBER() OVER (
              ORDER BY updated_at DESC, rowid DESC
            ) AS retention_rank,
            SUM(
              COALESCE(length(CAST(resume_cursor_json AS BLOB)), 0) +
              COALESCE(length(CAST(cwd AS BLOB)), 0)
            ) OVER (
              ORDER BY updated_at DESC, rowid DESC
              ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
            ) AS retained_private_bytes
          FROM provider_subagent_history_roots
          WHERE thread_id = ${threadId}
        )
        DELETE FROM provider_subagent_history_roots
        WHERE rowid IN (
          SELECT rowid
          FROM ranked_roots
          WHERE retention_rank > ${MAX_SUBAGENT_HISTORY_ROOTS_PER_THREAD}
             OR retained_private_bytes > ${MAX_SUBAGENT_HISTORY_ROOT_BYTES_PER_THREAD}
        )
      `,
  });

  const deleteSubagentBindingsWithoutRoots = SqlSchema.void({
    Request: GetRuntimeRequestSchema,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM provider_subagent_history_bindings
        WHERE thread_id = ${threadId}
          AND NOT EXISTS (
            SELECT 1
            FROM provider_subagent_history_roots
            WHERE provider_subagent_history_roots.thread_id = provider_subagent_history_bindings.thread_id
              AND provider_subagent_history_roots.turn_id = provider_subagent_history_bindings.turn_id
          )
      `,
  });

  const getSubagentHistoryBindingRow = SqlSchema.findOneOption({
    Request: GetSubagentHistoryBindingRequestSchema,
    Result: ProviderSubagentHistoryBindingDbRowSchema,
    execute: ({ threadId, turnId, subagentId, historyId }) =>
      sql`
        SELECT
          child.thread_id AS "threadId",
          child.turn_id AS "turnId",
          child.subagent_id AS "subagentId",
          child.history_id AS "historyId",
          root.provider_name AS "providerName",
          root.provider_instance_id AS "providerInstanceId",
          root.resume_cursor_json AS "resumeCursor",
          root.cwd,
          child.created_at AS "createdAt",
          child.updated_at AS "updatedAt"
        FROM provider_subagent_history_bindings AS child
        INNER JOIN provider_subagent_history_roots AS root
          ON root.thread_id = child.thread_id
         AND root.turn_id = child.turn_id
        WHERE child.thread_id = ${threadId}
          AND child.turn_id = ${turnId}
          AND child.subagent_id = ${subagentId}
          AND child.history_id = ${historyId}
        LIMIT 1
      `,
  });

  const deleteSubagentHistoryBindingsByThreadId = SqlSchema.void({
    Request: DeleteRuntimeRequestSchema,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM provider_subagent_history_bindings
        WHERE thread_id = ${threadId}
      `,
  });

  const deleteSubagentHistoryRootsByThreadId = SqlSchema.void({
    Request: DeleteRuntimeRequestSchema,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM provider_subagent_history_roots
        WHERE thread_id = ${threadId}
      `,
  });

  const upsert: ProviderSessionRuntimeRepositoryShape["upsert"] = (runtime) =>
    upsertRuntimeRow(runtime).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProviderSessionRuntimeRepository.upsert:query",
          "ProviderSessionRuntimeRepository.upsert:encodeRequest",
        ),
      ),
    );

  const getByThreadId: ProviderSessionRuntimeRepositoryShape["getByThreadId"] = (input) =>
    getRuntimeRowByThreadId(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProviderSessionRuntimeRepository.getByThreadId:query",
          "ProviderSessionRuntimeRepository.getByThreadId:decodeRow",
        ),
      ),
      Effect.flatMap((runtimeRowOption) =>
        Option.match(runtimeRowOption, {
          onNone: () => Effect.succeed(Option.none()),
          onSome: (row) =>
            decodeRuntime(row).pipe(
              Effect.mapError(
                toPersistenceDecodeError(
                  "ProviderSessionRuntimeRepository.getByThreadId:rowToRuntime",
                ),
              ),
              Effect.map((runtime) => Option.some(runtime)),
            ),
        }),
      ),
    );

  const list: ProviderSessionRuntimeRepositoryShape["list"] = () =>
    listRuntimeRows(undefined).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProviderSessionRuntimeRepository.list:query",
          "ProviderSessionRuntimeRepository.list:decodeRows",
        ),
      ),
      Effect.flatMap((rows) =>
        Effect.forEach(
          rows,
          (row) =>
            decodeRuntime(row).pipe(
              Effect.mapError(
                toPersistenceDecodeError("ProviderSessionRuntimeRepository.list:rowToRuntime"),
              ),
            ),
          { concurrency: "unbounded" },
        ),
      ),
    );

  const deleteByThreadId: ProviderSessionRuntimeRepositoryShape["deleteByThreadId"] = (input) =>
    sql
      .withTransaction(
        deleteSubagentHistoryBindingsByThreadId(input).pipe(
          Effect.andThen(deleteSubagentHistoryRootsByThreadId(input)),
          Effect.andThen(deleteRuntimeByThreadId(input)),
        ),
      )
      .pipe(
        Effect.mapError(
          toPersistenceSqlError("ProviderSessionRuntimeRepository.deleteByThreadId:query"),
        ),
      );

  const upsertSubagentHistoryBinding: ProviderSessionRuntimeRepositoryShape["upsertSubagentHistoryBinding"] =
    (binding) => {
      const root = {
        threadId: binding.threadId,
        turnId: binding.turnId,
        providerName: binding.providerName,
        providerInstanceId: binding.providerInstanceId,
        resumeCursor: binding.resumeCursor,
        cwd: binding.cwd,
        createdAt: binding.createdAt,
        updatedAt: binding.updatedAt,
      };
      const child = {
        threadId: binding.threadId,
        turnId: binding.turnId,
        subagentId: binding.subagentId,
        historyId: binding.historyId ?? "",
        createdAt: binding.createdAt,
        updatedAt: binding.updatedAt,
      };
      const mapUpsertError = toPersistenceSqlOrDecodeError(
        "ProviderSessionRuntimeRepository.upsertSubagentHistoryBinding:query",
        "ProviderSessionRuntimeRepository.upsertSubagentHistoryBinding:encodeRequest",
      );

      return sql
        .withTransaction(
          Effect.gen(function* () {
            const persistedRoot = yield* upsertSubagentHistoryRootRow(root).pipe(
              Effect.mapError(mapUpsertError),
            );
            if (Option.isNone(persistedRoot)) {
              // The SQL conflict predicate intentionally returns no row when any
              // immutable provenance field differs. Surface only a typed,
              // redacted signal; never embed cursor/cwd/provider-native values.
              return yield* new ProviderSubagentHistoryBindingConflictError({
                operation: "ProviderSessionRuntimeRepository.upsertSubagentHistoryBinding",
                issue: "immutable-provenance-conflict",
              });
            }

            yield* upsertSubagentHistoryChildRow(child).pipe(Effect.mapError(mapUpsertError));
            yield* pruneSubagentHistoryBindings({ threadId: binding.threadId }).pipe(
              Effect.mapError(mapUpsertError),
            );
            // Removing child rows can orphan roots; prune those before applying
            // the private-byte budget so every retained byte authorizes at least
            // one exact child tuple.
            yield* deleteOrphanedSubagentHistoryRoots({ threadId: binding.threadId }).pipe(
              Effect.mapError(mapUpsertError),
            );
            yield* pruneSubagentHistoryRoots({ threadId: binding.threadId }).pipe(
              Effect.mapError(mapUpsertError),
            );
            // SQLite deployments should enforce both foreign keys, but this
            // explicit cleanup keeps the invariant fail-closed if a legacy
            // connection temporarily has foreign_keys disabled.
            yield* deleteSubagentBindingsWithoutRoots({ threadId: binding.threadId }).pipe(
              Effect.mapError(mapUpsertError),
            );
          }),
        )
        .pipe(
          Effect.mapError((cause): ProviderSessionRuntimeRepositoryError => {
            if (
              isPersistenceSqlError(cause) ||
              isPersistenceDecodeError(cause) ||
              isProviderSubagentHistoryBindingConflictError(cause)
            ) {
              return cause;
            }
            return toPersistenceSqlError(
              "ProviderSessionRuntimeRepository.upsertSubagentHistoryBinding:transaction",
            )(cause);
          }),
          Effect.asVoid,
        );
    };

  const getSubagentHistoryBinding: ProviderSessionRuntimeRepositoryShape["getSubagentHistoryBinding"] =
    (input) =>
      getSubagentHistoryBindingRow({
        ...input,
        historyId: input.historyId ?? "",
      }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProviderSessionRuntimeRepository.getSubagentHistoryBinding:query",
            "ProviderSessionRuntimeRepository.getSubagentHistoryBinding:decodeRow",
          ),
        ),
        Effect.flatMap((rowOption) =>
          Option.match(rowOption, {
            onNone: () => Effect.succeed(Option.none()),
            onSome: (row) =>
              decodeSubagentHistoryBinding({
                ...row,
                historyId: row.historyId.length > 0 ? row.historyId : null,
              }).pipe(
                Effect.mapError(
                  toPersistenceDecodeError(
                    "ProviderSessionRuntimeRepository.getSubagentHistoryBinding:rowToBinding",
                  ),
                ),
                Effect.map((binding) => Option.some(binding)),
              ),
          }),
        ),
      );

  return {
    upsert,
    getByThreadId,
    list,
    deleteByThreadId,
    upsertSubagentHistoryBinding,
    getSubagentHistoryBinding,
  } satisfies ProviderSessionRuntimeRepositoryShape;
});

export const ProviderSessionRuntimeRepositoryLive = Layer.effect(
  ProviderSessionRuntimeRepository,
  makeProviderSessionRuntimeRepository,
);
