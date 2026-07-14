import type { OrchestrationEvent, OrchestrationReadModel, ThreadId } from "@cafecode/contracts";
import {
  EventId,
  MessageId,
  OrchestrationCheckpointSummary,
  OrchestrationMessage,
  OrchestrationProposedPlanId,
  OrchestrationSession,
  OrchestrationThread,
  TurnId,
} from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { toProjectorDecodeError, type OrchestrationProjectorDecodeError } from "./Errors.ts";
import {
  MessageSentPayloadSchema,
  ProjectCreatedPayload,
  ProjectDeletedPayload,
  ProjectMetaUpdatedPayload,
  ThreadActivityAppendedPayload,
  ThreadArchivedPayload,
  ThreadCreatedPayload,
  ThreadDuplicatedPayload,
  ThreadDeletedPayload,
  ThreadRestoredPayload,
  ThreadInteractionModeSetPayload,
  ThreadMetaUpdatedPayload,
  ThreadProposedPlanUpsertedPayload,
  ThreadRuntimeModeSetPayload,
  ThreadUnarchivedPayload,
  ThreadRevertedPayload,
  ThreadSessionSetPayload,
  ThreadTurnDiffCompletedPayload,
  ThreadTurnInterruptRequestedPayload,
  ThreadTurnStartRequestedPayload,
} from "./Schemas.ts";

type ThreadPatch = Partial<Omit<OrchestrationThread, "id">>;
const MAX_THREAD_MESSAGES = 2_000;
const MAX_THREAD_CHECKPOINTS = 500;

function copiedThreadScopedId(targetThreadId: ThreadId, id: string): string {
  return `copy:${targetThreadId}:${id}`;
}

function copiedMessageId(targetThreadId: ThreadId, messageId: string): MessageId {
  return MessageId.make(copiedThreadScopedId(targetThreadId, messageId));
}

function copiedTurnId(targetThreadId: ThreadId, turnId: string | null): TurnId | null {
  return turnId === null ? null : TurnId.make(copiedThreadScopedId(targetThreadId, turnId));
}

function copiedRequiredTurnId(targetThreadId: ThreadId, turnId: string): TurnId {
  return TurnId.make(copiedThreadScopedId(targetThreadId, turnId));
}

function copiedEventId(targetThreadId: ThreadId, eventId: string): EventId {
  return EventId.make(copiedThreadScopedId(targetThreadId, eventId));
}

function copiedProposedPlanId(
  targetThreadId: ThreadId,
  planId: string,
): OrchestrationProposedPlanId {
  return OrchestrationProposedPlanId.make(copiedThreadScopedId(targetThreadId, planId));
}

