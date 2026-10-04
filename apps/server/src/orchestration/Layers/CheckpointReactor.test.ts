// @effect-diagnostics nodeBuiltinImport:off
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import {
  ProviderDriverKind,
  ProviderRuntimeEvent,
  ProviderSession,
  ProviderInstanceId,
} from "@cafecode/contracts";
import {
  CheckpointRef,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
} from "@cafecode/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CheckpointStoreLive } from "../../checkpointing/Layers/CheckpointStore.ts";
import { CheckpointStore } from "../../checkpointing/Services/CheckpointStore.ts";
import { CheckpointInvariantError } from "../../checkpointing/Errors.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import { RepositoryIdentityResolverLive } from "../../project/Layers/RepositoryIdentityResolver.ts";
import { CheckpointReactorLive, computeCheckpointRefPrunePlan } from "./CheckpointReactor.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { RuntimeReceiptBusLive } from "./RuntimeReceiptBus.ts";
import { RuntimeReceiptBus } from "../Services/RuntimeReceiptBus.ts";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion.ts";
import { OrchestrationCommandInvariantError } from "../Errors.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { CheckpointReactor } from "../Services/CheckpointReactor.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterRewindOutcomeUnknownError,
} from "../../provider/Errors.ts";
import { checkpointRefForThreadTurn } from "../../checkpointing/Utils.ts";
import { ServerConfig } from "../../config.ts";
import { WorkspaceEntriesLive } from "../../workspace/Layers/WorkspaceEntries.ts";
import { WorkspacePathsLive } from "../../workspace/Layers/WorkspacePaths.ts";

const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);

describe("computeCheckpointRefPrunePlan", () => {
  it("skips provider-diff placeholders without letting them affect retention", () => {
    const threadId = ThreadId.make("thread-1");
    const plan = computeCheckpointRefPrunePlan({
      threadId,
      currentTurnCount: 4,
      checkpoints: [
        {
          checkpointTurnCount: 1,
          checkpointRef: checkpointRefForThreadTurn(threadId, 1),
        },
        {
          checkpointTurnCount: 2,
          checkpointRef: checkpointRefForThreadTurn(threadId, 2),
        },
        {
          checkpointTurnCount: 3,
          checkpointRef: checkpointRefForThreadTurn(threadId, 3),
        },
        {
          checkpointTurnCount: 99,
          checkpointRef: CheckpointRef.make("provider-diff:evt-placeholder"),
        },
      ],
    });

    expect(plan.retainedTurnCounts).toEqual([4, 3, 2]);
    expect(plan.skippedNonHiddenCheckpointRefs).toBe(1);
    expect(plan.checkpointRefsToDelete).toEqual([
      checkpointRefForThreadTurn(threadId, 1),
      checkpointRefForThreadTurn(threadId, 0),
    ]);
  });
});

type LegacyProviderRuntimeEvent = {
  readonly type: string;
  readonly eventId: EventId;
  readonly provider: ProviderDriverKind;
  readonly createdAt: string;
  readonly threadId: ThreadId;
  readonly turnId?: string | undefined;
  readonly itemId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly providerInstanceId?: ProviderInstanceId | undefined;
  readonly payload?: unknown | undefined;
  readonly [key: string]: unknown;
};

function createProviderServiceHarness(
  cwd: string,
  hasSession = true,
  sessionCwd = cwd,
  providerName: ProviderSession["provider"] = ProviderDriverKind.make("codex"),
) {
  const now = "2026-01-01T00:00:00.000Z";
  const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
  const rollbackConversation = vi.fn(
    (_input: {
      readonly threadId: ThreadId;
      readonly numTurns: number;
    }): ReturnType<ProviderServiceShape["rollbackConversation"]> => Effect.void,
  );
  const prepareConversationRollback = vi.fn<
    NonNullable<ProviderServiceShape["prepareConversationRollback"]>
  >(() => Effect.void);
  const commitConversationRollback = vi.fn<
    NonNullable<ProviderServiceShape["commitConversationRollback"]>
  >(() => Effect.void);
  const finishConversationRollback = vi.fn<
    NonNullable<ProviderServiceShape["finishConversationRollback"]>
  >(() => Effect.void);

  const unsupported = <A>() =>
    Effect.die(new Error("Unsupported provider call in test")) as Effect.Effect<A, never>;
  const listSessions = () =>
    hasSession
      ? Effect.succeed([
          {
            provider: providerName,
            status: "ready",
            runtimeMode: "full-access",
            threadId: ThreadId.make("thread-1"),
            cwd: sessionCwd,
            createdAt: now,
            updatedAt: now,
          },
        ] satisfies ReadonlyArray<ProviderSession>)
      : Effect.succeed([] as ReadonlyArray<ProviderSession>);
  const service: ProviderServiceShape = {
    startSession: () => unsupported(),
    forkSession: () => unsupported(),
    discardSessionFork: () => unsupported(),
    sendTurn: () => unsupported(),
    steerTurn: () => unsupported(),
    interruptTurn: () => unsupported(),
    respondToRequest: () => unsupported(),
    respondToUserInput: () => unsupported(),
    snoozeUserInput: () => unsupported(),
    stopSession: () => unsupported(),
    quiesceThreadForHardDelete: () => unsupported(),
    restartProviderRuntime: () => unsupported(),
    listSessions,
    getCapabilities: () =>
      Effect.succeed({ sessionModelSwitch: "in-session", liveSteer: "unsupported" }),
    getInstanceInfo: (instanceId) =>
      Effect.succeed({
        instanceId,
        driverKind: ProviderDriverKind.make(providerName),
        displayName: undefined,
        enabled: true,
        continuationIdentity: {
          driverKind: ProviderDriverKind.make(providerName),
          continuationKey: `${providerName}:instance:${instanceId}`,
        },
      }),
    rollbackConversation,
    prepareConversationRollback,
    commitConversationRollback,
    finishConversationRollback,
    readSubagentDetail: () => unsupported(),
    get streamEvents() {
      return Stream.fromPubSub(runtimeEventPubSub);
    },
  };

  const emit = (event: LegacyProviderRuntimeEvent): void => {
    Effect.runSync(PubSub.publish(runtimeEventPubSub, event as unknown as ProviderRuntimeEvent));
  };

  return {
    service,
    rollbackConversation,
    prepareConversationRollback,
    commitConversationRollback,
    finishConversationRollback,
    emit,
  };
}

async function waitForThread(
  readModel: () => Promise<{
    readonly threads: ReadonlyArray<{
      readonly id: ThreadId;
      readonly latestTurn: { readonly turnId: string } | null;
      readonly checkpoints: ReadonlyArray<{ readonly checkpointTurnCount: number }>;
      readonly activities: ReadonlyArray<{ readonly kind: string }>;
    }>;
  }>,
  predicate: (thread: {
    latestTurn: { turnId: string } | null;
    checkpoints: ReadonlyArray<{ checkpointTurnCount: number }>;
    activities: ReadonlyArray<{ kind: string }>;
  }) => boolean,
  timeoutMs = 15_000,
) {
  const deadline = (await Effect.runPromise(Clock.currentTimeMillis)) + timeoutMs;
  const poll = async (): Promise<{
    latestTurn: { turnId: string } | null;
    checkpoints: ReadonlyArray<{ checkpointTurnCount: number }>;
    activities: ReadonlyArray<{ kind: string }>;
  }> => {
    const snapshot = await readModel();
    const thread = snapshot.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    if (thread && predicate(thread)) {
      return thread;
    }
    if ((await Effect.runPromise(Clock.currentTimeMillis)) >= deadline) {
      throw new Error("Timed out waiting for thread state.");
    }
    await Effect.runPromise(Effect.sleep("10 millis"));
    return poll();
  };
  return poll();
}

async function waitForEvent(
  engine: OrchestrationEngineShape,
  predicate: (event: { type: string }) => boolean,
  timeoutMs = 15_000,
) {
  const deadline = (await Effect.runPromise(Clock.currentTimeMillis)) + timeoutMs;
  const poll = async () => {
    const events = await Effect.runPromise(
      Stream.runCollect(engine.readEvents(0)).pipe(Effect.map((chunk) => Array.from(chunk))),
    );
    if (events.some(predicate)) {
      return events;
    }
    if ((await Effect.runPromise(Clock.currentTimeMillis)) >= deadline) {
      throw new Error("Timed out waiting for orchestration event.");
    }
    await Effect.runPromise(Effect.sleep("10 millis"));
    return poll();
  };
  return poll();
}

function runGit(cwd: string, args: ReadonlyArray<string>) {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
}

function createGitRepository() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "cafe-code-checkpoint-handler-"));
  runGit(cwd, ["init", "--initial-branch=main"]);
  runGit(cwd, ["config", "user.email", "test@example.com"]);
  runGit(cwd, ["config", "user.name", "Test User"]);
  runGit(cwd, ["config", "core.autocrlf", "false"]);
  fs.writeFileSync(path.join(cwd, "README.md"), "v1\n", "utf8");
  runGit(cwd, ["add", "."]);
  runGit(cwd, ["commit", "-m", "Initial"]);
  return cwd;
}

