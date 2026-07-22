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
} from "@cafecode/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

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
import { UsageStatsService, type UsageStatsServiceShape } from "../Services/UsageStatsService.ts";
import { UsageStatsServiceLive } from "./UsageStatsService.ts";

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
  readonly emitDomain: (event: Record<string, unknown>) => Effect.Effect<void>;
  readonly setSessions: (sessions: ReadonlyArray<ProviderSession>) => Effect.Effect<void>;
  readonly setEnabled: (usageStatsEnabled: boolean) => Effect.Effect<void>;
  /** Build a second service instance sharing the same database. */
  readonly rebuildService: Effect.Effect<UsageStatsServiceShape, never, Scope.Scope>;
}

const withHarness = <A, E>(body: (harness: Harness) => Effect.Effect<A, E, Scope.Scope>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const providerPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();
      const domainPubSub = yield* PubSub.unbounded<ServerSettings | OrchestrationEvent>();
      const settingsPubSub = yield* PubSub.unbounded<ServerSettings>();
      const sessionsRef = yield* Ref.make<ReadonlyArray<ProviderSession>>([]);
      const enabledRef = yield* Ref.make(true);

      const unsupported = <T>() =>
        Effect.die(new Error("Unsupported call in test")) as Effect.Effect<T, never>;

      const providerService = {
        listSessions: () => Ref.get(sessionsRef),
        get streamEvents() {
          return Stream.fromPubSub(providerPubSub);
        },
      } as ProviderServiceShape;

      const engineService = {
        readEvents: () => Stream.empty,
        dispatch: () => unsupported(),
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
        UsageStatsRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
      );
      const repository = Context.get(infraContext, UsageStatsRepository);

      const serviceLayer = UsageStatsServiceLive.pipe(
        Layer.provide(Layer.succeedContext(infraContext)),
        Layer.provide(Layer.succeed(ProviderService, providerService)),
        Layer.provide(Layer.succeed(OrchestrationEngineService, engineService)),
        Layer.provide(Layer.succeed(ServerSettingsService, settingsService)),
      );

      // Layer results are memoized per runtime, so rebuilds must be forced
      // fresh to construct an independent service instance.
      const buildService = Effect.map(Layer.build(Layer.fresh(serviceLayer)), (context) =>
        Context.get(context, UsageStatsService),
      );
      const service = yield* buildService;
      yield* settle;

      return yield* body({
        service,
        repository,
        emitProvider: (event) =>
          PubSub.publish(providerPubSub, event as unknown as ProviderRuntimeEvent).pipe(
            Effect.flatMap(() => settle),
          ),
        emitDomain: (event) =>
          PubSub.publish(domainPubSub, event as unknown as OrchestrationEvent).pipe(
            Effect.flatMap(() => settle),
          ),
        setSessions: (sessions) => Ref.set(sessionsRef, sessions),
        setEnabled: (usageStatsEnabled) =>
          Ref.set(enabledRef, usageStatsEnabled).pipe(
            Effect.flatMap(() =>
              PubSub.publish(settingsPubSub, { ...DEFAULT_SERVER_SETTINGS, usageStatsEnabled }),
            ),
            Effect.flatMap(() => settle),
          ),
        rebuildService: buildService.pipe(Effect.tap(() => settle)),
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
  usage: { outputTokens?: number; totalOutputTokens?: number },
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

describe("UsageStatsService", () => {
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
        yield* harness.emitProvider(tokenUsageEvent(THREAD_2, "p3", { outputTokens: 70 }, CLAUDE));

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
            day: "1970-01-01",
            provider: CLAUDE,
            model: "claude-opus-5",
            outputTokens: 70,
          },
          {
            day: "1970-01-01",
            provider: CODEX,
            model: "gpt-5.6-codex",
            outputTokens: 125,
          },
          {
            day: "1970-01-01",
            provider: CODEX,
            model: "gpt-5.6-codex-mini",
            outputTokens: 50,
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
          type: "turn.started",
          payload: {},
        });
        yield* harness.emitProvider({
          ...providerEventBase(THREAD_2, "a1"),
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
          days: [{ day: "2020-01-01", generatingMs: 60_000, outputTokens: 5000, userMessages: 7 }],
          tokenBreakdowns: [],
        });
        const persisted = yield* harness.repository.listDays;
        assert.equal(persisted.length, 1);
        const rebuilt = yield* harness.rebuildService;
        const snapshot = yield* rebuilt.snapshot;
        assert.equal(snapshot.totals.outputTokens, 5000);
        assert.equal(snapshot.totals.userMessages, 7);
        assert.equal(snapshot.totals.generatingMs, 60_000);
      }),
    ),
  );
});
