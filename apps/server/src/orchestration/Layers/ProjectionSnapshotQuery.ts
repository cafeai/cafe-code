import {
  ChatAttachment,
  AdditionalWorkspaceRoots,
  IsoDateTime,
  MAX_RUNTIME_SUBAGENT_IDENTITIES_PER_TURN,
  MessageId,
  NonNegativeInt,
  OrchestrationCheckpointFile,
  OrchestrationProposedPlanId,
  OrchestrationReadModel,
  OrchestrationShellSnapshot,
  OrchestrationThread,
  OrchestrationThreadTurnActivityPageInput,
  OrchestrationThreadTurnSubagentDetailInput,
  ProviderThreadGoal,
  ProjectScript,
  TurnId,
  type OrchestrationCheckpointSummary,
  type OrchestrationLatestTurn,
  type OrchestrationMessage,
  type OrchestrationProjectShell,
  type OrchestrationProposedPlan,
  type OrchestrationProject,
  type OrchestrationSession,
  type OrchestrationThreadActivity,
  type OrchestrationThreadShell,
  ModelSelection,
  ProjectId,
  ThreadId,
} from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  isPersistenceError,
  toPersistenceDecodeError,
  toPersistenceSqlError,
  type ProjectionRepositoryError,
} from "../../persistence/Errors.ts";
import { ProjectionCheckpoint } from "../../persistence/Services/ProjectionCheckpoints.ts";
import { ProjectionProject } from "../../persistence/Services/ProjectionProjects.ts";
import { ProjectionState } from "../../persistence/Services/ProjectionState.ts";
import { ProjectionThreadActivity } from "../../persistence/Services/ProjectionThreadActivities.ts";
import { ProjectionThreadMessage } from "../../persistence/Services/ProjectionThreadMessages.ts";
import { ProjectionThreadProposedPlan } from "../../persistence/Services/ProjectionThreadProposedPlans.ts";
import { ProjectionThreadSession } from "../../persistence/Services/ProjectionThreadSessions.ts";
import { ProjectionThread } from "../../persistence/Services/ProjectionThreads.ts";
import { RepositoryIdentityResolver } from "../../project/Services/RepositoryIdentityResolver.ts";
import { buildCodexSteerClientCorrelationId } from "../../provider/codexSteerCorrelation.ts";
import { ORCHESTRATION_PROJECTOR_NAMES } from "./ProjectionPipeline.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionCodexSteerAcceptanceEvidence,
  type ProjectionCodexSteerAcceptanceEvidenceInput,
  type ProjectionCodexSteerIntentRecoveryBarriers,
  type ProjectionSnapshotCounts,
  type ProjectionThreadCheckpointContext,
  type ProjectionSnapshotQueryShape,
  type ProjectionUnsettledCodexSteerIntentEvent,
} from "../Services/ProjectionSnapshotQuery.ts";

const decodeReadModel = Schema.decodeUnknownEffect(OrchestrationReadModel);
const decodeShellSnapshot = Schema.decodeUnknownEffect(OrchestrationShellSnapshot);
const decodeThread = Schema.decodeUnknownEffect(OrchestrationThread);
export const THREAD_DETAIL_ACTIVITY_LIMIT = 500;
export const THREAD_DETAIL_MESSAGE_LIMIT = 2_000;
const ProjectionProjectDbRowSchema = ProjectionProject.mapFields(
  Struct.assign({
    additionalWorkspaceRoots: Schema.fromJsonString(AdditionalWorkspaceRoots),
    defaultModelSelection: Schema.NullOr(Schema.fromJsonString(ModelSelection)),
    scripts: Schema.fromJsonString(Schema.Array(ProjectScript)),
  }),
);
const ProjectionThreadMessageDbRowSchema = ProjectionThreadMessage.mapFields(
  Struct.assign({
    isStreaming: Schema.Number,
    attachments: Schema.NullOr(Schema.fromJsonString(Schema.Array(ChatAttachment))),
  }),
);
type ProjectionThreadMessageDbRow = Schema.Schema.Type<typeof ProjectionThreadMessageDbRowSchema>;
const ProjectionThreadProposedPlanDbRowSchema = ProjectionThreadProposedPlan;
const ProjectionThreadDbRowSchema = ProjectionThread.mapFields(
  Struct.assign({
    modelSelection: Schema.fromJsonString(ModelSelection),
  }),
);
const ProjectionThreadActivityDbRowSchema = ProjectionThreadActivity.mapFields(
  Struct.assign({
    payload: Schema.fromJsonString(Schema.Unknown),
    sequence: Schema.NullOr(NonNegativeInt),
  }),
);
const ProjectionThreadDetailActivityDbRowSchema = Schema.Struct({
  ...ProjectionThreadActivityDbRowSchema.fields,
  /** One metadata-only warning bit shared by every row in a detail result. */
  subagentRetentionTruncated: Schema.Number,
});
const ProjectionThreadSessionDbRowSchema = ProjectionThreadSession;
const ProjectionThreadGoalDbRowSchema = ProviderThreadGoal;
const ProjectionCheckpointDbRowSchema = ProjectionCheckpoint.mapFields(
  Struct.assign({
    files: Schema.fromJsonString(Schema.Array(OrchestrationCheckpointFile)),
  }),
);
const ProjectionLatestTurnDbRowSchema = Schema.Struct({
  threadId: ProjectionThread.fields.threadId,
  turnId: TurnId,
  state: Schema.String,
  requestedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
  assistantMessageId: Schema.NullOr(MessageId),
  sourceProposedPlanThreadId: Schema.NullOr(ThreadId),
  sourceProposedPlanId: Schema.NullOr(OrchestrationProposedPlanId),
});
const ProjectionStateDbRowSchema = ProjectionState;
const ProjectionCountsRowSchema = Schema.Struct({
  projectCount: Schema.Number,
  threadCount: Schema.Number,
});
const WorkspaceRootLookupInput = Schema.Struct({
  workspaceRoot: Schema.String,
});
const ProjectIdLookupInput = Schema.Struct({
  projectId: ProjectId,
});
const ThreadIdLookupInput = Schema.Struct({
  threadId: ThreadId,
});
const CodexSteerAcceptanceEvidenceLookupInput = Schema.Struct({
  threadId: Schema.NullOr(ThreadId),
  acceptedTurnId: Schema.NullOr(TurnId),
  messageId: Schema.NullOr(MessageId),
});
const CodexSteerAcceptanceEvidenceRowSchema = Schema.Struct({
  threadId: ThreadId,
  acceptedTurnId: TurnId,
  clientCorrelationId: Schema.NullOr(Schema.String),
  messageId: MessageId,
  messageTurnId: Schema.NullOr(TurnId),
  messageText: Schema.String,
  messageAttachments: Schema.NullOr(Schema.fromJsonString(Schema.Array(ChatAttachment))),
  acceptedAt: IsoDateTime,
  turnState: Schema.Literals(["running", "completed", "error", "interrupted"]),
  turnCompletedAt: Schema.NullOr(IsoDateTime),
  processingObserved: NonNegativeInt,
  recoveryObserved: NonNegativeInt,
  interruptRequested: NonNegativeInt,
  sessionStopRequested: NonNegativeInt,
});
const UnsettledCodexSteerIntentEventRowSchema = Schema.Struct({
  sequence: NonNegativeInt,
  threadId: ThreadId,
  messageId: MessageId,
  expectedTurnId: Schema.NullOr(TurnId),
  createdAt: IsoDateTime,
});
const UnsettledCodexSteerIntentLookupInput = Schema.Struct({
  threadId: Schema.NullOr(ThreadId),
});
const CodexSteerIntentRecoveryBarrierLookupInput = Schema.Struct({
  sequence: NonNegativeInt,
  threadId: ThreadId,
  messageId: MessageId,
  expectedTurnId: Schema.NullOr(TurnId),
});
const CodexSteerIntentRecoveryBarrierRowSchema = Schema.Struct({
  intentVerified: NonNegativeInt,
  newerTurnRequested: NonNegativeInt,
  interruptRequested: NonNegativeInt,
  sessionStopRequested: NonNegativeInt,
});
const CodexSteerProcessingEvidenceLookupInput = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  clientCorrelationId: Schema.String,
  taskId: Schema.String,
});
const CodexSteerProcessingEvidenceRowSchema = Schema.Struct({
  processingObserved: NonNegativeInt,
});
const ThreadTurnActivityPageLookupInput = OrchestrationThreadTurnActivityPageInput;
const ThreadTurnLookupInput = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
});
const ThreadTurnSubagentLookupInput = OrchestrationThreadTurnSubagentDetailInput;
const CountRowSchema = Schema.Struct({
  count: NonNegativeInt,
});
const WorkLogPresenceRowSchema = Schema.Struct({
  hasWorkLog: NonNegativeInt,
});
const SubagentActivityPresenceRowSchema = Schema.Struct({
  hasSubagentActivity: NonNegativeInt,
});
const ProjectionProjectLookupRowSchema = ProjectionProjectDbRowSchema;
const ProjectionThreadIdLookupRowSchema = Schema.Struct({
  threadId: ThreadId,
});
const ProjectionThreadCheckpointContextThreadRowSchema = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  workspaceRoot: Schema.String,
  worktreePath: Schema.NullOr(Schema.String),
});
const REQUIRED_SNAPSHOT_PROJECTORS = [
  ORCHESTRATION_PROJECTOR_NAMES.projects,
  ORCHESTRATION_PROJECTOR_NAMES.threads,
  ORCHESTRATION_PROJECTOR_NAMES.threadMessages,
  ORCHESTRATION_PROJECTOR_NAMES.threadProposedPlans,
  ORCHESTRATION_PROJECTOR_NAMES.threadActivities,
  ORCHESTRATION_PROJECTOR_NAMES.threadSessions,
  ORCHESTRATION_PROJECTOR_NAMES.threadGoals,
  ORCHESTRATION_PROJECTOR_NAMES.checkpoints,
] as const;

function maxIso(left: string | null, right: string): string {
  if (left === null) {
    return right;
  }
  return left > right ? left : right;
}

function computeSnapshotSequence(
  stateRows: ReadonlyArray<Schema.Schema.Type<typeof ProjectionStateDbRowSchema>>,
): number {
  if (stateRows.length === 0) {
    return 0;
  }
  const sequenceByProjector = new Map(
    stateRows.map((row) => [row.projector, row.lastAppliedSequence] as const),
  );

  let minSequence = Number.POSITIVE_INFINITY;
  for (const projector of REQUIRED_SNAPSHOT_PROJECTORS) {
    const sequence = sequenceByProjector.get(projector);
    if (sequence === undefined) {
      return 0;
    }
    if (sequence < minSequence) {
      minSequence = sequence;
    }
  }

  return Number.isFinite(minSequence) ? minSequence : 0;
}

function mapLatestTurn(
  row: Schema.Schema.Type<typeof ProjectionLatestTurnDbRowSchema>,
): OrchestrationLatestTurn {
  return {
    turnId: row.turnId,
    state:
      row.state === "error"
        ? "error"
        : row.state === "interrupted"
          ? "interrupted"
          : row.state === "completed"
            ? "completed"
            : "running",
    requestedAt: row.requestedAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    assistantMessageId: row.assistantMessageId,
    ...(row.sourceProposedPlanThreadId !== null && row.sourceProposedPlanId !== null
      ? {
          sourceProposedPlan: {
            threadId: row.sourceProposedPlanThreadId,
            planId: row.sourceProposedPlanId,
          },
        }
      : {}),
  };
}

function mapSessionRow(
  row: Schema.Schema.Type<typeof ProjectionThreadSessionDbRowSchema>,
): OrchestrationSession {
  return {
    threadId: row.threadId,
    status: row.status,
    providerName: row.providerName,
    ...(row.providerInstanceId !== null ? { providerInstanceId: row.providerInstanceId } : {}),
    runtimeMode: row.runtimeMode,
    activeTurnId: row.activeTurnId,
    lastError: row.lastError,
    updatedAt: row.updatedAt,
  };
}

function reconcileSessionWithLatestTurn(
  session: OrchestrationSession,
  latestTurn: OrchestrationLatestTurn | null | undefined,
): OrchestrationSession {
  if (session.activeTurnId === null) {
    return session;
  }

  if (latestTurn?.turnId !== session.activeTurnId) {
    if (session.status !== "running") {
      return {
        ...session,
        activeTurnId: null,
      };
    }
    if (
      latestTurn !== null &&
      latestTurn !== undefined &&
      latestTurn.completedAt !== null &&
      latestTurn.completedAt >= session.updatedAt &&
      (latestTurn.state === "completed" ||
        latestTurn.state === "interrupted" ||
        latestTurn.state === "error")
    ) {
      return {
        ...session,
        status: latestTurn.state === "completed" ? "ready" : latestTurn.state,
        activeTurnId: null,
        lastError: latestTurn.state === "completed" ? null : session.lastError,
        updatedAt: maxIso(session.updatedAt, latestTurn.completedAt),
      };
    }
    return session;
  }

  if (latestTurn.state === "completed" && latestTurn.completedAt !== null) {
    return {
      ...session,
      status: "ready",
      activeTurnId: null,
      lastError: null,
      updatedAt: maxIso(session.updatedAt, latestTurn.completedAt),
    };
  }

  if (latestTurn.state === "interrupted" || latestTurn.state === "error") {
    return {
      ...session,
      status: latestTurn.state,
      activeTurnId: null,
      updatedAt:
        latestTurn.completedAt !== null
          ? maxIso(session.updatedAt, latestTurn.completedAt)
          : session.updatedAt,
    };
  }

  if (latestTurn.state === "running" && session.status !== "running") {
    return {
      ...session,
      status: "running",
    };
  }

  return session;
}

function mapSessionRowForThread(
  row: Schema.Schema.Type<typeof ProjectionThreadSessionDbRowSchema>,
  latestTurn: OrchestrationLatestTurn | null | undefined,
): OrchestrationSession {
  return reconcileSessionWithLatestTurn(mapSessionRow(row), latestTurn);
}

function codexSnapshotAssistantMessageKey(row: ProjectionThreadMessageDbRow): string | undefined {
  const text = row.text.trim();
  if (
    row.role !== "assistant" ||
    row.turnId === null ||
    row.isStreaming !== 0 ||
    text.length === 0 ||
    (row.attachments?.length ?? 0) > 0
  ) {
    return undefined;
  }
  return [row.threadId, row.turnId, text].join("\u0000");
}

function isCodexSnapshotAssistantItemMessageId(messageId: MessageId): boolean {
  return /^assistant:item-\d+$/.test(String(messageId));
}

function dedupeCodexSnapshotAssistantMessages(
  rows: ReadonlyArray<ProjectionThreadMessageDbRow>,
): ReadonlyArray<ProjectionThreadMessageDbRow> {
  const liveAssistantMessageKeys = new Set<string>();
  for (const row of rows) {
    if (isCodexSnapshotAssistantItemMessageId(row.messageId)) {
      continue;
    }
    const key = codexSnapshotAssistantMessageKey(row);
    if (key) {
      liveAssistantMessageKeys.add(key);
    }
  }

  const retainedSnapshotKeys = new Set<string>();
  return rows.filter((row) => {
    const key = codexSnapshotAssistantMessageKey(row);
    if (!key || !isCodexSnapshotAssistantItemMessageId(row.messageId)) {
      return true;
    }
    // Codex delayed snapshot backfill is reconciliation data. When the live
    // stream has already produced the same assistant text for the same turn,
    // keep the live message and suppress the snapshot-only item row so old
    // projections do not show duplicated assistant bubbles.
    if (liveAssistantMessageKeys.has(key) || retainedSnapshotKeys.has(key)) {
      return false;
    }
    retainedSnapshotKeys.add(key);
    return true;
  });
}

