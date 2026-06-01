import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { ChatAttachment, IsoDateTime } from "@cafecode/contracts";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  CloseStreamingProjectionThreadMessagesByTurnInput,
  GetProjectionThreadMessageInput,
  GetProjectionThreadMessageByThreadInput,
  ProjectionThreadMessageRepository,
  type ProjectionThreadMessageRepositoryShape,
  DeleteProjectionThreadMessagesInput,
  ListProjectionThreadMessagesInput,
  ProjectionThreadMessage,
} from "../Services/ProjectionThreadMessages.ts";

const ProjectionThreadMessageDbRowSchema = ProjectionThreadMessage.mapFields(
  Struct.assign({
    isStreaming: Schema.Number,
    attachments: Schema.NullOr(Schema.fromJsonString(Schema.Array(ChatAttachment))),
  }),
);

function toProjectionThreadMessage(
  row: Schema.Schema.Type<typeof ProjectionThreadMessageDbRowSchema>,
): ProjectionThreadMessage {
  return {
    messageId: row.messageId,
    threadId: row.threadId,
    turnId: row.turnId,
    role: row.role,
    text: row.text,
    isStreaming: row.isStreaming === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(row.attachments !== null ? { attachments: row.attachments } : {}),
  };
}

const makeProjectionThreadMessageRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const LatestUserMessageAtRow = Schema.Struct({
    latestUserMessageAt: IsoDateTime,
  });

  const upsertProjectionThreadMessageRow = SqlSchema.void({
    Request: ProjectionThreadMessage,
    execute: (row) => {
      const nextAttachmentsJson =
        row.attachments !== undefined ? JSON.stringify(row.attachments) : null;
      return sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          attachments_json,
          is_streaming,
          created_at,
          updated_at
        )
        VALUES (
          ${row.messageId},
          ${row.threadId},
          ${row.turnId},
          ${row.role},
          ${row.text},
          COALESCE(
            ${nextAttachmentsJson},
            (
              SELECT attachments_json
              FROM projection_thread_messages
              WHERE thread_id = ${row.threadId}
                AND message_id = ${row.messageId}
            )
          ),
          ${row.isStreaming ? 1 : 0},
          ${row.createdAt},
          ${row.updatedAt}
        )
        ON CONFLICT (thread_id, message_id)
        DO UPDATE SET
          turn_id = excluded.turn_id,
          role = excluded.role,
          text = excluded.text,
          attachments_json = COALESCE(
            excluded.attachments_json,
            projection_thread_messages.attachments_json
          ),
          is_streaming = excluded.is_streaming,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
      `;
    },
  });

  const getProjectionThreadMessageRow = SqlSchema.findOneOption({
    Request: GetProjectionThreadMessageInput,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: ({ messageId }) =>
      sql`
        SELECT
          message_id AS "messageId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          role,
          text,
          attachments_json AS "attachments",
          is_streaming AS "isStreaming",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_messages
        WHERE message_id = ${messageId}
        LIMIT 1
      `,
  });

  const getProjectionThreadMessageByThreadRow = SqlSchema.findOneOption({
    Request: GetProjectionThreadMessageByThreadInput,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: ({ threadId, messageId }) =>
      sql`
        SELECT
          message_id AS "messageId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          role,
          text,
          attachments_json AS "attachments",
          is_streaming AS "isStreaming",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_messages
        WHERE thread_id = ${threadId}
          AND message_id = ${messageId}
        LIMIT 1
      `,
  });

  const listProjectionThreadMessageRows = SqlSchema.findAll({
    Request: ListProjectionThreadMessagesInput,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          message_id AS "messageId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          role,
          text,
          attachments_json AS "attachments",
          is_streaming AS "isStreaming",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_messages
        WHERE thread_id = ${threadId}
        ORDER BY created_at ASC, message_id ASC
      `,
  });

  const getLatestUserMessageAtRow = SqlSchema.findOneOption({
    Request: ListProjectionThreadMessagesInput,
    Result: LatestUserMessageAtRow,
    execute: ({ threadId }) =>
      sql`
        SELECT created_at AS "latestUserMessageAt"
        FROM projection_thread_messages
        WHERE thread_id = ${threadId}
          AND role = 'user'
        ORDER BY created_at DESC, message_id DESC
        LIMIT 1
      `,
  });

  const closeStreamingProjectionThreadMessagesByTurn = SqlSchema.void({
    Request: CloseStreamingProjectionThreadMessagesByTurnInput,
    execute: ({ threadId, turnId, updatedAt }) =>
      sql`
        UPDATE projection_thread_messages
        SET
          is_streaming = 0,
          updated_at = CASE
            WHEN updated_at > ${updatedAt}
            THEN updated_at
            ELSE ${updatedAt}
          END
        WHERE thread_id = ${threadId}
          AND turn_id = ${turnId}
          AND role = 'assistant'
          AND is_streaming = 1
      `,
  });

  const deleteProjectionThreadMessageRows = SqlSchema.void({
    Request: DeleteProjectionThreadMessagesInput,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM projection_thread_messages
        WHERE thread_id = ${threadId}
      `,
  });

  const upsert: ProjectionThreadMessageRepositoryShape["upsert"] = (row) =>
    upsertProjectionThreadMessageRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadMessageRepository.upsert:query")),
    );

  const getByMessageId: ProjectionThreadMessageRepositoryShape["getByMessageId"] = (input) =>
    getProjectionThreadMessageRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadMessageRepository.getByMessageId:query"),
      ),
      Effect.map(Option.map(toProjectionThreadMessage)),
    );

  const getByThreadAndMessageId: ProjectionThreadMessageRepositoryShape["getByThreadAndMessageId"] =
    (input) =>
      getProjectionThreadMessageByThreadRow(input).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionThreadMessageRepository.getByThreadAndMessageId:query"),
        ),
        Effect.map(Option.map(toProjectionThreadMessage)),
      );

  const listByThreadId: ProjectionThreadMessageRepositoryShape["listByThreadId"] = (input) =>
    listProjectionThreadMessageRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadMessageRepository.listByThreadId:query"),
      ),
      Effect.map((rows) => rows.map(toProjectionThreadMessage)),
    );

  const getLatestUserMessageAtByThreadId: ProjectionThreadMessageRepositoryShape["getLatestUserMessageAtByThreadId"] =
    (input) =>
      getLatestUserMessageAtRow(input).pipe(
        Effect.mapError(
          toPersistenceSqlError(
            "ProjectionThreadMessageRepository.getLatestUserMessageAtByThreadId:query",
          ),
        ),
        Effect.map(Option.map((row) => row.latestUserMessageAt)),
      );

  const closeStreamingByTurnId: ProjectionThreadMessageRepositoryShape["closeStreamingByTurnId"] = (
    input,
  ) =>
    closeStreamingProjectionThreadMessagesByTurn(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadMessageRepository.closeStreamingByTurnId:query"),
      ),
    );

  const deleteByThreadId: ProjectionThreadMessageRepositoryShape["deleteByThreadId"] = (input) =>
    deleteProjectionThreadMessageRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadMessageRepository.deleteByThreadId:query"),
      ),
    );

  return {
    upsert,
    getByMessageId,
    getByThreadAndMessageId,
    listByThreadId,
    getLatestUserMessageAtByThreadId,
    closeStreamingByTurnId,
    deleteByThreadId,
  } satisfies ProjectionThreadMessageRepositoryShape;
});

export const ProjectionThreadMessageRepositoryLive = Layer.effect(
  ProjectionThreadMessageRepository,
  makeProjectionThreadMessageRepository,
);
