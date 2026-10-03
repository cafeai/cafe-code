/**
 * ProjectionThreadSessionRepository - Repository interface for thread sessions.
 *
 * Owns persistence operations for projected provider-session linkage and
 * runtime status for each thread.
 *
 * @module ProjectionThreadSessionRepository
 */
import {
  RuntimeMode,
  MaxConcurrentSubagents,
  IsoDateTime,
  OrchestrationSessionStatus,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  SubagentRuntimeId,
} from "@cafecode/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionThreadSession = Schema.Struct({
  threadId: ThreadId,
  status: OrchestrationSessionStatus,
  providerName: Schema.NullOr(Schema.String),
  providerInstanceId: Schema.NullOr(ProviderInstanceId),
  runtimeMode: RuntimeMode,
  subagentRuntimeId: Schema.optional(Schema.NullOr(SubagentRuntimeId)),
  maxConcurrentSubagents: Schema.optional(Schema.NullOr(MaxConcurrentSubagents)),
  activeTurnId: Schema.NullOr(TurnId),
  lastError: Schema.NullOr(Schema.String),
  updatedAt: IsoDateTime,
});
export type ProjectionThreadSession = typeof ProjectionThreadSession.Type;

/**
 * SQL NULL alone cannot distinguish a legacy unknown observation from a new
 * process intentionally launched without an override. A separate bounded bit
 * preserves that distinction without inventing native effective policy.
 */
const ProjectionThreadSessionSqlFields = Schema.Struct({
  ...ProjectionThreadSession.fields,
  subagentRuntimeId: Schema.NullOr(SubagentRuntimeId),
  maxConcurrentSubagents: Schema.NullOr(MaxConcurrentSubagents),
  maxConcurrentSubagentsKnown: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
});
export const ProjectionThreadSessionSqlRow = ProjectionThreadSessionSqlFields.pipe(
  Schema.decodeTo(
    Schema.toType(ProjectionThreadSession),
    SchemaTransformation.transform<
      ProjectionThreadSession,
      typeof ProjectionThreadSessionSqlFields.Type
    >({
      decode: ({
        maxConcurrentSubagents,
        maxConcurrentSubagentsKnown,
        subagentRuntimeId,
        ...row
      }) => ({
        ...row,
        ...(subagentRuntimeId === null ? {} : { subagentRuntimeId }),
        ...(maxConcurrentSubagentsKnown === 1 ? { maxConcurrentSubagents } : {}),
      }),
      encode: (row) => ({
        ...row,
        subagentRuntimeId: row.subagentRuntimeId ?? null,
        maxConcurrentSubagents: row.maxConcurrentSubagents ?? null,
        maxConcurrentSubagentsKnown: row.maxConcurrentSubagents === undefined ? 0 : 1,
      }),
    }),
  ),
);

export const GetProjectionThreadSessionInput = Schema.Struct({
  threadId: ThreadId,
});
export type GetProjectionThreadSessionInput = typeof GetProjectionThreadSessionInput.Type;

export const DeleteProjectionThreadSessionInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteProjectionThreadSessionInput = typeof DeleteProjectionThreadSessionInput.Type;

/**
 * ProjectionThreadSessionRepositoryShape - Service API for projected thread sessions.
 */
export interface ProjectionThreadSessionRepositoryShape {
  /**
   * Insert or replace a projected thread-session row.
   *
   * Upserts by `threadId`.
   */
  readonly upsert: (row: ProjectionThreadSession) => Effect.Effect<void, ProjectionRepositoryError>;

  /**
   * Read projected thread-session state by thread id.
   */
  readonly getByThreadId: (
    input: GetProjectionThreadSessionInput,
  ) => Effect.Effect<Option.Option<ProjectionThreadSession>, ProjectionRepositoryError>;

  /**
   * Delete projected thread-session state by thread id.
   */
  readonly deleteByThreadId: (
    input: DeleteProjectionThreadSessionInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

/**
 * ProjectionThreadSessionRepository - Service tag for thread-session persistence.
 */
export class ProjectionThreadSessionRepository extends Context.Service<
  ProjectionThreadSessionRepository,
  ProjectionThreadSessionRepositoryShape
>()("cafecode/persistence/Services/ProjectionThreadSessions/ProjectionThreadSessionRepository") {}
