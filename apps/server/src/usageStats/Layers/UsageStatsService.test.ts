import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ServerSettings,
  type ThreadTokenUsageSnapshot,
  type UsageAccountingSnapshot,
} from "@cafecode/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlError from "effect/unstable/sql/SqlError";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { PersistenceSqlError } from "../../persistence/Errors.ts";

import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../../orchestration/Services/OrchestrationEngine.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import {
  UsageStatsRepository,
  type UsageStatsRepositoryShape,
} from "../../persistence/Services/UsageStats.ts";
import { UsageStatsRepositoryLive } from "../../persistence/Layers/UsageStats.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ServerSettingsService, type ServerSettingsShape } from "../../serverSettings.ts";
import { localDayKey } from "../dayBuckets.ts";
import { UsageStatsService, type UsageStatsServiceShape } from "../Services/UsageStatsService.ts";
import { UsageStatsServiceLive } from "./UsageStatsService.ts";
import { AuxiliaryUsage, AuxiliaryUsageLive } from "../Services/AuxiliaryUsage.ts";
import { makeCodexChildUsageAccounting } from "../../provider/codexChildUsageAccounting.ts";

const THREAD_1 = ThreadId.make("thread-1");
const THREAD_2 = ThreadId.make("thread-2");
const THREAD_3 = ThreadId.make("thread-3");
const CODEX = ProviderDriverKind.make("codex");
const CLAUDE = ProviderDriverKind.make("claudeAgent");
const CODEX_PERSONAL = ProviderInstanceId.make("codex_personal");
const CODEX_WORK = ProviderInstanceId.make("codex_work");

/** Let forked stream consumers subscribe / drain without advancing the clock. */
const settle = Effect.forEach(Array.from({ length: 32 }), () => Effect.yieldNow, {
  discard: true,
});

interface Harness {
  readonly service: UsageStatsServiceShape;
  readonly repository: UsageStatsRepositoryShape;
  readonly emitProvider: (event: Record<string, unknown>) => Effect.Effect<void>;
  readonly emitPresentationOnly: (event: Record<string, unknown>) => Effect.Effect<void>;
  readonly emitDomain: (event: Record<string, unknown>) => Effect.Effect<void>;
  readonly setSessions: (sessions: ReadonlyArray<ProviderSession>) => Effect.Effect<void>;
  readonly setEnabled: (usageStatsEnabled: boolean) => Effect.Effect<void>;
  readonly failNextAccountingWrites: (count: number) => Effect.Effect<void>;
  readonly failAccountingPermanently: Effect.Effect<void>;
  readonly delayNextSessionRead: (millis: number) => Effect.Effect<void>;
  readonly modelTimeReadCount: Effect.Effect<number>;
  readonly setModelTimeBoundary: (startedAt: string) => Effect.Effect<void>;
  readonly holdNextFlush: Effect.Effect<{
    readonly entered: Effect.Effect<void>;
    readonly releaseFailure: Effect.Effect<void>;
  }>;
  readonly holdCommittedFlush: Effect.Effect<{
    readonly entered: Effect.Effect<void>;
    readonly releaseAcknowledgement: Effect.Effect<void>;
  }>;
  readonly closeService: Effect.Effect<void>;
  readonly recordAuxiliary: (
    provider: ProviderDriverKind,
    snapshot: UsageAccountingSnapshot,
    observedAtMs: number,
  ) => Effect.Effect<void>;
  /** Build a second service instance sharing the same database. */
  readonly rebuildService: Effect.Effect<UsageStatsServiceShape, never, Scope.Scope>;
}

const unsupported = <T>() =>
  Effect.die(new Error("Unsupported call in test")) as Effect.Effect<T, never>;

