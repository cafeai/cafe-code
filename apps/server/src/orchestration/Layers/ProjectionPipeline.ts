import {
  ApprovalRequestId,
  type ChatAttachment,
  type OrchestrationEvent,
  ThreadId,
  type TurnId,
} from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError, type ProjectionRepositoryError } from "../../persistence/Errors.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { ProjectionPendingApprovalRepository } from "../../persistence/Services/ProjectionPendingApprovals.ts";
import { ProjectionProjectRepository } from "../../persistence/Services/ProjectionProjects.ts";
import { ProjectionStateRepository } from "../../persistence/Services/ProjectionState.ts";
import {
  type ProjectionThreadActivity,
  ProjectionThreadActivityRepository,
} from "../../persistence/Services/ProjectionThreadActivities.ts";
import {
  type ProjectionThreadMessage,
  ProjectionThreadMessageRepository,
} from "../../persistence/Services/ProjectionThreadMessages.ts";
import {
  type ProjectionThreadProposedPlan,
  ProjectionThreadProposedPlanRepository,
} from "../../persistence/Services/ProjectionThreadProposedPlans.ts";
import { ProjectionThreadSessionRepository } from "../../persistence/Services/ProjectionThreadSessions.ts";
import {
  type ProjectionTurn,
  type ProjectionTurnById,
  ProjectionTurnRepository,
} from "../../persistence/Services/ProjectionTurns.ts";
import { ProjectionThreadRepository } from "../../persistence/Services/ProjectionThreads.ts";
import { ProjectionPendingApprovalRepositoryLive } from "../../persistence/Layers/ProjectionPendingApprovals.ts";
import { ProjectionProjectRepositoryLive } from "../../persistence/Layers/ProjectionProjects.ts";
import { ProjectionStateRepositoryLive } from "../../persistence/Layers/ProjectionState.ts";
import { ProjectionThreadActivityRepositoryLive } from "../../persistence/Layers/ProjectionThreadActivities.ts";
import { ProjectionThreadMessageRepositoryLive } from "../../persistence/Layers/ProjectionThreadMessages.ts";
import { ProjectionThreadProposedPlanRepositoryLive } from "../../persistence/Layers/ProjectionThreadProposedPlans.ts";
import { ProjectionThreadSessionRepositoryLive } from "../../persistence/Layers/ProjectionThreadSessions.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { ProjectionThreadRepositoryLive } from "../../persistence/Layers/ProjectionThreads.ts";
import { ServerConfig } from "../../config.ts";
import {
  OrchestrationProjectionPipeline,
  type OrchestrationProjectionPipelineShape,
} from "../Services/ProjectionPipeline.ts";
import {
  attachmentRelativePath,
  parseAttachmentIdFromRelativePath,
  parseThreadSegmentFromAttachmentId,
  toSafeThreadAttachmentSegment,
} from "../../attachmentStore.ts";

export const ORCHESTRATION_PROJECTOR_NAMES = {
  projects: "projection.projects",
  threads: "projection.threads",
  threadMessages: "projection.thread-messages",
  threadProposedPlans: "projection.thread-proposed-plans",
  threadActivities: "projection.thread-activities",
  threadSessions: "projection.thread-sessions",
  threadTurns: "projection.thread-turns",
  checkpoints: "projection.checkpoints",
  pendingApprovals: "projection.pending-approvals",
} as const;

type ProjectorName =
  (typeof ORCHESTRATION_PROJECTOR_NAMES)[keyof typeof ORCHESTRATION_PROJECTOR_NAMES];

