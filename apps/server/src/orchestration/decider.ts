import * as Schema from "effect/Schema";
import { isDeepStrictEqual } from "node:util";

import type {
  CommandId,
  OrchestrationCommand,
  OrchestrationEvent,
  OrchestrationReadModel,
  OrchestrationThread,
  ProviderPrioritySessionBinding,
  ThreadProvenance,
} from "@cafecode/contracts";
import {
  MAX_LIVE_THREAD_GROUPS_PER_OWNER,
  MAX_THREAD_GROUP_DEPTH,
  defaultThreadOriginClassification,
} from "@cafecode/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import {
  formatCodexAsyncQuestionAnswer,
  normalizeCodexAsyncQuestions,
} from "@cafecode/shared/codexAsyncQuestions";

import { OrchestrationCommandInvariantError } from "./Errors.ts";
import {
  listThreadsByProjectId,
  requireProject,
  requireProjectAbsent,
  requireThread,
  requireThreadArchived,
  requireThreadAbsent,
  requireThreadNotArchived,
} from "./commandInvariants.ts";
import { projectEvent } from "./projector.ts";
import { resolveThreadForkMessageCutoff } from "./threadForkCutoff.ts";
import {
  collectArchiveClosure,
  collectDeletionClosure,
  collectRestoreClosure,
  findThreadGroup,
  liveGroupsOwnedBy,
  normalizedGroupTitle,
  threadGroupDepth,
  threadGroups,
  type ContainmentClosure,
} from "./threadGroups.ts";
import { SESSION_LIFECYCLE_SUPERSEDED, sessionLifecycleSnapshot } from "./sessionLifecycle.ts";
import {
  derivePendingQuestionRequests,
  validatePendingQuestionResponse,
} from "./pendingQuestions.ts";
import {
  makeMcpQuestionResolutionActivity,
  makeNativeMcpQuestionResolutionItems,
  type McpQuestionResolutionItem,
} from "./mcpQuestionNotice.ts";

const encodeJsonString = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

function withEventBase(
  input: Pick<OrchestrationCommand, "commandId"> & {
    readonly aggregateKind: OrchestrationEvent["aggregateKind"];
    readonly aggregateId: OrchestrationEvent["aggregateId"];
    readonly occurredAt: string;
    readonly metadata?: OrchestrationEvent["metadata"];
  },
): Omit<OrchestrationEvent, "sequence" | "type" | "payload"> {
  return {
    eventId: crypto.randomUUID() as OrchestrationEvent["eventId"],
    aggregateKind: input.aggregateKind,
    aggregateId: input.aggregateId,
    occurredAt: input.occurredAt,
    commandId: input.commandId,
    causationEventId: null,
    correlationId: input.commandId,
    metadata: input.metadata ?? {},
  };
}

type PlannedOrchestrationEvent = Omit<OrchestrationEvent, "sequence">;

/**
 * One delete batch: owner-stream group deletions plus ordinary thread
 * deletions, all tagged with the same exact deletion incarnation. Every
 * `thread.deleted` keeps the existing ThreadDeletionReactor stop request, which
 * is a requested native stop, not proof of cleanup.
 */
function closureDeletionEvents(
  closure: ContainmentClosure,
  deletionId: CommandId,
  occurredAt: string,
): PlannedOrchestrationEvent[] {
  return [
    ...closure.groups.map((group): PlannedOrchestrationEvent => ({
      ...withEventBase({
        aggregateKind: "thread",
        aggregateId: group.ownerThreadId,
        occurredAt,
        commandId: deletionId,
      }),
      type: "thread.group-deleted",
      payload: {
        groupId: group.id,
        ownerThreadId: group.ownerThreadId,
        deletionId,
        deletedAt: occurredAt,
      },
    })),
    ...closure.threads.map((thread): PlannedOrchestrationEvent => ({
      ...withEventBase({
        aggregateKind: "thread",
        aggregateId: thread.id,
        occurredAt,
        commandId: deletionId,
      }),
      type: "thread.deleted",
      payload: { threadId: thread.id, deletionId, deletedAt: occurredAt },
    })),
  ];
}

function closureRestoreEvents(
  closure: ContainmentClosure,
  commandId: CommandId,
  occurredAt: string,
): PlannedOrchestrationEvent[] {
  return [
    ...closure.groups.map((group): PlannedOrchestrationEvent => ({
      ...withEventBase({
        aggregateKind: "thread",
        aggregateId: group.ownerThreadId,
        occurredAt,
        commandId,
      }),
      type: "thread.group-restored",
      payload: { groupId: group.id, ownerThreadId: group.ownerThreadId, updatedAt: occurredAt },
    })),
    ...closure.threads.map((thread): PlannedOrchestrationEvent => ({
      ...withEventBase({
        aggregateKind: "thread",
        aggregateId: thread.id,
        occurredAt,
        commandId,
      }),
      type: "thread.restored",
      payload: { threadId: thread.id, updatedAt: occurredAt },
    })),
  ];
}

function isLiveThread(thread: OrchestrationThread | undefined): thread is OrchestrationThread {
  return thread !== undefined && thread.deletedAt === null;
}

/** Recorded label derived from server provenance; absent provenance stays unknown. */
function recordedOriginFields(provenance: ThreadProvenance | undefined, recordedAt: string) {
  if (provenance === undefined) return {};
  return {
    provenance,
    origin: {
      classification: defaultThreadOriginClassification(provenance),
      source: "recorded" as const,
      updatedAt: recordedAt,
    },
  };
}

type DecideOrchestrationCommandResult =
  | PlannedOrchestrationEvent
  | ReadonlyArray<PlannedOrchestrationEvent>;

/** Only management-only commands call this helper. The public client command
 * union has no provenance flag which a provider or ordinary renderer could
 * use to impersonate a completed management action. This is presentation
 * metadata, never a model message or permission/retry authority. */
function mcpQuestionNotice(
  command: Extract<
    OrchestrationCommand,
    {
      readonly type: "thread.async-question.answer" | "thread.mcp-async-questions.resolve";
    }
  >,
  action: "answered" | "skipped" | "cleared",
  items: readonly McpQuestionResolutionItem[],
): Extract<OrchestrationCommand, { readonly type: "thread.activity.append" }> {
  return {
    type: "thread.activity.append",
    commandId: command.commandId,
    threadId: command.threadId,
    createdAt: command.createdAt,
    activity: makeMcpQuestionResolutionActivity({
      noticeMessageId: command.noticeMessageId,
      action,
      items,
      createdAt: command.createdAt,
    }),
  };
}

export function threadHasUnsettledTurnStart(
  thread: OrchestrationReadModel["threads"][number],
): boolean {
  if (thread.session?.status === "starting" || thread.session?.status === "running") {
    return true;
  }
  if (thread.session?.activeTurnId !== null && thread.session?.activeTurnId !== undefined) {
    return true;
  }
  return false;
}

function activeTurnIdForSteer(
  thread: OrchestrationReadModel["threads"][number],
): NonNullable<OrchestrationReadModel["threads"][number]["latestTurn"]>["turnId"] | null {
  if (thread.session?.activeTurnId !== null && thread.session?.activeTurnId !== undefined) {
    return thread.session.activeTurnId;
  }
  // A running projection row is not enough proof that a provider turn is still
  // steerable. After a restart or stop-all, durable runtime state can be
  // stopped while a stale `projection_turns.state = running` row remains. In
  // that case upstream Codex CLI/TUI would start/resume fresh local app-server
  // state instead of steering a dead turn, so only use the latest-turn fallback
  // while the session itself still claims an active running provider boundary.
  if (thread.session?.status === "running" && thread.latestTurn?.state === "running") {
    return thread.latestTurn.turnId;
  }
  return null;
}

const decideCommandSequence = Effect.fn("decideCommandSequence")(function* ({
  commands,
  readModel,
}: {
  readonly commands: ReadonlyArray<OrchestrationCommand>;
  readonly readModel: OrchestrationReadModel;
}): Effect.fn.Return<ReadonlyArray<PlannedOrchestrationEvent>, OrchestrationCommandInvariantError> {
  let nextReadModel = readModel;
  let nextSequence = readModel.snapshotSequence;
  const plannedEvents: PlannedOrchestrationEvent[] = [];

  for (const nextCommand of commands) {
    const decided = yield* decideOrchestrationCommand({
      command: nextCommand,
      readModel: nextReadModel,
    });
    const nextEvents = Array.isArray(decided) ? decided : [decided];
    for (const nextEvent of nextEvents) {
      plannedEvents.push(nextEvent);
      nextSequence += 1;
      nextReadModel = yield* projectEvent(nextReadModel, {
        ...nextEvent,
        sequence: nextSequence,
      }).pipe(Effect.orDie);
    }
  }

  return plannedEvents;
});

