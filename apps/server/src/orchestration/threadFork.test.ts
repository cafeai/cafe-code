import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationThread,
  type ProviderSessionForkResult,
} from "@cafecode/contracts";
import { assert, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";

import { OrchestrationCommandInvariantError } from "./Errors.ts";
import { dispatchProviderNativeThreadFork } from "./threadFork.ts";
import type { OrchestrationEngineShape } from "./Services/OrchestrationEngine.ts";
import type { ProjectionSnapshotQueryShape } from "./Services/ProjectionSnapshotQuery.ts";
import type { ProviderServiceShape } from "../provider/Services/ProviderService.ts";

const sourceThreadId = ThreadId.make("thread-fork-source");
const targetThreadId = ThreadId.make("thread-fork-target");
const commandId = CommandId.make("cmd-thread-fork");
const createdAt = "2026-08-21T12:00:00.000Z";

const sourceThread = {
  id: sourceThreadId,
  projectId: ProjectId.make("project-fork"),
  title: "Source",
  modelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.5",
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "feature/fork",
  worktreePath: "/repo/fork",
  latestTurn: null,
  createdAt,
  updatedAt: createdAt,
  archivedAt: null,
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: {
    threadId: sourceThreadId,
    status: "ready",
    providerName: ProviderDriverKind.make("codex"),
    providerInstanceId: ProviderInstanceId.make("codex"),
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: null,
    updatedAt: createdAt,
  },
  goal: null,
} satisfies OrchestrationThread;

const nativeFork = {
  operationId: commandId,
  sourceThreadId,
  targetThreadId,
  provider: ProviderDriverKind.make("codex"),
  providerInstanceId: ProviderInstanceId.make("codex"),
  runtimeMode: "full-access",
  cwd: "/repo/fork",
  resumeCursor: { threadId: "provider-fork-id" },
} satisfies ProviderSessionForkResult;

it.effect("compensates only the owned native fork when the domain commit fails", () => {
  const forkSession = vi.fn<ProviderServiceShape["forkSession"]>(() => Effect.succeed(nativeFork));
  const discardSessionFork = vi.fn<ProviderServiceShape["discardSessionFork"]>(() => Effect.void);
  const dispatch = vi.fn<OrchestrationEngineShape["dispatch"]>((command) =>
    Effect.fail(
      new OrchestrationCommandInvariantError({
        commandType: command.type,
        detail: "simulated commit conflict",
      }),
    ),
  );
  const getThreadDetailById: ProjectionSnapshotQueryShape["getThreadDetailById"] = () =>
    Effect.succeed(Option.some(sourceThread));

  return Effect.gen(function* () {
    const exit = yield* dispatchProviderNativeThreadFork({
      command: {
        type: "thread.fork",
        commandId,
        sourceThreadId,
        targetThreadId,
        title: "Source (fork)",
        createdAt,
      },
      orchestrationEngine: { dispatch },
      projectionSnapshotQuery: { getThreadDetailById },
      providerService: { forkSession, discardSessionFork },
    }).pipe(Effect.exit);

    assert.equal(Exit.isFailure(exit), true);
    assert.deepEqual(forkSession.mock.calls[0]?.[0], {
      operationId: commandId,
      sourceThreadId,
      targetThreadId,
      title: "Source (fork)",
    });
    assert.equal(dispatch.mock.calls[0]?.[0].type, "thread.fork.commit");
    assert.deepEqual(discardSessionFork.mock.calls[0]?.[0], { fork: nativeFork });
  });
});