function gitRefExists(cwd: string, ref: string): boolean {
  try {
    runGit(cwd, ["show-ref", "--verify", "--quiet", ref]);
    return true;
  } catch {
    return false;
  }
}

function gitShowFileAtRef(cwd: string, ref: string, filePath: string): string {
  return runGit(cwd, ["show", `${ref}:${filePath}`]);
}

async function waitForGitRefExists(cwd: string, ref: string, timeoutMs = 15_000) {
  const deadline = (await Effect.runPromise(Clock.currentTimeMillis)) + timeoutMs;
  const poll = async (): Promise<void> => {
    if (gitRefExists(cwd, ref)) {
      return;
    }
    if ((await Effect.runPromise(Clock.currentTimeMillis)) >= deadline) {
      throw new Error(`Timed out waiting for git ref '${ref}'.`);
    }
    await Effect.runPromise(Effect.sleep("10 millis"));
    return poll();
  };
  return poll();
}

async function waitForGitRefMissing(cwd: string, ref: string, timeoutMs = 15_000) {
  const deadline = (await Effect.runPromise(Clock.currentTimeMillis)) + timeoutMs;
  const poll = async (): Promise<void> => {
    if (!gitRefExists(cwd, ref)) {
      return;
    }
    if ((await Effect.runPromise(Clock.currentTimeMillis)) >= deadline) {
      throw new Error(`Timed out waiting for git ref '${ref}' to be pruned.`);
    }
    await Effect.runPromise(Effect.sleep("10 millis"));
    return poll();
  };
  return poll();
}

