import {
  type ClientOrchestrationCommand,
  type OrchestrationCommand,
  OrchestrationDispatchCommandError,
} from "@cafecode/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { OrchestrationEngineShape } from "./Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "./Services/ProjectionSnapshotQuery.ts";
import type { ProviderServiceShape } from "../provider/Services/ProviderService.ts";

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
  }) {
    const source = Option.getOrUndefined(
      yield* input.projectionSnapshotQuery.getThreadDetailById(input.command.sourceThreadId),
    );
    if (!source || source.deletedAt !== null || source.archivedAt !== null) {
      return yield* forkDispatchError("The source thread is unavailable and cannot be forked.");
    }
    if (
      source.latestTurn?.state === "running" ||
      source.session?.status === "starting" ||
      source.session?.status === "running"
    ) {
      return yield* forkDispatchError("Wait for the current turn to finish before forking.");
    }

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
      Effect.onError((commitCause) =>
        input.providerService.discardSessionFork({ fork }).pipe(
          Effect.catchCause((cleanupCause) =>
            Effect.logError("provider thread fork compensation failed", {
              sourceThreadId: fork.sourceThreadId,
              targetThreadId: fork.targetThreadId,
              provider: fork.provider,
              providerInstanceId: fork.providerInstanceId,
              commitCause: Cause.pretty(commitCause),
              cleanupCause: Cause.pretty(cleanupCause),
            }),
          ),
        ),
      ),
    );
  },
);