export const decideOrchestrationCommand = Effect.fn("decideOrchestrationCommand")(function* ({
  command,
  readModel,
  runtimeRecoveryBarrierVerified = false,
  codexRootReplacementVerified = false,
  codexFailedRootVerified = false,
  codexFailedRootGenerationTransferVerified = false,
  codexRecoveryAcceptedVerified = false,
  scheduledFollowUpVerified = false,
}: {
  readonly command: OrchestrationCommand;
  readonly readModel: OrchestrationReadModel;
  /** Only the engine's durable loss-marker/control-barrier read may set this. */
  readonly runtimeRecoveryBarrierVerified?: boolean;
  /** Only the engine's serialized durable steer/control-barrier read may set this. */
  readonly codexRootReplacementVerified?: boolean;
  /** Exact internal intent/attempt/ACK and control barrier, checked by the engine. */
  readonly codexFailedRootVerified?: boolean;
  readonly codexFailedRootGenerationTransferVerified?: boolean;
  readonly codexRecoveryAcceptedVerified?: boolean;
  /** Only an exact occurrence claimed in the event commit transaction may set this. */
  readonly scheduledFollowUpVerified?: boolean;
}): Effect.fn.Return<DecideOrchestrationCommandResult, OrchestrationCommandInvariantError> {
  switch (command.type) {
    case "project.create": {
      yield* requireProjectAbsent({
        readModel,
        command,
        projectId: command.projectId,
      });

      return {
        ...withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "project.created",
        payload: {
          projectId: command.projectId,
          title: command.title,
          workspaceRoot: command.workspaceRoot,
          additionalWorkspaceRoots: command.additionalWorkspaceRoots ?? [],
          defaultModelSelection: command.defaultModelSelection ?? null,
          scripts: [],
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "project.meta.update": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "project.meta-updated",
        payload: {
          projectId: command.projectId,
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.workspaceRoot !== undefined ? { workspaceRoot: command.workspaceRoot } : {}),
          ...(command.additionalWorkspaceRoots !== undefined
            ? { additionalWorkspaceRoots: command.additionalWorkspaceRoots }
            : {}),
          ...(command.defaultModelSelection !== undefined
            ? { defaultModelSelection: command.defaultModelSelection }
            : {}),
          ...(command.scripts !== undefined ? { scripts: command.scripts } : {}),
          updatedAt: occurredAt,
        },
      };
    }

    case "project.delete": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      const projectThreads = listThreadsByProjectId(readModel, command.projectId).filter(
        (thread) => thread.deletedAt === null,
      );
      // Deleting an owner already cascades through its groups; do not issue a
      // second, differently tagged delete for a member it covers.
      const cascaded = new Set<string>();
      for (const thread of projectThreads) {
        for (const member of collectDeletionClosure(
          readModel,
          liveGroupsOwnedBy(readModel, thread.id),
        ).threads) {
          cascaded.add(member.id);
        }
      }
      const activeThreads = projectThreads.filter((thread) => !cascaded.has(thread.id));
      if (activeThreads.length > 0 && command.force !== true) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Project '${command.projectId}' is not empty and cannot be deleted without force=true.`,
        });
      }
      if (activeThreads.length > 0) {
        return yield* decideCommandSequence({
          readModel,
          commands: [
            ...activeThreads.map(
              (thread): Extract<OrchestrationCommand, { type: "thread.delete" }> => ({
                type: "thread.delete",
                commandId: command.commandId,
                threadId: thread.id,
              }),
            ),
            {
              type: "project.delete",
              commandId: command.commandId,
              projectId: command.projectId,
            },
          ],
        });
      }

      const occurredAt = yield* nowIso;
      return {
        ...withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "project.deleted" as const,
        payload: {
          projectId: command.projectId,
          deletedAt: occurredAt,
        },
      };
    }

    case "thread.create": {
      if (command.projectId !== null) {
        yield* requireProject({ readModel, command, projectId: command.projectId });
      } else if (command.branch !== null || command.worktreePath !== null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Standalone chats cannot select a branch or worktree.",
        });
      }
      yield* requireThreadAbsent({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (command.groupId !== undefined) {
        // The engine serializes commands, so a create decided after a group
        // delete is refused here and one decided before is in that delete's
        // closure. Neither path can leave an orphaned member.
        const group = findThreadGroup(readModel, command.groupId);
        const owner = group
          ? readModel.threads.find((thread) => thread.id === group.ownerThreadId)
          : undefined;
        if (!group || group.deletedAt !== null || !isLiveThread(owner)) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Thread group '${command.groupId}' is not available; it may have been deleted.`,
          });
        }
      }
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.created",
        payload: {
          threadId: command.threadId,
          projectId: command.projectId,
          title: command.title,
          modelSelection: command.modelSelection,
          ...(command.subagentLimits !== undefined
            ? { subagentLimits: command.subagentLimits }
            : {}),
          ...(command.codexContextWindowOverride !== undefined
            ? { codexContextWindowOverride: command.codexContextWindowOverride }
            : {}),
          runtimeMode: command.runtimeMode,
          interactionMode: command.interactionMode,
          branch: command.branch,
          worktreePath: command.worktreePath,
          ...(command.groupId !== undefined ? { groupId: command.groupId } : {}),
          ...(command.description !== undefined ? { description: command.description } : {}),
          ...recordedOriginFields(command.provenance, command.createdAt),
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.duplicate": {
      const sourceThread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.sourceThreadId,
      });
      if (sourceThread.deletedAt !== null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.sourceThreadId}' is in the Recycle Bin and cannot be duplicated.`,
        });
      }
      yield* requireThreadAbsent({
        readModel,
        command,
        threadId: command.targetThreadId,
      });

      const createdEventBase = withEventBase({
        aggregateKind: "thread",
        aggregateId: command.targetThreadId,
        occurredAt: command.createdAt,
        commandId: command.commandId,
      });
      return [
        {
          ...createdEventBase,
          type: "thread.created" as const,
          payload: {
            threadId: command.targetThreadId,
            projectId: sourceThread.projectId,
            title: command.title,
            modelSelection: sourceThread.modelSelection,
            ...(sourceThread.subagentLimits !== undefined
              ? { subagentLimits: sourceThread.subagentLimits }
              : {}),
            ...(sourceThread.codexContextWindowOverride !== undefined
              ? { codexContextWindowOverride: sourceThread.codexContextWindowOverride }
              : {}),
            runtimeMode: sourceThread.runtimeMode,
            interactionMode: sourceThread.interactionMode,
            branch: sourceThread.branch,
            worktreePath: sourceThread.worktreePath,
            // A copy is top level and owns no groups: membership is never
            // copied, so the source group cannot gain a duplicate row.
            ...(sourceThread.description ? { description: sourceThread.description } : {}),
            ...recordedOriginFields(
              {
                creationPath: "duplicate",
                originThreadId: command.sourceThreadId,
                recordedAt: command.createdAt,
              },
              command.createdAt,
            ),
            createdAt: command.createdAt,
            updatedAt: command.createdAt,
          },
        },
        {
          ...withEventBase({
            aggregateKind: "thread",
            aggregateId: command.targetThreadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          }),
          type: "thread.duplicated" as const,
          payload: {
            sourceThreadId: command.sourceThreadId,
            targetThreadId: command.targetThreadId,
            duplicatedAt: command.createdAt,
          },
        },
      ];
    }

    case "thread.fork":
      return yield* new OrchestrationCommandInvariantError({
        commandType: command.type,
        detail:
          "Provider-native thread forks must be prepared by the authenticated server transport.",
      });

    case "thread.fork.commit": {
      const sourceThread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.sourceThreadId,
      });
      if (sourceThread.deletedAt !== null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.sourceThreadId}' is in the Recycle Bin and cannot be forked.`,
        });
      }
      if (command.messageCutoff) {
        const boundary = yield* Effect.try({
          try: () =>
            resolveThreadForkMessageCutoff(sourceThread, command.messageCutoff!.sourceMessageId),
          catch: () =>
            new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: "The selected fork message is no longer available.",
            }),
        });
        if (
          encodeJsonString(boundary) !== encodeJsonString(command.messageCutoff) ||
          !command.retainedMessageIds ||
          !command.retainedMessageIds.includes(command.messageCutoff.sourceMessageId) ||
          new Set(command.retainedMessageIds).size !== command.retainedMessageIds.length ||
          command.retainedMessageIds.some(
            (id) => !sourceThread.messages.some((message) => message.id === id),
          ) ||
          sourceThread.session?.providerName !== "claudeAgent" ||
          sourceThread.session.providerInstanceId !== command.session.providerInstanceId ||
          sourceThread.modelSelection.instanceId !== command.session.providerInstanceId
        ) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: "The selected fork account or message boundary changed.",
          });
        }
      }
      if (
        sourceThread.latestTurn?.state === "running" ||
        sourceThread.session?.status === "starting" ||
        sourceThread.session?.status === "running"
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.sourceThreadId}' must be idle before it can be forked.`,
        });
      }
      yield* requireThreadAbsent({
        readModel,
        command,
        threadId: command.targetThreadId,
      });
      if (
        command.session.threadId !== command.targetThreadId ||
        command.session.status !== "stopped" ||
        command.session.activeTurnId !== null
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Fork commits require a stopped target provider session binding.",
        });
      }

      return [
        {
          ...withEventBase({
            aggregateKind: "thread",
            aggregateId: command.targetThreadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          }),
          type: "thread.created" as const,
          payload: {
            threadId: command.targetThreadId,
            projectId: sourceThread.projectId,
            title: command.title,
            modelSelection: sourceThread.modelSelection,
            runtimeMode: sourceThread.runtimeMode,
            ...(sourceThread.subagentLimits !== undefined
              ? { subagentLimits: sourceThread.subagentLimits }
              : {}),
            ...(sourceThread.codexContextWindowOverride !== undefined
              ? { codexContextWindowOverride: sourceThread.codexContextWindowOverride }
              : {}),
            interactionMode: sourceThread.interactionMode,
            branch: sourceThread.branch,
            worktreePath: sourceThread.worktreePath,
            ...(sourceThread.description ? { description: sourceThread.description } : {}),
            ...recordedOriginFields(
              {
                creationPath: "fork",
                originThreadId: command.sourceThreadId,
                recordedAt: command.createdAt,
              },
              command.createdAt,
            ),
            createdAt: command.createdAt,
            updatedAt: command.createdAt,
          },
        },
        {
          ...withEventBase({
            aggregateKind: "thread",
            aggregateId: command.targetThreadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          }),
          type: "thread.forked" as const,
          payload: {
            sourceThreadId: command.sourceThreadId,
            ...(command.messageCutoff ? { messageCutoff: command.messageCutoff } : {}),
            ...(command.retainedMessageIds
              ? { retainedMessageIds: command.retainedMessageIds }
              : {}),
            targetThreadId: command.targetThreadId,
            forkedAt: command.createdAt,
          },
        },
        {
          ...withEventBase({
            aggregateKind: "thread",
            aggregateId: command.targetThreadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          }),
          type: "thread.session-set" as const,
          payload: {
            threadId: command.targetThreadId,
            session: command.session,
          },
        },
      ];
    }

    case "thread.delete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      const deleted: PlannedOrchestrationEvent = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.deleted",
        payload: {
          threadId: command.threadId,
          deletionId: command.commandId,
          deletedAt: occurredAt,
        },
      };
      // Owned groups and their members join the same batch, so no member can
      // remain beneath a parent that is in the Recycle Bin.
      const cascade = collectDeletionClosure(
        readModel,
        liveGroupsOwnedBy(readModel, command.threadId),
      );
      if (cascade.groups.length === 0) return deleted;
      return [deleted, ...closureDeletionEvents(cascade, command.commandId, occurredAt)];
    }

    case "thread.restore": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (thread.deletedAt === null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' is not in the Recycle Bin.`,
        });
      }
      const occurredAt = yield* nowIso;
      const before: PlannedOrchestrationEvent[] = [];
      let detachFromGroup = false;
      if (thread.groupId) {
        const group = findThreadGroup(readModel, thread.groupId);
        const owner = group
          ? readModel.threads.find((entry) => entry.id === group.ownerThreadId)
          : undefined;
        if (!group || !isLiveThread(owner)) {
          // The parent is gone or in the Recycle Bin: return top level rather
          // than beneath an invisible owner.
          detachFromGroup = true;
        } else if (group.deletedAt !== null) {
          // Restore only the group shell; its other members stay deleted.
          before.push(
            ...closureRestoreEvents(
              { groups: [group], threads: [] },
              command.commandId,
              occurredAt,
            ),
          );
        }
      }
      const restored: PlannedOrchestrationEvent = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.restored",
        payload: {
          threadId: command.threadId,
          ...(detachFromGroup ? { detachFromGroup: true } : {}),
          updatedAt: occurredAt,
        },
      };
      // Restoring a thread also restores its own subtree, but only rows that
      // still carry this thread's exact deletion incarnation.
      const deletionId = thread.deletionId ?? null;
      const subtree =
        deletionId === null
          ? { groups: [], threads: [] }
          : collectRestoreClosure(
              readModel,
              threadGroups(readModel).filter((group) => group.ownerThreadId === thread.id),
              deletionId,
            );
      const after = closureRestoreEvents(subtree, command.commandId, occurredAt);
      if (before.length === 0 && after.length === 0) return restored;
      return [...before, restored, ...after];
    }

    case "thread.archive": {
      yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      // Archiving a parent also archives its group members, otherwise live
      // members would vanish beneath a parent the sidebar no longer shows.
      // Archive never stops sessions, so neither does the cascade.
      const members = collectArchiveClosure(readModel, command.threadId).threads.filter(
        (thread) => thread.archivedAt === null,
      );
      const archived = (threadId: OrchestrationThread["id"]): PlannedOrchestrationEvent => ({
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.archived",
        payload: {
          threadId,
          ...(members.length > 0 ? { archiveCascadeId: command.commandId } : {}),
          archivedAt: occurredAt,
          updatedAt: occurredAt,
        },
      });
      if (members.length === 0) return archived(command.threadId);
      return [archived(command.threadId), ...members.map((member) => archived(member.id))];
    }

    case "thread.unarchive": {
      const archivedThread = yield* requireThreadArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      const unarchived = (threadId: OrchestrationThread["id"]): PlannedOrchestrationEvent => ({
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.unarchived",
        payload: {
          threadId,
          updatedAt: occurredAt,
        },
      });
      // Reverse only the exact cascade this thread started. Members archived
      // independently carry another cascade ID (or none) and stay archived.
      const cascadeId = archivedThread.archiveCascadeId ?? null;
      const members =
        cascadeId === null
          ? []
          : readModel.threads.filter(
              (thread) =>
                thread.id !== archivedThread.id &&
                thread.archivedAt !== null &&
                thread.archiveCascadeId === cascadeId,
            );
      if (members.length === 0) return unarchived(command.threadId);
      return [unarchived(command.threadId), ...members.map((member) => unarchived(member.id))];
    }

    case "thread.metadata.update": {
      const thread = yield* requireThread({ readModel, command, threadId: command.threadId });
      if (thread.deletedAt !== null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "This chat is in the Recycle Bin.",
        });
      }
      if (command.originClassification === undefined && command.description === undefined) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "No metadata change was requested.",
        });
      }
      const occurredAt = yield* nowIso;
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.metadata-updated",
        payload: {
          threadId: command.threadId,
          // A saved label is the user's correction; provenance is untouched.
          ...(command.originClassification !== undefined
            ? {
                origin: {
                  classification: command.originClassification,
                  source: "user" as const,
                  updatedAt: occurredAt,
                },
              }
            : {}),
          ...(command.description !== undefined ? { description: command.description } : {}),
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.group.create": {
      const owner = yield* requireThread({ readModel, command, threadId: command.ownerThreadId });
      if (owner.deletedAt !== null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "The parent chat is in the Recycle Bin.",
        });
      }
      if (findThreadGroup(readModel, command.groupId)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread group '${command.groupId}' already exists.`,
        });
      }
      const ownerGroups = liveGroupsOwnedBy(readModel, owner.id);
      if (ownerGroups.length >= MAX_LIVE_THREAD_GROUPS_PER_OWNER) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `A chat can own at most ${MAX_LIVE_THREAD_GROUPS_PER_OWNER} live groups.`,
        });
      }
      const title = normalizedGroupTitle(command.title);
      if (ownerGroups.some((group) => normalizedGroupTitle(group.title) === title)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "This chat already has a group with that title.",
        });
      }
      const depth = threadGroupDepth(readModel, {
        id: command.groupId,
        ownerThreadId: owner.id,
        title: command.title,
        description: null,
        provenance: command.provenance,
        createdAt: command.createdAt,
        updatedAt: command.createdAt,
        deletedAt: null,
        deletionId: null,
      });
      if (depth > MAX_THREAD_GROUP_DEPTH) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Groups can be nested at most ${MAX_THREAD_GROUP_DEPTH} levels deep.`,
        });
      }
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: owner.id,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.group-created",
        payload: {
          groupId: command.groupId,
          ownerThreadId: owner.id,
          title: command.title,
          description: command.description ?? null,
          provenance: command.provenance,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.group.meta.update": {
      const group = findThreadGroup(readModel, command.groupId);
      if (!group || group.deletedAt !== null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread group '${command.groupId}' is not available.`,
        });
      }
      if (command.title === undefined && command.description === undefined) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "No group change was requested.",
        });
      }
      if (command.title !== undefined) {
        const title = normalizedGroupTitle(command.title);
        if (
          liveGroupsOwnedBy(readModel, group.ownerThreadId).some(
            (other) => other.id !== group.id && normalizedGroupTitle(other.title) === title,
          )
        ) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: "This chat already has a group with that title.",
          });
        }
      }
      const occurredAt = yield* nowIso;
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: group.ownerThreadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.group-meta-updated",
        payload: {
          groupId: group.id,
          ownerThreadId: group.ownerThreadId,
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.description !== undefined ? { description: command.description } : {}),
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.group.delete": {
      const group = findThreadGroup(readModel, command.groupId);
      if (!group || group.deletedAt !== null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread group '${command.groupId}' is not available; it may already be deleted.`,
        });
      }
      const occurredAt = yield* nowIso;
      // The parent (owner) thread is never part of its group's closure.
      return closureDeletionEvents(
        collectDeletionClosure(readModel, [group]),
        command.commandId,
        occurredAt,
      );
    }

    case "thread.group.restore": {
      const group = findThreadGroup(readModel, command.groupId);
      if (!group || group.deletedAt === null || group.deletionId === null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread group '${command.groupId}' is not in the Recycle Bin.`,
        });
      }
      const owner = readModel.threads.find((thread) => thread.id === group.ownerThreadId);
      if (!isLiveThread(owner)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Restore the parent chat first.",
        });
      }
      const occurredAt = yield* nowIso;
      return closureRestoreEvents(
        collectRestoreClosure(readModel, [group], group.deletionId),
        command.commandId,
        occurredAt,
      );
    }

    case "thread.meta.update": {
      const existingThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const associationChanged =
        command.projectId !== undefined && existingThread.projectId !== command.projectId;
      if (
        associationChanged &&
        (threadHasUnsettledTurnStart(existingThread) ||
          existingThread.latestTurn?.state === "running")
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "A chat must be idle before its project association can change.",
        });
      }
      const destinationProjectId =
        command.projectId === undefined ? existingThread.projectId : command.projectId;
      if (
        destinationProjectId === null &&
        (command.branch != null || command.worktreePath != null)
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Standalone chats cannot select a branch or worktree.",
        });
      }
      if (command.projectId !== undefined && command.projectId !== null) {
        const targetProject = yield* requireProject({
          readModel,
          command,
          projectId: command.projectId,
        });
        if (targetProject.deletedAt !== null) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `Project '${command.projectId}' has been deleted and cannot receive moved threads.`,
          });
        }
      }
      const occurredAt = yield* nowIso;
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.meta-updated",
        payload: {
          threadId: command.threadId,
          ...(command.projectId !== undefined ? { projectId: command.projectId } : {}),
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.modelSelection !== undefined
            ? { modelSelection: command.modelSelection }
            : {}),
          ...(command.subagentLimits !== undefined
            ? { subagentLimits: command.subagentLimits }
            : {}),
          ...(command.codexContextWindowOverride !== undefined
            ? { codexContextWindowOverride: command.codexContextWindowOverride }
            : {}),
          ...(associationChanged
            ? { branch: null }
            : command.branch !== undefined
              ? { branch: command.branch }
              : {}),
          ...(associationChanged
            ? { worktreePath: null }
            : command.worktreePath !== undefined
              ? { worktreePath: command.worktreePath }
              : {}),
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.runtime-mode.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.runtime-mode-set",
        payload: {
          threadId: command.threadId,
          runtimeMode: command.runtimeMode,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.interaction-mode.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.interaction-mode-set",
        payload: {
          threadId: command.threadId,
          interactionMode: command.interactionMode,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.turn.start": {
      const targetThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      // A chat in the Recycle Bin (for example after a group delete) must not
      // start new work through any path, including queued renderer rows.
      if (targetThread.deletedAt !== null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "This chat is in the Recycle Bin.",
        });
      }
      if (command.scheduledFollowUp !== undefined) {
        const scheduled = command.scheduledFollowUp;
        // Scheduling is idle-only. It must never inherit ordinary user-submit
        // recovery that steers a live turn or replaces its provider instance.
        // Validate authority first so a forged/retired occurrence cannot use a
        // busy rejection as permission to queue a new dispatch identity.
        if (
          !scheduledFollowUpVerified ||
          !command.commandId.startsWith("server:") ||
          targetThread.archivedAt !== null ||
          targetThread.deletedAt !== null ||
          command.bootstrap !== undefined ||
          command.runtimeRecovery !== undefined ||
          command.sourceProposedPlan !== undefined ||
          command.deliveryPriority !== undefined ||
          command.axiomWebEnabled === true ||
          command.runtimeMode !== targetThread.runtimeMode ||
          command.interactionMode !== targetThread.interactionMode ||
          scheduled.expectedRuntimeMode !== targetThread.runtimeMode ||
          scheduled.expectedInteractionMode !== targetThread.interactionMode ||
          !isDeepStrictEqual(scheduled.expectedModelSelection, targetThread.modelSelection) ||
          (command.modelSelection !== undefined &&
            command.modelSelection.instanceId !== targetThread.modelSelection.instanceId) ||
          (command.subagentLimits !== undefined &&
            !isDeepStrictEqual(command.subagentLimits, targetThread.subagentLimits ?? {})) ||
          (command.codexContextWindowOverride !== undefined &&
            command.codexContextWindowOverride !==
              (targetThread.codexContextWindowOverride ?? null))
        ) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: "Scheduled follow-up authorization no longer matches this chat.",
          });
        }
        if (threadHasUnsettledTurnStart(targetThread)) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: "Scheduled follow-up is waiting for an idle chat.",
          });
        }
      }
      if (command.runtimeRecovery !== undefined) {
        // Recovery applies to precisely one verified terminal root: either a
        // stopped lost owner or a failed root in the same healthy native
        // generation. It never grants permission to steer newer work or
        // reopen an archived thread. Stop has no reliable row representation, so this
        // snapshot comparison supplements (never replaces) the engine's
        // durable, sequence-ordered control barrier.
        const recovery = command.runtimeRecovery;
        const transient = recovery.codexTransientFailure;
        if (
          !runtimeRecoveryBarrierVerified ||
          !command.commandId.startsWith("server:") ||
          targetThread.archivedAt !== null ||
          targetThread.deletedAt !== null ||
          (transient === undefined
            ? targetThread.session?.status !== "stopped"
            : targetThread.session?.status !== "ready" ||
              targetThread.session.providerName !== "codex" ||
              targetThread.session.providerInstanceId !== transient.providerInstanceId ||
              targetThread.session.subagentRuntimeId !== transient.subagentRuntimeId ||
              targetThread.modelSelection.instanceId !== transient.providerInstanceId ||
              targetThread.latestTurn?.state !== "error" ||
              command.message.attachments.length !== 0) ||
          targetThread.session?.activeTurnId !== null ||
          targetThread.session?.updatedAt !== recovery.sessionUpdatedAt ||
          targetThread.latestTurn?.turnId !== recovery.turnId ||
          command.bootstrap !== undefined ||
          command.runtimeMode !== targetThread.runtimeMode ||
          command.interactionMode !== targetThread.interactionMode ||
          (command.modelSelection !== undefined &&
            !isDeepStrictEqual(command.modelSelection, targetThread.modelSelection)) ||
          (command.subagentLimits !== undefined &&
            !isDeepStrictEqual(command.subagentLimits, targetThread.subagentLimits ?? {})) ||
          (command.codexContextWindowOverride !== undefined &&
            command.codexContextWindowOverride !==
              (targetThread.codexContextWindowOverride ?? null))
        ) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: "Runtime recovery no longer matches the verified terminal turn.",
          });
        }
      }
      const boundProviderInstanceId =
        targetThread.session?.providerInstanceId ?? targetThread.session?.providerName;
      // Native reviews are explicit idle-only operations, never normal text
      // that can be recovered as a steer or unattended continuation.
      if (
        command.codexReview !== undefined &&
        (threadHasUnsettledTurnStart(targetThread) ||
          command.message.attachments.length > 0 ||
          command.runtimeMode !== targetThread.runtimeMode ||
          command.interactionMode !== targetThread.interactionMode ||
          (command.modelSelection !== undefined &&
            !isDeepStrictEqual(command.modelSelection, targetThread.modelSelection)) ||
          command.runtimeRecovery !== undefined ||
          command.scheduledFollowUp !== undefined ||
          command.sourceProposedPlan !== undefined)
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail:
            "Native review requires an idle chat and cannot include attachments or automatic continuation.",
        });
      }
      const requestsProviderInstanceSwitch =
        command.modelSelection !== undefined &&
        boundProviderInstanceId !== undefined &&
        command.modelSelection.instanceId !== boundProviderInstanceId;
      if (threadHasUnsettledTurnStart(targetThread) && !requestsProviderInstanceSwitch) {
        const activeTurnId = activeTurnIdForSteer(targetThread);
        // A start may become a steer when the renderer's ready snapshot lags.
        // Capture its exact canonical recipient now; replay must never borrow
        // a later Claude account or runtime merely because this chat still runs.
        let expectedPrioritySession: ProviderPrioritySessionBinding | undefined;
        if (command.deliveryPriority !== undefined) {
          const prioritySession = targetThread.session;
          if (
            prioritySession?.providerName !== "claudeAgent" ||
            prioritySession.providerInstanceId === undefined ||
            prioritySession.status !== "running" ||
            activeTurnId === null ||
            prioritySession.activeTurnId !== activeTurnId
          ) {
            return yield* new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: "Explicit delivery priority requires the exact active Claude session.",
            });
          }
          expectedPrioritySession = {
            providerInstanceId: prioritySession.providerInstanceId,
            subagentRuntimeId: prioritySession.subagentRuntimeId ?? null,
            activeTurnId,
          };
        }
        // The renderer can submit from an older ready snapshot while the
        // authoritative aggregate has already moved to `starting`. Claude can
        // also remain live while briefly projecting `running` without an
        // active turn id as SDK response segments cross a terminal-looking
        // boundary. Rejecting here loses the renderer's only durable handoff
        // and exposes a recoverable projection race to the user.
        //
        // Ordinary input persists one steer intent even when `activeTurnId`
        // is null; explicit priority was bound more narrowly above. The
        // ProviderCommandReactor resolves that intent against live provider
        // state in sequence: it steers a materialized active turn, or submits
        // the same message as the next turn when no active provider turn
        // remains. Command receipts keep exact retries idempotent, while the
        // original message id and attachments remain bound to one accepted
        // orchestration command.
        const userMessageEvent: Omit<OrchestrationEvent, "sequence"> = {
          ...withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          }),
          type: "thread.message-sent",
          payload: {
            threadId: command.threadId,
            messageId: command.message.messageId,
            role: "user",
            text: command.message.text,
            attachments: command.message.attachments,
            turnId: activeTurnId,
            streaming: false,
            createdAt: command.createdAt,
            updatedAt: command.createdAt,
          },
        };
        const turnSteerRequestedEvent: Omit<OrchestrationEvent, "sequence"> = {
          ...withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          }),
          causationEventId: userMessageEvent.eventId,
          type: "thread.turn-steer-requested",
          payload: {
            ...(command.axiomWebEnabled !== undefined
              ? { axiomWebEnabled: command.axiomWebEnabled }
              : {}),
            ...(command.axiomMcpRevision !== undefined
              ? { axiomMcpRevision: command.axiomMcpRevision }
              : {}),
            threadId: command.threadId,
            ...(command.deliveryPriority !== undefined
              ? {
                  deliveryPriority: command.deliveryPriority,
                  ...(expectedPrioritySession !== undefined ? { expectedPrioritySession } : {}),
                }
              : {}),
            messageId: command.message.messageId,
            expectedTurnId: activeTurnId,
            createdAt: command.createdAt,
          },
        };
        // A stale-ready submit can become a native steer. Retain its requested
        // policy as pending metadata, but never turn that edit into authority
        // to replace the process that still owns the active root/children.
        const pendingLimits: ReadonlyArray<PlannedOrchestrationEvent> =
          command.subagentLimits === undefined && command.codexContextWindowOverride === undefined
            ? []
            : [
                {
                  ...withEventBase({
                    aggregateKind: "thread",
                    aggregateId: command.threadId,
                    occurredAt: command.createdAt,
                    commandId: command.commandId,
                  }),
                  type: "thread.meta-updated",
                  payload: {
                    threadId: command.threadId,
                    ...(command.subagentLimits !== undefined
                      ? { subagentLimits: command.subagentLimits }
                      : {}),
                    ...(command.codexContextWindowOverride !== undefined
                      ? { codexContextWindowOverride: command.codexContextWindowOverride }
                      : {}),
                    updatedAt: command.createdAt,
                  },
                },
              ];
        return [...pendingLimits, userMessageEvent, turnSteerRequestedEvent];
      }
      // An explicit provider-instance change cannot be represented as a live
      // steer: provider steering APIs keep using the session that already owns
      // the active turn and do not accept a replacement routing key. Preserve
      // the requested model selection on a normal turn-start intent so the
      // provider reactor can replace stale runtime ownership before sending.
      // The renderer queues ordinary sends while a turn is genuinely active;
      // this branch handles the stale projection/runtime races that otherwise
      // make a composer-selected Codex turn run through Claude (or vice versa).
      const sourceProposedPlan = command.sourceProposedPlan;
      const sourceThread = sourceProposedPlan
        ? yield* requireThread({
            readModel,
            command,
            threadId: sourceProposedPlan.threadId,
          })
        : null;
      const sourcePlan =
        sourceProposedPlan && sourceThread
          ? sourceThread.proposedPlans.find((entry) => entry.id === sourceProposedPlan.planId)
          : null;
      if (sourceProposedPlan && !sourcePlan) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Proposed plan '${sourceProposedPlan.planId}' does not exist on thread '${sourceProposedPlan.threadId}'.`,
        });
      }
      if (
        sourceThread &&
        (sourceThread.projectId !== targetThread.projectId ||
          (targetThread.projectId === null && sourceThread.id !== targetThread.id))
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Proposed plan '${sourceProposedPlan?.planId}' belongs to thread '${sourceThread.id}' in a different project.`,
        });
      }
      const userMessageEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.message.messageId,
          role: "user",
          text: command.message.text,
          attachments: command.message.attachments,
          turnId: null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
      const turnStartRequestedEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        causationEventId: userMessageEvent.eventId,
        type: "thread.turn-start-requested",
        payload: {
          ...(command.axiomWebEnabled !== undefined
            ? { axiomWebEnabled: command.axiomWebEnabled }
            : {}),
          ...(command.axiomMcpRevision !== undefined
            ? { axiomMcpRevision: command.axiomMcpRevision }
            : {}),
          threadId: command.threadId,
          ...(command.deliveryPriority !== undefined
            ? { deliveryPriority: command.deliveryPriority }
            : {}),
          ...(command.codexReview !== undefined ? { codexReview: command.codexReview } : {}),
          messageId: command.message.messageId,
          ...(command.modelSelection !== undefined
            ? { modelSelection: command.modelSelection }
            : {}),
          ...(command.subagentLimits !== undefined
            ? { subagentLimits: command.subagentLimits }
            : {}),
          ...(command.codexContextWindowOverride !== undefined
            ? { codexContextWindowOverride: command.codexContextWindowOverride }
            : {}),
          ...(command.titleSeed !== undefined ? { titleSeed: command.titleSeed } : {}),
          runtimeMode: targetThread.runtimeMode,
          interactionMode: targetThread.interactionMode,
          ...(sourceProposedPlan !== undefined ? { sourceProposedPlan } : {}),
          ...(command.runtimeRecovery !== undefined
            ? { runtimeRecovery: command.runtimeRecovery }
            : {}),
          ...(command.scheduledFollowUp !== undefined
            ? { scheduledFollowUp: command.scheduledFollowUp }
            : {}),
          createdAt: command.createdAt,
        },
      };
      return [userMessageEvent, turnStartRequestedEvent];
    }

    case "thread.turn.interrupt": {
      const targetThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const activeTurnId =
        command.turnId ??
        targetThread.session?.activeTurnId ??
        (targetThread.latestTurn?.state === "running" ? targetThread.latestTurn.turnId : undefined);
      // Stamp the provider turn id onto the event before projections process it.
      // Projection handlers intentionally clear activeTurnId for interrupt
      // events, but provider reactors still need the upstream turn id to send a
      // valid Codex `turn/interrupt` request.
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.turn-interrupt-requested",
        payload: {
          threadId: command.threadId,
          ...(activeTurnId !== undefined && activeTurnId !== null ? { turnId: activeTurnId } : {}),
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.turn.steer": {
      const targetThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (targetThread.deletedAt !== null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "This chat is in the Recycle Bin.",
        });
      }
      const activeTurnId =
        targetThread.session?.status === "running" ? targetThread.session.activeTurnId : null;
      // Renderer attachment preparation and transport can race an account
      // switch. Only the observed recipient authorizes urgent steering; never
      // reinterpret a rejected binding as permission to start another turn.
      const expectedPrioritySession = command.expectedPrioritySession;
      if (
        command.deliveryPriority !== undefined &&
        (expectedPrioritySession === undefined ||
          targetThread.session?.providerName !== "claudeAgent" ||
          targetThread.session.providerInstanceId !== expectedPrioritySession.providerInstanceId ||
          activeTurnId !== expectedPrioritySession.activeTurnId ||
          (targetThread.session.subagentRuntimeId ?? null) !==
            expectedPrioritySession.subagentRuntimeId)
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "The explicit-priority Claude session changed. The message was not delivered.",
        });
      }
      const userMessageEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.message.messageId,
          role: "user",
          text: command.message.text,
          attachments: command.message.attachments,
          turnId: activeTurnId,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
      if (activeTurnId === null) {
        const turnStartRequestedEvent: Omit<OrchestrationEvent, "sequence"> = {
          ...withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          }),
          causationEventId: userMessageEvent.eventId,
          type: "thread.turn-start-requested",
          payload: {
            ...(command.axiomWebEnabled !== undefined
              ? { axiomWebEnabled: command.axiomWebEnabled }
              : {}),
            ...(command.axiomMcpRevision !== undefined
              ? { axiomMcpRevision: command.axiomMcpRevision }
              : {}),
            threadId: command.threadId,
            ...(command.deliveryPriority !== undefined
              ? { deliveryPriority: command.deliveryPriority }
              : {}),
            messageId: command.message.messageId,
            modelSelection: targetThread.modelSelection,
            runtimeMode: targetThread.runtimeMode,
            interactionMode: targetThread.interactionMode,
            ...(command.terminalRecovery !== undefined
              ? { terminalSteerRecovery: command.terminalRecovery }
              : {}),
            createdAt: command.createdAt,
          },
        };
        return [userMessageEvent, turnStartRequestedEvent];
      }
      const turnSteerRequestedEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        causationEventId: userMessageEvent.eventId,
        type: "thread.turn-steer-requested",
        payload: {
          ...(command.axiomWebEnabled !== undefined
            ? { axiomWebEnabled: command.axiomWebEnabled }
            : {}),
          ...(command.axiomMcpRevision !== undefined
            ? { axiomMcpRevision: command.axiomMcpRevision }
            : {}),
          threadId: command.threadId,
          ...(command.deliveryPriority !== undefined
            ? { deliveryPriority: command.deliveryPriority }
            : {}),
          messageId: command.message.messageId,
          expectedTurnId: activeTurnId,
          ...(command.deliveryPriority !== undefined && expectedPrioritySession !== undefined
            ? { expectedPrioritySession }
            : {}),
          ...(command.terminalRecovery !== undefined
            ? { terminalSteerRecovery: command.terminalRecovery }
            : {}),
          createdAt: command.createdAt,
        },
      };
      return [userMessageEvent, turnSteerRequestedEvent];
    }

    case "thread.approval.respond": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {
            requestId: command.requestId,
          },
        }),
        type: "thread.approval-response-requested",
        payload: {
          threadId: command.threadId,
          requestId: command.requestId,
          decision: command.decision,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.mcp-user-input.respond": {
      const thread = yield* requireThread({ readModel, command, threadId: command.threadId });
      if (thread.archivedAt !== null || thread.deletedAt !== null)
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "This chat is no longer available for a question response.",
        });
      const request = derivePendingQuestionRequests(thread.activities).find(
        (entry) => entry.requestId === command.requestId,
      );
      const validated = validatePendingQuestionResponse(request, {
        expectedRequestCreatedAt: command.expectedRequestCreatedAt,
        answers: command.answers,
        ...(command.unanswered !== undefined ? { unanswered: command.unanswered } : {}),
      });
      if (!validated.ok)
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: validated.reason,
        });
      // The policy helper refuses an absent request. Keep that ownership
      // explicit for the saved snapshot instead of reconstructing wording
      // after the provider has consumed its callback.
      if (!request)
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "This question is no longer available.",
        });
      const hasAnswers = Object.keys(validated.answers).length > 0;
      const dispositions = Object.values(validated.unanswered ?? {});
      if (
        (command.action === "answered" && !hasAnswers) ||
        (command.action !== "answered" && hasAnswers) ||
        (command.action === "skipped" && dispositions.some((value) => value !== "skipped")) ||
        (command.action === "cleared" && dispositions.some((value) => value !== "dismissed"))
      )
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "The requested question action does not match its response.",
        });
      yield* Effect.try({
        try: () => {
          // A mixed answer can contain all three actual dispositions. Check
          // each eventual receipt now: a native success must not newly fail
          // because its exact question text exceeds the presentation budget.
          for (const action of ["answered", "skipped", "cleared"] as const) {
            const items = makeNativeMcpQuestionResolutionItems({
              questions: request.questions,
              answers: validated.answers,
              ...(validated.unanswered !== undefined ? { unanswered: validated.unanswered } : {}),
              action,
            });
            if (items.length === 0) continue;
            makeMcpQuestionResolutionActivity({
              noticeMessageId: command.noticeMessageId,
              action,
              items,
              createdAt: command.createdAt,
            });
          }
        },
        catch: () =>
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: "The complete question and response are too large or invalid to record safely.",
          }),
      });
      // This is an intent acknowledgement only. The provider reactor publishes
      // the notice after the exact native callback succeeds, not at dispatch.
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: { requestId: command.requestId },
        }),
        type: "thread.user-input-response-requested",
        payload: {
          threadId: command.threadId,
          requestId: command.requestId,
          answers: validated.answers,
          ...(validated.unanswered !== undefined ? { unanswered: validated.unanswered } : {}),
          mcpResponse: {
            requestCreatedAt: command.expectedRequestCreatedAt,
            noticeMessageId: command.noticeMessageId,
            action: command.action,
            questions: request.questions,
          },
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.user-input.respond": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {
            requestId: command.requestId,
          },
        }),
        type: "thread.user-input-response-requested",
        payload: {
          threadId: command.threadId,
          requestId: command.requestId,
          answers: command.answers,
          ...(command.unanswered !== undefined ? { unanswered: command.unanswered } : {}),
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.user-input.snooze": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {
            requestId: command.requestId,
          },
        }),
        type: "thread.user-input-snooze-requested",
        payload: {
          threadId: command.threadId,
          requestId: command.requestId,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.checkpoint.revert": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (thread.projectId === null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Standalone chats do not have project filesystem checkpoints.",
        });
      }
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.checkpoint-revert-requested",
        payload: {
          threadId: command.threadId,
          turnCount: command.turnCount,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.session.stop": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.session-stop-requested",
        payload: {
          threadId: command.threadId,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.compact": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (
        !thread.session ||
        thread.session.providerInstanceId !== command.providerInstanceId ||
        (thread.session.providerName !== "codex" && thread.session.providerName !== "opencode")
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Select the existing Codex or OpenCode conversation before compacting.",
        });
      }
      if (threadHasUnsettledTurnStart(thread)) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Wait for the current turn to finish before compacting.",
        });
      }
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.compaction-requested",
        payload: {
          threadId: command.threadId,
          providerInstanceId: command.providerInstanceId,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.goal.set": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (
        command.objective === undefined &&
        command.status === undefined &&
        command.tokenBudget === undefined
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "A goal update must change objective, status, or token budget.",
        });
      }
      if (
        command.replaceExisting === true &&
        (command.objective === undefined || command.objective === null)
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Replacing a goal requires a new objective.",
        });
      }
      if (
        command.expectedUpdatedAt !== undefined &&
        command.expectedUpdatedAt !== (thread.goal?.updatedAt ?? null)
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail:
            "The provider goal changed after this editor opened. Refresh the goal and apply the change again.",
        });
      }
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.goal-set-requested",
        payload: {
          threadId: command.threadId,
          ...(command.objective !== undefined ? { objective: command.objective } : {}),
          ...(command.status !== undefined ? { status: command.status } : {}),
          ...(command.tokenBudget !== undefined ? { tokenBudget: command.tokenBudget } : {}),
          ...(command.replaceExisting !== undefined
            ? { replaceExisting: command.replaceExisting }
            : {}),
          ...(command.expectedUpdatedAt !== undefined
            ? { expectedUpdatedAt: command.expectedUpdatedAt }
            : {}),
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.goal.clear": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (
        command.expectedUpdatedAt !== undefined &&
        command.expectedUpdatedAt !== (thread.goal?.updatedAt ?? null)
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail:
            "The provider goal changed after this editor opened. Refresh the goal before clearing it.",
        });
      }
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.goal-clear-requested",
        payload: {
          threadId: command.threadId,
          ...(command.expectedUpdatedAt !== undefined
            ? { expectedUpdatedAt: command.expectedUpdatedAt }
            : {}),
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.session.set": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Normalize the captured guard as well as the live state. Legacy guards
      // may omit a null native generation after SQL hydration, while the
      // in-memory projector still retains an explicit clear from startup.
      const expectedLifecycle =
        command.expectedSessionLifecycle === undefined
          ? undefined
          : sessionLifecycleSnapshot(command.expectedSessionLifecycle);
      const currentLifecycle = sessionLifecycleSnapshot(thread.session);
      if (
        command.expectedSubagentRuntimeId !== undefined &&
        command.expectedSubagentRuntimeId !== (thread.session?.subagentRuntimeId ?? null)
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: SESSION_LIFECYCLE_SUPERSEDED,
        });
      }
      const sameConcreteLifecycle =
        expectedLifecycle != null &&
        currentLifecycle !== null &&
        expectedLifecycle.activeTurnId !== null &&
        expectedLifecycle.activeTurnId === currentLifecycle.activeTurnId &&
        expectedLifecycle.status === currentLifecycle.status &&
        expectedLifecycle.providerName === currentLifecycle.providerName &&
        expectedLifecycle.providerInstanceId === currentLifecycle.providerInstanceId &&
        expectedLifecycle.subagentRuntimeId === currentLifecycle.subagentRuntimeId;
      if (
        expectedLifecycle !== undefined &&
        !sameConcreteLifecycle &&
        !isDeepStrictEqual(expectedLifecycle, currentLifecycle)
      ) {
        // Provider ingestion runs independently of user intent/ACK admission.
        // Recheck its captured tuple here, where a later start or Stop cannot
        // interleave with the resulting session mutation. Provider clocks are
        // not an ordering authority, so deliberately compare identity/state
        // rather than rejecting all events with older timestamps. A heartbeat
        // can change only the clock for the exact same concrete active turn;
        // it must not invalidate that turn's genuine terminal notification.
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: SESSION_LIFECYCLE_SUPERSEDED,
        });
      }
      const failedRoot = command.codexFailedRoot;
      const recoveryAccepted = command.codexRecoveryAccepted;
      if (
        recoveryAccepted !== undefined &&
        (!codexRecoveryAcceptedVerified ||
          !command.commandId.startsWith("server:") ||
          command.expectedSessionLifecycle === undefined ||
          command.expectedSubagentRuntimeId == null ||
          thread.archivedAt !== null ||
          thread.deletedAt !== null ||
          thread.session == null ||
          thread.session.status === "stopped" ||
          thread.session.status === "interrupted" ||
          thread.session.providerName !== "codex" ||
          thread.session.providerInstanceId !== command.session.providerInstanceId ||
          thread.modelSelection.instanceId !== command.session.providerInstanceId ||
          (thread.latestTurn?.turnId !== recoveryAccepted.previousTurnId &&
            thread.latestTurn?.turnId !== recoveryAccepted.turnId) ||
          (thread.latestTurn?.turnId === recoveryAccepted.previousTurnId &&
            thread.latestTurn.state !== "error") ||
          (thread.latestTurn?.turnId === recoveryAccepted.turnId &&
            thread.latestTurn.state !== "running") ||
          (thread.session.activeTurnId !== null &&
            thread.session.activeTurnId !== recoveryAccepted.turnId) ||
          command.session.threadId !== command.threadId ||
          command.session.providerName !== "codex" ||
          command.session.status !== "running" ||
          command.session.activeTurnId !== recoveryAccepted.turnId ||
          command.session.subagentRuntimeId == null ||
          recoveryAccepted.turnId === recoveryAccepted.previousTurnId ||
          command.codexFailedRoot !== undefined ||
          command.codexRootReplacement !== undefined ||
          command.terminalTurnRecovery !== undefined)
      )
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Codex recovery acceptance is no longer authorized.",
        });
      if (
        failedRoot !== undefined &&
        (!codexFailedRootVerified ||
          !command.commandId.startsWith("server:") ||
          command.expectedSessionLifecycle === undefined ||
          command.expectedSubagentRuntimeId == null ||
          thread.archivedAt !== null ||
          thread.deletedAt !== null ||
          (thread.session?.status !== "ready" && thread.session?.status !== "error") ||
          thread.session.providerName !== "codex" ||
          thread.session.activeTurnId !== null ||
          thread.session.providerInstanceId !== command.session.providerInstanceId ||
          // Only the engine's immutable old-intent/new-ACK join may transfer
          // generations. This context is not a client command or event field.
          (thread.session.subagentRuntimeId !== command.session.subagentRuntimeId &&
            !codexFailedRootGenerationTransferVerified) ||
          thread.modelSelection.instanceId !== command.session.providerInstanceId ||
          (thread.latestTurn?.turnId !== failedRoot.previousTurnId &&
            thread.latestTurn?.turnId !== failedRoot.turnId) ||
          (thread.latestTurn?.turnId === failedRoot.previousTurnId &&
            thread.latestTurn.state !== "error") ||
          (thread.latestTurn?.turnId === failedRoot.turnId &&
            thread.latestTurn.state !== "error" &&
            thread.latestTurn.state !== "running") ||
          failedRoot.turnId === failedRoot.previousTurnId ||
          command.session.threadId !== command.threadId ||
          command.session.status !== "ready" ||
          command.session.providerName !== "codex" ||
          command.session.activeTurnId !== null ||
          command.session.lastError === null ||
          command.session.updatedAt !== failedRoot.completedAt ||
          command.terminalTurnRecovery !== undefined ||
          command.codexRootReplacement !== undefined)
      )
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Codex failed-root acceptance is no longer authorized.",
        });
      const replacement = command.codexRootReplacement;
      if (
        replacement !== undefined &&
        (!codexRootReplacementVerified ||
          !String(command.commandId).startsWith("server:") ||
          thread.archivedAt !== null ||
          thread.deletedAt !== null ||
          thread.session?.status !== "running" ||
          thread.session.providerName !== "codex" ||
          thread.session.activeTurnId !== replacement.expectedTurnId ||
          thread.session.providerInstanceId !== replacement.providerInstanceId ||
          (thread.latestTurn !== null && thread.latestTurn.turnId !== replacement.expectedTurnId) ||
          command.session.threadId !== command.threadId ||
          command.session.status !== "running" ||
          command.session.providerName !== "codex" ||
          command.session.providerInstanceId !== replacement.providerInstanceId ||
          command.session.activeTurnId === null ||
          command.session.activeTurnId === replacement.expectedTurnId)
      ) {
        // Inventory RPCs happen outside this serialized boundary. Neither a
        // previously valid snapshot nor a late successful native ACK may
        // override Stop, a newer turn, or a changed provider route admitted in
        // the meantime. Keep the failure fixed and free of private identifiers.
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Codex completed-root replacement is no longer authorized.",
        });
      }
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {},
        }),
        type: "thread.session-set",
        payload: {
          threadId: command.threadId,
          session: command.session,
          ...(failedRoot !== undefined ? { codexFailedRoot: failedRoot } : {}),
          ...(command.terminalTurnRecovery !== undefined
            ? { terminalTurnRecovery: command.terminalTurnRecovery }
            : {}),
        },
      };
    }

    case "thread.goal.sync": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (command.goal !== null && command.goal.threadId !== command.threadId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Provider goal thread identity does not match the Cafe thread.",
        });
      }
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.goal-synced",
        payload: {
          threadId: command.threadId,
          goal: command.goal,
        },
      };
    }

    case "thread.message.assistant.delta": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          role: "assistant",
          text: command.delta,
          turnId: command.turnId ?? null,
          streaming: true,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.message.assistant.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          role: "assistant",
          // A non-empty terminal payload is replacement text in every
          // projection/renderer reducer. Provider ingestion supplies it only
          // after binding the completed item to all observed stream deltas.
          text: command.finalText ?? "",
          turnId: command.turnId ?? null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.message.assistant.repair-suffix": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.message.assistant-repair-applied",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          turnId: command.turnId,
          suffix: command.suffix,
          provider: command.provider,
          ...(command.providerInstanceId !== undefined
            ? { providerInstanceId: command.providerInstanceId }
            : {}),
          ...(command.itemId !== undefined ? { itemId: command.itemId } : {}),
          ...(command.source !== undefined ? { source: command.source } : {}),
          ...(command.sourceEventId !== undefined ? { sourceEventId: command.sourceEventId } : {}),
          oldLength: command.oldLength,
          newLength: command.newLength,
          appendedLength: command.appendedLength,
          repairedAt: command.createdAt,
        },
      };
    }

    case "thread.proposed-plan.upsert": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.proposed-plan-upserted",
        payload: {
          threadId: command.threadId,
          proposedPlan: command.proposedPlan,
        },
      };
    }

    case "thread.turn.diff.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.turn-diff-completed",
        payload: {
          threadId: command.threadId,
          turnId: command.turnId,
          checkpointTurnCount: command.checkpointTurnCount,
          checkpointRef: command.checkpointRef,
          status: command.status,
          files: command.files,
          assistantMessageId: command.assistantMessageId ?? null,
          completedAt: command.completedAt,
        },
      };
    }

    case "thread.revert.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.reverted",
        payload: {
          threadId: command.threadId,
          turnCount: command.turnCount,
        },
      };
    }

    case "thread.async-question.answer":
    case "thread.mcp-async-questions.resolve": {
      const thread = yield* requireThread({ readModel, command, threadId: command.threadId });
      const activity = thread.activities.find((entry) => entry.id === command.activityId);
      const payload = activity?.payload;
      if (
        thread.archivedAt !== null ||
        thread.deletedAt !== null ||
        activity?.kind !== "provider.async-questions" ||
        !/^codex-async-questions:[a-f0-9]{64}$/u.test(command.activityId) ||
        !payload ||
        typeof payload !== "object" ||
        Array.isArray(payload)
      )
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "This question is no longer available.",
        });
      const source = payload as Record<string, unknown>;
      const questions = normalizeCodexAsyncQuestions(source.questions);
      const indexes =
        command.type === "thread.async-question.answer"
          ? [command.questionIndex]
          : command.questionIndexes;
      const handled =
        source.handledQuestionIndexes === undefined ? [] : source.handledQuestionIndexes;
      if (
        typeof source.itemId !== "string" ||
        source.itemId.length === 0 ||
        source.itemId.length > 512 ||
        indexes.length === 0 ||
        indexes.length > 16 ||
        new Set(indexes).size !== indexes.length ||
        indexes.some(
          (index) => !Number.isSafeInteger(index) || index < 0 || index >= questions.length,
        ) ||
        !Array.isArray(handled) ||
        handled.length > 16 ||
        handled.some(
          (index) => !Number.isSafeInteger(index) || index < 0 || index >= questions.length,
        )
      )
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "The question selection is invalid.",
        });
      if (indexes.some((index) => handled.includes(index)))
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "This question has already been handled.",
        });
      const commands: OrchestrationCommand[] = [];
      if (command.type === "thread.async-question.answer") {
        const text = formatCodexAsyncQuestionAnswer(
          questions[command.questionIndex]!.title,
          command.answer,
        );
        if (text === null)
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: "The answer is empty, invalid, or too long.",
          });
        commands.push({
          type: "thread.turn.start",
          commandId: command.commandId,
          threadId: command.threadId,
          message: { messageId: command.messageId, role: "user", text, attachments: [] },
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          createdAt: command.createdAt,
        });
      }
      commands.push({
        type: "thread.async-questions.resolve",
        commandId: command.commandId,
        threadId: command.threadId,
        activityId: command.activityId,
        questionIndexes: indexes,
        createdAt: command.createdAt,
      });
      const notice = yield* Effect.try({
        try: () => {
          const action =
            command.type === "thread.async-question.answer" ? "answered" : command.action;
          const items: McpQuestionResolutionItem[] = indexes.map((index) => ({
            question: {
              id: `${command.activityId}:${index}`,
              header: "",
              question: questions[index]!.title,
            },
            ...(command.type === "thread.async-question.answer"
              ? { answer: command.answer.trim() }
              : {
                  disposition: action === "skipped" ? ("skipped" as const) : ("dismissed" as const),
                }),
          }));
          return mcpQuestionNotice(command, action, items);
        },
        catch: () =>
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: "The complete question and response are too large or invalid to record safely.",
          }),
      });
      commands.push(notice);
      // The engine rehydrates the exact persisted question under its writer;
      // all message/turn intent, handled indexes and notice events commit or
      // roll back together. No provider request is issued by this decision.
      return yield* decideCommandSequence({ commands, readModel });
    }

    case "thread.async-questions.resolve": {
      const thread = yield* requireThread({ readModel, command, threadId: command.threadId });
      const activity = thread.activities.find((entry) => entry.id === command.activityId);
      const payload = activity?.payload;
      if (
        activity?.kind !== "provider.async-questions" ||
        !/^codex-async-questions:[a-f0-9]{64}$/u.test(command.activityId) ||
        !payload ||
        typeof payload !== "object" ||
        Array.isArray(payload)
      )
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "This question is no longer available.",
        });
      const source = payload as Record<string, unknown>;
      const questions = normalizeCodexAsyncQuestions(source.questions);
      if (
        !command.questionIndexes.length ||
        command.questionIndexes.length > 16 ||
        command.questionIndexes.some(
          (index) => !Number.isSafeInteger(index) || index < 0 || index >= questions.length,
        )
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "The question selection is invalid.",
        });
      }
      const previous = Array.isArray(source.handledQuestionIndexes)
        ? source.handledQuestionIndexes
            .slice(0, 16)
            .filter(
              (index): index is number =>
                Number.isSafeInteger(index) && index >= 0 && index < questions.length,
            )
        : [];
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.activity-appended",
        payload: {
          threadId: command.threadId,
          activity: {
            ...activity,
            payload: {
              ...source,
              handledQuestionIndexes: [...new Set([...previous, ...command.questionIndexes])].sort(
                (a, b) => a - b,
              ),
            },
          },
        },
      };
    }

    case "thread.activity.append": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (
        command.expectedSubagentRuntimeId !== undefined &&
        command.expectedSubagentRuntimeId !== (thread.session?.subagentRuntimeId ?? null)
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: SESSION_LIFECYCLE_SUPERSEDED,
        });
      }
      const requestId =
        typeof command.activity.payload === "object" &&
        command.activity.payload !== null &&
        "requestId" in command.activity.payload &&
        typeof (command.activity.payload as { requestId?: unknown }).requestId === "string"
          ? ((command.activity.payload as { requestId: string })
              .requestId as OrchestrationEvent["metadata"]["requestId"])
          : undefined;
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          ...(requestId !== undefined ? { metadata: { requestId } } : {}),
        }),
        type: "thread.activity-appended",
        payload: {
          threadId: command.threadId,
          activity: command.activity,
        },
      };
    }

    default: {
      command satisfies never;
      const fallback = command as never as { type: string };
      return yield* new OrchestrationCommandInvariantError({
        commandType: fallback.type,
        detail: `Unknown command type: ${fallback.type}`,
      });
    }
  }
});