interface ProjectorDefinition {
  readonly name: ProjectorName;
  readonly apply: (
    event: OrchestrationEvent,
    attachmentSideEffects: AttachmentSideEffects,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

interface AttachmentSideEffects {
  readonly deletedThreadIds: Set<string>;
  readonly prunedThreadRelativePaths: Map<string, Set<string>>;
}

const materializeAttachmentsForProjection = Effect.fn("materializeAttachmentsForProjection")(
  (input: { readonly attachments: ReadonlyArray<ChatAttachment> }) =>
    Effect.succeed(input.attachments.length === 0 ? [] : input.attachments),
);

function extractActivityRequestId(payload: unknown): ApprovalRequestId | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const requestId = (payload as Record<string, unknown>).requestId;
  return typeof requestId === "string" ? ApprovalRequestId.make(requestId) : null;
}

function isStalePendingApprovalFailureDetail(detail: string | null): boolean {
  if (detail === null) {
    return false;
  }
  return (
    detail.includes("stale pending approval request") ||
    detail.includes("unknown pending approval request") ||
    detail.includes("unknown pending permission request")
  );
}

function isStreamingAssistantMessageEvent(event: OrchestrationEvent): boolean {
  return (
    event.type === "thread.message-sent" &&
    event.payload.role === "assistant" &&
    event.payload.streaming
  );
}

function completedAtForTerminalTurn(turn: ProjectionTurnById | undefined): string | null {
  if (turn === undefined || !isTerminalTurnState(turn.state)) {
    return null;
  }
  return turn.completedAt;
}

function maxIso(left: string | null, right: string): string {
  return left !== null && left > right ? left : right;
}

function isTerminalTurnState(
  state: ProjectionTurn["state"],
): state is Extract<ProjectionTurn["state"], "completed" | "error" | "interrupted"> {
  return state === "completed" || state === "error" || state === "interrupted";
}

function terminalSessionStatusForTurnState(
  state: Extract<ProjectionTurn["state"], "completed" | "error" | "interrupted">,
) {
  return state === "completed" ? "ready" : state;
}

function terminalSessionStatusForCheckpointStatus(status: "ready" | "missing" | "error") {
  if (status === "ready") {
    return "ready" as const;
  }
  if (status === "error") {
    return "error" as const;
  }
  return "interrupted" as const;
}

function shouldPromoteLatestTurnFromSessionSet(input: {
  readonly currentLatestTurn: Option.Option<ProjectionTurnById>;
  readonly candidateActiveTurn: Option.Option<ProjectionTurnById>;
  readonly candidateActiveTurnId: string;
  readonly sessionUpdatedAt: string;
}): boolean {
  return shouldPromoteLatestTurn({
    currentLatestTurn: input.currentLatestTurn,
    candidateTurn: input.candidateActiveTurn,
    candidateTurnId: input.candidateActiveTurnId,
    candidateObservedAt: input.sessionUpdatedAt,
  });
}

function shouldPromoteLatestTurn(input: {
  readonly currentLatestTurn: Option.Option<ProjectionTurnById>;
  readonly candidateTurn: Option.Option<ProjectionTurnById>;
  readonly candidateTurnId: string;
  readonly candidateObservedAt: string;
}): boolean {
  if (Option.isNone(input.currentLatestTurn)) {
    return true;
  }

  if (input.currentLatestTurn.value.turnId === input.candidateTurnId) {
    return true;
  }

  const candidateRequestedAt = Option.isSome(input.candidateTurn)
    ? input.candidateTurn.value.requestedAt
    : input.candidateObservedAt;

  // Provider session snapshots can arrive after a newer turn has already been
  // projected, especially during daemon handoff or backfill. The same is true
  // for checkpoint/diff reconciliation emitted after restart. A stale provider
  // event must not move the thread shell back to an older active/completed turn,
  // because that makes the renderer offer steer/interrupt or latency diagnostics
  // for a turn the provider no longer owns.
  return input.currentLatestTurn.value.requestedAt <= candidateRequestedAt;
}

function extendCompletedTurnAt(turn: ProjectionTurnById, observedAt: string): ProjectionTurnById {
  if (!isTerminalTurnState(turn.state)) {
    return turn;
  }
  return {
    ...turn,
    completedAt: maxIso(turn.completedAt, observedAt),
  };
}

function doesActivityAffectThreadShellSummary(
  activity: Extract<OrchestrationEvent, { readonly type: "thread.activity-appended" }>,
): boolean {
  switch (activity.payload.activity.kind) {
    case "approval.requested":
    case "approval.resolved":
    case "provider.approval.respond.failed":
    case "user-input.requested":
    case "user-input.resolved":
    case "provider.user-input.respond.failed":
      return true;
    default:
      return false;
  }
}

function retainProjectionMessagesAfterRevert(
  messages: ReadonlyArray<ProjectionThreadMessage>,
  turns: ReadonlyArray<ProjectionTurn>,
  turnCount: number,
): ReadonlyArray<ProjectionThreadMessage> {
  const retainedMessageIds = new Set<string>();
  const retainedTurnIds = new Set<string>();
  const keptTurns = turns.filter(
    (turn) =>
      turn.turnId !== null &&
      turn.checkpointTurnCount !== null &&
      turn.checkpointTurnCount <= turnCount,
  );
  for (const turn of keptTurns) {
    if (turn.turnId !== null) {
      retainedTurnIds.add(turn.turnId);
    }
    if (turn.pendingMessageId !== null) {
      retainedMessageIds.add(turn.pendingMessageId);
    }
    if (turn.assistantMessageId !== null) {
      retainedMessageIds.add(turn.assistantMessageId);
    }
  }

  for (const message of messages) {
    if (message.role === "system") {
      retainedMessageIds.add(message.messageId);
      continue;
    }
    if (message.turnId !== null && retainedTurnIds.has(message.turnId)) {
      retainedMessageIds.add(message.messageId);
    }
  }

  const retainedUserCount = messages.filter(
    (message) => message.role === "user" && retainedMessageIds.has(message.messageId),
  ).length;
  const missingUserCount = Math.max(0, turnCount - retainedUserCount);
  if (missingUserCount > 0) {
    const fallbackUserMessages = messages
      .filter(
        (message) =>
          message.role === "user" &&
          !retainedMessageIds.has(message.messageId) &&
          (message.turnId === null || retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.messageId.localeCompare(right.messageId),
      )
      .slice(0, missingUserCount);
    for (const message of fallbackUserMessages) {
      retainedMessageIds.add(message.messageId);
    }
  }

  const retainedAssistantCount = messages.filter(
    (message) => message.role === "assistant" && retainedMessageIds.has(message.messageId),
  ).length;
  const missingAssistantCount = Math.max(0, turnCount - retainedAssistantCount);
  if (missingAssistantCount > 0) {
    const fallbackAssistantMessages = messages
      .filter(
        (message) =>
          message.role === "assistant" &&
          !retainedMessageIds.has(message.messageId) &&
          (message.turnId === null || retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.messageId.localeCompare(right.messageId),
      )
      .slice(0, missingAssistantCount);
    for (const message of fallbackAssistantMessages) {
      retainedMessageIds.add(message.messageId);
    }
  }

  return messages.filter((message) => retainedMessageIds.has(message.messageId));
}

function retainProjectionActivitiesAfterRevert(
  activities: ReadonlyArray<ProjectionThreadActivity>,
  turns: ReadonlyArray<ProjectionTurn>,
  turnCount: number,
): ReadonlyArray<ProjectionThreadActivity> {
  const retainedTurnIds = new Set<string>(
    turns
      .filter(
        (turn) =>
          turn.turnId !== null &&
          turn.checkpointTurnCount !== null &&
          turn.checkpointTurnCount <= turnCount,
      )
      .flatMap((turn) => (turn.turnId === null ? [] : [turn.turnId])),
  );
  return activities.filter(
    (activity) => activity.turnId === null || retainedTurnIds.has(activity.turnId),
  );
}

function retainProjectionProposedPlansAfterRevert(
  proposedPlans: ReadonlyArray<ProjectionThreadProposedPlan>,
  turns: ReadonlyArray<ProjectionTurn>,
  turnCount: number,
): ReadonlyArray<ProjectionThreadProposedPlan> {
  const retainedTurnIds = new Set<string>(
    turns
      .filter(
        (turn) =>
          turn.turnId !== null &&
          turn.checkpointTurnCount !== null &&
          turn.checkpointTurnCount <= turnCount,
      )
      .flatMap((turn) => (turn.turnId === null ? [] : [turn.turnId])),
  );
  return proposedPlans.filter(
    (proposedPlan) => proposedPlan.turnId === null || retainedTurnIds.has(proposedPlan.turnId),
  );
}

function collectThreadAttachmentRelativePaths(
  threadId: string,
  messages: ReadonlyArray<ProjectionThreadMessage>,
): Set<string> {
  const threadSegment = toSafeThreadAttachmentSegment(threadId);
  if (!threadSegment) {
    return new Set();
  }
  const relativePaths = new Set<string>();
  for (const message of messages) {
    for (const attachment of message.attachments ?? []) {
      if (attachment.type !== "image") {
        continue;
      }
      const attachmentThreadSegment = parseThreadSegmentFromAttachmentId(attachment.id);
      if (!attachmentThreadSegment || attachmentThreadSegment !== threadSegment) {
        continue;
      }
      relativePaths.add(attachmentRelativePath(attachment));
    }
  }
  return relativePaths;
}

const runAttachmentSideEffects = Effect.fn("runAttachmentSideEffects")(function* (
  sideEffects: AttachmentSideEffects,
) {
  const serverConfig = yield* Effect.service(ServerConfig);
  const fileSystem = yield* Effect.service(FileSystem.FileSystem);
  const path = yield* Effect.service(Path.Path);

  const attachmentsRootDir = serverConfig.attachmentsDir;
  const readAttachmentRootEntries = fileSystem
    .readDirectory(attachmentsRootDir, { recursive: false })
    .pipe(Effect.catch(() => Effect.succeed([] as Array<string>)));

  const removeDeletedThreadAttachmentEntry = Effect.fn("removeDeletedThreadAttachmentEntry")(
    function* (threadSegment: string, entry: string) {
      const normalizedEntry = entry.replace(/^[/\\]+/, "").replace(/\\/g, "/");
      if (normalizedEntry.length === 0 || normalizedEntry.includes("/")) {
        return;
      }
      const attachmentId = parseAttachmentIdFromRelativePath(normalizedEntry);
      if (!attachmentId) {
        return;
      }
      const attachmentThreadSegment = parseThreadSegmentFromAttachmentId(attachmentId);
      if (!attachmentThreadSegment || attachmentThreadSegment !== threadSegment) {
        return;
      }
      yield* fileSystem.remove(path.join(attachmentsRootDir, normalizedEntry), {
        force: true,
      });
    },
  );

  const deleteThreadAttachments = Effect.fn("deleteThreadAttachments")(function* (
    threadId: string,
  ) {
    const threadSegment = toSafeThreadAttachmentSegment(threadId);
    if (!threadSegment) {
      yield* Effect.logWarning("skipping attachment cleanup for unsafe thread id", {
        threadId,
      });
      return;
    }

    const entries = yield* readAttachmentRootEntries;
    yield* Effect.forEach(
      entries,
      (entry) => removeDeletedThreadAttachmentEntry(threadSegment, entry),
      {
        concurrency: 1,
      },
    );
  });

  const pruneThreadAttachmentEntry = Effect.fn("pruneThreadAttachmentEntry")(function* (
    threadSegment: string,
    keptThreadRelativePaths: Set<string>,
    entry: string,
  ) {
    const relativePath = entry.replace(/^[/\\]+/, "").replace(/\\/g, "/");
    if (relativePath.length === 0 || relativePath.includes("/")) {
      return;
    }
    const attachmentId = parseAttachmentIdFromRelativePath(relativePath);
    if (!attachmentId) {
      return;
    }
    const attachmentThreadSegment = parseThreadSegmentFromAttachmentId(attachmentId);
    if (!attachmentThreadSegment || attachmentThreadSegment !== threadSegment) {
      return;
    }

    const absolutePath = path.join(attachmentsRootDir, relativePath);
    const fileInfo = yield* fileSystem
      .stat(absolutePath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!fileInfo || fileInfo.type !== "File") {
      return;
    }

    if (!keptThreadRelativePaths.has(relativePath)) {
      yield* fileSystem.remove(absolutePath, { force: true });
    }
  });

  const pruneThreadAttachments = Effect.fn("pruneThreadAttachments")(function* (
    threadId: string,
    keptThreadRelativePaths: Set<string>,
  ) {
    if (sideEffects.deletedThreadIds.has(threadId)) {
      return;
    }

    const threadSegment = toSafeThreadAttachmentSegment(threadId);
    if (!threadSegment) {
      yield* Effect.logWarning("skipping attachment prune for unsafe thread id", { threadId });
      return;
    }

    const entries = yield* readAttachmentRootEntries;
    yield* Effect.forEach(
      entries,
      (entry) => pruneThreadAttachmentEntry(threadSegment, keptThreadRelativePaths, entry),
      { concurrency: 1 },
    );
  });

  yield* Effect.forEach(sideEffects.deletedThreadIds, deleteThreadAttachments, {
    concurrency: 1,
  });

  yield* Effect.forEach(
    sideEffects.prunedThreadRelativePaths.entries(),
    ([threadId, keptThreadRelativePaths]) =>
      pruneThreadAttachments(threadId, keptThreadRelativePaths),
    { concurrency: 1 },
  );
});

const makeOrchestrationProjectionPipeline = Effect.fn("makeOrchestrationProjectionPipeline")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    const eventStore = yield* OrchestrationEventStore;
    const projectionStateRepository = yield* ProjectionStateRepository;
    const projectionProjectRepository = yield* ProjectionProjectRepository;
    const projectionThreadRepository = yield* ProjectionThreadRepository;
    const projectionThreadMessageRepository = yield* ProjectionThreadMessageRepository;
    const projectionThreadProposedPlanRepository = yield* ProjectionThreadProposedPlanRepository;
    const projectionThreadActivityRepository = yield* ProjectionThreadActivityRepository;
    const projectionThreadSessionRepository = yield* ProjectionThreadSessionRepository;
    const projectionTurnRepository = yield* ProjectionTurnRepository;
    const projectionPendingApprovalRepository = yield* ProjectionPendingApprovalRepository;

    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const serverConfig = yield* ServerConfig;

    const copyThreadContextProjectionRows = Effect.fn(
      "ProjectionPipeline.copyThreadContextProjectionRows",
    )(function* (input: {
      readonly sourceThreadId: ThreadId;
      readonly targetThreadId: ThreadId;
      readonly duplicatedAt: string;
    }) {
      const copyPrefix = `copy:${input.targetThreadId}:`;

      // A duplicated thread is a Cafe read-model fork, not a provider-runtime
      // fork. Keep historical message/turn/plan/work-log context in bulk SQL,
      // but do not copy sessions, pending approvals, or pending user-input
      // accounting that would make the target look like live provider work.
      yield* sql`
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
        SELECT
          ${copyPrefix} || message_id,
          ${input.targetThreadId},
          CASE
            WHEN turn_id IS NULL THEN NULL
            ELSE ${copyPrefix} || turn_id
          END,
          role,
          text,
          attachments_json,
          0,
          created_at,
          CASE
            WHEN is_streaming = 1 AND updated_at < ${input.duplicatedAt}
            THEN ${input.duplicatedAt}
            ELSE updated_at
          END
        FROM projection_thread_messages
        WHERE thread_id = ${input.sourceThreadId}
        ON CONFLICT (thread_id, message_id) DO NOTHING
      `;

      yield* sql`
        INSERT INTO projection_thread_proposed_plans (
          plan_id,
          thread_id,
          turn_id,
          plan_markdown,
          created_at,
          updated_at,
          implemented_at,
          implementation_thread_id
        )
        SELECT
          ${copyPrefix} || plan_id,
          ${input.targetThreadId},
          CASE
            WHEN turn_id IS NULL THEN NULL
            ELSE ${copyPrefix} || turn_id
          END,
          plan_markdown,
          created_at,
          updated_at,
          implemented_at,
          CASE
            WHEN implementation_thread_id = ${input.sourceThreadId}
            THEN ${input.targetThreadId}
            ELSE implementation_thread_id
          END
        FROM projection_thread_proposed_plans
        WHERE thread_id = ${input.sourceThreadId}
        ON CONFLICT (plan_id) DO NOTHING
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        SELECT
          ${input.targetThreadId},
          ${copyPrefix} || turn_id,
          CASE
            WHEN pending_message_id IS NULL THEN NULL
            ELSE ${copyPrefix} || pending_message_id
          END,
          CASE
            WHEN source_proposed_plan_thread_id = ${input.sourceThreadId}
            THEN ${input.targetThreadId}
            ELSE source_proposed_plan_thread_id
          END,
          CASE
            WHEN source_proposed_plan_thread_id = ${input.sourceThreadId}
              AND source_proposed_plan_id IS NOT NULL
            THEN ${copyPrefix} || source_proposed_plan_id
            ELSE source_proposed_plan_id
          END,
          CASE
            WHEN assistant_message_id IS NULL THEN NULL
            ELSE ${copyPrefix} || assistant_message_id
          END,
          CASE
            WHEN state IN ('pending', 'running') THEN 'interrupted'
            ELSE state
          END,
          requested_at,
          CASE
            WHEN state IN ('pending', 'running') AND started_at IS NULL
            THEN requested_at
            ELSE started_at
          END,
          CASE
            WHEN state IN ('pending', 'running') AND completed_at IS NULL
            THEN ${input.duplicatedAt}
            ELSE completed_at
          END,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        FROM projection_turns
        WHERE thread_id = ${input.sourceThreadId}
          AND turn_id IS NOT NULL
        ON CONFLICT (thread_id, turn_id) DO NOTHING
      `;

      yield* sql`
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
        SELECT
          ${copyPrefix} || activity_id,
          ${input.targetThreadId},
          CASE
            WHEN turn_id IS NULL THEN NULL
            ELSE ${copyPrefix} || turn_id
          END,
          tone,
          kind,
          summary,
          payload_json,
          sequence,
          created_at
        FROM projection_thread_activities
        WHERE thread_id = ${input.sourceThreadId}
          AND kind NOT IN ('user-input.requested')
        ON CONFLICT (activity_id) DO NOTHING
      `;

      yield* sql`
        UPDATE projection_threads
        SET
          latest_turn_id = (
            SELECT CASE
              WHEN source.latest_turn_id IS NULL THEN NULL
              ELSE ${copyPrefix} || source.latest_turn_id
            END
            FROM projection_threads source
            WHERE source.thread_id = ${input.sourceThreadId}
          ),
          latest_user_message_at = (
            SELECT latest_user_message_at
            FROM projection_threads source
            WHERE source.thread_id = ${input.sourceThreadId}
          ),
          pending_approval_count = 0,
          pending_user_input_count = 0,
          has_actionable_proposed_plan = COALESCE((
            SELECT has_actionable_proposed_plan
            FROM projection_threads source
            WHERE source.thread_id = ${input.sourceThreadId}
          ), 0),
          updated_at = ${input.duplicatedAt}
        WHERE thread_id = ${input.targetThreadId}
      `;
    });

    const applyProjectsProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyProjectsProjection",
    )(function* (event, _attachmentSideEffects) {
      switch (event.type) {
        case "project.created":
          yield* projectionProjectRepository.upsert({
            projectId: event.payload.projectId,
            title: event.payload.title,
            workspaceRoot: event.payload.workspaceRoot,
            additionalWorkspaceRoots: event.payload.additionalWorkspaceRoots ?? [],
            defaultModelSelection: event.payload.defaultModelSelection,
            scripts: event.payload.scripts,
            createdAt: event.payload.createdAt,
            updatedAt: event.payload.updatedAt,
            deletedAt: null,
          });
          return;

        case "project.meta-updated": {
          const existingRow = yield* projectionProjectRepository.getById({
            projectId: event.payload.projectId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionProjectRepository.upsert({
            ...existingRow.value,
            ...(event.payload.title !== undefined ? { title: event.payload.title } : {}),
            ...(event.payload.workspaceRoot !== undefined
              ? { workspaceRoot: event.payload.workspaceRoot }
              : {}),
            ...(event.payload.additionalWorkspaceRoots !== undefined
              ? { additionalWorkspaceRoots: event.payload.additionalWorkspaceRoots }
              : {}),
            ...(event.payload.defaultModelSelection !== undefined
              ? { defaultModelSelection: event.payload.defaultModelSelection }
              : {}),
            ...(event.payload.scripts !== undefined ? { scripts: event.payload.scripts } : {}),
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "project.deleted": {
          const existingRow = yield* projectionProjectRepository.getById({
            projectId: event.payload.projectId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionProjectRepository.upsert({
            ...existingRow.value,
            deletedAt: event.payload.deletedAt,
            updatedAt: event.payload.deletedAt,
          });
          return;
        }

        default:
          return;
      }
    });

    const refreshThreadShellSummary = Effect.fn("refreshThreadShellSummary")(function* (
      threadId: ThreadId,
    ) {
      const existingRow = yield* projectionThreadRepository.getById({
        threadId,
      });
      if (Option.isNone(existingRow)) {
        return;
      }

      const [
        latestUserMessageAt,
        latestPlanForTurn,
        latestPlan,
        pendingUserInputCount,
        pendingApprovalCount,
      ] = yield* Effect.all([
        projectionThreadMessageRepository.getLatestUserMessageAtByThreadId({ threadId }),
        existingRow.value.latestTurnId === null
          ? Effect.succeed(Option.none<ProjectionThreadProposedPlan>())
          : projectionThreadProposedPlanRepository.getLatestByThreadId({
              threadId,
              turnId: existingRow.value.latestTurnId,
            }),
        projectionThreadProposedPlanRepository.getLatestByThreadId({ threadId }),
        projectionThreadActivityRepository.countPendingUserInputByThreadId({ threadId }),
        projectionPendingApprovalRepository.countPendingByThreadId({ threadId }),
      ]);

      const selectedPlan = Option.isSome(latestPlanForTurn) ? latestPlanForTurn : latestPlan;
      const hasActionableProposedPlan =
        Option.isSome(selectedPlan) && selectedPlan.value.implementedAt === null;

      yield* projectionThreadRepository.upsert({
        ...existingRow.value,
        latestUserMessageAt: Option.getOrNull(latestUserMessageAt),
        pendingApprovalCount,
        pendingUserInputCount,
        hasActionableProposedPlan: hasActionableProposedPlan ? 1 : 0,
      });
    });

    const applyThreadsProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyThreadsProjection",
    )(function* (event, attachmentSideEffects) {
      switch (event.type) {
        case "thread.created":
          yield* projectionThreadRepository.upsert({
            threadId: event.payload.threadId,
            projectId: event.payload.projectId,
            title: event.payload.title,
            modelSelection: event.payload.modelSelection,
            runtimeMode: event.payload.runtimeMode,
            interactionMode: event.payload.interactionMode,
            branch: event.payload.branch,
            worktreePath: event.payload.worktreePath,
            latestTurnId: null,
            createdAt: event.payload.createdAt,
            updatedAt: event.payload.updatedAt,
            archivedAt: null,
            latestUserMessageAt: null,
            pendingApprovalCount: 0,
            pendingUserInputCount: 0,
            hasActionableProposedPlan: 0,
            deletedAt: null,
          });
          return;

        case "thread.duplicated":
          yield* copyThreadContextProjectionRows({
            sourceThreadId: event.payload.sourceThreadId,
            targetThreadId: event.payload.targetThreadId,
            duplicatedAt: event.payload.duplicatedAt,
          }).pipe(
            Effect.mapError(
              toPersistenceSqlError("ProjectionPipeline.copyThreadContextProjectionRows:query"),
            ),
          );
          yield* refreshThreadShellSummary(event.payload.targetThreadId);
          return;

        case "thread.archived": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            archivedAt: event.payload.archivedAt,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.unarchived": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            archivedAt: null,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.meta-updated": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            ...(event.payload.projectId !== undefined
              ? { projectId: event.payload.projectId }
              : {}),
            ...(event.payload.title !== undefined ? { title: event.payload.title } : {}),
            ...(event.payload.modelSelection !== undefined
              ? { modelSelection: event.payload.modelSelection }
              : {}),
            ...(event.payload.branch !== undefined ? { branch: event.payload.branch } : {}),
            ...(event.payload.worktreePath !== undefined
              ? { worktreePath: event.payload.worktreePath }
              : {}),
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.runtime-mode-set": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            runtimeMode: event.payload.runtimeMode,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.interaction-mode-set": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            interactionMode: event.payload.interactionMode,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.turn-start-requested": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            ...(event.payload.modelSelection !== undefined
              ? { modelSelection: event.payload.modelSelection }
              : {}),
            runtimeMode: event.payload.runtimeMode,
            interactionMode: event.payload.interactionMode,
            updatedAt: maxIso(existingRow.value.updatedAt, event.payload.createdAt),
          });
          return;
        }

        case "thread.deleted": {
          attachmentSideEffects.deletedThreadIds.add(event.payload.threadId);
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            deletedAt: event.payload.deletedAt,
            updatedAt: event.payload.deletedAt,
          });
          return;
        }

        case "thread.restored": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            deletedAt: null,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.message-sent": {
          if (isStreamingAssistantMessageEvent(event)) {
            return;
          }
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            updatedAt: maxIso(existingRow.value.updatedAt, event.occurredAt),
          });
          if (event.payload.role === "user") {
            yield* refreshThreadShellSummary(event.payload.threadId);
          }
          return;
        }

        case "thread.proposed-plan-upserted":
        case "thread.approval-response-requested":
        case "thread.user-input-response-requested": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            updatedAt: maxIso(existingRow.value.updatedAt, event.occurredAt),
          });
          yield* refreshThreadShellSummary(event.payload.threadId);
          return;
        }

        case "thread.activity-appended": {
          if (!doesActivityAffectThreadShellSummary(event)) {
            return;
          }
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            updatedAt: maxIso(existingRow.value.updatedAt, event.occurredAt),
          });
          yield* refreshThreadShellSummary(event.payload.threadId);
          return;
        }

        case "thread.session-set": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          const activeTurnId = event.payload.session.activeTurnId;
          const candidateActiveTurn =
            activeTurnId === null
              ? Option.none<ProjectionTurnById>()
              : yield* projectionTurnRepository.getByTurnId({
                  threadId: event.payload.threadId,
                  turnId: activeTurnId,
                });
          const currentLatestTurn =
            existingRow.value.latestTurnId === null
              ? Option.none<ProjectionTurnById>()
              : yield* projectionTurnRepository.getByTurnId({
                  threadId: event.payload.threadId,
                  turnId: existingRow.value.latestTurnId,
                });
          const latestTurnId =
            activeTurnId !== null &&
            shouldPromoteLatestTurnFromSessionSet({
              currentLatestTurn,
              candidateActiveTurn,
              candidateActiveTurnId: activeTurnId,
              sessionUpdatedAt: event.payload.session.updatedAt,
            })
              ? activeTurnId
              : existingRow.value.latestTurnId;
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            latestTurnId,
            updatedAt: maxIso(existingRow.value.updatedAt, event.occurredAt),
          });
          yield* refreshThreadShellSummary(event.payload.threadId);
          return;
        }

        case "thread.turn-diff-completed": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          const currentLatestTurn =
            existingRow.value.latestTurnId === null
              ? Option.none<ProjectionTurnById>()
              : yield* projectionTurnRepository.getByTurnId({
                  threadId: event.payload.threadId,
                  turnId: existingRow.value.latestTurnId,
                });
          const candidateTurn = yield* projectionTurnRepository.getByTurnId({
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
          });
          const latestTurnId = shouldPromoteLatestTurn({
            currentLatestTurn,
            candidateTurn,
            candidateTurnId: event.payload.turnId,
            candidateObservedAt: event.payload.completedAt,
          })
            ? event.payload.turnId
            : existingRow.value.latestTurnId;
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            latestTurnId,
            updatedAt: maxIso(existingRow.value.updatedAt, event.occurredAt),
          });
          yield* refreshThreadShellSummary(event.payload.threadId);
          return;
        }

        case "thread.reverted": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }

          const retainedTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          let latestTurnId: ProjectionTurn["turnId"] = null;
          let latestCheckpointTurnCount = -1;
          for (let index = 0; index < retainedTurns.length; index += 1) {
            const turn = retainedTurns[index];
            if (
              !turn ||
              turn.turnId === null ||
              turn.checkpointTurnCount === null ||
              turn.checkpointTurnCount > event.payload.turnCount
            ) {
              continue;
            }
            if (turn.checkpointTurnCount > latestCheckpointTurnCount) {
              latestCheckpointTurnCount = turn.checkpointTurnCount;
              latestTurnId = turn.turnId;
            }
          }

          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            latestTurnId,
            updatedAt: event.occurredAt,
          });
          yield* refreshThreadShellSummary(event.payload.threadId);
          return;
        }

        default:
          return;
      }
    });

    const closeStreamingMessagesForTerminalTurn = Effect.fn(
      "ProjectionPipeline.closeStreamingMessagesForTerminalTurn",
    )(function* (input: {
      readonly threadId: ThreadId;
      readonly turnId: TurnId;
      readonly updatedAt: string;
    }) {
      // Codex and other providers can terminate a turn through interruption,
      // error, or checkpoint completion without emitting a non-streaming
      // replacement for every partial assistant message. Closing all streaming
      // assistant rows for the terminal turn keeps renderer "working" state
      // bound to provider truth instead of stale per-message flags.
      yield* projectionThreadMessageRepository.closeStreamingByTurnId(input);
    });

    const applyThreadMessagesProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyThreadMessagesProjection",
    )(function* (event, attachmentSideEffects) {
      switch (event.type) {
        case "thread.message-sent": {
          const existingMessage = yield* projectionThreadMessageRepository.getByThreadAndMessageId({
            threadId: event.payload.threadId,
            messageId: event.payload.messageId,
          });
          const previousMessage = Option.getOrUndefined(existingMessage);
          const eventTurn =
            event.payload.turnId === null
              ? Option.none<ProjectionTurnById>()
              : yield* projectionTurnRepository.getByTurnId({
                  threadId: event.payload.threadId,
                  turnId: event.payload.turnId,
                });
          const terminalTurnCompletedAt = completedAtForTerminalTurn(
            Option.getOrUndefined(eventTurn),
          );
          const streamingReplayForTerminalTurn =
            event.payload.streaming && terminalTurnCompletedAt !== null;
          const shouldKeepCompletedMessageText =
            streamingReplayForTerminalTurn &&
            previousMessage !== undefined &&
            !previousMessage.isStreaming &&
            previousMessage.text.length > 0;
          const nextText = Option.match(existingMessage, {
            onNone: () => event.payload.text,
            onSome: (message) => {
              if (shouldKeepCompletedMessageText) {
                return message.text;
              }
              if (event.payload.streaming) {
                return `${message.text}${event.payload.text}`;
              }
              if (event.payload.text.length === 0) {
                return message.text;
              }
              return event.payload.text;
            },
          });
          const nextAttachments =
            event.payload.attachments !== undefined
              ? yield* materializeAttachmentsForProjection({
                  attachments: event.payload.attachments,
                })
              : previousMessage?.attachments;
          yield* projectionThreadMessageRepository.upsert({
            messageId: event.payload.messageId,
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
            role: event.payload.role,
            text: nextText,
            ...(nextAttachments !== undefined ? { attachments: [...nextAttachments] } : {}),
            // App-server replay/backfill can deliver old streaming deltas after
            // Cafe has already projected the provider turn as terminal. Preserve
            // snapshot-only text when useful, but never let those reconciliation
            // events reopen renderer streaming/work indicators for a completed
            // turn; the CLI's terminal lifecycle is authoritative here.
            isStreaming: event.payload.streaming && terminalTurnCompletedAt === null,
            createdAt: previousMessage?.createdAt ?? event.payload.createdAt,
            updatedAt:
              terminalTurnCompletedAt === null
                ? maxIso(previousMessage?.updatedAt ?? null, event.payload.updatedAt)
                : maxIso(
                    maxIso(previousMessage?.updatedAt ?? null, event.payload.updatedAt),
                    terminalTurnCompletedAt,
                  ),
          });
          return;
        }

        case "thread.turn-interrupt-requested": {
          const existingSession = yield* projectionThreadSessionRepository.getByThreadId({
            threadId: event.payload.threadId,
          });
          const terminalTurnId =
            event.payload.turnId ??
            (Option.isSome(existingSession) ? existingSession.value.activeTurnId : null);
          if (terminalTurnId === null || terminalTurnId === undefined) {
            return;
          }
          yield* closeStreamingMessagesForTerminalTurn({
            threadId: event.payload.threadId,
            turnId: terminalTurnId,
            updatedAt: event.payload.createdAt,
          });
          return;
        }

        case "thread.turn-diff-completed": {
          if (event.payload.status === "missing") {
            return;
          }
          yield* closeStreamingMessagesForTerminalTurn({
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
            updatedAt: event.payload.completedAt,
          });
          return;
        }

        case "thread.session-set": {
          if (
            event.payload.session.activeTurnId !== null ||
            (event.payload.session.status !== "ready" &&
              event.payload.session.status !== "error" &&
              event.payload.session.status !== "interrupted" &&
              event.payload.session.status !== "stopped")
          ) {
            return;
          }
          const existingSession = yield* projectionThreadSessionRepository.getByThreadId({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingSession) || existingSession.value.activeTurnId === null) {
            return;
          }
          yield* closeStreamingMessagesForTerminalTurn({
            threadId: event.payload.threadId,
            turnId: existingSession.value.activeTurnId,
            updatedAt: event.payload.session.updatedAt,
          });
          return;
        }

        case "thread.reverted": {
          const existingRows = yield* projectionThreadMessageRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          if (existingRows.length === 0) {
            return;
          }

          const existingTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          const keptRows = retainProjectionMessagesAfterRevert(
            existingRows,
            existingTurns,
            event.payload.turnCount,
          );
          if (keptRows.length === existingRows.length) {
            return;
          }

          yield* projectionThreadMessageRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          yield* Effect.forEach(keptRows, projectionThreadMessageRepository.upsert, {
            concurrency: 1,
          }).pipe(Effect.asVoid);
          attachmentSideEffects.prunedThreadRelativePaths.set(
            event.payload.threadId,
            collectThreadAttachmentRelativePaths(event.payload.threadId, keptRows),
          );
          return;
        }

        default:
          return;
      }
    });

    const applyThreadProposedPlansProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyThreadProposedPlansProjection",
    )(function* (event, _attachmentSideEffects) {
      switch (event.type) {
        case "thread.proposed-plan-upserted":
          yield* projectionThreadProposedPlanRepository.upsert({
            planId: event.payload.proposedPlan.id,
            threadId: event.payload.threadId,
            turnId: event.payload.proposedPlan.turnId,
            planMarkdown: event.payload.proposedPlan.planMarkdown,
            implementedAt: event.payload.proposedPlan.implementedAt,
            implementationThreadId: event.payload.proposedPlan.implementationThreadId,
            createdAt: event.payload.proposedPlan.createdAt,
            updatedAt: event.payload.proposedPlan.updatedAt,
          });
          return;

        case "thread.reverted": {
          const existingRows = yield* projectionThreadProposedPlanRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          if (existingRows.length === 0) {
            return;
          }

          const existingTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          const keptRows = retainProjectionProposedPlansAfterRevert(
            existingRows,
            existingTurns,
            event.payload.turnCount,
          );
          if (keptRows.length === existingRows.length) {
            return;
          }

          yield* projectionThreadProposedPlanRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          yield* Effect.forEach(keptRows, projectionThreadProposedPlanRepository.upsert, {
            concurrency: 1,
          }).pipe(Effect.asVoid);
          return;
        }

        default:
          return;
      }
    });

    const applyThreadActivitiesProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyThreadActivitiesProjection",
    )(function* (event, _attachmentSideEffects) {
      switch (event.type) {
        case "thread.activity-appended":
          yield* projectionThreadActivityRepository.upsert({
            activityId: event.payload.activity.id,
            threadId: event.payload.threadId,
            turnId: event.payload.activity.turnId,
            tone: event.payload.activity.tone,
            kind: event.payload.activity.kind,
            summary: event.payload.activity.summary,
            payload: event.payload.activity.payload,
            ...(event.payload.activity.sequence !== undefined
              ? { sequence: event.payload.activity.sequence }
              : {}),
            createdAt: event.payload.activity.createdAt,
          });

          if (event.payload.activity.turnId !== null) {
            const existingTurn = yield* projectionTurnRepository.getByTurnId({
              threadId: event.payload.threadId,
              turnId: event.payload.activity.turnId,
            });
            if (Option.isSome(existingTurn) && isTerminalTurnState(existingTurn.value.state)) {
              yield* projectionTurnRepository.upsertByTurnId(
                extendCompletedTurnAt(existingTurn.value, event.payload.activity.createdAt),
              );
            }
          }
          return;

        case "thread.reverted": {
          const existingRows = yield* projectionThreadActivityRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          if (existingRows.length === 0) {
            return;
          }
          const existingTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          const keptRows = retainProjectionActivitiesAfterRevert(
            existingRows,
            existingTurns,
            event.payload.turnCount,
          );
          if (keptRows.length === existingRows.length) {
            return;
          }
          yield* projectionThreadActivityRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          yield* Effect.forEach(keptRows, projectionThreadActivityRepository.upsert, {
            concurrency: 1,
          }).pipe(Effect.asVoid);
          return;
        }

        default:
          return;
      }
    });

    const applyThreadSessionsProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyThreadSessionsProjection",
    )(function* (event, _attachmentSideEffects) {
      if (event.type === "thread.turn-start-requested") {
        const existingSession = yield* projectionThreadSessionRepository.getByThreadId({
          threadId: event.payload.threadId,
        });
        yield* projectionThreadSessionRepository.upsert({
          threadId: event.payload.threadId,
          status: "starting",
          providerName: Option.isSome(existingSession) ? existingSession.value.providerName : null,
          providerInstanceId: Option.isSome(existingSession)
            ? existingSession.value.providerInstanceId
            : null,
          runtimeMode: event.payload.runtimeMode,
          activeTurnId: null,
          lastError: null,
          updatedAt: Option.isSome(existingSession)
            ? maxIso(existingSession.value.updatedAt, event.payload.createdAt)
            : event.payload.createdAt,
        });
        return;
      }
      if (event.type === "thread.turn-interrupt-requested") {
        const existingSession = yield* projectionThreadSessionRepository.getByThreadId({
          threadId: event.payload.threadId,
        });
        if (Option.isNone(existingSession)) {
          return;
        }
        const interruptedTurnId = event.payload.turnId ?? existingSession.value.activeTurnId;
        if (interruptedTurnId === null || interruptedTurnId === undefined) {
          return;
        }
        if (
          existingSession.value.activeTurnId === null &&
          existingSession.value.status !== "starting" &&
          existingSession.value.status !== "running"
        ) {
          return;
        }
        if (
          existingSession.value.activeTurnId !== null &&
          existingSession.value.activeTurnId !== interruptedTurnId
        ) {
          return;
        }
        yield* projectionThreadSessionRepository.upsert({
          threadId: event.payload.threadId,
          status: "interrupted",
          providerName: existingSession.value.providerName,
          providerInstanceId: existingSession.value.providerInstanceId,
          runtimeMode: existingSession.value.runtimeMode,
          activeTurnId: null,
          lastError: existingSession.value.lastError,
          updatedAt: maxIso(existingSession.value.updatedAt, event.payload.createdAt),
        });
        return;
      }
      if (event.type === "thread.turn-diff-completed") {
        if (event.payload.status === "missing") {
          return;
        }
        const existingSession = yield* projectionThreadSessionRepository.getByThreadId({
          threadId: event.payload.threadId,
        });
        if (
          Option.isNone(existingSession) ||
          existingSession.value.activeTurnId !== event.payload.turnId
        ) {
          return;
        }
        const status = terminalSessionStatusForCheckpointStatus(event.payload.status);
        yield* projectionThreadSessionRepository.upsert({
          threadId: event.payload.threadId,
          status,
          providerName: existingSession.value.providerName,
          providerInstanceId: existingSession.value.providerInstanceId,
          runtimeMode: existingSession.value.runtimeMode,
          activeTurnId: null,
          lastError: status === "ready" ? null : existingSession.value.lastError,
          updatedAt: maxIso(existingSession.value.updatedAt, event.payload.completedAt),
        });
        return;
      }
      if (event.type !== "thread.session-set") {
        return;
      }
      const existingSession = yield* projectionThreadSessionRepository.getByThreadId({
        threadId: event.payload.threadId,
      });
      const runningActiveTurn =
        event.payload.session.status === "running" && event.payload.session.activeTurnId !== null
          ? yield* projectionTurnRepository.getByTurnId({
              threadId: event.payload.threadId,
              turnId: event.payload.session.activeTurnId,
            })
          : Option.none<ProjectionTurnById>();
      if (Option.isSome(runningActiveTurn) && isTerminalTurnState(runningActiveTurn.value.state)) {
        const status = terminalSessionStatusForTurnState(runningActiveTurn.value.state);
        yield* projectionThreadSessionRepository.upsert({
          threadId: event.payload.threadId,
          status,
          providerName: event.payload.session.providerName,
          providerInstanceId: event.payload.session.providerInstanceId ?? null,
          runtimeMode: event.payload.session.runtimeMode,
          activeTurnId: null,
          lastError: status === "ready" ? null : event.payload.session.lastError,
          updatedAt: maxIso(
            Option.isSome(existingSession)
              ? existingSession.value.updatedAt
              : event.payload.session.updatedAt,
            runningActiveTurn.value.completedAt !== null
              ? maxIso(event.payload.session.updatedAt, runningActiveTurn.value.completedAt)
              : event.payload.session.updatedAt,
          ),
        });
        return;
      }
      if (
        event.payload.session.activeTurnId === null &&
        (event.payload.session.status === "ready" ||
          event.payload.session.status === "error" ||
          event.payload.session.status === "interrupted" ||
          event.payload.session.status === "stopped") &&
        Option.isSome(existingSession) &&
        existingSession.value.activeTurnId !== null
      ) {
        const turnId = existingSession.value.activeTurnId;
        const existingTurn = yield* projectionTurnRepository.getByTurnId({
          threadId: event.payload.threadId,
          turnId,
        });
        const nextState =
          event.payload.session.status === "error"
            ? "error"
            : event.payload.session.status === "ready"
              ? "completed"
              : "interrupted";
        if (Option.isSome(existingTurn)) {
          yield* projectionTurnRepository.upsertByTurnId({
            ...existingTurn.value,
            state:
              existingTurn.value.state === "error" || existingTurn.value.state === "interrupted"
                ? existingTurn.value.state
                : nextState,
            completedAt: existingTurn.value.completedAt ?? event.payload.session.updatedAt,
            startedAt: existingTurn.value.startedAt ?? event.payload.session.updatedAt,
            requestedAt: existingTurn.value.requestedAt ?? event.payload.session.updatedAt,
          });
        } else {
          yield* projectionTurnRepository.upsertByTurnId({
            threadId: event.payload.threadId,
            turnId,
            pendingMessageId: null,
            sourceProposedPlanThreadId: null,
            sourceProposedPlanId: null,
            assistantMessageId: null,
            state: nextState,
            requestedAt: event.payload.session.updatedAt,
            startedAt: event.payload.session.updatedAt,
            completedAt: event.payload.session.updatedAt,
            checkpointTurnCount: null,
            checkpointRef: null,
            checkpointStatus: null,
            checkpointFiles: [],
          });
        }
      }

      if (
        event.payload.session.status === "running" &&
        event.payload.session.activeTurnId !== null
      ) {
        const existingRow = yield* projectionThreadRepository.getById({
          threadId: event.payload.threadId,
        });
        const activeTurn = runningActiveTurn;
        const latestTurn =
          Option.isSome(existingRow) && existingRow.value.latestTurnId !== null
            ? yield* projectionTurnRepository.getByTurnId({
                threadId: event.payload.threadId,
                turnId: existingRow.value.latestTurnId,
              })
            : Option.none<ProjectionTurnById>();
        if (
          Option.isSome(latestTurn) &&
          latestTurn.value.turnId !== event.payload.session.activeTurnId &&
          !shouldPromoteLatestTurnFromSessionSet({
            currentLatestTurn: latestTurn,
            candidateActiveTurn: activeTurn,
            candidateActiveTurnId: event.payload.session.activeTurnId,
            sessionUpdatedAt: event.payload.session.updatedAt,
          }) &&
          isTerminalTurnState(latestTurn.value.state)
        ) {
          const status = terminalSessionStatusForTurnState(latestTurn.value.state);
          yield* projectionThreadSessionRepository.upsert({
            threadId: event.payload.threadId,
            status,
            providerName: event.payload.session.providerName,
            providerInstanceId: event.payload.session.providerInstanceId ?? null,
            runtimeMode: event.payload.session.runtimeMode,
            activeTurnId: null,
            lastError: status === "ready" ? null : event.payload.session.lastError,
            updatedAt: maxIso(
              Option.isSome(existingSession)
                ? existingSession.value.updatedAt
                : event.payload.session.updatedAt,
              latestTurn.value.completedAt !== null
                ? maxIso(event.payload.session.updatedAt, latestTurn.value.completedAt)
                : event.payload.session.updatedAt,
            ),
          });
          return;
        }
      }

      if (
        event.payload.session.status === "running" &&
        event.payload.session.activeTurnId !== null &&
        Option.isSome(existingSession) &&
        existingSession.value.activeTurnId !== null &&
        existingSession.value.activeTurnId !== event.payload.session.activeTurnId
      ) {
        const previousActiveTurn = yield* projectionTurnRepository.getByTurnId({
          threadId: event.payload.threadId,
          turnId: existingSession.value.activeTurnId,
        });
        const shouldRetirePreviousActiveTurn =
          Option.isSome(previousActiveTurn) &&
          previousActiveTurn.value.state === "running" &&
          shouldPromoteLatestTurnFromSessionSet({
            currentLatestTurn: previousActiveTurn,
            candidateActiveTurn: runningActiveTurn,
            candidateActiveTurnId: event.payload.session.activeTurnId,
            sessionUpdatedAt: event.payload.session.updatedAt,
          });

        if (shouldRetirePreviousActiveTurn) {
          // A later concrete provider-owned turn is durable evidence that the
          // prior active turn id was only provisional or stale. Close it here so
          // renderer gates, interrupt targeting, and streaming markers follow
          // the same single-active-turn invariant as the Codex CLI/TUI.
          yield* projectionTurnRepository.upsertByTurnId({
            ...previousActiveTurn.value,
            state: "interrupted",
            completedAt: previousActiveTurn.value.completedAt ?? event.payload.session.updatedAt,
            startedAt: previousActiveTurn.value.startedAt ?? event.payload.session.updatedAt,
            requestedAt: previousActiveTurn.value.requestedAt ?? event.payload.session.updatedAt,
          });
          yield* projectionThreadMessageRepository.closeStreamingByTurnId({
            threadId: event.payload.threadId,
            turnId: existingSession.value.activeTurnId,
            updatedAt: event.payload.session.updatedAt,
          });
        }
      }

      yield* projectionThreadSessionRepository.upsert({
        threadId: event.payload.threadId,
        status: event.payload.session.status,
        providerName: event.payload.session.providerName,
        providerInstanceId: event.payload.session.providerInstanceId ?? null,
        runtimeMode: event.payload.session.runtimeMode,
        activeTurnId: event.payload.session.activeTurnId,
        lastError: event.payload.session.lastError,
        updatedAt: Option.isSome(existingSession)
          ? maxIso(existingSession.value.updatedAt, event.payload.session.updatedAt)
          : event.payload.session.updatedAt,
      });
    });

    const applyThreadTurnsProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyThreadTurnsProjection",
    )(function* (event, _attachmentSideEffects) {
      switch (event.type) {
        case "thread.turn-start-requested": {
          yield* projectionTurnRepository.replacePendingTurnStart({
            threadId: event.payload.threadId,
            messageId: event.payload.messageId,
            sourceProposedPlanThreadId: event.payload.sourceProposedPlan?.threadId ?? null,
            sourceProposedPlanId: event.payload.sourceProposedPlan?.planId ?? null,
            requestedAt: event.payload.createdAt,
          });
          return;
        }

        case "thread.session-set": {
          const turnId = event.payload.session.activeTurnId;
          if (
            turnId === null &&
            (event.payload.session.status === "ready" ||
              event.payload.session.status === "error" ||
              event.payload.session.status === "interrupted" ||
              event.payload.session.status === "stopped")
          ) {
            yield* projectionTurnRepository.deletePendingTurnStartByThreadId({
              threadId: event.payload.threadId,
            });
            return;
          }
          if (turnId === null || event.payload.session.status !== "running") {
            return;
          }

          const existingTurn = yield* projectionTurnRepository.getByTurnId({
            threadId: event.payload.threadId,
            turnId,
          });
          if (Option.isSome(existingTurn) && isTerminalTurnState(existingTurn.value.state)) {
            // Codex app-server can replay old `running` session snapshots after
            // a checkpoint has already made the same turn terminal, especially
            // during daemon replay/backfill. A provider-owned running turn must
            // use a fresh turn id; never let an old session snapshot reopen a
            // completed/interrupted/error turn or it will corrupt steering and
            // "still running" UI gates.
            return;
          }
          const pendingTurnStart = yield* projectionTurnRepository.getPendingTurnStartByThreadId({
            threadId: event.payload.threadId,
          });
          const turnStartedAt = event.payload.session.updatedAt;
          if (Option.isSome(existingTurn)) {
            const nextState =
              existingTurn.value.state === "error" || existingTurn.value.state === "interrupted"
                ? existingTurn.value.state
                : "running";
            yield* projectionTurnRepository.upsertByTurnId({
              ...existingTurn.value,
              state: nextState,
              completedAt: nextState === "running" ? null : existingTurn.value.completedAt,
              pendingMessageId:
                existingTurn.value.pendingMessageId ??
                (Option.isSome(pendingTurnStart) ? pendingTurnStart.value.messageId : null),
              sourceProposedPlanThreadId:
                existingTurn.value.sourceProposedPlanThreadId ??
                (Option.isSome(pendingTurnStart)
                  ? pendingTurnStart.value.sourceProposedPlanThreadId
                  : null),
              sourceProposedPlanId:
                existingTurn.value.sourceProposedPlanId ??
                (Option.isSome(pendingTurnStart)
                  ? pendingTurnStart.value.sourceProposedPlanId
                  : null),
              startedAt: existingTurn.value.startedAt ?? turnStartedAt,
              requestedAt:
                existingTurn.value.requestedAt ??
                (Option.isSome(pendingTurnStart)
                  ? pendingTurnStart.value.requestedAt
                  : turnStartedAt),
            });
          } else {
            yield* projectionTurnRepository.upsertByTurnId({
              turnId,
              threadId: event.payload.threadId,
              pendingMessageId: Option.isSome(pendingTurnStart)
                ? pendingTurnStart.value.messageId
                : null,
              sourceProposedPlanThreadId: Option.isSome(pendingTurnStart)
                ? pendingTurnStart.value.sourceProposedPlanThreadId
                : null,
              sourceProposedPlanId: Option.isSome(pendingTurnStart)
                ? pendingTurnStart.value.sourceProposedPlanId
                : null,
              assistantMessageId: null,
              state: "running",
              requestedAt: Option.isSome(pendingTurnStart)
                ? pendingTurnStart.value.requestedAt
                : turnStartedAt,
              startedAt: turnStartedAt,
              completedAt: null,
              checkpointTurnCount: null,
              checkpointRef: null,
              checkpointStatus: null,
              checkpointFiles: [],
            });
          }

          yield* projectionTurnRepository.deletePendingTurnStartByThreadId({
            threadId: event.payload.threadId,
          });
          return;
        }

        case "thread.message-sent": {
          if (event.payload.turnId === null || event.payload.role !== "assistant") {
            return;
          }
          const existingTurn = yield* projectionTurnRepository.getByTurnId({
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
          });
          if (Option.isSome(existingTurn)) {
            const nextState =
              existingTurn.value.state === "error" ||
              existingTurn.value.state === "interrupted" ||
              existingTurn.value.state === "completed"
                ? existingTurn.value.state
                : "running";
            yield* projectionTurnRepository.upsertByTurnId({
              ...existingTurn.value,
              assistantMessageId: event.payload.messageId,
              state: nextState,
              completedAt: isTerminalTurnState(nextState)
                ? maxIso(existingTurn.value.completedAt, event.payload.updatedAt)
                : existingTurn.value.completedAt,
              startedAt: existingTurn.value.startedAt ?? event.payload.createdAt,
              requestedAt: existingTurn.value.requestedAt ?? event.payload.createdAt,
            });
            return;
          }
          yield* projectionTurnRepository.upsertByTurnId({
            turnId: event.payload.turnId,
            threadId: event.payload.threadId,
            pendingMessageId: null,
            sourceProposedPlanThreadId: null,
            sourceProposedPlanId: null,
            assistantMessageId: event.payload.messageId,
            state: "running",
            requestedAt: event.payload.createdAt,
            startedAt: event.payload.createdAt,
            completedAt: null,
            checkpointTurnCount: null,
            checkpointRef: null,
            checkpointStatus: null,
            checkpointFiles: [],
          });
          return;
        }

        case "thread.turn-interrupt-requested": {
          if (event.payload.turnId === undefined) {
            return;
          }
          const existingTurn = yield* projectionTurnRepository.getByTurnId({
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
          });
          if (Option.isSome(existingTurn)) {
            yield* projectionTurnRepository.upsertByTurnId({
              ...existingTurn.value,
              state: "interrupted",
              completedAt: existingTurn.value.completedAt ?? event.payload.createdAt,
              startedAt: existingTurn.value.startedAt ?? event.payload.createdAt,
              requestedAt: existingTurn.value.requestedAt ?? event.payload.createdAt,
            });
            return;
          }
          yield* projectionTurnRepository.upsertByTurnId({
            turnId: event.payload.turnId,
            threadId: event.payload.threadId,
            pendingMessageId: null,
            sourceProposedPlanThreadId: null,
            sourceProposedPlanId: null,
            assistantMessageId: null,
            state: "interrupted",
            requestedAt: event.payload.createdAt,
            startedAt: event.payload.createdAt,
            completedAt: event.payload.createdAt,
            checkpointTurnCount: null,
            checkpointRef: null,
            checkpointStatus: null,
            checkpointFiles: [],
          });
          return;
        }

        case "thread.turn-diff-completed": {
          const existingTurn = yield* projectionTurnRepository.getByTurnId({
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
          });
          const nextState = event.payload.status === "error" ? "error" : "completed";
          yield* projectionTurnRepository.clearCheckpointTurnConflict({
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
            checkpointTurnCount: event.payload.checkpointTurnCount,
          });

          if (Option.isSome(existingTurn)) {
            const keepRunningForMissingProviderDiff =
              event.payload.status === "missing" &&
              existingTurn.value.state === "running" &&
              existingTurn.value.completedAt === null;
            const completedAt = keepRunningForMissingProviderDiff
              ? null
              : maxIso(existingTurn.value.completedAt, event.payload.completedAt);
            yield* projectionTurnRepository.upsertByTurnId({
              ...existingTurn.value,
              assistantMessageId: event.payload.assistantMessageId,
              state: keepRunningForMissingProviderDiff ? "running" : nextState,
              checkpointTurnCount: event.payload.checkpointTurnCount,
              checkpointRef: event.payload.checkpointRef,
              checkpointStatus: event.payload.status,
              checkpointFiles: event.payload.files,
              startedAt: existingTurn.value.startedAt ?? event.payload.completedAt,
              requestedAt: existingTurn.value.requestedAt ?? event.payload.completedAt,
              completedAt,
            });
            return;
          }
          yield* projectionTurnRepository.upsertByTurnId({
            turnId: event.payload.turnId,
            threadId: event.payload.threadId,
            pendingMessageId: null,
            sourceProposedPlanThreadId: null,
            sourceProposedPlanId: null,
            assistantMessageId: event.payload.assistantMessageId,
            state: nextState,
            requestedAt: event.payload.completedAt,
            startedAt: event.payload.completedAt,
            completedAt: event.payload.completedAt,
            checkpointTurnCount: event.payload.checkpointTurnCount,
            checkpointRef: event.payload.checkpointRef,
            checkpointStatus: event.payload.status,
            checkpointFiles: event.payload.files,
          });
          return;
        }

        case "thread.reverted": {
          const existingTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          const keptTurns = existingTurns.filter(
            (turn) =>
              turn.turnId !== null &&
              turn.checkpointTurnCount !== null &&
              turn.checkpointTurnCount <= event.payload.turnCount,
          );
          yield* projectionTurnRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          yield* Effect.forEach(
            keptTurns,
            (turn) =>
              turn.turnId === null
                ? Effect.void
                : projectionTurnRepository.upsertByTurnId({
                    ...turn,
                    turnId: turn.turnId,
                  }),
            { concurrency: 1 },
          ).pipe(Effect.asVoid);
          return;
        }

        default:
          return;
      }
    });

    const applyCheckpointsProjection: ProjectorDefinition["apply"] = () => Effect.void;

    const applyPendingApprovalsProjection: ProjectorDefinition["apply"] = Effect.fn(
      "applyPendingApprovalsProjection",
    )(function* (event, _attachmentSideEffects) {
      switch (event.type) {
        case "thread.activity-appended": {
          const requestId =
            extractActivityRequestId(event.payload.activity.payload) ??
            event.metadata.requestId ??
            null;
          if (requestId === null) {
            return;
          }
          const existingRow = yield* projectionPendingApprovalRepository.getByRequestId({
            requestId,
          });
          if (event.payload.activity.kind === "approval.resolved") {
            const resolvedDecisionRaw =
              typeof event.payload.activity.payload === "object" &&
              event.payload.activity.payload !== null &&
              "decision" in event.payload.activity.payload
                ? (event.payload.activity.payload as { decision?: unknown }).decision
                : null;
            const resolvedDecision =
              resolvedDecisionRaw === "accept" ||
              resolvedDecisionRaw === "acceptForSession" ||
              resolvedDecisionRaw === "decline" ||
              resolvedDecisionRaw === "cancel"
                ? resolvedDecisionRaw
                : null;
            yield* projectionPendingApprovalRepository.upsert({
              requestId,
              threadId: Option.isSome(existingRow)
                ? existingRow.value.threadId
                : event.payload.threadId,
              turnId: Option.isSome(existingRow)
                ? existingRow.value.turnId
                : event.payload.activity.turnId,
              status: "resolved",
              decision: resolvedDecision,
              createdAt: Option.isSome(existingRow)
                ? existingRow.value.createdAt
                : event.payload.activity.createdAt,
              resolvedAt: event.payload.activity.createdAt,
            });
            return;
          }
          if (event.payload.activity.kind === "provider.approval.respond.failed") {
            const payload =
              typeof event.payload.activity.payload === "object" &&
              event.payload.activity.payload !== null
                ? (event.payload.activity.payload as Record<string, unknown>)
                : null;
            const detail =
              typeof payload?.detail === "string" ? payload.detail.toLowerCase() : null;
            if (isStalePendingApprovalFailureDetail(detail)) {
              if (Option.isNone(existingRow)) {
                return;
              }
              if (existingRow.value.status === "resolved") {
                return;
              }
              yield* projectionPendingApprovalRepository.upsert({
                requestId,
                threadId: existingRow.value.threadId,
                turnId: existingRow.value.turnId,
                status: "resolved",
                decision: null,
                createdAt: existingRow.value.createdAt,
                resolvedAt: event.payload.activity.createdAt,
              });
              return;
            }
            return;
          }
          // Only approval-requested activities should create pending-approval
          // rows.  Other activity kinds that happen to carry a requestId
          // (e.g. user-input.requested / user-input.resolved) must not
          // pollute this projection; they have their own targeted shell
          // summary accounting.
          if (event.payload.activity.kind !== "approval.requested") {
            return;
          }
          if (Option.isSome(existingRow) && existingRow.value.status === "resolved") {
            return;
          }
          yield* projectionPendingApprovalRepository.upsert({
            requestId,
            threadId: event.payload.threadId,
            turnId: event.payload.activity.turnId,
            status: "pending",
            decision: null,
            createdAt: Option.isSome(existingRow)
              ? existingRow.value.createdAt
              : event.payload.activity.createdAt,
            resolvedAt: null,
          });
          return;
        }

        case "thread.approval-response-requested": {
          const existingRow = yield* projectionPendingApprovalRepository.getByRequestId({
            requestId: event.payload.requestId,
          });
          yield* projectionPendingApprovalRepository.upsert({
            requestId: event.payload.requestId,
            threadId: Option.isSome(existingRow)
              ? existingRow.value.threadId
              : event.payload.threadId,
            turnId: Option.isSome(existingRow) ? existingRow.value.turnId : null,
            status: "resolved",
            decision: event.payload.decision,
            createdAt: Option.isSome(existingRow)
              ? existingRow.value.createdAt
              : event.payload.createdAt,
            resolvedAt: event.payload.createdAt,
          });
          return;
        }

        default:
          return;
      }
    });

    const projectors: ReadonlyArray<ProjectorDefinition> = [
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.projects,
        apply: applyProjectsProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.threadMessages,
        apply: applyThreadMessagesProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.threadProposedPlans,
        apply: applyThreadProposedPlansProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.threadActivities,
        apply: applyThreadActivitiesProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.threadSessions,
        apply: applyThreadSessionsProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.threadTurns,
        apply: applyThreadTurnsProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.checkpoints,
        apply: applyCheckpointsProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.pendingApprovals,
        apply: applyPendingApprovalsProjection,
      },
      {
        name: ORCHESTRATION_PROJECTOR_NAMES.threads,
        apply: applyThreadsProjection,
      },
    ];

    const runProjectorForEvent = Effect.fn("runProjectorForEvent")(function* (
      projector: ProjectorDefinition,
      event: OrchestrationEvent,
    ) {
      const attachmentSideEffects: AttachmentSideEffects = {
        deletedThreadIds: new Set<string>(),
        prunedThreadRelativePaths: new Map<string, Set<string>>(),
      };

      yield* sql.withTransaction(
        projector.apply(event, attachmentSideEffects).pipe(
          Effect.flatMap(() =>
            projectionStateRepository.upsert({
              projector: projector.name,
              lastAppliedSequence: event.sequence,
              updatedAt: event.occurredAt,
            }),
          ),
        ),
      );

      yield* runAttachmentSideEffects(attachmentSideEffects).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("failed to apply projected attachment side-effects", {
            projector: projector.name,
            sequence: event.sequence,
            eventType: event.type,
            cause,
          }),
        ),
      );
    });

    const bootstrapProjector = (projector: ProjectorDefinition) =>
      projectionStateRepository
        .getByProjector({
          projector: projector.name,
        })
        .pipe(
          Effect.flatMap((stateRow) =>
            Stream.runForEach(
              eventStore.readFromSequence(
                Option.isSome(stateRow) ? stateRow.value.lastAppliedSequence : 0,
              ),
              (event) => runProjectorForEvent(projector, event),
            ),
          ),
        );

    const projectEvent: OrchestrationProjectionPipelineShape["projectEvent"] = (event) =>
      Effect.forEach(projectors, (projector) => runProjectorForEvent(projector, event), {
        concurrency: 1,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.provideService(ServerConfig, serverConfig),
        Effect.asVoid,
        Effect.catchTag("SqlError", (sqlError) =>
          Effect.fail(toPersistenceSqlError("ProjectionPipeline.projectEvent:query")(sqlError)),
        ),
      );

    const bootstrap: OrchestrationProjectionPipelineShape["bootstrap"] = Effect.forEach(
      projectors,
      bootstrapProjector,
      { concurrency: 1 },
    ).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ServerConfig, serverConfig),
      Effect.asVoid,
      Effect.tap(() =>
        Effect.logDebug("orchestration projection pipeline bootstrapped").pipe(
          Effect.annotateLogs({ projectors: projectors.length }),
        ),
      ),
      Effect.catchTag("SqlError", (sqlError) =>
        Effect.fail(toPersistenceSqlError("ProjectionPipeline.bootstrap:query")(sqlError)),
      ),
    );

    return {
      bootstrap,
      projectEvent,
    } satisfies OrchestrationProjectionPipelineShape;
  },
);

export const OrchestrationProjectionPipelineLive = Layer.effect(
  OrchestrationProjectionPipeline,
  makeOrchestrationProjectionPipeline(),
).pipe(
  Layer.provideMerge(ProjectionProjectRepositoryLive),
  Layer.provideMerge(ProjectionThreadRepositoryLive),
  Layer.provideMerge(ProjectionThreadMessageRepositoryLive),
  Layer.provideMerge(ProjectionThreadProposedPlanRepositoryLive),
  Layer.provideMerge(ProjectionThreadActivityRepositoryLive),
  Layer.provideMerge(ProjectionThreadSessionRepositoryLive),
  Layer.provideMerge(ProjectionTurnRepositoryLive),
  Layer.provideMerge(ProjectionPendingApprovalRepositoryLive),
  Layer.provideMerge(ProjectionStateRepositoryLive),
);
