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
    readonly projectionSnapshotQuery: Pick<ProjectionSnapshotQueryShape, "getThreadDetailById">;
    readonly providerService: Pick<ProviderServiceShape, "forkSession" | "discardSessionFork">;
    readonly standaloneWorkspaces?: Effect.Success<typeof makeStandaloneWorkspaceStore>;
  }) {
    const source = Option.getOrUndefined(
      yield* input.projectionSnapshotQuery.getThreadDetailById(input.command.sourceThreadId),
    );
    if (!source || source.deletedAt !== null || source.archivedAt !== null) {
      return yield* forkDispatchError("The source thread is unavailable and cannot be forked.");
    }
    if (source.latestTurn?.state === "running" || threadHasUnsettledTurnStart(source)) {
      return yield* forkDispatchError("Wait for the current turn to finish before forking.");
    }

    // A native fork intentionally retains the exact execution context. Bind
    // shared neutral ownership before provider I/O and compensate only this
    // provisional target if preparation/commit fails; source remains owned.
    const standalone = source.projectId === null ? input.standaloneWorkspaces : undefined;
    if (source.projectId === null && standalone === undefined) {
      return yield* forkDispatchError("Standalone chat fork ownership is unavailable.");
    }
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
      targetThreadId: input.command.targetThreadId,
      title: input.command.title,
    });
    const commit = {
      type: "thread.fork.commit",
      commandId: input.command.commandId,
      sourceThreadId: input.command.sourceThreadId,
      targetThreadId: input.command.targetThreadId,
      title: input.command.title,
      createdAt: input.command.createdAt,
      session: {
        threadId: input.command.targetThreadId,
        status: "stopped",
        providerName: fork.provider,
        providerInstanceId: fork.providerInstanceId,
        runtimeMode: fork.runtimeMode,
        activeTurnId: null,
        lastError: null,
        updatedAt: input.command.createdAt,
      },
    } satisfies OrchestrationCommand;

    return yield* input.orchestrationEngine.dispatch(commit).pipe(
      Effect.onError(() =>
        input.providerService.discardSessionFork({ fork }).pipe(
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
        ),
      ),
    );
  },
);