const withHarness = <A, E>(
  body: (harness: Harness) => Effect.Effect<A, E, Scope.Scope>,
  initialTimeMs = 0,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* TestClock.setTime(initialTimeMs);
      const providerPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();
      const domainPubSub = yield* PubSub.unbounded<ServerSettings | OrchestrationEvent>();
      const settingsPubSub = yield* PubSub.unbounded<ServerSettings>();
      const sessionsRef = yield* Ref.make<ReadonlyArray<ProviderSession>>([]);
      const enabledRef = yield* Ref.make(true);
      const accountingFailuresRef = yield* Ref.make(0);
      const sessionReadDelayRef = yield* Ref.make(0);
      const modelTimeReadsRef = yield* Ref.make(0);
      type HeldFlush = {
        readonly commitFirst: boolean;
        readonly entered: Deferred.Deferred<void>;
        readonly release: Deferred.Deferred<void>;
      };
      const heldFlushRef = yield* Ref.make<HeldFlush | undefined>(undefined);

      const providerService = {
        listSessions: () =>
          Effect.gen(function* () {
            const sessions = yield* Ref.get(sessionsRef);
            const delay = yield* Ref.getAndSet(sessionReadDelayRef, 0);
            if (delay > 0) yield* Effect.sleep(delay);
            return sessions;
          }),
        get streamEvents() {
          return Stream.fromPubSub(providerPubSub);
        },
      } as ProviderServiceShape;

      const engineService = {
        readEvents: () => Stream.empty,
        dispatch: () => unsupported(),
        retireThreadForHardDelete: () => unsupported(),
        purgeHardDeletedThread: () => unsupported(),
        diagnosticsSnapshot: unsupported(),
        get streamDomainEvents() {
          return Stream.fromPubSub(domainPubSub) as Stream.Stream<OrchestrationEvent>;
        },
      } as OrchestrationEngineShape;

      const settingsService = {
        start: Effect.void,
        ready: Effect.void,
        getSettings: Effect.map(Ref.get(enabledRef), (usageStatsEnabled) => ({
          ...DEFAULT_SERVER_SETTINGS,
          usageStatsEnabled,
        })),
        updateSettings: () => unsupported(),
        streamChanges: Stream.fromPubSub(settingsPubSub),
      } as ServerSettingsShape;

      const infraContext = yield* Layer.build(
        UsageStatsRepositoryLive.pipe(
          Layer.provideMerge(SqlitePersistenceMemory),
          Layer.provideMerge(AuxiliaryUsageLive),
        ),
      );
      const repository = Context.get(infraContext, UsageStatsRepository);
      const auxiliaryUsage = Context.get(infraContext, AuxiliaryUsage);
      const sql = Context.get(infraContext, SqlClient.SqlClient);
      const observedRepository: UsageStatsRepositoryShape = {
        ...repository,
        readModelGeneratingTime: Ref.update(modelTimeReadsRef, (count) => count + 1).pipe(
          Effect.flatMap(() => repository.readModelGeneratingTime),
        ),
        flushDeltas: (input) =>
          Effect.gen(function* () {
            const held = yield* Ref.getAndSet(heldFlushRef, undefined);
            if (held !== undefined) {
              if (held.commitFirst) yield* repository.flushDeltas(input);
              yield* Deferred.succeed(held.entered, undefined);
              yield* Deferred.await(held.release);
              if (held.commitFirst) return;
              return yield* new PersistenceSqlError({
                operation: "flush-test",
                detail: "synthetic failure",
              });
            }
            yield* repository.flushDeltas(input);
          }),
        recordAccountingSnapshot: (input) =>
          Effect.gen(function* () {
            const failures = yield* Ref.get(accountingFailuresRef);
            if (failures === -1) {
              return yield* new PersistenceSqlError({
                operation: "accounting-test",
                detail: "permanent test failure",
              });
            }
            if (failures > 0) {
              yield* Ref.set(accountingFailuresRef, failures - 1);
              return yield* new PersistenceSqlError({
                operation: "accounting-test",
                detail: "transient test lock",
                cause: new SqlError.SqlError({
                  reason: new SqlError.LockTimeoutError({
                    cause: new Error("locked"),
                    operation: "execute",
                  }),
                }),
              });
            }
            return yield* repository.recordAccountingSnapshot(input);
          }),
      };

      const serviceLayer = UsageStatsServiceLive.pipe(
        Layer.provide(
          Layer.succeedContext(Context.add(infraContext, UsageStatsRepository, observedRepository)),
        ),
        Layer.provide(Layer.succeed(ProviderService, providerService)),
        Layer.provide(Layer.succeed(OrchestrationEngineService, engineService)),
        Layer.provide(Layer.succeed(ServerSettingsService, settingsService)),
      );

      // Layer results are memoized per runtime, so rebuilds must be forced
      // fresh to construct an independent service instance.
      const buildService = Effect.map(Layer.build(Layer.fresh(serviceLayer)), (context) =>
        Context.get(context, UsageStatsService),
      );
      const harnessScope = yield* Scope.Scope;
      const serviceScope = yield* Scope.make();
      yield* Effect.addFinalizer((exit) => Scope.close(serviceScope, exit));
      const service = yield* buildService.pipe(Scope.provide(serviceScope));
      let currentService = service;
      yield* settle;

      return yield* body({
        service,
        repository,
        emitProvider: (event) =>
          Effect.gen(function* () {
            const typedEvent = event as unknown as ProviderRuntimeEvent;
            if (typedEvent.type === "thread.usage-accounting.updated") {
              // Emulate the required ingestion caller without forcing tests
              // of retry timing to await the deliberately delayed commit.
              yield* currentService
                .recordAccounting(
                  typedEvent.provider,
                  typedEvent.payload,
                  Date.parse(typedEvent.createdAt),
                )
                .pipe(Effect.forkScoped);
            }
            yield* PubSub.publish(providerPubSub, typedEvent);
            yield* settle;
          }).pipe(Scope.provide(harnessScope)),
        emitPresentationOnly: (event) =>
          PubSub.publish(providerPubSub, event as unknown as ProviderRuntimeEvent).pipe(
            Effect.flatMap(() => settle),
          ),
        emitDomain: (event) =>
          PubSub.publish(domainPubSub, event as unknown as OrchestrationEvent).pipe(
            Effect.flatMap(() => settle),
          ),
        setSessions: (sessions) => Ref.set(sessionsRef, sessions),
        failNextAccountingWrites: (count) => Ref.set(accountingFailuresRef, count),
        failAccountingPermanently: Ref.set(accountingFailuresRef, -1),
        delayNextSessionRead: (millis) => Ref.set(sessionReadDelayRef, millis),
        modelTimeReadCount: Ref.get(modelTimeReadsRef),
        setModelTimeBoundary: (startedAt) =>
          sql`UPDATE usage_stats_model_generating_time_metadata SET started_at = ${startedAt}`.pipe(
            Effect.asVoid,
            Effect.orDie,
          ),
        holdNextFlush: Effect.gen(function* () {
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          yield* Ref.set(heldFlushRef, { entered, release, commitFirst: false });
          return {
            entered: Deferred.await(entered),
            releaseFailure: Deferred.succeed(release, undefined).pipe(Effect.asVoid),
          };
        }),
        holdCommittedFlush: Effect.gen(function* () {
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          yield* Ref.set(heldFlushRef, { entered, release, commitFirst: true });
          return {
            entered: Deferred.await(entered),
            releaseAcknowledgement: Deferred.succeed(release, undefined).pipe(Effect.asVoid),
          };
        }),
        closeService: Scope.close(serviceScope, Exit.void),
        recordAuxiliary: auxiliaryUsage.record,
        setEnabled: (usageStatsEnabled) =>
          Ref.set(enabledRef, usageStatsEnabled).pipe(
            Effect.flatMap(() =>
              PubSub.publish(settingsPubSub, { ...DEFAULT_SERVER_SETTINGS, usageStatsEnabled }),
            ),
            Effect.flatMap(() => settle),
          ),
        rebuildService: buildService.pipe(
          Effect.tap((rebuilt) => {
            currentService = rebuilt;
            return settle;
          }),
        ),
      });
    }),
  ).pipe(Effect.provide(TestClock.layer()));

function userMessageEvent(threadId: ThreadId, messageId: string, role: "user" | "assistant") {
  return {
    type: "thread.message-sent",
    payload: {
      threadId,
      messageId,
      role,
      text: "hello",
      turnId: null,
      streaming: false,
      createdAt: "2026-07-06T00:00:00.000Z",
      updatedAt: "2026-07-06T00:00:00.000Z",
    },
  };
}

function providerEventBase(
  threadId: ThreadId,
  eventId: string,
  provider: ProviderDriverKind = CODEX,
) {
  return {
    eventId,
    provider,
    threadId,
    createdAt: "2026-07-06T00:00:00.000Z",
  };
}

function tokenUsageEvent(
  threadId: ThreadId,
  eventId: string,
  usage: Partial<Omit<ThreadTokenUsageSnapshot, "usedTokens">>,
  provider: ProviderDriverKind = CODEX,
) {
  return {
    ...providerEventBase(threadId, eventId, provider),
    type: "thread.token-usage.updated",
    payload: { usage: { usedTokens: 1000, ...usage } },
  };
}

function runningSession(
  threadId: ThreadId,
  provider: ProviderDriverKind = CODEX,
  model?: string,
): ProviderSession {
  return {
    provider,
    status: "running",
    runtimeMode: "full-access",
    threadId,
    activeTurnId: TurnId.make(`${threadId}-turn`),
    createdAt: "2026-07-06T00:00:00.000Z",
    updatedAt: "2026-07-06T00:00:00.000Z",
    ...(model !== undefined ? { model } : {}),
  };
}

function accountingEvent(
  revision: number,
  models: UsageAccountingSnapshot["models"],
  scopeId = "10000000-0000-4000-8000-000000000000",
) {
  return {
    ...providerEventBase(THREAD_1, `accounting-${scopeId}-${revision}`, CLAUDE),
    createdAt: new Date(0).toISOString(),
    type: "thread.usage-accounting.updated",
    payload: { scopeId, revision, models, completeness: "complete" },
  };
}

const accountingModel = (
  inputTokens: number,
  outputTokens: number,
  reasoningOutputTokens = 0,
  model = "claude-opus-5",
) => ({
  model,
  inputTokens,
  outputTokens,
  reasoningOutputTokens,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
});

