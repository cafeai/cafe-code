// @effect-diagnostics nodeBuiltinImport:off
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setImmediate as waitForEventLoopTurn } from "node:timers/promises";

import {
  OrchestrationReadModel,
  ProviderDriverKind,
  ProviderRuntimeEvent,
  ProviderSession,
  ProviderInstanceId,
} from "@cafecode/contracts";
import {
  ApprovalRequestId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ProviderItemId,
  type ServerSettings,
  ThreadId,
  TurnId,
} from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { afterEach, describe, expect, it } from "vitest";

import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import { RepositoryIdentityResolver } from "../../project/Services/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { ProviderRuntimeIngestionLive } from "./ProviderRuntimeIngestion.ts";
import { RuntimeReceiptBusLive } from "./RuntimeReceiptBus.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { RuntimeReceiptBus } from "../Services/RuntimeReceiptBus.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";

function makeTestServerSettingsLayer(overrides: Partial<ServerSettings> = {}) {
  return ServerSettingsService.layerTest(overrides);
}

const RepositoryIdentityResolverTest = Layer.succeed(RepositoryIdentityResolver, {
  resolve: (cwd: string) =>
    Effect.succeed({
      canonicalKey: "github.com/cafecode/runtime-ingestion-test",
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: "https://github.com/cafecode/runtime-ingestion-test.git",
      },
      rootPath: cwd,
      displayName: "cafecode/runtime-ingestion-test",
      provider: "github" as const,
      owner: "cafecode",
      name: "runtime-ingestion-test",
    }),
});

const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asItemId = (value: string): ProviderItemId => ProviderItemId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asMessageId = (value: string): MessageId => MessageId.make(value);
const asThreadId = (value: string): ThreadId => ThreadId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);

type LegacyProviderRuntimeEvent = {
  readonly type: string;
  readonly eventId: EventId;
  readonly provider: ProviderRuntimeEvent["provider"];
  readonly createdAt: string;
  readonly threadId: ThreadId;
  readonly turnId?: string | undefined;
  readonly itemId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly payload?: unknown | undefined;
  readonly [key: string]: unknown;
};

type LegacyTurnCompletedEvent = LegacyProviderRuntimeEvent & {
  readonly type: "turn.completed";
  readonly payload?: undefined;
  readonly status: "completed" | "failed" | "interrupted" | "cancelled";
  readonly errorMessage?: string | undefined;
};

function isLegacyTurnCompletedEvent(
  event: LegacyProviderRuntimeEvent,
): event is LegacyTurnCompletedEvent {
  return (
    event.type === "turn.completed" &&
    event.payload === undefined &&
    typeof event.status === "string"
  );
}

function createProviderServiceHarness() {
  const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
  const runtimeSessions: ProviderSession[] = [];

  const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;
  const service: ProviderServiceShape = {
    startSession: () => unsupported(),
    sendTurn: () => unsupported(),
    steerTurn: () => unsupported(),
    interruptTurn: () => unsupported(),
    respondToRequest: () => unsupported(),
    respondToUserInput: () => unsupported(),
    stopSession: () => unsupported(),
    restartProviderRuntime: () => unsupported(),
    listSessions: () => Effect.succeed([...runtimeSessions]),
    getCapabilities: () =>
      Effect.succeed({ sessionModelSwitch: "in-session", liveSteer: "unsupported" }),
    getInstanceInfo: (instanceId) => {
      const driverKind = ProviderDriverKind.make(String(instanceId));
      return Effect.succeed({
        instanceId,
        driverKind,
        displayName: undefined,
        enabled: true,
        continuationIdentity: {
          driverKind,
          continuationKey: `${driverKind}:instance:${instanceId}`,
        },
      });
    },
    rollbackConversation: () => unsupported(),
    get streamEvents() {
      return Stream.fromPubSub(runtimeEventPubSub);
    },
  };

  const setSession = (session: ProviderSession): void => {
    const existingIndex = runtimeSessions.findIndex((entry) => entry.threadId === session.threadId);
    if (existingIndex >= 0) {
      runtimeSessions[existingIndex] = session;
      return;
    }
    runtimeSessions.push(session);
  };

  const normalizeLegacyEvent = (event: LegacyProviderRuntimeEvent): ProviderRuntimeEvent => {
    if (isLegacyTurnCompletedEvent(event)) {
      const normalized: Extract<ProviderRuntimeEvent, { type: "turn.completed" }> = {
        ...(event as Omit<Extract<ProviderRuntimeEvent, { type: "turn.completed" }>, "payload">),
        payload: {
          state: event.status,
          ...(typeof event.errorMessage === "string" ? { errorMessage: event.errorMessage } : {}),
        },
      };
      return normalized;
    }

    return event as ProviderRuntimeEvent;
  };

  const emit = (event: LegacyProviderRuntimeEvent): void => {
    Effect.runSync(PubSub.publish(runtimeEventPubSub, normalizeLegacyEvent(event)));
  };

  return {
    service,
    emit,
    setSession,
  };
}

type ProviderRuntimeTestReadModel = OrchestrationReadModel;
type ProviderRuntimeTestThread = ProviderRuntimeTestReadModel["threads"][number];
type ProviderRuntimeTestMessage = ProviderRuntimeTestThread["messages"][number];
type ProviderRuntimeTestProposedPlan = ProviderRuntimeTestThread["proposedPlans"][number];
type ProviderRuntimeTestActivity = ProviderRuntimeTestThread["activities"][number];
type ProviderRuntimeTestCheckpoint = ProviderRuntimeTestThread["checkpoints"][number];

async function waitForThread(
  readModel: () => Promise<ProviderRuntimeTestReadModel>,
  predicate: (thread: ProviderRuntimeTestThread) => boolean,
  timeoutMs = 2000,
  threadId: ThreadId = asThreadId("thread-1"),
) {
  const deadline = performance.now() + timeoutMs;
  while (true) {
    const snapshot = await readModel();
    const thread = snapshot.threads.find((entry) => entry.id === threadId);
    if (thread && predicate(thread)) {
      return thread;
    }
    if (performance.now() >= deadline) {
      throw new Error("Timed out waiting for thread state");
    }
    // Projection work may cross a Node I/O boundary. Yield one macrotask without recursively
    // spinning Effect fibers, while retaining the timeout only as a failure guard.
    await waitForEventLoopTurn();
  }
}

