import type {
  ManualFollowUpDispatchOptions,
  OrchestrationCommand,
  OrchestrationEvent,
  OrchestrationReadModel,
  OrchestrationThread,
  ThreadAutoNudgeConfig,
} from "@cafecode/contracts";
import {
  DEFAULT_THREAD_AUTO_NUDGE_CONFIG,
  MANUAL_FOLLOW_UP_MAX_ITEMS,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  THREAD_AUTO_NUDGE_MAX_AUTHORITY_REVISION,
} from "@cafecode/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

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

type DecideOrchestrationCommandResult =
  | PlannedOrchestrationEvent
  | ReadonlyArray<PlannedOrchestrationEvent>;

function threadHasUnsettledTurnStart(thread: OrchestrationReadModel["threads"][number]): boolean {
  if (thread.session?.status === "starting" || thread.session?.status === "running") {
    return true;
  }
  if (thread.session?.activeTurnId !== null && thread.session?.activeTurnId !== undefined) {
    return true;
  }
  return false;
}

function isActiveProviderActivityKind(kind: string): boolean {
  return (
    kind.endsWith(".started") ||
    kind.endsWith(".progress") ||
    kind.endsWith(".updated") ||
    kind.endsWith(".requested")
  );
}

function isAutoNudgeInvalidatingProviderActivityKind(kind: string): boolean {
  return kind !== "context-window.updated" && kind !== "checkpoint.captured";
}

