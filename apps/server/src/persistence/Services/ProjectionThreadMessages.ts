/**
 * ProjectionThreadMessageRepository - Projection repository interface for messages.
 *
 * Owns persistence operations for projected thread messages rendered in the
 * orchestration read model.
 *
 * @module ProjectionThreadMessageRepository
 */
import {
  ChatAttachment,
  MessageId,
  OrchestrationMessageRole,
  ThreadId,
  TurnId,
  IsoDateTime,
} from "@cafecode/contracts";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import type * as Option from "effect/Option";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionThreadMessage = Schema.Struct({
  messageId: MessageId,
  threadId: ThreadId,
  turnId: Schema.NullOr(TurnId),
  role: OrchestrationMessageRole,
  text: Schema.String,
  attachments: Schema.optional(Schema.Array(ChatAttachment)),
  isStreaming: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProjectionThreadMessage = typeof ProjectionThreadMessage.Type;

export const ListProjectionThreadMessagesInput = Schema.Struct({
  threadId: ThreadId,
});
export type ListProjectionThreadMessagesInput = typeof ListProjectionThreadMessagesInput.Type;

export const GetProjectionThreadMessageInput = Schema.Struct({
  messageId: MessageId,
});
export type GetProjectionThreadMessageInput = typeof GetProjectionThreadMessageInput.Type;

export const GetProjectionThreadMessageByThreadInput = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
});
export type GetProjectionThreadMessageByThreadInput =
  typeof GetProjectionThreadMessageByThreadInput.Type;

export const DeleteProjectionThreadMessagesInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteProjectionThreadMessagesInput = typeof DeleteProjectionThreadMessagesInput.Type;

export const CloseStreamingProjectionThreadMessagesByTurnInput = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  updatedAt: IsoDateTime,
});
export type CloseStreamingProjectionThreadMessagesByTurnInput =
  typeof CloseStreamingProjectionThreadMessagesByTurnInput.Type;

/**
 * ProjectionThreadMessageRepositoryShape - Service API for projected thread messages.
 */
export interface ProjectionThreadMessageRepositoryShape {
  /**
   * Insert or replace a projected thread message row.
   *
   * Upserts by `threadId` and `messageId`.
   */
  readonly upsert: (
    message: ProjectionThreadMessage,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Read a projected thread message by id.
   */
  readonly getByMessageId: (
    input: GetProjectionThreadMessageInput,
  ) => Effect.Effect<Option.Option<ProjectionThreadMessage>, ProjectionRepositoryError>;

  /**
   * Read a projected thread message using the table's thread-scoped primary
   * key. Streaming assistant deltas already carry both ids; using both keeps
   * the hot path off a global message-id scan on large local databases.
   */
  readonly getByThreadAndMessageId: (
    input: GetProjectionThreadMessageByThreadInput,
  ) => Effect.Effect<Option.Option<ProjectionThreadMessage>, ProjectionRepositoryError>;

  /**
   * List projected thread messages for a thread.
   *
   * Returned in ascending creation order.
   */
  readonly listByThreadId: (
    input: ListProjectionThreadMessagesInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionThreadMessage>, ProjectionRepositoryError>;

  /**
   * Read the latest user-authored message timestamp for summary projections
   * without loading message bodies.
   */
  readonly getLatestUserMessageAtByThreadId: (
    input: ListProjectionThreadMessagesInput,
  ) => Effect.Effect<Option.Option<IsoDateTime>, ProjectionRepositoryError>;

  /**
   * Mark any still-streaming assistant messages for a terminal provider turn
   * as closed.
   *
   * Providers can be interrupted, fail, or checkpoint-complete a turn without
   * sending an explicit completion update for every partial assistant message.
   * The projection must close those partial rows at the same terminal boundary
   * so the renderer does not keep showing stale streaming/working markers.
   */
  readonly closeStreamingByTurnId: (
    input: CloseStreamingProjectionThreadMessagesByTurnInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Delete projected thread messages by thread.
   */
  readonly deleteByThreadId: (
    input: DeleteProjectionThreadMessagesInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

/**
 * ProjectionThreadMessageRepository - Service tag for message projection persistence.
 */
export class ProjectionThreadMessageRepository extends Context.Service<
  ProjectionThreadMessageRepository,
  ProjectionThreadMessageRepositoryShape
>()("cafecode/persistence/Services/ProjectionThreadMessages/ProjectionThreadMessageRepository") {}
