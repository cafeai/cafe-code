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
import {
  hydrateAndReadUnsettledCodexSteerIntents,
  pruneSettledAcceptedCodexSteerRecoveryCandidate,
  pruneSettledCodexSteerIntent,
  readAcceptedCodexSteerRecoveryBarriers,
  type PersistedUnsettledCodexSteerIntent,
} from "../codexSteerIntentLedger.ts";
import { ORCHESTRATION_PROJECTOR_NAMES } from "./ProjectionPipeline.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionAcceptedCodexSteerCandidate,
  type ProjectionCodexSteerAcceptanceEvidence,
  type ProjectionCodexSteerAcceptanceEvidenceInput,
  type ProjectionCodexSteerIntentRecoveryBarriers,
  type ProjectionLegacyCodexSteerCandidate,
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
  exactLookup: Schema.Boolean,
  threadId: Schema.NullOr(ThreadId),
  acceptedTurnId: Schema.NullOr(TurnId),
  messageId: Schema.NullOr(MessageId),
  exactEventSequence: Schema.NullOr(NonNegativeInt),
  exactIntentSequence: Schema.NullOr(NonNegativeInt),
  exactActivityId: Schema.NullOr(Schema.String),
  exactClientCorrelationId: Schema.NullOr(Schema.String),
  exactAcceptedAt: Schema.NullOr(IsoDateTime),
});
const CodexSteerAcceptanceEvidenceRowSchema = Schema.Struct({
  threadId: ThreadId,
  acceptedTurnId: TurnId,
  intentSequence: NonNegativeInt,
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
  candidateSequence: NonNegativeInt,
  candidateCreatedAt: IsoDateTime,
  threadId: ThreadId,
  expectedTurnId: Schema.NullOr(TurnId),
  messageId: MessageId,
  clientCorrelationId: Schema.String,
  taskId: Schema.String,
});
const CodexSteerProcessingEvidenceRowSchema = Schema.Struct({
  processingObserved: NonNegativeInt,
});
const CodexSteerAcceptedBarrierCandidateLookupInput = Schema.Struct({
  sequence: NonNegativeInt,
  intentSequence: NonNegativeInt,
  intentCreatedAt: IsoDateTime,
  threadId: ThreadId,
  activityId: Schema.String,
  acceptedTurnId: TurnId,
  clientCorrelationId: Schema.NullOr(Schema.String),
  messageId: MessageId,
  acceptedAt: IsoDateTime,
});
const CodexSteerAcceptedBarrierCandidateRowSchema = Schema.Struct({
  isCandidate: NonNegativeInt,
  processingObserved: NonNegativeInt,
  recoveryObserved: NonNegativeInt,
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

  const listActiveCodexThreadIdRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionThreadIdLookupRowSchema,
    execute: () =>
      sql`
        SELECT threads.thread_id AS "threadId"
        FROM projection_threads AS threads
        INNER JOIN projection_thread_sessions AS sessions
          ON sessions.thread_id = threads.thread_id
        WHERE threads.deleted_at IS NULL
          AND threads.archived_at IS NULL
          AND sessions.provider_name = 'codex'
        ORDER BY threads.thread_id ASC
      `,
  });

  /**
   * Decide whether one already-authenticated compact acceptance barrier still
   * needs terminal recovery. Every lookup starts from the activity primary key
   * and exact thread/turn/message tuple supplied by the ledger helper; unlike
   * the retired discovery branch, it never searches the event journal.
   *
   * Provider progress may suppress this prefilter under the historical
   * correlation contract, but permanent pruning is stricter: a non-null
   * correlation must also carry the exact MessageId. That distinction keeps a
   * provider-authored partial observation from destroying Cafe's only durable
   * recovery candidate. Trusted recovered evidence may settle it directly.
   */
  const findPostTerminalAcceptedSteerCandidateRow = SqlSchema.findOne({
    Request: CodexSteerAcceptedBarrierCandidateLookupInput,
    Result: CodexSteerAcceptedBarrierCandidateRowSchema,
    execute: ({
      sequence,
      intentSequence,
      intentCreatedAt,
      threadId,
      activityId,
      acceptedTurnId,
      clientCorrelationId,
      messageId,
      acceptedAt,
    }) =>
      sql`
        WITH exact_accepted AS (
          SELECT 1
          FROM orchestration_pending_codex_steer_acceptances AS pending
          INNER JOIN orchestration_events AS intent
            ON intent.sequence = pending.intent_sequence
          INNER JOIN projection_thread_activities AS accepted
            ON accepted.activity_id = ${activityId}
          INNER JOIN projection_turns AS accepted_turn
            ON accepted_turn.thread_id = accepted.thread_id
            AND accepted_turn.turn_id = accepted.turn_id
          INNER JOIN projection_thread_messages AS accepted_message
            ON accepted_message.thread_id = accepted.thread_id
            AND accepted_message.message_id = ${messageId}
            AND accepted_message.role = 'user'
          WHERE pending.sequence = ${sequence}
            AND pending.intent_sequence = ${intentSequence}
            AND pending.thread_id = ${threadId}
            AND pending.activity_id = ${activityId}
            AND pending.accepted_turn_id = ${acceptedTurnId}
            AND pending.message_id = ${messageId}
            AND pending.client_correlation_id IS ${clientCorrelationId}
            AND pending.accepted_at = ${acceptedAt}
            AND intent.aggregate_kind = 'thread'
            AND intent.stream_id = ${threadId}
            AND intent.event_type IN (
              'thread.turn-start-requested',
              'thread.turn-steer-requested'
            )
            AND intent.actor_kind IN ('client', 'server')
            AND json_extract(intent.payload_json, '$.threadId') = ${threadId}
            AND json_extract(intent.payload_json, '$.messageId') = ${messageId}
            AND json_extract(intent.payload_json, '$.createdAt') = intent.occurred_at
            AND intent.occurred_at = ${intentCreatedAt}
            AND accepted.thread_id = ${threadId}
            AND accepted.turn_id = ${acceptedTurnId}
            AND accepted.kind = 'provider.turn.steer.accepted'
            AND accepted.created_at = ${acceptedAt}
            AND json_extract(accepted.payload_json, '$.provider') = 'codex'
            AND json_extract(accepted.payload_json, '$.messageId') = ${messageId}
            AND json_extract(accepted.payload_json, '$.acceptedTurnId') = ${acceptedTurnId}
            AND json_extract(accepted.payload_json, '$.clientCorrelationId') IS
              ${clientCorrelationId}
            AND accepted_turn.completed_at IS NOT NULL
            AND accepted_turn.state IN ('completed', 'error', 'interrupted')
          LIMIT 1
        ),
        evidence AS (
          SELECT
            EXISTS (
              SELECT 1
              FROM projection_thread_activities AS processing
              INNER JOIN orchestration_events AS processing_event
                ON processing_event.command_id =
                  'provider:codex:' || processing.thread_id || ':' ||
                  processing.activity_id || ':thread-activity-append:' ||
                  processing.activity_id
                AND processing_event.sequence > ${intentSequence}
                AND processing_event.aggregate_kind = 'thread'
                AND processing_event.stream_id = processing.thread_id
                AND processing_event.event_type = 'thread.activity-appended'
                AND processing_event.actor_kind = 'provider'
                AND json_extract(processing_event.payload_json, '$.threadId') =
                  processing.thread_id
                AND json_extract(processing_event.payload_json, '$.activity.id') =
                  processing.activity_id
                AND json_extract(processing_event.payload_json, '$.activity.kind') =
                  processing.kind
                AND json_extract(processing_event.payload_json, '$.activity.turnId') IS
                  processing.turn_id
                AND json_extract(processing_event.payload_json, '$.activity.createdAt') =
                  processing.created_at
                AND json_extract(processing_event.payload_json, '$.activity.payload') =
                  json(processing.payload_json)
              WHERE processing.thread_id = ${threadId}
                AND processing.turn_id = ${acceptedTurnId}
                AND processing.kind = 'task.progress'
                AND processing.created_at >= ${intentCreatedAt}
                AND (
                  (
                    ${clientCorrelationId} IS NOT NULL
                    AND json_extract(processing.payload_json, '$.taskId') =
                      'codex-turn-steer-processing:' || ${clientCorrelationId}
                    AND json_extract(
                      processing.payload_json,
                      '$.usage.clientCorrelationId'
                    ) = ${clientCorrelationId}
                    AND (
                      json_extract(processing.payload_json, '$.usage.messageId') IS NULL
                      OR json_extract(processing.payload_json, '$.usage.messageId') = ${messageId}
                    )
                  )
                  OR (
                    ${clientCorrelationId} IS NULL
                    AND json_extract(processing.payload_json, '$.taskId') =
                      'codex-turn-steer-processing:' || ${messageId}
                    AND json_extract(processing.payload_json, '$.usage.messageId') = ${messageId}
                  )
                )
              LIMIT 1
            ) AS processing_observed,
            EXISTS (
              SELECT 1
              FROM projection_thread_activities AS processing
              INNER JOIN orchestration_events AS processing_event
                ON processing_event.command_id =
                  'provider:codex:' || processing.thread_id || ':' ||
                  processing.activity_id || ':thread-activity-append:' ||
                  processing.activity_id
                AND processing_event.sequence > ${intentSequence}
                AND processing_event.aggregate_kind = 'thread'
                AND processing_event.stream_id = processing.thread_id
                AND processing_event.event_type = 'thread.activity-appended'
                AND processing_event.actor_kind = 'provider'
                AND json_extract(processing_event.payload_json, '$.threadId') =
                  processing.thread_id
                AND json_extract(processing_event.payload_json, '$.activity.id') =
                  processing.activity_id
                AND json_extract(processing_event.payload_json, '$.activity.kind') =
                  processing.kind
                AND json_extract(processing_event.payload_json, '$.activity.turnId') IS
                  processing.turn_id
                AND json_extract(processing_event.payload_json, '$.activity.createdAt') =
                  processing.created_at
                AND json_extract(processing_event.payload_json, '$.activity.payload') =
                  json(processing.payload_json)
              WHERE processing.thread_id = ${threadId}
                AND processing.turn_id = ${acceptedTurnId}
                AND processing.kind = 'task.progress'
                AND processing.created_at >= ${intentCreatedAt}
                AND (
                  (
                    ${clientCorrelationId} IS NOT NULL
                    AND json_extract(processing.payload_json, '$.taskId') =
                      'codex-turn-steer-processing:' || ${clientCorrelationId}
                    AND json_extract(
                      processing.payload_json,
                      '$.usage.clientCorrelationId'
                    ) = ${clientCorrelationId}
                    AND json_extract(processing.payload_json, '$.usage.messageId') = ${messageId}
                  )
                  OR (
                    ${clientCorrelationId} IS NULL
                    AND json_extract(processing.payload_json, '$.taskId') =
                      'codex-turn-steer-processing:' || ${messageId}
                    AND json_extract(processing.payload_json, '$.usage.messageId') = ${messageId}
                  )
                )
              LIMIT 1
            ) AS prunable_processing_observed,
            EXISTS (
              SELECT 1
              FROM projection_thread_activities AS recovered
              INNER JOIN orchestration_codex_steer_recovery_barriers AS recovery_barrier
                ON recovery_barrier.sequence > ${sequence}
                AND recovery_barrier.thread_id = ${threadId}
                AND recovery_barrier.barrier_kind = 'provider.turn.steer.recovered'
                AND recovery_barrier.candidate_sequence = ${intentSequence}
                AND recovery_barrier.activity_id = recovered.activity_id
                AND recovery_barrier.message_id = ${messageId}
                AND recovery_barrier.turn_id = recovered.turn_id
                AND recovery_barrier.accepted_turn_id = ${acceptedTurnId}
                AND recovery_barrier.client_correlation_id IS ${clientCorrelationId}
                AND recovery_barrier.activity_created_at = recovered.created_at
              WHERE recovered.thread_id = ${threadId}
                AND recovered.kind = 'provider.turn.steer.recovered'
                AND recovered.created_at >= ${acceptedAt}
                AND json_extract(recovered.payload_json, '$.provider') = 'codex'
                AND json_extract(recovered.payload_json, '$.messageId') = ${messageId}
                AND json_extract(recovered.payload_json, '$.acceptedTurnId') = ${acceptedTurnId}
                AND json_extract(recovered.payload_json, '$.recoveredTurnId') = recovered.turn_id
                AND json_extract(recovered.payload_json, '$.clientCorrelationId') IS
                  ${clientCorrelationId}
              LIMIT 1
            ) AS recovery_observed
        )
        SELECT
          CASE
            WHEN EXISTS (SELECT 1 FROM exact_accepted)
              AND evidence.processing_observed = 0
              AND evidence.recovery_observed = 0
            THEN 1
            ELSE 0
          END AS "isCandidate",
          CASE
            WHEN EXISTS (SELECT 1 FROM exact_accepted)
            THEN evidence.prunable_processing_observed
            ELSE 0
          END AS "processingObserved",
          CASE
            WHEN EXISTS (SELECT 1 FROM exact_accepted)
            THEN evidence.recovery_observed
            ELSE 0
          END AS "recoveryObserved"
        FROM evidence
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
    execute: ({
      exactLookup,
      threadId,
      acceptedTurnId,
      messageId,
      exactEventSequence,
      exactIntentSequence,
      exactActivityId,
      exactClientCorrelationId,
      exactAcceptedAt,
    }) => {
      // Do not express the exact form as `(parameter IS NULL OR column =
      // parameter)`: SQLite cannot reliably select the primary-key access
      // path through that shape. Startup supplies both immutable primary keys,
      // so emit plain equalities and keep work independent of thread age.
      const acceptedIdentityPredicate = exactLookup
        ? sql`
            accepted.activity_id = ${exactActivityId}
            AND accepted.thread_id = ${threadId}
            AND accepted.turn_id = ${acceptedTurnId}
            AND accepted.created_at = ${exactAcceptedAt}
            AND json_extract(accepted.payload_json, '$.messageId') = ${messageId}
            AND json_extract(accepted.payload_json, '$.clientCorrelationId') IS
              ${exactClientCorrelationId}
          `
        : sql`
            (${threadId} IS NULL OR accepted.thread_id = ${threadId})
            AND (${acceptedTurnId} IS NULL OR accepted.turn_id = ${acceptedTurnId})
            AND (
              ${messageId} IS NULL
              OR json_extract(accepted.payload_json, '$.messageId') = ${messageId}
            )
          `;
      const acceptedEventIdentityPredicate = exactLookup
        ? sql`accepted_event.sequence = ${exactEventSequence}`
        : sql`
            accepted_event.aggregate_kind = 'thread'
            AND accepted_event.stream_id = accepted.thread_id
            AND accepted_event.event_type = 'thread.activity-appended'
          `;
      const acceptedIntentIdentityPredicate = exactLookup
        ? sql`accepted_intent.sequence = ${exactIntentSequence}`
        : sql`
            accepted_intent.sequence = json_extract(accepted.payload_json, '$.intentSequence')
          `;
      const acceptedIntentPayloadPredicate = exactLookup
        ? sql`
            (
              json_extract(accepted.payload_json, '$.intentSequence') =
                accepted_intent.sequence
              OR json_type(accepted.payload_json, '$.intentSequence') IS NULL
            )
          `
        : sql`
            json_extract(accepted.payload_json, '$.intentSequence') = accepted_intent.sequence
          `;

      return sql`
        SELECT
          accepted.thread_id AS "threadId",
          accepted.turn_id AS "acceptedTurnId",
          accepted_intent.sequence AS "intentSequence",
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
            INNER JOIN orchestration_events AS processing_event
              ON processing_event.command_id =
                'provider:codex:' || processing.thread_id || ':' ||
                processing.activity_id || ':thread-activity-append:' || processing.activity_id
              AND processing_event.sequence > accepted_intent.sequence
              AND processing_event.aggregate_kind = 'thread'
              AND processing_event.stream_id = processing.thread_id
              AND processing_event.event_type = 'thread.activity-appended'
              AND processing_event.actor_kind = 'provider'
              AND json_extract(processing_event.payload_json, '$.threadId') =
                processing.thread_id
              AND json_extract(processing_event.payload_json, '$.activity.id') =
                processing.activity_id
              AND json_extract(processing_event.payload_json, '$.activity.kind') = processing.kind
              AND json_extract(processing_event.payload_json, '$.activity.turnId') IS
                processing.turn_id
              AND json_extract(processing_event.payload_json, '$.activity.createdAt') =
                processing.created_at
              AND json_extract(processing_event.payload_json, '$.activity.payload') =
                json(processing.payload_json)
            WHERE processing.thread_id = accepted.thread_id
              AND processing.turn_id = accepted.turn_id
              AND processing.kind = 'task.progress'
              AND processing.created_at >= accepted_intent.occurred_at
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
              AND json_extract(recovered.payload_json, '$.intentSequence') =
                accepted_intent.sequence
              AND json_extract(recovered.payload_json, '$.clientCorrelationId') IS
                json_extract(accepted.payload_json, '$.clientCorrelationId')
              AND EXISTS (
                SELECT 1
                FROM orchestration_events AS recovered_event
                WHERE recovered_event.aggregate_kind = 'thread'
                  AND recovered_event.sequence > accepted_event.sequence
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
                    '$.activity.payload.intentSequence'
                  ) = accepted_intent.sequence
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
          ON ${acceptedEventIdentityPredicate}
          AND accepted_event.aggregate_kind = 'thread'
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
        INNER JOIN orchestration_events AS accepted_intent
          ON ${acceptedIntentIdentityPredicate}
          AND accepted_intent.sequence < accepted_event.sequence
          AND accepted_intent.aggregate_kind = 'thread'
          AND accepted_intent.stream_id = accepted.thread_id
          AND accepted_intent.event_type IN (
            'thread.turn-start-requested',
            'thread.turn-steer-requested'
          )
          AND accepted_intent.actor_kind IN ('client', 'server')
          AND json_extract(accepted_intent.payload_json, '$.threadId') = accepted.thread_id
          AND json_extract(accepted_intent.payload_json, '$.messageId') =
            json_extract(accepted.payload_json, '$.messageId')
          AND json_extract(accepted_intent.payload_json, '$.createdAt') =
            accepted_intent.occurred_at
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
          AND ${acceptedIntentPayloadPredicate}
          AND (
            json_type(accepted.payload_json, '$.clientCorrelationId') IS NULL
            OR json_type(accepted.payload_json, '$.clientCorrelationId') = 'text'
          )
          AND ${acceptedIdentityPredicate}
        ORDER BY accepted.created_at ASC, accepted.thread_id ASC, accepted.turn_id ASC,
          json_extract(accepted.payload_json, '$.messageId') ASC
      `;
    },
  });

  /**
   * Verify processing evidence only after TypeScript derives the one canonical
   * token for the persisted MessageId. SQLite does not provide Cafe's
   * domain-separated SHA-256 construction, so a prefix/shape comparison in the
   * discovery query would let a wrong-token activity suppress an undelivered
   * intent. Binding the independently derived token, exact task id, and raw
   * message identity here makes all three fields agree before replay settles.
   * The indexed deterministic provider command id then binds the projection
   * row back to its immutable source event, and that event must be newer than
   * this exact candidate generation. Wall-clock timestamps are insufficient:
   * reconnect replay can deliver an older observation after a newer intent.
   */
  const findExactCodexSteerProcessingEvidenceRow = SqlSchema.findOne({
    Request: CodexSteerProcessingEvidenceLookupInput,
    Result: CodexSteerProcessingEvidenceRowSchema,
    execute: ({
      candidateSequence,
      candidateCreatedAt,
      threadId,
      expectedTurnId,
      messageId,
      clientCorrelationId,
      taskId,
    }) =>
      sql`
        SELECT EXISTS (
          SELECT 1
          -- This join order is a startup-liveness boundary, not merely a
          -- planner hint. On mature ledgers SQLite otherwise starts from
          -- idx_orch_events_stream_sequence and synchronously scans every
          -- later event in a long-running thread before it considers the
          -- selective task-progress projection predicate. CROSS JOIN keeps
          -- the small thread/kind/created-at candidate set outermost, then the
          -- immutable source event is one command-id index probe per row.
          FROM projection_thread_activities AS processing
            INDEXED BY idx_projection_thread_activities_thread_turn_kind_created_id
          CROSS JOIN orchestration_events AS processing_event
            INDEXED BY idx_orch_events_command_id
            ON processing_event.command_id =
              'provider:codex:' || processing.thread_id || ':' ||
              processing.activity_id || ':thread-activity-append:' || processing.activity_id
            AND processing_event.sequence > ${candidateSequence}
            AND processing_event.aggregate_kind = 'thread'
            AND processing_event.stream_id = processing.thread_id
            AND processing_event.event_type = 'thread.activity-appended'
            AND processing_event.actor_kind = 'provider'
            AND json_extract(processing_event.payload_json, '$.threadId') =
              processing.thread_id
            AND json_extract(processing_event.payload_json, '$.activity.id') =
              processing.activity_id
            AND json_extract(processing_event.payload_json, '$.activity.kind') = processing.kind
            AND json_extract(processing_event.payload_json, '$.activity.turnId') IS
              processing.turn_id
            AND json_extract(processing_event.payload_json, '$.activity.createdAt') =
              processing.created_at
            AND json_extract(processing_event.payload_json, '$.activity.payload') =
              json(processing.payload_json)
          WHERE processing.thread_id = ${threadId}
            AND processing.turn_id IS ${expectedTurnId}
            AND processing.kind = 'task.progress'
            AND processing.created_at >= ${candidateCreatedAt}
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
            INDEXED BY idx_projection_thread_activities_thread_kind_created_id
          WHERE thread_id = ${threadId}
            AND kind = 'turn.plan.updated'
          -- The thread-recent index matches this ordering but does not contain
          -- the kind column. On a mature thread with no plan (or only a very old plan),
          -- SQLite can otherwise walk hundreds of thousands of recent activity
          -- entries and perform a table lookup for each one before proving that
          -- no newer plan exists. NodeSqlite executes synchronously, so that
          -- cold scan also starves HTTP and WebSocket liveness. Force the
          -- thread+kind index to bound the candidate set to plan rows; sorting
          -- that normally tiny set is substantially safer than scanning the
          -- full thread history.
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

  const getPostTerminalStaleSteerCandidates: ProjectionSnapshotQueryShape["getPostTerminalStaleSteerCandidates"] =
    (providedActiveCodexThreadIds, providedLegacyCandidateThreadIds = []) =>
      Effect.gen(function* () {
        const activeCodexThreadIds =
          providedActiveCodexThreadIds ??
          (yield* listActiveCodexThreadIdRows(undefined).pipe(
            Effect.mapError(
              toPersistenceSqlOrDecodeError(
                "ProjectionSnapshotQuery.getPostTerminalStaleSteerCandidates:listActiveCodexThreads:query",
                "ProjectionSnapshotQuery.getPostTerminalStaleSteerCandidates:listActiveCodexThreads:decodeRows",
              ),
            ),
            Effect.map((rows) => rows.map((row) => row.threadId)),
          ));

        // The old query placed the complete correlated recovery predicate on
        // a global projection/event scan. Mature installations can retain
        // millions of activity rows, and fresh databases no longer create the
        // retired JSON expression indexes which happened to mask that shape.
        // Legacy candidates are derived from the lightweight shell snapshot
        // by the startup owner. Never rediscover them with a per-thread scan:
        // mature threads may contain millions of messages and activities, and
        // that old bootstrap fan-out can block node:sqlite's synchronous main
        // thread even when both compact ledgers are empty.
        const uniqueThreadIds = [...new Set(activeCodexThreadIds)];
        const activeThreadIdSet = new Set(uniqueThreadIds);
        const legacyCandidates = [...new Set(providedLegacyCandidateThreadIds)]
          .filter((threadId) => activeThreadIdSet.has(threadId))
          .map(
            (threadId) =>
              ({ _tag: "legacy", threadId }) satisfies ProjectionLegacyCodexSteerCandidate,
          );
        const acceptedBarriers = yield* hydrateAndReadUnsettledCodexSteerIntents(
          sql,
          uniqueThreadIds,
        ).pipe(
          Effect.flatMap(() => readAcceptedCodexSteerRecoveryBarriers(sql, uniqueThreadIds)),
          Effect.mapError(
            toPersistenceSqlError(
              "ProjectionSnapshotQuery.getPostTerminalStaleSteerCandidates:readAcceptedLedger",
            ),
          ),
        );
        const acceptedCandidateRows = yield* Effect.forEach(
          acceptedBarriers,
          (barrier) =>
            findPostTerminalAcceptedSteerCandidateRow(barrier).pipe(
              Effect.mapError(
                toPersistenceSqlOrDecodeError(
                  "ProjectionSnapshotQuery.getPostTerminalStaleSteerCandidates:acceptedCandidateQuery",
                  "ProjectionSnapshotQuery.getPostTerminalStaleSteerCandidates:acceptedCandidateDecodeRow",
                ),
              ),
              Effect.flatMap((row) => {
                const correlationIsCanonical =
                  barrier.clientCorrelationId !== null &&
                  barrier.clientCorrelationId ===
                    buildCodexSteerClientCorrelationId(barrier.messageId);
                const mayPrune =
                  row.recoveryObserved > 0 ||
                  (row.processingObserved > 0 && correlationIsCanonical);
                if (mayPrune) {
                  return pruneSettledAcceptedCodexSteerRecoveryCandidate(sql, barrier).pipe(
                    Effect.mapError(
                      toPersistenceSqlError(
                        "ProjectionSnapshotQuery.getPostTerminalStaleSteerCandidates:pruneSettledAcceptedCandidate",
                      ),
                    ),
                    Effect.as(null),
                  );
                }
                return Effect.succeed(
                  row.isCandidate > 0
                    ? ({
                        _tag: "accepted",
                        threadId: barrier.threadId,
                        eventSequence: barrier.sequence,
                        intentSequence: barrier.intentSequence,
                        intentCreatedAt: barrier.intentCreatedAt,
                        activityId: barrier.activityId,
                        acceptedTurnId: barrier.acceptedTurnId,
                        clientCorrelationId: barrier.clientCorrelationId,
                        messageId: barrier.messageId,
                        acceptedAt: barrier.acceptedAt,
                      } satisfies ProjectionAcceptedCodexSteerCandidate)
                    : null,
                );
              }),
            ),
          { concurrency: 4 },
        );
        return [
          ...legacyCandidates,
          ...acceptedCandidateRows.flatMap((candidate) => (candidate === null ? [] : [candidate])),
        ].toSorted((left, right) => {
          const threadOrder = left.threadId.localeCompare(right.threadId);
          if (threadOrder !== 0) {
            return threadOrder;
          }
          if (left._tag !== right._tag) {
            return left._tag === "legacy" ? -1 : 1;
          }
          return left._tag === "accepted" && right._tag === "accepted"
            ? left.eventSequence - right.eventSequence
            : 0;
        });
      });

  const getPostTerminalStaleSteerCandidateThreadIds: ProjectionSnapshotQueryShape["getPostTerminalStaleSteerCandidateThreadIds"] =
    (activeCodexThreadIds, legacyCandidateThreadIds) =>
      getPostTerminalStaleSteerCandidates(activeCodexThreadIds, legacyCandidateThreadIds).pipe(
        Effect.map((candidates) =>
          [...new Set(candidates.map((candidate) => candidate.threadId))].toSorted((left, right) =>
            left.localeCompare(right),
          ),
        ),
      );

  const getCodexSteerAcceptanceEvidence: ProjectionSnapshotQueryShape["getCodexSteerAcceptanceEvidence"] =
    (input: ProjectionCodexSteerAcceptanceEvidenceInput = {}) => {
      const exactAcceptedBarrier = input.exactAcceptedBarrier;
      return listCodexSteerAcceptanceEvidenceRows({
        exactLookup: exactAcceptedBarrier !== undefined,
        threadId: exactAcceptedBarrier?.threadId ?? input.threadId ?? null,
        acceptedTurnId: exactAcceptedBarrier?.acceptedTurnId ?? input.acceptedTurnId ?? null,
        messageId: exactAcceptedBarrier?.messageId ?? input.messageId ?? null,
        exactEventSequence: exactAcceptedBarrier?.eventSequence ?? null,
        exactIntentSequence: exactAcceptedBarrier?.intentSequence ?? null,
        exactActivityId: exactAcceptedBarrier?.activityId ?? null,
        exactClientCorrelationId: exactAcceptedBarrier?.clientCorrelationId ?? null,
        exactAcceptedAt: exactAcceptedBarrier?.acceptedAt ?? null,
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
              intentSequence: row.intentSequence,
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
    };

  const getUnsettledCodexSteerIntentEvents: ProjectionSnapshotQueryShape["getUnsettledCodexSteerIntentEvents"] =
    (input) =>
      listActiveCodexThreadIdRows(undefined).pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectionSnapshotQuery.getUnsettledCodexSteerIntentEvents:listActiveCodexThreads:query",
            "ProjectionSnapshotQuery.getUnsettledCodexSteerIntentEvents:listActiveCodexThreads:decodeRows",
          ),
        ),
        Effect.map((rows) =>
          rows
            .map((row) => row.threadId)
            .filter((threadId) => input?.threadId === undefined || threadId === input.threadId),
        ),
        Effect.flatMap((activeCodexThreadIds) =>
          hydrateAndReadUnsettledCodexSteerIntents(sql, activeCodexThreadIds),
        ),
        Effect.mapError(
          toPersistenceSqlError(
            "ProjectionSnapshotQuery.getUnsettledCodexSteerIntentEvents:readLedger",
          ),
        ),
        Effect.flatMap((rows) => {
          if (input?.reconcileDurableProcessing === false) {
            return Effect.succeed<ReadonlyArray<PersistedUnsettledCodexSteerIntent | null>>(rows);
          }
          return Effect.forEach(
            rows,
            (row) => {
              const clientCorrelationId = buildCodexSteerClientCorrelationId(row.messageId);
              return findExactCodexSteerProcessingEvidenceRow({
                candidateSequence: row.sequence,
                candidateCreatedAt: row.createdAt,
                threadId: row.threadId,
                expectedTurnId: row.expectedTurnId,
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
                Effect.flatMap((processing) =>
                  processing.processingObserved > 0
                    ? pruneSettledCodexSteerIntent(sql, row).pipe(
                        Effect.mapError(
                          toPersistenceSqlError(
                            "ProjectionSnapshotQuery.getUnsettledCodexSteerIntentEvents:pruneProcessedCandidate",
                          ),
                        ),
                        Effect.as(null),
                      )
                    : Effect.succeed(row),
                ),
              );
            },
            // Genuine crash-before-I/O candidates are rare. Keep the exact
            // evidence lookups bounded so corrupt or adversarial ledgers cannot
            // turn startup reconciliation into unbounded SQLite contention.
            { concurrency: 8 },
          );
        }),
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
    getPostTerminalStaleSteerCandidates,
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