function threadHasPostCompletionProviderActivity(
  thread: OrchestrationReadModel["threads"][number],
  completedTurnId: NonNullable<OrchestrationReadModel["threads"][number]["latestTurn"]>["turnId"],
): boolean {
  const completedAt = thread.latestTurn?.completedAt;
  if (completedAt === null || completedAt === undefined) {
    return false;
  }

  const messageContinued = thread.messages.some(
    (message) =>
      message.turnId === completedTurnId &&
      (message.updatedAt > completedAt || (message.updatedAt === completedAt && message.streaming)),
  );
  if (messageContinued) {
    return true;
  }

  return thread.activities.some(
    (activity) =>
      activity.turnId === completedTurnId &&
      isAutoNudgeInvalidatingProviderActivityKind(activity.kind) &&
      (activity.createdAt > completedAt ||
        (activity.createdAt === completedAt && isActiveProviderActivityKind(activity.kind))),
  );
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

function manualFollowUpDispatchesMatch(
  reserved: ManualFollowUpDispatchOptions,
  candidate: ManualFollowUpDispatchOptions,
): boolean {
  const reservedOptions = reserved.modelSelection.options ?? [];
  const candidateOptions = candidate.modelSelection.options ?? [];
  const reservedSource = reserved.sourceProposedPlan;
  const candidateSource = candidate.sourceProposedPlan;

  return (
    reserved.modelSelection.instanceId === candidate.modelSelection.instanceId &&
    reserved.modelSelection.model === candidate.modelSelection.model &&
    reservedOptions.length === candidateOptions.length &&
    reservedOptions.every(
      (option, index) =>
        option.id === candidateOptions[index]?.id &&
        option.value === candidateOptions[index]?.value,
    ) &&
    reserved.titleSeed === candidate.titleSeed &&
    reserved.runtimeMode === candidate.runtimeMode &&
    reserved.interactionMode === candidate.interactionMode &&
    (reservedSource === undefined
      ? candidateSource === undefined
      : candidateSource !== undefined &&
        reservedSource.threadId === candidateSource.threadId &&
        reservedSource.planId === candidateSource.planId)
  );
}

function currentThreadAutoNudgeConfig(thread: OrchestrationThread): ThreadAutoNudgeConfig {
  return thread.autoNudge ?? DEFAULT_THREAD_AUTO_NUDGE_CONFIG;
}

function nextAutoNudgeAuthorityRevision(input: {
  readonly command: OrchestrationCommand;
  readonly current: ThreadAutoNudgeConfig;
}): Effect.Effect<number, OrchestrationCommandInvariantError> {
  if (input.current.authorityRevision >= THREAD_AUTO_NUDGE_MAX_AUTHORITY_REVISION) {
    return Effect.fail(
      new OrchestrationCommandInvariantError({
        commandType: input.command.type,
        detail: "Auto Nudge authority revision is exhausted and cannot advance safely.",
      }),
    );
  }
  return Effect.succeed(input.current.authorityRevision + 1);
}

function revokeAutoNudgeAuthorityRevision(current: ThreadAutoNudgeConfig): number {
  if (current.mode === "off") {
    return current.authorityRevision;
  }
  return Math.min(current.authorityRevision + 1, THREAD_AUTO_NUDGE_MAX_AUTHORITY_REVISION);
}

/**
 * Terminal thread lifecycle operations must revoke automation in the same
 * server-authored event batch. Otherwise a renderer with stale authority can
 * race the lifecycle command and submit paid provider work against a thread
 * that is being removed or rewound.
 */
function planThreadAutoNudgeStop(input: {
  readonly thread: OrchestrationThread;
  readonly command: Pick<OrchestrationCommand, "commandId"> & {
    readonly threadId: OrchestrationThread["id"];
  };
  readonly stoppedAt: string;
}): PlannedOrchestrationEvent {
  return {
    ...withEventBase({
      aggregateKind: "thread",
      aggregateId: input.command.threadId,
      occurredAt: input.stoppedAt,
      commandId: input.command.commandId,
    }),
    type: "thread.auto-nudge-stopped",
    payload: {
      threadId: input.command.threadId,
      authorityRevision: revokeAutoNudgeAuthorityRevision(
        currentThreadAutoNudgeConfig(input.thread),
      ),
      stoppedAt: input.stoppedAt,
    },
  };
}

function rejectAutoNudgeCommand(command: OrchestrationCommand, detail: string) {
  return Effect.fail(new OrchestrationCommandInvariantError({ commandType: command.type, detail }));
}

function rejectManualFollowUpCommand(command: OrchestrationCommand, detail: string) {
  return Effect.fail(new OrchestrationCommandInvariantError({ commandType: command.type, detail }));
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
}: {
  readonly command: OrchestrationCommand;
  readonly readModel: OrchestrationReadModel;
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
      const activeThreads = listThreadsByProjectId(readModel, command.projectId).filter(
        (thread) => thread.deletedAt === null,
      );
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
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      yield* requireThreadAbsent({
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
        type: "thread.created",
        payload: {
          threadId: command.threadId,
          projectId: command.projectId,
          title: command.title,
          modelSelection: command.modelSelection,
          runtimeMode: command.runtimeMode,
          interactionMode: command.interactionMode,
          branch: command.branch,
          worktreePath: command.worktreePath,
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
            runtimeMode: sourceThread.runtimeMode,
            interactionMode: sourceThread.interactionMode,
            branch: sourceThread.branch,
            worktreePath: sourceThread.worktreePath,
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

    case "thread.delete": {
      const targetThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      const stopEvent = planThreadAutoNudgeStop({
        thread: targetThread,
        command,
        stoppedAt: occurredAt,
      });
      const deletedEvent: PlannedOrchestrationEvent = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.deleted",
        payload: {
          threadId: command.threadId,
          deletedAt: occurredAt,
        },
      };
      return [stopEvent, deletedEvent];
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
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.restored",
        payload: {
          threadId: command.threadId,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.archive": {
      const targetThread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      const stopEvent = planThreadAutoNudgeStop({
        thread: targetThread,
        command,
        stoppedAt: occurredAt,
      });
      const archivedEvent: PlannedOrchestrationEvent = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        }),
        type: "thread.archived",
        payload: {
          threadId: command.threadId,
          archivedAt: occurredAt,
          updatedAt: occurredAt,
        },
      };
      return [stopEvent, archivedEvent];
    }

    case "thread.unarchive": {
      yield* requireThreadArchived({
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
        type: "thread.unarchived",
        payload: {
          threadId: command.threadId,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.meta.update": {
      const existingThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      let clearWorktreePathForProjectMove = false;
      if (command.projectId !== undefined) {
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
        clearWorktreePathForProjectMove =
          existingThread.projectId !== command.projectId && command.worktreePath === undefined;
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
          ...(command.branch !== undefined ? { branch: command.branch } : {}),
          ...(command.worktreePath !== undefined
            ? { worktreePath: command.worktreePath }
            : clearWorktreePathForProjectMove
              ? { worktreePath: null }
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

    case "thread.auto-nudge.configure": {
      const targetThread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (targetThread.deletedAt !== null) {
        return yield* rejectAutoNudgeCommand(
          command,
          `Thread '${command.threadId}' is in the Recycle Bin and cannot configure Auto Nudge.`,
        );
      }
      const current = currentThreadAutoNudgeConfig(targetThread);
      if (command.expectedAuthorityRevision !== current.authorityRevision) {
        return yield* rejectAutoNudgeCommand(
          command,
          `Auto Nudge authority revision for thread '${command.threadId}' is stale.`,
        );
      }
      const authorityRevision = yield* nextAutoNudgeAuthorityRevision({ command, current });
      const configuredAt = yield* nowIso;
      const config: ThreadAutoNudgeConfig =
        command.mode === "off"
          ? {
              ...DEFAULT_THREAD_AUTO_NUDGE_CONFIG,
              authorityRevision,
              prompt: command.prompt,
              maxRounds: command.maxRounds,
            }
          : {
              ...DEFAULT_THREAD_AUTO_NUDGE_CONFIG,
              authorityRevision,
              mode: command.mode,
              prompt: command.prompt,
              backgroundContinuation: command.backgroundContinuation,
              maxRounds: command.maxRounds,
              armedAt: configuredAt,
              baselineSettledTurnId:
                targetThread.latestTurn !== null &&
                targetThread.latestTurn.state !== "running" &&
                targetThread.latestTurn.completedAt !== null
                  ? targetThread.latestTurn.turnId
                  : null,
            };
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: configuredAt,
          commandId: command.commandId,
        }),
        type: "thread.auto-nudge-configured",
        payload: { threadId: command.threadId, config },
      };
    }

    case "thread.auto-nudge.stop": {
      const targetThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return planThreadAutoNudgeStop({
        thread: targetThread,
        command,
        stoppedAt: command.createdAt,
      });
    }

    case "thread.auto-nudge.dispatch": {
      const targetThread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (targetThread.deletedAt !== null) {
        return yield* rejectAutoNudgeCommand(
          command,
          `Thread '${command.threadId}' is in the Recycle Bin and cannot dispatch Auto Nudge.`,
        );
      }
      if (targetThread.manualFollowUps.length > 0) {
        return yield* rejectAutoNudgeCommand(
          command,
          `Thread '${command.threadId}' has manual follow-up intent. Manual operator work has priority over Auto Nudge.`,
        );
      }

      const config = currentThreadAutoNudgeConfig(targetThread);
      if (config.mode === "off") {
        return yield* rejectAutoNudgeCommand(
          command,
          `Auto Nudge is off for thread '${command.threadId}'.`,
        );
      }
      if (command.expectedAuthorityRevision !== config.authorityRevision) {
        return yield* rejectAutoNudgeCommand(
          command,
          `Auto Nudge authority revision for thread '${command.threadId}' is stale.`,
        );
      }
      if (targetThread.messages.some((message) => message.id === command.messageId)) {
        return yield* rejectAutoNudgeCommand(
          command,
          `Auto Nudge message '${command.messageId}' already exists on thread '${command.threadId}'.`,
        );
      }
      if (command.dispatchSource === "background" && !config.backgroundContinuation) {
        return yield* rejectAutoNudgeCommand(
          command,
          `Background Auto Nudge is not enabled for thread '${command.threadId}'.`,
        );
      }
      if (
        targetThread.latestTurn === null ||
        targetThread.latestTurn.state !== "completed" ||
        targetThread.latestTurn.completedAt === null ||
        targetThread.latestTurn.turnId !== command.completedTurnId
      ) {
        return yield* rejectAutoNudgeCommand(
          command,
          `Auto Nudge dispatch for thread '${command.threadId}' does not target its exact current completed turn.`,
        );
      }
      if (threadHasPostCompletionProviderActivity(targetThread, command.completedTurnId)) {
        return yield* rejectAutoNudgeCommand(
          command,
          `Auto Nudge dispatch for thread '${command.threadId}' was invalidated by continued provider output or activity.`,
        );
      }
      if (config.baselineSettledTurnId === command.completedTurnId) {
        return yield* rejectAutoNudgeCommand(
          command,
          `Auto Nudge dispatch for thread '${command.threadId}' targets the configuration baseline turn.`,
        );
      }
      if (config.lastDispatchedSettledTurnId === command.completedTurnId) {
        return yield* rejectAutoNudgeCommand(
          command,
          `Auto Nudge already dispatched for completed turn '${command.completedTurnId}'.`,
        );
      }
      if (!config.backgroundContinuation && config.lastDispatchedMessageId !== null) {
        const dispatchedOwnTurn = targetThread.messages.some(
          (message) =>
            message.id === config.lastDispatchedMessageId &&
            message.turnId === command.completedTurnId,
        );
        if (dispatchedOwnTurn) {
          return yield* rejectAutoNudgeCommand(
            command,
            `Auto Nudge cannot chain from its own previous dispatch without background continuation.`,
          );
        }
      }
      if (threadHasUnsettledTurnStart(targetThread)) {
        return yield* rejectAutoNudgeCommand(
          command,
          `Thread '${command.threadId}' has pending or running provider work.`,
        );
      }
      if (targetThread.session?.status !== "ready") {
        return yield* rejectAutoNudgeCommand(
          command,
          `Thread '${command.threadId}' does not have a ready provider session for Auto Nudge.`,
        );
      }
      if (config.roundsDispatched >= config.maxRounds) {
        return yield* rejectAutoNudgeCommand(
          command,
          `Auto Nudge round cap is exhausted for thread '${command.threadId}'.`,
        );
      }

      const dispatchedAt = yield* nowIso;
      const roundsDispatched = config.roundsDispatched + 1;
      const dispatchEvent: PlannedOrchestrationEvent = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: dispatchedAt,
          commandId: command.commandId,
        }),
        type: "thread.auto-nudge-dispatched",
        payload: {
          threadId: command.threadId,
          authorityRevision: config.authorityRevision,
          completedTurnId: command.completedTurnId,
          dispatchSource: command.dispatchSource,
          messageId: command.messageId,
          roundsDispatched,
          dispatchedAt,
        },
      };
      const userMessageEvent: PlannedOrchestrationEvent = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: dispatchedAt,
          commandId: command.commandId,
        }),
        causationEventId: dispatchEvent.eventId,
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          role: "user",
          text: config.prompt,
          attachments: [],
          turnId: null,
          streaming: false,
          createdAt: dispatchedAt,
          updatedAt: dispatchedAt,
        },
      };
      const turnStartRequestedEvent: PlannedOrchestrationEvent = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: dispatchedAt,
          commandId: command.commandId,
        }),
        causationEventId: userMessageEvent.eventId,
        type: "thread.turn-start-requested",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          modelSelection: targetThread.modelSelection,
          runtimeMode: targetThread.runtimeMode,
          interactionMode: targetThread.interactionMode,
          dispatchSource: "auto-nudge",
          autoNudgeAuthority: {
            authorityRevision: config.authorityRevision,
            completedTurnId: command.completedTurnId,
            completedAt: targetThread.latestTurn.completedAt,
            dispatchSource: command.dispatchSource,
          },
          createdAt: dispatchedAt,
        },
      };
      return [dispatchEvent, userMessageEvent, turnStartRequestedEvent];
    }

    case "thread.manual-follow-up.reserve": {
      const targetThread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (targetThread.deletedAt !== null) {
        return yield* rejectManualFollowUpCommand(
          command,
          `Thread '${command.threadId}' is in the Recycle Bin and cannot reserve a manual follow-up.`,
        );
      }
      if (targetThread.manualFollowUps.length >= MANUAL_FOLLOW_UP_MAX_ITEMS) {
        return yield* rejectManualFollowUpCommand(
          command,
          `Thread '${command.threadId}' already has the maximum ${MANUAL_FOLLOW_UP_MAX_ITEMS} manual follow-ups.`,
        );
      }
      if (targetThread.manualFollowUps.some((item) => item.id === command.followUpId)) {
        return yield* rejectManualFollowUpCommand(
          command,
          `Manual follow-up '${command.followUpId}' already exists on thread '${command.threadId}'.`,
        );
      }
      if (
        targetThread.messages.some((message) => message.id === command.messageId) ||
        targetThread.manualFollowUps.some((item) =>
          item.status === "reserving"
            ? item.messageId === command.messageId
            : item.message.messageId === command.messageId,
        )
      ) {
        return yield* rejectManualFollowUpCommand(
          command,
          `Manual follow-up message '${command.messageId}' already exists on thread '${command.threadId}'.`,
        );
      }
      const reservedEvent: PlannedOrchestrationEvent = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.manual-follow-up-reserved",
        payload: {
          threadId: command.threadId,
          item: {
            id: command.followUpId,
            messageId: command.messageId,
            dispatch: command.dispatch,
            status: "reserving",
            reservationCommandId: command.commandId,
            enqueuedAt: command.createdAt,
          },
        },
      };
      return [
        reservedEvent,
        {
          ...withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          }),
          causationEventId: reservedEvent.eventId,
          type: "thread.manual-follow-up-count-changed",
          payload: {
            threadId: command.threadId,
            count: targetThread.manualFollowUps.length + 1,
            updatedAt: command.createdAt,
          },
        },
      ];
    }

    case "thread.manual-follow-up.enqueue": {
      const targetThread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (targetThread.deletedAt !== null) {
        return yield* rejectManualFollowUpCommand(
          command,
          `Thread '${command.threadId}' is in the Recycle Bin and cannot accept a manual follow-up.`,
        );
      }
      if (
        command.message.text.length > PROVIDER_SEND_TURN_MAX_INPUT_CHARS ||
        command.message.attachments.length > PROVIDER_SEND_TURN_MAX_ATTACHMENTS ||
        (command.message.text.trim().length === 0 && command.message.attachments.length === 0)
      ) {
        return yield* rejectManualFollowUpCommand(command, "Manual follow-up payload is invalid.");
      }
      const reservation = targetThread.manualFollowUps.find(
        (item) => item.id === command.followUpId,
      );
      if (
        reservation === undefined ||
        reservation.status !== "reserving" ||
        reservation.reservationCommandId !== command.reservationCommandId ||
        reservation.messageId !== command.message.messageId ||
        !manualFollowUpDispatchesMatch(reservation.dispatch, command.dispatch)
      ) {
        return yield* rejectManualFollowUpCommand(
          command,
          `Manual follow-up '${command.followUpId}' does not match its reservation receipt.`,
        );
      }
      if (targetThread.messages.some((message) => message.id === command.message.messageId)) {
        return yield* rejectManualFollowUpCommand(
          command,
          `Manual follow-up message '${command.message.messageId}' already exists on thread '${command.threadId}'.`,
        );
      }
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.manual-follow-up-enqueued",
        payload: {
          threadId: command.threadId,
          item: {
            id: command.followUpId,
            message: command.message,
            dispatch: command.dispatch,
            status: "queued",
            reservationCommandId: command.reservationCommandId,
            enqueuedAt: reservation.enqueuedAt,
            activatedAt: null,
            activationCommandId: null,
          },
        },
      };
    }

    case "thread.manual-follow-up.cancel": {
      const targetThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (!targetThread.manualFollowUps.some((item) => item.id === command.followUpId)) {
        return yield* rejectManualFollowUpCommand(
          command,
          `Manual follow-up '${command.followUpId}' does not exist on thread '${command.threadId}'.`,
        );
      }
      const cancelledEvent: PlannedOrchestrationEvent = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.manual-follow-up-cancelled",
        payload: {
          threadId: command.threadId,
          followUpId: command.followUpId,
          cancelledAt: command.createdAt,
        },
      };
      return [
        cancelledEvent,
        {
          ...withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          }),
          causationEventId: cancelledEvent.eventId,
          type: "thread.manual-follow-up-count-changed",
          payload: {
            threadId: command.threadId,
            count: targetThread.manualFollowUps.length - 1,
            updatedAt: command.createdAt,
          },
        },
      ];
    }

    case "thread.manual-follow-up.activate": {
      const targetThread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (targetThread.deletedAt !== null) {
        return yield* rejectManualFollowUpCommand(
          command,
          `Thread '${command.threadId}' is in the Recycle Bin and cannot activate a manual follow-up.`,
        );
      }
      const head = targetThread.manualFollowUps[0];
      if (head === undefined) {
        return yield* rejectManualFollowUpCommand(
          command,
          `Thread '${command.threadId}' has no manual follow-up to activate.`,
        );
      }
      if (head.id !== command.followUpId) {
        return yield* rejectManualFollowUpCommand(
          command,
          `Manual follow-up '${command.followUpId}' is not the FIFO head for thread '${command.threadId}'.`,
        );
      }
      if (head.status === "reserving") {
        return yield* rejectManualFollowUpCommand(
          command,
          `Manual follow-up '${command.followUpId}' has no prompt payload and cannot be activated.`,
        );
      }
      if (head.status !== "queued") {
        return yield* rejectManualFollowUpCommand(
          command,
          `Manual follow-up '${command.followUpId}' already has an unresolved provider handoff.`,
        );
      }

      const existingMessage = targetThread.messages.find(
        (message) => message.id === head.message.messageId,
      );
      if (
        existingMessage !== undefined &&
        (existingMessage.role !== "user" ||
          existingMessage.text !== head.message.text ||
          JSON.stringify(existingMessage.attachments ?? []) !==
            JSON.stringify(head.message.attachments))
      ) {
        return yield* rejectManualFollowUpCommand(
          command,
          `Manual follow-up message '${head.message.messageId}' conflicts with existing thread content.`,
        );
      }

      const sourceProposedPlan = head.dispatch.sourceProposedPlan;
      const sourceThread = sourceProposedPlan
        ? yield* requireThread({ readModel, command, threadId: sourceProposedPlan.threadId })
        : null;
      const sourcePlan =
        sourceProposedPlan && sourceThread
          ? sourceThread.proposedPlans.find((entry) => entry.id === sourceProposedPlan.planId)
          : null;
      if (sourceProposedPlan && !sourcePlan) {
        return yield* rejectManualFollowUpCommand(
          command,
          `Proposed plan '${sourceProposedPlan.planId}' does not exist on thread '${sourceProposedPlan.threadId}'.`,
        );
      }
      if (sourceThread && sourceThread.projectId !== targetThread.projectId) {
        return yield* rejectManualFollowUpCommand(
          command,
          `Proposed plan '${sourceProposedPlan?.planId}' belongs to a different project.`,
        );
      }

      const unsettled = threadHasUnsettledTurnStart(targetThread);
      if (unsettled && command.activationMode === "automatic-after-settlement") {
        return yield* rejectManualFollowUpCommand(
          command,
          `Thread '${command.threadId}' became active before automatic activation. The follow-up remains queued.`,
        );
      }
      if (
        command.activationMode === "automatic-after-settlement" &&
        targetThread.session?.status !== "ready"
      ) {
        return yield* rejectManualFollowUpCommand(
          command,
          `Thread '${command.threadId}' is not ready for automatic activation. The follow-up remains queued.`,
        );
      }
      const activeTurnId = unsettled ? activeTurnIdForSteer(targetThread) : null;
      if (unsettled && activeTurnId === null) {
        return yield* rejectManualFollowUpCommand(
          command,
          `Thread '${command.threadId}' has work that is not safely steerable.`,
        );
      }

      const activatedEvent: PlannedOrchestrationEvent = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        }),
        type: "thread.manual-follow-up-activated",
        payload: {
          threadId: command.threadId,
          followUpId: command.followUpId,
          messageId: head.message.messageId,
          activationCommandId: command.commandId,
          activatedAt: command.createdAt,
        },
      };
      const userMessageEvent: PlannedOrchestrationEvent | null =
        existingMessage === undefined
          ? {
              ...withEventBase({
                aggregateKind: "thread",
                aggregateId: command.threadId,
                occurredAt: command.createdAt,
                commandId: command.commandId,
              }),
              causationEventId: activatedEvent.eventId,
              type: "thread.message-sent",
              payload: {
                threadId: command.threadId,
                messageId: head.message.messageId,
                role: "user",
                text: head.message.text,
                attachments: head.message.attachments,
                turnId: activeTurnId,
                streaming: false,
                createdAt: command.createdAt,
                updatedAt: command.createdAt,
              },
            }
          : null;
      const providerRequestedEvent: PlannedOrchestrationEvent =
        activeTurnId === null
          ? {
              ...withEventBase({
                aggregateKind: "thread",
                aggregateId: command.threadId,
                occurredAt: command.createdAt,
                commandId: command.commandId,
              }),
              causationEventId: userMessageEvent?.eventId ?? activatedEvent.eventId,
              type: "thread.turn-start-requested",
              payload: {
                threadId: command.threadId,
                messageId: head.message.messageId,
                modelSelection: head.dispatch.modelSelection,
                titleSeed: head.dispatch.titleSeed,
                runtimeMode: head.dispatch.runtimeMode,
                interactionMode: head.dispatch.interactionMode,
                ...(sourceProposedPlan !== undefined ? { sourceProposedPlan } : {}),
                dispatchSource: "user",
                manualFollowUpId: head.id,
                manualFollowUpActivationCommandId: command.commandId,
                createdAt: command.createdAt,
              },
            }
          : {
              ...withEventBase({
                aggregateKind: "thread",
                aggregateId: command.threadId,
                occurredAt: command.createdAt,
                commandId: command.commandId,
              }),
              causationEventId: userMessageEvent?.eventId ?? activatedEvent.eventId,
              type: "thread.turn-steer-requested",
              payload: {
                threadId: command.threadId,
                messageId: head.message.messageId,
                dispatchSource: "user",
                manualFollowUpId: head.id,
                manualFollowUpActivationCommandId: command.commandId,
                createdAt: command.createdAt,
              },
            };
      return userMessageEvent === null
        ? [activatedEvent, providerRequestedEvent]
        : [activatedEvent, userMessageEvent, providerRequestedEvent];
    }

    case "thread.manual-follow-up.accept": {
      const targetThread = yield* requireThread({ readModel, command, threadId: command.threadId });
      const head = targetThread.manualFollowUps[0];
      if (
        head === undefined ||
        head.id !== command.followUpId ||
        head.status !== "handoff" ||
        head.activationCommandId !== command.activationCommandId
      ) {
        return yield* rejectManualFollowUpCommand(
          command,
          `Manual follow-up '${command.followUpId}' has no matching active provider handoff.`,
        );
      }
      const acceptedEvent: PlannedOrchestrationEvent = {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.acceptedAt,
          commandId: command.commandId,
        }),
        type: "thread.manual-follow-up-accepted",
        payload: {
          threadId: command.threadId,
          followUpId: command.followUpId,
          activationCommandId: command.activationCommandId,
          acceptedAt: command.acceptedAt,
        },
      };
      return [
        acceptedEvent,
        {
          ...withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.acceptedAt,
            commandId: command.commandId,
          }),
          causationEventId: acceptedEvent.eventId,
          type: "thread.manual-follow-up-count-changed",
          payload: {
            threadId: command.threadId,
            count: targetThread.manualFollowUps.length - 1,
            updatedAt: command.acceptedAt,
          },
        },
      ];
    }

    case "thread.manual-follow-up.release": {
      const targetThread = yield* requireThread({ readModel, command, threadId: command.threadId });
      const head = targetThread.manualFollowUps[0];
      if (
        head === undefined ||
        head.id !== command.followUpId ||
        head.status !== "handoff" ||
        head.activationCommandId !== command.activationCommandId
      ) {
        return yield* rejectManualFollowUpCommand(
          command,
          `Manual follow-up '${command.followUpId}' has no matching active provider handoff.`,
        );
      }
      return {
        ...withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.releasedAt,
          commandId: command.commandId,
        }),
        type: "thread.manual-follow-up-released",
        payload: {
          threadId: command.threadId,
          followUpId: command.followUpId,
          activationCommandId: command.activationCommandId,
          releasedAt: command.releasedAt,
        },
      };
    }

    case "thread.turn.start": {
      if (command.dispatchSource === "auto-nudge") {
        return yield* rejectAutoNudgeCommand(
          command,
          "Automated turns must use exact-thread Auto Nudge dispatch authority.",
        );
      }
      const targetThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (targetThread.manualFollowUps.length > 0) {
        return yield* rejectManualFollowUpCommand(
          command,
          `Thread '${command.threadId}' has queued manual follow-ups. Activate the FIFO head.`,
        );
      }
      if (threadHasUnsettledTurnStart(targetThread)) {
        const activeTurnId = activeTurnIdForSteer(targetThread);
        // The renderer can submit from an older ready snapshot while the
        // authoritative aggregate has already moved to `starting`. Claude can
        // also remain live while briefly projecting `running` without an
        // active turn id as SDK response segments cross a terminal-looking
        // boundary. Rejecting here loses the renderer's only durable handoff
        // and exposes a recoverable projection race to the user.
        //
        // Persist one steer intent even when `activeTurnId` is null. The
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
            threadId: command.threadId,
            messageId: command.message.messageId,
            ...(command.dispatchSource !== undefined
              ? { dispatchSource: command.dispatchSource }
              : {}),
            createdAt: command.createdAt,
          },
        };
        return [userMessageEvent, turnSteerRequestedEvent];
      }
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
      if (sourceThread && sourceThread.projectId !== targetThread.projectId) {
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
          threadId: command.threadId,
          messageId: command.message.messageId,
          ...(command.modelSelection !== undefined
            ? { modelSelection: command.modelSelection }
            : {}),
          ...(command.titleSeed !== undefined ? { titleSeed: command.titleSeed } : {}),
          runtimeMode: targetThread.runtimeMode,
          interactionMode: targetThread.interactionMode,
          ...(sourceProposedPlan !== undefined ? { sourceProposedPlan } : {}),
          ...(command.dispatchSource !== undefined
            ? { dispatchSource: command.dispatchSource }
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
      if (command.dispatchSource === "auto-nudge") {
        return yield* rejectAutoNudgeCommand(
          command,
          "Automated turns must use exact-thread Auto Nudge dispatch authority.",
        );
      }
      const targetThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (targetThread.manualFollowUps.length > 0) {
        return yield* rejectManualFollowUpCommand(
          command,
          `Thread '${command.threadId}' has queued manual follow-ups. Activate the FIFO head.`,
        );
      }
      const activeTurnId =
        targetThread.session?.status === "running" ? targetThread.session.activeTurnId : null;
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
            threadId: command.threadId,
            messageId: command.message.messageId,
            modelSelection: targetThread.modelSelection,
            runtimeMode: targetThread.runtimeMode,
            interactionMode: targetThread.interactionMode,
            ...(command.dispatchSource !== undefined
              ? { dispatchSource: command.dispatchSource }
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
          threadId: command.threadId,
          messageId: command.message.messageId,
          ...(command.dispatchSource !== undefined
            ? { dispatchSource: command.dispatchSource }
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
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.checkpoint.revert": {
      const targetThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const stoppedAt = yield* nowIso;
      const stopEvent = planThreadAutoNudgeStop({ thread: targetThread, command, stoppedAt });
      const revertEvent: PlannedOrchestrationEvent = {
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
      return [stopEvent, revertEvent];
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
          metadata: {},
        }),
        type: "thread.session-set",
        payload: {
          threadId: command.threadId,
          session: command.session,
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
      const targetThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const stoppedAt = yield* nowIso;
      const stopEvent = planThreadAutoNudgeStop({ thread: targetThread, command, stoppedAt });
      const revertedEvent: PlannedOrchestrationEvent = {
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
      return [stopEvent, revertedEvent];
    }

    case "thread.activity.append": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
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
