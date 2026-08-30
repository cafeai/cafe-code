// @effect-diagnostics nodeBuiltinImport:off
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  ProviderApprovalDecision,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionForkInput,
  ProviderSessionForkResult,
  ProviderSteerTurnInput,
  ProviderTurnSteerResult,
  ProviderTurnStartResult,
} from "@cafecode/contracts";
import {
  ApprovalRequestId,
  EventId,
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionStartInput,
  ThreadId,
  TurnId,
} from "@cafecode/contracts";
import { createModelSelection } from "@cafecode/shared/model";
import { it, assert, vi } from "@effect/vitest";
import { beforeEach } from "vitest";

import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderUnsupportedError,
  ProviderValidationError,
  makeProviderSubagentDetailReadError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { ProviderAdapterShape, ProviderSubagentDetail } from "../Services/ProviderAdapter.ts";
import {
  ProviderAdapterRegistry,
  type ProviderAdapterRegistryShape,
} from "../Services/ProviderAdapterRegistry.ts";
import { ProviderService } from "../Services/ProviderService.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import { makeProviderServiceLive } from "./ProviderService.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "./ProviderEventLoggers.ts";
import { ProviderSessionDirectoryLive } from "./ProviderSessionDirectory.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderSessionRuntimeRepositoryLive } from "../../persistence/Layers/ProviderSessionRuntime.ts";
import type { ProviderSessionRuntimeRepositoryError } from "../../persistence/Errors.ts";
import { ProviderSessionRuntimeRepository } from "../../persistence/Services/ProviderSessionRuntime.ts";
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../../persistence/Layers/Sqlite.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeAdapterRegistryMock } from "../testUtils/providerAdapterRegistryMock.ts";

const defaultServerSettingsLayer = ServerSettingsService.layerTest();

const asRequestId = (value: string): ApprovalRequestId => ApprovalRequestId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asThreadId = (value: string): ThreadId => ThreadId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);
const codexInstanceId = ProviderInstanceId.make("codex");
const claudeAgentInstanceId = ProviderInstanceId.make("claudeAgent");
const CODEX_DRIVER = ProviderDriverKind.make("codex");
const CLAUDE_AGENT_DRIVER = ProviderDriverKind.make("claudeAgent");
const TEST_DRIVER = ProviderDriverKind.make("testDriver");

type LegacyProviderRuntimeEvent = {
  readonly type: string;
  readonly eventId: EventId;
  readonly provider: ProviderDriverKind;
  readonly createdAt: string;
  readonly threadId: ThreadId;
  readonly turnId?: string | undefined;
  readonly itemId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly payload?: unknown | undefined;
  readonly [key: string]: unknown;
};

function makeFakeCodexAdapter(provider: ProviderDriverKind = CODEX_DRIVER) {
  const sessions = new Map<ThreadId, ProviderSession>();
  let runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());

  const startSession = vi.fn(
    (input: ProviderSessionStartInput): Effect.Effect<ProviderSession, ProviderAdapterError> =>
      Effect.sync(() => {
        const now = "2026-01-01T00:00:00.000Z";
        const session: ProviderSession = {
          provider,
          ...(input.providerInstanceId !== undefined
            ? { providerInstanceId: input.providerInstanceId }
            : {}),
          status: "ready",
          runtimeMode: input.runtimeMode,
          threadId: input.threadId,
          resumeCursor: input.resumeCursor ?? {
            opaque: `resume-${String(input.threadId)}`,
          },
          cwd: input.cwd ?? process.cwd(),
          createdAt: now,
          updatedAt: now,
        };
        sessions.set(session.threadId, session);
        return session;
      }),
  );

  const sendTurn = vi.fn(
    (
      input: ProviderSendTurnInput,
    ): Effect.Effect<ProviderTurnStartResult, ProviderAdapterError> => {
      if (!sessions.has(input.threadId)) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({
            provider,
            threadId: input.threadId,
          }),
        );
      }

      return Effect.succeed({
        threadId: input.threadId,
        turnId: TurnId.make(`turn-${String(input.threadId)}`),
      });
    },
  );

  const forkSession = vi.fn(
    (
      input: ProviderSessionForkInput,
    ): Effect.Effect<ProviderSessionForkResult, ProviderAdapterError> => {
      const source = sessions.get(input.sourceThreadId);
      if (!source) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({
            provider,
            threadId: input.sourceThreadId,
          }),
        );
      }
      return Effect.succeed({
        operationId: input.operationId,
        sourceThreadId: input.sourceThreadId,
        targetThreadId: input.targetThreadId,
        provider,
        providerInstanceId: source.providerInstanceId ?? ProviderInstanceId.make(String(provider)),
        runtimeMode: source.runtimeMode,
        ...(source.cwd !== undefined ? { cwd: source.cwd } : {}),
        resumeCursor: { opaque: `fork-${String(input.targetThreadId)}` },
      });
    },
  );

  const discardSessionFork = vi.fn((): Effect.Effect<void, ProviderAdapterError> => Effect.void);

  const steerTurn = vi.fn(
    (
      input: ProviderSteerTurnInput,
    ): Effect.Effect<ProviderTurnSteerResult, ProviderAdapterError> => {
      if (!sessions.has(input.threadId)) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({
            provider,
            threadId: input.threadId,
          }),
        );
      }

      return Effect.succeed({
        threadId: input.threadId,
        turnId: input.expectedTurnId,
      });
    },
  );

  const interruptTurn = vi.fn(
    (_threadId: ThreadId, _turnId?: TurnId): Effect.Effect<void, ProviderAdapterError> =>
      Effect.void,
  );

  const respondToRequest = vi.fn(
    (
      _threadId: ThreadId,
      _requestId: string,
      _decision: ProviderApprovalDecision,
    ): Effect.Effect<void, ProviderAdapterError> => Effect.void,
  );

  const respondToUserInput = vi.fn(
    (
      _threadId: ThreadId,
      _requestId: string,
      _answers: Record<string, unknown>,
    ): Effect.Effect<void, ProviderAdapterError> => Effect.void,
  );

  const stopSession = vi.fn(
    (threadId: ThreadId): Effect.Effect<void, ProviderAdapterError> =>
      Effect.sync(() => {
        sessions.delete(threadId);
      }),
  );

  const listSessions = vi.fn(
    (): Effect.Effect<ReadonlyArray<ProviderSession>> =>
      Effect.sync(() => Array.from(sessions.values())),
  );

  const hasSession = vi.fn(
    (threadId: ThreadId): Effect.Effect<boolean> => Effect.succeed(sessions.has(threadId)),
  );

  const readThread = vi.fn(
    (
      threadId: ThreadId,
    ): Effect.Effect<
      {
        threadId: ThreadId;
        turns: ReadonlyArray<{ id: TurnId; items: readonly [] }>;
      },
      ProviderAdapterError
    > =>
      Effect.succeed({
        threadId,
        turns: [{ id: asTurnId("turn-1"), items: [] }],
      }),
  );

  const readSubagentDetail = vi.fn(
    (
      _threadId: ThreadId,
      subagentId: string,
    ): Effect.Effect<ProviderSubagentDetail, ProviderAdapterError> =>
      Effect.succeed({
        messages: [
          { key: "m0", role: "user", text: `Assignment for ${subagentId}` },
          { key: "m1", role: "assistant", text: "Completed safely." },
        ],
        gaps: [],
        truncated: false,
      }),
  );

  const rollbackThread = vi.fn(
    (
      threadId: ThreadId,
      _numTurns: number,
    ): Effect.Effect<{ threadId: ThreadId; turns: readonly [] }, ProviderAdapterError> =>
      Effect.succeed({ threadId, turns: [] }),
  );

  const stopAll = vi.fn(
    (): Effect.Effect<void, ProviderAdapterError> =>
      Effect.sync(() => {
        sessions.clear();
      }),
  );

  const adapter: ProviderAdapterShape<ProviderAdapterError> = {
    provider,
    capabilities: {
      sessionModelSwitch: "in-session",
      liveSteer:
        provider === CODEX_DRIVER || provider === CLAUDE_AGENT_DRIVER ? "supported" : "unsupported",
      sessionFork:
        provider === CODEX_DRIVER || provider === CLAUDE_AGENT_DRIVER ? "supported" : "unsupported",
    },
    startSession,
    forkSession,
    discardSessionFork,
    sendTurn,
    steerTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    readThread,
    ...(provider === CODEX_DRIVER || provider === CLAUDE_AGENT_DRIVER
      ? { readSubagentDetail }
      : {}),
    rollbackThread,
    stopAll,
    get streamEvents() {
      return Stream.fromPubSub(runtimeEventPubSub);
    },
  };

  const emit = (event: LegacyProviderRuntimeEvent): void => {
    Effect.runSync(PubSub.publish(runtimeEventPubSub, event as unknown as ProviderRuntimeEvent));
  };

  const replaceEventStream = (): void => {
    const previous = runtimeEventPubSub;
    runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
    Effect.runSync(PubSub.shutdown(previous));
  };

  const updateSession = (
    threadId: ThreadId,
    update: (session: ProviderSession) => ProviderSession,
  ): void => {
    const existing = sessions.get(threadId);
    if (!existing) {
      return;
    }
    sessions.set(threadId, update(existing));
  };

  return {
    adapter,
    emit,
    updateSession,
    startSession,
    forkSession,
    discardSessionFork,
    sendTurn,
    steerTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    readThread,
    readSubagentDetail,
    rollbackThread,
    stopAll,
    replaceEventStream,
  };
}

const advanceTestClock = (ms: number) =>
  TestClock.adjust(`${ms} millis`).pipe(Effect.andThen(Effect.yieldNow));

const hasMetricSnapshot = (
  snapshots: ReadonlyArray<Metric.Metric.Snapshot>,
  id: string,
  attributes: Readonly<Record<string, string>>,
) =>
  snapshots.some(
    (snapshot) =>
      snapshot.id === id &&
      Object.entries(attributes).every(([key, value]) => snapshot.attributes?.[key] === value),
  );

function makeProviderServiceLayer() {
  const codex = makeFakeCodexAdapter();
  const claude = makeFakeCodexAdapter(CLAUDE_AGENT_DRIVER);
  const testDriver = makeFakeCodexAdapter(TEST_DRIVER);
  const registry = makeAdapterRegistryMock({
    [ProviderDriverKind.make("codex")]: codex.adapter,
    [ProviderDriverKind.make("claudeAgent")]: claude.adapter,
    [TEST_DRIVER]: testDriver.adapter,
  });

  const providerAdapterLayer = Layer.succeed(ProviderAdapterRegistry, registry);
  const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
    Layer.provide(SqlitePersistenceMemory),
  );
  const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));

  let resetRepository:
    | (() => Effect.Effect<void, ProviderSessionRuntimeRepositoryError>)
    | undefined;
  const testLayer = Layer.mergeAll(
    makeProviderServiceLive().pipe(
      Layer.provide(providerAdapterLayer),
      Layer.provide(directoryLayer),
      Layer.provide(defaultServerSettingsLayer),
      Layer.provide(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
    ),
    directoryLayer,

    runtimeRepositoryLayer,
    // Expose the same memoized in-memory SQL client so history-provenance
    // tests can create the projection-thread parent required by migration 64's
    // fail-closed foreign-key fence.
    SqlitePersistenceMemory,
    NodeServices.layer,
  ).pipe(
    Layer.tap((context) =>
      Effect.sync(() => {
        const repository = Context.get(context, ProviderSessionRuntimeRepository);
        resetRepository = () =>
          repository
            .list()
            .pipe(
              Effect.flatMap((entries) =>
                Effect.forEach(
                  entries,
                  (entry) => repository.deleteByThreadId({ threadId: entry.threadId }),
                  { discard: true },
                ),
              ),
            );
      }),
    ),
  );
  const layer = it.layer(testLayer);
  const reset = async () => {
    await Effect.runPromise(
      Effect.all([codex.stopAll(), claude.stopAll(), testDriver.stopAll()], { discard: true }),
    );
    if (resetRepository) {
      await Effect.runPromise(resetRepository());
    }
    vi.clearAllMocks();
  };

  return {
    codex,
    claude,
    testDriver,
    layer,
    reset,
  };
}

it.effect("ProviderServiceLive catches stopAll failures during shutdown", () =>
  Effect.gen(function* () {
    const codex = makeFakeCodexAdapter();
    codex.stopAll.mockImplementation(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: String(CODEX_DRIVER),
          method: "stopAll",
          detail: "simulated stopAll failure",
        }),
      ),
    );
    const registry = makeAdapterRegistryMock({
      [CODEX_DRIVER]: codex.adapter,
    });
    const providerAdapterLayer = Layer.succeed(ProviderAdapterRegistry, registry);
    const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
    const providerLayer = Layer.mergeAll(
      makeProviderServiceLive().pipe(
        Layer.provide(providerAdapterLayer),
        Layer.provide(directoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
      ),
      directoryLayer,
      runtimeRepositoryLayer,
    );
    const scope = yield* Scope.make();
    const runtimeServices = yield* Layer.build(providerLayer).pipe(Scope.provide(scope));

    yield* Effect.gen(function* () {
      yield* ProviderService;
    }).pipe(Effect.provide(runtimeServices));
    const closeExit = yield* Scope.close(scope, Exit.void).pipe(Effect.exit);

    assert.equal(Exit.isSuccess(closeExit), true);
    assert.equal(codex.stopAll.mock.calls.length, 1);
  }),
);