describe("ProviderRuntimeIngestion", () => {
  let runtime: ManagedRuntime.ManagedRuntime<
    | OrchestrationEngineService
    | ProviderRuntimeIngestionService
    | ProjectionSnapshotQuery
    | RuntimeReceiptBus,
    unknown
  > | null = null;
  let scope: Scope.Closeable | null = null;
  const tempDirs: string[] = [];

  function makeTempDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  async function createHarness(options?: { serverSettings?: Partial<ServerSettings> }) {
    const workspaceRoot = makeTempDir("t3-provider-project-");
    fs.mkdirSync(path.join(workspaceRoot, ".git"));
    const provider = createProviderServiceHarness();
    const orchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(RepositoryIdentityResolverTest),
      Layer.provide(SqlitePersistenceMemory),
    );
    const projectionSnapshotLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
      Layer.provide(RepositoryIdentityResolverTest),
      Layer.provide(SqlitePersistenceMemory),
    );
    const layer = ProviderRuntimeIngestionLive.pipe(
      Layer.provideMerge(orchestrationLayer),
      Layer.provideMerge(projectionSnapshotLayer),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(RuntimeReceiptBusLive),
      Layer.provideMerge(Layer.succeed(ProviderService, provider.service)),
      Layer.provideMerge(makeTestServerSettingsLayer(options?.serverSettings)),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(NodeServices.layer),
    );
    runtime = ManagedRuntime.make(layer);
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const snapshotQuery = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
    const ingestion = await runtime.runPromise(Effect.service(ProviderRuntimeIngestionService));
    const receiptBus = await runtime.runPromise(Effect.service(RuntimeReceiptBus));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(ingestion.start().pipe(Scope.provide(scope)));
    const drain = () => Effect.runPromise(ingestion.drain);

    const createdAt = "2026-01-01T00:00:00.000Z";
    await Effect.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-provider-project-create"),
        projectId: asProjectId("project-1"),
        title: "Provider Project",
        workspaceRoot,
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
        worktreePath: null,
        createdAt,
      }),
    );
    await Effect.runPromise(
      engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-seed"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          updatedAt: createdAt,
          lastError: null,
        },
        createdAt,
      }),
    );
    provider.setSession({
      provider: ProviderDriverKind.make("codex"),
      status: "ready",
      runtimeMode: "approval-required",
      threadId: ThreadId.make("thread-1"),
      createdAt,
      updatedAt: createdAt,
    });

    return {
      engine,
      readModel: () => Effect.runPromise(snapshotQuery.getSnapshot()),
      emit: provider.emit,
      setProviderSession: provider.setSession,
      receiptBus,
      drain,
    };
  }

  it("maps turn started/completed events into thread session updates", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started"),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      createdAt: now,
      turnId: asTurnId("turn-1"),
    });

    await waitForThread(
      harness.readModel,
      (thread) => thread.session?.status === "running" && thread.session?.activeTurnId === "turn-1",
    );

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed"),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      createdAt: "2026-01-01T00:00:00.000Z",
      turnId: asTurnId("turn-1"),
      payload: {
        state: "failed",
        errorMessage: "turn failed",
      },
    });

    const thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.session?.status === "error" &&
        entry.session?.activeTurnId === null &&
        entry.session?.lastError === "turn failed",
    );
    expect(thread.session?.status).toBe("error");
    expect(thread.session?.lastError).toBe("turn failed");
  });

  it("publishes provider turn ingestion quiescence after processing turn completion", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const turnId = asTurnId("turn-ingestion-quiesced");
    const awaitingReceipt = runtime!.runPromise(
      harness.receiptBus.awaitTurnIngestionQuiesced({
        threadId: asThreadId("thread-1"),
        turnId,
        provider: ProviderDriverKind.make("codex"),
      }),
    );

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-ingestion-quiesced"),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      createdAt: now,
      turnId,
      payload: { state: "completed" },
    });

    const receipt = await awaitingReceipt;
    expect(receipt.sourceEventId).toBe("evt-turn-completed-ingestion-quiesced");

    const thread = await waitForThread(
      harness.readModel,
      (entry) => entry.session?.status === "ready" && entry.session.activeTurnId === null,
    );
    expect(thread.session?.status).toBe("ready");
  });

  it("does not write redundant session heartbeats for active content deltas", async () => {
    const harness = await createHarness({ serverSettings: { enableAssistantStreaming: true } });
    const startedAt = "2026-01-01T00:00:00.000Z";
    const deltaAt = "2026-01-01T00:00:01.000Z";
    const turnId = asTurnId("turn-no-token-heartbeat");

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-no-token-heartbeat-started"),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      createdAt: startedAt,
      turnId,
    });
    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-no-token-heartbeat",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-no-token-heartbeat-delta"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: deltaAt,
      threadId: asThreadId("thread-1"),
      turnId,
      itemId: asItemId("item-no-token-heartbeat"),
      payload: {
        streamKind: "assistant_text",
        delta: "visible",
      },
    });
    await harness.drain();

    const thread = (await harness.readModel()).threads.find((entry) => entry.id === "thread-1");
    expect(thread?.session?.updatedAt).toBe(startedAt);
    expect(
      thread?.messages.find(
        (message: ProviderRuntimeTestMessage) => message.id === "assistant:item-no-token-heartbeat",
      )?.text,
    ).toBe("visible");
  });

  it("does not reopen a completed turn when replayed content arrives late", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const turnId = asTurnId("turn-late-replay");

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-late-replay-turn-started"),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      createdAt: now,
      turnId,
    });

    await waitForThread(
      harness.readModel,
      (thread) => thread.session?.status === "running" && thread.session?.activeTurnId === turnId,
    );

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-late-replay-turn-completed"),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      createdAt: "2026-01-01T00:00:01.000Z",
      turnId,
      payload: {
        state: "completed",
      },
    });

    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "ready" &&
        thread.session?.activeTurnId === null &&
        thread.latestTurn?.state === "completed",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-late-replay-delta"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:02.000Z",
      threadId: asThreadId("thread-1"),
      turnId,
      itemId: asItemId("item-late-replay"),
      payload: {
        streamKind: "assistant_text",
        delta: "late replay text",
      },
    });

    await harness.drain();
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === asThreadId("thread-1"));

    expect(thread?.session?.status).toBe("ready");
    expect(thread?.session?.activeTurnId).toBeNull();
    expect(thread?.latestTurn?.state).toBe("completed");
    expect(
      thread?.messages.some(
        (message: ProviderRuntimeTestMessage) => message.id === "assistant:item-late-replay",
      ),
    ).toBe(true);
  });

  it("reopens the same terminal turn only for explicit live Codex aggregate continuation", async () => {
    const harness = await createHarness();
    const turnId = asTurnId("turn-live-aggregate-continuation");

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-live-aggregate-started"),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      createdAt: "2026-07-14T00:00:00.000Z",
      turnId,
      payload: {},
    });
    await waitForThread(
      harness.readModel,
      (thread) => thread.session?.status === "running" && thread.session.activeTurnId === turnId,
    );

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-live-aggregate-root-completed"),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      createdAt: "2026-07-14T00:00:01.000Z",
      turnId,
      payload: { state: "completed" },
    });
    await waitForThread(
      harness.readModel,
      (thread) => thread.session?.status === "ready" && thread.latestTurn?.state === "completed",
    );

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-live-aggregate-reopened"),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      createdAt: "2026-07-14T00:00:02.000Z",
      turnId,
      raw: {
        source: "codex.app-server.notification",
        method: "codex.aggregateTurn/reopened",
        payload: {},
      },
      payload: {},
    });

    const recovered = await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session.activeTurnId === turnId &&
        thread.latestTurn?.state === "running" &&
        thread.latestTurn.completedAt === null,
    );
    expect(recovered.latestTurn?.completedAt).toBeNull();
  });

  it("clears active turn state when Codex reports an aborted turn", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-before-abort"),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      createdAt: now,
      turnId: asTurnId("turn-aborted"),
    });

    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" && thread.session?.activeTurnId === "turn-aborted",
    );

    harness.emit({
      type: "turn.aborted",
      eventId: asEventId("evt-turn-aborted"),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      createdAt: "2026-01-01T00:00:01.000Z",
      payload: {
        reason: "Turn aborted by Codex.",
      },
    });

    const thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.session?.status === "interrupted" &&
        entry.session?.activeTurnId === null &&
        entry.session?.lastError === "Turn aborted by Codex.",
    );
    expect(thread.session?.status).toBe("interrupted");
    expect(thread.session?.activeTurnId).toBeNull();
  });

  it("applies provider session.state.changed transitions directly", async () => {
    const harness = await createHarness();
    const waitingAt = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "session.state.changed",
      eventId: asEventId("evt-session-state-waiting"),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      createdAt: waitingAt,
      payload: {
        state: "waiting",
        reason: "awaiting approval",
      },
    });

    let thread = await waitForThread(
      harness.readModel,
      (entry) => entry.session?.status === "running" && entry.session?.activeTurnId === null,
    );
    expect(thread.session?.status).toBe("running");
    expect(thread.session?.lastError).toBeNull();

    harness.emit({
      type: "session.state.changed",
      eventId: asEventId("evt-session-state-error"),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      createdAt: "2026-01-01T00:00:00.000Z",
      payload: {
        state: "error",
        reason: "provider crashed",
      },
    });

    thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.session?.status === "error" &&
        entry.session?.activeTurnId === null &&
        entry.session?.lastError === "provider crashed",
    );
    expect(thread.session?.status).toBe("error");
    expect(thread.session?.lastError).toBe("provider crashed");

    harness.emit({
      type: "session.state.changed",
      eventId: asEventId("evt-session-state-stopped"),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      createdAt: "2026-01-01T00:00:00.000Z",
      payload: {
        state: "stopped",
      },
    });

    thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.session?.status === "stopped" &&
        entry.session?.activeTurnId === null &&
        entry.session?.lastError === "provider crashed",
    );
    expect(thread.session?.status).toBe("stopped");
    expect(thread.session?.lastError).toBe("provider crashed");

    harness.emit({
      type: "session.state.changed",
      eventId: asEventId("evt-session-state-ready"),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      createdAt: "2026-01-01T00:00:00.000Z",
      payload: {
        state: "ready",
      },
    });

    thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.session?.status === "ready" &&
        entry.session?.activeTurnId === null &&
        entry.session?.lastError === null,
    );
    expect(thread.session?.status).toBe("ready");
    expect(thread.session?.lastError).toBeNull();
  });

  it("does not clear active turn when session/thread started arrives mid-turn", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-midturn-lifecycle"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-midturn-lifecycle"),
    });

    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-midturn-lifecycle",
    );

    harness.emit({
      type: "thread.started",
      eventId: asEventId("evt-thread-started-midturn-lifecycle"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: asThreadId("thread-1"),
    });
    harness.emit({
      type: "session.started",
      eventId: asEventId("evt-session-started-midturn-lifecycle"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: asThreadId("thread-1"),
    });

    await harness.drain();
    const midReadModel = await harness.readModel();
    const midThread = midReadModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(midThread?.session?.status).toBe("running");
    expect(midThread?.session?.activeTurnId).toBe("turn-midturn-lifecycle");

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-midturn-lifecycle"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-midturn-lifecycle"),
      status: "completed",
    });

    await waitForThread(
      harness.readModel,
      (thread) => thread.session?.status === "ready" && thread.session?.activeTurnId === null,
    );
  });

  it("accepts claude turn lifecycle when seeded thread id is a synthetic placeholder", async () => {
    const harness = await createHarness();
    const seededAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-seed-claude-placeholder"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: null,
          updatedAt: seededAt,
          lastError: null,
        },
        createdAt: seededAt,
      }),
    );

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-claude-placeholder"),
      provider: ProviderDriverKind.make("claudeAgent"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-claude-placeholder"),
    });

    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-claude-placeholder",
    );

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-claude-placeholder"),
      provider: ProviderDriverKind.make("claudeAgent"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-claude-placeholder"),
      status: "completed",
    });

    await waitForThread(
      harness.readModel,
      (thread) => thread.session?.status === "ready" && thread.session?.activeTurnId === null,
    );
  });

  it("ignores auxiliary turn completions from a different provider thread", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-primary"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-primary"),
    });

    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" && thread.session?.activeTurnId === "turn-primary",
    );

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-aux"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-aux"),
      status: "completed",
    });

    await harness.drain();
    const midReadModel = await harness.readModel();
    const midThread = midReadModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(midThread?.session?.status).toBe("running");
    expect(midThread?.session?.activeTurnId).toBe("turn-primary");

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-primary"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-primary"),
      status: "completed",
    });

    await waitForThread(
      harness.readModel,
      (thread) => thread.session?.status === "ready" && thread.session?.activeTurnId === null,
    );
  });

  it("maps canonical content delta/item completed into finalized assistant messages", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-1"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-2"),
      itemId: asItemId("item-1"),
      payload: {
        streamKind: "assistant_text",
        delta: "hello",
      },
    });
    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-2"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-2"),
      itemId: asItemId("item-1"),
      payload: {
        streamKind: "assistant_text",
        delta: " world",
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-2"),
      itemId: asItemId("item-1"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-1" && !message.streaming,
      ),
    );
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-1",
    );
    expect(message?.text).toBe("hello world");
    expect(message?.streaming).toBe(false);
  });

  it("keeps interleaved Codex root and subagent assistant streams isolated", async () => {
    const harness = await createHarness({ serverSettings: { enableAssistantStreaming: true } });
    const now = "2026-01-01T00:00:00.000Z";
    const threadId = asThreadId("thread-1");
    const turnId = asTurnId("turn-multi-agent-interleaved");
    const rootItemId = asItemId("item-root-message");
    const childItemId = asItemId("item-child-message");

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-multi-agent-turn-started"),
      provider: ProviderDriverKind.make("codex"),
      threadId,
      createdAt: now,
      turnId,
    });

    const emitDelta = (input: {
      readonly eventId: string;
      readonly providerThreadId: string;
      readonly itemId: ReturnType<typeof asItemId>;
      readonly delta: string;
    }) => {
      harness.emit({
        type: "content.delta",
        eventId: asEventId(input.eventId),
        provider: ProviderDriverKind.make("codex"),
        threadId,
        createdAt: now,
        turnId,
        itemId: input.itemId,
        providerRefs: {
          providerTurnId: "provider-parent-turn",
          providerItemId: input.itemId,
        },
        raw: {
          source: "codex.app-server.notification",
          method: "item/agentMessage/delta",
          payload: {
            threadId: input.providerThreadId,
            turnId: "provider-parent-turn",
            itemId: input.itemId,
            delta: input.delta,
          },
        },
        payload: {
          streamKind: "assistant_text",
          delta: input.delta,
        },
      });
    };

    emitDelta({
      eventId: "evt-root-delta-1",
      providerThreadId: "provider-root-thread",
      itemId: rootItemId,
      delta: "Under",
    });
    emitDelta({
      eventId: "evt-child-delta-1",
      providerThreadId: "provider-child-thread",
      itemId: childItemId,
      delta: "Child",
    });
    emitDelta({
      eventId: "evt-root-delta-2",
      providerThreadId: "provider-root-thread",
      itemId: rootItemId,
      delta: "stood",
    });
    emitDelta({
      eventId: "evt-child-delta-2",
      providerThreadId: "provider-child-thread",
      itemId: childItemId,
      delta: " progress",
    });

    for (const completion of [
      {
        eventId: "evt-root-completed",
        providerThreadId: "provider-root-thread",
        itemId: rootItemId,
        text: "Understood",
      },
      {
        eventId: "evt-child-completed",
        providerThreadId: "provider-child-thread",
        itemId: childItemId,
        text: "Child progress",
      },
    ]) {
      harness.emit({
        type: "item.completed",
        eventId: asEventId(completion.eventId),
        provider: ProviderDriverKind.make("codex"),
        threadId,
        createdAt: now,
        turnId,
        itemId: completion.itemId,
        providerRefs: {
          providerTurnId: "provider-parent-turn",
          providerItemId: completion.itemId,
        },
        raw: {
          source: "codex.app-server.notification",
          method: "item/completed",
          payload: {
            threadId: completion.providerThreadId,
            turnId: "provider-parent-turn",
            item: {
              type: "agentMessage",
              id: completion.itemId,
              text: completion.text,
            },
          },
        },
        payload: {
          itemType: "assistant_message",
          status: "completed",
          detail: completion.text,
        },
      });
    }

    const thread = await waitForThread(harness.readModel, (entry) => {
      const root = entry.messages.find(
        (message: ProviderRuntimeTestMessage) => message.id === "assistant:item-root-message",
      );
      const child = entry.messages.find(
        (message: ProviderRuntimeTestMessage) => message.id === "assistant:item-child-message",
      );
      return root?.streaming === false && child?.streaming === false;
    });
    const root = thread.messages.find(
      (message: ProviderRuntimeTestMessage) => message.id === "assistant:item-root-message",
    );
    const child = thread.messages.find(
      (message: ProviderRuntimeTestMessage) => message.id === "assistant:item-child-message",
    );

    expect(root?.text).toBe("Understood");
    expect(child?.text).toBe("Child progress");
  });

  it("deduplicates replayed streaming provider runtime events", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";
    const turnId = asTurnId("turn-replayed-runtime-event");
    const itemId = asItemId("item-replayed-runtime-event");
    const deltaEvent = {
      type: "content.delta",
      eventId: asEventId("evt-replayed-delta"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId,
      itemId,
      payload: {
        streamKind: "assistant_text",
        delta: "hello",
      },
    };
    const completedEvent = {
      type: "item.completed",
      eventId: asEventId("evt-replayed-completed"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId,
      itemId,
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    };

    harness.emit(deltaEvent);
    harness.emit(deltaEvent);
    harness.emit(deltaEvent);
    harness.emit(completedEvent);
    harness.emit(completedEvent);

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-replayed-runtime-event" && !message.streaming,
      ),
    );
    const matchingMessages = thread.messages.filter(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-replayed-runtime-event",
    );

    expect(matchingMessages).toHaveLength(1);
    expect(matchingMessages[0]?.text).toBe("hello");
    expect(matchingMessages[0]?.streaming).toBe(false);
  });

  it("deduplicates replayed buffered assistant deltas before finalization", async () => {
    const harness = await createHarness({ serverSettings: { enableAssistantStreaming: false } });
    const now = "2026-01-01T00:00:00.000Z";
    const turnId = asTurnId("turn-buffered-replayed-runtime-event");
    const itemId = asItemId("item-buffered-replayed-runtime-event");
    const deltaEvent = {
      type: "content.delta",
      eventId: asEventId("evt-buffered-replayed-delta"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId,
      itemId,
      payload: {
        streamKind: "assistant_text",
        delta: "buffered hello",
      },
    };

    harness.emit(deltaEvent);
    harness.emit(deltaEvent);
    harness.emit(deltaEvent);
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-buffered-replayed-completed"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId,
      itemId,
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-buffered-replayed-runtime-event" && !message.streaming,
      ),
    );
    const matchingMessages = thread.messages.filter(
      (entry: ProviderRuntimeTestMessage) =>
        entry.id === "assistant:item-buffered-replayed-runtime-event",
    );

    expect(matchingMessages).toHaveLength(1);
    expect(matchingMessages[0]?.text).toBe("buffered hello");
    expect(matchingMessages[0]?.streaming).toBe(false);
  });

  it("uses assistant item completion detail when no assistant deltas were streamed", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-assistant-item-completed-no-delta"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-no-delta"),
      itemId: asItemId("item-no-delta"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        detail: "assistant-only final text",
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-no-delta" && !message.streaming,
      ),
    );
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-no-delta",
    );
    expect(message?.text).toBe("assistant-only final text");
    expect(message?.streaming).toBe(false);
  });

  it("appends missing suffix from assistant item completion detail after a streamed prefix", async () => {
    const harness = await createHarness({ serverSettings: { enableAssistantStreaming: true } });
    const now = "2026-01-01T00:00:00.000Z";
    const turnId = asTurnId("turn-completion-prefix-repair");
    const itemId = asItemId("item-completion-prefix-repair");
    const finalText = "Here’s a table:\n\n| A | B |\n|---|---|\n";

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-completion-prefix-repair-delta"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId,
      itemId,
      payload: {
        streamKind: "assistant_text",
        delta: "Here",
      },
    });

    await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-completion-prefix-repair" &&
          message.streaming &&
          message.text === "Here",
      ),
    );

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-completion-prefix-repair-completed"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId,
      itemId,
      payload: {
        itemType: "assistant_message",
        status: "completed",
        detail: finalText,
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-completion-prefix-repair" && !message.streaming,
      ),
    );
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-completion-prefix-repair",
    );

    expect(message?.text).toBe(finalText);
    expect(message?.streaming).toBe(false);
  });

  it("consolidates a completed assistant stream without appending it twice", async () => {
    const harness = await createHarness({ serverSettings: { enableAssistantStreaming: true } });
    const now = "2026-01-01T00:00:00.000Z";
    const turnId = asTurnId("turn-completion-stream-consolidation");
    const itemId = asItemId("item-completion-stream-consolidation");
    const firstChunk = "First";
    const remainingText =
      " streamed paragraph is complete. Another sentence verifies terminal replacement.";
    const finalText = `${firstChunk}${remainingText}`;

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-completion-stream-consolidation-first"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId,
      itemId,
      payload: {
        streamKind: "assistant_text",
        delta: firstChunk,
      },
    });
    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-completion-stream-consolidation-rest"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId,
      itemId,
      payload: {
        streamKind: "assistant_text",
        delta: remainingText,
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-completion-stream-consolidation-completed"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId,
      itemId,
      payload: {
        itemType: "assistant_message",
        status: "completed",
        detail: finalText,
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-completion-stream-consolidation" && !message.streaming,
      ),
    );
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) =>
        entry.id === "assistant:item-completion-stream-consolidation",
    );
    expect(message?.text).toBe(finalText);

    const events = await Effect.runPromise(
      Stream.runCollect(harness.engine.readEvents(0)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      ),
    );
    const messageEvents = events.filter(
      (event): event is Extract<(typeof events)[number], { type: "thread.message-sent" }> =>
        event.type === "thread.message-sent" &&
        event.payload.messageId === "assistant:item-completion-stream-consolidation",
    );
    expect(
      messageEvents
        .filter((event) => event.payload.streaming)
        .map((event) => event.payload.text)
        .join(""),
    ).toBe(finalText);
    expect(messageEvents.at(-1)?.payload).toMatchObject({
      streaming: false,
      text: finalText,
    });
  });

  it("appends missing suffix from assistant item completion detail after streamed prefix and buffered tail", async () => {
    const harness = await createHarness({ serverSettings: { enableAssistantStreaming: true } });
    const now = "2026-01-01T00:00:00.000Z";
    const turnId = asTurnId("turn-completion-prefix-buffered-tail-repair");
    const itemId = asItemId("item-completion-prefix-buffered-tail-repair");
    const finalText = "Here is the complete answer.";

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-completion-buffered-tail-repair-delta-1"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId,
      itemId,
      payload: {
        streamKind: "assistant_text",
        delta: "Here",
      },
    });

    await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-completion-prefix-buffered-tail-repair" &&
          message.streaming &&
          message.text === "Here",
      ),
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-completion-buffered-tail-repair-delta-2"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId,
      itemId,
      payload: {
        streamKind: "assistant_text",
        delta: " is",
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-completion-buffered-tail-repair-completed"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId,
      itemId,
      payload: {
        itemType: "assistant_message",
        status: "completed",
        detail: finalText,
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-completion-prefix-buffered-tail-repair" &&
          !message.streaming,
      ),
    );
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) =>
        entry.id === "assistant:item-completion-prefix-buffered-tail-repair",
    );

    expect(message?.text).toBe(finalText);
    expect(message?.streaming).toBe(false);
  });

  it("does not replace streamed output with a divergent completed item", async () => {
    const harness = await createHarness({ serverSettings: { enableAssistantStreaming: true } });
    const now = "2026-01-01T00:00:00.000Z";
    const turnId = asTurnId("turn-divergent-completion");
    const itemId = asItemId("item-divergent-completion");
    const streamedText = "Streamed provider text.";

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-divergent-completion-delta"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId,
      itemId,
      payload: {
        streamKind: "assistant_text",
        delta: streamedText,
      },
    });
    await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-divergent-completion" && message.streaming,
      ),
    );

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-divergent-completion-completed"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId,
      itemId,
      payload: {
        itemType: "assistant_message",
        status: "completed",
        detail: "Different completed provider text.",
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-divergent-completion" && !message.streaming,
      ),
    );
    expect(
      thread.messages.find(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-divergent-completion",
      )?.text,
    ).toBe(streamedText);
  });

  it("ignores Codex snapshot backfill assistant completions that duplicate live assistant output", async () => {
    const harness = await createHarness({ serverSettings: { enableAssistantStreaming: false } });
    const now = "2026-01-01T00:00:00.000Z";
    const turnId = asTurnId("turn-snapshot-backfill-dedup");
    const duplicateText = "B214 design is running now under global defaults.";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-snapshot-backfill-dedup"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId,
    });
    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-live-message-delta-snapshot-backfill-dedup"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId,
      itemId: asItemId("msg_live_1"),
      payload: {
        streamKind: "assistant_text",
        delta: duplicateText,
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-live-message-completed-snapshot-backfill-dedup"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:01.000Z",
      threadId: asThreadId("thread-1"),
      turnId,
      itemId: asItemId("msg_live_1"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });

    await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:msg_live_1" && message.text === duplicateText,
      ),
    );

    harness.emit({
      type: "item.completed",
      eventId: asEventId(
        "codex-snapshot:send-turn-follow-up:provider-thread-1:turn-snapshot-backfill-dedup:item-6768:item-completed",
      ),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:02.000Z",
      threadId: asThreadId("thread-1"),
      turnId,
      itemId: asItemId("item-6768"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        detail: duplicateText,
      },
    });

    await harness.drain();
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    const matchingMessages =
      thread?.messages.filter(
        (message: ProviderRuntimeTestMessage) =>
          message.turnId === turnId &&
          message.role === "assistant" &&
          message.text === duplicateText,
      ) ?? [];

    expect(matchingMessages.map((message) => message.id)).toEqual(["assistant:msg_live_1"]);
  });

  it("separates assistant item streams that overlap within one provider turn", async () => {
    const harness = await createHarness({ serverSettings: { enableAssistantStreaming: false } });
    const now = "2026-01-01T00:00:00.000Z";
    const turnId = asTurnId("turn-overlapping-assistant-items");

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-overlapping-items"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId,
    });

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-overlapping-item-a-delta"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId,
      itemId: asItemId("item-overlap-a"),
      payload: {
        streamKind: "assistant_text",
        delta: "first assistant item",
      },
    });

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-overlapping-item-b-delta"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId,
      itemId: asItemId("item-overlap-b"),
      payload: {
        streamKind: "assistant_text",
        delta: "second assistant item",
      },
    });

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-overlapping-item-a-completed"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId,
      itemId: asItemId("item-overlap-a"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-overlapping-item-b-completed"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId,
      itemId: asItemId("item-overlap-b"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });

    const thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.messages.some(
          (message: ProviderRuntimeTestMessage) =>
            message.id === "assistant:item-overlap-a" &&
            message.text === "first assistant item" &&
            !message.streaming,
        ) &&
        entry.messages.some(
          (message: ProviderRuntimeTestMessage) =>
            message.id === "assistant:item-overlap-b" &&
            message.text === "second assistant item" &&
            !message.streaming,
        ),
    );

    expect(
      thread.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.text === "first assistant itemsecond assistant item",
      ),
    ).toBe(false);
  });

  it("preserves completed tool metadata on projected tool activities", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-tool-completed-with-data"),
      provider: ProviderDriverKind.make("testProvider"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-tool-completed"),
      itemId: asItemId("item-tool-completed"),
      payload: {
        itemType: "dynamic_tool_call",
        status: "completed",
        title: "Read file",
        data: {
          toolCallId: "tool-read-1",
          kind: "read",
          rawOutput: {
            content: 'import * as Effect from "effect/Effect"\n',
          },
        },
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-tool-completed-with-data",
      ),
    );
    const activity = thread.activities.find(
      (entry: ProviderRuntimeTestActivity) => entry.id === "evt-tool-completed-with-data",
    );
    const payload =
      activity?.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : undefined;
    const data =
      payload?.data && typeof payload.data === "object"
        ? (payload.data as Record<string, unknown>)
        : undefined;
    const rawOutput =
      data?.rawOutput && typeof data.rawOutput === "object"
        ? (data.rawOutput as Record<string, unknown>)
        : undefined;

    expect(activity?.kind).toBe("tool.completed");
    expect(activity?.summary).toBe("Read file");
    expect(payload?.itemType).toBe("dynamic_tool_call");
    expect(payload?.detail).toBeUndefined();
    expect(data?.toolCallId).toBe("tool-read-1");
    expect(data?.kind).toBe("read");
    expect(rawOutput?.content).toMatch(/^\[content omitted: \d+ chars, \d+ lines\]$/);
  });

  it("projects Codex context compaction item lifecycle into visible tool activity", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "item.started",
      eventId: asEventId("evt-compaction-started"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-compacting"),
      itemId: asItemId("item-compaction"),
      payload: {
        itemType: "context_compaction",
        status: "inProgress",
        title: "Context compaction",
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-compaction-completed"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:01.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-compacting"),
      itemId: asItemId("item-compaction"),
      payload: {
        itemType: "context_compaction",
        status: "completed",
        title: "Context compaction",
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-compaction-completed",
      ),
    );
    const started = thread.activities.find(
      (entry: ProviderRuntimeTestActivity) => entry.id === "evt-compaction-started",
    );
    const completed = thread.activities.find(
      (entry: ProviderRuntimeTestActivity) => entry.id === "evt-compaction-completed",
    );

    expect(started?.kind).toBe("tool.started");
    expect(started?.summary).toBe("Context compaction started");
    expect(completed?.kind).toBe("tool.completed");
    expect(completed?.summary).toBe("Context compacted");
  });

  it("normalizes command execution activities to ran-command summaries", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-command-completed"),
      provider: ProviderDriverKind.make("testProvider"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-command-completed"),
      itemId: asItemId("item-command-completed"),
      payload: {
        itemType: "command_execution",
        status: "completed",
        title: "Ran command",
        detail: "bun run lint",
        data: {
          toolCallId: "tool-command-1",
          kind: "execute",
          command: "bun run lint",
        },
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-command-completed",
      ),
    );
    const activity = thread.activities.find(
      (entry: ProviderRuntimeTestActivity) => entry.id === "evt-command-completed",
    );
    const payload =
      activity?.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : undefined;

    expect(activity?.summary).toBe("Ran command");
    expect(payload?.detail).toBe("bun run lint");
  });

  it("uses structured read-file paths when available", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-read-path-completed"),
      provider: ProviderDriverKind.make("testProvider"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-read-path"),
      itemId: asItemId("item-read-path"),
      payload: {
        itemType: "dynamic_tool_call",
        status: "completed",
        title: "Read file",
        detail: "/tmp/app.ts",
        data: {
          toolCallId: "tool-read-path-1",
          kind: "read",
          locations: [{ path: "/tmp/app.ts" }],
        },
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-read-path-completed",
      ),
    );
    const activity = thread.activities.find(
      (entry: ProviderRuntimeTestActivity) => entry.id === "evt-read-path-completed",
    );
    const payload =
      activity?.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : undefined;

    expect(activity?.summary).toBe("Read file");
    expect(payload?.detail).toBe("/tmp/app.ts");
  });

  it("projects completed plan items into first-class proposed plans", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "turn.proposed.completed",
      eventId: asEventId("evt-plan-item-completed"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-plan-final"),
      payload: {
        planMarkdown: "## Ship plan\n\n- wire projection\n- render follow-up",
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.proposedPlans.some(
        (proposedPlan: ProviderRuntimeTestProposedPlan) =>
          proposedPlan.id === "plan:thread-1:turn:turn-plan-final",
      ),
    );
    const proposedPlan = thread.proposedPlans.find(
      (entry: ProviderRuntimeTestProposedPlan) => entry.id === "plan:thread-1:turn:turn-plan-final",
    );
    expect(proposedPlan?.planMarkdown).toBe(
      "## Ship plan\n\n- wire projection\n- render follow-up",
    );
  });

  it("marks the source proposed plan implemented only after the target turn starts", async () => {
    const harness = await createHarness();
    const sourceThreadId = asThreadId("thread-plan");
    const targetThreadId = asThreadId("thread-implement");
    const sourceTurnId = asTurnId("turn-plan-source");
    const targetTurnId = asTurnId("turn-plan-implement");
    const createdAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-create-plan-source"),
        threadId: sourceThreadId,
        projectId: asProjectId("project-1"),
        title: "Plan Source",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: "plan",
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-plan-source"),
        threadId: sourceThreadId,
        session: {
          threadId: sourceThreadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          updatedAt: createdAt,
          lastError: null,
        },
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-create-plan-target"),
        threadId: targetThreadId,
        projectId: asProjectId("project-1"),
        title: "Plan Target",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-plan-target"),
        threadId: targetThreadId,
        session: {
          threadId: targetThreadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          updatedAt: createdAt,
          lastError: null,
        },
        createdAt,
      }),
    );
    harness.setProviderSession({
      provider: ProviderDriverKind.make("codex"),
      status: "ready",
      runtimeMode: "approval-required",
      threadId: targetThreadId,
      createdAt,
      updatedAt: createdAt,
      activeTurnId: targetTurnId,
    });

    harness.emit({
      type: "turn.proposed.completed",
      eventId: asEventId("evt-plan-source-completed"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId: sourceThreadId,
      turnId: sourceTurnId,
      payload: {
        planMarkdown: "# Source plan",
      },
    });

    const sourceThreadWithPlan = await waitForThread(
      harness.readModel,
      (thread) =>
        thread.proposedPlans.some(
          (proposedPlan: ProviderRuntimeTestProposedPlan) =>
            proposedPlan.id === "plan:thread-plan:turn:turn-plan-source" &&
            proposedPlan.implementedAt === null,
        ),
      2_000,
      sourceThreadId,
    );
    const sourcePlan = sourceThreadWithPlan.proposedPlans.find(
      (entry: ProviderRuntimeTestProposedPlan) =>
        entry.id === "plan:thread-plan:turn:turn-plan-source",
    );
    expect(sourcePlan).toBeDefined();
    if (!sourcePlan) {
      throw new Error("Expected source plan to exist.");
    }

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-plan-target"),
        threadId: targetThreadId,
        message: {
          messageId: asMessageId("msg-plan-target"),
          role: "user",
          text: "PLEASE IMPLEMENT THIS PLAN:\n# Source plan",
          attachments: [],
        },
        sourceProposedPlan: {
          threadId: sourceThreadId,
          planId: sourcePlan.id,
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    const sourceThreadBeforeStart = await waitForThread(
      harness.readModel,
      (thread) =>
        thread.proposedPlans.some(
          (proposedPlan: ProviderRuntimeTestProposedPlan) =>
            proposedPlan.id === sourcePlan.id && proposedPlan.implementedAt === null,
        ),
      2_000,
      sourceThreadId,
    );
    expect(
      sourceThreadBeforeStart.proposedPlans.find((entry) => entry.id === sourcePlan.id),
    ).toMatchObject({
      implementedAt: null,
      implementationThreadId: null,
    });

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-plan-target-started"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: targetThreadId,
      turnId: targetTurnId,
    });

    const sourceThreadAfterStart = await waitForThread(
      harness.readModel,
      (thread) =>
        thread.proposedPlans.some(
          (proposedPlan: ProviderRuntimeTestProposedPlan) =>
            proposedPlan.id === sourcePlan.id &&
            proposedPlan.implementedAt !== null &&
            proposedPlan.implementationThreadId === targetThreadId,
        ),
      2_000,
      sourceThreadId,
    );
    expect(
      sourceThreadAfterStart.proposedPlans.find((entry) => entry.id === sourcePlan.id),
    ).toMatchObject({
      implementationThreadId: "thread-implement",
    });
  });

  it("does not mark the source proposed plan implemented for a rejected turn.started event", async () => {
    const harness = await createHarness();
    const sourceThreadId = asThreadId("thread-plan");
    const targetThreadId = asThreadId("thread-1");
    const sourceTurnId = asTurnId("turn-plan-source");
    const activeTurnId = asTurnId("turn-already-running");
    const staleTurnId = asTurnId("turn-stale-start");
    const createdAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-create-plan-source-guarded"),
        threadId: sourceThreadId,
        projectId: asProjectId("project-1"),
        title: "Plan Source",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: "plan",
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-plan-source-guarded"),
        threadId: sourceThreadId,
        session: {
          threadId: sourceThreadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          updatedAt: createdAt,
          lastError: null,
        },
        createdAt,
      }),
    );
    harness.emit({
      type: "turn.proposed.completed",
      eventId: asEventId("evt-plan-source-completed-guarded"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId: sourceThreadId,
      turnId: sourceTurnId,
      payload: {
        planMarkdown: "# Source plan",
      },
    });

    const sourceThreadWithPlan = await waitForThread(
      harness.readModel,
      (thread) =>
        thread.proposedPlans.some(
          (proposedPlan: ProviderRuntimeTestProposedPlan) =>
            proposedPlan.id === "plan:thread-plan:turn:turn-plan-source" &&
            proposedPlan.implementedAt === null,
        ),
      2_000,
      sourceThreadId,
    );
    const sourcePlan = sourceThreadWithPlan.proposedPlans.find(
      (entry: ProviderRuntimeTestProposedPlan) =>
        entry.id === "plan:thread-plan:turn:turn-plan-source",
    );
    expect(sourcePlan).toBeDefined();
    if (!sourcePlan) {
      throw new Error("Expected source plan to exist.");
    }

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-plan-target-guarded"),
        threadId: targetThreadId,
        message: {
          messageId: asMessageId("msg-plan-target-guarded"),
          role: "user",
          text: "PLEASE IMPLEMENT THIS PLAN:\n# Source plan",
          attachments: [],
        },
        sourceProposedPlan: {
          threadId: sourceThreadId,
          planId: sourcePlan.id,
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-already-running-guarded"),
        threadId: targetThreadId,
        session: {
          threadId: targetThreadId,
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId,
          updatedAt: createdAt,
          lastError: null,
        },
        createdAt,
      }),
    );

    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" && thread.session?.activeTurnId === activeTurnId,
      2_000,
      targetThreadId,
    );

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-stale-plan-implementation"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: targetThreadId,
      turnId: staleTurnId,
    });

    await harness.drain();

    const readModel = await harness.readModel();
    const sourceThreadAfterRejectedStart = readModel.threads.find(
      (entry) => entry.id === sourceThreadId,
    );
    expect(
      sourceThreadAfterRejectedStart?.proposedPlans.find((entry) => entry.id === sourcePlan.id),
    ).toMatchObject({
      implementedAt: null,
      implementationThreadId: null,
    });

    const targetThreadAfterRejectedStart = readModel.threads.find(
      (entry) => entry.id === targetThreadId,
    );
    expect(targetThreadAfterRejectedStart?.session?.status).toBe("running");
    expect(targetThreadAfterRejectedStart?.session?.activeTurnId).toBe(activeTurnId);
  });

  it("does not mark the source proposed plan implemented for an unrelated turn.started when no thread active turn is tracked", async () => {
    const harness = await createHarness();
    const sourceThreadId = asThreadId("thread-plan");
    const targetThreadId = asThreadId("thread-implement");
    const sourceTurnId = asTurnId("turn-plan-source");
    const expectedTurnId = asTurnId("turn-plan-implement");
    const replayedTurnId = asTurnId("turn-replayed");
    const createdAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-create-plan-source-unrelated"),
        threadId: sourceThreadId,
        projectId: asProjectId("project-1"),
        title: "Plan Source",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: "plan",
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-plan-source-unrelated"),
        threadId: sourceThreadId,
        session: {
          threadId: sourceThreadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          updatedAt: createdAt,
          lastError: null,
        },
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-create-plan-target-unrelated"),
        threadId: targetThreadId,
        projectId: asProjectId("project-1"),
        title: "Plan Target",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-plan-target-unrelated"),
        threadId: targetThreadId,
        session: {
          threadId: targetThreadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          updatedAt: createdAt,
          lastError: null,
        },
        createdAt,
      }),
    );

    harness.emit({
      type: "turn.proposed.completed",
      eventId: asEventId("evt-plan-source-completed-unrelated"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId: sourceThreadId,
      turnId: sourceTurnId,
      payload: {
        planMarkdown: "# Source plan",
      },
    });

    const sourceThreadWithPlan = await waitForThread(
      harness.readModel,
      (thread) =>
        thread.proposedPlans.some(
          (proposedPlan: ProviderRuntimeTestProposedPlan) =>
            proposedPlan.id === "plan:thread-plan:turn:turn-plan-source" &&
            proposedPlan.implementedAt === null,
        ),
      2_000,
      sourceThreadId,
    );
    const sourcePlan = sourceThreadWithPlan.proposedPlans.find(
      (entry: ProviderRuntimeTestProposedPlan) =>
        entry.id === "plan:thread-plan:turn:turn-plan-source",
    );
    expect(sourcePlan).toBeDefined();
    if (!sourcePlan) {
      throw new Error("Expected source plan to exist.");
    }

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-plan-target-unrelated"),
        threadId: targetThreadId,
        message: {
          messageId: asMessageId("msg-plan-target-unrelated"),
          role: "user",
          text: "PLEASE IMPLEMENT THIS PLAN:\n# Source plan",
          attachments: [],
        },
        sourceProposedPlan: {
          threadId: sourceThreadId,
          planId: sourcePlan.id,
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    harness.setProviderSession({
      provider: ProviderDriverKind.make("codex"),
      status: "running",
      runtimeMode: "approval-required",
      threadId: targetThreadId,
      createdAt,
      updatedAt: createdAt,
      activeTurnId: expectedTurnId,
    });

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-unrelated-plan-implementation"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: targetThreadId,
      turnId: replayedTurnId,
    });

    await harness.drain();

    const readModel = await harness.readModel();
    const sourceThreadAfterUnrelatedStart = readModel.threads.find(
      (entry) => entry.id === sourceThreadId,
    );
    expect(
      sourceThreadAfterUnrelatedStart?.proposedPlans.find((entry) => entry.id === sourcePlan.id),
    ).toMatchObject({
      implementedAt: null,
      implementationThreadId: null,
    });
  });

  it("finalizes buffered proposed-plan deltas into a first-class proposed plan on turn completion", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-plan-buffer"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-plan-buffer"),
    });

    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" && thread.session?.activeTurnId === "turn-plan-buffer",
    );

    harness.emit({
      type: "turn.proposed.delta",
      eventId: asEventId("evt-plan-delta-1"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-plan-buffer"),
      payload: {
        delta: "## Buffered plan\n\n- first",
      },
    });
    harness.emit({
      type: "turn.proposed.delta",
      eventId: asEventId("evt-plan-delta-2"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-plan-buffer"),
      payload: {
        delta: "\n- second",
      },
    });
    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-plan-buffer"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-plan-buffer"),
      payload: {
        state: "completed",
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.proposedPlans.some(
        (proposedPlan: ProviderRuntimeTestProposedPlan) =>
          proposedPlan.id === "plan:thread-1:turn:turn-plan-buffer",
      ),
    );
    const proposedPlan = thread.proposedPlans.find(
      (entry: ProviderRuntimeTestProposedPlan) =>
        entry.id === "plan:thread-1:turn:turn-plan-buffer",
    );
    expect(proposedPlan?.planMarkdown).toBe("## Buffered plan\n\n- first\n- second");
  });

  it("buffers assistant deltas when assistant streaming is disabled", async () => {
    const harness = await createHarness({ serverSettings: { enableAssistantStreaming: false } });
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-buffered"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered"),
    });
    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" && thread.session?.activeTurnId === "turn-buffered",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-buffered"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered"),
      itemId: asItemId("item-buffered"),
      payload: {
        streamKind: "assistant_text",
        delta: "buffer me",
      },
    });

    await harness.drain();
    const midReadModel = await harness.readModel();
    const midThread = midReadModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(
      midThread?.messages.some(
        (message: ProviderRuntimeTestMessage) => message.id === "assistant:item-buffered",
      ),
    ).toBe(false);

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed-buffered"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered"),
      itemId: asItemId("item-buffered"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-buffered" && !message.streaming,
      ),
    );
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-buffered",
    );
    expect(message?.text).toBe("buffer me");
    expect(message?.streaming).toBe(false);
  });

  it("flushes buffered assistant text at interactive request boundaries", async () => {
    const cases = [
      {
        name: "approval request",
        suffix: "request-flush",
        text: "visible before approval",
        boundary: (now: string) => ({
          type: "request.opened" as const,
          eventId: asEventId("evt-request-opened-buffered-request-flush"),
          provider: ProviderDriverKind.make("codex"),
          createdAt: now,
          threadId: asThreadId("thread-1"),
          turnId: asTurnId("turn-buffered-request-flush"),
          requestId: ApprovalRequestId.make("req-buffered-request-flush"),
          payload: { requestType: "command_execution_approval" as const, detail: "pwd" },
        }),
      },
      {
        name: "user input request",
        suffix: "user-input-flush",
        text: "visible before user input",
        boundary: (now: string) => ({
          type: "user-input.requested" as const,
          eventId: asEventId("evt-user-input-requested-buffered-user-input-flush"),
          provider: ProviderDriverKind.make("codex"),
          createdAt: now,
          threadId: asThreadId("thread-1"),
          turnId: asTurnId("turn-buffered-user-input-flush"),
          requestId: ApprovalRequestId.make("req-buffered-user-input-flush"),
          payload: {
            questions: [
              {
                id: "choice",
                header: "Choice",
                question: "Pick one",
                options: [{ label: "A", description: "Option A" }],
              },
            ],
          },
        }),
      },
    ];

    for (const testCase of cases) {
      const harness = await createHarness({ serverSettings: { enableAssistantStreaming: false } });
      const now = "2026-01-01T00:00:00.000Z";
      const turnId = `turn-buffered-${testCase.suffix}`;
      const itemId = `item-buffered-${testCase.suffix}`;

      harness.emit({
        type: "turn.started",
        eventId: asEventId(`evt-turn-started-buffered-${testCase.suffix}`),
        provider: ProviderDriverKind.make("codex"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId(turnId),
      });
      await waitForThread(
        harness.readModel,
        (thread) => thread.session?.status === "running" && thread.session?.activeTurnId === turnId,
      );

      harness.emit({
        type: "content.delta",
        eventId: asEventId(`evt-message-delta-buffered-${testCase.suffix}`),
        provider: ProviderDriverKind.make("codex"),
        createdAt: now,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId(turnId),
        itemId: asItemId(itemId),
        payload: { streamKind: "assistant_text", delta: testCase.text },
      });
      harness.emit(testCase.boundary(now));

      const messageId = `assistant:${itemId}`;
      const thread = await waitForThread(harness.readModel, (entry) =>
        entry.messages.some(
          (message: ProviderRuntimeTestMessage) =>
            message.id === messageId && !message.streaming && message.text === testCase.text,
        ),
      );
      const message = thread.messages.find(
        (entry: ProviderRuntimeTestMessage) => entry.id === messageId,
      );
      expect(message?.streaming, testCase.name).toBe(false);
    }
  });

  it("does not create assistant segments for whitespace-only buffered text at approval boundaries", async () => {
    const harness = await createHarness({ serverSettings: { enableAssistantStreaming: false } });
    const startedAt = "2026-03-28T06:28:00.000Z";
    const pausedAt = "2026-03-28T06:28:01.000Z";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-buffered-whitespace-request"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: startedAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-whitespace-request"),
    });
    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-buffered-whitespace-request",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-buffered-whitespace-request"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: startedAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-whitespace-request"),
      itemId: asItemId("item-buffered-whitespace-request"),
      payload: {
        streamKind: "assistant_text",
        delta: "\n\n\n",
      },
    });
    harness.emit({
      type: "request.opened",
      eventId: asEventId("evt-request-opened-buffered-whitespace-request"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: pausedAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-whitespace-request"),
      requestId: ApprovalRequestId.make("req-buffered-whitespace-request"),
      payload: {
        requestType: "command_execution_approval",
        detail: "pwd",
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.kind === "approval.requested",
      ),
    );
    expect(
      thread.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-buffered-whitespace-request",
      ),
    ).toBe(false);
  });

  it("starts a new buffered assistant message segment after approval and completes without duplication", async () => {
    const harness = await createHarness({ serverSettings: { enableAssistantStreaming: false } });
    const startedAt = "2026-03-28T06:07:00.000Z";
    const pausedAt = "2026-03-28T06:07:01.000Z";
    const resumedAt = "2026-03-28T06:07:02.000Z";
    const completedAt = "2026-03-28T06:07:03.000Z";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-buffered-request-append"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: startedAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-request-append"),
    });
    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-buffered-request-append",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-buffered-request-append-initial"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: startedAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-request-append"),
      itemId: asItemId("item-buffered-request-append"),
      payload: {
        streamKind: "assistant_text",
        delta: "first half",
      },
    });
    harness.emit({
      type: "request.opened",
      eventId: asEventId("evt-request-opened-buffered-request-append"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: pausedAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-request-append"),
      requestId: ApprovalRequestId.make("req-buffered-request-append"),
      payload: {
        requestType: "command_execution_approval",
        detail: "pwd",
      },
    });

    await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-buffered-request-append" &&
          !message.streaming &&
          message.text === "first half",
      ),
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-buffered-request-append-followup"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: resumedAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-request-append"),
      itemId: asItemId("item-buffered-request-append"),
      payload: {
        streamKind: "assistant_text",
        delta: " second half",
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed-buffered-request-append"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: completedAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffered-request-append"),
      itemId: asItemId("item-buffered-request-append"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-buffered-request-append:segment:1" &&
          !message.streaming &&
          message.text === " second half",
      ),
    );
    const firstMessage = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-buffered-request-append",
    );
    const resumedMessage = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) =>
        entry.id === "assistant:item-buffered-request-append:segment:1",
    );
    expect(firstMessage?.text).toBe("first half");
    expect(firstMessage?.streaming).toBe(false);
    expect(resumedMessage?.text).toBe(" second half");
    expect(resumedMessage?.streaming).toBe(false);

    const events = await Effect.runPromise(
      Stream.runCollect(harness.engine.readEvents(0)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      ),
    );
    const assistantEvents = events.filter(
      (event): event is Extract<(typeof events)[number], { type: "thread.message-sent" }> =>
        event.type === "thread.message-sent" &&
        event.payload.messageId.startsWith("assistant:item-buffered-request-append"),
    );
    expect(assistantEvents).toHaveLength(4);
    expect(assistantEvents[0]?.payload.streaming).toBe(true);
    expect(assistantEvents[0]?.payload.text).toBe("first half");
    expect(assistantEvents[1]?.payload.streaming).toBe(false);
    expect(assistantEvents[1]?.payload.text).toBe("");
    expect(assistantEvents[2]?.payload.messageId).toBe(
      "assistant:item-buffered-request-append:segment:1",
    );
    expect(assistantEvents[2]?.payload.streaming).toBe(true);
    expect(assistantEvents[2]?.payload.text).toBe(" second half");
    expect(assistantEvents[3]?.payload.messageId).toBe(
      "assistant:item-buffered-request-append:segment:1",
    );
    expect(assistantEvents[3]?.payload.streaming).toBe(false);
    expect(assistantEvents[3]?.payload.text).toBe("");
  });

  it("starts a new streaming assistant message segment after approval", async () => {
    const harness = await createHarness({ serverSettings: { enableAssistantStreaming: true } });
    const startedAt = "2026-03-28T07:00:00.000Z";
    const pausedAt = "2026-03-28T07:00:01.000Z";
    const resumedAt = "2026-03-28T07:00:02.000Z";
    const completedAt = "2026-03-28T07:00:03.000Z";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-streaming-request-segment"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: startedAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-request-segment"),
    });
    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-streaming-request-segment",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-streaming-request-segment-initial"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: startedAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-request-segment"),
      itemId: asItemId("item-streaming-request-segment"),
      payload: {
        streamKind: "assistant_text",
        delta: "before approval",
      },
    });
    harness.emit({
      type: "request.opened",
      eventId: asEventId("evt-request-opened-streaming-request-segment"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: pausedAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-request-segment"),
      requestId: ApprovalRequestId.make("req-streaming-request-segment"),
      payload: {
        requestType: "command_execution_approval",
        detail: "pwd",
      },
    });

    await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-streaming-request-segment" &&
          !message.streaming &&
          message.text === "before approval",
      ),
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-streaming-request-segment-followup"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: resumedAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-request-segment"),
      itemId: asItemId("item-streaming-request-segment"),
      payload: {
        streamKind: "assistant_text",
        delta: " after approval",
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed-streaming-request-segment"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: completedAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-request-segment"),
      itemId: asItemId("item-streaming-request-segment"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-streaming-request-segment:segment:1" &&
          !message.streaming &&
          message.text === " after approval",
      ),
    );
    expect(
      thread.messages.find(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-streaming-request-segment",
      )?.text,
    ).toBe("before approval");
    expect(
      thread.messages.find(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-streaming-request-segment:segment:1",
      )?.text,
    ).toBe(" after approval");
  });

  it("streams assistant deltas when thread.turn.start requests streaming mode", async () => {
    const harness = await createHarness({ serverSettings: { enableAssistantStreaming: true } });
    const now = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-streaming-mode"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: asMessageId("message-streaming-mode"),
          role: "user",
          text: "stream please",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: now,
      }),
    );
    await harness.drain();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-streaming-mode"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-mode"),
    });
    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-streaming-mode",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-streaming-mode"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-mode"),
      itemId: asItemId("item-streaming-mode"),
      payload: {
        streamKind: "assistant_text",
        delta: "hello live",
      },
    });

    const liveThread = await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-streaming-mode" &&
          message.streaming &&
          message.text === "hello live",
      ),
    );
    const liveMessage = liveThread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-streaming-mode",
    );
    expect(liveMessage?.streaming).toBe(true);

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed-streaming-mode"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-streaming-mode"),
      itemId: asItemId("item-streaming-mode"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
        detail: "hello live",
      },
    });

    const finalThread = await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-streaming-mode" && !message.streaming,
      ),
    );
    const finalMessage = finalThread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-streaming-mode",
    );
    expect(finalMessage?.text).toBe("hello live");
    expect(finalMessage?.streaming).toBe(false);
  });

  it("coalesces streaming assistant deltas after the first visible bytes", async () => {
    const harness = await createHarness({ serverSettings: { enableAssistantStreaming: true } });
    const now = "2026-01-01T00:00:00.000Z";
    const turnId = asTurnId("turn-streaming-coalesce");
    const itemId = asItemId("item-streaming-coalesce");

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-streaming-coalesce-started"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId,
    });
    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-streaming-coalesce",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-streaming-coalesce-first"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId,
      itemId,
      payload: {
        streamKind: "assistant_text",
        delta: "first",
      },
    });
    await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-streaming-coalesce" &&
          message.streaming &&
          message.text === "first",
      ),
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-streaming-coalesce-buffered"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId,
      itemId,
      payload: {
        streamKind: "assistant_text",
        delta: " buffered",
      },
    });
    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-streaming-coalesce-buffered-more"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId,
      itemId,
      payload: {
        streamKind: "assistant_text",
        delta: " more",
      },
    });
    await harness.drain();
    const beforeCompletion = (await harness.readModel()).threads.find(
      (entry) => entry.id === "thread-1",
    );
    expect(
      beforeCompletion?.messages.find(
        (message: ProviderRuntimeTestMessage) => message.id === "assistant:item-streaming-coalesce",
      )?.text,
    ).toBe("first");

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-streaming-coalesce-completed"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId,
      itemId,
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });

    const finalThread = await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-streaming-coalesce" && !message.streaming,
      ),
    );
    const finalMessage = finalThread.messages.find(
      (message: ProviderRuntimeTestMessage) => message.id === "assistant:item-streaming-coalesce",
    );
    expect(finalMessage?.text).toBe("first buffered more");
    expect(finalMessage?.streaming).toBe(false);

    const events = await Effect.runPromise(
      Stream.runCollect(harness.engine.readEvents(0)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      ),
    );
    const assistantEvents = events.filter(
      (event): event is Extract<(typeof events)[number], { type: "thread.message-sent" }> =>
        event.type === "thread.message-sent" &&
        event.payload.messageId === "assistant:item-streaming-coalesce",
    );
    expect(assistantEvents.map((event) => [event.payload.streaming, event.payload.text])).toEqual([
      [true, "first"],
      [true, " buffered more"],
      [false, ""],
    ]);
  });

  it("spills oversized buffered deltas and still finalizes full assistant text", async () => {
    const harness = await createHarness({ serverSettings: { enableAssistantStreaming: false } });
    const now = "2026-01-01T00:00:00.000Z";
    const oversizedText = "x".repeat(40_000);

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-buffer-spill"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffer-spill"),
    });
    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-buffer-spill",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-buffer-spill"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffer-spill"),
      itemId: asItemId("item-buffer-spill"),
      payload: {
        streamKind: "assistant_text",
        delta: oversizedText,
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed-buffer-spill"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-buffer-spill"),
      itemId: asItemId("item-buffer-spill"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.messages.some(
        (message: ProviderRuntimeTestMessage) =>
          message.id === "assistant:item-buffer-spill" && !message.streaming,
      ),
    );
    const message = thread.messages.find(
      (entry: ProviderRuntimeTestMessage) => entry.id === "assistant:item-buffer-spill",
    );
    expect(message?.text.length).toBe(oversizedText.length);
    expect(message?.text).toBe(oversizedText);
    expect(message?.streaming).toBe(false);
  });

  it("does not duplicate assistant completion when item.completed is followed by turn.completed", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-for-complete-dedup"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-complete-dedup"),
    });

    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-complete-dedup",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-for-complete-dedup"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-complete-dedup"),
      itemId: asItemId("item-complete-dedup"),
      payload: {
        streamKind: "assistant_text",
        delta: "done",
      },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed-for-complete-dedup"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-complete-dedup"),
      itemId: asItemId("item-complete-dedup"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });
    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-for-complete-dedup"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-complete-dedup"),
      payload: {
        state: "completed",
      },
    });

    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.session?.status === "ready" &&
        thread.session?.activeTurnId === null &&
        thread.messages.some(
          (message: ProviderRuntimeTestMessage) =>
            message.id === "assistant:item-complete-dedup" && !message.streaming,
        ),
    );

    const events = await Effect.runPromise(
      Stream.runCollect(harness.engine.readEvents(0)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      ),
    );
    const completionEvents = events.filter((event) => {
      if (event.type !== "thread.message-sent") {
        return false;
      }
      return (
        event.payload.messageId === "assistant:item-complete-dedup" &&
        event.payload.streaming === false
      );
    });
    expect(completionEvents).toHaveLength(1);
  });

  it("finalizes assistant output without closing the active provider turn", async () => {
    const harness = await createHarness();
    const turnId = asTurnId("turn-provider-idle");

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-provider-idle"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: asThreadId("thread-1"),
      turnId,
    });

    await waitForThread(
      harness.readModel,
      (thread) => thread.latestTurn?.state === "running" && thread.session?.status === "running",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-assistant-delta-provider-idle"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:01.000Z",
      threadId: asThreadId("thread-1"),
      turnId,
      itemId: asItemId("item-provider-idle"),
      payload: {
        streamKind: "assistant_text",
        delta: "I am still working.",
      },
    });

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-assistant-completed-provider-idle"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:02.000Z",
      threadId: asThreadId("thread-1"),
      turnId,
      itemId: asItemId("item-provider-idle"),
      payload: {
        itemType: "assistant_message",
        status: "completed",
      },
    });

    const finalizedOutput = await waitForThread(
      harness.readModel,
      (thread) =>
        thread.latestTurn?.turnId === turnId &&
        thread.latestTurn.state === "running" &&
        thread.latestTurn.completedAt === null &&
        thread.session?.status === "running" &&
        thread.session.activeTurnId === turnId &&
        thread.messages.some(
          (message: ProviderRuntimeTestMessage) =>
            message.id === "assistant:item-provider-idle" && !message.streaming,
        ),
    );
    expect(finalizedOutput.latestTurn?.state).toBe("running");
    expect(finalizedOutput.session?.status).toBe("running");

    harness.emit({
      type: "thread.state.changed",
      eventId: asEventId("evt-thread-idle-provider-idle"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:03.000Z",
      threadId: asThreadId("thread-1"),
      payload: {
        state: "idle",
      },
    });

    const runningAfterIdle = await waitForThread(
      harness.readModel,
      (thread) =>
        thread.latestTurn?.turnId === turnId &&
        thread.latestTurn.state === "running" &&
        thread.latestTurn.completedAt === null &&
        thread.session?.status === "running" &&
        thread.session.activeTurnId === turnId,
    );
    expect(runningAfterIdle.session?.status).toBe("running");

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-provider-idle"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:04.000Z",
      threadId: asThreadId("thread-1"),
      turnId,
      payload: {
        state: "completed",
      },
    });

    const completed = await waitForThread(
      harness.readModel,
      (thread) =>
        thread.latestTurn?.turnId === turnId &&
        thread.latestTurn.state === "completed" &&
        thread.latestTurn.completedAt === "2026-01-01T00:00:04.000Z" &&
        thread.session?.status === "ready",
    );
    expect(completed.latestTurn?.state).toBe("completed");
  });

  it("keeps a running turn open when provider diff metadata arrives before turn completion", async () => {
    const harness = await createHarness();
    const turnId = asTurnId("turn-provider-diff-midturn");

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-provider-diff-midturn"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: asThreadId("thread-1"),
      turnId,
    });

    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.latestTurn?.state === "running" &&
        thread.latestTurn.completedAt === null &&
        thread.session?.status === "running",
    );

    harness.emit({
      type: "turn.diff.updated",
      eventId: asEventId("evt-turn-diff-provider-diff-midturn"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:02.000Z",
      threadId: asThreadId("thread-1"),
      turnId,
      itemId: asItemId("item-provider-diff-midturn"),
      payload: {
        unifiedDiff: "diff --git a/file.txt b/file.txt\n+hello\n",
      },
    });

    const stillRunning = await waitForThread(
      harness.readModel,
      (thread) =>
        thread.latestTurn?.turnId === turnId &&
        thread.latestTurn.state === "running" &&
        thread.latestTurn.completedAt === null &&
        thread.session?.status === "running" &&
        thread.session.activeTurnId === turnId,
    );

    expect(stillRunning.latestTurn?.state).toBe("running");
    expect(stillRunning.latestTurn?.completedAt).toBeNull();
  });

  it("preserves completed latest turn state when same-turn provider content arrives late", async () => {
    const harness = await createHarness();
    const turnId = asTurnId("turn-provider-work-after-completed");

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-work-after-completed"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: asThreadId("thread-1"),
      turnId,
    });
    await waitForThread(
      harness.readModel,
      (thread) => thread.latestTurn?.state === "running" && thread.session?.status === "running",
    );

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-work-after-completed"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:02.000Z",
      threadId: asThreadId("thread-1"),
      turnId,
      payload: {
        state: "completed",
      },
    });
    await waitForThread(
      harness.readModel,
      (thread) => thread.latestTurn?.state === "completed" && thread.session?.status === "ready",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-content-after-completed"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:03.000Z",
      threadId: asThreadId("thread-1"),
      turnId,
      itemId: asItemId("item-after-completed"),
      payload: {
        streamKind: "assistant_text",
        delta: "Still working.",
      },
    });

    await harness.drain();
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === asThreadId("thread-1"));

    expect(thread?.latestTurn?.turnId).toBe(turnId);
    expect(thread?.latestTurn?.state).toBe("completed");
    expect(thread?.latestTurn?.completedAt).not.toBeNull();
    expect(thread?.session?.status).toBe("ready");
    expect(thread?.session?.activeTurnId).toBeNull();
    expect(
      thread?.messages.some(
        (message: ProviderRuntimeTestMessage) => message.id === "assistant:item-after-completed",
      ),
    ).toBe(true);
  });

  it("reopens active turn state when provider content arrives after a stale idle transition", async () => {
    const harness = await createHarness();
    const turnId = asTurnId("turn-reopen-after-idle");

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-reopen-after-idle"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: asThreadId("thread-1"),
      turnId,
    });

    await waitForThread(
      harness.readModel,
      (thread) =>
        thread.latestTurn?.state === "running" &&
        thread.session?.status === "running" &&
        thread.session.activeTurnId === turnId,
    );

    harness.emit({
      type: "thread.state.changed",
      eventId: asEventId("evt-thread-idle-reopen-after-idle"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:01.000Z",
      threadId: asThreadId("thread-1"),
      payload: {
        state: "idle",
      },
    });

    await waitForThread(
      harness.readModel,
      (thread) => thread.session?.status === "running" && thread.session.activeTurnId === turnId,
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-content-reopen-after-idle"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:02.000Z",
      threadId: asThreadId("thread-1"),
      turnId,
      itemId: asItemId("item-reopen-after-idle"),
      payload: {
        streamKind: "assistant_text",
        delta: "Still streaming.",
      },
    });

    const reopened = await waitForThread(
      harness.readModel,
      (thread) =>
        thread.latestTurn?.turnId === turnId &&
        thread.latestTurn.state === "running" &&
        thread.latestTurn.completedAt === null &&
        thread.session?.status === "running" &&
        thread.session.activeTurnId === turnId,
    );
    expect(reopened.session?.status).toBe("running");
    expect(reopened.latestTurn?.state).toBe("running");
  });

  it("maps canonical request events into approval activities with requestKind", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "request.opened",
      eventId: asEventId("evt-request-opened"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      requestId: ApprovalRequestId.make("req-open"),
      payload: {
        requestType: "command_execution_approval",
        detail: "pwd",
      },
    });

    harness.emit({
      type: "request.resolved",
      eventId: asEventId("evt-request-resolved"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      requestId: ApprovalRequestId.make("req-open"),
      payload: {
        requestType: "command_execution_approval",
        decision: "accept",
      },
    });

    await waitForThread(
      harness.readModel,
      (entry) =>
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "approval.requested",
        ) &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "approval.resolved",
        ),
    );

    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread).toBeDefined();

    const requested = thread?.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-request-opened",
    );
    const requestedPayload =
      requested?.payload && typeof requested.payload === "object"
        ? (requested.payload as Record<string, unknown>)
        : undefined;
    expect(requestedPayload?.requestKind).toBe("command");
    expect(requestedPayload?.requestType).toBe("command_execution_approval");

    const resolved = thread?.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-request-resolved",
    );
    const resolvedPayload =
      resolved?.payload && typeof resolved.payload === "object"
        ? (resolved.payload as Record<string, unknown>)
        : undefined;
    expect(resolvedPayload?.requestKind).toBe("command");
    expect(resolvedPayload?.requestType).toBe("command_execution_approval");
  });

  it("maps runtime.error into errored session state", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "runtime.error",
      eventId: asEventId("evt-runtime-error"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-3"),
      payload: {
        message: "runtime exploded",
      },
    });

    const thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.session?.status === "error" &&
        entry.session?.activeTurnId === null &&
        entry.session?.lastError === "runtime exploded" &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.id === "evt-runtime-error",
        ),
    );
    const activity = thread.activities.find(
      (entry: ProviderRuntimeTestActivity) => entry.id === "evt-runtime-error",
    );
    const activityPayload =
      activity?.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : undefined;

    expect(thread.session?.status).toBe("error");
    expect(thread.session?.lastError).toBe("runtime exploded");
    expect(activity?.kind).toBe("runtime.error");
    expect(activityPayload?.message).toBe("runtime exploded");
  });

  it("keeps the session running and records transient retry warnings during an active turn", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-warning-turn-started"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-warning"),
      payload: {},
    });

    harness.emit({
      type: "runtime.warning",
      eventId: asEventId("evt-warning-runtime"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-warning"),
      payload: {
        message: "Reconnecting... 2/5",
        detail: {
          willRetry: true,
        },
      },
    });
    await harness.drain();

    const thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.session?.status === "running" &&
        entry.session?.activeTurnId === "turn-warning" &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.id === "evt-warning-runtime",
        ),
    );
    const activity = thread.activities.find(
      (entry: ProviderRuntimeTestActivity) => entry.id === "evt-warning-runtime",
    );
    const payload =
      activity?.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : undefined;
    expect(thread.session?.status).toBe("running");
    expect(thread.session?.activeTurnId).toBe("turn-warning");
    expect(thread.session?.lastError).toBeNull();
    expect(activity?.kind).toBe("runtime.warning");
    expect(activity?.summary).toBe("Provider transport retrying");
    expect(payload?.message).toBe("Reconnecting... 2/5");
    expect(payload?.retrying).toBe(true);
  });

  it("keeps pending turn starts busy across provider ready and idle startup events", async () => {
    const harness = await createHarness();
    const requestedAt = "2026-01-01T00:00:00.000Z";
    const startedAt = "2026-01-01T00:00:05.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-pending-start-lifecycle"),
        threadId: asThreadId("thread-1"),
        message: {
          messageId: asMessageId("msg-pending-start-lifecycle"),
          role: "user",
          text: "hello",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: requestedAt,
      }),
    );

    await waitForThread(
      harness.readModel,
      (entry) => entry.session?.status === "starting" && entry.session?.activeTurnId === null,
    );

    harness.emit({
      type: "session.started",
      eventId: asEventId("evt-pending-start-session-started"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:01.000Z",
      threadId: asThreadId("thread-1"),
      message: "session started",
    });
    harness.emit({
      type: "session.state.changed",
      eventId: asEventId("evt-pending-start-session-ready"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:02.000Z",
      threadId: asThreadId("thread-1"),
      payload: {
        state: "ready",
      },
    });
    harness.emit({
      type: "thread.started",
      eventId: asEventId("evt-pending-start-thread-started"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:03.000Z",
      threadId: asThreadId("thread-1"),
    });
    harness.emit({
      type: "thread.state.changed",
      eventId: asEventId("evt-pending-start-thread-idle"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:04.000Z",
      threadId: asThreadId("thread-1"),
      payload: {
        state: "idle",
      },
    });
    await harness.drain();

    const stillStarting = await waitForThread(
      harness.readModel,
      (entry) => entry.session?.status === "starting" && entry.session?.activeTurnId === null,
    );
    expect(stillStarting.session?.status).toBe("starting");
    expect(stillStarting.session?.activeTurnId).toBeNull();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-pending-start-turn-started"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: startedAt,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-pending-start"),
      payload: {},
    });

    const running = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.session?.status === "running" &&
        entry.session?.activeTurnId === "turn-pending-start" &&
        entry.latestTurn?.turnId === "turn-pending-start",
    );
    expect(running.latestTurn?.requestedAt).toBe(requestedAt);
    expect(running.latestTurn?.startedAt).toBe(startedAt);
  });

  it("lets Codex turn.started repair a provisional ACK active turn id", async () => {
    const harness = await createHarness();
    const provisionalTurnId = asTurnId("turn-provisional-ack");
    const concreteTurnId = asTurnId("turn-provider-active");
    const sessionAt = "2026-01-01T00:00:01.000Z";
    const startedAt = "2026-01-01T00:00:02.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-provisional-active"),
        threadId: asThreadId("thread-1"),
        session: {
          threadId: asThreadId("thread-1"),
          status: "running",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: provisionalTurnId,
          updatedAt: sessionAt,
          lastError: null,
        },
        createdAt: sessionAt,
      }),
    );
    await waitForThread(
      harness.readModel,
      (entry) =>
        entry.session?.status === "running" && entry.session.activeTurnId === provisionalTurnId,
    );

    harness.setProviderSession({
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      status: "running",
      runtimeMode: "approval-required",
      threadId: asThreadId("thread-1"),
      createdAt: sessionAt,
      updatedAt: startedAt,
      activeTurnId: concreteTurnId,
    });

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-concrete-provider-turn-started"),
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      createdAt: startedAt,
      threadId: asThreadId("thread-1"),
      turnId: concreteTurnId,
      payload: {},
    });

    const repaired = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.session?.status === "running" &&
        entry.session.activeTurnId === concreteTurnId &&
        entry.latestTurn?.turnId === concreteTurnId,
    );

    expect(repaired.latestTurn?.startedAt).toBe(startedAt);
  });

  it("repairs a stale projected Codex active turn from provider-owned active work", async () => {
    const harness = await createHarness();
    const staleTurnId = asTurnId("turn-stale-projection");
    const concreteTurnId = asTurnId("turn-provider-work");
    const sessionAt = "2026-01-01T00:00:01.000Z";
    const workAt = "2026-01-01T00:00:03.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-stale-active"),
        threadId: asThreadId("thread-1"),
        session: {
          threadId: asThreadId("thread-1"),
          status: "running",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "approval-required",
          activeTurnId: staleTurnId,
          updatedAt: sessionAt,
          lastError: null,
        },
        createdAt: sessionAt,
      }),
    );
    await waitForThread(
      harness.readModel,
      (entry) => entry.session?.status === "running" && entry.session.activeTurnId === staleTurnId,
    );

    harness.setProviderSession({
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      status: "running",
      runtimeMode: "approval-required",
      threadId: asThreadId("thread-1"),
      createdAt: sessionAt,
      updatedAt: workAt,
      activeTurnId: concreteTurnId,
    });

    harness.emit({
      type: "item.started",
      eventId: asEventId("evt-concrete-provider-work"),
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      createdAt: workAt,
      threadId: asThreadId("thread-1"),
      turnId: concreteTurnId,
      payload: {
        itemType: "command_execution",
        status: "in_progress",
        title: "Command run",
        detail: "echo ok",
      },
    });

    const repaired = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.session?.status === "running" &&
        entry.session.activeTurnId === concreteTurnId &&
        entry.latestTurn?.turnId === concreteTurnId &&
        entry.activities.some((activity) => activity.turnId === concreteTurnId),
    );

    expect(repaired.latestTurn?.startedAt).toBe(workAt);
    expect(repaired.activities.some((activity) => activity.turnId === concreteTurnId)).toBe(true);
  });

  it("treats a provider tool heartbeat as provider-owned active work", async () => {
    const harness = await createHarness();
    const staleTurnId = asTurnId("turn-stale-tool-heartbeat");
    const concreteTurnId = asTurnId("turn-provider-tool-heartbeat");
    const sessionAt = "2026-01-01T00:00:01.000Z";
    const heartbeatAt = "2026-01-01T00:00:03.000Z";

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-stale-provider-turn-started"),
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      createdAt: sessionAt,
      threadId: asThreadId("thread-1"),
      turnId: staleTurnId,
      payload: {},
    });
    await waitForThread(
      harness.readModel,
      (entry) => entry.session?.status === "running" && entry.session.activeTurnId === staleTurnId,
    );

    harness.setProviderSession({
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      status: "running",
      runtimeMode: "approval-required",
      threadId: asThreadId("thread-1"),
      createdAt: sessionAt,
      updatedAt: heartbeatAt,
      activeTurnId: concreteTurnId,
    });

    harness.emit({
      type: "tool.progress",
      eventId: asEventId("evt-provider-tool-heartbeat"),
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      createdAt: heartbeatAt,
      threadId: asThreadId("thread-1"),
      turnId: concreteTurnId,
      payload: {
        toolUseId: "tool-heartbeat-1",
        toolName: "Bash",
        elapsedSeconds: 30,
      },
    });

    const repaired = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.session?.status === "running" &&
        entry.session.activeTurnId === concreteTurnId &&
        entry.latestTurn?.turnId === concreteTurnId &&
        entry.latestTurn.state === "running",
    );

    expect(repaired.latestTurn?.startedAt).toBe(heartbeatAt);
    expect(
      repaired.activities.some((activity) => activity.id === "evt-provider-tool-heartbeat"),
    ).toBe(false);
  });

  it("maps session/thread lifecycle and item.started into session/activity projections", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "session.started",
      eventId: asEventId("evt-session-started"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      message: "session started",
    });
    harness.emit({
      type: "thread.started",
      eventId: asEventId("evt-thread-started"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
    });
    harness.emit({
      type: "item.started",
      eventId: asEventId("evt-tool-started"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-9"),
      payload: {
        itemType: "command_execution",
        status: "in_progress",
        title: "Read file",
        detail: "/tmp/file.ts",
      },
    });

    const thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.session?.status === "ready" &&
        entry.session?.activeTurnId === null &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "tool.started",
        ),
    );

    expect(thread.session?.status).toBe("ready");
    expect(
      thread.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.kind === "tool.started",
      ),
    ).toBe(true);
  });

  it("consumes P1 runtime events into thread metadata, diff checkpoints, and activities", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "thread.metadata.updated",
      eventId: asEventId("evt-thread-metadata-updated"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        name: "Renamed by provider",
        metadata: { source: "provider" },
      },
    });

    harness.emit({
      type: "turn.plan.updated",
      eventId: asEventId("evt-turn-plan-updated"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-p1"),
      payload: {
        explanation: "Working through the plan",
        plan: [
          { step: "Inspect files", status: "completed" },
          { step: "Apply patch", status: "in_progress" },
        ],
      },
    });

    harness.emit({
      type: "item.updated",
      eventId: asEventId("evt-item-updated"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-p1"),
      itemId: asItemId("item-p1-tool"),
      payload: {
        itemType: "command_execution",
        status: "in_progress",
        title: "Run tests",
        detail: "bun test",
        data: { pid: 123 },
      },
    });

    harness.emit({
      type: "runtime.warning",
      eventId: asEventId("evt-runtime-warning"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-p1"),
      payload: {
        message: "Provider got slow",
        detail: { latencyMs: 1500 },
      },
    });

    harness.emit({
      type: "turn.diff.updated",
      eventId: asEventId("evt-turn-diff-updated"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-p1"),
      itemId: asItemId("item-p1-assistant"),
      payload: {
        unifiedDiff: "diff --git a/file.txt b/file.txt\n+hello\n",
      },
    });

    const thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.title === "Renamed by provider" &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "turn.plan.updated",
        ) &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "tool.updated",
        ) &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "runtime.warning",
        ) &&
        entry.checkpoints.some(
          (checkpoint: ProviderRuntimeTestCheckpoint) => checkpoint.turnId === "turn-p1",
        ),
    );

    expect(thread.title).toBe("Renamed by provider");

    const planActivity = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-turn-plan-updated",
    );
    const planPayload =
      planActivity?.payload && typeof planActivity.payload === "object"
        ? (planActivity.payload as Record<string, unknown>)
        : undefined;
    expect(planActivity?.kind).toBe("turn.plan.updated");
    expect(Array.isArray(planPayload?.plan)).toBe(true);

    const toolUpdate = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-item-updated",
    );
    const toolUpdatePayload =
      toolUpdate?.payload && typeof toolUpdate.payload === "object"
        ? (toolUpdate.payload as Record<string, unknown>)
        : undefined;
    expect(toolUpdate?.kind).toBe("tool.updated");
    expect(toolUpdatePayload?.itemType).toBe("command_execution");
    expect(toolUpdatePayload?.status).toBe("in_progress");

    const warning = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-runtime-warning",
    );
    const warningPayload =
      warning?.payload && typeof warning.payload === "object"
        ? (warning.payload as Record<string, unknown>)
        : undefined;
    expect(warning?.kind).toBe("runtime.warning");
    expect(warningPayload?.message).toBe("Provider got slow");

    const checkpoint = thread.checkpoints.find(
      (entry: ProviderRuntimeTestCheckpoint) => entry.turnId === "turn-p1",
    );
    expect(checkpoint?.status).toBe("missing");
    expect(checkpoint?.assistantMessageId).toBe("assistant:item-p1-assistant");
    expect(checkpoint?.checkpointRef).toBe("provider-diff:evt-turn-diff-updated");
  });

  it("projects context window updates into normalized thread activities", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "thread.token-usage.updated",
      eventId: asEventId("evt-thread-token-usage-updated"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        usage: {
          usedTokens: 1075,
          totalProcessedTokens: 10_200,
          maxTokens: 128_000,
          inputTokens: 1000,
          cachedInputTokens: 500,
          outputTokens: 50,
          reasoningOutputTokens: 25,
          lastUsedTokens: 1075,
          lastInputTokens: 1000,
          lastCachedInputTokens: 500,
          lastOutputTokens: 50,
          lastReasoningOutputTokens: 25,
          compactsAutomatically: true,
        },
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.kind === "context-window.updated",
      ),
    );

    const usageActivity = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.kind === "context-window.updated",
    );
    expect(usageActivity).toBeDefined();
    expect(usageActivity?.payload).toMatchObject({
      usedTokens: 1075,
      totalProcessedTokens: 10_200,
      maxTokens: 128_000,
      inputTokens: 1000,
      cachedInputTokens: 500,
      outputTokens: 50,
      reasoningOutputTokens: 25,
      lastUsedTokens: 1075,
      compactsAutomatically: true,
    });
  });

  it("projects Claude usage snapshots with context window into normalized thread activities", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "thread.token-usage.updated",
      eventId: asEventId("evt-thread-token-usage-updated-claude-window"),
      provider: ProviderDriverKind.make("claudeAgent"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      payload: {
        usage: {
          usedTokens: 31_251,
          lastUsedTokens: 31_251,
          maxTokens: 200_000,
          toolUses: 25,
          durationMs: 43_567,
        },
      },
      raw: {
        source: "claude.sdk.message",
        method: "claude/result/success",
        payload: {},
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.kind === "context-window.updated",
      ),
    );

    const usageActivity = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.kind === "context-window.updated",
    );
    expect(usageActivity?.payload).toMatchObject({
      usedTokens: 31_251,
      lastUsedTokens: 31_251,
      maxTokens: 200_000,
      toolUses: 25,
      durationMs: 43_567,
    });
  });

  it("projects compacted thread state into context compaction activities", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "thread.state.changed",
      eventId: asEventId("evt-thread-compacted"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-1"),
      payload: {
        state: "compacted",
        detail: { source: "provider" },
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.kind === "context-compaction",
      ),
    );

    const activity = thread.activities.find(
      (candidate: ProviderRuntimeTestActivity) => candidate.kind === "context-compaction",
    );
    expect(activity?.summary).toBe("Context compacted");
    expect(activity?.tone).toBe("info");
  });

  it("projects Codex task lifecycle chunks into thread activities", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "task.started",
      eventId: asEventId("evt-task-started"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-task-1"),
      payload: {
        taskId: "turn-task-1",
        taskType: "plan",
      },
    });

    harness.emit({
      type: "task.progress",
      eventId: asEventId("evt-task-progress"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-task-1"),
      payload: {
        taskId: "turn-task-1",
        description: "Comparing the desktop rollout chunks to the app-server stream.",
        summary: "Code reviewer is validating the desktop rollout chunks.",
      },
    });

    harness.emit({
      type: "task.completed",
      eventId: asEventId("evt-task-completed"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-task-1"),
      payload: {
        taskId: "turn-task-1",
        status: "completed",
        summary: "<proposed_plan>\n# Plan title\n</proposed_plan>",
      },
    });
    harness.emit({
      type: "turn.proposed.completed",
      eventId: asEventId("evt-task-proposed-plan-completed"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-task-1"),
      payload: {
        planMarkdown: "# Plan title",
      },
    });

    const thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "task.completed",
        ) &&
        entry.proposedPlans.some(
          (proposedPlan: ProviderRuntimeTestProposedPlan) =>
            proposedPlan.id === "plan:thread-1:turn:turn-task-1",
        ),
    );

    const started = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-task-started",
    );
    const progress = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-task-progress",
    );
    const completed = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-task-completed",
    );

    const progressPayload =
      progress?.payload && typeof progress.payload === "object"
        ? (progress.payload as Record<string, unknown>)
        : undefined;
    const completedPayload =
      completed?.payload && typeof completed.payload === "object"
        ? (completed.payload as Record<string, unknown>)
        : undefined;

    expect(started?.kind).toBe("task.started");
    expect(started?.summary).toBe("Plan task started");
    expect(progress?.kind).toBe("task.progress");
    expect(progressPayload?.detail).toBe("Code reviewer is validating the desktop rollout chunks.");
    expect(progressPayload?.summary).toBe(
      "Code reviewer is validating the desktop rollout chunks.",
    );
    expect(completed?.kind).toBe("task.completed");
    expect(completedPayload?.detail).toBe("<proposed_plan>\n# Plan title\n</proposed_plan>");
    expect(
      thread.proposedPlans.find(
        (entry: ProviderRuntimeTestProposedPlan) => entry.id === "plan:thread-1:turn:turn-task-1",
      )?.planMarkdown,
    ).toBe("# Plan title");
  });

  it("projects provider hook lifecycle into bounded work-log activities", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "hook.started",
      eventId: asEventId("evt-hook-started"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-hook-1"),
      payload: {
        hookId: "hook-1",
        hookName: "command hook",
        hookEvent: "postToolUse",
      },
    });

    harness.emit({
      type: "hook.completed",
      eventId: asEventId("evt-hook-completed"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-hook-1"),
      payload: {
        hookId: "hook-1",
        outcome: "error",
        output: "Hook rejected the output because validation failed.",
      },
    });

    const thread = await waitForThread(harness.readModel, (entry) =>
      entry.activities.some(
        (activity: ProviderRuntimeTestActivity) => activity.id === "evt-hook-completed",
      ),
    );
    const started = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-hook-started",
    );
    const completed = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-hook-completed",
    );
    const completedPayload =
      completed?.payload && typeof completed.payload === "object"
        ? (completed.payload as Record<string, unknown>)
        : undefined;

    expect(started?.kind).toBe("hook.started");
    expect(started?.summary).toBe("command hook started");
    expect(started?.turnId).toBe("turn-hook-1");
    expect(completed?.kind).toBe("hook.completed");
    expect(completed?.tone).toBe("error");
    expect(completed?.summary).toBe("Hook failed");
    expect(completedPayload?.detail).toBe("Hook rejected the output because validation failed.");
  });

  it("projects structured user input request and resolution as thread activities", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "user-input.requested",
      eventId: asEventId("evt-user-input-requested"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-user-input"),
      requestId: ApprovalRequestId.make("req-user-input-1"),
      payload: {
        questions: [
          {
            id: "sandbox_mode",
            header: "Sandbox",
            question: "Which mode should be used?",
            options: [
              {
                label: "workspace-write",
                description: "Allow workspace writes only",
              },
            ],
          },
        ],
      },
    });

    harness.emit({
      type: "user-input.resolved",
      eventId: asEventId("evt-user-input-resolved"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-user-input"),
      requestId: ApprovalRequestId.make("req-user-input-1"),
      payload: {
        answers: {
          sandbox_mode: "workspace-write",
        },
      },
    });

    const thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "user-input.requested",
        ) &&
        entry.activities.some(
          (activity: ProviderRuntimeTestActivity) => activity.kind === "user-input.resolved",
        ),
    );

    const requested = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-user-input-requested",
    );
    expect(requested?.kind).toBe("user-input.requested");

    const resolved = thread.activities.find(
      (activity: ProviderRuntimeTestActivity) => activity.id === "evt-user-input-resolved",
    );
    const resolvedPayload =
      resolved?.payload && typeof resolved.payload === "object"
        ? (resolved.payload as Record<string, unknown>)
        : undefined;
    expect(resolved?.kind).toBe("user-input.resolved");
    expect(resolvedPayload?.answers).toEqual({
      sandbox_mode: "workspace-write",
    });
  });

  it("continues processing runtime events after a single event handler failure", async () => {
    const harness = await createHarness();
    const now = "2026-01-01T00:00:00.000Z";

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-invalid-delta"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: now,
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-invalid"),
      itemId: asItemId("item-invalid"),
      payload: {
        streamKind: "assistant_text",
        delta: undefined,
      },
    } as unknown as ProviderRuntimeEvent);

    harness.emit({
      type: "runtime.error",
      eventId: asEventId("evt-runtime-error-after-failure"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: asThreadId("thread-1"),
      turnId: asTurnId("turn-after-failure"),
      payload: {
        message: "runtime still processed",
      },
    });

    const thread = await waitForThread(
      harness.readModel,
      (entry) =>
        entry.session?.status === "error" &&
        entry.session?.activeTurnId === null &&
        entry.session?.lastError === "runtime still processed",
    );
    expect(thread.session?.status).toBe("error");
    expect(thread.session?.lastError).toBe("runtime still processed");
  });
});