describe("UsageStatsService", () => {
  it.effect("does not replay settled time when the wall clock moves backwards and catches up", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        yield* harness.emitProvider({
          ...providerEventBase(THREAD_1, "clock-start"),
          type: "turn.started",
          payload: { model: "a" },
        });
        yield* TestClock.adjust(1000);
        yield* harness.emitProvider({
          ...providerEventBase(THREAD_1, "clock-settle"),
          type: "model.rerouted",
          payload: { fromModel: "a", toModel: "b" },
        });
        yield* TestClock.setTime(500);
        yield* harness.setEnabled(false);
        yield* harness.setEnabled(true);
        assert.equal((yield* harness.service.get).totals.generatingMs, 1000);
        yield* TestClock.setTime(1500);
        yield* harness.emitProvider({
          ...providerEventBase(THREAD_1, "clock-stop"),
          type: "turn.completed",
          payload: { state: "completed" },
        });
        const detail = yield* harness.service.get;
        assert.equal(detail.totals.generatingMs, 1500);
        assert.deepEqual(detail.modelGeneratingTime?.totals, [
          { provider: CODEX, model: "a", generatingMs: 1000 },
          { provider: CODEX, model: "b", generatingMs: 500 },
        ]);
        yield* harness.service.flush;
        assert.equal((yield* harness.repository.listDays)[0]?.generatingMs, 1500);
        assert.equal(
          (yield* harness.repository.readModelGeneratingTime).days.reduce(
            (total, row) => total + row.generatingMs,
            0,
          ),
          1500,
        );
      }),
    ),
  );

  it.effect(
    "uses unknown for unbounded provider model labels without persisting account or prompt material",
    () =>
      withHarness((harness) =>
        Effect.gen(function* () {
          const oversizedModel = "untrusted".repeat(40);
          yield* harness.setSessions([runningSession(THREAD_1, CODEX, oversizedModel)]);
          yield* harness.emitProvider({
            ...providerEventBase(THREAD_1, "bounded-start"),
            providerInstanceId: CODEX_PERSONAL,
            raw: { source: "test", payload: "synthetic-private-prompt" },
            type: "turn.started",
            payload: { model: oversizedModel },
          });
          yield* TestClock.adjust(1000);
          yield* harness.emitProvider({
            ...providerEventBase(THREAD_1, "bounded-end"),
            type: "turn.completed",
            payload: { state: "completed" },
          });
          yield* harness.service.flush;
          const ledger = yield* harness.repository.readModelGeneratingTime;
          assert.deepEqual(ledger.days, [
            { day: localDayKey(0), provider: CODEX, model: "unknown", generatingMs: 1000 },
          ]);
          for (const privateValue of [CODEX_PERSONAL, "synthetic-private-prompt", oversizedModel])
            assert.notInclude(JSON.stringify(ledger), privateValue);
        }),
      ),
  );

  it.effect(
    "settles repeated starts, reroutes, driver resets and aborts without recoloring elapsed time",
    () =>
      withHarness((harness) =>
        Effect.gen(function* () {
          yield* harness.emitProvider({
            ...providerEventBase(THREAD_1, "time-a"),
            type: "turn.started",
            payload: { model: "a" },
          });
          yield* TestClock.adjust(250);
          yield* harness.emitProvider({
            ...providerEventBase(THREAD_1, "time-b"),
            type: "turn.started",
            payload: { model: "b" },
          });
          yield* TestClock.adjust(250);
          yield* harness.emitProvider({
            ...providerEventBase(THREAD_1, "time-c"),
            type: "model.rerouted",
            payload: { fromModel: "b", toModel: "c" },
          });
          yield* TestClock.adjust(250);
          yield* harness.emitProvider({
            ...providerEventBase(THREAD_1, "time-driver", CLAUDE),
            type: "session.started",
            payload: {},
          });
          yield* TestClock.adjust(250);
          yield* harness.emitProvider({
            ...providerEventBase(THREAD_1, "time-thread", CLAUDE),
            type: "thread.started",
            payload: {},
          });
          yield* TestClock.adjust(250);
          yield* harness.emitProvider({
            ...providerEventBase(THREAD_1, "time-d", CLAUDE),
            type: "model.rerouted",
            payload: { fromModel: "unknown", toModel: "d" },
          });
          yield* TestClock.adjust(250);
          yield* harness.emitProvider({
            ...providerEventBase(THREAD_1, "time-stop", CLAUDE),
            type: "turn.aborted",
            payload: { reason: "interrupted" },
          });
          const result = yield* harness.service.get;
          assert.equal(result.totals.generatingMs, 1500);
          assert.deepEqual(result.modelGeneratingTime?.totals, [
            { provider: CLAUDE, model: "unknown", generatingMs: 500 },
            { provider: CLAUDE, model: "d", generatingMs: 250 },
            { provider: CODEX, model: "a", generatingMs: 250 },
            { provider: CODEX, model: "b", generatingMs: 250 },
            { provider: CODEX, model: "c", generatingMs: 250 },
          ]);
          yield* harness.service.flush;
          assert.equal(
            (yield* harness.repository.readModelGeneratingTime).days.reduce(
              (total, row) => total + row.generatingMs,
              0,
            ),
            1500,
          );
        }),
      ),
  );

  it.effect(
    "keeps an active effective model through redundant same-driver session and thread notifications",
    () =>
      withHarness((harness) =>
        Effect.gen(function* () {
          yield* harness.emitProvider({
            ...providerEventBase(THREAD_1, "known-start"),
            type: "turn.started",
            payload: { model: "known" },
          });
          for (const [index, type] of ["session.started", "thread.started"].entries()) {
            yield* TestClock.adjust(250);
            yield* harness.emitProvider({
              ...providerEventBase(THREAD_1, `duplicate-${index}`),
              type,
              payload: {},
            });
          }
          yield* TestClock.adjust(250);
          yield* harness.emitProvider({
            ...providerEventBase(THREAD_1, "known-end"),
            type: "turn.completed",
            payload: { state: "completed" },
          });
          assert.deepEqual((yield* harness.service.get).modelGeneratingTime?.totals, [
            { provider: CODEX, model: "known", generatingMs: 750 },
          ]);
        }),
      ),
  );

  it.effect(
    "assigns unresolved elapsed time to unknown before an asynchronous session-model read completes",
    () =>
      withHarness((harness) =>
        Effect.gen(function* () {
          yield* harness.setSessions([runningSession(THREAD_1, CODEX, "resolved")]);
          yield* harness.delayNextSessionRead(500);
          yield* harness.emitProvider({
            ...providerEventBase(THREAD_1, "lookup-start"),
            type: "turn.started",
            payload: {},
          });
          yield* TestClock.adjust(250);
          assert.deepEqual((yield* harness.service.get).modelGeneratingTime?.totals, [
            { provider: CODEX, model: "unknown", generatingMs: 250 },
          ]);
          yield* TestClock.adjust(250);
          yield* settle;
          yield* TestClock.adjust(500);
          yield* harness.emitProvider({
            ...providerEventBase(THREAD_1, "lookup-end"),
            type: "turn.completed",
            payload: { state: "completed" },
          });
          assert.deepEqual((yield* harness.service.get).modelGeneratingTime?.totals, [
            { provider: CODEX, model: "resolved", generatingMs: 500 },
            { provider: CODEX, model: "unknown", generatingMs: 500 },
          ]);
        }),
      ),
  );

  it.effect(
    "partitions collection toggles under the old setting and does not charge disabled reroutes",
    () =>
      withHarness((harness) =>
        Effect.gen(function* () {
          yield* harness.emitProvider({
            ...providerEventBase(THREAD_1, "toggle-start"),
            type: "turn.started",
            payload: { model: "a" },
          });
          yield* TestClock.adjust(250);
          yield* harness.setEnabled(false);
          yield* TestClock.adjust(250);
          yield* harness.emitProvider({
            ...providerEventBase(THREAD_1, "toggle-reroute"),
            type: "model.rerouted",
            payload: { fromModel: "a", toModel: "b" },
          });
          yield* TestClock.adjust(250);
          yield* harness.setEnabled(true);
          yield* TestClock.adjust(250);
          yield* harness.emitProvider({
            ...providerEventBase(THREAD_1, "toggle-end"),
            type: "session.exited",
            payload: {},
          });
          const result = yield* harness.service.get;
          assert.equal(result.totals.generatingMs, 500);
          assert.deepEqual(result.modelGeneratingTime?.totals, [
            { provider: CODEX, model: "a", generatingMs: 250 },
            { provider: CODEX, model: "b", generatingMs: 250 },
          ]);
          assert.equal(result.activeSessionCount, 0);
        }),
      ),
  );

  it.effect(
    "overlays all live local-day spans before a tick without counting reads as new work",
    () => {
      const beforeMidnight = new Date(2026, 9, 2, 23, 59, 59, 0).getTime();
      return withHarness(
        (harness) =>
          Effect.gen(function* () {
            yield* harness.setSessions([runningSession(THREAD_1, CODEX, "night")]);
            yield* harness.emitProvider({
              ...providerEventBase(THREAD_1, "midnight-start"),
              type: "turn.started",
              payload: { model: "night" },
            });
            yield* TestClock.adjust(2000);
            const first = yield* harness.service.get;
            const second = yield* harness.service.get;
            assert.deepEqual(first, second);
            assert.equal(first.totals.generatingMs, 2000);
            assert.deepEqual(
              first.days.map(({ day, generatingMs }) => ({ day, generatingMs })),
              [
                { day: localDayKey(beforeMidnight), generatingMs: 1000 },
                { day: localDayKey(beforeMidnight + 2000), generatingMs: 1000 },
              ],
            );
            assert.deepEqual(
              first.modelGeneratingTime?.days.map(({ day, generatingMs }) => ({
                day,
                generatingMs,
              })),
              first.days.map(({ day, generatingMs }) => ({ day, generatingMs })),
            );
            assert.deepEqual((yield* harness.repository.readModelGeneratingTime).days, []);
            assert.equal(yield* harness.modelTimeReadCount, 1);
            assert.notProperty(yield* harness.service.snapshot, "modelGeneratingTime");
            yield* harness.emitProvider({
              ...providerEventBase(THREAD_1, "midnight-end"),
              type: "turn.completed",
              payload: { state: "completed" },
            });
            yield* harness.service.flush;
            assert.deepEqual(
              (yield* harness.service.get).modelGeneratingTime,
              first.modelGeneratingTime,
            );
            yield* harness.closeService;
            const rebuilt = yield* harness.rebuildService;
            assert.deepEqual((yield* rebuilt.get).modelGeneratingTime, first.modelGeneratingTime);
            assert.equal(yield* harness.modelTimeReadCount, 2);
          }),
        beforeMidnight,
      );
    },
  );

  it.effect(
    "requeues the exact failed three-ledger batch alongside concurrently admitted work and survives restart",
    () =>
      withHarness((harness) =>
        Effect.gen(function* () {
          yield* harness.emitProvider({
            ...providerEventBase(THREAD_1, "retry-start"),
            type: "turn.started",
            payload: { model: "a" },
          });
          yield* TestClock.adjust(1000);
          yield* harness.emitProvider({
            ...providerEventBase(THREAD_1, "retry-reroute-1"),
            type: "model.rerouted",
            payload: { fromModel: "a", toModel: "b" },
          });
          yield* harness.emitDomain(userMessageEvent(THREAD_1, "retry-message-1", "user"));
          yield* harness.emitProvider(
            tokenUsageEvent(THREAD_1, "retry-token-1", { outputTokens: 10 }),
          );
          const held = yield* harness.holdNextFlush;
          const flushing = yield* harness.service.flush.pipe(Effect.forkScoped);
          yield* held.entered;
          yield* TestClock.adjust(1000);
          yield* harness.emitProvider({
            ...providerEventBase(THREAD_1, "retry-reroute-2"),
            type: "model.rerouted",
            payload: { fromModel: "b", toModel: "c" },
          });
          yield* harness.emitDomain(userMessageEvent(THREAD_1, "retry-message-2", "user"));
          yield* harness.emitProvider(
            tokenUsageEvent(THREAD_1, "retry-token-2", { outputTokens: 15 }),
          );
          yield* held.releaseFailure;
          yield* Fiber.join(flushing);
          assert.deepEqual(yield* harness.repository.listDays, []);
          assert.deepEqual(yield* harness.repository.listTokenBreakdownDays, []);
          assert.deepEqual((yield* harness.repository.readModelGeneratingTime).days, []);
          yield* harness.emitProvider({
            ...providerEventBase(THREAD_1, "retry-end"),
            type: "turn.aborted",
            payload: { reason: "interrupted" },
          });
          const before = yield* harness.service.get;
          yield* harness.service.flush;
          yield* harness.service.flush;
          const stored = (yield* harness.repository.listDays)[0]!;
          assert.equal(stored.generatingMs, 2000);
          assert.equal(stored.userMessages, 2);
          assert.equal(stored.outputTokens, 15);
          assert.deepEqual(
            (yield* harness.repository.readModelGeneratingTime).days,
            before.modelGeneratingTime?.days,
          );
          yield* harness.closeService;
          const rebuilt = yield* harness.rebuildService;
          assert.deepEqual((yield* rebuilt.get).modelGeneratingTime, before.modelGeneratingTime);
          assert.equal((yield* rebuilt.snapshot).totals.generatingMs, 2000);
        }),
      ),
  );

  it.effect(
    "settles an admitted committed batch before honoring cancellation and never replays its charge",
    () =>
      withHarness((harness) =>
        Effect.gen(function* () {
          yield* harness.emitProvider({
            ...providerEventBase(THREAD_1, "interrupt-start"),
            type: "turn.started",
            payload: { model: "a" },
          });
          yield* TestClock.adjust(1000);
          yield* harness.emitProvider({
            ...providerEventBase(THREAD_1, "interrupt-end"),
            type: "turn.aborted",
            payload: { reason: "interrupted" },
          });
          yield* harness.emitDomain(userMessageEvent(THREAD_1, "interrupt-message", "user"));
          yield* harness.emitProvider(
            tokenUsageEvent(THREAD_1, "interrupt-token", { outputTokens: 7 }),
          );
          const held = yield* harness.holdCommittedFlush;
          const flushing = yield* harness.service.flush.pipe(Effect.forkScoped);
          yield* held.entered;
          assert.equal((yield* harness.repository.listDays)[0]?.generatingMs, 1000);
          const cancelling = yield* Fiber.interrupt(flushing).pipe(Effect.forkScoped);
          yield* settle;
          yield* held.releaseAcknowledgement;
          yield* Fiber.join(cancelling);
          yield* harness.service.flush;
          assert.equal((yield* harness.repository.listDays)[0]?.generatingMs, 1000);
          assert.equal((yield* harness.repository.listTokenBreakdownDays)[0]?.outputTokens, 7);
          assert.equal(
            (yield* harness.repository.readModelGeneratingTime).days[0]?.generatingMs,
            1000,
          );
        }),
      ),
  );

  it.effect(
    "waits for an admitted periodic flush before shutdown retries the whole failed batch",
    () =>
      withHarness((harness) =>
        Effect.gen(function* () {
          yield* harness.setSessions([runningSession(THREAD_1, CODEX, "a")]);
          yield* harness.emitProvider({
            ...providerEventBase(THREAD_1, "shutdown-start"),
            type: "turn.started",
            payload: { model: "a" },
          });
          yield* harness.emitDomain(userMessageEvent(THREAD_1, "shutdown-message", "user"));
          yield* harness.emitProvider(
            tokenUsageEvent(THREAD_1, "shutdown-token", { outputTokens: 7 }),
          );
          const held = yield* harness.holdNextFlush;
          yield* TestClock.adjust(5000);
          yield* held.entered;
          const closing = yield* harness.closeService.pipe(Effect.forkScoped);
          yield* settle;
          assert.deepEqual(yield* harness.repository.listDays, []);
          yield* held.releaseFailure;
          yield* Fiber.join(closing);
          assert.equal((yield* harness.repository.listDays)[0]?.generatingMs, 5000);
          assert.equal((yield* harness.repository.listTokenBreakdownDays)[0]?.outputTokens, 7);
          assert.equal(
            (yield* harness.repository.readModelGeneratingTime).days[0]?.generatingMs,
            5000,
          );
        }),
      ),
  );

  it.effect(
    "keeps model-time unavailable for corrupt metadata and for unsafe combined history or live time",
    () =>
      withHarness((harness) =>
        Effect.gen(function* () {
          yield* harness.closeService;
          yield* harness.setModelTimeBoundary("2026-02-30T00:00:00.000Z");
          const invalidScope = yield* Scope.make();
          const invalid = yield* harness.rebuildService.pipe(Scope.provide(invalidScope));
          assert.notProperty(yield* invalid.get, "modelGeneratingTime");
          assert.equal((yield* invalid.snapshot).totals.generatingMs, 0);
          yield* Scope.close(invalidScope, Exit.void);
          yield* harness.setModelTimeBoundary("2026-10-02T00:00:00.000Z");
          yield* harness.repository.flushDeltas({
            days: [],
            tokenBreakdowns: [],
            modelGeneratingTimes: [
              {
                day: "2020-01-01",
                provider: CODEX,
                model: "a",
                generatingMs: Number.MAX_SAFE_INTEGER,
              },
            ],
          });
          const largeScope = yield* Scope.make();
          const large = yield* harness.rebuildService.pipe(Scope.provide(largeScope));
          assert.equal(
            (yield* large.get).modelGeneratingTime?.totals[0]?.generatingMs,
            Number.MAX_SAFE_INTEGER,
          );
          yield* harness.emitProvider({
            ...providerEventBase(THREAD_1, "overflow-start"),
            type: "turn.started",
            payload: { model: "b" },
          });
          yield* TestClock.adjust(1);
          assert.notProperty(yield* large.get, "modelGeneratingTime");
          yield* harness.emitProvider({
            ...providerEventBase(THREAD_1, "overflow-end"),
            type: "turn.aborted",
            payload: { reason: "interrupted" },
          });
          yield* large.flush;
          yield* Scope.close(largeScope, Exit.void);
          const overflowed = yield* harness.rebuildService;
          assert.notProperty(yield* overflowed.get, "modelGeneratingTime");
          assert.equal((yield* harness.repository.readModelGeneratingTime).days.length, 2);
        }),
      ),
  );

  it.effect("never acknowledges permanent accounting storage failure and bounds shutdown", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        yield* harness.failAccountingPermanently;
        let acknowledged = false;
        const event = accountingEvent(1, [accountingModel(1000, 100)]);
        const caller = yield* harness.service
          .recordAccounting(CLAUDE, event.payload as UsageAccountingSnapshot, 0)
          .pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                acknowledged = true;
              }),
            ),
            Effect.forkChild,
          );
        yield* settle;
        yield* TestClock.adjust(5_000);
        assert.equal(acknowledged, false);
        assert.deepEqual(yield* harness.repository.listDays, []);
        const closing = yield* harness.closeService.pipe(Effect.forkChild);
        yield* settle;
        yield* TestClock.adjust(2_000);
        yield* Fiber.join(closing);
        assert.equal(acknowledged, false);
        yield* Fiber.interrupt(caller);
      }),
    ),
  );
  it.effect(
    "requires acknowledged ingestion instead of billing from an independent subscriber",
    () =>
      withHarness((harness) =>
        Effect.gen(function* () {
          const event = accountingEvent(1, [accountingModel(1000, 100)]);
          yield* harness.emitPresentationOnly(event);
          assert.equal((yield* harness.service.get).totals.inputTokens, 0);
          yield* harness.service.recordAccounting(
            CLAUDE,
            event.payload as UsageAccountingSnapshot,
            Date.parse(event.createdAt),
          );
          assert.equal((yield* harness.service.get).totals.inputTokens, 1000);
          // Replay after a cursor/write crash must remain exactly once in SQLite.
          const rebuilt = yield* harness.rebuildService;
          yield* rebuilt.recordAccounting(
            CLAUDE,
            event.payload as UsageAccountingSnapshot,
            Date.parse(event.createdAt),
          );
          assert.equal((yield* rebuilt.get).totals.inputTokens, 1000);
        }),
      ),
  );
  it.effect(
    "settles prospective child usage once alongside root tokens across a database-backed rebuild",
    () =>
      withHarness((harness) =>
        Effect.gen(function* () {
          const child = makeCodexChildUsageAccounting();
          const routes = new Map([["child", "owner-turn"]]);
          child.observeMetadata(
            { id: "child", parentThreadId: "root", model: "gpt-6.1-sol" },
            "root",
          );
          const observe = (inputTokens: number, outputTokens: number) =>
            child.observe({
              rootId: "root",
              routes,
              method: "thread/tokenUsage/updated",
              payload: {
                threadId: "child",
                tokenUsage: {
                  total: {
                    inputTokens,
                    outputTokens,
                    cachedInputTokens: 0,
                    reasoningOutputTokens: 0,
                  },
                },
              },
            });
          assert.equal(observe(1_000, 100), undefined);
          const first = observe(1_100, 110)!;
          yield* harness.emitProvider({
            ...providerEventBase(THREAD_1, "root-start"),
            type: "session.started",
            payload: {},
          });
          yield* harness.emitProvider(
            tokenUsageEvent(THREAD_1, "root-tokens", {
              totalInputTokens: 200,
              totalOutputTokens: 20,
            }),
          );
          yield* harness.service.recordAccounting(CODEX, first, 0);
          yield* harness.service.recordAccounting(CODEX, first, 0);
          yield* harness.service.flush;
          assert.equal((yield* harness.service.get).totals.inputTokens, 300);
          assert.equal((yield* harness.service.get).totals.outputTokens, 30);
          const rebuilt = yield* harness.rebuildService;
          yield* rebuilt.recordAccounting(CODEX, first, 0);
          const next = observe(1_125, 115)!;
          yield* rebuilt.recordAccounting(CODEX, next, 0);
          yield* rebuilt.recordAccounting(CODEX, first, 0);
          const result = yield* rebuilt.get;
          assert.equal(result.totals.inputTokens, 325);
          assert.equal(result.totals.outputTokens, 35);
          assert.equal(
            result.tokenBreakdown.find((row) => row.model === "gpt-6.1-sol")?.inputTokens,
            125,
          );
          assert.equal((yield* harness.repository.listDays)[0]?.inputTokens, 325);
        }),
      ),
  );

  it.effect("settles acknowledged auxiliary usage through the same durable model/day ledger", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const snapshot: UsageAccountingSnapshot = {
          scopeId: "90000000-0000-4000-8000-000000000000",
          revision: 1,
          completeness: "complete",
          models: [accountingModel(100, 10, 0, "gpt-5.4-mini")],
        };
        yield* harness.recordAuxiliary(CODEX, snapshot, 0);
        yield* harness.recordAuxiliary(CODEX, snapshot, 0);
        const result = yield* harness.service.get;
        assert.equal(result.totals.inputTokens, 100);
        assert.equal(result.totals.outputTokens, 10);
        assert.equal(result.tokenBreakdownDays?.[0]?.provider, CODEX);
        assert.equal(result.tokenBreakdownDays?.[0]?.model, "gpt-5.4-mini");
        assert.equal((yield* harness.repository.listDays)[0]?.inputTokens, 100);
      }),
    ),
  );
  it.effect("retains unreported helper model counts exactly once across replay and rebuild", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const snapshot: UsageAccountingSnapshot = {
          scopeId: "90000000-0000-4000-8000-000000000001",
          revision: 1,
          completeness: "complete",
          models: [
            {
              ...accountingModel(20_511, 16, 0, "unknown"),
              cachedInputTokens: 9_984,
            },
          ],
        };
        yield* harness.recordAuxiliary(CODEX, snapshot, 0);
        yield* harness.recordAuxiliary(CODEX, snapshot, 0);
        // A missing model is missing attribution, not missing numeric usage.
        // Rebuilding must keep both the tiny output and its much larger input
        // without assigning the helper's requested model or charging a replay.
        const rebuilt = yield* harness.rebuildService;
        yield* rebuilt.recordAccounting(CODEX, snapshot, 0);
        const result = yield* rebuilt.get;
        assert.equal(result.totals.inputTokens, 20_511);
        assert.equal(result.totals.cachedInputTokens, 9_984);
        assert.equal(result.totals.outputTokens, 16);
        assert.equal(result.tokenBreakdown.length, 1);
        assert.deepEqual(result.tokenBreakdown[0], { ...snapshot.models[0], provider: CODEX });
        assert.equal((yield* harness.repository.listDays)[0]?.outputTokens, 16);
      }),
    ),
  );
  it.effect(
    "keeps per-day billing models through delayed replay/rebuild and excludes them from hot snapshots",
    () =>
      withHarness((harness) =>
        Effect.gen(function* () {
          // The test clock starts at epoch zero. Use an earlier event instead of
          // advancing a 5-second periodic service clock through decades of ticks.
          const originalAt = -2 * 86_400_000;
          const observedDay = localDayKey(originalAt);
          const event = {
            ...accountingEvent(1, [accountingModel(201000, 1234)]),
            createdAt: new Date(originalAt).toISOString(),
          };
          // Receiver time is later; attribution remains on the event's canonical
          // original observation day even after a daemon reconnect.
          yield* harness.emitProvider(event);
          const first = yield* harness.service.get;
          assert.equal(first.tokenBreakdownDays?.[0]?.day, observedDay);
          assert.equal(first.tokenBreakdownDays?.[0]?.inputTokens, 201000);
          assert.equal("tokenBreakdownDays" in (yield* harness.service.snapshot), false);
          const rebuilt = yield* harness.rebuildService;
          assert.deepEqual((yield* rebuilt.get).tokenBreakdownDays, first.tokenBreakdownDays);
          yield* harness.emitProvider(event);
          assert.equal((yield* rebuilt.get).totals.inputTokens, 201000);
          assert.equal((yield* harness.repository.listDays)[0]?.inputTokens, 201000);
        }),
      ),
  );

  it.effect(
    "retains a terminal accounting snapshot across transient database failures without a later provider event",
    () =>
      withHarness((harness) =>
        Effect.gen(function* () {
          yield* harness.failNextAccountingWrites(2);
          yield* harness.emitProvider(accountingEvent(1, [accountingModel(1000, 100)]));
          assert.equal((yield* harness.service.snapshot).totals.inputTokens, 0);
          yield* TestClock.adjust(100);
          yield* settle;
          yield* TestClock.adjust(200);
          yield* settle;
          assert.equal((yield* harness.service.snapshot).totals.inputTokens, 1000);
          assert.equal((yield* harness.repository.listDays)[0]?.inputTokens, 1000);
        }),
      ),
  );

  it.effect(
    "bounds shutdown drain during persistent lock contention and recovers an uncommitted snapshot by replay",
    () =>
      withHarness((harness) =>
        Effect.gen(function* () {
          yield* harness.failNextAccountingWrites(100);
          const event = accountingEvent(1, [accountingModel(1000, 100)]);
          yield* harness.emitProvider(event);
          const closing = yield* harness.closeService.pipe(Effect.forkChild);
          yield* settle;
          yield* TestClock.adjust(2_000);
          yield* Fiber.join(closing);
          assert.deepEqual(yield* harness.repository.listDays, []);
          yield* harness.failNextAccountingWrites(0);
          const rebuilt = yield* harness.rebuildService;
          yield* harness.emitProvider(event);
          assert.equal((yield* rebuilt.get).totals.inputTokens, 1000);
          yield* harness.emitProvider(event);
          assert.equal((yield* rebuilt.get).totals.inputTokens, 1000);
        }),
      ),
  );

  it.effect("drains an admitted final snapshot before the accounting worker is stopped", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        yield* harness.failNextAccountingWrites(1);
        yield* harness.emitProvider(accountingEvent(1, [accountingModel(1000, 100)]));
        const closing = yield* harness.closeService.pipe(Effect.forkChild);
        yield* settle;
        yield* TestClock.adjust(100);
        yield* Fiber.join(closing);
        assert.equal((yield* harness.repository.listDays)[0]?.inputTokens, 1000);
      }),
    ),
  );

  it.effect(
    "preserves collection enablement at accounting admission while its transaction retries",
    () =>
      withHarness((harness) =>
        Effect.gen(function* () {
          yield* harness.failNextAccountingWrites(1);
          yield* harness.emitProvider(accountingEvent(1, [accountingModel(100, 10)]));
          yield* harness.setEnabled(false);
          yield* TestClock.adjust(100);
          yield* settle;
          assert.equal((yield* harness.service.snapshot).totals.inputTokens, 100);
          yield* harness.emitProvider(accountingEvent(2, [accountingModel(200, 20)]));
          yield* harness.setEnabled(true);
          yield* harness.emitProvider(accountingEvent(3, [accountingModel(250, 25)]));
          assert.equal((yield* harness.service.snapshot).totals.inputTokens, 150);
          assert.equal((yield* harness.service.get).tokenBreakdownDays?.[0]?.inputTokens, 150);
        }),
      ),
  );
  it.effect("counts user chat messages and persists them on flush", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        yield* harness.emitDomain(userMessageEvent(THREAD_1, "m1", "user"));
        yield* harness.emitDomain(userMessageEvent(THREAD_1, "m2", "assistant"));
        yield* harness.emitDomain(userMessageEvent(THREAD_2, "m3", "user"));

        const snapshot = yield* harness.service.snapshot;
        assert.equal(snapshot.totals.userMessages, 2);

        yield* harness.service.flush;
        const rows = yield* harness.repository.listDays;
        assert.equal(rows.length, 1);
        assert.equal(rows[0]?.userMessages, 2);
      }),
    ),
  );

  it.effect("accumulates growing per-message token counters, counting resets in full", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        // Claude-style: grows during one message, resets for the next.
        for (const [index, outputTokens] of [3, 120, 450, 2, 200].entries()) {
          yield* harness.emitProvider(tokenUsageEvent(THREAD_1, `t${index}`, { outputTokens }));
        }
        const snapshot = yield* harness.service.snapshot;
        assert.equal(snapshot.totals.outputTokens, 650);
      }),
    ),
  );

  it.effect("excludes Claude context/request snapshots from billed throughput", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        // message_start emits zeroes before each new message. Those explicit
        // resets make a later message whose first/final count exceeds the
        // previous watermark unambiguous instead of silently undercounting it.
        const messages = [
          { outputTokens: 0, reasoningOutputTokens: 0 },
          { outputTokens: 100, reasoningOutputTokens: 40 },
          { outputTokens: 0, reasoningOutputTokens: 0 },
          { outputTokens: 150, reasoningOutputTokens: 60 },
        ];
        for (const [index, usage] of messages.entries()) {
          yield* harness.emitProvider(
            tokenUsageEvent(THREAD_1, `reasoning-reset-${index}`, usage, CLAUDE),
          );
        }

        const snapshot = yield* harness.service.snapshot;
        assert.equal(snapshot.totals.outputTokens, 0);
        assert.equal(snapshot.totals.reasoningOutputTokens, 0);
      }),
    ),
  );

  it.effect("settles Claude query billing once independently of cumulative context reasoning", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        yield* harness.emitProvider({
          ...providerEventBase(THREAD_1, "reasoning-session-start", CLAUDE),
          type: "session.started",
          payload: {},
        });
        const snapshots: Array<Partial<Omit<ThreadTokenUsageSnapshot, "usedTokens">>> = [
          // First message streams before a cumulative ModelUsage result exists.
          { reasoningOutputTokens: 0 },
          { reasoningOutputTokens: 40 },
          // The terminal result includes 10 additional subagent/sidechain
          // thinking tokens. UsageStats should count only that delta here.
          { reasoningOutputTokens: 40, totalReasoningOutputTokens: 50 },
          // The adapter carries the cumulative field through the next
          // message's reset/growth so per-message thinking is not recounted.
          { reasoningOutputTokens: 0, totalReasoningOutputTokens: 50 },
          { reasoningOutputTokens: 60, totalReasoningOutputTokens: 50 },
          // The next terminal cumulative total accounts for the complete
          // query pipeline exactly once.
          { reasoningOutputTokens: 60, totalReasoningOutputTokens: 120 },
          { reasoningOutputTokens: 60, totalReasoningOutputTokens: 120 },
        ];
        for (const [index, usage] of snapshots.entries()) {
          yield* harness.emitProvider(
            tokenUsageEvent(THREAD_1, `reasoning-total-${index}`, usage, CLAUDE),
          );
        }

        yield* harness.emitProvider(accountingEvent(1, [accountingModel(1000, 100, 50)]));
        yield* harness.emitProvider(accountingEvent(2, [accountingModel(2200, 240, 120)]));
        yield* harness.emitProvider(accountingEvent(2, [accountingModel(2200, 240, 120)]));
        const snapshot = yield* harness.service.snapshot;
        assert.equal(snapshot.totals.reasoningOutputTokens, 120);
        assert.equal(snapshot.totals.outputTokens, 240);
        assert.equal(snapshot.totals.inputTokens, 2200);
      }),
    ),
  );

  it.effect("seeds unwitnessed session-cumulative counters instead of recounting history", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        // Reattach: no session.started seen for thread-1 this process.
        yield* harness.emitProvider(tokenUsageEvent(THREAD_1, "r0", { totalOutputTokens: 9000 }));
        yield* harness.emitProvider(tokenUsageEvent(THREAD_1, "r1", { totalOutputTokens: 9100 }));

        // Fresh session: witnessed start, duplicate notification included.
        yield* harness.emitProvider({
          ...providerEventBase(THREAD_2, "s0"),
          type: "session.started",
          payload: {},
        });
        for (const [index, totalOutputTokens] of [250, 560, 560].entries()) {
          yield* harness.emitProvider(
            tokenUsageEvent(THREAD_2, `c${index}`, { totalOutputTokens }),
          );
        }

        const snapshot = yield* harness.service.snapshot;
        assert.equal(snapshot.totals.outputTokens, 100 + 560);
      }),
    ),
  );

  it.effect("falls back to turn-completed usage only when no usage events were seen", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        // Completion-only usage: no token-usage events, per-turn totals on completion.
        yield* harness.emitProvider({
          ...providerEventBase(THREAD_1, "g0"),
          type: "turn.started",
          payload: {},
        });
        yield* harness.emitProvider({
          ...providerEventBase(THREAD_1, "g1"),
          type: "turn.completed",
          payload: {
            state: "completed",
            usage: { inputTokens: 900, outputTokens: 100, thoughtTokens: 20 },
          },
        });

        // Codex/Claude-style: usage events seen, completion usage must not double count.
        yield* harness.emitProvider({
          ...providerEventBase(THREAD_2, "g2"),
          type: "turn.started",
          payload: {},
        });
        yield* harness.emitProvider(tokenUsageEvent(THREAD_2, "g3", { outputTokens: 40 }));
        yield* harness.emitProvider({
          ...providerEventBase(THREAD_2, "g4"),
          type: "turn.completed",
          payload: { state: "completed", usage: { outputTokens: 40 } },
        });

        const snapshot = yield* harness.service.snapshot;
        assert.equal(snapshot.totals.outputTokens, 120 + 40);
      }),
    ),
  );

  it.effect("persists output tokens by provider driver and effective model", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        yield* harness.setSessions([
          runningSession(THREAD_1, CODEX, "gpt-5.6-codex"),
          runningSession(THREAD_2, CLAUDE, "claude-opus-5"),
        ]);

        // Codex turn-start notifications do not currently include the model,
        // so attribution resolves it once from the live provider session.
        yield* harness.emitProvider({
          ...providerEventBase(THREAD_1, "p0", CODEX),
          providerInstanceId: CODEX_PERSONAL,
          type: "turn.started",
          payload: {},
        });
        yield* harness.emitProvider({
          ...tokenUsageEvent(THREAD_1, "p1", { outputTokens: 100 }, CODEX),
          providerInstanceId: CODEX_PERSONAL,
        });

        // A second configured account using the same driver/model aggregates
        // into the same row; account instance ids are not usage dimensions.
        yield* harness.emitProvider({
          ...providerEventBase(THREAD_3, "p-account-0", CODEX),
          providerInstanceId: CODEX_WORK,
          type: "turn.started",
          payload: { model: "gpt-5.6-codex" },
        });
        yield* harness.emitProvider({
          ...tokenUsageEvent(THREAD_3, "p-account-1", { outputTokens: 25 }, CODEX),
          providerInstanceId: CODEX_WORK,
        });

        // Claude/OpenCode can provide the selected model directly on turn
        // start, avoiding the session lookup.
        yield* harness.emitProvider({
          ...providerEventBase(THREAD_2, "p2", CLAUDE),
          type: "turn.started",
          payload: { model: "claude-opus-5" },
        });
        yield* harness.emitProvider(accountingEvent(1, [accountingModel(0, 70)]));

        // Subsequent deltas belong to the effective rerouted model.
        yield* harness.emitProvider({
          ...providerEventBase(THREAD_1, "p4", CODEX),
          type: "model.rerouted",
          payload: {
            fromModel: "gpt-5.6-codex",
            toModel: "gpt-5.6-codex-mini",
            reason: "capacity",
          },
        });
        yield* harness.emitProvider(tokenUsageEvent(THREAD_1, "p5", { outputTokens: 150 }, CODEX));

        yield* harness.service.flush;
        const expectedRows = [
          {
            day: localDayKey(0),
            provider: CLAUDE,
            model: "claude-opus-5",
            outputTokens: 70,
            inputTokens: 0,
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
            reasoningOutputTokens: 0,
          },
          {
            day: localDayKey(0),
            provider: CODEX,
            model: "gpt-5.6-codex",
            outputTokens: 125,
            inputTokens: 0,
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
            reasoningOutputTokens: 0,
          },
          {
            day: localDayKey(0),
            provider: CODEX,
            model: "gpt-5.6-codex-mini",
            outputTokens: 50,
            inputTokens: 0,
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
            reasoningOutputTokens: 0,
          },
        ];
        assert.deepEqual(yield* harness.repository.listTokenBreakdownDays, expectedRows);

        const expectedLifetimeBreakdown = expectedRows.map(({ day: _day, ...row }) => row);
        assert.deepEqual((yield* harness.service.get).tokenBreakdown, expectedLifetimeBreakdown);

        // A fresh process must reconstruct the same lifetime view from the
        // daily ledger without a Settings-page SQL query.
        const rebuiltService = yield* harness.rebuildService;
        assert.deepEqual((yield* rebuiltService.get).tokenBreakdown, expectedLifetimeBreakdown);
      }),
    ),
  );

  it.effect("accrues generating time per concurrent session", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        yield* harness.setSessions([runningSession(THREAD_1), runningSession(THREAD_2)]);
        yield* harness.emitProvider({
          ...providerEventBase(THREAD_1, "a0"),
          providerInstanceId: CODEX_PERSONAL,
          type: "turn.started",
          payload: {},
        });
        yield* harness.emitProvider({
          ...providerEventBase(THREAD_2, "a1"),
          providerInstanceId: CODEX_WORK,
          type: "turn.started",
          payload: {},
        });

        yield* TestClock.adjust("10 seconds");
        yield* settle;

        const running = yield* harness.service.snapshot;
        assert.equal(running.activeSessionCount, 2);
        assert.equal(running.totals.generatingMs, 20_000);

        yield* harness.emitProvider({
          ...providerEventBase(THREAD_1, "a2"),
          type: "turn.completed",
          payload: { state: "completed" },
        });
        yield* harness.emitProvider({
          ...providerEventBase(THREAD_2, "a3"),
          type: "turn.aborted",
          payload: { reason: "interrupted" },
        });

        const stopped = yield* harness.service.snapshot;
        assert.equal(stopped.activeSessionCount, 0);
        assert.equal(stopped.totals.generatingMs, 20_000);
        assert.equal(stopped.today.generatingMs, 20_000);
        const detail = yield* harness.service.get;
        assert.deepEqual(detail.modelGeneratingTime?.totals, [
          { provider: CODEX, model: "unknown", generatingMs: 20_000 },
        ]);
        assert.notInclude(JSON.stringify(detail.modelGeneratingTime), CODEX_PERSONAL);
        assert.notInclude(JSON.stringify(detail.modelGeneratingTime), CODEX_WORK);
      }),
    ),
  );

  it.effect("stops accruing when the provider session disappears without a terminal event", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        yield* harness.setSessions([runningSession(THREAD_1)]);
        yield* harness.emitProvider({
          ...providerEventBase(THREAD_1, "z0"),
          type: "turn.started",
          payload: {},
        });

        yield* TestClock.adjust("5 seconds");
        yield* settle;
        yield* harness.setSessions([]);
        yield* TestClock.adjust("5 seconds");
        yield* settle;

        // The second tick accrued up to its own timestamp and then dropped the
        // accrual cursor; time must stop advancing afterwards.
        const afterDrop = yield* harness.service.snapshot;
        assert.equal(afterDrop.activeSessionCount, 0);
        assert.equal(afterDrop.totals.generatingMs, 10_000);

        yield* TestClock.adjust("5 seconds");
        yield* settle;
        const later = yield* harness.service.snapshot;
        assert.equal(later.totals.generatingMs, 10_000);
        assert.deepEqual((yield* harness.service.get).modelGeneratingTime?.totals, [
          { provider: CODEX, model: "unknown", generatingMs: 10_000 },
        ]);
      }),
    ),
  );

  it.effect("gates collection on the usageStatsEnabled setting without restarting", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        yield* harness.emitDomain(userMessageEvent(THREAD_1, "m1", "user"));
        yield* harness.setEnabled(false);
        yield* harness.emitDomain(userMessageEvent(THREAD_1, "m2", "user"));
        yield* harness.emitProvider(tokenUsageEvent(THREAD_1, "d0", { outputTokens: 500 }));

        const disabled = yield* harness.service.snapshot;
        assert.equal(disabled.collectionEnabled, false);
        assert.equal(disabled.totals.userMessages, 1);
        assert.equal(disabled.totals.outputTokens, 0);

        yield* harness.setEnabled(true);
        yield* harness.emitDomain(userMessageEvent(THREAD_1, "m3", "user"));
        // Watermark advanced while disabled, so re-enabling counts only growth.
        yield* harness.emitProvider(tokenUsageEvent(THREAD_1, "d1", { outputTokens: 530 }));

        const enabled = yield* harness.service.snapshot;
        assert.equal(enabled.collectionEnabled, true);
        assert.equal(enabled.totals.userMessages, 2);
        assert.equal(enabled.totals.outputTokens, 30);
      }),
    ),
  );

  it.effect("flushes pending deltas when its scope closes", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        const innerScope = yield* Scope.make();
        const rebuilt = yield* harness.rebuildService.pipe(Scope.provide(innerScope));
        yield* harness.emitDomain(userMessageEvent(THREAD_1, "m1", "user"));
        const snapshot = yield* rebuilt.snapshot;
        assert.equal(snapshot.totals.userMessages, 1);

        yield* Scope.close(innerScope, Exit.void);

        const rows = yield* harness.repository.listDays;
        assert.equal(
          rows.reduce((total, row) => total + row.userMessages, 0),
          1,
        );
      }),
    ),
  );

  it.effect("hydrates lifetime totals from previously flushed days", () =>
    withHarness((harness) =>
      Effect.gen(function* () {
        yield* harness.repository.flushDeltas({
          days: [
            {
              day: "2020-01-01",
              generatingMs: 60_000,
              outputTokens: 5000,
              userMessages: 7,
              inputTokens: 0,
              cachedInputTokens: 0,
              cacheWriteInputTokens: 0,
              reasoningOutputTokens: 0,
            },
          ],
          tokenBreakdowns: [],
        });
        const persisted = yield* harness.repository.listDays;
        assert.equal(persisted.length, 1);
        const rebuilt = yield* harness.rebuildService;
        const snapshot = yield* rebuilt.snapshot;
        assert.equal(snapshot.totals.outputTokens, 5000);
        assert.equal(snapshot.totals.userMessages, 7);
        assert.equal(snapshot.totals.generatingMs, 60_000);
        assert.deepEqual((yield* rebuilt.get).modelGeneratingTime?.totals, []);
        assert.deepEqual((yield* rebuilt.get).modelGeneratingTime?.days, []);
      }),
    ),
  );
});
