import {
  type ClientOrchestrationCommand,
  type OrchestrationCommand,
  OrchestrationDispatchCommandError,
} from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { OrchestrationEngineShape } from "./Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "./Services/ProjectionSnapshotQuery.ts";
import type { ProviderServiceShape } from "../provider/Services/ProviderService.ts";
import type { makeStandaloneWorkspaceStore } from "./standaloneWorkspace.ts";
import { threadHasUnsettledTurnStart } from "./decider.ts";
import { resolveThreadForkMessageCutoff } from "./threadForkCutoff.ts";
import type { OrchestrationDispatchError } from "./Errors.ts";
import { resolveThreadWorkspaceCwd } from "../checkpointing/Utils.ts";

type ThreadForkCommand = Extract<ClientOrchestrationCommand, { readonly type: "thread.fork" }>;

function forkDispatchError(message: string, cause?: unknown): OrchestrationDispatchCommandError {
  return new OrchestrationDispatchCommandError({
    message,
    ...(cause !== undefined ? { cause } : {}),
  });
}

/**
 * Execute provider-native fork first, then commit the Cafe projection + dormant
 * session binding as one orchestration transaction. If that commit fails, the
 * provider service compensates by deleting only the newly-created native fork.
 */
export const dispatchProviderNativeThreadFork = Effect.fn("dispatchProviderNativeThreadFork")(
  function* (input: {
    readonly command: ThreadForkCommand;
    readonly orchestrationEngine: Pick<OrchestrationEngineShape, "dispatch">;
    readonly projectionSnapshotQuery: Pick<
      ProjectionSnapshotQueryShape,
      | "getThreadDetailById"
      | "getThreadForkSourceVersion"
      | "hasPendingContextBootstrap"
      | "getThreadForkMessageCount"
      | "getProjectShellById"
    >;
    readonly providerService: Pick<ProviderServiceShape, "forkSession" | "discardSessionFork">;
    readonly standaloneWorkspaces?: Effect.Success<typeof makeStandaloneWorkspaceStore>;
  }) {
    // Fence the entire persisted source context, including project metadata
    // outside the thread row. Unrelated conversations do not invalidate this
    // authority, but source events do, even if they undo an earlier change.
    const sourceVersion = yield* input.projectionSnapshotQuery.getThreadForkSourceVersion(
      input.command.sourceThreadId,
    );
    const source = Option.getOrUndefined(
      yield* input.projectionSnapshotQuery.getThreadDetailById(input.command.sourceThreadId),
    );
    const projectedMessageCount =
      input.command.sourceMessageId !== undefined
        ? yield* input.projectionSnapshotQuery.getThreadForkMessageCount(
            input.command.sourceThreadId,
          )
        : undefined;
    const project = source?.projectId
      ? Option.getOrUndefined(
          yield* input.projectionSnapshotQuery.getProjectShellById(source.projectId),
        )
      : undefined;
    if (
      (yield* input.projectionSnapshotQuery.getThreadForkSourceVersion(
        input.command.sourceThreadId,
      )) !== sourceVersion
    )
      return yield* forkDispatchError(
        "The source context changed while preparing the fork. Try again.",
      );
    if (!source || source.deletedAt !== null || source.archivedAt !== null) {
      return yield* forkDispatchError("The source thread is unavailable and cannot be forked.");
    }
    // A duplicate's visible transcript is not native provider context until
    // its first ordinary message has delivered the bootstrap. Native fork
    // would otherwise copy an empty context and silently lose that history.
    // Refuse before acquiring standalone ownership or making provider calls;
    // an unreadable admission must propagate, never become a false result.
    if (
      yield* input.projectionSnapshotQuery.hasPendingContextBootstrap(input.command.sourceThreadId)
    )
      return yield* forkDispatchError(
        "Send a normal message in this copied chat before creating a native fork so its visible context can be delivered first.",
      );
    if (
      projectedMessageCount !== undefined &&
      (projectedMessageCount > 2000 || projectedMessageCount !== source.messages.length)
    ) {
      return yield* forkDispatchError(
        "The selected fork cannot prove a complete message boundary for this conversation's retained history.",
      );
    }
    if (source.latestTurn?.state === "running" || threadHasUnsettledTurnStart(source)) {
      return yield* forkDispatchError("Wait for the current turn to finish before forking.");
    }
    const messageCutoff =
      input.command.sourceMessageId === undefined
        ? undefined
        : yield* Effect.try({
            try: () => {
              if (source.session?.providerName !== "claudeAgent")
                throw new Error("Selected-message native forks require a Claude conversation.");
              return resolveThreadForkMessageCutoff(source, input.command.sourceMessageId!);
            },
            catch: () =>
              forkDispatchError(
                "The selected Claude message has no available persisted fork boundary.",
              ),
          });

    // A native fork intentionally retains the exact execution context. Bind
    // shared neutral ownership before provider I/O and compensate only this
    // provisional target if preparation/commit fails; source remains owned.
    const standalone = source.projectId === null ? input.standaloneWorkspaces : undefined;
    if (source.projectId === null && standalone === undefined) {
      return yield* forkDispatchError("Standalone chat fork ownership is unavailable.");
    }
    const expectedCwd = standalone
      ? yield* standalone.readExisting(source.id)
      : resolveThreadWorkspaceCwd({ thread: source, projects: project ? [project] : [] });
    if (!expectedCwd)
      return yield* forkDispatchError("The source workspace is unavailable for native forking.");
    const discardStandaloneOwnership = () =>
      (
        standalone?.discardFork(input.command.targetThreadId, input.command.commandId) ??
        Effect.void
      ).pipe(
        Effect.catch(() =>
          Effect.logWarning("standalone fork ownership compensation failed", {
            targetThreadId: input.command.targetThreadId,
          }),
        ),
      );
    if (standalone)
      yield* standalone
        .shareFork(source.id, input.command.targetThreadId, input.command.commandId)
        .pipe(
          Effect.mapError(() =>
            forkDispatchError("Standalone chat fork ownership is unavailable."),
          ),
        );
    // A failed preparation response does not prove that native fork creation
    // never happened: provider I/O or binding persistence may fail afterward.
    // Retain provisional ownership on that uncertainty rather than deleting a
    // directory which an unobserved native fork could still reference.
    const fork = yield* input.providerService.forkSession({
      operationId: input.command.commandId,
      sourceThreadId: input.command.sourceThreadId,
      sourceVersion,
      expectedCwd,
      ...(messageCutoff
        ? { messageCutoff, sourceMessageIds: source.messages.map((message) => message.id) }
        : {}),
      targetThreadId: input.command.targetThreadId,
      title: input.command.title,
    });
    if (
      messageCutoff &&
      (!fork.retainedMessageIds ||
        !fork.retainedMessageIds.includes(messageCutoff.sourceMessageId) ||
        new Set(fork.retainedMessageIds).size !== fork.retainedMessageIds.length ||
        fork.retainedMessageIds.some((id) => !source.messages.some((message) => message.id === id)))
    ) {
      return yield* forkDispatchError(
        "The provider returned an unbound selected-message fork prefix.",
      );
    }
    const commit = {
      type: "thread.fork.commit",
      commandId: input.command.commandId,
      sourceThreadId: input.command.sourceThreadId,
      sourceVersion,
      ...(messageCutoff ? { messageCutoff } : {}),
      ...(fork.retainedMessageIds ? { retainedMessageIds: fork.retainedMessageIds } : {}),
      targetThreadId: input.command.targetThreadId,
      title: input.command.title,
      createdAt: input.command.createdAt,
      session: {
        threadId: input.command.targetThreadId,
        status: "stopped",
        providerName: fork.provider,
        providerInstanceId: fork.providerInstanceId,
        runtimeMode: fork.runtimeMode,
        ...(fork.maxConcurrentSubagents !== undefined
          ? { maxConcurrentSubagents: fork.maxConcurrentSubagents }
          : {}),
        activeTurnId: null,
        lastError: null,
        updatedAt: input.command.createdAt,
      },
    } satisfies OrchestrationCommand;

    return yield* input.orchestrationEngine.dispatch(commit).pipe(
      Effect.catch((error): Effect.Effect<never, OrchestrationDispatchError> => {
        // dispatch queues work on an independent engine fiber. Cancellation,
        // defects and persistence failures are NOT proof that its transaction
        // did not commit. Preserve recovery evidence on every unknown outcome.
        // Only the engine's explicit pre-commit rejection authorizes deletion.
        if (
          error._tag !== "OrchestrationCommandInvariantError" &&
          error._tag !== "OrchestrationCommandPreviouslyRejectedError"
        )
          return Effect.fail(error);
        return input.providerService.discardSessionFork({ fork }).pipe(
          // Filesystem authority is released only after exact native provider
          // compensation settles successfully. Failure/interruption retains the
          // private durable reference for later ownership reconciliation.
          Effect.tap(discardStandaloneOwnership),
          Effect.catchCause(() =>
            Effect.logError("provider thread fork compensation failed", {
              sourceThreadId: fork.sourceThreadId,
              targetThreadId: fork.targetThreadId,
              provider: fork.provider,
              providerInstanceId: fork.providerInstanceId,
              operationId: fork.operationId,
              // Provider errors can contain native private output/cursors. Log
              // fixed operation metadata, never raw commit/cleanup causes.
            }),
          ),
          Effect.andThen(Effect.fail(error)),
        );
      }),
    );
  },
);