function mapProjectShellRow(
  row: Schema.Schema.Type<typeof ProjectionProjectDbRowSchema>,
  repositoryIdentity: OrchestrationProject["repositoryIdentity"],
): OrchestrationProjectShell {
  return {
    id: row.projectId,
    title: row.title,
    workspaceRoot: row.workspaceRoot,
    additionalWorkspaceRoots: row.additionalWorkspaceRoots,
    repositoryIdentity,
    defaultModelSelection: row.defaultModelSelection,
    scripts: row.scripts,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapProposedPlanRow(
  row: Schema.Schema.Type<typeof ProjectionThreadProposedPlanDbRowSchema>,
): OrchestrationProposedPlan {
  return {
    id: row.planId,
    turnId: row.turnId,
    planMarkdown: row.planMarkdown,
    implementedAt: row.implementedAt,
    implementationThreadId: row.implementationThreadId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapActivityRow(
  row: Schema.Schema.Type<typeof ProjectionThreadActivityDbRowSchema>,
): OrchestrationThreadActivity {
  const activity = {
    id: row.activityId,
    tone: row.tone,
    kind: row.kind,
    summary: row.summary,
    payload: row.payload,
    turnId: row.turnId,
    createdAt: row.createdAt,
  };
  if (row.sequence !== null) {
    return Object.assign(activity, { sequence: row.sequence });
  }
  return activity;
}

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown): ProjectionRepositoryError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeProjectionSnapshotQuery = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const repositoryIdentityResolver = yield* RepositoryIdentityResolver;
  /**
   * The historical Work Log count, page, and presence queries must agree on
   * exactly which persisted activities can produce a Work Log row. Keeping
   * this as one trusted, static SQL fragment prevents the three queries from
   * drifting and, importantly, ensures provider subagent lifecycle events do
   * not consume command-log pages after subagents moved to their own roster.
   *
   * Thread and turn identities remain separately bound SQL parameters at each
   * call site. The strings below are application-owned SQL, never provider or
   * user input. `payload.subagent` is a reserved structured-lifecycle marker;
   * fail closed for every non-null JSON value so malformed provider metadata
   * cannot make a subagent row leak back into the ordinary Work Log.
   */
  const historicalWorkLogActivityPredicate = sql.and([
    "kind != 'context-window.updated'",
    "kind != 'checkpoint.captured'",
    "kind != 'task.started'",
    "summary != 'Checkpoint captured'",
    "(kind != 'tool.started' OR json_extract(payload_json, '$.itemType') = 'context_compaction')",
    "NOT (kind IN ('task.started', 'task.progress', 'task.completed') AND json_type(payload_json, '$.subagent') IS NOT NULL)",
    "NOT (kind IN ('tool.updated', 'tool.completed') AND COALESCE(json_extract(payload_json, '$.detail'), '') LIKE 'ExitPlanMode:%')",
    "NOT (kind = 'provider.turn.steer.failed' AND json_extract(payload_json, '$.retryableFollowUp') = 1)",
  ]);
  // Diagnostics are bounded and keyed only by Cafe thread/turn identity. Never
  // log provider child ids or presentation text when the safety ceiling trips.
  const reportedSubagentRetentionLimits = new Map<string, true>();
  const repositoryIdentityResolutionConcurrency = 4;
  const resolveRepositoryIdentitiesForProjects = Effect.fn(
    "ProjectionSnapshotQuery.resolveRepositoryIdentitiesForProjects",
  )(function* (
    projectRows: ReadonlyArray<Schema.Schema.Type<typeof ProjectionProjectDbRowSchema>>,
    options?: {
      readonly includeDeleted?: boolean;
    },
  ) {
    const filteredProjectRows =
      options?.includeDeleted === true
        ? projectRows
        : projectRows.filter((row) => row.deletedAt === null);
    const uniqueWorkspaceRoots = [...new Set(filteredProjectRows.map((row) => row.workspaceRoot))];
    const repositoryIdentityByWorkspaceRoot = new Map(
      yield* Effect.forEach(
        uniqueWorkspaceRoots,
        (workspaceRoot) =>
          repositoryIdentityResolver
            .resolve(workspaceRoot)
            .pipe(Effect.map((identity) => [workspaceRoot, identity] as const)),
        { concurrency: repositoryIdentityResolutionConcurrency },
      ),
    );

    return new Map(
      filteredProjectRows.map((row) => [
        row.projectId,
        repositoryIdentityByWorkspaceRoot.get(row.workspaceRoot) ?? null,
      ]),
    );
  });

  const listProjectRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionProjectDbRowSchema,
    execute: () =>
      sql`
        SELECT
          project_id AS "projectId",
          title,
          workspace_root AS "workspaceRoot",
          additional_workspace_roots_json AS "additionalWorkspaceRoots",
          default_model_selection_json AS "defaultModelSelection",
          scripts_json AS "scripts",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_projects
        ORDER BY created_at ASC, project_id ASC
      `,
  });

  const listThreadRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          title,
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          branch,
          worktree_path AS "worktreePath",
          latest_turn_id AS "latestTurnId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          latest_user_message_at AS "latestUserMessageAt",
          pending_approval_count AS "pendingApprovalCount",
          pending_user_input_count AS "pendingUserInputCount",
          has_actionable_proposed_plan AS "hasActionableProposedPlan",
          deleted_at AS "deletedAt"
        FROM projection_threads
        ORDER BY created_at ASC, thread_id ASC
      `,
  });

  const listActiveThreadRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          title,
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          branch,
          worktree_path AS "worktreePath",
          latest_turn_id AS "latestTurnId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          latest_user_message_at AS "latestUserMessageAt",
          pending_approval_count AS "pendingApprovalCount",
          pending_user_input_count AS "pendingUserInputCount",
          has_actionable_proposed_plan AS "hasActionableProposedPlan",
          deleted_at AS "deletedAt"
        FROM projection_threads
        WHERE deleted_at IS NULL
          AND archived_at IS NULL
        ORDER BY project_id ASC, created_at ASC, thread_id ASC
      `,
  });

  const listArchivedThreadRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          title,
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          branch,
          worktree_path AS "worktreePath",
          latest_turn_id AS "latestTurnId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          latest_user_message_at AS "latestUserMessageAt",
          pending_approval_count AS "pendingApprovalCount",
          pending_user_input_count AS "pendingUserInputCount",
          has_actionable_proposed_plan AS "hasActionableProposedPlan",
          deleted_at AS "deletedAt"
        FROM projection_threads
        WHERE deleted_at IS NULL
          AND archived_at IS NOT NULL
        ORDER BY project_id ASC, archived_at DESC, thread_id DESC
      `,
  });

  const listDeletedThreadRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          title,
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          branch,
          worktree_path AS "worktreePath",
          latest_turn_id AS "latestTurnId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          latest_user_message_at AS "latestUserMessageAt",
          pending_approval_count AS "pendingApprovalCount",
          pending_user_input_count AS "pendingUserInputCount",
          has_actionable_proposed_plan AS "hasActionableProposedPlan",
          deleted_at AS "deletedAt"
        FROM projection_threads
        WHERE deleted_at IS NOT NULL
        ORDER BY project_id ASC, deleted_at DESC, thread_id DESC
      `,
  });

  const listThreadMessageRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: () =>
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
        ORDER BY thread_id ASC, created_at ASC, message_id ASC
      `,
  });

  const listThreadProposedPlanRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadProposedPlanDbRowSchema,
    execute: () =>
      sql`
        SELECT
          plan_id AS "planId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          plan_markdown AS "planMarkdown",
          implemented_at AS "implementedAt",
          implementation_thread_id AS "implementationThreadId",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_proposed_plans
        ORDER BY thread_id ASC, created_at ASC, plan_id ASC
      `,
  });

  const listThreadActivityRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: () =>
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
        ORDER BY
          thread_id ASC,
          sequence ASC,
          created_at ASC,
          activity_id ASC
      `,
  });

  const listThreadSessionRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadSessionDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          status,
          provider_name AS "providerName",
          provider_instance_id AS "providerInstanceId",
          provider_session_id AS "providerSessionId",
          provider_thread_id AS "providerThreadId",
          runtime_mode AS "runtimeMode",
          active_turn_id AS "activeTurnId",
          last_error AS "lastError",
          updated_at AS "updatedAt"
        FROM projection_thread_sessions
        ORDER BY thread_id ASC
      `,
  });

  const listThreadGoalRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadGoalDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          objective,
          status,
          token_budget AS "tokenBudget",
          tokens_used AS "tokensUsed",
          time_used_seconds AS "timeUsedSeconds",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_goals
        ORDER BY thread_id ASC
      `,
  });

  const listActiveThreadSessionRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadSessionDbRowSchema,
    execute: () =>
      sql`
        SELECT
          sessions.thread_id AS "threadId",
          sessions.status,
          sessions.provider_name AS "providerName",
          sessions.provider_instance_id AS "providerInstanceId",
          sessions.provider_session_id AS "providerSessionId",
          sessions.provider_thread_id AS "providerThreadId",
          sessions.runtime_mode AS "runtimeMode",
          sessions.active_turn_id AS "activeTurnId",
          sessions.last_error AS "lastError",
          sessions.updated_at AS "updatedAt"
        FROM projection_thread_sessions sessions
        INNER JOIN projection_threads threads
          ON threads.thread_id = sessions.thread_id
        WHERE threads.deleted_at IS NULL
          AND threads.archived_at IS NULL
        ORDER BY sessions.thread_id ASC
      `,
  });

  const listArchivedThreadSessionRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadSessionDbRowSchema,
    execute: () =>
      sql`
        SELECT
          sessions.thread_id AS "threadId",
          sessions.status,
          sessions.provider_name AS "providerName",
          sessions.provider_instance_id AS "providerInstanceId",
          sessions.provider_session_id AS "providerSessionId",
          sessions.provider_thread_id AS "providerThreadId",
          sessions.runtime_mode AS "runtimeMode",
          sessions.active_turn_id AS "activeTurnId",
          sessions.last_error AS "lastError",
          sessions.updated_at AS "updatedAt"
        FROM projection_thread_sessions sessions
        INNER JOIN projection_threads threads
          ON threads.thread_id = sessions.thread_id
        WHERE threads.deleted_at IS NULL
          AND threads.archived_at IS NOT NULL
        ORDER BY sessions.thread_id ASC
      `,
  });

  const listDeletedThreadSessionRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadSessionDbRowSchema,
    execute: () =>
      sql`
        SELECT
          sessions.thread_id AS "threadId",
          sessions.status,
          sessions.provider_name AS "providerName",
          sessions.provider_instance_id AS "providerInstanceId",
          sessions.provider_session_id AS "providerSessionId",
          sessions.provider_thread_id AS "providerThreadId",
          sessions.runtime_mode AS "runtimeMode",
          sessions.active_turn_id AS "activeTurnId",
          sessions.last_error AS "lastError",
          sessions.updated_at AS "updatedAt"
        FROM projection_thread_sessions sessions
        INNER JOIN projection_threads threads
          ON threads.thread_id = sessions.thread_id
        WHERE threads.deleted_at IS NOT NULL
        ORDER BY sessions.thread_id ASC
      `,
  });

  const listCheckpointRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionCheckpointDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          turn_id AS "turnId",
          checkpoint_turn_count AS "checkpointTurnCount",
          checkpoint_ref AS "checkpointRef",
          checkpoint_status AS "status",
          checkpoint_files_json AS "files",
          assistant_message_id AS "assistantMessageId",
          COALESCE(checkpoint_completed_at, completed_at) AS "completedAt"
        FROM projection_turns
        WHERE checkpoint_turn_count IS NOT NULL
          AND checkpoint_ref IS NOT NULL
          AND checkpoint_status IS NOT NULL
          AND checkpoint_files_json IS NOT NULL
          AND COALESCE(checkpoint_completed_at, completed_at) IS NOT NULL
        ORDER BY thread_id ASC, checkpoint_turn_count ASC
      `,
  });

  const listLatestTurnRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionLatestTurnDbRowSchema,
    execute: () =>
      sql`
        SELECT
          turns.thread_id AS "threadId",
          turns.turn_id AS "turnId",
          turns.state,
          turns.requested_at AS "requestedAt",
          turns.started_at AS "startedAt",
          turns.completed_at AS "completedAt",
          turns.assistant_message_id AS "assistantMessageId",
          turns.source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          turns.source_proposed_plan_id AS "sourceProposedPlanId"
        FROM projection_threads threads
        JOIN projection_turns turns
          ON turns.thread_id = threads.thread_id
          AND turns.turn_id = threads.latest_turn_id
        WHERE threads.latest_turn_id IS NOT NULL
        ORDER BY turns.thread_id ASC
      `,
  });

  const listActiveLatestTurnRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionLatestTurnDbRowSchema,
    execute: () =>
      sql`
        SELECT
          turns.thread_id AS "threadId",
          turns.turn_id AS "turnId",
          turns.state,
          turns.requested_at AS "requestedAt",
          turns.started_at AS "startedAt",
          turns.completed_at AS "completedAt",
          turns.assistant_message_id AS "assistantMessageId",
          turns.source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          turns.source_proposed_plan_id AS "sourceProposedPlanId"
        FROM projection_threads threads
        JOIN projection_turns turns
          ON turns.thread_id = threads.thread_id
          AND turns.turn_id = threads.latest_turn_id
        WHERE threads.deleted_at IS NULL
          AND threads.archived_at IS NULL
          AND threads.latest_turn_id IS NOT NULL
        ORDER BY turns.thread_id ASC
      `,
  });

  const listArchivedLatestTurnRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionLatestTurnDbRowSchema,
    execute: () =>
      sql`
        SELECT
          turns.thread_id AS "threadId",
          turns.turn_id AS "turnId",
          turns.state,
          turns.requested_at AS "requestedAt",
          turns.started_at AS "startedAt",
          turns.completed_at AS "completedAt",
          turns.assistant_message_id AS "assistantMessageId",
          turns.source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          turns.source_proposed_plan_id AS "sourceProposedPlanId"
        FROM projection_threads threads
        JOIN projection_turns turns
          ON turns.thread_id = threads.thread_id
          AND turns.turn_id = threads.latest_turn_id
        WHERE threads.deleted_at IS NULL
          AND threads.archived_at IS NOT NULL
          AND threads.latest_turn_id IS NOT NULL
        ORDER BY turns.thread_id ASC
      `,
  });

  const listDeletedLatestTurnRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionLatestTurnDbRowSchema,
    execute: () =>
      sql`
        SELECT
          turns.thread_id AS "threadId",
          turns.turn_id AS "turnId",
          turns.state,
          turns.requested_at AS "requestedAt",
          turns.started_at AS "startedAt",
          turns.completed_at AS "completedAt",
          turns.assistant_message_id AS "assistantMessageId",
          turns.source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          turns.source_proposed_plan_id AS "sourceProposedPlanId"
        FROM projection_threads threads
        JOIN projection_turns turns
          ON turns.thread_id = threads.thread_id
          AND turns.turn_id = threads.latest_turn_id
        WHERE threads.deleted_at IS NOT NULL
          AND threads.latest_turn_id IS NOT NULL
        ORDER BY turns.thread_id ASC
      `,
  });

  const listProjectionStateRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionStateDbRowSchema,
    execute: () =>
      sql`
        SELECT
          projector,
          last_applied_sequence AS "lastAppliedSequence",
          updated_at AS "updatedAt"
        FROM projection_state
      `,
  });

  const readProjectionCounts = SqlSchema.findOne({
    Request: Schema.Void,
    Result: ProjectionCountsRowSchema,
    execute: () =>
      sql`
        SELECT
          (SELECT COUNT(*) FROM projection_projects) AS "projectCount",
          (SELECT COUNT(*) FROM projection_threads) AS "threadCount"
      `,
  });

  const getActiveProjectRowByWorkspaceRoot = SqlSchema.findOneOption({
    Request: WorkspaceRootLookupInput,
    Result: ProjectionProjectLookupRowSchema,
    execute: ({ workspaceRoot }) =>
      sql`
        SELECT
          project_id AS "projectId",
          title,
          workspace_root AS "workspaceRoot",
          additional_workspace_roots_json AS "additionalWorkspaceRoots",
          default_model_selection_json AS "defaultModelSelection",
          scripts_json AS "scripts",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_projects
        WHERE workspace_root = ${workspaceRoot}
          AND deleted_at IS NULL
        ORDER BY created_at ASC, project_id ASC
        LIMIT 1
      `,
  });

  const getActiveProjectRowById = SqlSchema.findOneOption({
    Request: ProjectIdLookupInput,
    Result: ProjectionProjectLookupRowSchema,
    execute: ({ projectId }) =>
      sql`
        SELECT
          project_id AS "projectId",
          title,
          workspace_root AS "workspaceRoot",
          additional_workspace_roots_json AS "additionalWorkspaceRoots",
          default_model_selection_json AS "defaultModelSelection",
          scripts_json AS "scripts",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_projects
        WHERE project_id = ${projectId}
          AND deleted_at IS NULL
        LIMIT 1
      `,
  });

  const getFirstActiveThreadIdByProject = SqlSchema.findOneOption({
    Request: ProjectIdLookupInput,
    Result: ProjectionThreadIdLookupRowSchema,
    execute: ({ projectId }) =>
      sql`
        SELECT
          thread_id AS "threadId"
        FROM projection_threads
        WHERE project_id = ${projectId}
          AND deleted_at IS NULL
          AND archived_at IS NULL
        ORDER BY created_at ASC, thread_id ASC
        LIMIT 1
      `,
  });

  const getThreadCheckpointContextThreadRow = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadCheckpointContextThreadRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          threads.thread_id AS "threadId",
          threads.project_id AS "projectId",
          projects.workspace_root AS "workspaceRoot",
          threads.worktree_path AS "worktreePath"
        FROM projection_threads AS threads
        INNER JOIN projection_projects AS projects
          ON projects.project_id = threads.project_id
        WHERE threads.thread_id = ${threadId}
          AND threads.deleted_at IS NULL
        LIMIT 1
      `,
  });

  const getActiveThreadRowById = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          title,
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          branch,
          worktree_path AS "worktreePath",
          latest_turn_id AS "latestTurnId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          latest_user_message_at AS "latestUserMessageAt",
          pending_approval_count AS "pendingApprovalCount",
          pending_user_input_count AS "pendingUserInputCount",
          has_actionable_proposed_plan AS "hasActionableProposedPlan",
          deleted_at AS "deletedAt"
        FROM projection_threads
        WHERE thread_id = ${threadId}
          AND deleted_at IS NULL
          AND archived_at IS NULL
        LIMIT 1
      `,
  });

  const listPostTerminalStaleSteerCandidateThreadRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadIdLookupRowSchema,
    execute: () =>
      sql`
        SELECT
          DISTINCT threads.thread_id AS "threadId"
        FROM projection_threads AS threads
        LEFT JOIN projection_turns AS latest_turns
          ON latest_turns.thread_id = threads.thread_id
          AND latest_turns.turn_id = threads.latest_turn_id
        INNER JOIN projection_thread_sessions AS sessions
          ON sessions.thread_id = threads.thread_id
        WHERE threads.deleted_at IS NULL
          AND threads.archived_at IS NULL
          AND sessions.provider_name = 'codex'
          AND (
            (
              latest_turns.completed_at IS NOT NULL
              AND latest_turns.state IN ('completed', 'error', 'interrupted')
              AND EXISTS (
                SELECT 1
                FROM projection_thread_messages AS messages
                WHERE messages.thread_id = threads.thread_id
                  AND messages.turn_id = latest_turns.turn_id
                  AND messages.role = 'user'
                  AND messages.created_at > latest_turns.completed_at
                  AND NOT EXISTS (
                    SELECT 1
                    FROM projection_thread_activities AS recovered
                    WHERE recovered.thread_id = messages.thread_id
                      AND recovered.kind = 'provider.turn.steer.recovered'
                      AND json_extract(recovered.payload_json, '$.provider') = 'codex'
                      AND json_extract(recovered.payload_json, '$.messageId') =
                        messages.message_id
                      AND json_extract(recovered.payload_json, '$.acceptedTurnId') =
                        latest_turns.turn_id
                      AND json_extract(recovered.payload_json, '$.recoveredTurnId') =
                        recovered.turn_id
                      AND EXISTS (
                        SELECT 1
                        FROM orchestration_events AS recovered_event
                        WHERE recovered_event.aggregate_kind = 'thread'
                          AND recovered_event.stream_id = recovered.thread_id
                          AND recovered_event.event_type = 'thread.activity-appended'
                          AND recovered_event.actor_kind = 'server'
                          AND json_extract(recovered_event.payload_json, '$.threadId') =
                            recovered.thread_id
                          AND json_extract(recovered_event.payload_json, '$.activity.id') =
                            recovered.activity_id
                          AND json_extract(recovered_event.payload_json, '$.activity.kind') =
                            recovered.kind
                          AND json_extract(recovered_event.payload_json, '$.activity.turnId') =
                            recovered.turn_id
                          AND json_extract(
                            recovered_event.payload_json,
                            '$.activity.payload.provider'
                          ) = 'codex'
                          AND json_extract(
                            recovered_event.payload_json,
                            '$.activity.payload.messageId'
                          ) = messages.message_id
                          AND json_extract(
                            recovered_event.payload_json,
                            '$.activity.payload.acceptedTurnId'
                          ) = latest_turns.turn_id
                          AND json_extract(
                            recovered_event.payload_json,
                            '$.activity.payload.recoveredTurnId'
                          ) = recovered.turn_id
                          AND json_extract(
                            recovered_event.payload_json,
                            '$.activity.payload.clientCorrelationId'
                          ) IS json_extract(recovered.payload_json, '$.clientCorrelationId')
                        LIMIT 1
                      )
                    LIMIT 1
                  )
                LIMIT 1
              )
            )
            OR EXISTS (
              SELECT 1
              FROM projection_thread_activities AS accepted
              INNER JOIN projection_turns AS accepted_turn
                ON accepted_turn.thread_id = accepted.thread_id
                AND accepted_turn.turn_id = accepted.turn_id
              INNER JOIN projection_thread_messages AS accepted_message
                ON accepted_message.thread_id = accepted.thread_id
                AND accepted_message.role = 'user'
                AND accepted_message.message_id = json_extract(accepted.payload_json, '$.messageId')
              WHERE accepted.thread_id = threads.thread_id
                AND accepted.kind = 'provider.turn.steer.accepted'
                AND json_extract(accepted.payload_json, '$.provider') = 'codex'
                AND json_extract(accepted.payload_json, '$.acceptedTurnId') = accepted.turn_id
                AND (
                  json_type(accepted.payload_json, '$.clientCorrelationId') IS NULL
                  OR json_type(accepted.payload_json, '$.clientCorrelationId') = 'text'
                )
                AND accepted_turn.completed_at IS NOT NULL
                AND accepted_turn.state IN ('completed', 'error', 'interrupted')
                AND EXISTS (
                  SELECT 1
                  FROM orchestration_events AS accepted_event
                  WHERE accepted_event.aggregate_kind = 'thread'
                    AND accepted_event.stream_id = accepted.thread_id
                    AND accepted_event.event_type = 'thread.activity-appended'
                    AND accepted_event.actor_kind = 'server'
                    AND json_extract(accepted_event.payload_json, '$.threadId') = accepted.thread_id
                    AND json_extract(accepted_event.payload_json, '$.activity.id') = accepted.activity_id
                    AND json_extract(accepted_event.payload_json, '$.activity.kind') = accepted.kind
                    AND json_extract(accepted_event.payload_json, '$.activity.turnId') = accepted.turn_id
                    AND json_extract(accepted_event.payload_json, '$.activity.payload.provider') = 'codex'
                    AND json_extract(accepted_event.payload_json, '$.activity.payload.messageId') =
                      json_extract(accepted.payload_json, '$.messageId')
                    AND json_extract(accepted_event.payload_json, '$.activity.payload.acceptedTurnId') =
                      accepted.turn_id
                    AND json_extract(
                      accepted_event.payload_json,
                      '$.activity.payload.clientCorrelationId'
                    ) IS json_extract(accepted.payload_json, '$.clientCorrelationId')
                  LIMIT 1
                )
                AND NOT EXISTS (
                  SELECT 1
                  FROM projection_thread_activities AS processing
                  WHERE processing.thread_id = accepted.thread_id
                    AND processing.turn_id = accepted.turn_id
                    AND processing.kind = 'task.progress'
                    AND (
                      (
                        json_extract(accepted.payload_json, '$.clientCorrelationId') IS NOT NULL
                        AND json_extract(processing.payload_json, '$.taskId') =
                          'codex-turn-steer-processing:' ||
                            json_extract(accepted.payload_json, '$.clientCorrelationId')
                        AND json_extract(
                          processing.payload_json,
                          '$.usage.clientCorrelationId'
                        ) = json_extract(accepted.payload_json, '$.clientCorrelationId')
                        AND (
                          json_extract(processing.payload_json, '$.usage.messageId') IS NULL
                          OR json_extract(processing.payload_json, '$.usage.messageId') =
                            json_extract(accepted.payload_json, '$.messageId')
                        )
                      )
                      OR (
                        json_extract(accepted.payload_json, '$.clientCorrelationId') IS NULL
                        AND json_extract(processing.payload_json, '$.taskId') =
                          'codex-turn-steer-processing:' ||
                            json_extract(accepted.payload_json, '$.messageId')
                        AND json_extract(processing.payload_json, '$.usage.messageId') =
                          json_extract(accepted.payload_json, '$.messageId')
                      )
                    )
                  LIMIT 1
                )
                AND NOT EXISTS (
                  SELECT 1
                  FROM projection_thread_activities AS recovered
                  WHERE recovered.thread_id = accepted.thread_id
                    AND recovered.kind = 'provider.turn.steer.recovered'
                    AND json_extract(recovered.payload_json, '$.provider') = 'codex'
                    AND json_extract(recovered.payload_json, '$.messageId') =
                      json_extract(accepted.payload_json, '$.messageId')
                    AND json_extract(recovered.payload_json, '$.acceptedTurnId') = accepted.turn_id
                    AND json_extract(recovered.payload_json, '$.recoveredTurnId') = recovered.turn_id
                    AND json_extract(recovered.payload_json, '$.clientCorrelationId') IS
                      json_extract(accepted.payload_json, '$.clientCorrelationId')
                    AND EXISTS (
                      SELECT 1
                      FROM orchestration_events AS recovered_event
                      WHERE recovered_event.aggregate_kind = 'thread'
                        AND recovered_event.stream_id = recovered.thread_id
                        AND recovered_event.event_type = 'thread.activity-appended'
                        AND recovered_event.actor_kind = 'server'
                        AND json_extract(recovered_event.payload_json, '$.threadId') =
                          recovered.thread_id
                        AND json_extract(recovered_event.payload_json, '$.activity.id') =
                          recovered.activity_id
                        AND json_extract(recovered_event.payload_json, '$.activity.kind') =
                          recovered.kind
                        AND json_extract(recovered_event.payload_json, '$.activity.turnId') =
                          recovered.turn_id
                        AND json_extract(
                          recovered_event.payload_json,
                          '$.activity.payload.provider'
                        ) = 'codex'
                        AND json_extract(
                          recovered_event.payload_json,
                          '$.activity.payload.messageId'
                        ) = json_extract(recovered.payload_json, '$.messageId')
                        AND json_extract(
                          recovered_event.payload_json,
                          '$.activity.payload.acceptedTurnId'
                        ) = json_extract(recovered.payload_json, '$.acceptedTurnId')
                        AND json_extract(
                          recovered_event.payload_json,
                          '$.activity.payload.recoveredTurnId'
                        ) = recovered.turn_id
                        AND json_extract(
                          recovered_event.payload_json,
                          '$.activity.payload.clientCorrelationId'
                        ) IS json_extract(recovered.payload_json, '$.clientCorrelationId')
                      LIMIT 1
                    )
                  LIMIT 1
                )
              LIMIT 1
            )
          )
        ORDER BY threads.thread_id ASC
      `,
  });

  /**
   * Read acceptance evidence from the complete projection history rather than
   * the bounded thread-detail tails. A projected activity is trusted only when
   * its exact id and correlation fields are backed by a server-authored
   * `thread.activity-appended` orchestration event. This prevents a provider
   * warning (or a malformed projection row) from becoming replay authority.
   */
  const listCodexSteerAcceptanceEvidenceRows = SqlSchema.findAll({
    Request: CodexSteerAcceptanceEvidenceLookupInput,
    Result: CodexSteerAcceptanceEvidenceRowSchema,
    execute: ({ threadId, acceptedTurnId, messageId }) =>
      sql`
        SELECT
          accepted.thread_id AS "threadId",
          accepted.turn_id AS "acceptedTurnId",
          json_extract(accepted.payload_json, '$.clientCorrelationId') AS "clientCorrelationId",
          json_extract(accepted.payload_json, '$.messageId') AS "messageId",
          message.turn_id AS "messageTurnId",
          message.text AS "messageText",
          message.attachments_json AS "messageAttachments",
          accepted.created_at AS "acceptedAt",
          accepted_turn.state AS "turnState",
          accepted_turn.completed_at AS "turnCompletedAt",
          EXISTS (
            SELECT 1
            FROM projection_thread_activities AS processing
            WHERE processing.thread_id = accepted.thread_id
              AND processing.turn_id = accepted.turn_id
              AND processing.kind = 'task.progress'
              AND (
                (
                  json_extract(accepted.payload_json, '$.clientCorrelationId') IS NOT NULL
                  AND json_extract(processing.payload_json, '$.taskId') =
                    'codex-turn-steer-processing:' ||
                      json_extract(accepted.payload_json, '$.clientCorrelationId')
                  AND json_extract(processing.payload_json, '$.usage.clientCorrelationId') =
                    json_extract(accepted.payload_json, '$.clientCorrelationId')
                  AND (
                    json_extract(processing.payload_json, '$.usage.messageId') IS NULL
                    OR json_extract(processing.payload_json, '$.usage.messageId') =
                      json_extract(accepted.payload_json, '$.messageId')
                  )
                )
                OR (
                  json_extract(accepted.payload_json, '$.clientCorrelationId') IS NULL
                  AND json_extract(processing.payload_json, '$.taskId') =
                    'codex-turn-steer-processing:' ||
                      json_extract(accepted.payload_json, '$.messageId')
                  AND json_extract(processing.payload_json, '$.usage.messageId') =
                    json_extract(accepted.payload_json, '$.messageId')
                )
              )
            LIMIT 1
          ) AS "processingObserved",
          EXISTS (
            SELECT 1
            FROM projection_thread_activities AS recovered
            WHERE recovered.thread_id = accepted.thread_id
              AND recovered.kind = 'provider.turn.steer.recovered'
              AND json_extract(recovered.payload_json, '$.provider') = 'codex'
              AND json_extract(recovered.payload_json, '$.messageId') =
                json_extract(accepted.payload_json, '$.messageId')
              AND json_extract(recovered.payload_json, '$.acceptedTurnId') = accepted.turn_id
              AND json_extract(recovered.payload_json, '$.recoveredTurnId') = recovered.turn_id
              AND json_extract(recovered.payload_json, '$.clientCorrelationId') IS
                json_extract(accepted.payload_json, '$.clientCorrelationId')
              AND EXISTS (
                SELECT 1
                FROM orchestration_events AS recovered_event
                WHERE recovered_event.aggregate_kind = 'thread'
                  AND recovered_event.stream_id = recovered.thread_id
                  AND recovered_event.event_type = 'thread.activity-appended'
                  AND recovered_event.actor_kind = 'server'
                  AND json_extract(recovered_event.payload_json, '$.threadId') =
                    recovered.thread_id
                  AND json_extract(recovered_event.payload_json, '$.activity.id') =
                    recovered.activity_id
                  AND json_extract(recovered_event.payload_json, '$.activity.kind') =
                    recovered.kind
                  AND json_extract(recovered_event.payload_json, '$.activity.turnId') =
                    recovered.turn_id
                  AND json_extract(recovered_event.payload_json, '$.activity.payload.provider') =
                    'codex'
                  AND json_extract(recovered_event.payload_json, '$.activity.payload.messageId') =
                    json_extract(recovered.payload_json, '$.messageId')
                  AND json_extract(
                    recovered_event.payload_json,
                    '$.activity.payload.acceptedTurnId'
                  ) = json_extract(recovered.payload_json, '$.acceptedTurnId')
                  AND json_extract(
                    recovered_event.payload_json,
                    '$.activity.payload.recoveredTurnId'
                  ) = recovered.turn_id
                  AND json_extract(
                    recovered_event.payload_json,
                    '$.activity.payload.clientCorrelationId'
                  ) IS json_extract(recovered.payload_json, '$.clientCorrelationId')
                LIMIT 1
              )
            LIMIT 1
          ) AS "recoveryObserved",
          EXISTS (
            SELECT 1
            FROM orchestration_events AS interrupt_event
            WHERE interrupt_event.aggregate_kind = 'thread'
              AND interrupt_event.stream_id = accepted.thread_id
              AND interrupt_event.event_type = 'thread.turn-interrupt-requested'
              AND interrupt_event.actor_kind IN ('client', 'server')
              AND json_extract(interrupt_event.payload_json, '$.threadId') = accepted.thread_id
              AND (
                interrupt_event.sequence > accepted_event.sequence
                OR interrupt_event.occurred_at >= accepted.created_at
              )
              AND (
                json_extract(interrupt_event.payload_json, '$.turnId') IS NULL
                OR json_extract(interrupt_event.payload_json, '$.turnId') = accepted.turn_id
              )
            LIMIT 1
          ) AS "interruptRequested",
          EXISTS (
            SELECT 1
            FROM orchestration_events AS stop_event
            WHERE stop_event.aggregate_kind = 'thread'
              AND stop_event.stream_id = accepted.thread_id
              AND stop_event.event_type = 'thread.session-stop-requested'
              AND stop_event.actor_kind IN ('client', 'server')
              AND json_extract(stop_event.payload_json, '$.threadId') = accepted.thread_id
              AND (
                stop_event.sequence > accepted_event.sequence
                OR stop_event.occurred_at >= accepted.created_at
              )
            LIMIT 1
          ) AS "sessionStopRequested"
        FROM projection_thread_activities AS accepted
        INNER JOIN orchestration_events AS accepted_event
          ON accepted_event.aggregate_kind = 'thread'
          AND accepted_event.stream_id = accepted.thread_id
          AND accepted_event.event_type = 'thread.activity-appended'
          AND accepted_event.actor_kind = 'server'
          AND json_extract(accepted_event.payload_json, '$.threadId') = accepted.thread_id
          AND json_extract(accepted_event.payload_json, '$.activity.id') = accepted.activity_id
          AND json_extract(accepted_event.payload_json, '$.activity.kind') = accepted.kind
          AND json_extract(accepted_event.payload_json, '$.activity.turnId') = accepted.turn_id
          AND json_extract(accepted_event.payload_json, '$.activity.payload.provider') = 'codex'
          AND json_extract(accepted_event.payload_json, '$.activity.payload.messageId') =
            json_extract(accepted.payload_json, '$.messageId')
          AND json_extract(accepted_event.payload_json, '$.activity.payload.acceptedTurnId') =
            accepted.turn_id
          AND json_extract(
            accepted_event.payload_json,
            '$.activity.payload.clientCorrelationId'
          ) IS json_extract(accepted.payload_json, '$.clientCorrelationId')
        INNER JOIN projection_thread_messages AS message
          ON message.thread_id = accepted.thread_id
          AND message.message_id = json_extract(accepted.payload_json, '$.messageId')
          AND message.role = 'user'
        INNER JOIN projection_turns AS accepted_turn
          ON accepted_turn.thread_id = accepted.thread_id
          AND accepted_turn.turn_id = accepted.turn_id
        WHERE accepted.kind = 'provider.turn.steer.accepted'
          AND json_extract(accepted.payload_json, '$.provider') = 'codex'
          AND json_extract(accepted.payload_json, '$.acceptedTurnId') = accepted.turn_id
          AND (
            json_type(accepted.payload_json, '$.clientCorrelationId') IS NULL
            OR json_type(accepted.payload_json, '$.clientCorrelationId') = 'text'
          )
          AND (${threadId} IS NULL OR accepted.thread_id = ${threadId})
          AND (${acceptedTurnId} IS NULL OR accepted.turn_id = ${acceptedTurnId})
          AND (
            ${messageId} IS NULL
            OR json_extract(accepted.payload_json, '$.messageId') = ${messageId}
          )
        ORDER BY accepted.created_at ASC, accepted.thread_id ASC, accepted.turn_id ASC,
          json_extract(accepted.payload_json, '$.messageId') ASC
      `,
  });

  /**
   * Discover event-store intents, not projected message tails. A crash can
   * happen after the canonical steer event commits but before the reactor
   * reaches provider I/O, so there may be no acceptance activity to drive the
   * older recovery query. Only authenticated client/server events for active
   * Codex threads are eligible; provider-authored lookalikes never become
   * replay authority. Successful delivery stays correlated by the immutable
   * Cafe message id for renderer settlement, while pre-I/O attempts and queue
   * failures additionally bind the exact intent sequence because an automatic
   * retry intentionally reuses MessageId. Activity outcomes require a later,
   * exact server-authored event join before they can suppress startup replay.
   */
  const listUnsettledCodexSteerIntentEventRows = SqlSchema.findAll({
    Request: UnsettledCodexSteerIntentLookupInput,
    Result: UnsettledCodexSteerIntentEventRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          intent.sequence AS "sequence",
          intent.stream_id AS "threadId",
          json_extract(intent.payload_json, '$.messageId') AS "messageId",
          json_extract(intent.payload_json, '$.expectedTurnId') AS "expectedTurnId",
          intent.occurred_at AS "createdAt"
        FROM orchestration_events AS intent
        INNER JOIN projection_threads AS threads
          ON threads.thread_id = intent.stream_id
        INNER JOIN projection_thread_sessions AS sessions
          ON sessions.thread_id = intent.stream_id
        WHERE intent.aggregate_kind = 'thread'
          AND intent.event_type = 'thread.turn-steer-requested'
          AND intent.actor_kind IN ('client', 'server')
          AND threads.deleted_at IS NULL
          AND threads.archived_at IS NULL
          AND sessions.provider_name = 'codex'
          AND (${threadId} IS NULL OR intent.stream_id = ${threadId})
          AND json_extract(intent.payload_json, '$.threadId') = intent.stream_id
          AND json_type(intent.payload_json, '$.messageId') = 'text'
          AND (
            json_type(intent.payload_json, '$.expectedTurnId') IS NULL
            OR json_type(intent.payload_json, '$.expectedTurnId') IN ('text', 'null')
          )
          AND json_extract(intent.payload_json, '$.createdAt') = intent.occurred_at
          AND NOT EXISTS (
            SELECT 1
            FROM projection_thread_activities AS accepted
            WHERE accepted.thread_id = intent.stream_id
              AND accepted.kind = 'provider.turn.steer.accepted'
              AND json_extract(accepted.payload_json, '$.provider') = 'codex'
              AND json_extract(accepted.payload_json, '$.messageId') =
                json_extract(intent.payload_json, '$.messageId')
              AND json_extract(accepted.payload_json, '$.acceptedTurnId') = accepted.turn_id
              AND (
                json_type(accepted.payload_json, '$.clientCorrelationId') IS NULL
                OR json_type(accepted.payload_json, '$.clientCorrelationId') = 'text'
              )
              AND EXISTS (
                SELECT 1
                FROM orchestration_events AS accepted_event
                WHERE accepted_event.aggregate_kind = 'thread'
                  AND accepted_event.sequence > intent.sequence
                  AND accepted_event.stream_id = accepted.thread_id
                  AND accepted_event.event_type = 'thread.activity-appended'
                  AND accepted_event.actor_kind = 'server'
                  AND json_extract(accepted_event.payload_json, '$.threadId') =
                    accepted.thread_id
                  AND json_extract(accepted_event.payload_json, '$.activity.id') =
                    accepted.activity_id
                  AND json_extract(accepted_event.payload_json, '$.activity.kind') = accepted.kind
                  AND json_extract(accepted_event.payload_json, '$.activity.turnId') IS
                    accepted.turn_id
                  AND json_extract(accepted_event.payload_json, '$.activity.payload.provider') =
                    'codex'
                  AND json_extract(accepted_event.payload_json, '$.activity.payload.messageId') =
                    json_extract(accepted.payload_json, '$.messageId')
                  AND json_extract(
                    accepted_event.payload_json,
                    '$.activity.payload.acceptedTurnId'
                  ) = accepted.turn_id
                  AND json_extract(
                    accepted_event.payload_json,
                    '$.activity.payload.clientCorrelationId'
                  ) IS json_extract(accepted.payload_json, '$.clientCorrelationId')
                LIMIT 1
              )
            LIMIT 1
          )
          AND NOT EXISTS (
            SELECT 1
            FROM projection_thread_activities AS failed
            WHERE failed.thread_id = intent.stream_id
              AND failed.kind = 'provider.turn.steer.failed'
              AND json_extract(failed.payload_json, '$.messageId') =
                json_extract(intent.payload_json, '$.messageId')
              AND (
                json_type(failed.payload_json, '$.intentSequence') IS NULL
                OR json_extract(failed.payload_json, '$.intentSequence') = intent.sequence
              )
              AND EXISTS (
                SELECT 1
                FROM orchestration_events AS failed_event
                WHERE failed_event.aggregate_kind = 'thread'
                  AND failed_event.sequence > intent.sequence
                  AND failed_event.stream_id = failed.thread_id
                  AND failed_event.event_type = 'thread.activity-appended'
                  AND failed_event.actor_kind = 'server'
                  AND json_extract(failed_event.payload_json, '$.threadId') = failed.thread_id
                  AND json_extract(failed_event.payload_json, '$.activity.id') = failed.activity_id
                  AND json_extract(failed_event.payload_json, '$.activity.kind') = failed.kind
                  AND json_extract(failed_event.payload_json, '$.activity.turnId') IS
                    failed.turn_id
                  AND json_extract(failed_event.payload_json, '$.activity.payload.messageId') =
                    json_extract(failed.payload_json, '$.messageId')
                  AND json_extract(
                    failed_event.payload_json,
                    '$.activity.payload.intentSequence'
                  ) IS json_extract(failed.payload_json, '$.intentSequence')
                LIMIT 1
              )
            LIMIT 1
          )
          AND NOT EXISTS (
            SELECT 1
            FROM projection_thread_activities AS recovered
            WHERE recovered.thread_id = intent.stream_id
              AND recovered.kind = 'provider.turn.steer.recovered'
              AND json_extract(recovered.payload_json, '$.provider') = 'codex'
              AND json_extract(recovered.payload_json, '$.messageId') =
                json_extract(intent.payload_json, '$.messageId')
              AND json_extract(recovered.payload_json, '$.acceptedTurnId') IS NOT NULL
              AND json_extract(recovered.payload_json, '$.recoveredTurnId') = recovered.turn_id
              AND EXISTS (
                SELECT 1
                FROM orchestration_events AS recovered_event
                WHERE recovered_event.aggregate_kind = 'thread'
                  AND recovered_event.sequence > intent.sequence
                  AND recovered_event.stream_id = recovered.thread_id
                  AND recovered_event.event_type = 'thread.activity-appended'
                  AND recovered_event.actor_kind = 'server'
                  AND json_extract(recovered_event.payload_json, '$.threadId') =
                    recovered.thread_id
                  AND json_extract(recovered_event.payload_json, '$.activity.id') =
                    recovered.activity_id
                  AND json_extract(recovered_event.payload_json, '$.activity.kind') =
                    recovered.kind
                  AND json_extract(recovered_event.payload_json, '$.activity.turnId') IS
                    recovered.turn_id
                  AND json_extract(recovered_event.payload_json, '$.activity.payload.provider') =
                    'codex'
                  AND json_extract(recovered_event.payload_json, '$.activity.payload.messageId') =
                    json_extract(recovered.payload_json, '$.messageId')
                  AND json_extract(
                    recovered_event.payload_json,
                    '$.activity.payload.acceptedTurnId'
                  ) = json_extract(recovered.payload_json, '$.acceptedTurnId')
                  AND json_extract(
                    recovered_event.payload_json,
                    '$.activity.payload.recoveredTurnId'
                  ) = recovered.turn_id
                  AND json_extract(
                    recovered_event.payload_json,
                    '$.activity.payload.clientCorrelationId'
                  ) IS json_extract(recovered.payload_json, '$.clientCorrelationId')
                LIMIT 1
              )
            LIMIT 1
          )
          AND NOT EXISTS (
            SELECT 1
            FROM projection_thread_activities AS delivered
            WHERE delivered.thread_id = intent.stream_id
              AND delivered.kind = 'provider.turn.steer.delivered'
              AND json_extract(delivered.payload_json, '$.provider') = 'codex'
              AND json_extract(delivered.payload_json, '$.messageId') =
                json_extract(intent.payload_json, '$.messageId')
              AND json_extract(delivered.payload_json, '$.deliveredTurnId') = delivered.turn_id
              AND json_extract(delivered.payload_json, '$.delivery') = 'next-turn'
              AND json_extract(delivered.payload_json, '$.reason') IN (
                'turn-start-after-no-local-active-turn',
                'turn-start-after-missing-active-turn-id',
                'turn-start-after-provider-no-active-turn'
              )
              AND EXISTS (
                SELECT 1
                FROM orchestration_events AS delivered_event
                WHERE delivered_event.aggregate_kind = 'thread'
                  AND delivered_event.sequence > intent.sequence
                  AND delivered_event.stream_id = delivered.thread_id
                  AND delivered_event.event_type = 'thread.activity-appended'
                  AND delivered_event.actor_kind = 'server'
                  AND json_extract(delivered_event.payload_json, '$.threadId') =
                    delivered.thread_id
                  AND json_extract(delivered_event.payload_json, '$.activity.id') =
                    delivered.activity_id
                  AND json_extract(delivered_event.payload_json, '$.activity.kind') =
                    delivered.kind
                  AND json_extract(delivered_event.payload_json, '$.activity.turnId') IS
                    delivered.turn_id
                  AND json_extract(delivered_event.payload_json, '$.activity.payload.provider') =
                    'codex'
                  AND json_extract(delivered_event.payload_json, '$.activity.payload.messageId') =
                    json_extract(delivered.payload_json, '$.messageId')
                  AND json_extract(
                    delivered_event.payload_json,
                    '$.activity.payload.deliveredTurnId'
                  ) = delivered.turn_id
                  AND json_extract(delivered_event.payload_json, '$.activity.payload.delivery') =
                    'next-turn'
                  AND json_extract(delivered_event.payload_json, '$.activity.payload.reason') =
                    json_extract(delivered.payload_json, '$.reason')
                LIMIT 1
              )
            LIMIT 1
          )
          AND NOT EXISTS (
            SELECT 1
            FROM projection_thread_activities AS attempted
            WHERE attempted.thread_id = intent.stream_id
              AND attempted.kind = 'provider.turn.steer.delivery-attempted'
              AND json_extract(attempted.payload_json, '$.provider') = 'codex'
              AND json_extract(attempted.payload_json, '$.messageId') =
                json_extract(intent.payload_json, '$.messageId')
              AND json_type(attempted.payload_json, '$.intentSequence') = 'integer'
              AND json_extract(attempted.payload_json, '$.intentSequence') = intent.sequence
              AND json_extract(attempted.payload_json, '$.deliveryState') = 'attempted'
              AND (
                (
                  json_extract(attempted.payload_json, '$.delivery') = 'live-steer'
                  AND json_extract(attempted.payload_json, '$.reason') = 'live-steer'
                  AND json_extract(attempted.payload_json, '$.expectedTurnId') = attempted.turn_id
                )
                OR (
                  json_extract(attempted.payload_json, '$.delivery') = 'next-turn'
                  AND json_extract(attempted.payload_json, '$.reason') IN (
                    'turn-start-after-no-local-active-turn',
                    'turn-start-after-missing-active-turn-id',
                    'turn-start-after-provider-no-active-turn',
                    'turn-start-after-terminal-unprocessed-steer'
                  )
                  AND json_extract(attempted.payload_json, '$.staleTurnId') IS attempted.turn_id
                )
              )
              AND EXISTS (
                SELECT 1
                FROM orchestration_events AS attempted_event
                WHERE attempted_event.aggregate_kind = 'thread'
                  AND attempted_event.sequence > intent.sequence
                  AND attempted_event.stream_id = attempted.thread_id
                  AND attempted_event.event_type = 'thread.activity-appended'
                  AND attempted_event.actor_kind = 'server'
                  AND json_extract(attempted_event.payload_json, '$.threadId') =
                    attempted.thread_id
                  AND json_extract(attempted_event.payload_json, '$.activity.id') =
                    attempted.activity_id
                  AND json_extract(attempted_event.payload_json, '$.activity.kind') = attempted.kind
                  AND json_extract(attempted_event.payload_json, '$.activity.turnId') IS
                    attempted.turn_id
                  AND json_extract(attempted_event.payload_json, '$.activity.payload.provider') =
                    'codex'
                  AND json_extract(attempted_event.payload_json, '$.activity.payload.messageId') =
                    json_extract(attempted.payload_json, '$.messageId')
                  AND json_extract(
                    attempted_event.payload_json,
                    '$.activity.payload.intentSequence'
                  ) = intent.sequence
                  AND json_extract(
                    attempted_event.payload_json,
                    '$.activity.payload.intentSequence'
                  ) = json_extract(attempted.payload_json, '$.intentSequence')
                  AND json_extract(attempted_event.payload_json, '$.activity.payload.delivery') =
                    json_extract(attempted.payload_json, '$.delivery')
                  AND json_extract(
                    attempted_event.payload_json,
                    '$.activity.payload.deliveryState'
                  ) = 'attempted'
                  AND json_extract(attempted_event.payload_json, '$.activity.payload.reason') =
                    json_extract(attempted.payload_json, '$.reason')
                  AND json_extract(
                    attempted_event.payload_json,
                    '$.activity.payload.expectedTurnId'
                  ) IS json_extract(attempted.payload_json, '$.expectedTurnId')
                  AND json_extract(
                    attempted_event.payload_json,
                    '$.activity.payload.staleTurnId'
                  ) IS json_extract(attempted.payload_json, '$.staleTurnId')
                LIMIT 1
              )
            LIMIT 1
          )
          AND NOT EXISTS (
            SELECT 1
            FROM orchestration_events AS later_intent
            WHERE later_intent.sequence > intent.sequence
              AND later_intent.aggregate_kind = 'thread'
              AND later_intent.stream_id = intent.stream_id
              AND later_intent.event_type IN (
                'thread.turn-start-requested',
                'thread.turn-steer-requested'
              )
              AND later_intent.actor_kind IN ('client', 'server')
              AND json_extract(later_intent.payload_json, '$.threadId') = intent.stream_id
              AND json_extract(later_intent.payload_json, '$.messageId') =
                json_extract(intent.payload_json, '$.messageId')
            LIMIT 1
          )
        ORDER BY intent.sequence ASC
      `,
  });

  /**
   * Verify processing evidence only after TypeScript derives the one canonical
   * token for the persisted MessageId. SQLite does not provide Cafe's
   * domain-separated SHA-256 construction, so a prefix/shape comparison in the
   * discovery query would let a wrong-token activity suppress an undelivered
   * intent. Binding the independently derived token, exact task id, and raw
   * message identity here makes all three fields agree before replay settles.
   */
  const findExactCodexSteerProcessingEvidenceRow = SqlSchema.findOne({
    Request: CodexSteerProcessingEvidenceLookupInput,
    Result: CodexSteerProcessingEvidenceRowSchema,
    execute: ({ threadId, messageId, clientCorrelationId, taskId }) =>
      sql`
        SELECT EXISTS (
          SELECT 1
          FROM projection_thread_activities AS processing
          WHERE processing.thread_id = ${threadId}
            AND processing.kind = 'task.progress'
            AND json_type(processing.payload_json, '$.taskId') = 'text'
            AND json_extract(processing.payload_json, '$.taskId') = ${taskId}
            AND json_type(processing.payload_json, '$.usage.clientCorrelationId') = 'text'
            AND json_extract(processing.payload_json, '$.usage.clientCorrelationId') =
              ${clientCorrelationId}
            AND json_type(processing.payload_json, '$.usage.messageId') = 'text'
            AND json_extract(processing.payload_json, '$.usage.messageId') = ${messageId}
          LIMIT 1
        ) AS "processingObserved"
      `,
  });

  /**
   * Re-read only the event ledger immediately before replay I/O. Projection
   * state is intentionally not enough here: Stop and session-stop intents can
   * commit after the original steer while their provider side effects are
   * still pending. The CTE authenticates the complete immutable intent tuple,
   * and every barrier is limited to later client/server-authored events in the
   * same thread stream.
   */
  const findCodexSteerIntentRecoveryBarrierRow = SqlSchema.findOne({
    Request: CodexSteerIntentRecoveryBarrierLookupInput,
    Result: CodexSteerIntentRecoveryBarrierRowSchema,
    execute: ({ sequence, threadId, messageId, expectedTurnId }) =>
      sql`
        WITH exact_intent AS (
          SELECT 1
          FROM orchestration_events AS intent
          WHERE intent.sequence = ${sequence}
            AND intent.aggregate_kind = 'thread'
            AND intent.stream_id = ${threadId}
            AND intent.event_type = 'thread.turn-steer-requested'
            AND intent.actor_kind IN ('client', 'server')
            AND json_extract(intent.payload_json, '$.threadId') = ${threadId}
            AND json_extract(intent.payload_json, '$.messageId') = ${messageId}
            AND json_extract(intent.payload_json, '$.expectedTurnId') IS ${expectedTurnId}
          LIMIT 1
        )
        SELECT
          EXISTS (SELECT 1 FROM exact_intent) AS "intentVerified",
          EXISTS (
            SELECT 1
            FROM orchestration_events AS later_event
            WHERE EXISTS (SELECT 1 FROM exact_intent)
              AND later_event.sequence > ${sequence}
              AND later_event.aggregate_kind = 'thread'
              AND later_event.stream_id = ${threadId}
              AND later_event.event_type = 'thread.turn-start-requested'
              AND later_event.actor_kind IN ('client', 'server')
              AND json_extract(later_event.payload_json, '$.threadId') = ${threadId}
            LIMIT 1
          ) AS "newerTurnRequested",
          EXISTS (
            SELECT 1
            FROM orchestration_events AS later_event
            WHERE EXISTS (SELECT 1 FROM exact_intent)
              AND later_event.sequence > ${sequence}
              AND later_event.aggregate_kind = 'thread'
              AND later_event.stream_id = ${threadId}
              AND later_event.event_type = 'thread.turn-interrupt-requested'
              AND later_event.actor_kind IN ('client', 'server')
              AND json_extract(later_event.payload_json, '$.threadId') = ${threadId}
            LIMIT 1
          ) AS "interruptRequested",
          EXISTS (
            SELECT 1
            FROM orchestration_events AS later_event
            WHERE EXISTS (SELECT 1 FROM exact_intent)
              AND later_event.sequence > ${sequence}
              AND later_event.aggregate_kind = 'thread'
              AND later_event.stream_id = ${threadId}
              AND later_event.event_type = 'thread.session-stop-requested'
              AND later_event.actor_kind IN ('client', 'server')
              AND json_extract(later_event.payload_json, '$.threadId') = ${threadId}
            LIMIT 1
          ) AS "sessionStopRequested"
      `,
  });

  const listThreadMessageRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT *
        FROM (
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
          ORDER BY created_at DESC, message_id DESC
          LIMIT ${THREAD_DETAIL_MESSAGE_LIMIT}
        )
        ORDER BY "createdAt" ASC, "messageId" ASC
      `,
  });

  const listThreadProposedPlanRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadProposedPlanDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          plan_id AS "planId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          plan_markdown AS "planMarkdown",
          implemented_at AS "implementedAt",
          implementation_thread_id AS "implementationThreadId",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_proposed_plans
        WHERE thread_id = ${threadId}
        ORDER BY created_at ASC, plan_id ASC
      `,
  });

  const listThreadActivityRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadDetailActivityDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        WITH recent_activity_ids AS (
          SELECT activity_id
          FROM projection_thread_activities
          WHERE thread_id = ${threadId}
          ORDER BY
            CASE WHEN sequence IS NULL THEN 0 ELSE 1 END DESC,
            sequence DESC,
            created_at DESC,
            activity_id DESC
          LIMIT ${THREAD_DETAIL_ACTIVITY_LIMIT}
        ),
        latest_task_plan_activity_id AS (
          SELECT activity_id
          FROM projection_thread_activities
          WHERE thread_id = ${threadId}
            AND kind = 'turn.plan.updated'
          ORDER BY
            CASE WHEN sequence IS NULL THEN 0 ELSE 1 END DESC,
            sequence DESC,
            created_at DESC,
            activity_id DESC
          LIMIT 1
        ),
        current_turn_subagent_identities AS (
          -- Keep the most recently active identities plus one sentinel row so
          -- the caller can emit a metadata-only truncation diagnostic. The
          -- output cap is a hard defense against a compromised provider
          -- manufacturing unique ids to bypass the normal activity window.
          SELECT
            activities.turn_id,
            json_extract(activities.payload_json, '$.subagent.threadId') AS subagent_thread_id
          FROM projection_thread_activities AS activities
          WHERE activities.thread_id = ${threadId}
            AND activities.turn_id = (
              SELECT latest_turn_id
              FROM projection_threads
              WHERE thread_id = ${threadId}
              LIMIT 1
            )
            AND activities.kind IN ('task.started', 'task.progress', 'task.completed')
            AND json_type(activities.payload_json, '$.subagent.threadId') = 'text'
          GROUP BY
            activities.turn_id,
            json_extract(activities.payload_json, '$.subagent.threadId')
          ORDER BY
            MAX(CASE WHEN activities.sequence IS NULL THEN 0 ELSE 1 END) DESC,
            MAX(activities.sequence) DESC,
            MAX(activities.created_at) DESC,
            MAX(activities.activity_id) DESC
          LIMIT ${MAX_RUNTIME_SUBAGENT_IDENTITIES_PER_TURN + 1}
        ),
        retained_current_turn_subagent_identities AS (
          SELECT turn_id, subagent_thread_id
          FROM current_turn_subagent_identities
          LIMIT ${MAX_RUNTIME_SUBAGENT_IDENTITIES_PER_TURN}
        ),
        latest_subagent_lifecycle_activity_ids AS (
          -- The general activity window is intentionally bounded, but a quiet
          -- child can run for hours while unrelated tool activity continues.
          -- Retain the latest edge of each lifecycle kind for every subagent
          -- on the current turn. Three edges (start/progress/completed) are
          -- sufficient to reconstruct a restart-safe state machine, including
          -- rejecting a delayed progress replay after a terminal edge, without
          -- retaining the child's full activity history.
          SELECT activity_id
          FROM (
            SELECT
              activities.activity_id,
              ROW_NUMBER() OVER (
                PARTITION BY
                  activities.turn_id,
                  json_extract(activities.payload_json, '$.subagent.threadId'),
                  activities.kind
                ORDER BY
                  CASE WHEN activities.sequence IS NULL THEN 0 ELSE 1 END DESC,
                  activities.sequence DESC,
                  activities.created_at DESC,
                  activities.activity_id DESC
              ) AS lifecycle_rank
            FROM projection_thread_activities AS activities
            INNER JOIN retained_current_turn_subagent_identities AS identities
              ON identities.turn_id = activities.turn_id
              AND identities.subagent_thread_id =
                json_extract(activities.payload_json, '$.subagent.threadId')
            WHERE activities.thread_id = ${threadId}
              -- The identity CTE contains only the current turn, but SQLite
              -- cannot reliably push that fact through this JSON-expression
              -- join. Without the explicit predicate it can scan and parse
              -- every activity ever retained by a long-running thread. That
              -- synchronous scan can exceed the WebSocket heartbeat window,
              -- causing a reconnect that immediately repeats the same query.
              AND activities.turn_id = (
                SELECT latest_turn_id
                FROM projection_threads
                WHERE thread_id = ${threadId}
                LIMIT 1
              )
              AND activities.kind IN ('task.started', 'task.progress', 'task.completed')
              AND json_type(activities.payload_json, '$.subagent.threadId') = 'text'
          )
          WHERE lifecycle_rank = 1
        ),
        retained_activity_ids AS (
          SELECT activity_id
          FROM recent_activity_ids
          UNION
          SELECT activity_id
          FROM latest_task_plan_activity_id
          UNION
          SELECT activity_id
          FROM latest_subagent_lifecycle_activity_ids
        )
        SELECT
          activities.activity_id AS "activityId",
          activities.thread_id AS "threadId",
          activities.turn_id AS "turnId",
          activities.tone,
          activities.kind,
          activities.summary,
          activities.payload_json AS "payload",
          activities.sequence,
          activities.created_at AS "createdAt",
          CASE
            WHEN (
              SELECT COUNT(*)
              FROM current_turn_subagent_identities
            ) > ${MAX_RUNTIME_SUBAGENT_IDENTITIES_PER_TURN}
            THEN 1
            ELSE 0
          END AS "subagentRetentionTruncated"
        FROM projection_thread_activities activities
        INNER JOIN retained_activity_ids retained
          ON retained.activity_id = activities.activity_id
        ORDER BY
          CASE WHEN activities.sequence IS NULL THEN 0 ELSE 1 END ASC,
          activities.sequence ASC,
          activities.created_at ASC,
          activities.activity_id ASC
      `,
  });

  const countThreadActivityRowsByTurn = SqlSchema.findOne({
    Request: ThreadTurnActivityPageLookupInput,
    Result: CountRowSchema,
    execute: ({ threadId, turnId }) =>
      sql`
        SELECT COUNT(*) AS "count"
        FROM projection_thread_activities
        WHERE thread_id = ${threadId}
          AND turn_id = ${turnId}
          AND ${historicalWorkLogActivityPredicate}
      `,
  });

  const findThreadTurnWorkLogPresence = SqlSchema.findOne({
    Request: ThreadTurnLookupInput,
    Result: WorkLogPresenceRowSchema,
    execute: ({ threadId, turnId }) =>
      sql`
        SELECT EXISTS(
          SELECT 1
          FROM projection_thread_activities
          WHERE thread_id = ${threadId}
            AND turn_id = ${turnId}
            AND ${historicalWorkLogActivityPredicate}
          LIMIT 1
        ) AS "hasWorkLog"
      `,
  });

  const findThreadTurnSubagentActivityPresence = SqlSchema.findOne({
    Request: ThreadTurnSubagentLookupInput,
    Result: SubagentActivityPresenceRowSchema,
    execute: ({ threadId, turnId, subagentId, historyId }) =>
      sql`
        SELECT EXISTS(
          SELECT 1
          FROM projection_thread_activities
          WHERE thread_id = ${threadId}
            AND turn_id = ${turnId}
            AND kind IN ('task.started', 'task.progress', 'task.completed')
            AND json_type(payload_json, '$.subagent.threadId') = 'text'
            AND json_extract(payload_json, '$.subagent.threadId') = ${subagentId}
            AND (
              ${historyId ?? null} IS NULL
              OR (
                json_type(payload_json, '$.subagent.historyId') = 'text'
                AND json_extract(payload_json, '$.subagent.historyId') = ${historyId ?? null}
              )
            )
          LIMIT 1
        ) AS "hasSubagentActivity"
      `,
  });

  const listThreadActivityRowsByTurnPage = SqlSchema.findAll({
    Request: ThreadTurnActivityPageLookupInput,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: ({ threadId, turnId, offset, limit }) =>
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
          AND turn_id = ${turnId}
          AND ${historicalWorkLogActivityPredicate}
        ORDER BY
          CASE WHEN sequence IS NULL THEN 0 ELSE 1 END ASC,
          sequence ASC,
          created_at ASC,
          activity_id ASC
        LIMIT ${limit}
        OFFSET ${offset}
      `,
  });

  const getThreadSessionRowByThread = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadSessionDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          status,
          provider_name AS "providerName",
          provider_instance_id AS "providerInstanceId",
          runtime_mode AS "runtimeMode",
          active_turn_id AS "activeTurnId",
          last_error AS "lastError",
          updated_at AS "updatedAt"
        FROM projection_thread_sessions
        WHERE thread_id = ${threadId}
        LIMIT 1
      `,
  });

  const getThreadGoalRowByThread = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadGoalDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          objective,
          status,
          token_budget AS "tokenBudget",
          tokens_used AS "tokensUsed",
          time_used_seconds AS "timeUsedSeconds",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_goals
        WHERE thread_id = ${threadId}
        LIMIT 1
      `,
  });

  const getLatestTurnRowByThread = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: ProjectionLatestTurnDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          turns.thread_id AS "threadId",
          turns.turn_id AS "turnId",
          turns.state,
          turns.requested_at AS "requestedAt",
          turns.started_at AS "startedAt",
          turns.completed_at AS "completedAt",
          turns.assistant_message_id AS "assistantMessageId",
          turns.source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          turns.source_proposed_plan_id AS "sourceProposedPlanId"
        FROM projection_threads threads
        JOIN projection_turns turns
          ON turns.thread_id = threads.thread_id
          AND turns.turn_id = threads.latest_turn_id
        WHERE threads.thread_id = ${threadId}
          AND threads.deleted_at IS NULL
          AND threads.archived_at IS NULL
        LIMIT 1
      `,
  });

  const listCheckpointRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionCheckpointDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          turn_id AS "turnId",
          checkpoint_turn_count AS "checkpointTurnCount",
          checkpoint_ref AS "checkpointRef",
          checkpoint_status AS "status",
          checkpoint_files_json AS "files",
          assistant_message_id AS "assistantMessageId",
          COALESCE(checkpoint_completed_at, completed_at) AS "completedAt"
        FROM projection_turns
        WHERE thread_id = ${threadId}
          AND checkpoint_turn_count IS NOT NULL
          AND checkpoint_ref IS NOT NULL
          AND checkpoint_status IS NOT NULL
          AND checkpoint_files_json IS NOT NULL
          AND COALESCE(checkpoint_completed_at, completed_at) IS NOT NULL
        ORDER BY checkpoint_turn_count ASC
      `,
  });

  const getSnapshot: ProjectionSnapshotQueryShape["getSnapshot"] = () =>
    sql
      .withTransaction(
        Effect.all([
          listProjectRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listProjects:query",
                "ProjectionSnapshotQuery.getSnapshot:listProjects:decodeRows",
              ),
            ),
          ),
          listThreadRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listThreads:query",
                "ProjectionSnapshotQuery.getSnapshot:listThreads:decodeRows",
              ),
            ),
          ),
          listThreadMessageRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listThreadMessages:query",
                "ProjectionSnapshotQuery.getSnapshot:listThreadMessages:decodeRows",
              ),
            ),
          ),
          listThreadProposedPlanRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listThreadProposedPlans:query",
                "ProjectionSnapshotQuery.getSnapshot:listThreadProposedPlans:decodeRows",
              ),
            ),
          ),
          listThreadActivityRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listThreadActivities:query",
                "ProjectionSnapshotQuery.getSnapshot:listThreadActivities:decodeRows",
              ),
            ),
          ),
          listThreadSessionRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listThreadSessions:query",
                "ProjectionSnapshotQuery.getSnapshot:listThreadSessions:decodeRows",
              ),
            ),
          ),
          listThreadGoalRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listThreadGoals:query",
                "ProjectionSnapshotQuery.getSnapshot:listThreadGoals:decodeRows",
              ),
            ),
          ),
          listCheckpointRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listCheckpoints:query",
                "ProjectionSnapshotQuery.getSnapshot:listCheckpoints:decodeRows",
              ),
            ),
          ),
          listLatestTurnRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listLatestTurns:query",
                "ProjectionSnapshotQuery.getSnapshot:listLatestTurns:decodeRows",
              ),
            ),
          ),
          listProjectionStateRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getSnapshot:listProjectionState:query",
                "ProjectionSnapshotQuery.getSnapshot:listProjectionState:decodeRows",
              ),
            ),
          ),
        ]),
      )
      .pipe(
        Effect.flatMap(
          ([
            projectRows,
            threadRows,
            messageRows,
            proposedPlanRows,
            activityRows,
            sessionRows,
            goalRows,
            checkpointRows,
            latestTurnRows,
            stateRows,
          ]) =>
            Effect.gen(function* () {
              const messagesByThread = new Map<string, Array<OrchestrationMessage>>();
              const proposedPlansByThread = new Map<string, Array<OrchestrationProposedPlan>>();
              const activitiesByThread = new Map<string, Array<OrchestrationThreadActivity>>();
              const checkpointsByThread = new Map<string, Array<OrchestrationCheckpointSummary>>();
              const sessionsByThread = new Map<string, OrchestrationSession>();
              const goalsByThread = new Map<string, ProviderThreadGoal>();
              const latestTurnByThread = new Map<string, OrchestrationLatestTurn>();

              let updatedAt: string | null = null;

              for (const row of projectRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (const row of threadRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (const row of stateRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }

              for (const row of messageRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }

              for (const row of dedupeCodexSnapshotAssistantMessages(messageRows)) {
                const threadMessages = messagesByThread.get(row.threadId) ?? [];
                threadMessages.push({
                  id: row.messageId,
                  role: row.role,
                  text: row.text,
                  ...(row.attachments !== null ? { attachments: row.attachments } : {}),
                  turnId: row.turnId,
                  streaming: row.isStreaming === 1,
                  createdAt: row.createdAt,
                  updatedAt: row.updatedAt,
                });
                messagesByThread.set(row.threadId, threadMessages);
              }

              for (const row of proposedPlanRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
                const threadProposedPlans = proposedPlansByThread.get(row.threadId) ?? [];
                threadProposedPlans.push({
                  id: row.planId,
                  turnId: row.turnId,
                  planMarkdown: row.planMarkdown,
                  implementedAt: row.implementedAt,
                  implementationThreadId: row.implementationThreadId,
                  createdAt: row.createdAt,
                  updatedAt: row.updatedAt,
                });
                proposedPlansByThread.set(row.threadId, threadProposedPlans);
              }

              for (const row of activityRows) {
                updatedAt = maxIso(updatedAt, row.createdAt);
                const threadActivities = activitiesByThread.get(row.threadId) ?? [];
                threadActivities.push({
                  id: row.activityId,
                  tone: row.tone,
                  kind: row.kind,
                  summary: row.summary,
                  payload: row.payload,
                  turnId: row.turnId,
                  ...(row.sequence !== null ? { sequence: row.sequence } : {}),
                  createdAt: row.createdAt,
                });
                activitiesByThread.set(row.threadId, threadActivities);
              }

              for (const row of checkpointRows) {
                updatedAt = maxIso(updatedAt, row.completedAt);
                const threadCheckpoints = checkpointsByThread.get(row.threadId) ?? [];
                threadCheckpoints.push({
                  turnId: row.turnId,
                  checkpointTurnCount: row.checkpointTurnCount,
                  checkpointRef: row.checkpointRef,
                  status: row.status,
                  files: row.files,
                  assistantMessageId: row.assistantMessageId,
                  completedAt: row.completedAt,
                });
                checkpointsByThread.set(row.threadId, threadCheckpoints);
              }

              for (const row of latestTurnRows) {
                updatedAt = maxIso(updatedAt, row.requestedAt);
                if (row.startedAt !== null) {
                  updatedAt = maxIso(updatedAt, row.startedAt);
                }
                if (row.completedAt !== null) {
                  updatedAt = maxIso(updatedAt, row.completedAt);
                }
                if (latestTurnByThread.has(row.threadId)) {
                  continue;
                }
                latestTurnByThread.set(row.threadId, {
                  turnId: row.turnId,
                  state:
                    row.state === "error"
                      ? "error"
                      : row.state === "interrupted"
                        ? "interrupted"
                        : row.state === "completed"
                          ? "completed"
                          : "running",
                  requestedAt: row.requestedAt,
                  startedAt: row.startedAt,
                  completedAt: row.completedAt,
                  assistantMessageId: row.assistantMessageId,
                  ...(row.sourceProposedPlanThreadId !== null && row.sourceProposedPlanId !== null
                    ? {
                        sourceProposedPlan: {
                          threadId: row.sourceProposedPlanThreadId,
                          planId: row.sourceProposedPlanId,
                        },
                      }
                    : {}),
                });
              }

              for (const row of sessionRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
                sessionsByThread.set(
                  row.threadId,
                  mapSessionRowForThread(row, latestTurnByThread.get(row.threadId) ?? null),
                );
              }
              for (const row of goalRows) {
                updatedAt = maxIso(updatedAt, row.updatedAt);
                goalsByThread.set(row.threadId, row);
              }

              const repositoryIdentities = yield* resolveRepositoryIdentitiesForProjects(
                projectRows,
                { includeDeleted: true },
              );

              const projects: ReadonlyArray<OrchestrationProject> = projectRows.map((row) => ({
                id: row.projectId,
                title: row.title,
                workspaceRoot: row.workspaceRoot,
                additionalWorkspaceRoots: row.additionalWorkspaceRoots,
                repositoryIdentity: repositoryIdentities.get(row.projectId) ?? null,
                defaultModelSelection: row.defaultModelSelection,
                scripts: row.scripts,
                createdAt: row.createdAt,
                updatedAt: row.updatedAt,
                deletedAt: row.deletedAt,
              }));

              const threads: ReadonlyArray<OrchestrationThread> = threadRows.map((row) => ({
                id: row.threadId,
                projectId: row.projectId,
                title: row.title,
                modelSelection: row.modelSelection,
                runtimeMode: row.runtimeMode,
                interactionMode: row.interactionMode,
                branch: row.branch,
                worktreePath: row.worktreePath,
                latestTurn: latestTurnByThread.get(row.threadId) ?? null,
                createdAt: row.createdAt,
                updatedAt: row.updatedAt,
                archivedAt: row.archivedAt,
                deletedAt: row.deletedAt,
                messages: messagesByThread.get(row.threadId) ?? [],
                proposedPlans: proposedPlansByThread.get(row.threadId) ?? [],
                activities: activitiesByThread.get(row.threadId) ?? [],
                checkpoints: checkpointsByThread.get(row.threadId) ?? [],
                session: sessionsByThread.get(row.threadId) ?? null,
                goal: goalsByThread.get(row.threadId) ?? null,
              }));

              const snapshot = {
                snapshotSequence: computeSnapshotSequence(stateRows),
                projects,
                threads,
                updatedAt: updatedAt ?? "1970-01-01T00:00:00.000Z",
              };

              return yield* decodeReadModel(snapshot).pipe(
                Effect.mapError(
                  toPersistenceDecodeError("ProjectionSnapshotQuery.getSnapshot:decodeReadModel"),
                ),
              );
            }),
        ),
        Effect.mapError((error) => {
          if (isPersistenceError(error)) {
            return error;
          }
          return toPersistenceSqlError("ProjectionSnapshotQuery.getSnapshot:query")(error);
        }),
      );

  const getCommandReadModel: ProjectionSnapshotQueryShape["getCommandReadModel"] = () =>
    sql
      .withTransaction(
        Effect.all([
          listProjectRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getCommandReadModel:listProjects:query",
                "ProjectionSnapshotQuery.getCommandReadModel:listProjects:decodeRows",
              ),
            ),
          ),
          listThreadRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getCommandReadModel:listThreads:query",
                "ProjectionSnapshotQuery.getCommandReadModel:listThreads:decodeRows",
              ),
            ),
          ),
          listThreadProposedPlanRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getCommandReadModel:listThreadProposedPlans:query",
                "ProjectionSnapshotQuery.getCommandReadModel:listThreadProposedPlans:decodeRows",
              ),
            ),
          ),
          listThreadSessionRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getCommandReadModel:listThreadSessions:query",
                "ProjectionSnapshotQuery.getCommandReadModel:listThreadSessions:decodeRows",
              ),
            ),
          ),
          listThreadGoalRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getCommandReadModel:listThreadGoals:query",
                "ProjectionSnapshotQuery.getCommandReadModel:listThreadGoals:decodeRows",
              ),
            ),
          ),
          listLatestTurnRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getCommandReadModel:listLatestTurns:query",
                "ProjectionSnapshotQuery.getCommandReadModel:listLatestTurns:decodeRows",
              ),
            ),
          ),
          listProjectionStateRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getCommandReadModel:listProjectionState:query",
                "ProjectionSnapshotQuery.getCommandReadModel:listProjectionState:decodeRows",
              ),
            ),
          ),
        ]),
      )
      .pipe(
        Effect.flatMap(
          ([
            projectRows,
            threadRows,
            proposedPlanRows,
            sessionRows,
            goalRows,
            latestTurnRows,
            stateRows,
          ]) =>
            Effect.sync(() => {
              let updatedAt: string | null = null;
              const projects: OrchestrationProject[] = [];
              const threads: OrchestrationThread[] = [];

              for (let index = 0; index < projectRows.length; index += 1) {
                const row = projectRows[index];
                if (!row) {
                  continue;
                }
                updatedAt = maxIso(updatedAt, row.updatedAt);
                projects.push({
                  id: row.projectId,
                  title: row.title,
                  workspaceRoot: row.workspaceRoot,
                  additionalWorkspaceRoots: row.additionalWorkspaceRoots,
                  defaultModelSelection: row.defaultModelSelection,
                  scripts: row.scripts,
                  createdAt: row.createdAt,
                  updatedAt: row.updatedAt,
                  deletedAt: row.deletedAt,
                });
              }
              for (let index = 0; index < threadRows.length; index += 1) {
                const row = threadRows[index];
                if (!row) {
                  continue;
                }
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (let index = 0; index < proposedPlanRows.length; index += 1) {
                const row = proposedPlanRows[index];
                if (!row) {
                  continue;
                }
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (let index = 0; index < sessionRows.length; index += 1) {
                const row = sessionRows[index];
                if (!row) {
                  continue;
                }
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }
              for (let index = 0; index < latestTurnRows.length; index += 1) {
                const row = latestTurnRows[index];
                if (!row) {
                  continue;
                }
                updatedAt = maxIso(updatedAt, row.requestedAt);
                if (row.startedAt !== null) {
                  updatedAt = maxIso(updatedAt, row.startedAt);
                }
                if (row.completedAt !== null) {
                  updatedAt = maxIso(updatedAt, row.completedAt);
                }
              }
              for (let index = 0; index < stateRows.length; index += 1) {
                const row = stateRows[index];
                if (!row) {
                  continue;
                }
                updatedAt = maxIso(updatedAt, row.updatedAt);
              }

              const latestTurnByThread = new Map<string, OrchestrationLatestTurn>();
              for (let index = 0; index < latestTurnRows.length; index += 1) {
                const row = latestTurnRows[index];
                if (!row) {
                  continue;
                }
                latestTurnByThread.set(row.threadId, mapLatestTurn(row));
              }
              const proposedPlansByThread = new Map<string, Array<OrchestrationProposedPlan>>();
              const sessionByThread = new Map<string, OrchestrationSession>();
              const goalByThread = new Map<string, ProviderThreadGoal>();

              for (let index = 0; index < sessionRows.length; index += 1) {
                const row = sessionRows[index];
                if (!row) {
                  continue;
                }
                sessionByThread.set(
                  row.threadId,
                  mapSessionRowForThread(row, latestTurnByThread.get(row.threadId) ?? null),
                );
              }
              for (let index = 0; index < goalRows.length; index += 1) {
                const row = goalRows[index];
                if (!row) {
                  continue;
                }
                updatedAt = maxIso(updatedAt, row.updatedAt);
                goalByThread.set(row.threadId, row);
              }

              for (let index = 0; index < proposedPlanRows.length; index += 1) {
                const row = proposedPlanRows[index];
                if (!row) {
                  continue;
                }
                const threadProposedPlans = proposedPlansByThread.get(row.threadId) ?? [];
                threadProposedPlans.push(mapProposedPlanRow(row));
                proposedPlansByThread.set(row.threadId, threadProposedPlans);
              }

              for (let index = 0; index < threadRows.length; index += 1) {
                const row = threadRows[index];
                if (!row) {
                  continue;
                }
                threads.push({
                  id: row.threadId,
                  projectId: row.projectId,
                  title: row.title,
                  modelSelection: row.modelSelection,
                  runtimeMode: row.runtimeMode,
                  interactionMode: row.interactionMode,
                  branch: row.branch,
                  worktreePath: row.worktreePath,
                  latestTurn: latestTurnByThread.get(row.threadId) ?? null,
                  createdAt: row.createdAt,
                  updatedAt: row.updatedAt,
                  archivedAt: row.archivedAt,
                  deletedAt: row.deletedAt,
                  messages: [],
                  proposedPlans: proposedPlansByThread.get(row.threadId) ?? [],
                  activities: [],
                  checkpoints: [],
                  session: sessionByThread.get(row.threadId) ?? null,
                  goal: goalByThread.get(row.threadId) ?? null,
                });
              }

              return {
                snapshotSequence: computeSnapshotSequence(stateRows),
                projects,
                threads,
                updatedAt: updatedAt ?? "1970-01-01T00:00:00.000Z",
              } satisfies OrchestrationReadModel;
            }),
        ),
        Effect.mapError((error) => {
          if (isPersistenceError(error)) {
            return error;
          }
          return toPersistenceSqlError("ProjectionSnapshotQuery.getCommandReadModel:query")(error);
        }),
      );

  const getShellSnapshot: ProjectionSnapshotQueryShape["getShellSnapshot"] = () =>
    sql
      .withTransaction(
        Effect.all([
          listProjectRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getShellSnapshot:listProjects:query",
                "ProjectionSnapshotQuery.getShellSnapshot:listProjects:decodeRows",
              ),
            ),
          ),
          listActiveThreadRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getShellSnapshot:listThreads:query",
                "ProjectionSnapshotQuery.getShellSnapshot:listThreads:decodeRows",
              ),
            ),
          ),
          listActiveThreadSessionRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getShellSnapshot:listThreadSessions:query",
                "ProjectionSnapshotQuery.getShellSnapshot:listThreadSessions:decodeRows",
              ),
            ),
          ),
          listActiveLatestTurnRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getShellSnapshot:listLatestTurns:query",
                "ProjectionSnapshotQuery.getShellSnapshot:listLatestTurns:decodeRows",
              ),
            ),
          ),
          listProjectionStateRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getShellSnapshot:listProjectionState:query",
                "ProjectionSnapshotQuery.getShellSnapshot:listProjectionState:decodeRows",
              ),
            ),
          ),
        ]),
      )
      .pipe(
        Effect.flatMap(([projectRows, threadRows, sessionRows, latestTurnRows, stateRows]) =>
          Effect.gen(function* () {
            let updatedAt: string | null = null;
            for (const row of projectRows) {
              updatedAt = maxIso(updatedAt, row.updatedAt);
            }
            for (const row of threadRows) {
              updatedAt = maxIso(updatedAt, row.updatedAt);
            }
            for (const row of sessionRows) {
              updatedAt = maxIso(updatedAt, row.updatedAt);
            }
            for (const row of latestTurnRows) {
              updatedAt = maxIso(updatedAt, row.requestedAt);
              if (row.startedAt !== null) {
                updatedAt = maxIso(updatedAt, row.startedAt);
              }
              if (row.completedAt !== null) {
                updatedAt = maxIso(updatedAt, row.completedAt);
              }
            }
            for (const row of stateRows) {
              updatedAt = maxIso(updatedAt, row.updatedAt);
            }

            const repositoryIdentities = yield* resolveRepositoryIdentitiesForProjects(projectRows);
            const latestTurnByThread = new Map(
              latestTurnRows.map((row) => [row.threadId, mapLatestTurn(row)] as const),
            );
            const sessionByThread = new Map(
              sessionRows.map(
                (row) =>
                  [
                    row.threadId,
                    mapSessionRowForThread(row, latestTurnByThread.get(row.threadId) ?? null),
                  ] as const,
              ),
            );

            const snapshot = {
              snapshotSequence: computeSnapshotSequence(stateRows),
              projects: projectRows
                .filter((row) => row.deletedAt === null)
                .map((row) =>
                  mapProjectShellRow(row, repositoryIdentities.get(row.projectId) ?? null),
                ),
              threads: threadRows
                .filter((row) => row.deletedAt === null)
                .map(
                  (row): OrchestrationThreadShell => ({
                    id: row.threadId,
                    projectId: row.projectId,
                    title: row.title,
                    modelSelection: row.modelSelection,
                    runtimeMode: row.runtimeMode,
                    interactionMode: row.interactionMode,
                    branch: row.branch,
                    worktreePath: row.worktreePath,
                    latestTurn: latestTurnByThread.get(row.threadId) ?? null,
                    createdAt: row.createdAt,
                    updatedAt: row.updatedAt,
                    archivedAt: row.archivedAt,
                    deletedAt: row.deletedAt,
                    session: sessionByThread.get(row.threadId) ?? null,
                    latestUserMessageAt: row.latestUserMessageAt,
                    hasPendingApprovals: row.pendingApprovalCount > 0,
                    hasPendingUserInput: row.pendingUserInputCount > 0,
                    hasActionableProposedPlan: row.hasActionableProposedPlan > 0,
                  }),
                ),
              updatedAt: updatedAt ?? "1970-01-01T00:00:00.000Z",
            };

            return yield* decodeShellSnapshot(snapshot).pipe(
              Effect.mapError(
                toPersistenceDecodeError(
                  "ProjectionSnapshotQuery.getShellSnapshot:decodeShellSnapshot",
                ),
              ),
            );
          }),
        ),
        Effect.mapError((error) => {
          if (isPersistenceError(error)) {
            return error;
          }
          return toPersistenceSqlError("ProjectionSnapshotQuery.getShellSnapshot:query")(error);
        }),
      );

  const getArchivedShellSnapshot: ProjectionSnapshotQueryShape["getArchivedShellSnapshot"] = () =>
    sql
      .withTransaction(
        Effect.all([
          listProjectRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listProjects:query",
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listProjects:decodeRows",
              ),
            ),
          ),
          listArchivedThreadRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listThreads:query",
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listThreads:decodeRows",
              ),
            ),
          ),
          listArchivedThreadSessionRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listThreadSessions:query",
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listThreadSessions:decodeRows",
              ),
            ),
          ),
          listArchivedLatestTurnRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listLatestTurns:query",
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listLatestTurns:decodeRows",
              ),
            ),
          ),
          listProjectionStateRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listProjectionState:query",
                "ProjectionSnapshotQuery.getArchivedShellSnapshot:listProjectionState:decodeRows",
              ),
            ),
          ),
        ]),
      )
      .pipe(
        Effect.flatMap(([projectRows, threadRows, sessionRows, latestTurnRows, stateRows]) =>
          Effect.gen(function* () {
            let updatedAt: string | null = null;
            for (const row of projectRows) {
              updatedAt = maxIso(updatedAt, row.updatedAt);
            }
            for (const row of threadRows) {
              updatedAt = maxIso(updatedAt, row.updatedAt);
            }
            for (const row of sessionRows) {
              updatedAt = maxIso(updatedAt, row.updatedAt);
            }
            for (const row of latestTurnRows) {
              updatedAt = maxIso(updatedAt, row.requestedAt);
              if (row.startedAt !== null) {
                updatedAt = maxIso(updatedAt, row.startedAt);
              }
              if (row.completedAt !== null) {
                updatedAt = maxIso(updatedAt, row.completedAt);
              }
            }
            for (const row of stateRows) {
              updatedAt = maxIso(updatedAt, row.updatedAt);
            }

            const activeProjectIds = new Set(threadRows.map((row) => row.projectId));
            const repositoryIdentities = yield* resolveRepositoryIdentitiesForProjects(
              projectRows.filter((row) => activeProjectIds.has(row.projectId)),
            );
            const latestTurnByThread = new Map(
              latestTurnRows.map((row) => [row.threadId, mapLatestTurn(row)] as const),
            );
            const sessionByThread = new Map(
              sessionRows.map(
                (row) =>
                  [
                    row.threadId,
                    mapSessionRowForThread(row, latestTurnByThread.get(row.threadId) ?? null),
                  ] as const,
              ),
            );

            const snapshot = {
              snapshotSequence: computeSnapshotSequence(stateRows),
              projects: projectRows
                .filter((row) => row.deletedAt === null && activeProjectIds.has(row.projectId))
                .map((row) =>
                  mapProjectShellRow(row, repositoryIdentities.get(row.projectId) ?? null),
                ),
              threads: threadRows.map(
                (row): OrchestrationThreadShell => ({
                  id: row.threadId,
                  projectId: row.projectId,
                  title: row.title,
                  modelSelection: row.modelSelection,
                  runtimeMode: row.runtimeMode,
                  interactionMode: row.interactionMode,
                  branch: row.branch,
                  worktreePath: row.worktreePath,
                  latestTurn: latestTurnByThread.get(row.threadId) ?? null,
                  createdAt: row.createdAt,
                  updatedAt: row.updatedAt,
                  archivedAt: row.archivedAt,
                  deletedAt: row.deletedAt,
                  session: sessionByThread.get(row.threadId) ?? null,
                  latestUserMessageAt: row.latestUserMessageAt,
                  hasPendingApprovals: row.pendingApprovalCount > 0,
                  hasPendingUserInput: row.pendingUserInputCount > 0,
                  hasActionableProposedPlan: row.hasActionableProposedPlan > 0,
                }),
              ),
              updatedAt: updatedAt ?? "1970-01-01T00:00:00.000Z",
            };

            return yield* decodeShellSnapshot(snapshot).pipe(
              Effect.mapError(
                toPersistenceDecodeError(
                  "ProjectionSnapshotQuery.getArchivedShellSnapshot:decodeShellSnapshot",
                ),
              ),
            );
          }),
        ),
        Effect.mapError((error) => {
          if (isPersistenceError(error)) {
            return error;
          }
          return toPersistenceSqlError("ProjectionSnapshotQuery.getArchivedShellSnapshot:query")(
            error,
          );
        }),
      );

  const getDeletedShellSnapshot: ProjectionSnapshotQueryShape["getDeletedShellSnapshot"] = () =>
    sql
      .withTransaction(
        Effect.all([
          listProjectRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getDeletedShellSnapshot:listProjects:query",
                "ProjectionSnapshotQuery.getDeletedShellSnapshot:listProjects:decodeRows",
              ),
            ),
          ),
          listDeletedThreadRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getDeletedShellSnapshot:listThreads:query",
                "ProjectionSnapshotQuery.getDeletedShellSnapshot:listThreads:decodeRows",
              ),
            ),
          ),
          listDeletedThreadSessionRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getDeletedShellSnapshot:listThreadSessions:query",
                "ProjectionSnapshotQuery.getDeletedShellSnapshot:listThreadSessions:decodeRows",
              ),
            ),
          ),
          listDeletedLatestTurnRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getDeletedShellSnapshot:listLatestTurns:query",
                "ProjectionSnapshotQuery.getDeletedShellSnapshot:listLatestTurns:decodeRows",
              ),
            ),
          ),
          listProjectionStateRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getDeletedShellSnapshot:listProjectionState:query",
                "ProjectionSnapshotQuery.getDeletedShellSnapshot:listProjectionState:decodeRows",
              ),
            ),
          ),
        ]),
      )
      .pipe(
        Effect.flatMap(([projectRows, threadRows, sessionRows, latestTurnRows, stateRows]) =>
          Effect.gen(function* () {
            let updatedAt: string | null = null;
            for (const row of projectRows) {
              updatedAt = maxIso(updatedAt, row.updatedAt);
            }
            for (const row of threadRows) {
              updatedAt = maxIso(updatedAt, row.updatedAt);
              if (row.deletedAt !== null) {
                updatedAt = maxIso(updatedAt, row.deletedAt);
              }
            }
            for (const row of sessionRows) {
              updatedAt = maxIso(updatedAt, row.updatedAt);
            }
            for (const row of latestTurnRows) {
              updatedAt = maxIso(updatedAt, row.requestedAt);
              if (row.startedAt !== null) {
                updatedAt = maxIso(updatedAt, row.startedAt);
              }
              if (row.completedAt !== null) {
                updatedAt = maxIso(updatedAt, row.completedAt);
              }
            }
            for (const row of stateRows) {
              updatedAt = maxIso(updatedAt, row.updatedAt);
            }

            const activeProjectIds = new Set(threadRows.map((row) => row.projectId));
            const repositoryIdentities = yield* resolveRepositoryIdentitiesForProjects(
              projectRows.filter((row) => activeProjectIds.has(row.projectId)),
              { includeDeleted: true },
            );
            const latestTurnByThread = new Map(
              latestTurnRows.map((row) => [row.threadId, mapLatestTurn(row)] as const),
            );
            const sessionByThread = new Map(
              sessionRows.map(
                (row) =>
                  [
                    row.threadId,
                    mapSessionRowForThread(row, latestTurnByThread.get(row.threadId) ?? null),
                  ] as const,
              ),
            );

            const snapshot = {
              snapshotSequence: computeSnapshotSequence(stateRows),
              projects: projectRows
                .filter((row) => activeProjectIds.has(row.projectId))
                .map((row) =>
                  mapProjectShellRow(row, repositoryIdentities.get(row.projectId) ?? null),
                ),
              threads: threadRows.map(
                (row): OrchestrationThreadShell => ({
                  id: row.threadId,
                  projectId: row.projectId,
                  title: row.title,
                  modelSelection: row.modelSelection,
                  runtimeMode: row.runtimeMode,
                  interactionMode: row.interactionMode,
                  branch: row.branch,
                  worktreePath: row.worktreePath,
                  latestTurn: latestTurnByThread.get(row.threadId) ?? null,
                  createdAt: row.createdAt,
                  updatedAt: row.updatedAt,
                  archivedAt: row.archivedAt,
                  deletedAt: row.deletedAt,
                  session: sessionByThread.get(row.threadId) ?? null,
                  latestUserMessageAt: row.latestUserMessageAt,
                  hasPendingApprovals: row.pendingApprovalCount > 0,
                  hasPendingUserInput: row.pendingUserInputCount > 0,
                  hasActionableProposedPlan: row.hasActionableProposedPlan > 0,
                }),
              ),
              updatedAt: updatedAt ?? "1970-01-01T00:00:00.000Z",
            };

            return yield* decodeShellSnapshot(snapshot).pipe(
              Effect.mapError(
                toPersistenceDecodeError(
                  "ProjectionSnapshotQuery.getDeletedShellSnapshot:decodeShellSnapshot",
                ),
              ),
            );
          }),
        ),
        Effect.mapError((error) => {
          if (isPersistenceError(error)) {
            return error;
          }
          return toPersistenceSqlError("ProjectionSnapshotQuery.getDeletedShellSnapshot:query")(
            error,
          );
        }),
      );

  const getSnapshotSequence: ProjectionSnapshotQueryShape["getSnapshotSequence"] = () =>
    listProjectionStateRows(undefined).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.getSnapshotSequence:query",
          "ProjectionSnapshotQuery.getSnapshotSequence:decodeRows",
        ),
      ),
      Effect.map((stateRows) => ({
        snapshotSequence: computeSnapshotSequence(stateRows),
      })),
    );

  const getCounts: ProjectionSnapshotQueryShape["getCounts"] = () =>
    readProjectionCounts(undefined).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.getCounts:query",
          "ProjectionSnapshotQuery.getCounts:decodeRow",
        ),
      ),
      Effect.map(
        (row): ProjectionSnapshotCounts => ({
          projectCount: row.projectCount,
          threadCount: row.threadCount,
        }),
      ),
    );

  const getActiveProjectByWorkspaceRoot: ProjectionSnapshotQueryShape["getActiveProjectByWorkspaceRoot"] =
    (workspaceRoot) =>
      getActiveProjectRowByWorkspaceRoot({ workspaceRoot }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getActiveProjectByWorkspaceRoot:query",
            "ProjectionSnapshotQuery.getActiveProjectByWorkspaceRoot:decodeRow",
          ),
        ),
        Effect.flatMap((option) =>
          Option.isNone(option)
            ? Effect.succeed(Option.none<OrchestrationProject>())
            : repositoryIdentityResolver.resolve(option.value.workspaceRoot).pipe(
                Effect.map((repositoryIdentity) =>
                  Option.some({
                    id: option.value.projectId,
                    title: option.value.title,
                    workspaceRoot: option.value.workspaceRoot,
                    repositoryIdentity,
                    defaultModelSelection: option.value.defaultModelSelection,
                    scripts: option.value.scripts,
                    createdAt: option.value.createdAt,
                    updatedAt: option.value.updatedAt,
                    deletedAt: option.value.deletedAt,
                  } satisfies OrchestrationProject),
                ),
              ),
        ),
      );

  const getProjectShellById: ProjectionSnapshotQueryShape["getProjectShellById"] = (projectId) =>
    getActiveProjectRowById({ projectId }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionSnapshotQuery.getProjectShellById:query",
          "ProjectionSnapshotQuery.getProjectShellById:decodeRow",
        ),
      ),
      Effect.flatMap((option) =>
        Option.isNone(option)
          ? Effect.succeed(Option.none<OrchestrationProjectShell>())
          : repositoryIdentityResolver
              .resolve(option.value.workspaceRoot)
              .pipe(
                Effect.map((repositoryIdentity) =>
                  Option.some(mapProjectShellRow(option.value, repositoryIdentity)),
                ),
              ),
      ),
    );

  const getFirstActiveThreadIdByProjectId: ProjectionSnapshotQueryShape["getFirstActiveThreadIdByProjectId"] =
    (projectId) =>
      getFirstActiveThreadIdByProject({ projectId }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getFirstActiveThreadIdByProjectId:query",
            "ProjectionSnapshotQuery.getFirstActiveThreadIdByProjectId:decodeRow",
          ),
        ),
        Effect.map(Option.map((row) => row.threadId)),
      );

  const getThreadCheckpointContext: ProjectionSnapshotQueryShape["getThreadCheckpointContext"] = (
    threadId,
  ) =>
    Effect.gen(function* () {
      const threadRow = yield* getThreadCheckpointContextThreadRow({ threadId }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getThreadCheckpointContext:getThread:query",
            "ProjectionSnapshotQuery.getThreadCheckpointContext:getThread:decodeRow",
          ),
        ),
      );
      if (Option.isNone(threadRow)) {
        return Option.none<ProjectionThreadCheckpointContext>();
      }

      const checkpointRows = yield* listCheckpointRowsByThread({ threadId }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getThreadCheckpointContext:listCheckpoints:query",
            "ProjectionSnapshotQuery.getThreadCheckpointContext:listCheckpoints:decodeRows",
          ),
        ),
      );

      return Option.some({
        threadId: threadRow.value.threadId,
        projectId: threadRow.value.projectId,
        workspaceRoot: threadRow.value.workspaceRoot,
        worktreePath: threadRow.value.worktreePath,
        checkpoints: checkpointRows.map(
          (row): OrchestrationCheckpointSummary => ({
            turnId: row.turnId,
            checkpointTurnCount: row.checkpointTurnCount,
            checkpointRef: row.checkpointRef,
            status: row.status,
            files: row.files,
            assistantMessageId: row.assistantMessageId,
            completedAt: row.completedAt,
          }),
        ),
      });
    });

  const getThreadShellById: ProjectionSnapshotQueryShape["getThreadShellById"] = (threadId) =>
    Effect.gen(function* () {
      const [threadRow, latestTurnRow, sessionRow] = yield* Effect.all([
        getActiveThreadRowById({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadShellById:getThread:query",
              "ProjectionSnapshotQuery.getThreadShellById:getThread:decodeRow",
            ),
          ),
        ),
        getLatestTurnRowByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadShellById:getLatestTurn:query",
              "ProjectionSnapshotQuery.getThreadShellById:getLatestTurn:decodeRow",
            ),
          ),
        ),
        getThreadSessionRowByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadShellById:getSession:query",
              "ProjectionSnapshotQuery.getThreadShellById:getSession:decodeRow",
            ),
          ),
        ),
      ]);

      if (Option.isNone(threadRow)) {
        return Option.none<OrchestrationThreadShell>();
      }

      return Option.some({
        id: threadRow.value.threadId,
        projectId: threadRow.value.projectId,
        title: threadRow.value.title,
        modelSelection: threadRow.value.modelSelection,
        runtimeMode: threadRow.value.runtimeMode,
        interactionMode: threadRow.value.interactionMode,
        branch: threadRow.value.branch,
        worktreePath: threadRow.value.worktreePath,
        latestTurn: Option.isSome(latestTurnRow) ? mapLatestTurn(latestTurnRow.value) : null,
        createdAt: threadRow.value.createdAt,
        updatedAt: threadRow.value.updatedAt,
        archivedAt: threadRow.value.archivedAt,
        deletedAt: threadRow.value.deletedAt,
        session: Option.isSome(sessionRow)
          ? mapSessionRowForThread(
              sessionRow.value,
              Option.isSome(latestTurnRow) ? mapLatestTurn(latestTurnRow.value) : null,
            )
          : null,
        latestUserMessageAt: threadRow.value.latestUserMessageAt,
        hasPendingApprovals: threadRow.value.pendingApprovalCount > 0,
        hasPendingUserInput: threadRow.value.pendingUserInputCount > 0,
        hasActionableProposedPlan: threadRow.value.hasActionableProposedPlan > 0,
      } satisfies OrchestrationThreadShell);
    });

  const getPostTerminalStaleSteerCandidateThreadIds: ProjectionSnapshotQueryShape["getPostTerminalStaleSteerCandidateThreadIds"] =
    () =>
      listPostTerminalStaleSteerCandidateThreadRows(undefined).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getPostTerminalStaleSteerCandidateThreadIds:query",
            "ProjectionSnapshotQuery.getPostTerminalStaleSteerCandidateThreadIds:decodeRows",
          ),
        ),
        Effect.map((rows) => rows.map((row) => row.threadId)),
      );

  const getCodexSteerAcceptanceEvidence: ProjectionSnapshotQueryShape["getCodexSteerAcceptanceEvidence"] =
    (input: ProjectionCodexSteerAcceptanceEvidenceInput = {}) =>
      listCodexSteerAcceptanceEvidenceRows({
        threadId: input.threadId ?? null,
        acceptedTurnId: input.acceptedTurnId ?? null,
        messageId: input.messageId ?? null,
      }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getCodexSteerAcceptanceEvidence:query",
            "ProjectionSnapshotQuery.getCodexSteerAcceptanceEvidence:decodeRows",
          ),
        ),
        Effect.map(
          (rows): ReadonlyArray<ProjectionCodexSteerAcceptanceEvidence> =>
            rows.map((row) => ({
              threadId: row.threadId,
              acceptedTurnId: row.acceptedTurnId,
              clientCorrelationId: row.clientCorrelationId,
              messageId: row.messageId,
              messageTurnId: row.messageTurnId,
              messageText: row.messageText,
              messageAttachments: row.messageAttachments ?? [],
              acceptedAt: row.acceptedAt,
              turnState: row.turnState,
              turnCompletedAt: row.turnCompletedAt,
              processingObserved: row.processingObserved > 0,
              recoveryObserved: row.recoveryObserved > 0,
              interruptRequested: row.interruptRequested > 0,
              sessionStopRequested: row.sessionStopRequested > 0,
            })),
        ),
      );

  const getUnsettledCodexSteerIntentEvents: ProjectionSnapshotQueryShape["getUnsettledCodexSteerIntentEvents"] =
    (input) =>
      listUnsettledCodexSteerIntentEventRows({ threadId: input?.threadId ?? null }).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getUnsettledCodexSteerIntentEvents:query",
            "ProjectionSnapshotQuery.getUnsettledCodexSteerIntentEvents:decodeRows",
          ),
        ),
        Effect.flatMap((rows) =>
          Effect.forEach(
            rows,
            (row) => {
              const clientCorrelationId = buildCodexSteerClientCorrelationId(row.messageId);
              return findExactCodexSteerProcessingEvidenceRow({
                threadId: row.threadId,
                messageId: row.messageId,
                clientCorrelationId,
                taskId: `codex-turn-steer-processing:${clientCorrelationId}`,
              }).pipe(
                Effect.mapError(
                  toPersistenceSqlOrDecodeError(
                    "ProjectionSnapshotQuery.getUnsettledCodexSteerIntentEvents:processingQuery",
                    "ProjectionSnapshotQuery.getUnsettledCodexSteerIntentEvents:processingDecodeRow",
                  ),
                ),
                Effect.map((processing) => (processing.processingObserved > 0 ? null : row)),
              );
            },
            // Genuine crash-before-I/O candidates are rare. Keep the exact
            // evidence lookups bounded so corrupt or adversarial ledgers cannot
            // turn startup reconciliation into unbounded SQLite contention.
            { concurrency: 8 },
          ),
        ),
        Effect.map(
          (rows): ReadonlyArray<ProjectionUnsettledCodexSteerIntentEvent> =>
            rows.flatMap((row) =>
              row === null
                ? []
                : [
                    {
                      sequence: row.sequence,
                      threadId: row.threadId,
                      messageId: row.messageId,
                      expectedTurnId: row.expectedTurnId,
                      createdAt: row.createdAt,
                    },
                  ],
            ),
        ),
      );

  const getCodexSteerIntentRecoveryBarriers: ProjectionSnapshotQueryShape["getCodexSteerIntentRecoveryBarriers"] =
    (input) =>
      findCodexSteerIntentRecoveryBarrierRow(input).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getCodexSteerIntentRecoveryBarriers:query",
            "ProjectionSnapshotQuery.getCodexSteerIntentRecoveryBarriers:decodeRow",
          ),
        ),
        Effect.map(
          (row): ProjectionCodexSteerIntentRecoveryBarriers => ({
            intentVerified: row.intentVerified > 0,
            newerTurnRequested: row.newerTurnRequested > 0,
            interruptRequested: row.interruptRequested > 0,
            sessionStopRequested: row.sessionStopRequested > 0,
          }),
        ),
      );

  const getThreadTurnActivityPage: ProjectionSnapshotQueryShape["getThreadTurnActivityPage"] = (
    input,
  ) =>
    Effect.gen(function* () {
      const [countRow, activityRows] = yield* Effect.all([
        countThreadActivityRowsByTurn(input).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadTurnActivityPage:countActivities:query",
              "ProjectionSnapshotQuery.getThreadTurnActivityPage:countActivities:decodeRow",
            ),
          ),
        ),
        listThreadActivityRowsByTurnPage(input).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadTurnActivityPage:listActivities:query",
              "ProjectionSnapshotQuery.getThreadTurnActivityPage:listActivities:decodeRows",
            ),
          ),
        ),
      ]);

      // Keep historical work-log hydration bounded. The thread-detail snapshot
      // already carries recent activity for live rendering; this query is the
      // DB-backed page path for older turns and must not grow into a full
      // thread-history read.
      return {
        threadId: input.threadId,
        turnId: input.turnId,
        offset: input.offset,
        limit: input.limit,
        totalCount: countRow.count,
        activities: activityRows.map(mapActivityRow),
      };
    });

  const getThreadTurnWorkLogPresence: ProjectionSnapshotQueryShape["getThreadTurnWorkLogPresence"] =
    (input) =>
      Effect.gen(function* () {
        // Preserve request order while eliminating duplicate lookups. Each
        // EXISTS query is turn-scoped and can stop at the first displayable
        // row, unlike the full COUNT used only after explicit expansion.
        const uniqueTurnIds = [...new Set(input.turnIds)];
        const presenceRows = yield* Effect.forEach(uniqueTurnIds, (turnId) =>
          findThreadTurnWorkLogPresence({
            threadId: input.threadId,
            turnId,
          }).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getThreadTurnWorkLogPresence:query",
                "ProjectionSnapshotQuery.getThreadTurnWorkLogPresence:decodeRow",
              ),
            ),
            Effect.map((row) => ({ turnId, hasWorkLog: row.hasWorkLog > 0 })),
          ),
        );

        return {
          threadId: input.threadId,
          turnIdsWithWorkLog: presenceRows.flatMap(({ turnId, hasWorkLog }) =>
            hasWorkLog ? [turnId] : [],
          ),
        };
      });

  const hasThreadTurnSubagentActivity: ProjectionSnapshotQueryShape["hasThreadTurnSubagentActivity"] =
    (input) =>
      findThreadTurnSubagentActivityPresence(input).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.hasThreadTurnSubagentActivity:query",
            "ProjectionSnapshotQuery.hasThreadTurnSubagentActivity:decodeRow",
          ),
        ),
        Effect.map((row) => row.hasSubagentActivity > 0),
      );

  const loadThreadDetailById = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const [
        threadRow,
        messageRows,
        proposedPlanRows,
        activityRows,
        checkpointRows,
        latestTurnRow,
        sessionRow,
        goalRow,
      ] = yield* Effect.all([
        getActiveThreadRowById({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:getThread:query",
              "ProjectionSnapshotQuery.getThreadDetailById:getThread:decodeRow",
            ),
          ),
        ),
        listThreadMessageRowsByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:listMessages:query",
              "ProjectionSnapshotQuery.getThreadDetailById:listMessages:decodeRows",
            ),
          ),
        ),
        listThreadProposedPlanRowsByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:listPlans:query",
              "ProjectionSnapshotQuery.getThreadDetailById:listPlans:decodeRows",
            ),
          ),
        ),
        listThreadActivityRowsByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:listActivities:query",
              "ProjectionSnapshotQuery.getThreadDetailById:listActivities:decodeRows",
            ),
          ),
        ),
        listCheckpointRowsByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:listCheckpoints:query",
              "ProjectionSnapshotQuery.getThreadDetailById:listCheckpoints:decodeRows",
            ),
          ),
        ),
        getLatestTurnRowByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:getLatestTurn:query",
              "ProjectionSnapshotQuery.getThreadDetailById:getLatestTurn:decodeRow",
            ),
          ),
        ),
        getThreadSessionRowByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:getSession:query",
              "ProjectionSnapshotQuery.getThreadDetailById:getSession:decodeRow",
            ),
          ),
        ),
        getThreadGoalRowByThread({ threadId }).pipe(
          Effect.mapError(
            toPersistenceSqlOrDecodeError(
              "ProjectionSnapshotQuery.getThreadDetailById:getGoal:query",
              "ProjectionSnapshotQuery.getThreadDetailById:getGoal:decodeRow",
            ),
          ),
        ),
      ]);

      if (activityRows[0]?.subagentRetentionTruncated === 1) {
        const latestTurnId = Option.isSome(latestTurnRow) ? latestTurnRow.value.turnId : null;
        const diagnosticKey = JSON.stringify([threadId, latestTurnId]);
        if (!reportedSubagentRetentionLimits.has(diagnosticKey)) {
          reportedSubagentRetentionLimits.set(diagnosticKey, true);
          while (reportedSubagentRetentionLimits.size > MAX_RUNTIME_SUBAGENT_IDENTITIES_PER_TURN) {
            const oldest = reportedSubagentRetentionLimits.keys().next().value;
            if (typeof oldest !== "string") break;
            reportedSubagentRetentionLimits.delete(oldest);
          }
          yield* Effect.logWarning("thread detail subagent retention reached safety limit", {
            threadId,
            turnId: latestTurnId,
            retainedIdentityLimit: MAX_RUNTIME_SUBAGENT_IDENTITIES_PER_TURN,
          });
        }
      }

      if (Option.isNone(threadRow)) {
        return Option.none<OrchestrationThread>();
      }

      const thread = {
        id: threadRow.value.threadId,
        projectId: threadRow.value.projectId,
        title: threadRow.value.title,
        modelSelection: threadRow.value.modelSelection,
        runtimeMode: threadRow.value.runtimeMode,
        interactionMode: threadRow.value.interactionMode,
        branch: threadRow.value.branch,
        worktreePath: threadRow.value.worktreePath,
        latestTurn: Option.isSome(latestTurnRow) ? mapLatestTurn(latestTurnRow.value) : null,
        createdAt: threadRow.value.createdAt,
        updatedAt: threadRow.value.updatedAt,
        archivedAt: threadRow.value.archivedAt,
        deletedAt: null,
        messages: dedupeCodexSnapshotAssistantMessages(messageRows).map((row) => {
          const message = {
            id: row.messageId,
            role: row.role,
            text: row.text,
            turnId: row.turnId,
            streaming: row.isStreaming === 1,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          };
          if (row.attachments !== null) {
            return Object.assign(message, { attachments: row.attachments });
          }
          return message;
        }),
        proposedPlans: proposedPlanRows.map(mapProposedPlanRow),
        activities: activityRows.map(mapActivityRow),
        checkpoints: checkpointRows.map((row) => ({
          turnId: row.turnId,
          checkpointTurnCount: row.checkpointTurnCount,
          checkpointRef: row.checkpointRef,
          status: row.status,
          files: row.files,
          assistantMessageId: row.assistantMessageId,
          completedAt: row.completedAt,
        })),
        session: Option.isSome(sessionRow)
          ? mapSessionRowForThread(
              sessionRow.value,
              Option.isSome(latestTurnRow) ? mapLatestTurn(latestTurnRow.value) : null,
            )
          : null,
        goal: Option.getOrNull(goalRow),
      };

      return Option.some(
        yield* decodeThread(thread).pipe(
          Effect.mapError(
            toPersistenceDecodeError("ProjectionSnapshotQuery.getThreadDetailById:decodeThread"),
          ),
        ),
      );
    });

  const getThreadDetailById: ProjectionSnapshotQueryShape["getThreadDetailById"] = (threadId) =>
    sql.withTransaction(loadThreadDetailById(threadId)).pipe(
      Effect.mapError((error) => {
        if (isPersistenceError(error)) {
          return error;
        }
        return toPersistenceSqlError("ProjectionSnapshotQuery.getThreadDetailById:query")(error);
      }),
    );

  const getThreadDetailSnapshotById: ProjectionSnapshotQueryShape["getThreadDetailSnapshotById"] = (
    threadId,
  ) =>
    sql
      .withTransaction(
        Effect.all([
          loadThreadDetailById(threadId),
          listProjectionStateRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getThreadDetailSnapshotById:listProjectionState:query",
                "ProjectionSnapshotQuery.getThreadDetailSnapshotById:listProjectionState:decodeRows",
              ),
            ),
          ),
        ]),
      )
      .pipe(
        Effect.map(([threadDetail, stateRows]) => {
          if (Option.isNone(threadDetail)) {
            return Option.none();
          }
          return Option.some({
            snapshotSequence: computeSnapshotSequence(stateRows),
            thread: threadDetail.value,
          });
        }),
        Effect.mapError((error) => {
          if (isPersistenceError(error)) {
            return error;
          }
          return toPersistenceSqlError("ProjectionSnapshotQuery.getThreadDetailSnapshotById:query")(
            error,
          );
        }),
      );

  return {
    getCommandReadModel,
    getSnapshot,
    getShellSnapshot,
    getArchivedShellSnapshot,
    getDeletedShellSnapshot,
    getSnapshotSequence,
    getCounts,
    getActiveProjectByWorkspaceRoot,
    getProjectShellById,
    getFirstActiveThreadIdByProjectId,
    getThreadCheckpointContext,
    getThreadShellById,
    getPostTerminalStaleSteerCandidateThreadIds,
    getCodexSteerAcceptanceEvidence,
    getUnsettledCodexSteerIntentEvents,
    getCodexSteerIntentRecoveryBarriers,
    getThreadTurnActivityPage,
    getThreadTurnWorkLogPresence,
    hasThreadTurnSubagentActivity,
    getThreadDetailById,
    getThreadDetailSnapshotById,
  } satisfies ProjectionSnapshotQueryShape;
});

export const OrchestrationProjectionSnapshotQueryLive = Layer.effect(
  ProjectionSnapshotQuery,
  makeProjectionSnapshotQuery,
);