describe("CheckpointReactor", () => {
  let runtime: ManagedRuntime.ManagedRuntime<
    | OrchestrationEngineService
    | CheckpointReactor
    | CheckpointStore
    | ProjectionSnapshotQuery
    | RuntimeReceiptBus
    | SqlClient.SqlClient,
    unknown
  > | null = null;
  let scope: Scope.Closeable | null = null;
  const tempDirs: string[] = [];

  afterEach(async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  async function createHarness(options?: {
    readonly hasSession?: boolean;
    readonly seedFilesystemCheckpoints?: boolean;
    readonly projectWorkspaceRoot?: string;
    readonly threadWorktreePath?: string | null;
    readonly providerSessionCwd?: string;
    readonly providerName?: ProviderDriverKind;
    readonly gitStatusRefreshCalls?: Array<string>;
    readonly gitStatusFullRefreshCalls?: Array<string>;
    readonly autoPublishIngestionReceipt?: boolean;
    readonly runtimeReceiptBusLayer?: Layer.Layer<RuntimeReceiptBus>;
    readonly ingestionDrain?: Effect.Effect<void>;
    readonly testClock?: Clock.Clock;
  }) {
    const cwd = createGitRepository();
    tempDirs.push(cwd);
    const provider = createProviderServiceHarness(
      cwd,
      options?.hasSession ?? true,
      options?.providerSessionCwd ?? cwd,
      options?.providerName ?? ProviderDriverKind.make("codex"),
    );
    const orchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(RepositoryIdentityResolverLive),
      Layer.provide(SqlitePersistenceMemory),
    );
    const projectionSnapshotLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
      Layer.provide(RepositoryIdentityResolverLive),
      Layer.provide(SqlitePersistenceMemory),
    );

    const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
      prefix: "cafe-code-checkpoint-reactor-test-",
    });
    const gitStatusFullRefreshCalls = options?.gitStatusFullRefreshCalls;
    const vcsStatusBroadcasterLayer = Layer.succeed(VcsStatusBroadcaster, {
      getStatus: () => Effect.die("getStatus should not be called in this test"),
      refreshLocalStatus: (cwd: string) =>
        Effect.sync(() => {
          options?.gitStatusRefreshCalls?.push(cwd);
        }).pipe(
          Effect.as({
            isRepo: true,
            hasPrimaryRemote: false,
            isDefaultRef: true,
            refName: "main",
            hasWorkingTreeChanges: false,
            workingTree: { files: [], insertions: 0, deletions: 0 },
          }),
        ),
      refreshStatus: (cwd: string) =>
        gitStatusFullRefreshCalls
          ? Effect.sync(() => {
              gitStatusFullRefreshCalls.push(cwd);
            }).pipe(
              Effect.as({
                isRepo: true,
                hasPrimaryRemote: true,
                isDefaultRef: true,
                refName: "main",
                hasWorkingTreeChanges: false,
                workingTree: { files: [], insertions: 0, deletions: 0 },
                hasUpstream: true,
                aheadCount: 0,
                behindCount: 0,
                pr: null,
              }),
            )
          : Effect.die("refreshStatus should not be called in this test"),
      streamStatus: () => Stream.empty,
    });

    const layer = CheckpointReactorLive.pipe(
      Layer.provideMerge(orchestrationLayer),
      Layer.provideMerge(projectionSnapshotLayer),
      Layer.provideMerge(options?.runtimeReceiptBusLayer ?? RuntimeReceiptBusLive),
      Layer.provideMerge(Layer.succeed(ProviderService, provider.service)),
      Layer.provide(
        Layer.succeed(ProviderRuntimeIngestionService, {
          start: () => Effect.void,
          drain: options?.ingestionDrain ?? Effect.void,
          retireThreadForHardDelete: () => Effect.void,
          completeThreadHardDelete: () => Effect.void,
        }),
      ),
      Layer.provideMerge(vcsStatusBroadcasterLayer),
      Layer.provideMerge(CheckpointStoreLive.pipe(Layer.provide(VcsDriverRegistry.layer))),
      Layer.provideMerge(
        WorkspaceEntriesLive.pipe(
          Layer.provide(WorkspacePathsLive),
          Layer.provideMerge(VcsDriverRegistry.layer),
        ),
      ),
      Layer.provideMerge(WorkspacePathsLive),
      Layer.provideMerge(VcsProcess.layer),
      Layer.provideMerge(ServerConfigLayer),
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(SqlitePersistenceMemory),
    );

    runtime = ManagedRuntime.make(
      options?.testClock
        ? layer.pipe(Layer.provideMerge(Layer.succeed(Clock.Clock, options.testClock)))
        : layer,
    );
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const snapshotQuery = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
    const reactor = await runtime.runPromise(Effect.service(CheckpointReactor));
    const checkpointStore = await runtime.runPromise(Effect.service(CheckpointStore));
    const sql = await runtime.runPromise(Effect.service(SqlClient.SqlClient));
    const receiptBus = await runtime.runPromise(Effect.service(RuntimeReceiptBus));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reactor.start().pipe(Scope.provide(scope)));
    const drain = () => Effect.runPromise(reactor.drain);
    const publishIngestionReceipt = (event: LegacyProviderRuntimeEvent) => {
      if (event.type !== "turn.completed" || !event.turnId) {
        return Promise.resolve();
      }
      return runtime!.runPromise(
        receiptBus.publish({
          type: "provider.turn.ingestion-quiesced",
          threadId: event.threadId,
          turnId: TurnId.make(String(event.turnId)),
          provider: event.provider,
          ...(event.providerInstanceId ? { providerInstanceId: event.providerInstanceId } : {}),
          sourceEventId: event.eventId,
          createdAt: event.createdAt,
        }),
      );
    };
    const emit = (event: LegacyProviderRuntimeEvent): void => {
      provider.emit(event);
      if (options?.autoPublishIngestionReceipt !== false) {
        void publishIngestionReceipt(event);
      }
    };

    const createdAt = "2026-01-01T00:00:00.000Z";
    await Effect.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-create"),
        projectId: asProjectId("project-1"),
        title: "Test Project",
        workspaceRoot: options?.projectWorkspaceRoot ?? cwd,
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await Effect.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-create"),
        threadId: ThreadId.make("thread-1"),
        projectId: asProjectId("project-1"),
        title: "Thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: options?.threadWorktreePath ?? cwd,
        createdAt,
      }),
    );

    if (options?.seedFilesystemCheckpoints ?? true) {
      await runtime.runPromise(
        checkpointStore.captureCheckpoint({
          cwd,
          checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
        }),
      );
      fs.writeFileSync(path.join(cwd, "README.md"), "v2\n", "utf8");
      await runtime.runPromise(
        checkpointStore.captureCheckpoint({
          cwd,
          checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
        }),
      );
      fs.writeFileSync(path.join(cwd, "README.md"), "v3\n", "utf8");
      await runtime.runPromise(
        checkpointStore.captureCheckpoint({
          cwd,
          checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 2),
        }),
      );
    }

    return {
      engine,
      readModel: () => Effect.runPromise(snapshotQuery.getSnapshot()),
      provider: {
        ...provider,
        emit,
      },
      publishIngestionReceipt,
      cwd,
      drain,
      checkpointStore,
      snapshotQuery,
      sql,
    };
  }

  // Real filesystem refs and the real SQL-backed orchestration projection are
  // used below. Only the native provider phases are mocked, so the tests can
  // prove when recoverable files and durable conversation receipts exist.
  async function createRewindHarness(
    providerName: ProviderDriverKind = ProviderDriverKind.make("claudeAgent"),
    turnCounts: ReadonlyArray<number> = [1, 2],
    ingestionDrain?: Effect.Effect<void>,
    options?: { readonly testClock?: Clock.Clock; readonly gitStatusRefreshCalls?: string[] },
  ) {
    const harness = await createHarness({
      providerName,
      ...(ingestionDrain ? { ingestionDrain } : {}),
      ...options,
    });
    const threadId = ThreadId.make("thread-1");
    const createdAt = "2026-01-01T00:00:00.000Z";
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("rewind-session"),
        threadId,
        session: {
          threadId,
          status: "ready",
          providerName,
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );
    for (const turnCount of turnCounts) {
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.diff.complete",
          commandId: CommandId.make(`rewind-diff-${turnCount}`),
          threadId,
          turnId: asTurnId(`native-turn-${turnCount}`),
          checkpointTurnCount: turnCount,
          checkpointRef: checkpointRefForThreadTurn(threadId, turnCount),
          status: "ready",
          files: [],
          createdAt,
          completedAt: createdAt,
        }),
      );
    }
    await harness.drain();
    const request = (turnCount = 1) =>
      Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.checkpoint.revert",
          commandId: CommandId.make(`rewind-request-${crypto.randomUUID()}`),
          threadId,
          turnCount,
          createdAt,
        }),
      );
    return {
      ...harness,
      request,
      recoveryRef: checkpointRefForThreadTurn(threadId, Number.MAX_SAFE_INTEGER),
    };
  }

  it("keeps historical checkpoints fenced after detach/reattach and captures a fresh baseline", async () => {
    const harness = await createHarness();
    const threadId = ThreadId.make("thread-1");
    const originalRef = checkpointRefForThreadTurn(threadId, 1);
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("fence-old-diff"),
        threadId,
        turnId: asTurnId("old-turn"),
        checkpointTurnCount: 1,
        checkpointRef: originalRef,
        status: "ready",
        files: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    await harness.drain();
    for (const [projectId, createdAt] of [
      [null, "2026-01-01T00:01:00.000Z"],
      [asProjectId("project-1"), "2026-01-01T00:02:00.000Z"],
    ] as const) {
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make(`fence-move-${createdAt}`),
          threadId,
          projectId,
        }),
      );
      await harness.drain();
    }
    const context = await Effect.runPromise(
      harness.snapshotQuery.getThreadCheckpointContext(threadId),
    );
    if (context._tag !== "Some" || !context.value.workspaceFence)
      throw new Error("Missing durable association fence");
    const fence = context.value.workspaceFence;
    // Deliberately behind the server's association clock: native timestamps
    // are display data, not proof of destination workspace authority.
    const afterMove = "2026-01-01T00:04:00.000Z";
    expect(fence.invalidThroughTurnCount).toBe(1);
    expect(context.value.checkpoints).toHaveLength(1);
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.make("fence-revert-old"),
        threadId,
        turnCount: 1,
        createdAt: "2026-01-01T00:03:00.000Z",
      }),
    );
    await waitForThread(harness.readModel, (thread) =>
      thread.activities.some((activity) => activity.kind === "checkpoint.revert.failed"),
    );
    expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(harness.cwd, "README.md"), "utf8")).toBe("v3\n");
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("fence-new-request"),
        threadId,
        message: {
          messageId: MessageId.make("fence-new-user"),
          role: "user",
          text: "New explicit request",
          attachments: [],
        },
        runtimeMode: "approval-required",
        interactionMode: "default",
        createdAt: afterMove,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("fence-bind-request"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("new-turn"),
          lastError: null,
          updatedAt: afterMove,
        },
        createdAt: afterMove,
      }),
    );
    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.make("fence-new-turn"),
      provider: ProviderDriverKind.make("codex"),
      threadId,
      turnId: asTurnId("new-turn"),
      createdAt: afterMove,
    });
    const baselineRef = checkpointRefForThreadTurn(threadId, 1, fence.associationSequence);
    await waitForGitRefExists(harness.cwd, baselineRef);
    expect(gitShowFileAtRef(harness.cwd, baselineRef, "README.md")).toBe("v3\n");
    expect(gitShowFileAtRef(harness.cwd, originalRef, "README.md")).toBe("v2\n");
    fs.writeFileSync(path.join(harness.cwd, "README.md"), "v4\n");
    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("fence-new-completed"),
      provider: ProviderDriverKind.make("codex"),
      threadId,
      turnId: asTurnId("new-turn"),
      createdAt: new Date(Date.parse(afterMove) + 1_000).toISOString(),
      payload: { state: "completed" },
    });
    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForThreadTurn(threadId, 2, fence.associationSequence),
    );
    expect(gitShowFileAtRef(harness.cwd, originalRef, "README.md")).toBe("v2\n");
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("fence-ready"),
        threadId,
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: afterMove,
        },
        createdAt: afterMove,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.make("fence-revert-fresh-baseline"),
        threadId,
        turnCount: 1,
        createdAt: afterMove,
      }),
    );
    await waitForEvent(harness.engine, (event) => event.type === "thread.reverted");
    expect(fs.readFileSync(path.join(harness.cwd, "README.md"), "utf8")).toBe("v3\n");
    expect(harness.provider.rollbackConversation).toHaveBeenCalledTimes(1);
  });

  it("does not capture newly discovered native history after association change without a Cafe request", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const threadId = ThreadId.make("thread-1");
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("unknown-detach"),
        threadId,
        projectId: null,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("unknown-attach"),
        threadId,
        projectId: asProjectId("project-1"),
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("unknown-historical-placeholder"),
        threadId,
        turnId: asTurnId("newly-discovered-old-turn"),
        checkpointTurnCount: 1,
        checkpointRef: CheckpointRef.make("provider-diff:old-history"),
        status: "missing",
        files: [],
        createdAt: "2099-01-01T00:00:00.000Z",
        completedAt: "2099-01-01T00:00:00.000Z",
      }),
    );
    await harness.drain();
    const context = await Effect.runPromise(
      harness.snapshotQuery.getThreadCheckpointContext(
        threadId,
        asTurnId("newly-discovered-old-turn"),
      ),
    );
    if (context._tag !== "Some" || !context.value.workspaceFence)
      throw new Error("Missing association fence");
    expect(context.value.workspaceFence.eligibleTurn).toBe(false);
    expect(
      gitRefExists(
        harness.cwd,
        checkpointRefForThreadTurn(threadId, 1, context.value.workspaceFence.associationSequence),
      ),
    ).toBe(false);
    expect(context.value.checkpoints[0]?.status).toBe("missing");
    expect(fs.readFileSync(path.join(harness.cwd, "README.md"), "utf8")).toBe("v1\n");
  });

  it("captures pre-turn baseline on turn.started and post-turn checkpoint on turn.completed", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const createdAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-capture"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.make("evt-turn-started-1"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-1"),
    });
    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
    );

    fs.writeFileSync(path.join(harness.cwd, "README.md"), "v2\n", "utf8");
    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-1"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-1"),
      payload: { state: "completed" },
    });

    await waitForEvent(harness.engine, (event) => event.type === "thread.turn-diff-completed");
    const thread = await waitForThread(
      harness.readModel,
      (entry) => entry.latestTurn?.turnId === "turn-1" && entry.checkpoints.length === 1,
    );
    expect(thread.checkpoints[0]?.checkpointTurnCount).toBe(1);
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0)),
    ).toBe(true);
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1)),
    ).toBe(true);
    expect(
      gitShowFileAtRef(
        harness.cwd,
        checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
        "README.md",
      ),
    ).toBe("v1\n");
    expect(
      gitShowFileAtRef(
        harness.cwd,
        checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
        "README.md",
      ),
    ).toBe("v2\n");
  });

  it("waits for provider ingestion quiescence before dispatching terminal turn diff completion", async () => {
    const receiptAwaited = Effect.runSync(Deferred.make<void>());
    const releaseReceipt = Effect.runSync(Deferred.make<void>());
    const runtimeReceiptBusLayer = Layer.succeed(RuntimeReceiptBus, {
      publish: () => Effect.void,
      awaitTurnIngestionQuiesced: (input) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(receiptAwaited, undefined);
          yield* Deferred.await(releaseReceipt);
          return {
            type: "provider.turn.ingestion-quiesced" as const,
            threadId: input.threadId,
            turnId: input.turnId,
            provider: input.provider,
            ...(input.providerInstanceId ? { providerInstanceId: input.providerInstanceId } : {}),
            sourceEventId: EventId.make("evt-controlled-ingestion-quiesced"),
            createdAt: "2026-01-01T00:00:00.000Z",
          };
        }),
      streamEventsForTest: Stream.empty,
    });
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      autoPublishIngestionReceipt: false,
      runtimeReceiptBusLayer,
    });
    const createdAt = "2026-01-01T00:00:00.000Z";

    fs.writeFileSync(path.join(harness.cwd, "README.md"), "v2\n", "utf8");
    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-waits-for-ingestion"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-waits-for-ingestion"),
      payload: { state: "completed" },
    });

    await Effect.runPromise(Deferred.await(receiptAwaited).pipe(Effect.timeout("2 seconds")));
    const eventsBeforeReceipt = await Effect.runPromise(
      Stream.runCollect(harness.engine.readEvents(0)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      ),
    );
    expect(eventsBeforeReceipt.some((event) => event.type === "thread.turn-diff-completed")).toBe(
      false,
    );

    await Effect.runPromise(Deferred.succeed(releaseReceipt, undefined));

    await waitForEvent(harness.engine, (event) => event.type === "thread.turn-diff-completed");
    const thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.latestTurn?.turnId === "turn-waits-for-ingestion" && entry.checkpoints.length === 1,
    );
    expect(thread.checkpoints[0]?.checkpointTurnCount).toBe(1);
  });

  it("does not replace a provider diff placeholder while the turn is still running", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const threadId = ThreadId.make("thread-1");
    const turnId = asTurnId("turn-placeholder-running");

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-running-placeholder"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: turnId,
          lastError: null,
          updatedAt: "2026-01-01T00:00:01.000Z",
        },
        createdAt: "2026-01-01T00:00:01.000Z",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-running-provider-diff-placeholder"),
        threadId,
        turnId,
        completedAt: "2026-01-01T00:00:02.000Z",
        checkpointRef: CheckpointRef.make("provider-diff:midturn"),
        status: "missing",
        files: [],
        assistantMessageId: MessageId.make("assistant:placeholder"),
        checkpointTurnCount: 1,
        createdAt: "2026-01-01T00:00:02.000Z",
      }),
    );
    await harness.drain();

    const events = await Effect.runPromise(
      Stream.runCollect(harness.engine.readEvents(0)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      ),
    );
    const turnDiffEvents = events.filter(
      (event) => event.type === "thread.turn-diff-completed" && event.payload.turnId === turnId,
    );
    const snapshot = await harness.readModel();
    const thread = snapshot.threads.find((entry) => entry.id === threadId);
    const firstTurnDiffPayload =
      turnDiffEvents[0]?.type === "thread.turn-diff-completed" ? turnDiffEvents[0].payload : null;

    expect(turnDiffEvents).toHaveLength(1);
    expect(firstTurnDiffPayload?.status).toBe("missing");
    expect(thread?.latestTurn).toMatchObject({
      turnId,
      state: "running",
      completedAt: null,
    });
  });

  it("prunes old hidden checkpoint refs after capturing a new turn", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const threadId = ThreadId.make("thread-1");
    const createdAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.checkpointStore.captureCheckpoint({
        cwd: harness.cwd,
        checkpointRef: checkpointRefForThreadTurn(threadId, 0),
      }),
    );

    for (const turnCount of [1, 2, 3] as const) {
      fs.writeFileSync(path.join(harness.cwd, "README.md"), `v${turnCount + 1}\n`, "utf8");
      const checkpointRef = checkpointRefForThreadTurn(threadId, turnCount);
      await Effect.runPromise(
        harness.checkpointStore.captureCheckpoint({
          cwd: harness.cwd,
          checkpointRef,
        }),
      );
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.diff.complete",
          commandId: CommandId.make(`cmd-seed-diff-${turnCount}`),
          threadId,
          turnId: asTurnId(`turn-${turnCount}`),
          completedAt: createdAt,
          checkpointRef,
          status: "ready",
          files: [],
          checkpointTurnCount: turnCount,
          createdAt,
        }),
      );
    }
    await waitForThread(harness.readModel, (entry) =>
      entry.checkpoints.some((checkpoint) => checkpoint.checkpointTurnCount === 3),
    );

    fs.writeFileSync(path.join(harness.cwd, "README.md"), "v5\n", "utf8");
    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-prune"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId,
      turnId: asTurnId("turn-4"),
      payload: { state: "completed" },
    });

    await waitForThread(
      harness.readModel,
      (entry) =>
        entry.latestTurn?.turnId === "turn-4" &&
        entry.checkpoints.some((checkpoint) => checkpoint.checkpointTurnCount === 4),
    );
    await harness.drain();

    // Checkpoint ref pruning intentionally runs outside the synchronous
    // provider-turn completion path. The turn diff is durable once drain()
    // returns, but old hidden refs may still be deleting in the cleanup scope.
    await waitForGitRefMissing(harness.cwd, checkpointRefForThreadTurn(threadId, 0));
    await waitForGitRefMissing(harness.cwd, checkpointRefForThreadTurn(threadId, 1));

    expect(gitRefExists(harness.cwd, checkpointRefForThreadTurn(threadId, 0))).toBe(false);
    expect(gitRefExists(harness.cwd, checkpointRefForThreadTurn(threadId, 1))).toBe(false);
    expect(gitRefExists(harness.cwd, checkpointRefForThreadTurn(threadId, 2))).toBe(true);
    expect(gitRefExists(harness.cwd, checkpointRefForThreadTurn(threadId, 3))).toBe(true);
    expect(gitRefExists(harness.cwd, checkpointRefForThreadTurn(threadId, 4))).toBe(true);
  });

  it("refreshes local git status state on turn completion using the session cwd", async () => {
    const gitStatusRefreshCalls: string[] = [];
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      gitStatusRefreshCalls,
    });

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-refresh-local-status"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-refresh-local-status"),
      payload: { state: "completed" },
    });

    await harness.drain();

    expect(gitStatusRefreshCalls).toEqual([harness.cwd]);
  });

  it("refreshes local git status on a provider VCS hint using only the session cwd", async () => {
    const gitStatusRefreshCalls: string[] = [];
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      gitStatusRefreshCalls,
    });

    harness.provider.emit({
      type: "vcs.state.changed",
      eventId: EventId.make("evt-vcs-state-changed-commit"),
      provider: ProviderDriverKind.make("claudeAgent"),
      createdAt: "2026-08-18T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-vcs-state-changed"),
      payload: {
        kind: "commit",
        branch: "main",
        cwd: "/provider/controlled/path",
      },
    });

    await harness.drain();

    expect(gitStatusRefreshCalls).toEqual([harness.cwd]);
  });

  it("refreshes local and remote git status after a provider push hint", async () => {
    const gitStatusFullRefreshCalls: string[] = [];
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      gitStatusFullRefreshCalls,
    });

    harness.provider.emit({
      type: "vcs.state.changed",
      eventId: EventId.make("evt-vcs-state-changed-push"),
      provider: ProviderDriverKind.make("claudeAgent"),
      createdAt: "2026-08-18T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-vcs-state-push"),
      payload: {
        kind: "push",
        branch: "main",
      },
    });

    await harness.drain();

    expect(gitStatusFullRefreshCalls).toEqual([harness.cwd]);
  });

  it("ignores auxiliary thread turn completion while primary turn is active", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const createdAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-primary-running"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-main"),
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.make("evt-turn-started-main"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-main"),
    });
    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
    );

    fs.writeFileSync(path.join(harness.cwd, "README.md"), "v2\n", "utf8");

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-aux"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-aux"),
      payload: { state: "completed" },
    });

    await harness.drain();
    const midReadModel = await harness.readModel();
    const midThread = midReadModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(midThread?.checkpoints).toHaveLength(0);

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-main"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-main"),
      payload: { state: "completed" },
    });

    const thread = await waitForThread(
      harness.readModel,
      (entry) => entry.latestTurn?.turnId === "turn-main" && entry.checkpoints.length === 1,
    );
    expect(thread.checkpoints[0]?.checkpointTurnCount).toBe(1);
  });

  it("captures pre-turn and completion checkpoints for claude runtime events", async () => {
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      providerName: ProviderDriverKind.make("claudeAgent"),
    });
    const createdAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-capture-claude"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.make("evt-turn-started-claude-1"),
      provider: ProviderDriverKind.make("claudeAgent"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-claude-1"),
    });
    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
    );

    fs.writeFileSync(path.join(harness.cwd, "README.md"), "v2\n", "utf8");
    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-claude-1"),
      provider: ProviderDriverKind.make("claudeAgent"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-claude-1"),
      payload: { state: "completed" },
    });

    await waitForEvent(harness.engine, (event) => event.type === "thread.turn-diff-completed");
    const thread = await waitForThread(
      harness.readModel,
      (entry) => entry.latestTurn?.turnId === "turn-claude-1" && entry.checkpoints.length === 1,
    );

    expect(thread.checkpoints[0]?.checkpointTurnCount).toBe(1);
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1)),
    ).toBe(true);
  });

  it("appends capture failure activity when turn diff summary cannot be derived", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const createdAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-missing-baseline-diff"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-missing-baseline"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-missing-baseline"),
      payload: { state: "completed" },
    });

    await waitForEvent(harness.engine, (event) => event.type === "thread.turn-diff-completed");
    const thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.checkpoints.length === 1 &&
        entry.activities.some((activity) => activity.kind === "checkpoint.capture.failed"),
    );

    expect(thread.checkpoints[0]?.checkpointTurnCount).toBe(1);
    expect(
      thread.activities.some((activity) => activity.kind === "checkpoint.capture.failed"),
    ).toBe(true);
  });

  it("captures pre-turn baseline from project workspace root when thread worktree is unset", async () => {
    const harness = await createHarness({
      hasSession: false,
      seedFilesystemCheckpoints: false,
      threadWorktreePath: null,
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-for-baseline"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: MessageId.make("message-user-1"),
          role: "user",
          text: "start turn",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
    );
    expect(
      gitShowFileAtRef(
        harness.cwd,
        checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
        "README.md",
      ),
    ).toBe("v1\n");
  });

  it("captures turn completion checkpoint from project workspace root when provider session cwd is unavailable", async () => {
    const harness = await createHarness({
      hasSession: false,
      seedFilesystemCheckpoints: false,
      threadWorktreePath: null,
    });
    const createdAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-missing-provider-cwd"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-missing-cwd"),
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    fs.writeFileSync(path.join(harness.cwd, "README.md"), "v2\n", "utf8");
    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-missing-provider-cwd"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-missing-cwd"),
      payload: { state: "completed" },
    });

    await waitForEvent(harness.engine, (event) => event.type === "thread.turn-diff-completed");
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1)),
    ).toBe(true);
    expect(
      gitShowFileAtRef(
        harness.cwd,
        checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
        "README.md",
      ),
    ).toBe("v2\n");
  });

  it("continues processing runtime events after a single checkpoint runtime failure", async () => {
    const nonRepositorySessionCwd = fs.mkdtempSync(
      path.join(os.tmpdir(), "cafe-code-checkpoint-runtime-non-repo-"),
    );
    tempDirs.push(nonRepositorySessionCwd);

    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      providerSessionCwd: nonRepositorySessionCwd,
    });
    const createdAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-non-repo-runtime"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-runtime-capture-failure"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-runtime-failure"),
      payload: { state: "completed" },
    });

    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.make("evt-turn-started-after-runtime-failure"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-after-runtime-failure"),
    });

    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
    );
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0)),
    ).toBe(true);
  });

  it("executes provider revert and emits thread.reverted for checkpoint revert requests", async () => {
    const harness = await createHarness();
    const createdAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-diff-1"),
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-1"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
        status: "ready",
        files: [],
        checkpointTurnCount: 1,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-diff-2"),
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-2"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 2),
        status: "ready",
        files: [],
        checkpointTurnCount: 2,
        createdAt,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.make("cmd-revert-request"),
        threadId: ThreadId.make("thread-1"),
        turnCount: 1,
        createdAt,
      }),
    );

    await waitForEvent(harness.engine, (event) => event.type === "thread.reverted");
    await harness.drain();
    const thread = await waitForThread(
      harness.readModel,
      (entry) => entry.checkpoints.length === 1,
    );

    expect(thread.latestTurn?.turnId).toBe("turn-1");
    expect(thread.checkpoints).toHaveLength(1);
    expect(thread.checkpoints[0]?.checkpointTurnCount).toBe(1);
    expect(harness.provider.rollbackConversation).toHaveBeenCalledTimes(1);
    expect(harness.provider.rollbackConversation).toHaveBeenCalledWith({
      threadId: ThreadId.make("thread-1"),
      numTurns: 1,
    });
    expect(fs.readFileSync(path.join(harness.cwd, "README.md"), "utf8")).toBe("v2\n");
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 2)),
    ).toBe(false);
  });

  it.each([
    {
      label: "local uncertain outcome",
      error: new ProviderAdapterRewindOutcomeUnknownError({}),
      uncertain: true,
      preexistingRecovery: false,
    },
    {
      label: "remote uncertain outcome",
      error: new ProviderAdapterRequestError({
        provider: "codex",
        method: "thread/revert",
        remoteErrorTag: "ProviderAdapterRewindOutcomeUnknownError",
        detail: "Private provider transcript and native path must not enter the work log.",
      }),
      uncertain: true,
      preexistingRecovery: false,
    },
    {
      label: "definite provider refusal",
      error: new ProviderAdapterRequestError({
        provider: "codex",
        method: "thread/revert",
        detail: "Provider refused the rewind before mutation.",
      }),
      uncertain: false,
      preexistingRecovery: false,
    },
    {
      label: "recovery snapshot retained by an earlier process",
      error: new ProviderAdapterRewindOutcomeUnknownError({}),
      uncertain: true,
      preexistingRecovery: true,
    },
  ])(
    "preserves safe filesystem recovery for $label",
    async ({ error, uncertain, preexistingRecovery }) => {
      const harness = await createHarness();
      const threadId = ThreadId.make("thread-1");
      const createdAt = "2026-01-01T00:00:00.000Z";
      const recoveryRef = checkpointRefForThreadTurn(threadId, Number.MAX_SAFE_INTEGER);
      const recoveryRequiredMessage =
        "A previous checkpoint recovery snapshot is still present. Stop this thread and inspect its provider history and saved workspace before retrying; the existing recovery snapshot was not changed.";
      harness.provider.rollbackConversation.mockReturnValue(Effect.fail(error));
      if (preexistingRecovery) {
        // Model a crash after the private recovery capture, with subsequent user
        // edits that must not be overwritten by another attempted checkpoint.
        await runtime!.runPromise(
          harness.checkpointStore.captureCheckpoint({
            cwd: harness.cwd,
            checkpointRef: recoveryRef,
          }),
        );
        fs.writeFileSync(path.join(harness.cwd, "README.md"), "edited after crash\n", "utf8");
      }

      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("cmd-session-set-rewind-failure"),
          threadId,
          session: {
            threadId,
            status: "ready",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: null,
            lastError: null,
            updatedAt: createdAt,
          },
          createdAt,
        }),
      );
      for (const turnCount of [1, 2]) {
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.turn.diff.complete",
            commandId: CommandId.make(`cmd-rewind-failure-diff-${turnCount}`),
            threadId,
            turnId: asTurnId(`turn-${turnCount}`),
            completedAt: createdAt,
            checkpointRef: checkpointRefForThreadTurn(threadId, turnCount),
            status: "ready",
            files: [],
            checkpointTurnCount: turnCount,
            createdAt,
          }),
        );
      }

      const dispatch = vi.spyOn(harness.engine, "dispatch");
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.checkpoint.revert",
          commandId: CommandId.make("cmd-rewind-failure-request"),
          threadId,
          turnCount: 1,
          createdAt,
        }),
      );
      await harness.drain();

      const snapshot = await harness.readModel();
      const thread = snapshot.threads.find((entry) => entry.id === threadId);
      const failure = thread?.activities.find(
        (activity) => activity.kind === "checkpoint.revert.failed",
      );
      expect(failure?.payload).toEqual({
        turnCount: 1,
        detail: preexistingRecovery
          ? recoveryRequiredMessage
          : uncertain
            ? new ProviderAdapterRewindOutcomeUnknownError({}).message
            : error.message,
      });
      expect(
        dispatch.mock.calls.some(([command]) => command.type === "thread.revert.complete"),
      ).toBe(false);
      expect(thread?.checkpoints).toHaveLength(2);
      if (preexistingRecovery) expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
      else
        expect(harness.provider.rollbackConversation).toHaveBeenCalledExactlyOnceWith({
          threadId,
          numTurns: 1,
        });
      // An uncertain native commit keeps the target workspace in place and the
      // original v3 content reachable for explicit recovery. A definite refusal
      // still compensates back to v3 and removes the no-longer-needed recovery ref.
      expect(fs.readFileSync(path.join(harness.cwd, "README.md"), "utf8")).toBe(
        preexistingRecovery ? "edited after crash\n" : uncertain ? "v2\n" : "v3\n",
      );
      expect(gitRefExists(harness.cwd, recoveryRef)).toBe(uncertain);
      if (uncertain) expect(gitShowFileAtRef(harness.cwd, recoveryRef, "README.md")).toBe("v3\n");
      expect(gitRefExists(harness.cwd, checkpointRefForThreadTurn(threadId, 2))).toBe(true);

      if (uncertain && !preexistingRecovery) {
        fs.writeFileSync(path.join(harness.cwd, "README.md"), "edited after uncertainty\n", "utf8");
        await Effect.runPromise(
          harness.engine.dispatch({
            type: "thread.checkpoint.revert",
            commandId: CommandId.make("cmd-rewind-failure-retry"),
            threadId,
            turnCount: 1,
            createdAt,
          }),
        );
        await harness.drain();
        expect(harness.provider.rollbackConversation).toHaveBeenCalledTimes(1);
        expect(fs.readFileSync(path.join(harness.cwd, "README.md"), "utf8")).toBe(
          "edited after uncertainty\n",
        );
        expect(gitShowFileAtRef(harness.cwd, recoveryRef, "README.md")).toBe("v3\n");
        const retried = (await harness.readModel()).threads.find((entry) => entry.id === threadId);
        expect(
          retried?.activities
            .filter((activity) => activity.kind === "checkpoint.revert.failed")
            .map((activity) => activity.payload),
        ).toContainEqual({ turnCount: 1, detail: recoveryRequiredMessage });
        expect(
          dispatch.mock.calls.some(([command]) => command.type === "thread.revert.complete"),
        ).toBe(false);
      }
    },
  );

  it("executes provider revert and emits thread.reverted for claude sessions", async () => {
    const harness = await createHarness({ providerName: ProviderDriverKind.make("claudeAgent") });
    const createdAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-claude"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-diff-claude-1"),
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-claude-1"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
        status: "ready",
        files: [],
        checkpointTurnCount: 1,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-diff-claude-2"),
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-claude-2"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 2),
        status: "ready",
        files: [],
        checkpointTurnCount: 2,
        createdAt,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.make("cmd-revert-request-claude"),
        threadId: ThreadId.make("thread-1"),
        turnCount: 1,
        createdAt,
      }),
    );

    await waitForEvent(harness.engine, (event) => event.type === "thread.reverted");
    await harness.drain();
    expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
    const prepared = harness.provider.prepareConversationRollback.mock.calls[0]?.[0];
    expect(prepared).toEqual({
      threadId: ThreadId.make("thread-1"),
      numTurns: 1,
      operationId: expect.any(String),
      expectedControlSequence: expect.any(Number),
      firstRemovedTurnId: asTurnId("turn-claude-2"),
      retainedTurnCount: 1,
    });
    expect(harness.provider.prepareConversationRollback).toHaveBeenCalledTimes(1);
    expect(harness.provider.commitConversationRollback).toHaveBeenCalledExactlyOnceWith({
      threadId: ThreadId.make("thread-1"),
      operationId: prepared?.operationId,
    });
    expect(harness.provider.finishConversationRollback).toHaveBeenCalledExactlyOnceWith({
      threadId: ThreadId.make("thread-1"),
      operationId: prepared?.operationId,
      outcome: "committed",
      completionCommandId: expect.any(String),
    });
  });

  it("waits for Claude preparation before capturing or restoring files and retains recovery until the exact projection receipt", async () => {
    const harness = await createRewindHarness();
    const entered = Effect.runSync(Deferred.make<void>());
    const release = Effect.runSync(Deferred.make<void>());
    const order: string[] = [];
    const capture = harness.checkpointStore.captureCheckpoint;
    const restore = harness.checkpointStore.restoreCheckpoint;
    const remove = harness.checkpointStore.deleteCheckpointRefs;
    const dispatch = harness.engine.dispatch;
    const captureSpy = vi
      .spyOn(harness.checkpointStore, "captureCheckpoint")
      .mockImplementation((input) =>
        Effect.sync(() => order.push("capture")).pipe(Effect.andThen(capture(input))),
      );
    const restoreSpy = vi
      .spyOn(harness.checkpointStore, "restoreCheckpoint")
      .mockImplementation((input) =>
        Effect.sync(() => order.push("restore")).pipe(Effect.andThen(restore(input))),
      );
    vi.spyOn(harness.checkpointStore, "deleteCheckpointRefs").mockImplementation((input) =>
      Effect.sync(() => {
        order.push(
          input.checkpointRefs.includes(harness.recoveryRef) ? "delete recovery" : "prune",
        );
      }).pipe(Effect.andThen(remove(input))),
    );
    let completionCommandId: string | undefined;
    vi.spyOn(harness.engine, "dispatch").mockImplementation((command) => {
      if (command.type !== "thread.revert.complete") return dispatch(command);
      completionCommandId = command.commandId;
      return Effect.sync(() => {
        order.push("projection");
        expect(gitRefExists(harness.cwd, harness.recoveryRef)).toBe(true);
        expect(
          gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 2)),
        ).toBe(true);
      }).pipe(Effect.andThen(dispatch(command)));
    });
    harness.provider.prepareConversationRollback.mockImplementation(() =>
      Effect.sync(() => order.push("prepare")).pipe(
        Effect.andThen(Deferred.succeed(entered, undefined)),
        Effect.andThen(Deferred.await(release)),
      ),
    );
    harness.provider.commitConversationRollback.mockImplementation(() =>
      Effect.sync(() => {
        order.push("commit");
        expect(fs.readFileSync(path.join(harness.cwd, "README.md"), "utf8")).toBe("v2\n");
        expect(gitShowFileAtRef(harness.cwd, harness.recoveryRef, "README.md")).toBe("v3\n");
      }),
    );
    harness.provider.finishConversationRollback.mockImplementation((input) =>
      Effect.gen(function* () {
        order.push("finish");
        expect(input).toMatchObject({ outcome: "committed", completionCommandId });
        const snapshot = yield* harness.snapshotQuery.getSnapshot();
        expect(snapshot.threads[0]?.checkpoints).toHaveLength(1);
        expect(gitRefExists(harness.cwd, harness.recoveryRef)).toBe(true);
      }),
    );
    try {
      await harness.request();
      await Effect.runPromise(Deferred.await(entered).pipe(Effect.timeout("5 seconds")));
      expect(captureSpy).not.toHaveBeenCalled();
      expect(restoreSpy).not.toHaveBeenCalled();
      expect(fs.readFileSync(path.join(harness.cwd, "README.md"), "utf8")).toBe("v3\n");
    } finally {
      // Always release the synthetic provider barrier before scope cleanup, even
      // when an ordering assertion fails. No provider or wall-clock race is used.
      await Effect.runPromise(Deferred.succeed(release, undefined));
      await harness.drain();
    }
    expect(order).toEqual([
      "prepare",
      "capture",
      "restore",
      "commit",
      "projection",
      "finish",
      "prune",
      "delete recovery",
    ]);
    const events = await Effect.runPromise(Stream.runCollect(harness.engine.readEvents(0)));
    const requested = events.find((event) => event.type === "thread.checkpoint-revert-requested");
    expect(harness.provider.prepareConversationRollback.mock.calls[0]?.[0]).toMatchObject({
      firstRemovedTurnId: "native-turn-2",
      expectedControlSequence: requested?.sequence,
    });
    expect(gitRefExists(harness.cwd, harness.recoveryRef)).toBe(false);
  });

  it.each([
    "prepareConversationRollback",
    "commitConversationRollback",
    "finishConversationRollback",
  ] as const)(
    "refuses Claude rewind without %s before capturing or changing files",
    async (method) => {
      const harness = await createRewindHarness();
      delete harness.provider.service[method];
      const capture = vi.spyOn(harness.checkpointStore, "captureCheckpoint");
      const restore = vi.spyOn(harness.checkpointStore, "restoreCheckpoint");
      await harness.request();
      await harness.drain();
      expect(capture).not.toHaveBeenCalled();
      expect(restore).not.toHaveBeenCalled();
      expect(harness.provider.prepareConversationRollback).not.toHaveBeenCalled();
      expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
      const snapshot = await harness.readModel();
      expect(snapshot.threads[0]?.activities).toContainEqual(
        expect.objectContaining({ kind: "checkpoint.revert.failed" }),
      );
    },
  );

  it("drains old-generation ingestion after Claude preparation and before touching the workspace", async () => {
    const entered = Effect.runSync(Deferred.make<void>());
    const release = Effect.runSync(Deferred.make<void>());
    const harness = await createRewindHarness(
      ProviderDriverKind.make("claudeAgent"),
      [1, 2],
      Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
    );
    const capture = vi.spyOn(harness.checkpointStore, "captureCheckpoint");
    const restore = vi.spyOn(harness.checkpointStore, "restoreCheckpoint");
    try {
      await harness.request();
      await Effect.runPromise(Deferred.await(entered).pipe(Effect.timeout("5 seconds")));
      expect(harness.provider.prepareConversationRollback).toHaveBeenCalledTimes(1);
      expect(harness.provider.commitConversationRollback).not.toHaveBeenCalled();
      expect(capture).not.toHaveBeenCalled();
      expect(restore).not.toHaveBeenCalled();
      expect(fs.readFileSync(path.join(harness.cwd, "README.md"), "utf8")).toBe("v3\n");
    } finally {
      await Effect.runPromise(Deferred.succeed(release, undefined));
      await harness.drain();
    }
    expect(harness.provider.finishConversationRollback).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ outcome: "committed" }),
    );
  });

  it("bounds a stuck ingestion drain without restoring files or releasing its prepared reservation", async () => {
    const drainEntered = Effect.runSync(Deferred.make<void>());
    const timerEntered = Effect.runSync(Deferred.make<void>());
    const expire = Effect.runSync(Deferred.make<void>());
    const liveClock = Effect.runSync(Effect.service(Clock.Clock));
    const harness = await createRewindHarness(
      ProviderDriverKind.make("claudeAgent"),
      [1, 2],
      Deferred.succeed(drainEntered, undefined).pipe(Effect.andThen(Effect.never)),
      {
        testClock: {
          currentTimeMillisUnsafe: () => liveClock.currentTimeMillisUnsafe(),
          currentTimeNanosUnsafe: () => liveClock.currentTimeNanosUnsafe(),
          currentTimeMillis: liveClock.currentTimeMillis,
          currentTimeNanos: liveClock.currentTimeNanos,
          sleep: (duration) =>
            Duration.toMillis(duration) === 30_000
              ? Deferred.succeed(timerEntered, undefined).pipe(
                  Effect.andThen(Deferred.await(expire)),
                )
              : liveClock.sleep(duration),
        },
      },
    );
    const capture = vi.spyOn(harness.checkpointStore, "captureCheckpoint");
    const restore = vi.spyOn(harness.checkpointStore, "restoreCheckpoint");
    try {
      await harness.request();
      await Effect.runPromise(Deferred.await(drainEntered).pipe(Effect.timeout("5 seconds")));
      await Effect.runPromise(Deferred.await(timerEntered).pipe(Effect.timeout("5 seconds")));
    } finally {
      await Effect.runPromise(Deferred.succeed(expire, undefined));
      await harness.drain();
    }
    expect(capture).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
    expect(harness.provider.prepareConversationRollback).toHaveBeenCalledTimes(1);
    expect(harness.provider.commitConversationRollback).not.toHaveBeenCalled();
    expect(harness.provider.finishConversationRollback).not.toHaveBeenCalled();
    expect((await harness.readModel()).threads[0]?.activities).toContainEqual(
      expect.objectContaining({
        kind: "checkpoint.revert.failed",
        payload: { turnCount: 1, detail: new ProviderAdapterRewindOutcomeUnknownError({}).message },
      }),
    );
  });

  it("does not recreate a removed checkpoint from a retired native generation with an old terminal receipt", async () => {
    const refreshes: string[] = [];
    const harness = await createRewindHarness(
      ProviderDriverKind.make("claudeAgent"),
      [1, 2],
      undefined,
      { gitStatusRefreshCalls: refreshes },
    );
    await harness.request();
    await harness.drain();
    // Simulate the durable service's completed rewind and later fresh runtime.
    // The SQL store, not the mocked provider's current in-memory list, owns the
    // generation fence. No external database or native provider is involved.
    const threadId = ThreadId.make("thread-1");
    const instanceId = ProviderInstanceId.make("claude-fixture");
    const original = {
      threadId,
      provider: "claudeAgent",
      providerInstanceId: instanceId,
      status: "ready",
      runtimeMode: "full-access",
      subagentRuntimeId: "retired-generation",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    await Effect.runPromise(harness.sql`
      INSERT INTO provider_session_runtime
        (thread_id,provider_name,provider_instance_id,adapter_key,runtime_mode,status,last_seen_at,runtime_payload_json)
      VALUES (${threadId},'claudeAgent',${instanceId},'fixture','full-access','ready',
        '2026-01-01T00:00:00.000Z',${JSON.stringify({ subagentRuntimeId: "fresh-generation" })})
    `);
    await Effect.runPromise(harness.sql`
      INSERT INTO provider_conversation_rewinds
        (thread_id,operation_id,phase,provider_instance_id,runtime_id,expected_control_sequence,
          retained_turn_count,removed_turn_count,first_removed_turn_id,original_session_json,candidate_session_json)
      VALUES (${threadId},${crypto.randomUUID()},'finished',${instanceId},'retired-generation',0,
        1,1,'native-turn-2',${JSON.stringify(original)},NULL)
    `);
    const capture = vi.spyOn(harness.checkpointStore, "captureCheckpoint");
    const prune = vi.spyOn(harness.checkpointStore, "deleteCheckpointRefs");
    // publishIngestionReceipt deliberately leaves an apparently valid previous
    // terminal acknowledgement: that must not override retired-generation SQL.
    const retiredTerminal: LegacyProviderRuntimeEvent = {
      type: "turn.completed",
      eventId: EventId.make("retired-terminal"),
      threadId,
      provider: ProviderDriverKind.make("claudeAgent"),
      providerInstanceId: instanceId,
      subagentRuntimeId: "retired-generation",
      turnId: "native-turn-2",
      createdAt: "2026-01-01T00:00:00.000Z",
      payload: { state: "completed" },
    };
    await harness.publishIngestionReceipt(retiredTerminal);
    harness.provider.emit(retiredTerminal);
    // A valid fresh-generation invalidation behind the stale frame is an
    // explicit processing barrier, avoiding a timing-based negative assertion.
    harness.provider.emit({
      type: "vcs.state.changed",
      eventId: EventId.make("fresh-after-retired"),
      threadId,
      provider: ProviderDriverKind.make("claudeAgent"),
      providerInstanceId: instanceId,
      subagentRuntimeId: "fresh-generation",
      createdAt: "2026-01-01T00:00:01.000Z",
      payload: { kind: "commit" },
    });
    await expect.poll(() => refreshes.length).toBe(1);
    await harness.drain();
    expect(capture).not.toHaveBeenCalled();
    expect(prune).not.toHaveBeenCalled();
    expect(gitRefExists(harness.cwd, checkpointRefForThreadTurn(threadId, 2))).toBe(false);
    expect((await harness.readModel()).threads[0]?.checkpoints).toHaveLength(1);
  });

  it("does not resurrect an old placeholder queued behind a successful rewind", async () => {
    const harness = await createRewindHarness();
    const committing = Effect.runSync(Deferred.make<void>());
    const release = Effect.runSync(Deferred.make<void>());
    harness.provider.commitConversationRollback.mockReturnValue(
      Deferred.succeed(committing, undefined).pipe(Effect.andThen(Deferred.await(release))),
    );
    const capture = vi.spyOn(harness.checkpointStore, "captureCheckpoint");
    const threadId = ThreadId.make("thread-1");
    try {
      await harness.request();
      await Effect.runPromise(Deferred.await(committing).pipe(Effect.timeout("5 seconds")));
      // This represents ingestion that started before admission was fenced and
      // already durably projected its placeholder; its checkpoint worker item
      // cannot run until the current rewind releases the same serial worker.
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.diff.complete",
          commandId: CommandId.make("old-placeholder-during-rewind"),
          threadId,
          turnId: asTurnId("native-turn-2"),
          checkpointTurnCount: 2,
          checkpointRef: checkpointRefForThreadTurn(threadId, 2),
          status: "missing",
          files: [],
          createdAt: "2026-01-01T00:00:01.000Z",
          completedAt: "2026-01-01T00:00:01.000Z",
        }),
      );
    } finally {
      await Effect.runPromise(Deferred.succeed(release, undefined));
      await harness.drain();
    }
    expect(capture).toHaveBeenCalledExactlyOnceWith({
      cwd: harness.cwd,
      checkpointRef: harness.recoveryRef,
    });
    expect(gitRefExists(harness.cwd, checkpointRefForThreadTurn(threadId, 2))).toBe(false);
    expect((await harness.readModel()).threads[0]?.checkpoints).toHaveLength(1);
  });

  it("retains recovery and native admission when a newer user control arrives after native commit", async () => {
    const harness = await createRewindHarness();
    const threadId = ThreadId.make("thread-1");
    harness.provider.commitConversationRollback.mockImplementation(() =>
      harness.engine
        .dispatch({
          type: "thread.runtime-mode.set",
          commandId: CommandId.make("newer-control-after-native-commit"),
          threadId,
          runtimeMode: "full-access",
          createdAt: "2026-01-01T00:00:02.000Z",
        })
        .pipe(Effect.orDie, Effect.asVoid),
    );
    const restore = vi.spyOn(harness.checkpointStore, "restoreCheckpoint");
    const dispatch = vi.spyOn(harness.engine, "dispatch");
    await harness.request();
    await harness.drain();
    expect(harness.provider.commitConversationRollback).toHaveBeenCalledTimes(1);
    expect(harness.provider.finishConversationRollback).not.toHaveBeenCalled();
    const prepared = harness.provider.prepareConversationRollback.mock.calls[0]?.[0];
    const complete = dispatch.mock.calls.find(
      ([command]) => command.type === "thread.revert.complete",
    )?.[0];
    expect(complete).toMatchObject({ expectedControlSequence: prepared?.expectedControlSequence });
    expect(restore).toHaveBeenCalledExactlyOnceWith({
      cwd: harness.cwd,
      checkpointRef: checkpointRefForThreadTurn(threadId, 1),
      fallbackToHead: false,
    });
    expect(fs.readFileSync(path.join(harness.cwd, "README.md"), "utf8")).toBe("v2\n");
    expect(gitShowFileAtRef(harness.cwd, harness.recoveryRef, "README.md")).toBe("v3\n");
    expect(gitRefExists(harness.cwd, checkpointRefForThreadTurn(threadId, 2))).toBe(true);
    const thread = (await harness.readModel()).threads[0]!;
    expect(thread.checkpoints).toHaveLength(2);
    expect(thread.runtimeMode).toBe("full-access");
    expect(thread.activities).toContainEqual(
      expect.objectContaining({ kind: "checkpoint.revert.failed" }),
    );
  });

  it.each([
    { label: "the current checkpoint has no removed history", turnCounts: [1, 2], target: 2 },
    { label: "the exact first removed turn is missing", turnCounts: [1, 3], target: 1 },
  ])("refuses Claude rewind when $label", async ({ turnCounts, target }) => {
    const harness = await createRewindHarness(ProviderDriverKind.make("claudeAgent"), turnCounts);
    const capture = vi.spyOn(harness.checkpointStore, "captureCheckpoint");
    const restore = vi.spyOn(harness.checkpointStore, "restoreCheckpoint");
    await harness.request(target);
    await harness.drain();
    expect(capture).not.toHaveBeenCalled();
    expect(restore).not.toHaveBeenCalled();
    expect(harness.provider.prepareConversationRollback).not.toHaveBeenCalled();
    expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "does not touch files when Claude preparation refuses (unknown=%s)",
    async (unknown) => {
      const harness = await createRewindHarness();
      const failure = unknown
        ? new ProviderAdapterRewindOutcomeUnknownError({})
        : new ProviderAdapterRequestError({
            provider: "claudeAgent",
            method: "prepareConversationRollback",
            detail: "Native tree is not idle.",
          });
      harness.provider.prepareConversationRollback.mockReturnValue(Effect.fail(failure));
      const capture = vi.spyOn(harness.checkpointStore, "captureCheckpoint");
      const restore = vi.spyOn(harness.checkpointStore, "restoreCheckpoint");
      await harness.request();
      await harness.drain();
      expect(capture).not.toHaveBeenCalled();
      expect(restore).not.toHaveBeenCalled();
      expect(harness.provider.commitConversationRollback).not.toHaveBeenCalled();
      expect(harness.provider.finishConversationRollback).not.toHaveBeenCalled();
      expect(fs.readFileSync(path.join(harness.cwd, "README.md"), "utf8")).toBe("v3\n");
    },
  );

  it.each([
    "capture failed",
    "target restore failed",
    "target restore false",
    "native commit refused",
    "native commit unknown",
    "compensation failed",
    "compensation false",
    "abort acknowledgement unknown",
    "projection failed",
    "finish acknowledgement unknown",
  ] as const)("preserves the correct Claude recovery boundary when %s", async (scenario) => {
    const harness = await createRewindHarness();
    const fileError = new CheckpointInvariantError({
      operation: "test fixture",
      detail: "Controlled filesystem failure.",
    });
    const providerError = new ProviderAdapterRequestError({
      provider: "claudeAgent",
      method: "commitConversationRollback",
      detail: "Native commit refused before mutation.",
    });
    const unknown = new ProviderAdapterRewindOutcomeUnknownError({});
    const capture = harness.checkpointStore.captureCheckpoint;
    vi.spyOn(harness.checkpointStore, "captureCheckpoint").mockImplementation((input) =>
      scenario === "capture failed" ? Effect.fail(fileError) : capture(input),
    );
    const restore = harness.checkpointStore.restoreCheckpoint;
    const restoreSpy = vi
      .spyOn(harness.checkpointStore, "restoreCheckpoint")
      .mockImplementation((input) => {
        if (input.checkpointRef === harness.recoveryRef) {
          if (scenario === "compensation failed") return Effect.fail(fileError);
          if (scenario === "compensation false") return Effect.succeed(false);
          return restore(input);
        }
        if (scenario === "target restore failed" || scenario === "target restore false") {
          // A partially applied target is intentionally observable before the
          // failure, proving compensation is needed even without a successful ACK.
          return restore(input).pipe(
            Effect.andThen(
              scenario === "target restore failed" ? Effect.fail(fileError) : Effect.succeed(false),
            ),
          );
        }
        return restore(input);
      });
    if (scenario === "native commit unknown") {
      harness.provider.commitConversationRollback.mockReturnValue(Effect.fail(unknown));
    } else if (
      [
        "native commit refused",
        "compensation failed",
        "compensation false",
        "abort acknowledgement unknown",
      ].includes(scenario)
    ) {
      harness.provider.commitConversationRollback.mockReturnValue(Effect.fail(providerError));
    }
    if (
      scenario === "abort acknowledgement unknown" ||
      scenario === "finish acknowledgement unknown"
    ) {
      harness.provider.finishConversationRollback.mockReturnValue(Effect.fail(unknown));
    }
    const dispatch = harness.engine.dispatch;
    const dispatchSpy = vi.spyOn(harness.engine, "dispatch").mockImplementation((command) =>
      scenario === "projection failed" && command.type === "thread.revert.complete"
        ? Effect.fail(
            new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: "Controlled projection failure.",
            }),
          )
        : dispatch(command),
    );
    await harness.request();
    await harness.drain();
    const retained = [
      "native commit unknown",
      "compensation failed",
      "compensation false",
      "abort acknowledgement unknown",
      "projection failed",
      "finish acknowledgement unknown",
    ].includes(scenario);
    const compensated = [
      "target restore failed",
      "target restore false",
      "native commit refused",
      "abort acknowledgement unknown",
    ].includes(scenario);
    const expectedContent = scenario === "capture failed" || compensated ? "v3\n" : "v2\n";
    expect(fs.readFileSync(path.join(harness.cwd, "README.md"), "utf8")).toBe(expectedContent);
    expect(gitRefExists(harness.cwd, harness.recoveryRef)).toBe(retained);
    if (retained)
      expect(gitShowFileAtRef(harness.cwd, harness.recoveryRef, "README.md")).toBe("v3\n");
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 2)),
    ).toBe(true);
    const finish = harness.provider.finishConversationRollback;
    if (scenario === "capture failed" || compensated) {
      expect(finish).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ outcome: "aborted" }),
      );
    } else if (scenario === "finish acknowledgement unknown") {
      expect(finish).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ outcome: "committed" }),
      );
    } else {
      expect(finish).not.toHaveBeenCalled();
    }
    const recoveryRestores = restoreSpy.mock.calls.filter(
      ([input]) => input.checkpointRef === harness.recoveryRef,
    );
    expect(recoveryRestores).toHaveLength(
      compensated || scenario === "compensation failed" || scenario === "compensation false"
        ? 1
        : 0,
    );
    const projectionAttempted =
      scenario === "projection failed" || scenario === "finish acknowledgement unknown";
    expect(
      dispatchSpy.mock.calls.some(([command]) => command.type === "thread.revert.complete"),
    ).toBe(projectionAttempted);
    const snapshot = await harness.readModel();
    expect(snapshot.threads[0]?.checkpoints).toHaveLength(
      scenario === "finish acknowledgement unknown" ? 1 : 2,
    );
    expect(snapshot.threads[0]?.activities).toContainEqual(
      expect.objectContaining({ kind: "checkpoint.revert.failed" }),
    );
  });

  it.each([
    { providerName: "codex", scenario: "compensation failed" },
    { providerName: "codex", scenario: "compensation false" },
    { providerName: "codex", scenario: "projection failed" },
    { providerName: "grok", scenario: "compensation failed" },
    { providerName: "grok", scenario: "compensation false" },
    { providerName: "grok", scenario: "projection failed" },
  ] as const)(
    "retains legacy $providerName recovery when $scenario",
    async ({ providerName, scenario }) => {
      const harness = await createRewindHarness(ProviderDriverKind.make(providerName));
      const restore = harness.checkpointStore.restoreCheckpoint;
      vi.spyOn(harness.checkpointStore, "restoreCheckpoint").mockImplementation((input) => {
        if (input.checkpointRef !== harness.recoveryRef || scenario === "projection failed")
          return restore(input);
        return scenario === "compensation false"
          ? Effect.succeed(false)
          : Effect.fail(
              new CheckpointInvariantError({
                operation: "test compensation",
                detail: "Controlled compensation failure.",
              }),
            );
      });
      if (scenario !== "projection failed") {
        harness.provider.rollbackConversation.mockReturnValue(
          Effect.fail(
            new ProviderAdapterRequestError({
              provider: providerName,
              method: "rollbackConversation",
              detail: "Controlled refusal.",
            }),
          ),
        );
      }
      const dispatch = harness.engine.dispatch;
      vi.spyOn(harness.engine, "dispatch").mockImplementation((command) =>
        scenario === "projection failed" && command.type === "thread.revert.complete"
          ? Effect.fail(
              new OrchestrationCommandInvariantError({
                commandType: command.type,
                detail: "Controlled projection failure.",
              }),
            )
          : dispatch(command),
      );
      await harness.request();
      await harness.drain();
      expect(harness.provider.prepareConversationRollback).not.toHaveBeenCalled();
      expect(harness.provider.rollbackConversation).toHaveBeenCalledTimes(1);
      expect(gitShowFileAtRef(harness.cwd, harness.recoveryRef, "README.md")).toBe("v3\n");
      expect(fs.readFileSync(path.join(harness.cwd, "README.md"), "utf8")).toBe("v2\n");
      expect(
        gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 2)),
      ).toBe(true);
      expect((await harness.readModel()).threads[0]?.checkpoints).toHaveLength(2);
    },
  );

  it("processes consecutive revert requests with deterministic rollback sequencing", async () => {
    const harness = await createHarness();
    const createdAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-inline-revert"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-inline-revert-diff-1"),
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-1"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
        status: "ready",
        files: [],
        checkpointTurnCount: 1,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-inline-revert-diff-2"),
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-2"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 2),
        status: "ready",
        files: [],
        checkpointTurnCount: 2,
        createdAt,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.make("cmd-sequenced-revert-request-1"),
        threadId: ThreadId.make("thread-1"),
        turnCount: 1,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.make("cmd-sequenced-revert-request-0"),
        threadId: ThreadId.make("thread-1"),
        turnCount: 0,
        createdAt,
      }),
    );

    await harness.drain();

    expect(harness.provider.rollbackConversation).toHaveBeenCalledTimes(2);
    expect(harness.provider.rollbackConversation.mock.calls[0]?.[0]).toEqual({
      threadId: ThreadId.make("thread-1"),
      numTurns: 1,
    });
    expect(harness.provider.rollbackConversation.mock.calls[1]?.[0]).toEqual({
      threadId: ThreadId.make("thread-1"),
      numTurns: 1,
    });
  });

  it("appends an error activity when revert is requested without an active session", async () => {
    const harness = await createHarness({ hasSession: false });
    const createdAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.make("cmd-revert-no-session"),
        threadId: ThreadId.make("thread-1"),
        turnCount: 1,
        createdAt,
      }),
    );

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some((activity) => activity.kind === "checkpoint.revert.failed"),
    );

    expect(thread.activities.some((activity) => activity.kind === "checkpoint.revert.failed")).toBe(
      true,
    );
    expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
  });
});
