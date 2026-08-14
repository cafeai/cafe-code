import {
  CommandId,
  MessageId,
  ProviderInstanceId,
  type ProviderSession,
  type ThreadId,
} from "@cafecode/contracts";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ProviderRegistryShape } from "./Services/ProviderRegistry.ts";
import type { ProviderServiceShape } from "./Services/ProviderService.ts";

export const DEFAULT_PROVIDER_RESTART_RESUME_MESSAGE =
  "Cafe Code restarted the provider runtime. Resume the work you were doing before the restart. Re-read the thread context, inspect the current workspace state, and continue from the last incomplete step.";

export interface ProviderRuntimeControlDependencies {
  readonly orchestrationEngine: Pick<OrchestrationEngineShape, "dispatch">;
  readonly projectionSnapshotQuery: Pick<ProjectionSnapshotQueryShape, "getThreadShellById">;
  readonly providerRegistry: Pick<ProviderRegistryShape, "refreshInstance">;
  readonly providerService: Pick<ProviderServiceShape, "listSessions" | "restartProviderRuntime">;
}

export interface ProviderRuntimeControlInput {
  readonly instanceId: ProviderInstanceId;
  readonly resumeActiveSessions: boolean;
  readonly resumeMessage?: string;
}

export interface ProviderRuntimeControlResult {
  readonly instanceId: ProviderInstanceId;
  readonly provider: ProviderSession["provider"];
  readonly stoppedSessionCount: number;
  readonly activeSessionCount: number;
  readonly resumedThreadIds: ReadonlyArray<ThreadId>;
  readonly failedResumeThreadIds: ReadonlyArray<ThreadId>;
}

export class ProviderRuntimeControlError extends Data.TaggedError("ProviderRuntimeControlError")<{
  readonly instanceId: ProviderInstanceId;
  readonly message: string;
  readonly cause?: unknown;
}> {}

function isActiveProviderSession(session: ProviderSession): boolean {
  return (
    session.status === "connecting" ||
    session.status === "running" ||
    session.activeTurnId !== undefined
  );
}

function belongsToInstance(session: ProviderSession, instanceId: ProviderInstanceId): boolean {
  return session.providerInstanceId === instanceId;
}

function toControlError(
  instanceId: ProviderInstanceId,
  cause: unknown,
): ProviderRuntimeControlError {
  return new ProviderRuntimeControlError({
    instanceId,
    message: `Failed to restart provider instance '${instanceId}'.`,
    cause,
  });
}

/**
 * Restart one provider instance and optionally resume every thread that had
 * active provider work at the restart boundary.
 *
 * The caller is responsible for starting this effect only after the MCP tool
 * response has been handed back to the invoking provider. A provider runtime
 * owns the agent process that made the call, so beginning teardown inside the
 * request handler can kill that process before it receives the acknowledgement.
 */
export const restartProviderRuntimeWithPolicy = Effect.fn(
  "ProviderRuntimeControl.restartProviderRuntimeWithPolicy",
)(function* (dependencies: ProviderRuntimeControlDependencies, input: ProviderRuntimeControlInput) {
  const sessions = yield* dependencies.providerService
    .listSessions()
    .pipe(Effect.mapError((cause) => toControlError(input.instanceId, cause)));
  const instanceSessions = sessions.filter((session) =>
    belongsToInstance(session, input.instanceId),
  );
  const activeSessions = instanceSessions.filter(isActiveProviderSession);
  const sessionsToResume = input.resumeActiveSessions ? activeSessions : [];

  // Capture thread execution preferences before teardown. Provider runtime
  // events race projection updates during stopAll(), but these values are
  // stable thread metadata and are sufficient to submit the follow-up turn.
  const resumeTargets = yield* Effect.forEach(
    sessionsToResume,
    (session) =>
      dependencies.projectionSnapshotQuery.getThreadShellById(session.threadId).pipe(
        Effect.map((thread) => Option.map(thread, (value) => ({ session, thread: value }))),
        Effect.mapError((cause) => toControlError(input.instanceId, cause)),
      ),
    { concurrency: 8 },
  ).pipe(Effect.map((targets) => targets.flatMap(Option.toArray)));

  const restarted = yield* dependencies.providerService
    .restartProviderRuntime({
      instanceId: input.instanceId,
    })
    .pipe(Effect.mapError((cause) => toControlError(input.instanceId, cause)));

  // Provider snapshots are UI/control-plane state. A refresh failure must not
  // prevent durable resume messages from reopening the provider sessions.
  yield* dependencies.providerRegistry.refreshInstance(input.instanceId).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("provider runtime restart refresh failed", {
        instanceId: input.instanceId,
        cause,
      }),
    ),
    Effect.asVoid,
  );

  if (!input.resumeActiveSessions || resumeTargets.length === 0) {
    return {
      ...restarted,
      activeSessionCount: activeSessions.length,
      resumedThreadIds: [],
      failedResumeThreadIds: [],
    } satisfies ProviderRuntimeControlResult;
  }

  // Let stop/interrupt runtime events enter the projection first. Correctness
  // does not depend on this pause: if a stale running projection remains, the
  // orchestration decider records a steer intent and ProviderCommandReactor's
  // no-active-turn recovery converts it to the next turn. The short grace
  // period simply makes the common path a normal turn start.
  yield* Effect.sleep(Duration.millis(100));

  const resumeMessage = input.resumeMessage?.trim() || DEFAULT_PROVIDER_RESTART_RESUME_MESSAGE;
  const resumeResults = yield* Effect.forEach(
    resumeTargets,
    ({ session, thread }) =>
      Effect.gen(function* () {
        const createdAt = DateTime.formatIso(yield* DateTime.now);
        yield* dependencies.orchestrationEngine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(crypto.randomUUID()),
          threadId: session.threadId,
          message: {
            messageId: MessageId.make(crypto.randomUUID()),
            role: "user",
            text: resumeMessage,
            attachments: [],
          },
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          createdAt,
        });
        return session.threadId;
      }).pipe(Effect.result),
    { concurrency: 4 },
  );

  const resumedThreadIds: Array<ThreadId> = [];
  const failedResumeThreadIds: Array<ThreadId> = [];
  for (let index = 0; index < resumeResults.length; index += 1) {
    const result = resumeResults[index];
    const target = resumeTargets[index];
    if (!result || !target) continue;
    if (result._tag === "Success") {
      resumedThreadIds.push(result.success);
      continue;
    }
    failedResumeThreadIds.push(target.session.threadId);
    yield* Effect.logWarning("provider runtime restart resume dispatch failed", {
      instanceId: input.instanceId,
      threadId: target.session.threadId,
      cause: result.failure,
    });
  }

  return {
    ...restarted,
    activeSessionCount: activeSessions.length,
    resumedThreadIds,
    failedResumeThreadIds,
  } satisfies ProviderRuntimeControlResult;
});