function cloneThreadContextForDuplicate(input: {
  readonly sourceThread: OrchestrationThread;
  readonly targetThread: OrchestrationThread;
  readonly duplicatedAt: string;
}): OrchestrationThread {
  const { sourceThread, targetThread, duplicatedAt } = input;
  const copiedMessages = sourceThread.messages.map((message) => ({
    ...message,
    id: copiedMessageId(targetThread.id, message.id),
    turnId: copiedTurnId(targetThread.id, message.turnId),
    streaming: false,
  }));
  const copiedPlans = sourceThread.proposedPlans.map((plan) => ({
    ...plan,
    id: copiedProposedPlanId(targetThread.id, plan.id),
    turnId: copiedTurnId(targetThread.id, plan.turnId),
    implementationThreadId:
      plan.implementationThreadId === sourceThread.id
        ? targetThread.id
        : plan.implementationThreadId,
  }));
  const copiedActivities = sourceThread.activities.map((activity) => ({
    ...activity,
    id: copiedEventId(targetThread.id, activity.id),
    turnId: copiedTurnId(targetThread.id, activity.turnId),
  }));
  const latestTurn =
    sourceThread.latestTurn === null
      ? null
      : {
          ...sourceThread.latestTurn,
          turnId: copiedRequiredTurnId(targetThread.id, sourceThread.latestTurn.turnId),
          state:
            sourceThread.latestTurn.state === "running"
              ? ("interrupted" as const)
              : sourceThread.latestTurn.state,
          completedAt:
            sourceThread.latestTurn.completedAt ??
            (sourceThread.latestTurn.state === "running" ? duplicatedAt : null),
          assistantMessageId:
            sourceThread.latestTurn.assistantMessageId === null
              ? null
              : copiedMessageId(targetThread.id, sourceThread.latestTurn.assistantMessageId),
          ...(sourceThread.latestTurn.sourceProposedPlan !== undefined
            ? {
                sourceProposedPlan:
                  sourceThread.latestTurn.sourceProposedPlan.threadId === sourceThread.id
                    ? {
                        threadId: targetThread.id,
                        planId: copiedProposedPlanId(
                          targetThread.id,
                          sourceThread.latestTurn.sourceProposedPlan.planId,
                        ),
                      }
                    : sourceThread.latestTurn.sourceProposedPlan,
              }
            : {}),
        };

  return {
    ...targetThread,
    latestTurn,
    messages: copiedMessages.slice(-MAX_THREAD_MESSAGES),
    proposedPlans: copiedPlans,
    activities: copiedActivities,
    checkpoints: sourceThread.checkpoints.map(
      (checkpoint): OrchestrationCheckpointSummary => ({
        turnId: copiedRequiredTurnId(targetThread.id, checkpoint.turnId),
        checkpointTurnCount: checkpoint.checkpointTurnCount,
        checkpointRef: checkpoint.checkpointRef,
        status: checkpoint.status,
        files: checkpoint.files,
        assistantMessageId:
          checkpoint.assistantMessageId === null
            ? null
            : copiedMessageId(targetThread.id, checkpoint.assistantMessageId),
        completedAt: checkpoint.completedAt,
      }),
    ),
    // Provider runtime/session identity is intentionally not copied. A
    // duplicate carries Cafe-visible conversation context only; the next user
    // prompt must create a fresh provider boundary instead of resuming Claude
    // or Codex state owned by the source thread.
    session: null,
    updatedAt: duplicatedAt,
  };
}

function checkpointStatusToLatestTurnState(status: "ready" | "missing" | "error") {
  if (status === "error") return "error" as const;
  if (status === "missing") return "interrupted" as const;
  return "completed" as const;
}

function isLatestTurnTerminal(turn: OrchestrationThread["latestTurn"]): boolean {
  return (
    turn !== null &&
    turn.completedAt !== null &&
    (turn.state === "completed" || turn.state === "interrupted" || turn.state === "error")
  );
}

function updateThread(
  threads: ReadonlyArray<OrchestrationThread>,
  threadId: ThreadId,
  patch: ThreadPatch,
): OrchestrationThread[] {
  return threads.map((thread) => (thread.id === threadId ? { ...thread, ...patch } : thread));
}

function decodeForEvent<A>(
  schema: Schema.Decoder<A, never>,
  value: unknown,
  eventType: OrchestrationEvent["type"],
  field: string,
): Effect.Effect<A, OrchestrationProjectorDecodeError> {
  return Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(toProjectorDecodeError(`${eventType}:${field}`)),
  );
}

