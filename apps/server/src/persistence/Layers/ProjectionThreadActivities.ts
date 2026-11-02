import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { NonNegativeInt } from "@cafecode/contracts";
import { readLiveWorkObservation } from "@cafecode/shared/liveWork";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { upsertNativeAgentBinding } from "../nativeAgentBindings.ts";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";

import {
  DeleteProjectionThreadActivitiesInput,
  ListProjectionThreadActivitiesInput,
  ProjectionPendingUserInputCountRow,
  ProjectionThreadActivity,
  ProjectionThreadActivityRepository,
  ProjectionUserInputActivityAccountingRow,
  type ProjectionThreadActivityRepositoryShape,
} from "../Services/ProjectionThreadActivities.ts";

const ProjectionThreadActivityDbRowSchema = ProjectionThreadActivity.mapFields(
  Struct.assign({
    payload: Schema.fromJsonString(Schema.Unknown),
    sequence: Schema.NullOr(NonNegativeInt),
  }),
);
const encodePayloadJson = Schema.encodeEffect(Schema.UnknownFromJsonString);
const decodePayloadJson = Schema.decodeEffect(Schema.UnknownFromJsonString);

const ProjectionUserInputActivityAccountingDbRowSchema =
  ProjectionUserInputActivityAccountingRow.mapFields(
    Struct.assign({
      payload: Schema.fromJsonString(Schema.Unknown),
    }),
  );

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown) =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeProjectionThreadActivityRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionThreadActivityRow = SqlSchema.void({
    Request: Schema.Struct({ ...ProjectionThreadActivity.fields, payloadJson: Schema.String }),
    execute: (row) =>
      sql`
            INSERT INTO projection_thread_activities (
              activity_id,
              thread_id,
              turn_id,
              tone,
              kind,
              summary,
              payload_json,
              sequence,
              created_at
            )
            VALUES (
              ${row.activityId},
              ${row.threadId},
              ${row.turnId},
              ${row.tone},
              ${row.kind},
              ${row.summary},
              ${row.payloadJson},
              ${row.sequence ?? null},
              ${row.createdAt}
            )
            ON CONFLICT (activity_id)
            DO UPDATE SET
              thread_id = excluded.thread_id,
              turn_id = excluded.turn_id,
              tone = excluded.tone,
              kind = excluded.kind,
              summary = excluded.summary,
              payload_json = excluded.payload_json,
              sequence = excluded.sequence,
              created_at = excluded.created_at
          `,
  });

  const listProjectionThreadActivityRows = SqlSchema.findAll({
    Request: ListProjectionThreadActivitiesInput,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          activity_id AS "activityId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          tone,
          kind,
          summary,
          payload_json AS "payload",
          sequence,
          created_at AS "createdAt"
        FROM projection_thread_activities
        WHERE thread_id = ${threadId}
        ORDER BY
          CASE WHEN sequence IS NULL THEN 0 ELSE 1 END ASC,
          sequence ASC,
          created_at ASC,
          activity_id ASC
      `,
  });

  const listProjectionUserInputAccountingRows = SqlSchema.findAll({
    Request: ListProjectionThreadActivitiesInput,
    Result: ProjectionUserInputActivityAccountingDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          activity_id AS "activityId",
          kind,
          payload_json AS "payload",
          created_at AS "createdAt"
        FROM projection_thread_activities
        WHERE thread_id = ${threadId}
          AND kind IN (
            'user-input.requested',
            'user-input.resolved',
            'provider.user-input.respond.failed'
          )
        ORDER BY
          CASE WHEN sequence IS NULL THEN 0 ELSE 1 END ASC,
          sequence ASC,
          created_at ASC,
          CASE WHEN kind = 'user-input.resolved' THEN 2 ELSE 1 END ASC,
          activity_id ASC
      `,
  });

  const countPendingUserInputRows = SqlSchema.findOne({
    Request: ListProjectionThreadActivitiesInput,
    Result: ProjectionPendingUserInputCountRow,
    execute: ({ threadId }) =>
      sql`
        WITH user_input_accounting AS (
          SELECT
            activity_id,
            kind,
            json_extract(payload_json, '$.requestId') AS request_id,
            -- Only provider-authored string details can carry a canonical
            -- stale-request observation. JSON objects must not be coerced to
            -- text and accidentally retire a still-pending callback.
            CASE WHEN json_type(payload_json, '$.detail') = 'text'
              THEN lower(json_extract(payload_json, '$.detail')) ELSE '' END AS detail,
            sequence,
            created_at
          FROM projection_thread_activities
          WHERE thread_id = ${threadId}
            AND kind IN (
              'user-input.requested',
              'user-input.resolved',
              'provider.user-input.respond.failed'
            )
            -- Malformed opaque identities cannot name a native callback and
            -- must not create shell attention with no renderable request.
            -- Keep the same nonempty string admission as detail retention.
            AND CASE WHEN json_valid(payload_json) THEN
              json_type(payload_json, '$.requestId') = 'text'
              AND length(json_extract(payload_json, '$.requestId')) > 0
            ELSE 0 END
        )
        SELECT COUNT(DISTINCT requested.request_id) AS "count"
        FROM user_input_accounting requested
        WHERE requested.kind = 'user-input.requested'
          AND requested.request_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM user_input_accounting later
            WHERE later.request_id = requested.request_id
              -- Match the canonical lifecycle fold: known orchestration
              -- sequences follow legacy unsequenced rows and outrank wall
              -- clocks. At a genuine tie a resolution follows its request,
              -- even when its opaque activity id sorts before that request.
              -- A failed response keeps its ordinary tie rank; only the
              -- existing stale/unknown whitelist below can retire a callback.
              AND (
                CASE WHEN later.sequence IS NULL THEN 0 ELSE 1 END,
                COALESCE(later.sequence, 0),
                later.created_at,
                CASE WHEN later.kind = 'user-input.resolved' THEN 2 ELSE 1 END,
                later.activity_id
              ) > (
                CASE WHEN requested.sequence IS NULL THEN 0 ELSE 1 END,
                COALESCE(requested.sequence, 0),
                requested.created_at,
                1,
                requested.activity_id
              )
              AND (
                later.kind = 'user-input.resolved'
                OR (
                  later.kind = 'provider.user-input.respond.failed'
                  AND (
                    later.detail LIKE '%stale pending user-input request%'
                    OR later.detail LIKE '%unknown pending user-input request%'
                  )
                )
              )
          )
      `,
  });

  const deleteProjectionThreadActivityRows = SqlSchema.void({
    Request: DeleteProjectionThreadActivitiesInput,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM projection_thread_activities
        WHERE thread_id = ${threadId}
      `,
  });

  const upsert: ProjectionThreadActivityRepositoryShape["upsert"] = (row) =>
    Effect.gen(function* () {
      // One qualified encoding owns the persisted bytes. Decode those exact
      // bytes into a private object before reading work identity, so an input
      // getter/toJSON cannot make the head disagree with its stored activity.
      // Unsupported input remains a typed schema failure before any SQL write.
      const payloadJson = yield* encodePayloadJson(row.payload);
      const payload = yield* decodePayloadJson(payloadJson);
      const prepared = { ...row, payload, payloadJson };
      const work = readLiveWorkObservation(prepared);
      const write =
        work || prepared.kind === "task.started"
          ? sql.withTransaction(
              Effect.gen(function* () {
                yield* upsertProjectionThreadActivityRow(prepared);
                if (work)
                  yield* sql`INSERT INTO projection_live_work
        (thread_id, runtime_id, turn_id, lane, work_id, is_agent, active, sequence, created_at, activity_id)
        VALUES (${prepared.threadId}, ${work.runtimeId}, ${prepared.turnId ?? ""}, ${work.lane}, ${work.workId},
          ${work.agent ? 1 : 0}, ${work.active ? 1 : 0}, ${prepared.sequence ?? null}, ${prepared.createdAt}, ${prepared.activityId})
        ON CONFLICT (thread_id, runtime_id, turn_id, lane, work_id) DO UPDATE SET
          is_agent = excluded.is_agent, active = excluded.active, sequence = excluded.sequence,
          created_at = excluded.created_at, activity_id = excluded.activity_id
        WHERE
          (CASE WHEN excluded.sequence IS NULL THEN 0 ELSE 1 END,
            COALESCE(excluded.sequence, -1), excluded.created_at, excluded.activity_id) >=
          (CASE WHEN projection_live_work.sequence IS NULL THEN 0 ELSE 1 END,
            COALESCE(projection_live_work.sequence, -1),
            projection_live_work.created_at, projection_live_work.activity_id)`;
                if (prepared.kind === "task.started")
                  yield* upsertNativeAgentBinding(sql, prepared, payloadJson);
              }),
            )
          : upsertProjectionThreadActivityRow(prepared);
      return yield* write;
    }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionThreadActivityRepository.upsert:query",
          "ProjectionThreadActivityRepository.upsert:encodeRequest",
        ),
      ),
    );

  const listByThreadId: ProjectionThreadActivityRepositoryShape["listByThreadId"] = (input) =>
    listProjectionThreadActivityRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionThreadActivityRepository.listByThreadId:query",
          "ProjectionThreadActivityRepository.listByThreadId:decodeRows",
        ),
      ),
      Effect.map((rows) =>
        rows.map((row) => ({
          activityId: row.activityId,
          threadId: row.threadId,
          turnId: row.turnId,
          tone: row.tone,
          kind: row.kind,
          summary: row.summary,
          payload: row.payload,
          ...(row.sequence !== null ? { sequence: row.sequence } : {}),
          createdAt: row.createdAt,
        })),
      ),
    );

  const listUserInputAccountingByThreadId: ProjectionThreadActivityRepositoryShape["listUserInputAccountingByThreadId"] =
    (input) =>
      listProjectionUserInputAccountingRows(input).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionThreadActivityRepository.listUserInputAccountingByThreadId:query",
            "ProjectionThreadActivityRepository.listUserInputAccountingByThreadId:decodeRows",
          ),
        ),
      );

  const countPendingUserInputByThreadId: ProjectionThreadActivityRepositoryShape["countPendingUserInputByThreadId"] =
    (input) =>
      countPendingUserInputRows(input).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionThreadActivityRepository.countPendingUserInputByThreadId:query",
            "ProjectionThreadActivityRepository.countPendingUserInputByThreadId:decodeRow",
          ),
        ),
        Effect.map((row) => row.count),
      );

  const deleteByThreadId: ProjectionThreadActivityRepositoryShape["deleteByThreadId"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`DELETE FROM projection_native_agent_bindings WHERE thread_id = ${input.threadId}`;
          yield* sql`DELETE FROM projection_live_work WHERE thread_id = ${input.threadId}`;
          yield* deleteProjectionThreadActivityRows(input);
        }),
      )
      .pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionThreadActivityRepository.deleteByThreadId:query"),
        ),
      );

  return {
    upsert,
    listByThreadId,
    listUserInputAccountingByThreadId,
    countPendingUserInputByThreadId,
    deleteByThreadId,
  } satisfies ProjectionThreadActivityRepositoryShape;
});

export const ProjectionThreadActivityRepositoryLive = Layer.effect(
  ProjectionThreadActivityRepository,
  makeProjectionThreadActivityRepository,
);