it.effect("ProviderServiceLive persists stopped runtime state before adapter stopAll", () =>
  Effect.gen(function* () {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-provider-stopall-"));
    const dbPath = path.join(tempDir, "orchestration.sqlite");
    const codex = makeFakeCodexAdapter();
    codex.stopAll.mockImplementation(() =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: String(CODEX_DRIVER),
          method: "stopAll",
          detail: "simulated stopAll failure",
        }),
      ),
    );
    const registry = makeAdapterRegistryMock({
      [CODEX_DRIVER]: codex.adapter,
    });
    const providerAdapterLayer = Layer.succeed(ProviderAdapterRegistry, registry);
    const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
      Layer.provide(makeSqlitePersistenceLive(dbPath)),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
    const providerLayer = Layer.mergeAll(
      makeProviderServiceLive().pipe(
        Layer.provide(providerAdapterLayer),
        Layer.provide(directoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
      ),
      directoryLayer,
      runtimeRepositoryLayer,
    );
    const scope = yield* Scope.make();
    const runtimeServices = yield* Layer.build(providerLayer).pipe(Scope.provide(scope));

    const threadId = asThreadId("thread-stopall-before-adapter-failure");
    yield* Effect.gen(function* () {
      const provider = yield* ProviderService;
      const session = yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "full-access",
      });
      yield* provider.sendTurn({
        threadId: session.threadId,
        input: "before shutdown",
        attachments: [],
      });
    }).pipe(Effect.provide(runtimeServices));

    const closeExit = yield* Scope.close(scope, Exit.void).pipe(Effect.exit);
    assert.equal(Exit.isSuccess(closeExit), true);

    const persisted = yield* Effect.gen(function* () {
      const repository = yield* ProviderSessionRuntimeRepository;
      return yield* repository.getByThreadId({ threadId });
    }).pipe(Effect.provide(runtimeRepositoryLayer));

    assert.equal(Option.isSome(persisted), true);
    if (Option.isNone(persisted)) {
      return;
    }

    assert.equal(persisted.value.status, "stopped");
    const runtimePayload = persisted.value.runtimePayload as Record<string, unknown>;
    assert.equal(runtimePayload.activeTurnId, null);
    assert.equal(runtimePayload.lastRuntimeEvent, "provider.stopAll");

    fs.rmSync(tempDir, { recursive: true, force: true });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("ProviderServiceLive stopAll cannot recreate a concurrently retired binding", () =>
  Effect.gen(function* () {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-provider-stopall-delete-race-"));
    const dbPath = path.join(tempDir, "orchestration.sqlite");
    const codex = makeFakeCodexAdapter();
    const registry = makeAdapterRegistryMock({
      [CODEX_DRIVER]: codex.adapter,
    });
    const providerAdapterLayer = Layer.succeed(ProviderAdapterRegistry, registry);
    const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
      Layer.provide(makeSqlitePersistenceLive(dbPath)),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
    const providerLayer = Layer.mergeAll(
      makeProviderServiceLive().pipe(
        Layer.provide(providerAdapterLayer),
        Layer.provide(directoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
      ),
      directoryLayer,
      runtimeRepositoryLayer,
    );
    const scope = yield* Scope.make();
    const runtimeServices = yield* Layer.build(providerLayer).pipe(Scope.provide(scope));
    const threadId = asThreadId("thread-stopall-hard-delete-race");
    const { provider, directory } = yield* Effect.gen(function* () {
      const provider = yield* ProviderService;
      const directory = yield* ProviderSessionDirectory;
      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "full-access",
      });
      return { provider, directory };
    }).pipe(Effect.provide(runtimeServices));
    const staleSessions = yield* codex.listSessions();
    const listStarted = yield* Deferred.make<void>();
    const releaseList = yield* Deferred.make<void>();
    codex.listSessions.mockImplementationOnce(() =>
      Deferred.succeed(listStarted, undefined).pipe(
        Effect.andThen(Deferred.await(releaseList)),
        Effect.as(staleSessions),
      ),
    );

    const closeFiber = yield* Scope.close(scope, Exit.void).pipe(Effect.forkChild);
    yield* Deferred.await(listStarted);
    yield* provider.quiesceThreadForHardDelete({ threadId });
    yield* directory.remove(threadId);
    yield* Deferred.succeed(releaseList, undefined);
    yield* Fiber.join(closeFiber);

    const persisted = yield* Effect.gen(function* () {
      const repository = yield* ProviderSessionRuntimeRepository;
      return yield* repository.getByThreadId({ threadId });
    }).pipe(Effect.provide(runtimeRepositoryLayer));
    assert.isTrue(Option.isNone(persisted));
    fs.rmSync(tempDir, { recursive: true, force: true });
  }).pipe(Effect.provide(NodeServices.layer)),
);

const nativeFork = makeProviderServiceLayer();
nativeFork.layer("ProviderServiceLive native session forks", (it) => {
  beforeEach(nativeFork.reset);

  it.effect("persists an idempotent stopped target binding and discards it safely", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const directory = yield* ProviderSessionDirectory;
      const sourceThreadId = asThreadId("thread-fork-source");
      const targetThreadId = asThreadId("thread-fork-target");
      yield* provider.startSession(sourceThreadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId: sourceThreadId,
        runtimeMode: "full-access",
        cwd: "/repo/native-fork",
      });

      const request = {
        operationId: "cmd-native-fork",
        sourceThreadId,
        targetThreadId,
        title: "Fork target",
      } as const;
      const first = yield* provider.forkSession(request);
      const retry = yield* provider.forkSession(request);

      assert.deepEqual(retry, first);
      assert.equal(nativeFork.codex.forkSession.mock.calls.length, 1);
      const binding = Option.getOrThrow(yield* directory.getBinding(targetThreadId));
      assert.equal(binding.status, "stopped");
      assert.equal(binding.providerInstanceId, codexInstanceId);
      assert.deepEqual(binding.resumeCursor, { opaque: "fork-thread-fork-target" });
      assert.deepInclude(binding.runtimePayload as Record<string, unknown>, {
        forkOperationId: "cmd-native-fork",
        forkedFromThreadId: sourceThreadId,
        cwd: "/repo/native-fork",
      });

      const conflictingExit = yield* provider
        .forkSession({ ...request, operationId: "cmd-competing-fork" })
        .pipe(Effect.exit);
      assert.equal(Exit.isFailure(conflictingExit), true);
      assert.equal(nativeFork.codex.forkSession.mock.calls.length, 1);

      yield* provider.discardSessionFork({ fork: first });
      assert.equal(nativeFork.codex.discardSessionFork.mock.calls.length, 1);
      assert.equal(Option.isNone(yield* directory.getBinding(targetThreadId)), true);
    }),
  );

  it.effect("rejects providers without a native fork contract", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const sourceThreadId = asThreadId("thread-unsupported-fork-source");
      yield* provider.startSession(sourceThreadId, {
        provider: TEST_DRIVER,
        providerInstanceId: ProviderInstanceId.make("testDriver"),
        threadId: sourceThreadId,
        runtimeMode: "full-access",
      });

      const exit = yield* provider
        .forkSession({
          operationId: "cmd-unsupported-fork",
          sourceThreadId,
          targetThreadId: asThreadId("thread-unsupported-fork-target"),
          title: "Unsupported fork",
        })
        .pipe(Effect.exit);
      assert.equal(Exit.isFailure(exit), true);
      assert.equal(nativeFork.testDriver.forkSession.mock.calls.length, 0);
    }),
  );

  it.effect("serializes competing target forks before allocating native context", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const sourceThreadId = asThreadId("thread-fork-race-source");
      const targetThreadId = asThreadId("thread-fork-race-target");
      yield* provider.startSession(sourceThreadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId: sourceThreadId,
        runtimeMode: "full-access",
        cwd: "/repo/fork-race",
      });

      const firstStarted = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      nativeFork.codex.forkSession.mockImplementationOnce((input) =>
        Deferred.succeed(firstStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseFirst)),
          Effect.as({
            operationId: input.operationId,
            sourceThreadId: input.sourceThreadId,
            targetThreadId: input.targetThreadId,
            provider: CODEX_DRIVER,
            providerInstanceId: codexInstanceId,
            runtimeMode: "full-access",
            cwd: "/repo/fork-race",
            resumeCursor: { opaque: "fork-race-target" },
          }),
        ),
      );

      const firstFiber = yield* provider
        .forkSession({
          operationId: "cmd-fork-race-first",
          sourceThreadId,
          targetThreadId,
          title: "First",
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(firstStarted);
      const competingFiber = yield* provider
        .forkSession({
          operationId: "cmd-fork-race-competing",
          sourceThreadId,
          targetThreadId,
          title: "Competing",
        })
        .pipe(Effect.exit, Effect.forkChild);
      yield* Effect.yieldNow;
      assert.equal(nativeFork.codex.forkSession.mock.calls.length, 1);

      yield* Deferred.succeed(releaseFirst, undefined);
      const first = yield* Fiber.join(firstFiber);
      const competingExit = yield* Fiber.join(competingFiber);
      assert.equal(Exit.isFailure(competingExit), true);
      assert.equal(nativeFork.codex.forkSession.mock.calls.length, 1);
      yield* provider.discardSessionFork({ fork: first });
    }),
  );

  it.effect("holds the target lifecycle fence through native fork persistence", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const directory = yield* ProviderSessionDirectory;
      const sourceThreadId = asThreadId("thread-fork-delete-race-source");
      const targetThreadId = asThreadId("thread-fork-delete-race-target");
      yield* provider.startSession(sourceThreadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId: sourceThreadId,
        runtimeMode: "full-access",
      });

      const nativeForkStarted = yield* Deferred.make<void>();
      const releaseNativeFork = yield* Deferred.make<void>();
      nativeFork.codex.forkSession.mockImplementationOnce((input) =>
        Deferred.succeed(nativeForkStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseNativeFork)),
          Effect.as({
            operationId: input.operationId,
            sourceThreadId: input.sourceThreadId,
            targetThreadId: input.targetThreadId,
            provider: CODEX_DRIVER,
            providerInstanceId: codexInstanceId,
            runtimeMode: "full-access",
            resumeCursor: { opaque: "fork-delete-race" },
          }),
        ),
      );

      const forkFiber = yield* provider
        .forkSession({
          operationId: "cmd-fork-delete-race",
          sourceThreadId,
          targetThreadId,
          title: "Fork racing hard delete",
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(nativeForkStarted);

      const quiesceFinished = yield* Deferred.make<void>();
      const quiesceFiber = yield* provider
        .quiesceThreadForHardDelete({ threadId: targetThreadId })
        .pipe(
          Effect.tap(() => Deferred.succeed(quiesceFinished, undefined)),
          Effect.forkChild,
        );
      yield* Effect.yieldNow;
      // The target fence cannot pass the in-flight native allocation; if it
      // did, the delayed target upsert below could resurrect a deleted row.
      assert.isTrue(Option.isNone(yield* Deferred.poll(quiesceFinished)));

      yield* Deferred.succeed(releaseNativeFork, undefined);
      yield* Fiber.join(forkFiber);
      yield* Fiber.join(quiesceFiber);
      yield* directory.remove(targetThreadId);
      assert.isTrue(Option.isNone(yield* directory.getBinding(targetThreadId)));
    }),
  );

  it.effect("deduplicates colliding lifecycle stripes for two-thread forks", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      // These ids collide under ProviderService's bounded FNV-1a stripe map.
      // A two-lock helper that acquired the same semaphore twice would hang.
      const sourceThreadId = asThreadId("thread-stripe-19");
      const targetThreadId = asThreadId("thread-stripe-82");
      yield* provider.startSession(sourceThreadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId: sourceThreadId,
        runtimeMode: "full-access",
      });

      const fork = yield* provider.forkSession({
        operationId: "cmd-colliding-lifecycle-stripes",
        sourceThreadId,
        targetThreadId,
        title: "Colliding lifecycle stripes",
      });

      assert.equal(fork.targetThreadId, targetThreadId);
      assert.equal(nativeFork.codex.forkSession.mock.calls.length, 1);
    }),
  );
});

const restart = makeProviderServiceLayer();
restart.layer("ProviderServiceLive runtime restart", (it) => {
  beforeEach(restart.reset);

  it.effect("stops only the targeted provider instance", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const directory = yield* ProviderSessionDirectory;
      const codexThreadId = asThreadId("thread-codex-restart");
      const claudeThreadId = asThreadId("thread-claude-keep-running");

      yield* provider.startSession(codexThreadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId: codexThreadId,
        runtimeMode: "full-access",
        cwd: "/repo/codex",
      });
      yield* provider.startSession(claudeThreadId, {
        provider: CLAUDE_AGENT_DRIVER,
        providerInstanceId: claudeAgentInstanceId,
        threadId: claudeThreadId,
        runtimeMode: "full-access",
        cwd: "/repo/claude",
      });

      const result = yield* provider.restartProviderRuntime({
        instanceId: codexInstanceId,
      });

      assert.equal(result.instanceId, codexInstanceId);
      assert.equal(result.provider, CODEX_DRIVER);
      assert.equal(result.stoppedSessionCount, 1);
      assert.equal(restart.codex.stopAll.mock.calls.length, 1);
      assert.equal(restart.claude.stopAll.mock.calls.length, 0);

      const remainingSessions = yield* provider.listSessions();
      assert.deepEqual(
        remainingSessions.map((session) => session.threadId),
        [claudeThreadId],
      );

      const codexBinding = Option.getOrThrow(yield* directory.getBinding(codexThreadId));
      assert.equal(codexBinding.status, "stopped");
      assert.equal(codexBinding.providerInstanceId, codexInstanceId);
      assert.deepEqual(codexBinding.resumeCursor, {
        opaque: `resume-${String(codexThreadId)}`,
      });
      assert.equal((codexBinding.runtimePayload as { activeTurnId?: unknown }).activeTurnId, null);
      assert.equal(
        (codexBinding.runtimePayload as { lastRuntimeEvent?: unknown }).lastRuntimeEvent,
        "provider.runtime.restart",
      );

      const claudeBinding = Option.getOrThrow(yield* directory.getBinding(claudeThreadId));
      assert.equal(claudeBinding.status, "running");
    }),
  );

  it.effect("does not recreate a retired binding from a stale restart snapshot", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const directory = yield* ProviderSessionDirectory;
      const threadId = asThreadId("thread-restart-hard-delete-race");
      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "full-access",
      });
      const staleSessions = yield* restart.codex.listSessions();
      const listStarted = yield* Deferred.make<void>();
      const releaseList = yield* Deferred.make<void>();
      restart.codex.listSessions.mockImplementationOnce(() =>
        Deferred.succeed(listStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseList)),
          Effect.as(staleSessions),
        ),
      );

      const restartFiber = yield* provider
        .restartProviderRuntime({ instanceId: codexInstanceId })
        .pipe(Effect.forkChild);
      yield* Deferred.await(listStarted);
      yield* provider.quiesceThreadForHardDelete({ threadId });
      yield* directory.remove(threadId);

      // The restart observed the session before retirement, but every delayed
      // binding write must re-check the lifecycle fence under its permit.
      yield* Deferred.succeed(releaseList, undefined);
      yield* Fiber.join(restartFiber);
      assert.isTrue(Option.isNone(yield* directory.getBinding(threadId)));
    }),
  );
});