function retainThreadMessagesAfterRevert(
  messages: ReadonlyArray<OrchestrationMessage>,
  retainedTurnIds: ReadonlySet<string>,
  turnCount: number,
): ReadonlyArray<OrchestrationMessage> {
  const retainedMessageIds = new Set<string>();
  for (const message of messages) {
    if (message.role === "system") {
      retainedMessageIds.add(message.id);
      continue;
    }
    if (message.turnId !== null && retainedTurnIds.has(message.turnId)) {
      retainedMessageIds.add(message.id);
    }
  }

  const retainedUserCount = messages.filter(
    (message) => message.role === "user" && retainedMessageIds.has(message.id),
  ).length;
  const missingUserCount = Math.max(0, turnCount - retainedUserCount);
  if (missingUserCount > 0) {
    const fallbackUserMessages = messages
      .filter(
        (message) =>
          message.role === "user" &&
          !retainedMessageIds.has(message.id) &&
          (message.turnId === null || retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      )
      .slice(0, missingUserCount);
    for (const message of fallbackUserMessages) {
      retainedMessageIds.add(message.id);
    }
  }

  const retainedAssistantCount = messages.filter(
    (message) => message.role === "assistant" && retainedMessageIds.has(message.id),
  ).length;
  const missingAssistantCount = Math.max(0, turnCount - retainedAssistantCount);
  if (missingAssistantCount > 0) {
    const fallbackAssistantMessages = messages
      .filter(
        (message) =>
          message.role === "assistant" &&
          !retainedMessageIds.has(message.id) &&
          (message.turnId === null || retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      )
      .slice(0, missingAssistantCount);
    for (const message of fallbackAssistantMessages) {
      retainedMessageIds.add(message.id);
    }
  }

  return messages.filter((message) => retainedMessageIds.has(message.id));
}

function retainThreadActivitiesAfterRevert(
  activities: ReadonlyArray<OrchestrationThread["activities"][number]>,
  retainedTurnIds: ReadonlySet<string>,
): ReadonlyArray<OrchestrationThread["activities"][number]> {
  return activities.filter(
    (activity) => activity.turnId === null || retainedTurnIds.has(activity.turnId),
  );
}

function retainThreadProposedPlansAfterRevert(
  proposedPlans: ReadonlyArray<OrchestrationThread["proposedPlans"][number]>,
  retainedTurnIds: ReadonlySet<string>,
): ReadonlyArray<OrchestrationThread["proposedPlans"][number]> {
  return proposedPlans.filter(
    (proposedPlan) => proposedPlan.turnId === null || retainedTurnIds.has(proposedPlan.turnId),
  );
}

function compareThreadActivities(
  left: OrchestrationThread["activities"][number],
  right: OrchestrationThread["activities"][number],
): number {
  if (left.sequence !== undefined && right.sequence !== undefined) {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
  } else if (left.sequence !== undefined) {
    return 1;
  } else if (right.sequence !== undefined) {
    return -1;
  }

  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

export function createEmptyReadModel(nowIso: string): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [],
    updatedAt: nowIso,
  };
}

export function projectEvent(
  model: OrchestrationReadModel,
  event: OrchestrationEvent,
): Effect.Effect<OrchestrationReadModel, OrchestrationProjectorDecodeError> {
  const nextBase: OrchestrationReadModel = {
    ...model,
    snapshotSequence: event.sequence,
    updatedAt: event.occurredAt,
  };

  switch (event.type) {
    case "project.created":
      return decodeForEvent(ProjectCreatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const existing = nextBase.projects.find((entry) => entry.id === payload.projectId);
          const nextProject = {
            id: payload.projectId,
            title: payload.title,
            workspaceRoot: payload.workspaceRoot,
            additionalWorkspaceRoots: payload.additionalWorkspaceRoots ?? [],
            defaultModelSelection: payload.defaultModelSelection,
            scripts: payload.scripts,
            createdAt: payload.createdAt,
            updatedAt: payload.updatedAt,
            deletedAt: null,
          };

          return {
            ...nextBase,
            projects: existing
              ? nextBase.projects.map((entry) =>
                  entry.id === payload.projectId ? nextProject : entry,
                )
              : [...nextBase.projects, nextProject],
          };
        }),
      );

    case "project.meta-updated":
      return decodeForEvent(ProjectMetaUpdatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          projects: nextBase.projects.map((project) =>
            project.id === payload.projectId
              ? {
                  ...project,
                  ...(payload.title !== undefined ? { title: payload.title } : {}),
                  ...(payload.workspaceRoot !== undefined
                    ? { workspaceRoot: payload.workspaceRoot }
                    : {}),
                  ...(payload.additionalWorkspaceRoots !== undefined
                    ? { additionalWorkspaceRoots: payload.additionalWorkspaceRoots }
                    : {}),
                  ...(payload.defaultModelSelection !== undefined
                    ? { defaultModelSelection: payload.defaultModelSelection }
                    : {}),
                  ...(payload.scripts !== undefined ? { scripts: payload.scripts } : {}),
                  updatedAt: payload.updatedAt,
                }
              : project,
          ),
        })),
      );

    case "project.deleted":
      return decodeForEvent(ProjectDeletedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          projects: nextBase.projects.map((project) =>
            project.id === payload.projectId
              ? {
                  ...project,
                  deletedAt: payload.deletedAt,
                  updatedAt: payload.deletedAt,
                }
              : project,
          ),
        })),
      );

    case "thread.created":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadCreatedPayload,
          event.payload,
          event.type,
          "payload",
        );
        const thread: OrchestrationThread = yield* decodeForEvent(
          OrchestrationThread,
          {
            id: payload.threadId,
            projectId: payload.projectId,
            title: payload.title,
            modelSelection: payload.modelSelection,
            runtimeMode: payload.runtimeMode,
            interactionMode: payload.interactionMode,
            branch: payload.branch,
            worktreePath: payload.worktreePath,
            latestTurn: null,
            createdAt: payload.createdAt,
            updatedAt: payload.updatedAt,
            archivedAt: null,
            deletedAt: null,
            messages: [],
            activities: [],
            checkpoints: [],
            session: null,
          },
          event.type,
          "thread",
        );
        const existing = nextBase.threads.find((entry) => entry.id === thread.id);
        return {
          ...nextBase,
          threads: existing
            ? nextBase.threads.map((entry) => (entry.id === thread.id ? thread : entry))
            : [...nextBase.threads, thread],
        };
      });

    case "thread.duplicated":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadDuplicatedPayload,
          event.payload,
          event.type,
          "payload",
        );
        const sourceThread = nextBase.threads.find((entry) => entry.id === payload.sourceThreadId);
        const targetThread = nextBase.threads.find((entry) => entry.id === payload.targetThreadId);
        if (!sourceThread || !targetThread) {
          return nextBase;
        }
        const copiedThread = cloneThreadContextForDuplicate({
          sourceThread,
          targetThread,
          duplicatedAt: payload.duplicatedAt,
        });
        return {
          ...nextBase,
          threads: nextBase.threads.map((entry) =>
            entry.id === payload.targetThreadId ? copiedThread : entry,
          ),
        };
      });

    case "thread.deleted":
      return decodeForEvent(ThreadDeletedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            deletedAt: payload.deletedAt,
            updatedAt: payload.deletedAt,
          }),
        })),
      );

    case "thread.restored":
      return decodeForEvent(ThreadRestoredPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            deletedAt: null,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.archived":
      return decodeForEvent(ThreadArchivedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            archivedAt: payload.archivedAt,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.unarchived":
      return decodeForEvent(ThreadUnarchivedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            archivedAt: null,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.meta-updated":
      return decodeForEvent(ThreadMetaUpdatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            ...(payload.projectId !== undefined ? { projectId: payload.projectId } : {}),
            ...(payload.title !== undefined ? { title: payload.title } : {}),
            ...(payload.modelSelection !== undefined
              ? { modelSelection: payload.modelSelection }
              : {}),
            ...(payload.branch !== undefined ? { branch: payload.branch } : {}),
            ...(payload.worktreePath !== undefined ? { worktreePath: payload.worktreePath } : {}),
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.runtime-mode-set":
      return decodeForEvent(ThreadRuntimeModeSetPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            runtimeMode: payload.runtimeMode,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.interaction-mode-set":
      return decodeForEvent(
        ThreadInteractionModeSetPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            interactionMode: payload.interactionMode,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.turn-start-requested":
      return decodeForEvent(
        ThreadTurnStartRequestedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          if (!thread) {
            return nextBase;
          }
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              ...(payload.modelSelection !== undefined
                ? { modelSelection: payload.modelSelection }
                : {}),
              runtimeMode: payload.runtimeMode,
              interactionMode: payload.interactionMode,
              session: {
                threadId: payload.threadId,
                status: "starting",
                providerName: thread.session?.providerName ?? null,
                ...(thread.session?.providerInstanceId !== undefined
                  ? { providerInstanceId: thread.session.providerInstanceId }
                  : {}),
                runtimeMode: payload.runtimeMode,
                activeTurnId: null,
                lastError: null,
                updatedAt: payload.createdAt,
              },
              updatedAt: event.occurredAt,
            }),
          };
        }),
      );

    case "thread.message-sent":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          MessageSentPayloadSchema,
          event.payload,
          event.type,
          "payload",
        );
        const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
        if (!thread) {
          return nextBase;
        }

        const message: OrchestrationMessage = yield* decodeForEvent(
          OrchestrationMessage,
          {
            id: payload.messageId,
            role: payload.role,
            text: payload.text,
            ...(payload.attachments !== undefined ? { attachments: payload.attachments } : {}),
            turnId: payload.turnId,
            streaming: payload.streaming,
            createdAt: payload.createdAt,
            updatedAt: payload.updatedAt,
          },
          event.type,
          "message",
        );

        const existingMessage = thread.messages.find((entry) => entry.id === message.id);
        const messages = existingMessage
          ? thread.messages.map((entry) =>
              entry.id === message.id
                ? {
                    ...entry,
                    text: message.streaming
                      ? `${entry.text}${message.text}`
                      : message.text.length > 0
                        ? message.text
                        : entry.text,
                    streaming: message.streaming,
                    updatedAt: message.updatedAt,
                    turnId: message.turnId,
                    ...(message.attachments !== undefined
                      ? { attachments: message.attachments }
                      : {}),
                  }
                : entry,
            )
          : [...thread.messages, message];
        const cappedMessages = messages.slice(-MAX_THREAD_MESSAGES);

        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            messages: cappedMessages,
            updatedAt: event.occurredAt,
          }),
        };
      });

    case "thread.message.assistant-repair-applied":
      return Effect.sync(() => {
        const thread = nextBase.threads.find((entry) => entry.id === event.payload.threadId);
        if (!thread) {
          return nextBase;
        }

        const messages: Array<(typeof thread.messages)[number]> = [];
        for (const message of thread.messages) {
          if (message.id === event.payload.messageId && message.role === "assistant") {
            messages.push({
              ...message,
              text: `${message.text}${event.payload.suffix}`,
              streaming: false,
              updatedAt: event.payload.repairedAt,
              turnId: event.payload.turnId,
            });
          } else {
            messages.push(message);
          }
        }

        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, event.payload.threadId, {
            messages,
            updatedAt: event.occurredAt,
          }),
        };
      });

    case "thread.session-set":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadSessionSetPayload,
          event.payload,
          event.type,
          "payload",
        );
        const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
        if (!thread) {
          return nextBase;
        }

        const session: OrchestrationSession = yield* decodeForEvent(
          OrchestrationSession,
          payload.session,
          event.type,
          "session",
        );
        const existingActiveTurnId =
          thread.session?.activeTurnId ??
          (thread.latestTurn?.state === "running" ? thread.latestTurn.turnId : null);
        const terminalLatestTurn = isLatestTurnTerminal(thread.latestTurn)
          ? thread.latestTurn
          : null;
        const permitsTerminalTurnRecovery =
          payload.terminalTurnRecovery === "live-provider-continuation";
        const staleRunningSession =
          !permitsTerminalTurnRecovery &&
          session.status === "running" &&
          session.activeTurnId !== null &&
          terminalLatestTurn !== null &&
          terminalLatestTurn.completedAt !== null &&
          (session.activeTurnId === terminalLatestTurn.turnId ||
            terminalLatestTurn.completedAt >= session.updatedAt);
        const closesActiveTurn =
          session.activeTurnId === null &&
          existingActiveTurnId !== null &&
          (session.status === "ready" ||
            session.status === "error" ||
            session.status === "interrupted" ||
            session.status === "stopped");
        const closedTurnState =
          session.status === "error"
            ? "error"
            : session.status === "ready"
              ? "completed"
              : "interrupted";

        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            session: staleRunningSession ? thread.session : session,
            latestTurn: staleRunningSession
              ? thread.latestTurn
              : session.status === "running" && session.activeTurnId !== null
                ? (() => {
                    const isSameTurn = thread.latestTurn?.turnId === session.activeTurnId;
                    const requestedAt = isSameTurn
                      ? thread.latestTurn.requestedAt
                      : thread.session?.status === "starting" &&
                          thread.session.activeTurnId === null
                        ? thread.session.updatedAt
                        : session.updatedAt;
                    return {
                      turnId: session.activeTurnId,
                      state: "running",
                      requestedAt,
                      startedAt: isSameTurn
                        ? (thread.latestTurn.startedAt ?? session.updatedAt)
                        : session.updatedAt,
                      completedAt: null,
                      assistantMessageId: isSameTurn ? thread.latestTurn.assistantMessageId : null,
                    };
                  })()
                : closesActiveTurn
                  ? (() => {
                      const isSameTurn = thread.latestTurn?.turnId === existingActiveTurnId;
                      return {
                        turnId: existingActiveTurnId,
                        state:
                          thread.latestTurn?.state === "error" ||
                          thread.latestTurn?.state === "interrupted"
                            ? thread.latestTurn.state
                            : closedTurnState,
                        requestedAt: isSameTurn
                          ? (thread.latestTurn.requestedAt ?? session.updatedAt)
                          : session.updatedAt,
                        startedAt: isSameTurn
                          ? (thread.latestTurn.startedAt ?? session.updatedAt)
                          : session.updatedAt,
                        completedAt: isSameTurn
                          ? (thread.latestTurn.completedAt ?? session.updatedAt)
                          : session.updatedAt,
                        assistantMessageId: isSameTurn
                          ? thread.latestTurn.assistantMessageId
                          : null,
                      };
                    })()
                  : thread.latestTurn,
            updatedAt: event.occurredAt,
          }),
        };
      });

    case "thread.turn-interrupt-requested":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadTurnInterruptRequestedPayload,
          event.payload,
          event.type,
          "payload",
        );
        const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
        if (!thread) {
          return nextBase;
        }

        const interruptedTurnId =
          payload.turnId ??
          thread.session?.activeTurnId ??
          (thread.latestTurn?.state === "running" ? thread.latestTurn.turnId : null);
        const sessionActiveTurnId = thread.session?.activeTurnId ?? null;
        const interruptMatchesSession =
          payload.turnId === undefined ||
          sessionActiveTurnId === null ||
          sessionActiveTurnId === payload.turnId;
        const shouldCloseSession =
          thread.session !== null &&
          interruptMatchesSession &&
          (thread.session.status === "starting" ||
            thread.session.status === "running" ||
            thread.session.activeTurnId !== null);
        const shouldUpdateLatestTurn =
          interruptedTurnId !== null &&
          (thread.latestTurn === null || thread.latestTurn.turnId === interruptedTurnId);
        const sameLatestTurn =
          thread.latestTurn !== null && thread.latestTurn.turnId === interruptedTurnId;

        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            session: shouldCloseSession
              ? {
                  ...thread.session,
                  status: "interrupted",
                  activeTurnId: null,
                  updatedAt: payload.createdAt,
                }
              : thread.session,
            latestTurn: shouldUpdateLatestTurn
              ? {
                  turnId: interruptedTurnId,
                  state: "interrupted",
                  requestedAt: sameLatestTurn
                    ? (thread.latestTurn?.requestedAt ?? payload.createdAt)
                    : payload.createdAt,
                  startedAt: sameLatestTurn
                    ? (thread.latestTurn?.startedAt ?? payload.createdAt)
                    : payload.createdAt,
                  completedAt: sameLatestTurn
                    ? (thread.latestTurn?.completedAt ?? payload.createdAt)
                    : payload.createdAt,
                  assistantMessageId: sameLatestTurn ? thread.latestTurn?.assistantMessageId : null,
                }
              : thread.latestTurn,
            updatedAt: event.occurredAt,
          }),
        };
      });

    case "thread.proposed-plan-upserted":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadProposedPlanUpsertedPayload,
          event.payload,
          event.type,
          "payload",
        );
        const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
        if (!thread) {
          return nextBase;
        }

        const proposedPlans = [
          ...thread.proposedPlans.filter((entry) => entry.id !== payload.proposedPlan.id),
          payload.proposedPlan,
        ]
          .toSorted(
            (left, right) =>
              left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
          )
          .slice(-200);

        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            proposedPlans,
            updatedAt: event.occurredAt,
          }),
        };
      });

    case "thread.turn-diff-completed":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadTurnDiffCompletedPayload,
          event.payload,
          event.type,
          "payload",
        );
        const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
        if (!thread) {
          return nextBase;
        }

        const checkpoint = yield* decodeForEvent(
          OrchestrationCheckpointSummary,
          {
            turnId: payload.turnId,
            checkpointTurnCount: payload.checkpointTurnCount,
            checkpointRef: payload.checkpointRef,
            status: payload.status,
            files: payload.files,
            assistantMessageId: payload.assistantMessageId,
            completedAt: payload.completedAt,
          },
          event.type,
          "checkpoint",
        );

        // Do not let a placeholder (status "missing") overwrite a checkpoint
        // that has already been captured with a real git ref (status "ready").
        // ProviderRuntimeIngestion may fire multiple turn.diff.updated events
        // per turn; without this guard later placeholders would clobber the
        // real capture dispatched by CheckpointReactor.
        const existing = thread.checkpoints.find((entry) => entry.turnId === checkpoint.turnId);
        if (existing && existing.status !== "missing" && checkpoint.status === "missing") {
          return nextBase;
        }

        const checkpoints = [
          ...thread.checkpoints.filter((entry) => entry.turnId !== checkpoint.turnId),
          checkpoint,
        ]
          .toSorted((left, right) => left.checkpointTurnCount - right.checkpointTurnCount)
          .slice(-MAX_THREAD_CHECKPOINTS);

        const preservesTurnLifecycle = payload.status === "missing";

        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            checkpoints,
            // `turn.diff.updated` is a change signal, not a provider lifecycle
            // event. Its synthetic `missing` checkpoint records diagnostic
            // metadata only and must never close or manufacture a turn.
            latestTurn: preservesTurnLifecycle
              ? thread.latestTurn
              : {
                  turnId: payload.turnId,
                  state: checkpointStatusToLatestTurnState(payload.status),
                  requestedAt:
                    thread.latestTurn?.turnId === payload.turnId
                      ? thread.latestTurn.requestedAt
                      : payload.completedAt,
                  startedAt:
                    thread.latestTurn?.turnId === payload.turnId
                      ? (thread.latestTurn.startedAt ?? payload.completedAt)
                      : payload.completedAt,
                  completedAt: payload.completedAt,
                  assistantMessageId: payload.assistantMessageId,
                },
            updatedAt: event.occurredAt,
          }),
        };
      });

    case "thread.reverted":
      return decodeForEvent(ThreadRevertedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          if (!thread) {
            return nextBase;
          }

          const checkpoints = thread.checkpoints
            .filter((entry) => entry.checkpointTurnCount <= payload.turnCount)
            .toSorted((left, right) => left.checkpointTurnCount - right.checkpointTurnCount)
            .slice(-MAX_THREAD_CHECKPOINTS);
          const retainedTurnIds = new Set(checkpoints.map((checkpoint) => checkpoint.turnId));
          const messages = retainThreadMessagesAfterRevert(
            thread.messages,
            retainedTurnIds,
            payload.turnCount,
          ).slice(-MAX_THREAD_MESSAGES);
          const proposedPlans = retainThreadProposedPlansAfterRevert(
            thread.proposedPlans,
            retainedTurnIds,
          ).slice(-200);
          const activities = retainThreadActivitiesAfterRevert(thread.activities, retainedTurnIds);

          const latestCheckpoint = checkpoints.at(-1) ?? null;
          const latestTurn =
            latestCheckpoint === null
              ? null
              : {
                  turnId: latestCheckpoint.turnId,
                  state: checkpointStatusToLatestTurnState(latestCheckpoint.status),
                  requestedAt: latestCheckpoint.completedAt,
                  startedAt: latestCheckpoint.completedAt,
                  completedAt: latestCheckpoint.completedAt,
                  assistantMessageId: latestCheckpoint.assistantMessageId,
                };

          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              checkpoints,
              messages,
              proposedPlans,
              activities,
              latestTurn,
              updatedAt: event.occurredAt,
            }),
          };
        }),
      );

    case "thread.activity-appended":
      return decodeForEvent(
        ThreadActivityAppendedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          if (!thread) {
            return nextBase;
          }

          const activities = [
            ...thread.activities.filter((entry) => entry.id !== payload.activity.id),
            payload.activity,
          ]
            .toSorted(compareThreadActivities)
            .slice(-500);

          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              activities,
              updatedAt: event.occurredAt,
            }),
          };
        }),
      );

    default:
      return Effect.succeed(nextBase);
  }
}