it.effect("ProviderServiceLive rejects new sessions for disabled providers", () =>
  Effect.gen(function* () {
    const codex = makeFakeCodexAdapter();
    const claude = makeFakeCodexAdapter(CLAUDE_AGENT_DRIVER);
    const registryBase = makeAdapterRegistryMock({
      [CODEX_DRIVER]: codex.adapter,
      [CLAUDE_AGENT_DRIVER]: claude.adapter,
    });
    const registry: ProviderAdapterRegistryShape = {
      ...registryBase,
      getInstanceInfo: (instanceId) =>
        instanceId === claudeAgentInstanceId
          ? Effect.succeed({
              instanceId,
              driverKind: CLAUDE_AGENT_DRIVER,
              displayName: undefined,
              enabled: false,
              continuationIdentity: {
                driverKind: CLAUDE_AGENT_DRIVER,
                continuationKey: "claudeAgent:instance:claudeAgent",
              },
            })
          : registryBase.getInstanceInfo(instanceId),
    };
    const providerAdapterLayer = Layer.succeed(ProviderAdapterRegistry, registry);
    const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
    const providerLayer = makeProviderServiceLive().pipe(
      Layer.provide(providerAdapterLayer),
      Layer.provide(directoryLayer),
      Layer.provide(defaultServerSettingsLayer),
      Layer.provide(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
    );

    const failure = yield* Effect.flip(
      Effect.gen(function* () {
        const provider = yield* ProviderService;
        return yield* provider.startSession(asThreadId("thread-disabled"), {
          provider: ProviderDriverKind.make("claudeAgent"),
          providerInstanceId: claudeAgentInstanceId,
          threadId: asThreadId("thread-disabled"),
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(providerLayer)),
    );

    assert.instanceOf(failure, ProviderValidationError);
    assert.include(failure.issue, "Provider instance 'claudeAgent' is disabled");
    assert.equal(claude.startSession.mock.calls.length, 0);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "ProviderServiceLive allows enabled custom instances when legacy driver is disabled",
  () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("codex_personal");
      const driverKind = CODEX_DRIVER;
      const codex = makeFakeCodexAdapter();
      const unsupported = () =>
        new ProviderUnsupportedError({
          provider: driverKind,
        });
      const registry: ProviderAdapterRegistryShape = {
        getByInstance: (requestedInstanceId) =>
          requestedInstanceId === instanceId
            ? Effect.succeed(codex.adapter)
            : Effect.fail(unsupported()),
        getInstanceInfo: (requestedInstanceId) =>
          requestedInstanceId === instanceId
            ? Effect.succeed({
                instanceId,
                driverKind,
                displayName: "Codex Personal",
                enabled: true,
                continuationIdentity: {
                  driverKind,
                  continuationKey: "codex:/Users/example/.codex",
                },
              })
            : Effect.fail(unsupported()),
        listInstances: () => Effect.succeed([instanceId]),
        listProviders: () => Effect.succeed([driverKind] as const),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
          PubSub.subscribe(pubsub),
        ),
      };
      const providerAdapterLayer = Layer.succeed(ProviderAdapterRegistry, registry);
      const serverSettingsLayer = ServerSettingsService.layerTest({
        providers: {
          codex: {
            enabled: false,
          },
        },
      });
      const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
        Layer.provide(SqlitePersistenceMemory),
      );
      const directoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const providerLayer = makeProviderServiceLive().pipe(
        Layer.provide(providerAdapterLayer),
        Layer.provide(directoryLayer),
        Layer.provide(serverSettingsLayer),
        Layer.provide(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
      );

      const session = yield* Effect.gen(function* () {
        const provider = yield* ProviderService;
        return yield* provider.startSession(asThreadId("thread-enabled-custom"), {
          provider: driverKind,
          providerInstanceId: instanceId,
          threadId: asThreadId("thread-enabled-custom"),
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(providerLayer));

      assert.equal(session.providerInstanceId, instanceId);
      assert.equal(codex.startSession.mock.calls.length, 1);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("ProviderServiceLive rejects new sessions for disabled custom instances", () =>
  Effect.gen(function* () {
    const instanceId = ProviderInstanceId.make("codex_personal");
    const driverKind = ProviderDriverKind.make("codex");
    const codex = makeFakeCodexAdapter();
    const unsupported = () =>
      new ProviderUnsupportedError({
        provider: ProviderDriverKind.make("codex"),
      });
    const registry: ProviderAdapterRegistryShape = {
      getByInstance: (requestedInstanceId) =>
        requestedInstanceId === instanceId
          ? Effect.succeed(codex.adapter)
          : Effect.fail(unsupported()),
      getInstanceInfo: (requestedInstanceId) =>
        requestedInstanceId === instanceId
          ? Effect.succeed({
              instanceId,
              driverKind,
              displayName: "Codex Personal",
              enabled: false,
              continuationIdentity: {
                driverKind,
                continuationKey: "codex:/Users/example/.codex",
              },
            })
          : Effect.fail(unsupported()),
      listInstances: () => Effect.succeed([instanceId]),
      listProviders: () => Effect.succeed([CODEX_DRIVER] as const),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) =>
        PubSub.subscribe(pubsub),
      ),
    };
    const providerAdapterLayer = Layer.succeed(ProviderAdapterRegistry, registry);
    const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
    const providerLayer = makeProviderServiceLive().pipe(
      Layer.provide(providerAdapterLayer),
      Layer.provide(directoryLayer),
      Layer.provide(defaultServerSettingsLayer),
      Layer.provide(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
    );

    const failure = yield* Effect.flip(
      Effect.gen(function* () {
        const provider = yield* ProviderService;
        return yield* provider.startSession(asThreadId("thread-disabled-instance"), {
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: instanceId,
          threadId: asThreadId("thread-disabled-instance"),
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(providerLayer)),
    );

    assert.instanceOf(failure, ProviderValidationError);
    assert.include(failure.issue, "Provider instance 'codex_personal' is disabled");
    assert.equal(codex.startSession.mock.calls.length, 0);
  }).pipe(Effect.provide(NodeServices.layer)),
);

const routing = makeProviderServiceLayer();

it.effect("ProviderServiceLive writes canonical events to the emitting thread segment", () =>
  Effect.gen(function* () {
    const codex = makeFakeCodexAdapter();
    const canonicalEvents: ProviderRuntimeEvent[] = [];
    const canonicalThreadIds: Array<string | null> = [];
    const registry = makeAdapterRegistryMock({
      [ProviderDriverKind.make("codex")]: codex.adapter,
    });
    const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));
    const providerLayer = makeProviderServiceLive({
      canonicalEventLogger: {
        filePath: "memory://provider-canonical-events",
        write: (event, threadId) => {
          canonicalEvents.push(event as ProviderRuntimeEvent);
          canonicalThreadIds.push(threadId ?? null);
          return Effect.void;
        },
        close: () => Effect.void,
      },
    }).pipe(
      Layer.provide(Layer.succeed(ProviderAdapterRegistry, registry)),
      Layer.provide(directoryLayer),
      Layer.provide(defaultServerSettingsLayer),
      Layer.provide(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
    );

    yield* Effect.gen(function* () {
      yield* ProviderService;
      yield* advanceTestClock(10);
      codex.emit({
        eventId: asEventId("evt-canonical-thread-segment"),
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-canonical-thread-segment"),
        createdAt: "2026-01-01T00:00:00.000Z",
        type: "turn.completed",
        payload: {
          state: "completed",
        },
      });
      yield* advanceTestClock(20);
    }).pipe(Effect.provide(providerLayer));

    assert.equal(canonicalEvents.length, 1);
    assert.equal(canonicalEvents[0]?.threadId, "thread-canonical-thread-segment");
    assert.deepEqual(canonicalThreadIds, ["thread-canonical-thread-segment"]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("ProviderServiceLive keeps persisted resumable sessions on startup", () =>
  Effect.gen(function* () {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-provider-service-"));
    const dbPath = path.join(tempDir, "orchestration.sqlite");

    const codex = makeFakeCodexAdapter();
    const registry = makeAdapterRegistryMock({
      [ProviderDriverKind.make("codex")]: codex.adapter,
    });

    const persistenceLayer = makeSqlitePersistenceLive(dbPath);
    const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
      Layer.provide(persistenceLayer),
    );
    const directoryLayer = ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepositoryLayer));

    yield* Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      yield* directory.upsert({
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: ThreadId.make("thread-stale"),
      });
    }).pipe(Effect.provide(directoryLayer));

    const providerLayer = makeProviderServiceLive().pipe(
      Layer.provide(Layer.succeed(ProviderAdapterRegistry, registry)),
      Layer.provide(directoryLayer),
      Layer.provide(defaultServerSettingsLayer),
      Layer.provide(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
    );

    yield* Effect.gen(function* () {
      yield* ProviderService;
    }).pipe(Effect.provide(providerLayer));

    const persistedProvider = yield* Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      return yield* directory.getProvider(asThreadId("thread-stale"));
    }).pipe(Effect.provide(directoryLayer));
    assert.equal(persistedProvider, "codex");

    const runtime = yield* Effect.gen(function* () {
      const repository = yield* ProviderSessionRuntimeRepository;
      return yield* repository.getByThreadId({
        threadId: asThreadId("thread-stale"),
      });
    }).pipe(Effect.provide(runtimeRepositoryLayer));
    assert.equal(Option.isSome(runtime), true);

    const legacyTableRows = yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name = 'provider_sessions'
      `;
    }).pipe(Effect.provide(persistenceLayer));
    assert.equal(legacyTableRows.length, 0);

    fs.rmSync(tempDir, { recursive: true, force: true });
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "ProviderServiceLive restores rollback routing after restart using persisted thread mapping",
  () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-provider-service-restart-"));
      const dbPath = path.join(tempDir, "orchestration.sqlite");
      const persistenceLayer = makeSqlitePersistenceLive(dbPath);
      const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
        Layer.provide(persistenceLayer),
      );

      const firstCodex = makeFakeCodexAdapter();
      const firstRegistry = makeAdapterRegistryMock({
        [ProviderDriverKind.make("codex")]: firstCodex.adapter,
      });

      const firstDirectoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const firstProviderLayer = makeProviderServiceLive().pipe(
        Layer.provide(Layer.succeed(ProviderAdapterRegistry, firstRegistry)),
        Layer.provide(firstDirectoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
      );
      const updatedResumeCursor = {
        threadId: asThreadId("thread-1"),
        resume: "resume-session-1",
        resumeSessionAt: "assistant-message-1",
        turnCount: 1,
      };

      const startedSession = yield* Effect.gen(function* () {
        const provider = yield* ProviderService;
        const threadId = asThreadId("thread-1");
        const session = yield* provider.startSession(threadId, {
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          cwd: "/tmp/project",
          runtimeMode: "full-access",
          threadId,
        });
        firstCodex.updateSession(threadId, (existing) => ({
          ...existing,
          status: "ready",
          resumeCursor: updatedResumeCursor,
          updatedAt: "2026-01-01T00:00:01.000Z",
        }));
        return session;
      }).pipe(Effect.provide(firstProviderLayer));

      const persistedAfterStopAll = yield* Effect.gen(function* () {
        const repository = yield* ProviderSessionRuntimeRepository;
        return yield* repository.getByThreadId({
          threadId: startedSession.threadId,
        });
      }).pipe(Effect.provide(runtimeRepositoryLayer));
      assert.equal(Option.isSome(persistedAfterStopAll), true);
      if (Option.isSome(persistedAfterStopAll)) {
        assert.equal(persistedAfterStopAll.value.status, "stopped");
        assert.deepEqual(persistedAfterStopAll.value.resumeCursor, updatedResumeCursor);
      }

      const secondCodex = makeFakeCodexAdapter();
      const secondRegistry = makeAdapterRegistryMock({
        [ProviderDriverKind.make("codex")]: secondCodex.adapter,
      });
      const secondDirectoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const secondProviderLayer = makeProviderServiceLive().pipe(
        Layer.provide(Layer.succeed(ProviderAdapterRegistry, secondRegistry)),
        Layer.provide(secondDirectoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
      );

      secondCodex.startSession.mockClear();
      secondCodex.rollbackThread.mockClear();

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService;
        yield* provider.rollbackConversation({
          threadId: startedSession.threadId,
          numTurns: 1,
        });
      }).pipe(Effect.provide(secondProviderLayer));

      assert.equal(secondCodex.startSession.mock.calls.length, 1);
      const resumedStartInput = secondCodex.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "codex");
        assert.equal(startPayload.cwd, "/tmp/project");
        assert.deepEqual(startPayload.resumeCursor, updatedResumeCursor);
        assert.equal(startPayload.threadId, startedSession.threadId);
      }
      assert.equal(secondCodex.rollbackThread.mock.calls.length, 1);
      const rollbackCall = secondCodex.rollbackThread.mock.calls[0];
      assert.equal(typeof rollbackCall?.[0], "string");
      assert.equal(rollbackCall?.[1], 1);

      fs.rmSync(tempDir, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
);

routing.layer("ProviderServiceLive routing", (it) => {
  beforeEach(routing.reset);

  it.effect("routes provider operations and rollback conversation", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;

      const session = yield* provider.startSession(asThreadId("thread-1"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-1"),
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });
      assert.equal(session.provider, "codex");

      const sessions = yield* provider.listSessions();
      assert.equal(sessions.length, 1);

      yield* provider.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });
      assert.equal(routing.codex.sendTurn.mock.calls.length, 1);

      yield* provider.interruptTurn({ threadId: session.threadId });
      assert.deepEqual(routing.codex.interruptTurn.mock.calls, [[session.threadId, undefined]]);

      yield* provider.respondToRequest({
        threadId: session.threadId,
        requestId: asRequestId("req-1"),
        decision: "accept",
      });
      assert.deepEqual(routing.codex.respondToRequest.mock.calls, [
        [session.threadId, asRequestId("req-1"), "accept"],
      ]);

      yield* provider.respondToUserInput({
        threadId: session.threadId,
        requestId: asRequestId("req-user-input-1"),
        answers: {
          sandbox_mode: "workspace-write",
        },
      });
      assert.deepEqual(routing.codex.respondToUserInput.mock.calls, [
        [
          session.threadId,
          asRequestId("req-user-input-1"),
          {
            sandbox_mode: "workspace-write",
          },
        ],
      ]);

      yield* provider.rollbackConversation({
        threadId: session.threadId,
        numTurns: 0,
      });

      yield* provider.stopSession({ threadId: session.threadId });
      routing.codex.startSession.mockClear();
      routing.codex.sendTurn.mockClear();

      yield* provider.sendTurn({
        threadId: session.threadId,
        input: "after-stop",
        attachments: [],
      });

      assert.equal(routing.codex.startSession.mock.calls.length, 1);
      const resumedStartInput = routing.codex.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "codex");
        assert.equal(startPayload.cwd, "/tmp/project");
        assert.deepEqual(startPayload.resumeCursor, session.resumeCursor);
        assert.equal(startPayload.threadId, session.threadId);
      }
      assert.equal(routing.codex.sendTurn.mock.calls.length, 1);
    }),
  );

  it.effect(
    "routes direct Codex sendTurn through steer while the adapter owns an active turn",
    () =>
      Effect.gen(function* () {
        const provider = yield* ProviderService;
        const runtimeRepository = yield* ProviderSessionRuntimeRepository;

        const session = yield* provider.startSession(asThreadId("thread-active"), {
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          threadId: asThreadId("thread-active"),
          cwd: "/tmp/project",
          runtimeMode: "full-access",
        });
        routing.codex.updateSession(session.threadId, (current) => ({
          ...current,
          status: "running",
          activeTurnId: asTurnId("turn-active"),
        }));
        routing.codex.sendTurn.mockClear();
        routing.codex.steerTurn.mockClear();
        const messageId = MessageId.make("message-active-steer");
        const clientCorrelationId =
          "cafe-steer-v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        routing.codex.steerTurn.mockImplementationOnce((input) =>
          Effect.succeed({
            threadId: input.threadId,
            turnId: input.expectedTurnId,
            clientCorrelationId,
          }),
        );

        const turn = yield* provider.sendTurn({
          threadId: session.threadId,
          messageId,
          input: "this must be steered or queued",
          attachments: [],
        });

        assert.equal(turn.turnId, asTurnId("turn-active"));
        assert.equal(turn.clientCorrelationId, clientCorrelationId);
        assert.equal(routing.codex.sendTurn.mock.calls.length, 0);
        assert.equal(routing.codex.steerTurn.mock.calls.length, 1);
        assert.deepEqual(routing.codex.steerTurn.mock.calls[0]?.[0], {
          threadId: session.threadId,
          expectedTurnId: asTurnId("turn-active"),
          messageId,
          input: "this must be steered or queued",
        });

        const runningRuntime = yield* runtimeRepository.getByThreadId({
          threadId: session.threadId,
        });
        assert.equal(Option.isSome(runningRuntime), true);
        if (Option.isSome(runningRuntime)) {
          const payload = runningRuntime.value.runtimePayload;
          assert.equal(payload !== null && typeof payload === "object", true);
          if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
            const runtimePayload = payload as {
              activeTurnId: string | null;
              lastRuntimeEvent: string | null;
            };
            assert.equal(runtimePayload.activeTurnId, "turn-active");
            assert.equal(runtimePayload.lastRuntimeEvent, "provider.steerTurn");
          }
        }
      }),
  );

  it.effect("does not retarget a terminal-recovery send through a concurrently active turn", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const threadId = asThreadId("thread-terminal-recovery-no-steer-fallback");
      const session = yield* provider.startSession(threadId, {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });
      routing.codex.updateSession(session.threadId, (current) => ({
        ...current,
        status: "running",
        activeTurnId: asTurnId("turn-newer"),
      }));
      routing.codex.sendTurn.mockClear();
      routing.codex.steerTurn.mockClear();
      const messageId = MessageId.make("message-terminal-recovery");

      const turn = yield* provider.sendTurn({
        threadId: session.threadId,
        messageId,
        allowActiveTurnSteerFallback: false,
        input: "deliver only as the next turn",
        attachments: [],
      });

      assert.equal(turn.turnId, asTurnId(`turn-${String(threadId)}`));
      assert.equal(routing.codex.steerTurn.mock.calls.length, 0);
      assert.equal(routing.codex.sendTurn.mock.calls.length, 1);
      assert.deepEqual(routing.codex.sendTurn.mock.calls[0]?.[0], {
        threadId,
        messageId,
        allowActiveTurnSteerFallback: false,
        input: "deliver only as the next turn",
        attachments: [],
      });
    }),
  );

  it.effect(
    "routes direct Claude sendTurn into its queued follow-up path while a turn is active",
    () =>
      Effect.gen(function* () {
        const provider = yield* ProviderService;

        const session = yield* provider.startSession(asThreadId("thread-claude-active"), {
          provider: CLAUDE_AGENT_DRIVER,
          providerInstanceId: claudeAgentInstanceId,
          threadId: asThreadId("thread-claude-active"),
          cwd: "/tmp/project",
          runtimeMode: "full-access",
        });
        routing.claude.updateSession(session.threadId, (current) => ({
          ...current,
          status: "running",
          activeTurnId: asTurnId("turn-claude-active"),
        }));
        routing.claude.sendTurn.mockClear();
        routing.claude.steerTurn.mockClear();

        const turn = yield* provider.sendTurn({
          threadId: session.threadId,
          input: "queue this without interrupting Claude",
          attachments: [],
        });

        assert.equal(turn.turnId, asTurnId("turn-claude-active"));
        assert.equal(routing.claude.sendTurn.mock.calls.length, 0);
        assert.equal(routing.claude.steerTurn.mock.calls.length, 1);
        assert.deepEqual(routing.claude.steerTurn.mock.calls[0]?.[0], {
          threadId: session.threadId,
          expectedTurnId: asTurnId("turn-claude-active"),
          input: "queue this without interrupting Claude",
        });
      }),
  );

  it.effect("recovers stale persisted sessions for rollback by resuming thread identity", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;

      const initial = yield* provider.startSession(asThreadId("thread-1"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-1"),
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });
      yield* routing.codex.stopSession(initial.threadId);
      routing.codex.startSession.mockClear();
      routing.codex.rollbackThread.mockClear();

      yield* provider.rollbackConversation({
        threadId: initial.threadId,
        numTurns: 1,
      });

      assert.equal(routing.codex.startSession.mock.calls.length, 1);
      const resumedStartInput = routing.codex.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "codex");
        assert.equal(startPayload.cwd, "/tmp/project");
        assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
        assert.equal(startPayload.threadId, initial.threadId);
      }
      assert.equal(routing.codex.rollbackThread.mock.calls.length, 1);
      const rollbackCall = routing.codex.rollbackThread.mock.calls[0];
      assert.equal(rollbackCall?.[1], 1);
    }),
  );

  it.effect("reads ended Codex detail through immutable provenance after a Claude switch", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;
      const sql = yield* SqlClient.SqlClient;
      const threadId = asThreadId("thread-subagent-detail-recovery");
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, branch, worktree_path,
          latest_turn_id, created_at, updated_at
        ) VALUES (
          ${threadId}, 'project-subagent-detail-recovery', 'Subagent detail recovery',
          NULL, NULL, NULL,
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        )
      `;
      const codexSession = yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/project-subagent-detail",
        runtimeMode: "full-access",
      });
      const { turnId } = yield* provider.sendTurn({
        threadId,
        input: "Run completed child",
        attachments: [],
      });
      routing.codex.emit({
        type: "task.started",
        eventId: asEventId("event-subagent-detail-recovery"),
        provider: CODEX_DRIVER,
        createdAt: "2026-01-01T00:00:01.000Z",
        threadId,
        turnId,
        payload: {
          taskId: "provider-child-completed",
          taskType: "subagent",
          description: "Read completed child history",
          subagent: { threadId: "provider-child-completed", status: "completed" },
        },
      });
      yield* advanceTestClock(50);
      yield* provider.stopSession({ threadId });
      // Replace the mutable root binding before reading the ended child. The
      // detail call must still route through the immutable Codex provenance
      // captured with the lifecycle event, never through current Claude state.
      yield* provider.startSession(threadId, {
        provider: CLAUDE_AGENT_DRIVER,
        providerInstanceId: claudeAgentInstanceId,
        threadId,
        cwd: "/tmp/project-after-provider-switch",
        runtimeMode: "full-access",
      });
      const persistedBeforeRead = yield* runtimeRepository.getByThreadId({ threadId });
      routing.codex.startSession.mockClear();
      routing.codex.readSubagentDetail.mockClear();
      routing.claude.readSubagentDetail.mockClear();
      const rootToJsonSentinel = "provider-service-root-to-json-must-not-cross";
      const nestedToJsonSentinel = "provider-service-message-to-json-must-not-cross";
      const privateFieldSentinel = "provider-service-private-field-must-not-cross";
      const providerOwnedDetail = {
        messages: [
          {
            key: "m0",
            role: "user" as const,
            text: "Assignment for provider-child-completed",
            privateProviderField: privateFieldSentinel,
            toJSON: () => ({ leaked: nestedToJsonSentinel }),
          },
          { key: "m1", role: "assistant" as const, text: "Completed safely." },
        ],
        gaps: [],
        truncated: false,
        privateProviderField: privateFieldSentinel,
        toJSON: () => ({ leaked: rootToJsonSentinel }),
      };
      routing.codex.readSubagentDetail.mockImplementationOnce(() =>
        Effect.succeed(providerOwnedDetail),
      );

      const detail = yield* provider.readSubagentDetail({
        threadId,
        turnId,
        subagentId: "provider-child-completed",
      });

      assert.equal(detail.provider, CODEX_DRIVER);
      assert.equal(detail.providerInstanceId, codexInstanceId);
      assert.deepEqual(detail.messages, [
        { key: "m0", role: "user", text: "Assignment for provider-child-completed" },
        { key: "m1", role: "assistant", text: "Completed safely." },
      ]);
      assert.deepEqual(detail.gaps, []);
      assert.equal(detail.truncated, false);
      const serializedDetail = JSON.stringify(detail);
      assert.notInclude(serializedDetail, rootToJsonSentinel);
      assert.notInclude(serializedDetail, nestedToJsonSentinel);
      assert.notInclude(serializedDetail, privateFieldSentinel);
      assert.equal("toJSON" in detail, false);
      assert.equal(detail.messages[0] === undefined || "toJSON" in detail.messages[0], false);
      assert.equal(routing.codex.startSession.mock.calls.length, 0);
      assert.deepEqual(routing.codex.readSubagentDetail.mock.calls[0], [
        threadId,
        "provider-child-completed",
        {
          resumeCursor: codexSession.resumeCursor,
          cwd: "/tmp/project-subagent-detail",
        },
      ]);
      assert.equal(routing.claude.readSubagentDetail.mock.calls.length, 0);

      const invalidDetailSentinel = "invalid-provider-detail-must-not-cross-service";
      routing.codex.readSubagentDetail.mockImplementationOnce(() =>
        Effect.succeed({
          messages: [
            { key: "duplicate", role: "user", text: invalidDetailSentinel },
            { key: "duplicate", role: "assistant", text: "duplicate key" },
          ],
          gaps: [],
          truncated: false,
        }),
      );
      const invalidDetailError = yield* provider
        .readSubagentDetail({
          threadId,
          turnId,
          subagentId: "provider-child-completed",
        })
        .pipe(Effect.flip);
      assert.equal(invalidDetailError._tag, "ProviderSubagentDetailReadError");
      if (invalidDetailError._tag === "ProviderSubagentDetailReadError") {
        assert.equal(invalidDetailError.reason, "provider-response-invalid");
      }
      assert.notInclude(JSON.stringify(invalidDetailError), invalidDetailSentinel);
      assert.deepEqual(yield* runtimeRepository.getByThreadId({ threadId }), persistedBeforeRead);
    }),
  );

  it.effect("never starts a root session or overwrites its binding when history read fails", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;
      const sql = yield* SqlClient.SqlClient;
      const threadId = asThreadId("thread-subagent-detail-rejected-resume");
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, branch, worktree_path,
          latest_turn_id, created_at, updated_at
        ) VALUES (
          ${threadId}, 'project-subagent-detail-rejected-resume', 'Rejected subagent detail',
          NULL, NULL, NULL,
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        )
      `;
      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/project-subagent-detail-rejected-resume",
        runtimeMode: "full-access",
      });
      const { turnId } = yield* provider.sendTurn({
        threadId,
        input: "Run child with rejected history",
        attachments: [],
      });
      routing.codex.emit({
        type: "task.started",
        eventId: asEventId("event-subagent-detail-rejected-resume"),
        provider: CODEX_DRIVER,
        createdAt: "2026-01-01T00:00:02.000Z",
        threadId,
        turnId,
        payload: {
          taskId: "provider-child-ended",
          taskType: "subagent",
          description: "Read rejected child history",
          subagent: { threadId: "provider-child-ended", status: "completed" },
        },
      });
      yield* advanceTestClock(50);
      yield* provider.stopSession({ threadId });
      const persistedBeforeRead = yield* runtimeRepository.getByThreadId({ threadId });
      routing.codex.startSession.mockClear();
      routing.codex.readSubagentDetail.mockClear();
      routing.codex.readSubagentDetail.mockImplementationOnce(() =>
        Effect.fail(makeProviderSubagentDetailReadError("root-thread-unavailable")),
      );

      const exit = yield* provider
        .readSubagentDetail({
          threadId,
          turnId,
          subagentId: "provider-child-ended",
        })
        .pipe(Effect.exit);

      assert.equal(Exit.isFailure(exit), true);
      assert.equal(routing.codex.startSession.mock.calls.length, 0);
      assert.equal(routing.codex.readSubagentDetail.mock.calls.length, 1);
      assert.deepEqual(yield* runtimeRepository.getByThreadId({ threadId }), persistedBeforeRead);
    }),
  );

  it.effect("fails closed when one turn reports conflicting immutable history roots", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const directory = yield* ProviderSessionDirectory;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;
      const sql = yield* SqlClient.SqlClient;
      const threadId = asThreadId("thread-conflicting-subagent-history-root");
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, branch, worktree_path,
          latest_turn_id, created_at, updated_at
        ) VALUES (
          ${threadId}, 'project-conflicting-subagent-history-root',
          'Conflicting subagent history root', NULL, NULL, NULL,
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        )
      `;
      const session = yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/original-history-root",
        runtimeMode: "full-access",
      });
      const { turnId } = yield* provider.sendTurn({
        threadId,
        input: "run children from one immutable root",
        attachments: [],
      });
      routing.codex.emit({
        type: "task.started",
        eventId: asEventId("event-original-subagent-history-root"),
        provider: CODEX_DRIVER,
        createdAt: "2026-01-01T00:00:01.000Z",
        threadId,
        turnId,
        payload: {
          taskId: "child-original-root",
          taskType: "subagent",
          description: "Original rooted child",
          subagent: { threadId: "child-original-root", status: "active" },
        },
      });
      yield* advanceTestClock(50);

      assert.equal(
        Option.isSome(
          yield* runtimeRepository.getSubagentHistoryBinding({
            threadId,
            turnId,
            subagentId: "child-original-root",
            historyId: null,
          }),
        ),
        true,
      );

      // Simulate a corrupted/replaced live binding without changing the Cafe
      // turn. The lifecycle event remains observable, but its child must not
      // inherit or replace the first root's private routing provenance.
      yield* directory.upsert({
        threadId,
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        resumeCursor: { threadId: "provider-root-conflict" },
        runtimePayload: { cwd: "/tmp/conflicting-history-root" },
      });
      routing.codex.emit({
        type: "task.started",
        eventId: asEventId("event-conflicting-subagent-history-root"),
        provider: CODEX_DRIVER,
        createdAt: "2026-01-01T00:00:02.000Z",
        threadId,
        turnId,
        payload: {
          taskId: "child-conflicting-root",
          taskType: "subagent",
          description: "Conflicting rooted child",
          subagent: { threadId: "child-conflicting-root", status: "active" },
        },
      });
      yield* advanceTestClock(50);

      assert.equal(
        Option.isNone(
          yield* runtimeRepository.getSubagentHistoryBinding({
            threadId,
            turnId,
            subagentId: "child-conflicting-root",
            historyId: null,
          }),
        ),
        true,
      );
      const original = yield* runtimeRepository.getSubagentHistoryBinding({
        threadId,
        turnId,
        subagentId: "child-original-root",
        historyId: null,
      });
      assert.equal(Option.isSome(original), true);
      if (Option.isSome(original)) {
        assert.deepEqual(original.value.resumeCursor, session.resumeCursor);
        assert.equal(original.value.cwd, "/tmp/original-history-root");
      }
    }),
  );

  it.effect("routes provider-neutral Claude detail with exact history identity and cwd", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const sql = yield* SqlClient.SqlClient;
      const threadId = asThreadId("thread-claude-subagent-detail");
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, branch, worktree_path,
          latest_turn_id, created_at, updated_at
        ) VALUES (
          ${threadId}, 'project-claude-subagent-detail', 'Claude subagent detail',
          NULL, NULL, NULL,
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        )
      `;
      const session = yield* provider.startSession(threadId, {
        provider: CLAUDE_AGENT_DRIVER,
        providerInstanceId: claudeAgentInstanceId,
        threadId,
        cwd: "/tmp/project-claude-detail",
        runtimeMode: "full-access",
      });
      const { turnId } = yield* provider.sendTurn({
        threadId,
        input: "Run Claude child",
        attachments: [],
      });
      routing.claude.emit({
        type: "task.progress",
        eventId: asEventId("event-claude-subagent-detail"),
        provider: CLAUDE_AGENT_DRIVER,
        createdAt: "2026-01-01T00:00:03.000Z",
        threadId,
        turnId,
        payload: {
          taskId: "claude-task-1",
          description: "Reading Claude child history",
          subagent: {
            threadId: "claude-task-1",
            historyId: "claude-agent-1",
            status: "active",
          },
        },
      });
      yield* advanceTestClock(50);
      routing.claude.readSubagentDetail.mockClear();

      const detail = yield* provider.readSubagentDetail({
        threadId,
        turnId,
        subagentId: "claude-task-1",
        historyId: "claude-agent-1",
      });
      assert.equal(detail.provider, CLAUDE_AGENT_DRIVER);
      assert.equal(detail.providerInstanceId, claudeAgentInstanceId);
      assert.deepEqual(detail.messages, [
        { key: "m0", role: "user", text: "Assignment for claude-task-1" },
        { key: "m1", role: "assistant", text: "Completed safely." },
      ]);
      assert.deepEqual(detail.gaps, []);
      assert.deepEqual(routing.claude.readSubagentDetail.mock.calls[0], [
        threadId,
        "claude-task-1",
        {
          resumeCursor: session.resumeCursor,
          cwd: "/tmp/project-claude-detail",
          historyId: "claude-agent-1",
        },
      ]);
    }),
  );

  it.effect("rejects subagent detail reads for adapters without a verified child protocol", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const threadId = asThreadId("thread-unsupported-subagent-detail");
      yield* provider.startSession(threadId, {
        provider: TEST_DRIVER,
        providerInstanceId: ProviderInstanceId.make("testDriver"),
        threadId,
        cwd: "/tmp/project-unsupported-detail",
        runtimeMode: "full-access",
      });

      const { turnId } = yield* provider.sendTurn({
        threadId,
        input: "Run unsupported child",
        attachments: [],
      });
      routing.testDriver.emit({
        type: "task.started",
        eventId: asEventId("event-unsupported-subagent-detail"),
        provider: TEST_DRIVER,
        createdAt: "2026-01-01T00:00:04.000Z",
        threadId,
        turnId,
        payload: {
          taskId: "opaque-child",
          taskType: "subagent",
          description: "Unsupported child",
          subagent: { threadId: "opaque-child", status: "active" },
        },
      });
      yield* advanceTestClock(50);

      const result = yield* provider
        .readSubagentDetail({ threadId, turnId, subagentId: "opaque-child" })
        .pipe(Effect.exit);
      assert.equal(Exit.isFailure(result), true);
    }),
  );

  it.effect("preserves the persisted binding when stopping a session", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;

      const initial = yield* provider.startSession(asThreadId("thread-reap-preserve"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-reap-preserve"),
        cwd: "/tmp/project-reap-preserve",
        runtimeMode: "full-access",
      });

      yield* provider.stopSession({ threadId: initial.threadId });

      const persistedAfterStop = yield* runtimeRepository.getByThreadId({
        threadId: initial.threadId,
      });
      assert.equal(Option.isSome(persistedAfterStop), true);
      if (Option.isSome(persistedAfterStop)) {
        assert.equal(persistedAfterStop.value.status, "stopped");
        assert.deepEqual(persistedAfterStop.value.resumeCursor, initial.resumeCursor);
      }

      routing.codex.startSession.mockClear();
      routing.codex.sendTurn.mockClear();

      yield* provider.sendTurn({
        threadId: initial.threadId,
        input: "resume after reap",
        attachments: [],
      });

      assert.equal(routing.codex.startSession.mock.calls.length, 1);
      const resumedStartInput = routing.codex.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "codex");
        assert.equal(startPayload.cwd, "/tmp/project-reap-preserve");
        assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
        assert.equal(startPayload.threadId, initial.threadId);
      }
      assert.equal(routing.codex.sendTurn.mock.calls.length, 1);
    }),
  );

  it.effect("routes explicit claudeAgent provider session starts to the claude adapter", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;

      const session = yield* provider.startSession(asThreadId("thread-claude"), {
        provider: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: claudeAgentInstanceId,
        threadId: asThreadId("thread-claude"),
        cwd: "/tmp/project-claude",
        runtimeMode: "full-access",
      });

      assert.equal(session.provider, "claudeAgent");
      assert.equal(routing.claude.startSession.mock.calls.length, 1);
      const startInput = routing.claude.startSession.mock.calls[0]?.[0];
      assert.equal(typeof startInput === "object" && startInput !== null, true);
      if (startInput && typeof startInput === "object") {
        const startPayload = startInput as {
          provider?: string;
          providerInstanceId?: ProviderInstanceId;
          cwd?: string;
        };
        assert.equal(startPayload.provider, "claudeAgent");
        assert.equal(startPayload.providerInstanceId, claudeAgentInstanceId);
        assert.equal(startPayload.cwd, "/tmp/project-claude");
      }
    }),
  );

  it.effect("dies when an active session conflicts with its persisted binding", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const directory = yield* ProviderSessionDirectory;
      const threadId = asThreadId("thread-binding-mismatch");

      yield* provider.startSession(threadId, {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/project-binding-mismatch",
        runtimeMode: "full-access",
      });
      yield* directory.upsert({
        threadId,
        provider: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: claudeAgentInstanceId,
        runtimeMode: "full-access",
      });

      const exit = yield* Effect.exit(provider.listSessions());
      assert.equal(Exit.hasDies(exit), true);
      yield* directory.upsert({
        threadId,
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        runtimeMode: "full-access",
      });
    }),
  );

  it.effect("stops stale sessions in other providers after a successful replacement start", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const threadId = asThreadId("thread-provider-replacement");

      const codexSession = yield* provider.startSession(threadId, {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId,
        cwd: "/tmp/project-provider-replacement",
        runtimeMode: "full-access",
      });

      routing.codex.stopSession.mockClear();
      routing.claude.stopSession.mockClear();

      const claudeSession = yield* provider.startSession(threadId, {
        provider: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: claudeAgentInstanceId,
        threadId,
        cwd: "/tmp/project-provider-replacement",
        runtimeMode: "full-access",
      });

      assert.equal(codexSession.provider, "codex");
      assert.equal(claudeSession.provider, "claudeAgent");
      assert.deepEqual(routing.codex.stopSession.mock.calls, [[threadId]]);
      assert.equal(routing.claude.stopSession.mock.calls.length, 0);

      const sessions = yield* provider.listSessions();
      assert.deepEqual(
        sessions
          .filter((session) => session.threadId === threadId)
          .map((session) => session.provider),
        ["claudeAgent"],
      );
    }),
  );

  it.effect("recovers stale sessions for sendTurn using persisted cwd", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;

      const initial = yield* provider.startSession(asThreadId("thread-1"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-1"),
        cwd: "/tmp/project-send-turn",
        runtimeMode: "full-access",
      });

      yield* routing.codex.stopAll();
      routing.codex.startSession.mockClear();
      routing.codex.sendTurn.mockClear();

      yield* provider.sendTurn({
        threadId: initial.threadId,
        input: "resume",
        attachments: [],
      });

      assert.equal(routing.codex.startSession.mock.calls.length, 1);
      const resumedStartInput = routing.codex.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "codex");
        assert.equal(startPayload.cwd, "/tmp/project-send-turn");
        assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
        assert.equal(startPayload.threadId, initial.threadId);
      }
      assert.equal(routing.codex.sendTurn.mock.calls.length, 1);
    }),
  );

  it.effect("recovers stale claudeAgent sessions for sendTurn using persisted cwd", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;

      const initial = yield* provider.startSession(asThreadId("thread-claude-send-turn"), {
        provider: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: claudeAgentInstanceId,
        threadId: asThreadId("thread-claude-send-turn"),
        cwd: "/tmp/project-claude-send-turn",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("claudeAgent"),
          "claude-opus-4-6",
          [{ id: "effort", value: "max" }],
        ),
        runtimeMode: "full-access",
      });

      yield* routing.claude.stopAll();
      routing.claude.startSession.mockClear();
      routing.claude.sendTurn.mockClear();

      yield* provider.sendTurn({
        threadId: initial.threadId,
        input: "resume with claude",
        attachments: [],
      });

      assert.equal(routing.claude.startSession.mock.calls.length, 1);
      const resumedStartInput = routing.claude.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          modelSelection?: unknown;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "claudeAgent");
        assert.equal(startPayload.cwd, "/tmp/project-claude-send-turn");
        assert.deepEqual(
          startPayload.modelSelection,
          createModelSelection(ProviderInstanceId.make("claudeAgent"), "claude-opus-4-6", [
            { id: "effort", value: "max" },
          ]),
        );
        assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
        assert.equal(startPayload.threadId, initial.threadId);
      }
      assert.equal(routing.claude.sendTurn.mock.calls.length, 1);
    }),
  );

  it.effect("lists no sessions after adapter runtime clears", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;

      yield* provider.startSession(asThreadId("thread-1"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-1"),
        runtimeMode: "full-access",
      });
      yield* provider.startSession(asThreadId("thread-2"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-2"),
        runtimeMode: "full-access",
      });

      yield* routing.codex.stopAll();
      yield* routing.claude.stopAll();

      const remaining = yield* provider.listSessions();
      assert.equal(remaining.length, 0);
    }),
  );

  it.effect("persists runtime status transitions in provider_session_runtime", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;

      const threadId = asThreadId("thread-runtime-status");
      const session = yield* provider.startSession(threadId, {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "full-access",
      });
      yield* provider.sendTurn({
        threadId: session.threadId,
        input: "hello",
        attachments: [],
      });

      const runningRuntime = yield* runtimeRepository.getByThreadId({
        threadId: session.threadId,
      });
      assert.equal(Option.isSome(runningRuntime), true);
      if (Option.isSome(runningRuntime)) {
        assert.equal(runningRuntime.value.status, "running");
        assert.deepEqual(runningRuntime.value.resumeCursor, session.resumeCursor);
        const payload = runningRuntime.value.runtimePayload;
        assert.equal(payload !== null && typeof payload === "object", true);
        if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
          const runtimePayload = payload as {
            cwd: string;
            model: string | null;
            activeTurnId: string | null;
            lastError: string | null;
            lastRuntimeEvent: string | null;
            runtimeOwnerId: string;
            runtimeOwnerPid: number;
            runtimeOwnerStartedAt: string;
            runtimeOwnerHeartbeatAt: string;
          };
          assert.equal(runtimePayload.cwd, session.cwd);
          assert.equal(runtimePayload.model, null);
          assert.equal(runtimePayload.activeTurnId, `turn-${String(session.threadId)}`);
          assert.equal(runtimePayload.lastError, null);
          assert.equal(runtimePayload.lastRuntimeEvent, "provider.sendTurn");
          assert.match(runtimePayload.runtimeOwnerId, /^[0-9a-f-]{36}$/u);
          assert.equal(runtimePayload.runtimeOwnerPid, process.pid);
          assert.equal(Number.isNaN(Date.parse(runtimePayload.runtimeOwnerStartedAt)), false);
          assert.equal(Number.isNaN(Date.parse(runtimePayload.runtimeOwnerHeartbeatAt)), false);
        }
      }
    }),
  );

  it.effect("routes live steering and preserves the expected active turn id", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;

      const threadId = asThreadId("thread-runtime-steer");
      const session = yield* provider.startSession(threadId, {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "full-access",
      });
      routing.codex.steerTurn.mockClear();
      const result = yield* provider.steerTurn({
        threadId: session.threadId,
        expectedTurnId: asTurnId("turn-active"),
        input: "adjust course",
        attachments: [],
      });

      assert.equal(result.turnId, asTurnId("turn-active"));
      assert.equal(routing.codex.steerTurn.mock.calls.length, 1);
      assert.deepEqual(routing.codex.steerTurn.mock.calls[0]?.[0], {
        threadId,
        expectedTurnId: asTurnId("turn-active"),
        input: "adjust course",
        attachments: [],
      });

      const runningRuntime = yield* runtimeRepository.getByThreadId({
        threadId: session.threadId,
      });
      assert.equal(Option.isSome(runningRuntime), true);
      if (Option.isSome(runningRuntime)) {
        const payload = runningRuntime.value.runtimePayload;
        assert.equal(payload !== null && typeof payload === "object", true);
        if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
          const runtimePayload = payload as {
            activeTurnId: string | null;
            lastRuntimeEvent: string | null;
          };
          assert.equal(runtimePayload.activeTurnId, "turn-active");
          assert.equal(runtimePayload.lastRuntimeEvent, "provider.steerTurn");
        }
      }
    }),
  );

  it.effect("persists resume cursors emitted by runtime lifecycle events", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;
      const threadId = asThreadId("thread-runtime-resume-cursor");
      const session = yield* provider.startSession(threadId, {
        provider: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: claudeAgentInstanceId,
        threadId,
        runtimeMode: "full-access",
      });
      yield* advanceTestClock(50);

      const resumeCursor = {
        threadId,
        resume: "550e8400-e29b-41d4-a716-446655440000",
        resumeSessionAt: "assistant-runtime-resume",
        turnCount: 1,
      };
      routing.claude.emit({
        type: "turn.completed",
        eventId: asEventId("evt-runtime-resume-cursor"),
        provider: ProviderDriverKind.make("claudeAgent"),
        createdAt: "2026-01-01T00:00:10.000Z",
        threadId: session.threadId,
        turnId: asTurnId("turn-runtime-resume-cursor"),
        payload: {
          state: "completed",
          resumeCursor,
        },
      });
      yield* advanceTestClock(50);

      const persisted = yield* runtimeRepository.getByThreadId({ threadId: session.threadId });
      assert.equal(Option.isSome(persisted), true);
      if (Option.isSome(persisted)) {
        assert.deepEqual(persisted.value.resumeCursor, resumeCursor);
      }
    }),
  );

  it.effect("reuses persisted resume cursor when startSession is called after a restart", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-provider-service-start-"));
      const dbPath = path.join(tempDir, "orchestration.sqlite");
      const persistenceLayer = makeSqlitePersistenceLive(dbPath);
      const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
        Layer.provide(persistenceLayer),
      );

      const firstClaude = makeFakeCodexAdapter(CLAUDE_AGENT_DRIVER);
      const firstRegistry = makeAdapterRegistryMock({
        [ProviderDriverKind.make("claudeAgent")]: firstClaude.adapter,
      });
      const firstDirectoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const firstProviderLayer = makeProviderServiceLive().pipe(
        Layer.provide(Layer.succeed(ProviderAdapterRegistry, firstRegistry)),
        Layer.provide(firstDirectoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
      );

      const initial = yield* Effect.gen(function* () {
        const provider = yield* ProviderService;
        return yield* provider.startSession(asThreadId("thread-claude-start"), {
          provider: ProviderDriverKind.make("claudeAgent"),
          providerInstanceId: claudeAgentInstanceId,
          threadId: asThreadId("thread-claude-start"),
          cwd: "/tmp/project-claude-start",
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(firstProviderLayer));

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService;
        yield* provider.listSessions();
      }).pipe(Effect.provide(firstProviderLayer));

      const secondClaude = makeFakeCodexAdapter(CLAUDE_AGENT_DRIVER);
      const secondRegistry = makeAdapterRegistryMock({
        [ProviderDriverKind.make("claudeAgent")]: secondClaude.adapter,
      });
      const secondDirectoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );
      const secondProviderLayer = makeProviderServiceLive().pipe(
        Layer.provide(Layer.succeed(ProviderAdapterRegistry, secondRegistry)),
        Layer.provide(secondDirectoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
      );

      secondClaude.startSession.mockClear();

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService;
        yield* provider.startSession(initial.threadId, {
          provider: ProviderDriverKind.make("claudeAgent"),
          providerInstanceId: claudeAgentInstanceId,
          threadId: initial.threadId,
          cwd: "/tmp/project-claude-start",
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(secondProviderLayer));

      assert.equal(secondClaude.startSession.mock.calls.length, 1);
      const resumedStartInput = secondClaude.startSession.mock.calls[0]?.[0];
      assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
      if (resumedStartInput && typeof resumedStartInput === "object") {
        const startPayload = resumedStartInput as {
          provider?: string;
          cwd?: string;
          resumeCursor?: unknown;
          threadId?: string;
        };
        assert.equal(startPayload.provider, "claudeAgent");
        assert.equal(startPayload.cwd, "/tmp/project-claude-start");
        assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
        assert.equal(startPayload.threadId, initial.threadId);
      }

      fs.rmSync(tempDir, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("starts fresh when a persisted Codex resume cursor points at a missing rollout", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-provider-service-codex-rollout-"));
      const dbPath = path.join(tempDir, "orchestration.sqlite");
      const persistenceLayer = makeSqlitePersistenceLive(dbPath);
      const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
        Layer.provide(persistenceLayer),
      );
      const directoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );

      const threadId = asThreadId("thread-codex-missing-rollout");
      const staleResumeCursor = { threadId: "019ea1bf-c1d5-7800-9813-0ccf59d77847" };

      yield* Effect.gen(function* () {
        const directory = yield* ProviderSessionDirectory;
        yield* directory.upsert({
          threadId,
          provider: CODEX_DRIVER,
          providerInstanceId: codexInstanceId,
          runtimeMode: "full-access",
          status: "stopped",
          resumeCursor: staleResumeCursor,
          runtimePayload: {
            cwd: "/tmp/project-codex-rollout",
          },
        });
      }).pipe(Effect.provide(directoryLayer));

      const codex = makeFakeCodexAdapter(CODEX_DRIVER);
      codex.startSession.mockImplementationOnce((input: ProviderSessionStartInput) =>
        Effect.fail(
          new ProviderAdapterProcessError({
            provider: CODEX_DRIVER,
            threadId: input.threadId,
            detail:
              "failed to resolve rollout path `/tmp/rollout-019ea1bf-c1d5-7800-9813-0ccf59d77847.jsonl`: file does not exist",
          }),
        ),
      );

      const registry = makeAdapterRegistryMock({
        [CODEX_DRIVER]: codex.adapter,
      });
      const providerLayer = makeProviderServiceLive().pipe(
        Layer.provide(Layer.succeed(ProviderAdapterRegistry, registry)),
        Layer.provide(directoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
      );

      const session = yield* Effect.gen(function* () {
        const provider = yield* ProviderService;
        return yield* provider.startSession(threadId, {
          provider: CODEX_DRIVER,
          providerInstanceId: codexInstanceId,
          threadId,
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(providerLayer));

      assert.equal(session.provider, CODEX_DRIVER);
      assert.equal(codex.startSession.mock.calls.length, 2);
      assert.deepEqual(codex.startSession.mock.calls[0]?.[0].resumeCursor, staleResumeCursor);
      assert.equal("resumeCursor" in (codex.startSession.mock.calls[1]?.[0] ?? {}), false);

      const persisted = yield* Effect.gen(function* () {
        const runtimeRepository = yield* ProviderSessionRuntimeRepository;
        return yield* runtimeRepository.getByThreadId({ threadId: session.threadId });
      }).pipe(Effect.provide(runtimeRepositoryLayer));
      assert.equal(Option.isSome(persisted), true);
      if (Option.isSome(persisted)) {
        assert.notDeepEqual(persisted.value.resumeCursor, staleResumeCursor);
      }

      fs.rmSync(tempDir, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("starts fresh when a persisted Claude resume cursor is rejected", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-provider-service-claude-resume-"));
      const dbPath = path.join(tempDir, "orchestration.sqlite");
      const persistenceLayer = makeSqlitePersistenceLive(dbPath);
      const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
        Layer.provide(persistenceLayer),
      );
      const directoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );

      const threadId = asThreadId("thread-claude-rejected-resume");
      const staleResumeCursor = {
        threadId,
        resume: "550e8400-e29b-41d4-a716-446655440000",
        turnCount: 4,
      };

      yield* Effect.gen(function* () {
        const directory = yield* ProviderSessionDirectory;
        yield* directory.upsert({
          threadId,
          provider: CLAUDE_AGENT_DRIVER,
          providerInstanceId: claudeAgentInstanceId,
          runtimeMode: "full-access",
          status: "stopped",
          resumeCursor: staleResumeCursor,
          runtimePayload: {
            cwd: "/tmp/project-claude-rejected-resume",
          },
        });
      }).pipe(Effect.provide(directoryLayer));

      const claude = makeFakeCodexAdapter(CLAUDE_AGENT_DRIVER);
      claude.startSession.mockImplementationOnce((input: ProviderSessionStartInput) =>
        Effect.fail(
          new ProviderAdapterProcessError({
            provider: CLAUDE_AGENT_DRIVER,
            threadId: input.threadId,
            detail: "Claude Code process exited with code 1",
            cause: new Error(
              "No conversation found with session ID: 550e8400-e29b-41d4-a716-446655440000",
            ),
          }),
        ),
      );

      const registry = makeAdapterRegistryMock({
        [CLAUDE_AGENT_DRIVER]: claude.adapter,
      });
      const providerLayer = makeProviderServiceLive().pipe(
        Layer.provide(Layer.succeed(ProviderAdapterRegistry, registry)),
        Layer.provide(directoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
      );

      const session = yield* Effect.gen(function* () {
        const provider = yield* ProviderService;
        return yield* provider.startSession(threadId, {
          provider: CLAUDE_AGENT_DRIVER,
          providerInstanceId: claudeAgentInstanceId,
          threadId,
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(providerLayer));

      assert.equal(session.provider, CLAUDE_AGENT_DRIVER);
      assert.equal(claude.startSession.mock.calls.length, 2);
      assert.deepEqual(claude.startSession.mock.calls[0]?.[0].resumeCursor, staleResumeCursor);
      assert.equal("resumeCursor" in (claude.startSession.mock.calls[1]?.[0] ?? {}), false);

      const persisted = yield* Effect.gen(function* () {
        const runtimeRepository = yield* ProviderSessionRuntimeRepository;
        return yield* runtimeRepository.getByThreadId({ threadId: session.threadId });
      }).pipe(Effect.provide(runtimeRepositoryLayer));
      assert.equal(Option.isSome(persisted), true);
      if (Option.isSome(persisted)) {
        assert.notDeepEqual(persisted.value.resumeCursor, staleResumeCursor);
      }

      fs.rmSync(tempDir, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("recovers stale Claude sendTurn sessions by dropping rejected resume cursors", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "t3-provider-service-claude-send-resume-"),
      );
      const dbPath = path.join(tempDir, "orchestration.sqlite");
      const persistenceLayer = makeSqlitePersistenceLive(dbPath);
      const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
        Layer.provide(persistenceLayer),
      );
      const directoryLayer = ProviderSessionDirectoryLive.pipe(
        Layer.provide(runtimeRepositoryLayer),
      );

      const threadId = asThreadId("thread-claude-send-rejected-resume");
      const staleResumeCursor = {
        threadId,
        resume: "650e8400-e29b-41d4-a716-446655440000",
        turnCount: 6,
      };

      yield* Effect.gen(function* () {
        const directory = yield* ProviderSessionDirectory;
        yield* directory.upsert({
          threadId,
          provider: CLAUDE_AGENT_DRIVER,
          providerInstanceId: claudeAgentInstanceId,
          runtimeMode: "full-access",
          status: "stopped",
          resumeCursor: staleResumeCursor,
          runtimePayload: {
            cwd: "/tmp/project-claude-send-rejected-resume",
          },
        });
      }).pipe(Effect.provide(directoryLayer));

      const claude = makeFakeCodexAdapter(CLAUDE_AGENT_DRIVER);
      claude.startSession.mockImplementationOnce((input: ProviderSessionStartInput) =>
        Effect.fail(
          new ProviderAdapterProcessError({
            provider: CLAUDE_AGENT_DRIVER,
            threadId: input.threadId,
            detail: "No message found with message.uuid of: assistant-99",
          }),
        ),
      );

      const registry = makeAdapterRegistryMock({
        [CLAUDE_AGENT_DRIVER]: claude.adapter,
      });
      const providerLayer = makeProviderServiceLive().pipe(
        Layer.provide(Layer.succeed(ProviderAdapterRegistry, registry)),
        Layer.provide(directoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
      );

      yield* Effect.gen(function* () {
        const provider = yield* ProviderService;
        yield* provider.sendTurn({
          threadId,
          input: "resume without stale Claude cursor",
          attachments: [],
        });
      }).pipe(Effect.provide(providerLayer));

      assert.equal(claude.startSession.mock.calls.length, 2);
      assert.deepEqual(claude.startSession.mock.calls[0]?.[0].resumeCursor, staleResumeCursor);
      assert.equal("resumeCursor" in (claude.startSession.mock.calls[1]?.[0] ?? {}), false);
      assert.equal(claude.sendTurn.mock.calls.length, 1);

      const persisted = yield* Effect.gen(function* () {
        const runtimeRepository = yield* ProviderSessionRuntimeRepository;
        return yield* runtimeRepository.getByThreadId({ threadId });
      }).pipe(Effect.provide(runtimeRepositoryLayer));
      assert.equal(Option.isSome(persisted), true);
      if (Option.isSome(persisted)) {
        assert.notDeepEqual(persisted.value.resumeCursor, staleResumeCursor);
      }

      fs.rmSync(tempDir, { recursive: true, force: true });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "reuses persisted cwd when startSession resumes a claude session without cwd input",
    () =>
      Effect.gen(function* () {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-provider-service-cwd-"));
        const dbPath = path.join(tempDir, "orchestration.sqlite");
        const persistenceLayer = makeSqlitePersistenceLive(dbPath);
        const runtimeRepositoryLayer = ProviderSessionRuntimeRepositoryLive.pipe(
          Layer.provide(persistenceLayer),
        );

        const firstClaude = makeFakeCodexAdapter(CLAUDE_AGENT_DRIVER);
        const firstRegistry = makeAdapterRegistryMock({
          [ProviderDriverKind.make("claudeAgent")]: firstClaude.adapter,
        });
        const firstDirectoryLayer = ProviderSessionDirectoryLive.pipe(
          Layer.provide(runtimeRepositoryLayer),
        );
        const firstProviderLayer = makeProviderServiceLive().pipe(
          Layer.provide(Layer.succeed(ProviderAdapterRegistry, firstRegistry)),
          Layer.provide(firstDirectoryLayer),
          Layer.provide(defaultServerSettingsLayer),
          Layer.provide(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
        );

        const initial = yield* Effect.gen(function* () {
          const provider = yield* ProviderService;
          return yield* provider.startSession(asThreadId("thread-claude-cwd"), {
            provider: ProviderDriverKind.make("claudeAgent"),
            providerInstanceId: claudeAgentInstanceId,
            threadId: asThreadId("thread-claude-cwd"),
            cwd: "/tmp/project-claude-cwd",
            runtimeMode: "full-access",
          });
        }).pipe(Effect.provide(firstProviderLayer));

        const secondClaude = makeFakeCodexAdapter(CLAUDE_AGENT_DRIVER);
        const secondRegistry = makeAdapterRegistryMock({
          [ProviderDriverKind.make("claudeAgent")]: secondClaude.adapter,
        });
        const secondDirectoryLayer = ProviderSessionDirectoryLive.pipe(
          Layer.provide(runtimeRepositoryLayer),
        );
        const secondProviderLayer = makeProviderServiceLive().pipe(
          Layer.provide(Layer.succeed(ProviderAdapterRegistry, secondRegistry)),
          Layer.provide(secondDirectoryLayer),
          Layer.provide(defaultServerSettingsLayer),
          Layer.provide(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
        );

        secondClaude.startSession.mockClear();

        yield* Effect.gen(function* () {
          const provider = yield* ProviderService;
          yield* provider.startSession(initial.threadId, {
            provider: ProviderDriverKind.make("claudeAgent"),
            providerInstanceId: claudeAgentInstanceId,
            threadId: initial.threadId,
            runtimeMode: "full-access",
          });
        }).pipe(Effect.provide(secondProviderLayer));

        assert.equal(secondClaude.startSession.mock.calls.length, 1);
        const resumedStartInput = secondClaude.startSession.mock.calls[0]?.[0];
        assert.equal(typeof resumedStartInput === "object" && resumedStartInput !== null, true);
        if (resumedStartInput && typeof resumedStartInput === "object") {
          const startPayload = resumedStartInput as {
            provider?: string;
            cwd?: string;
            resumeCursor?: unknown;
            threadId?: string;
          };
          assert.equal(startPayload.provider, "claudeAgent");
          assert.equal(startPayload.cwd, "/tmp/project-claude-cwd");
          assert.deepEqual(startPayload.resumeCursor, initial.resumeCursor);
          assert.equal(startPayload.threadId, initial.threadId);
        }

        fs.rmSync(tempDir, { recursive: true, force: true });
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});

const fanout = makeProviderServiceLayer();
fanout.layer("ProviderServiceLive fanout", (it) => {
  beforeEach(fanout.reset);

  it.effect("fences late lifecycle events while quiescing every adapter for hard delete", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const directory = yield* ProviderSessionDirectory;
      const threadId = asThreadId("thread-hard-delete-event-fence");
      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "full-access",
      });
      // A stale adapter instance can still own the immutable Cafe thread id
      // after a provider switch. Permanent deletion must stop it too.
      yield* fanout.claude.startSession({
        provider: CLAUDE_AGENT_DRIVER,
        providerInstanceId: claudeAgentInstanceId,
        threadId,
        runtimeMode: "full-access",
      });

      const received: Array<ProviderRuntimeEvent> = [];
      const consumer = yield* Stream.runForEach(provider.streamEvents, (event) =>
        Effect.sync(() => {
          received.push(event);
        }),
      ).pipe(Effect.forkChild);
      yield* advanceTestClock(50);

      yield* provider.quiesceThreadForHardDelete({ threadId });
      yield* directory.remove(threadId);
      fanout.codex.emit({
        type: "session.exited",
        eventId: asEventId("evt-late-after-hard-delete"),
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        createdAt: "2026-01-01T00:00:10.000Z",
        threadId,
        payload: { reason: "late provider shutdown event" },
      });
      yield* advanceTestClock(50);

      assert.equal(fanout.codex.stopSession.mock.calls.length, 1);
      assert.equal(fanout.claude.stopSession.mock.calls.length, 1);
      assert.isFalse(received.some((event) => event.eventId === "evt-late-after-hard-delete"));
      assert.isTrue(Option.isNone(yield* directory.getBinding(threadId)));
      yield* Fiber.interrupt(consumer);
    }),
  );

  it.effect("waits for an acknowledged turn mutation before permanently retiring the thread", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const threadId = asThreadId("thread-hard-delete-concurrent-send");
      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "full-access",
      });

      const sendStarted = yield* Deferred.make<void>();
      const releaseSend = yield* Deferred.make<void>();
      fanout.codex.sendTurn.mockImplementationOnce((input) =>
        Deferred.succeed(sendStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseSend)),
          Effect.as({
            threadId: input.threadId,
            turnId: asTurnId("turn-concurrent-hard-delete"),
          }),
        ),
      );

      const sendFiber = yield* provider
        .sendTurn({ threadId, input: "work racing permanent deletion", attachments: [] })
        .pipe(Effect.forkChild);
      yield* Deferred.await(sendStarted);

      const quiesceFiber = yield* provider
        .quiesceThreadForHardDelete({ threadId })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      assert.equal(fanout.codex.stopSession.mock.calls.length, 0);

      yield* Deferred.succeed(releaseSend, undefined);
      yield* Fiber.join(sendFiber);
      yield* Fiber.join(quiesceFiber);
      assert.equal(fanout.codex.stopSession.mock.calls.length, 1);

      const rejected = yield* provider
        .sendTurn({ threadId, input: "must remain retired", attachments: [] })
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(rejected));
      assert.equal(fanout.codex.sendTurn.mock.calls.length, 1);
    }),
  );

  it.effect("drops a stale owner-heartbeat write after permanent retirement", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const directory = yield* ProviderSessionDirectory;
      const threadId = asThreadId("thread-heartbeat-hard-delete-race");
      // Seed adapter and durable state directly so ProviderService's heartbeat
      // cache has no prior write for this live session and the next inventory
      // refresh is immediately due.
      yield* fanout.codex.startSession({
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "full-access",
      });
      const turnId = asTurnId("turn-heartbeat-hard-delete-race");
      fanout.codex.updateSession(threadId, (session) => ({
        ...session,
        status: "running",
        activeTurnId: turnId,
      }));
      yield* directory.upsert({
        threadId,
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        status: "running",
        runtimePayload: { activeTurnId: turnId },
      });
      const staleSessions = yield* fanout.codex.listSessions();
      const listStarted = yield* Deferred.make<void>();
      const releaseList = yield* Deferred.make<void>();
      fanout.codex.listSessions.mockImplementationOnce(() =>
        Deferred.succeed(listStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseList)),
          Effect.as(staleSessions),
        ),
      );

      const listFiber = yield* provider.listSessions().pipe(Effect.forkChild);
      yield* Deferred.await(listStarted);
      yield* provider.quiesceThreadForHardDelete({ threadId });
      yield* directory.remove(threadId);
      yield* Deferred.succeed(releaseList, undefined);
      yield* Fiber.join(listFiber);

      assert.isTrue(Option.isNone(yield* directory.getBinding(threadId)));
    }),
  );

  it.effect("persists stopped runtime state when an adapter session exits", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;
      const threadId = asThreadId("thread-session-exited");
      const session = yield* provider.startSession(threadId, {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "full-access",
      });

      yield* provider.sendTurn({
        threadId: session.threadId,
        input: "before exit",
        attachments: [],
      });
      yield* advanceTestClock(50);

      fanout.codex.emit({
        type: "session.exited",
        eventId: asEventId("evt-session-exited"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:10.000Z",
        threadId: session.threadId,
        payload: {
          reason: "Codex App Server exited with code 1.",
        },
      });
      yield* advanceTestClock(50);

      const persisted = yield* runtimeRepository.getByThreadId({ threadId: session.threadId });
      assert.equal(Option.isSome(persisted), true);
      if (Option.isNone(persisted)) {
        return;
      }

      assert.equal(persisted.value.status, "stopped");
      const runtimePayload = persisted.value.runtimePayload as Record<string, unknown>;
      assert.equal(runtimePayload.activeTurnId, null);
      assert.equal(runtimePayload.lastRuntimeEvent, "session.exited");
      assert.equal(runtimePayload.lastRuntimeEventAt, "2026-01-01T00:00:10.000Z");
    }),
  );

  it.effect("fans out adapter turn completion events", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const session = yield* provider.startSession(asThreadId("thread-1"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-1"),
        runtimeMode: "full-access",
      });

      const eventsRef = yield* Ref.make<Array<ProviderRuntimeEvent>>([]);
      const consumer = yield* Stream.runForEach(provider.streamEvents, (event) =>
        Ref.update(eventsRef, (current) => [...current, event]),
      ).pipe(Effect.forkChild);
      yield* advanceTestClock(50);

      const completedEvent: LegacyProviderRuntimeEvent = {
        type: "turn.completed",
        eventId: asEventId("evt-1"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: session.threadId,
        turnId: asTurnId("turn-1"),
        status: "completed",
      };

      fanout.codex.emit(completedEvent);
      yield* advanceTestClock(50);

      const events = yield* Ref.get(eventsRef);
      yield* Fiber.interrupt(consumer);

      assert.equal(
        events.some((entry) => entry.type === "turn.completed"),
        true,
      );
      assert.equal(
        events.some(
          (entry) =>
            entry.type === "turn.completed" && entry.providerInstanceId === codexInstanceId,
        ),
        true,
      );
    }),
  );

  it.effect("fans out canonical runtime events in emission order", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const session = yield* provider.startSession(asThreadId("thread-seq"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-seq"),
        runtimeMode: "full-access",
      });

      const receivedRef = yield* Ref.make<Array<ProviderRuntimeEvent>>([]);
      const consumer = yield* Stream.take(provider.streamEvents, 3).pipe(
        Stream.runForEach((event) => Ref.update(receivedRef, (current) => [...current, event])),
        Effect.forkChild,
      );
      yield* advanceTestClock(50);

      fanout.codex.emit({
        type: "tool.started",
        eventId: asEventId("evt-seq-1"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: session.threadId,
        turnId: asTurnId("turn-1"),
        toolKind: "command",
        title: "Ran command",
      });
      fanout.codex.emit({
        type: "tool.completed",
        eventId: asEventId("evt-seq-2"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: session.threadId,
        turnId: asTurnId("turn-1"),
        toolKind: "command",
        title: "Ran command",
      });
      fanout.codex.emit({
        type: "turn.completed",
        eventId: asEventId("evt-seq-3"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: session.threadId,
        turnId: asTurnId("turn-1"),
        status: "completed",
      });

      yield* Fiber.join(consumer);
      const received = yield* Ref.get(receivedRef);
      assert.deepEqual(
        received.map((event) => event.eventId),
        [asEventId("evt-seq-1"), asEventId("evt-seq-2"), asEventId("evt-seq-3")],
      );
    }),
  );

  it.effect("keeps subscriber delivery ordered and isolates failing subscribers", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const session = yield* provider.startSession(asThreadId("thread-1"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-1"),
        runtimeMode: "full-access",
      });

      const receivedByHealthy: string[] = [];
      const expectedEventIds = new Set<string>(["evt-ordered-1", "evt-ordered-2", "evt-ordered-3"]);
      const healthyFiber = yield* Stream.take(provider.streamEvents, 3).pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            receivedByHealthy.push(event.eventId);
          }),
        ),
        Effect.forkChild,
      );
      const failingFiber = yield* Stream.take(provider.streamEvents, 1).pipe(
        Stream.runForEach(() => Effect.fail("listener crash")),
        Effect.forkChild,
      );
      yield* advanceTestClock(50);

      const events: ReadonlyArray<LegacyProviderRuntimeEvent> = [
        {
          type: "tool.completed",
          eventId: asEventId("evt-ordered-1"),
          provider: ProviderDriverKind.make("codex"),
          createdAt: "2026-01-01T00:00:00.000Z",
          threadId: session.threadId,
          turnId: asTurnId("turn-1"),
          toolKind: "command",
          title: "Ran command",
          detail: "echo one",
        },
        {
          type: "message.delta",
          eventId: asEventId("evt-ordered-2"),
          provider: ProviderDriverKind.make("codex"),
          createdAt: "2026-01-01T00:00:00.000Z",
          threadId: session.threadId,
          turnId: asTurnId("turn-1"),
          delta: "hello",
        },
        {
          type: "turn.completed",
          eventId: asEventId("evt-ordered-3"),
          provider: ProviderDriverKind.make("codex"),
          createdAt: "2026-01-01T00:00:00.000Z",
          threadId: session.threadId,
          turnId: asTurnId("turn-1"),
          status: "completed",
        },
      ];

      for (const event of events) {
        fanout.codex.emit(event);
      }
      const failingResult = yield* Effect.result(Fiber.join(failingFiber));
      assert.equal(failingResult._tag, "Failure");
      yield* Fiber.join(healthyFiber);

      assert.deepEqual(
        receivedByHealthy.filter((eventId) => expectedEventIds.has(eventId)).slice(0, 3),
        ["evt-ordered-1", "evt-ordered-2", "evt-ordered-3"],
      );
    }),
  );

  it.effect("continues adapter event fanout after one malformed source event", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const session = yield* provider.startSession(asThreadId("thread-fanout-resilience"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-fanout-resilience"),
        runtimeMode: "full-access",
      });

      const receivedRef = yield* Ref.make<Array<ProviderRuntimeEvent>>([]);
      const consumer = yield* Stream.runForEach(provider.streamEvents, (event) =>
        Ref.update(receivedRef, (current) => [...current, event]),
      ).pipe(Effect.forkChild);
      yield* advanceTestClock(50);

      // This event carries a conflicting providerInstanceId for the adapter
      // that emitted it. It must be logged and discarded, not allowed to kill
      // the adapter subscription for future valid events from the same session.
      fanout.codex.emit({
        type: "turn.completed",
        eventId: asEventId("evt-fanout-malformed"),
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex-other"),
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: session.threadId,
        turnId: asTurnId("turn-1"),
        status: "completed",
      } as unknown as LegacyProviderRuntimeEvent);

      fanout.codex.emit({
        type: "turn.completed",
        eventId: asEventId("evt-fanout-valid-after-malformed"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:01.000Z",
        threadId: session.threadId,
        turnId: asTurnId("turn-1"),
        status: "completed",
      });
      yield* advanceTestClock(50);

      const received = yield* Ref.get(receivedRef);
      yield* Fiber.interrupt(consumer);

      assert.deepEqual(
        received.map((event) => event.eventId),
        [asEventId("evt-fanout-valid-after-malformed")],
      );
    }),
  );

  it.effect("restarts a current adapter event subscription after the stream ends", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const session = yield* provider.startSession(asThreadId("thread-stream-restart"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-stream-restart"),
        runtimeMode: "full-access",
      });

      const receivedFiber = yield* Stream.take(provider.streamEvents, 1).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* advanceTestClock(50);

      fanout.codex.replaceEventStream();
      yield* advanceTestClock(600);

      fanout.codex.emit({
        type: "turn.completed",
        eventId: asEventId("evt-after-stream-restart"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:01.000Z",
        threadId: session.threadId,
        turnId: asTurnId("turn-1"),
        status: "completed",
      });

      const received = Array.from(yield* Fiber.join(receivedFiber));
      assert.deepEqual(
        received.map((event) => event.eventId),
        [asEventId("evt-after-stream-restart")],
      );
    }),
  );

  it.effect("records provider metrics with the routed provider label", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;

      const session = yield* provider.startSession(asThreadId("thread-metrics"), {
        provider: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: claudeAgentInstanceId,
        threadId: asThreadId("thread-metrics"),
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });

      yield* provider.interruptTurn({ threadId: session.threadId });
      yield* provider.respondToRequest({
        threadId: session.threadId,
        requestId: asRequestId("req-metrics-1"),
        decision: "accept",
      });
      yield* provider.respondToUserInput({
        threadId: session.threadId,
        requestId: asRequestId("req-metrics-2"),
        answers: {
          sandbox_mode: "workspace-write",
        },
      });
      yield* provider.rollbackConversation({
        threadId: session.threadId,
        numTurns: 1,
      });
      yield* provider.stopSession({ threadId: session.threadId });

      const snapshots = yield* Metric.snapshot;

      assert.equal(
        hasMetricSnapshot(snapshots, "t3_provider_turns_total", {
          provider: ProviderDriverKind.make("claudeAgent"),
          operation: "interrupt",
          outcome: "success",
        }),
        true,
      );
      assert.equal(
        hasMetricSnapshot(snapshots, "t3_provider_turns_total", {
          provider: ProviderDriverKind.make("claudeAgent"),
          operation: "approval-response",
          outcome: "success",
        }),
        true,
      );
      assert.equal(
        hasMetricSnapshot(snapshots, "t3_provider_turns_total", {
          provider: ProviderDriverKind.make("claudeAgent"),
          operation: "user-input-response",
          outcome: "success",
        }),
        true,
      );
      assert.equal(
        hasMetricSnapshot(snapshots, "t3_provider_turns_total", {
          provider: ProviderDriverKind.make("claudeAgent"),
          operation: "rollback",
          outcome: "success",
        }),
        true,
      );
      assert.equal(
        hasMetricSnapshot(snapshots, "t3_provider_sessions_total", {
          provider: ProviderDriverKind.make("claudeAgent"),
          operation: "stop",
          outcome: "success",
        }),
        true,
      );
    }),
  );

  it.effect(
    "records sendTurn metrics with the resolved provider when modelSelection is omitted",
    () =>
      Effect.gen(function* () {
        const provider = yield* ProviderService;

        const session = yield* provider.startSession(asThreadId("thread-send-metrics"), {
          provider: ProviderDriverKind.make("claudeAgent"),
          providerInstanceId: claudeAgentInstanceId,
          threadId: asThreadId("thread-send-metrics"),
          cwd: "/tmp/project-send-metrics",
          runtimeMode: "full-access",
        });

        yield* provider.sendTurn({
          threadId: session.threadId,
          input: "hello",
          attachments: [],
        });

        const snapshots = yield* Metric.snapshot;

        assert.equal(
          hasMetricSnapshot(snapshots, "t3_provider_turns_total", {
            provider: ProviderDriverKind.make("claudeAgent"),
            operation: "send",
            outcome: "success",
          }),
          true,
        );
        assert.equal(
          hasMetricSnapshot(snapshots, "t3_provider_turn_duration", {
            provider: ProviderDriverKind.make("claudeAgent"),
            operation: "send",
          }),
          true,
        );
      }),
  );
});

const validation = makeProviderServiceLayer();
validation.layer("ProviderServiceLive validation", (it) => {
  beforeEach(validation.reset);

  it.effect("rejects session starts without an explicit provider instance id", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;

      validation.codex.startSession.mockClear();
      const failure = yield* Effect.flip(
        provider.startSession(asThreadId("thread-missing-instance-id"), {
          provider: ProviderDriverKind.make("codex"),
          threadId: asThreadId("thread-missing-instance-id"),
          runtimeMode: "full-access",
        }),
      );

      assert.instanceOf(failure, ProviderValidationError);
      assert.include(failure.issue, "Provider instance id is required for provider 'codex'.");
      assert.equal(validation.codex.startSession.mock.calls.length, 0);
    }),
  );

  it.effect("rejects mismatched provider kind and provider instance id", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;

      validation.codex.startSession.mockClear();
      validation.claude.startSession.mockClear();
      const failure = yield* Effect.flip(
        provider.startSession(asThreadId("thread-instance-mismatch"), {
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: claudeAgentInstanceId,
          threadId: asThreadId("thread-instance-mismatch"),
          runtimeMode: "full-access",
        }),
      );

      assert.instanceOf(failure, ProviderValidationError);
      assert.include(
        failure.issue,
        "Provider instance 'claudeAgent' belongs to driver 'claudeAgent', not 'codex'.",
      );
      assert.equal(validation.codex.startSession.mock.calls.length, 0);
      assert.equal(validation.claude.startSession.mock.calls.length, 0);
    }),
  );

  it.effect("returns ProviderValidationError for invalid input payloads", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;

      const failure = yield* Effect.result(
        provider.startSession(asThreadId("thread-validation"), {
          threadId: asThreadId("thread-validation"),
          provider: "invalid-provider",
          runtimeMode: "full-access",
        } as never),
      );

      assert.equal(failure._tag, "Failure");
      if (failure._tag !== "Failure") {
        return;
      }
      assert.equal(failure.failure._tag, "ProviderValidationError");
      if (failure.failure._tag !== "ProviderValidationError") {
        return;
      }
      assert.equal(failure.failure.operation, "ProviderService.startSession");
      assert.equal(failure.failure.issue.includes("invalid-provider"), true);
    }),
  );

  it.effect("accepts startSession when adapter has not emitted provider thread id yet", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService;
      const runtimeRepository = yield* ProviderSessionRuntimeRepository;

      validation.codex.startSession.mockImplementationOnce((input: ProviderSessionStartInput) =>
        Effect.sync(() => {
          const now = "2026-01-01T00:00:00.000Z";
          return {
            provider: ProviderDriverKind.make("codex"),
            status: "ready",
            threadId: input.threadId,
            runtimeMode: input.runtimeMode,
            cwd: input.cwd ?? process.cwd(),
            createdAt: now,
            updatedAt: now,
          } satisfies ProviderSession;
        }),
      );

      const session = yield* provider.startSession(asThreadId("thread-missing"), {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: asThreadId("thread-missing"),
        cwd: "/tmp/project",
        runtimeMode: "full-access",
      });

      assert.equal(session.threadId, asThreadId("thread-missing"));

      const runtime = yield* runtimeRepository.getByThreadId({
        threadId: session.threadId,
      });
      assert.equal(Option.isSome(runtime), true);
      if (Option.isSome(runtime)) {
        assert.equal(runtime.value.threadId, session.threadId);
      }
    }),
  );
});
