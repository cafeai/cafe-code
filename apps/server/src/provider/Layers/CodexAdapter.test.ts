import * as ManagementMcp from "../../mcp/sessionConnection.ts";
// @effect-diagnostics nodeBuiltinImport:off
import {
  ApprovalRequestId,
  CodexSettings,
  EventId,
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderItemId,
  RuntimeTaskId,
  SubagentRuntimeId,
  ThreadId,
  TurnId,
  type ProviderApprovalDecision,
  type ProviderDaemonFailedRootRetirementRefusal,
  type ProviderEvent,
  type ProviderSession,
  type ProviderTaskOwner,
  type ProviderThreadGoal,
  type ProviderThreadGoalSetInput,
  type ProviderTurnStartResult,
  type ProviderTurnSteerResult,
  type ProviderUserInputAnswers,
  type ServerProviderModel,
} from "@cafecode/contracts";
import { makeCodexCompactionDiagnosticsTracker } from "@cafecode/shared/codexCompactionDiagnostics";
import { createModelSelection } from "@cafecode/shared/model";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, vi } from "@effect/vitest";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as CodexErrors from "effect-codex-app-server/errors";
import * as EffectCodexSchema from "effect-codex-app-server/schema";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { VisualizationGenerationId } from "@cafecode/contracts/visualizations";
import { CODEX_HISTORY_RECOVERY_REQUIRED_MESSAGE } from "@cafecode/shared/codexHistorySafety";
import { ServerConfig } from "../../config.ts";
import { installGlideSessionRuntime, type GlideSessionBroker } from "../../glide/sessionRuntime.ts";
import { storeFileAttachment } from "../../fileAttachmentStore.ts";
import { AssistantStreamTextCommitment } from "../../orchestration/providerAssistantStreamCommitment.ts";
import { SqlitePersistenceTest } from "../../persistence/Sqlite.test.fixture.ts";
import {
  installSchedulingSessionBroker,
  type SchedulingSessionBinding,
  type SchedulingSessionBroker,
} from "../../scheduledFollowups/sessionRuntime.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  installVisualizationSessionRuntime,
  type VisualizationSessionBroker,
} from "../../visualizations/sessionRuntime.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterRewindOutcomeUnknownError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import type { CodexAdapterShape } from "../Services/CodexAdapter.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import { makeCodexDaybreakDescriptor } from "../codexDaybreak.ts";
import { buildCodexSteerClientCorrelationId } from "../codexSteerCorrelation.ts";
import {
  canonicalizeCodexSubagentDetail,
  makeCodexAdapter,
  makeCodexNativeRetryTracker,
  redactArchivedToolEvent,
  type CodexAdapterLiveOptions,
} from "./CodexAdapter.ts";
import {
  type CodexFailedRootRetirementResult,
  type CodexSessionRuntimeError,
  type CodexSessionRuntimeOptions,
  type CodexSessionRuntimeSendTurnInput,
  type CodexSessionRuntimeShape,
  type CodexSessionRuntimeSteerTurnInput,
  type CodexThreadSnapshot,
  type CodexTransientSubagentHistoryReadOptions,
} from "./CodexSessionRuntime.ts";

const decodeProviderJsonString = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const decodeDiagnosticMessageJsonString = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ error: Schema.Struct({ message: Schema.String }) })),
);
const decodeTerminalErrorJsonString = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ turn: Schema.Struct({ error: Schema.Unknown }) })),
);
const encodeProviderJsonString = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);
const decodeCodexSettings = Schema.decodeSync(CodexSettings);
const decodeMessageId = Schema.decodeUnknownSync(MessageId);
const decodeNativeNotification = Schema.decodeUnknownSync(EffectCodexSchema.ServerNotification);
const isStartedItem = Schema.is(EffectCodexSchema.V2ItemStartedNotification);
const isCompletedItem = Schema.is(EffectCodexSchema.V2ItemCompletedNotification);
const isTerminalInteraction = Schema.is(EffectCodexSchema.V2TerminalInteractionNotification);

// Test-local service tag so the rest of the file can keep using `yield* CodexAdapter`.
class CodexAdapter extends Context.Service<CodexAdapter, CodexAdapterShape>()(
  "test/CodexAdapter",
) {}

const asThreadId = (value: string): ThreadId => ThreadId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asItemId = (value: string): ProviderItemId => ProviderItemId.make(value);
const authRecoveryTaskIdForTest = (threadId: string, turnId: string): RuntimeTaskId =>
  RuntimeTaskId.make(
    `codex-auth-recovery-sha256:${crypto
      .createHash("sha256")
      .update(
        `cafecode/codex-auth-recovery-task/v1\u0000${JSON.stringify([threadId, turnId])}`,
        "utf8",
      )
      .digest("hex")}`,
  );
const utf8Bytes = (value: string): number => Buffer.byteLength(value, "utf8");
const retainedDetailBytes = (detail: ReturnType<typeof canonicalizeCodexSubagentDetail>): number =>
  detail.messages.reduce(
    (total, message) =>
      total + utf8Bytes(message.text) + (message.omission ? utf8Bytes(message.omission.tail) : 0),
    0,
  );

const retryTestRuntimeId = "b9c6b24c-3323-4d5e-bc74-9df5b7806108";
const retryTestAccountId = ProviderInstanceId.make("codex_retry_test");
function retryObservationFrame(
  id: string,
  targetId = "native-root",
  nativeTurnId = "native-turn-1",
  child = false,
): ProviderEvent {
  return {
    id: asEventId(id),
    kind: "notification",
    provider: ProviderDriverKind.make("codex"),
    providerInstanceId: retryTestAccountId,
    subagentRuntimeId: retryTestRuntimeId,
    threadId: asThreadId("visible-retry-thread"),
    createdAt: "2026-10-11T00:00:00.000Z",
    method: child ? "codex.subagent/error" : "error",
    turnId: asTurnId(child ? "canonical-parent-turn" : nativeTurnId),
    payload: {
      threadId: targetId,
      turnId: nativeTurnId,
      error: { message: "Reconnecting... 1/5", codexErrorInfo: "serverOverloaded" },
      willRetry: true,
    },
  };
}

function retryTurnFrame(
  turnId: string,
  completed = false,
  targetId = "native-root",
  child = false,
): ProviderEvent {
  return {
    ...retryObservationFrame(`turn-${turnId}-${completed}`, targetId, turnId, child),
    method: child
      ? completed
        ? "codex.subagent/turnCompleted"
        : "codex.subagent/turnStarted"
      : completed
        ? "turn/completed"
        : "turn/started",
    payload: {
      threadId: targetId,
      turn: { id: turnId, items: [], status: completed ? "failed" : "inProgress", error: null },
    },
  };
}

const boundRetryTracker = () =>
  makeCodexNativeRetryTracker({
    threadId: asThreadId("visible-retry-thread"),
    providerInstanceId: retryTestAccountId,
    runtimeId: retryTestRuntimeId,
  });

class FakeCodexRuntime implements CodexSessionRuntimeShape {
  private readonly eventQueue = Effect.runSync(Queue.unbounded<ProviderEvent>());
  private readonly now = "2026-01-01T00:00:00.000Z";
  private currentSession: ProviderSession | undefined;
  private closed = false;

  private initialSession(status: ProviderSession["status"]): ProviderSession {
    return {
      provider: ProviderDriverKind.make("codex"),
      status,
      runtimeMode: this.options.runtimeMode,
      maxConcurrentSubagents: this.options.maxConcurrentSubagents ?? null,
      codexContextWindowOverride: this.options.codexContextWindowOverride ?? null,
      threadId: this.options.threadId,
      cwd: this.options.cwd,
      ...(this.options.model ? { model: this.options.model } : {}),
      resumeCursor: this.options.resumeCursor ?? { threadId: "provider-thread-1" },
      createdAt: this.now,
      updatedAt: this.now,
    };
  }

  public readonly startImpl = vi.fn((): Promise<ProviderSession> =>
    Promise.resolve(this.initialSession("ready")),
  );

  // A production descriptor read is independent of native startup. Keeping
  // this seam separate catches acquisition-order bugs and lets timeout tests
  // stall start() without accidentally stalling its earlier descriptor read.
  public readonly getSessionImpl = vi.fn((): Promise<ProviderSession> =>
    Promise.resolve(this.currentSession ?? this.initialSession("connecting")),
  );

  public readonly sendTurnImpl = vi.fn(
    (_input: CodexSessionRuntimeSendTurnInput): Promise<ProviderTurnStartResult> =>
      Promise.resolve({
        threadId: this.options.threadId,
        turnId: asTurnId("turn-1"),
      }),
  );

  public readonly steerTurnImpl = vi.fn(
    (input: CodexSessionRuntimeSteerTurnInput): Promise<ProviderTurnSteerResult> =>
      Promise.resolve({
        threadId: this.options.threadId,
        turnId: asTurnId("turn-1"),
        clientCorrelationId:
          input.clientCorrelationId ?? buildCodexSteerClientCorrelationId("steer-1"),
      }),
  );

  public readonly interruptTurnImpl = vi.fn((_turnId?: TurnId): Promise<void> =>
    Promise.resolve(undefined),
  );

  public readonly forkThreadImpl = vi.fn(() =>
    Promise.resolve({ threadId: "provider-thread-fork" }),
  );

  public readonly discardForkImpl = vi.fn((_resumeCursor: unknown) => Promise.resolve());

  public readonly readThreadImpl = vi.fn((): Promise<CodexThreadSnapshot> =>
    Promise.resolve({
      threadId: "provider-thread-1",
      turns: [],
    }),
  );

  public readonly readSubagentThreadImpl = vi.fn(
    (subagentThreadId: string): Promise<CodexThreadSnapshot> =>
      Promise.resolve({
        threadId: subagentThreadId,
        turns: [],
      }),
  );

  public readonly rollbackThreadImpl = vi.fn((_numTurns: number): Promise<CodexThreadSnapshot> =>
    Promise.resolve({
      threadId: "provider-thread-1",
      turns: [],
    }),
  );

  public readonly respondToRequestImpl = vi.fn(
    (_requestId: ApprovalRequestId, _decision: ProviderApprovalDecision): Promise<void> =>
      Promise.resolve(undefined),
  );

  public readonly respondToUserInputImpl = vi.fn(
    (_requestId: ApprovalRequestId, _answers: ProviderUserInputAnswers): Promise<void> =>
      Promise.resolve(undefined),
  );

  public readonly snoozeUserInputImpl = vi.fn((_requestId: ApprovalRequestId): Promise<void> =>
    Promise.resolve(undefined),
  );

  public readonly closeImpl = vi.fn(() => Promise.resolve(undefined));
  public readonly closeIfIdleImpl = vi.fn(() => Promise.resolve(true));
  closeIfIdle = Effect.promise(() => this.closeIfIdleImpl()).pipe(
    Effect.tap((idle) => (idle ? this.close : Effect.void)),
  );

  // This seam is deliberately independent of ordinary close/idle admission.
  // Recovery tests may refuse the exact failed-owner retirement without ever
  // authorizing unconditional teardown of a newer synthetic native session.
  public readonly closeIfFailedRootImpl = vi.fn(
    (
      _expected: NonNullable<CodexSessionRuntimeSendTurnInput["expectedFailedRoot"]>,
    ): Promise<CodexFailedRootRetirementResult> =>
      Promise.resolve({ retired: false, reason: "root-proof-changed" }),
  );
  closeIfFailedRoot(expected: NonNullable<CodexSessionRuntimeSendTurnInput["expectedFailedRoot"]>) {
    return Effect.promise(() => this.closeIfFailedRootImpl(expected)).pipe(
      Effect.tap((result) => (result.retired ? this.close : Effect.void)),
    );
  }

  /** Test-only hook that runs after the provider interrupt promise ACKs. */
  public afterInterruptAcknowledged: Effect.Effect<void> | undefined;

  readonly options: CodexSessionRuntimeOptions;

  constructor(options: CodexSessionRuntimeOptions) {
    this.options = options;
  }

  start(): Effect.Effect<ProviderSession, CodexSessionRuntimeError> {
    return Effect.promise(() => this.startImpl()).pipe(
      Effect.tap((session) =>
        Effect.sync(() => {
          this.currentSession = session;
        }),
      ),
    );
  }

  getSession = Effect.promise(() => this.getSessionImpl());

  sendTurn(
    input: CodexSessionRuntimeSendTurnInput,
  ): Effect.Effect<ProviderTurnStartResult, CodexSessionRuntimeError> {
    return Effect.promise(() => this.sendTurnImpl(input));
  }

  steerTurn(input: CodexSessionRuntimeSteerTurnInput) {
    return Effect.promise(() => this.steerTurnImpl(input));
  }

  interruptTurn(turnId?: TurnId) {
    return Effect.promise(() => this.interruptTurnImpl(turnId)).pipe(
      Effect.andThen(Effect.suspend(() => this.afterInterruptAcknowledged ?? Effect.void)),
    );
  }

  get forkThread() {
    return Effect.promise(() => this.forkThreadImpl());
  }

  discardFork(resumeCursor: unknown) {
    return Effect.promise(() => this.discardForkImpl(resumeCursor));
  }

  snoozeUserInput(_requestId: ApprovalRequestId) {
    return Effect.promise(() => this.snoozeUserInputImpl(_requestId));
  }

  compactThread = Effect.void;

  getGoal = Effect.succeed<ProviderThreadGoal | null>(null);

  setGoal(input: Omit<ProviderThreadGoalSetInput, "threadId">) {
    return Effect.succeed({
      threadId: this.options.threadId,
      objective: input.objective ?? "Test goal",
      status: input.status ?? "active",
      tokenBudget: input.tokenBudget ?? null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: this.now,
      updatedAt: this.now,
    } satisfies ProviderThreadGoal);
  }

  clearGoal = Effect.succeed({ cleared: true });

  readThread = Effect.promise(() => this.readThreadImpl());

  readSubagentThread(subagentThreadId: string) {
    return Effect.tryPromise({
      try: () => this.readSubagentThreadImpl(subagentThreadId),
      catch: (error) => error as CodexSessionRuntimeError,
    });
  }

  rollbackThread(numTurns: number) {
    return Effect.tryPromise({
      try: () => this.rollbackThreadImpl(numTurns),
      catch: (error) => error as CodexSessionRuntimeError,
    });
  }

  respondToRequest(requestId: ApprovalRequestId, decision: ProviderApprovalDecision) {
    return Effect.promise(() => this.respondToRequestImpl(requestId, decision));
  }

  respondToUserInput(requestId: ApprovalRequestId, answers: ProviderUserInputAnswers) {
    return Effect.promise(() => this.respondToUserInputImpl(requestId, answers));
  }

  get events() {
    return Stream.fromQueue(this.eventQueue);
  }

  close = Effect.suspend(() => {
    // Match the native closedRef reservation: repeated retirement callers
    // share one physical close even when scoped cleanup also invokes it.
    if (this.closed) return Effect.void;
    this.closed = true;
    return Effect.promise(() => this.closeImpl()).pipe(
      Effect.andThen(Queue.shutdown(this.eventQueue)),
    );
  });

  emit(event: ProviderEvent) {
    return Queue.offer(this.eventQueue, event).pipe(Effect.asVoid);
  }
}

function makeRuntimeFactory() {
  const runtimes: Array<FakeCodexRuntime> = [];
  const factory = vi.fn((options: CodexSessionRuntimeOptions) => {
    const runtime = new FakeCodexRuntime(options);
    runtimes.push(runtime);
    return Effect.succeed(runtime);
  });

  return {
    factory,
    runtimes,
    get lastRuntime(): FakeCodexRuntime | undefined {
      return runtimes.at(-1);
    },
  };
}

function makeFailedRootRecoveryFixture(fastMode = false) {
  const factory = makeRuntimeFactory();
  const generations = [
    SubagentRuntimeId.make("00000000-0000-4000-8000-000000000081"),
    SubagentRuntimeId.make("00000000-0000-4000-8000-000000000082"),
    SubagentRuntimeId.make("00000000-0000-4000-8000-000000000083"),
  ];
  const account = ProviderInstanceId.make("codex");
  const threadId = asThreadId("cold-failed-root-conversation");
  const nativeThreadId = "same-private-native-history";
  const failedTurnId = asTurnId("exact-failed-root");
  const observedAt = "2026-10-14T06:00:00.000Z";
  const order: string[] = [];
  factory.factory.mockImplementation((options) => {
    const index = factory.runtimes.length;
    const generation = generations[index]!;
    const runtime = new FakeCodexRuntime(options);
    const originalStart = runtime.start.bind(runtime);
    runtime.start = () =>
      originalStart().pipe(
        Effect.map((session) => ({
          ...session,
          providerInstanceId: account,
          subagentRuntimeId: generation,
        })),
        Effect.tap(() => Effect.sync(() => order.push(`opened:${index}`))),
      );
    runtime.getSession = runtime.getSession.pipe(
      Effect.map((session) => ({
        ...session,
        providerInstanceId: account,
        subagentRuntimeId: generation,
      })),
    );
    factory.runtimes.push(runtime);
    return Effect.succeed(runtime);
  });
  const layer = Layer.effect(
    CodexAdapter,
    makeCodexAdapter(
      decodeCodexSettings({ maxConcurrentSubagents: 16, autoCompactTokenLimit: 640_000 }),
      {
        instanceId: account,
        makeRuntime: factory.factory,
        getSubagentConcurrencySupport: () => true,
        getCodexContextWindowSupport: () => true,
      },
    ),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  );
  const expectedFailedRoot = {
    turnId: failedTurnId,
    providerThreadId: nativeThreadId,
    subagentRuntimeId: generations[0]!,
    providerInstanceId: account,
    observedAt,
    restartSession: true as const,
  };
  const prepare = Effect.gen(function* () {
    const adapter = yield* CodexAdapter;
    yield* adapter.startSession({
      threadId,
      runtimeMode: "approval-required",
      interactionMode: "plan",
      cwd: process.cwd(),
      additionalDirectories: [path.join(process.cwd(), "packages")],
      modelSelection: createModelSelection(account, "gpt-5.4", [
        { id: "reasoningEffort", value: "high" },
        ...(fastMode ? [{ id: "fastMode", value: true }] : []),
      ]),
      maxConcurrentSubagents: 3,
      codexContextWindowOverride: 800_000,
      resumeCursor: { threadId: nativeThreadId },
    });
    const oldRuntime = factory.runtimes[0]!;
    const base = yield* oldRuntime.getSession;
    oldRuntime.getSessionImpl.mockResolvedValue({
      ...base,
      status: "ready",
      activeTurnId: undefined,
      lastError: "Definitive transient native failure",
      codexRootTurnFailure: {
        turnId: failedTurnId,
        providerThreadId: nativeThreadId,
        observedAt,
        category: "server",
      },
    });
    return { adapter, oldRuntime };
  });
  return {
    factory,
    generations,
    account,
    threadId,
    nativeThreadId,
    order,
    layer,
    expectedFailedRoot,
    prepare,
  };
}

it.effect(
  "cold failed-root recovery retires before exact-history reopening and submits one new turn with unchanged launch policy",
  () => {
    const fixture = makeFailedRootRecoveryFixture(true);
    return Effect.gen(function* () {
      const { adapter, oldRuntime } = yield* fixture.prepare;
      const closeReached = yield* Deferred.make<void>();
      const releaseClose = yield* Deferred.make<void>();
      yield* Effect.addFinalizer(() =>
        Deferred.succeed(releaseClose, undefined).pipe(Effect.asVoid),
      );
      oldRuntime.closeIfFailedRootImpl.mockResolvedValue({ retired: true });
      const originalCloseImpl = oldRuntime.closeImpl.getMockImplementation()!;
      oldRuntime.closeImpl.mockImplementation(() =>
        originalCloseImpl().then(() => {
          fixture.order.push("retired:0");
          return undefined;
        }),
      );
      oldRuntime.close = Deferred.succeed(closeReached, undefined).pipe(
        Effect.andThen(Deferred.await(releaseClose)),
        Effect.andThen(oldRuntime.close),
      );
      const resultFiber = yield* adapter
        .sendTurn({
          threadId: fixture.threadId,
          input: "Continue the unfinished work. Check existing work before repeating any action.",
          expectedFailedRoot: fixture.expectedFailedRoot,
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(closeReached);
      // Teardown completion, not a close invocation, grants the next opening.
      assert.equal(fixture.factory.runtimes.length, 1);
      assert.equal(oldRuntime.sendTurnImpl.mock.calls.length, 0);
      yield* Deferred.succeed(releaseClose, undefined);
      const result = yield* Fiber.join(resultFiber);
      assert.equal(fixture.factory.runtimes.length, 2);
      const replacement = fixture.factory.runtimes[1]!;
      assert.equal(Object.hasOwn(oldRuntime.options, "requireExactResume"), false);
      assert.equal(replacement.options.requireExactResume, true);
      assert.deepEqual(oldRuntime.closeIfFailedRootImpl.mock.calls, [[fixture.expectedFailedRoot]]);
      assert.deepEqual(fixture.order, ["opened:0", "retired:0", "opened:1"]);
      // The replacement receives the recorded launch intent, not today's
      // account default (16) or a more permissive session mode.
      // Session-scoped tool bindings/history guards are deliberately minted
      // again. Compare launch policy, not the identity of those new closures.
      for (const key of [
        "binaryPath",
        "appServerCwd",
        "homePath",
        "environment",
        "transportPolicy",
        "customInstructions",
        "providerInstanceId",
        "threadId",
        "cwd",
        "model",
        "serviceTier",
        "additionalDirectories",
        "runtimeMode",
        "maxConcurrentSubagents",
        "codexContextWindowOverride",
        "autoCompactTokenLimit",
        "resumeCursor",
      ] as const)
        assert.deepEqual(replacement.options[key], oldRuntime.options[key], key);
      assert.deepEqual(replacement.options.resumeCursor, { threadId: fixture.nativeThreadId });
      assert.equal(replacement.options.maxConcurrentSubagents, 3);
      assert.equal(replacement.options.codexContextWindowOverride, 800_000);
      assert.equal(replacement.options.autoCompactTokenLimit, 640_000);
      assert.equal(replacement.options.runtimeMode, "approval-required");
      assert.equal(oldRuntime.options.serviceTier, "priority");
      assert.equal(replacement.options.serviceTier, "priority");
      assert.equal(oldRuntime.sendTurnImpl.mock.calls.length, 0);
      assert.equal(oldRuntime.steerTurnImpl.mock.calls.length, 0);
      assert.equal(replacement.steerTurnImpl.mock.calls.length, 0);
      assert.equal(replacement.sendTurnImpl.mock.calls.length, 1);
      assert.deepEqual(result.recoverySession, {
        previousSubagentRuntimeId: fixture.generations[0],
        subagentRuntimeId: fixture.generations[1],
        providerThreadId: fixture.nativeThreadId,
      });
      const request = replacement.sendTurnImpl.mock.calls[0]![0];
      assert.equal(request.allowActiveTurnSteerFallback, false);
      assert.deepEqual(request.expectedRecoverySession, result.recoverySession);
      assert.equal(request.expectedFailedRoot, undefined);
      // Private recovery reopens recorded Fast policy, not an ordinary unset
      // composer request. Its new continuation must inherit that exact policy.
      assert.equal(Object.hasOwn(request, "serviceTier"), false);
      assert.equal(
        request.input,
        "Continue the unfinished work. Check existing work before repeating any action.",
      );
    }).pipe(Effect.provide(fixture.layer));
  },
);

for (const scenario of [
  "atomic retirement refused",
  "legacy runtime",
  "wrong timestamp",
  "missing timestamp",
  "wrong account",
  "wrong generation",
  "wrong native history",
  "wrong root",
  "active root",
  "missing resume cursor",
] as const) {
  it.effect(`cold failed-root recovery cannot retire or send from ${scenario}`, () => {
    const fixture = makeFailedRootRecoveryFixture();
    return Effect.gen(function* () {
      const { adapter, oldRuntime } = yield* fixture.prepare;
      oldRuntime.closeIfFailedRootImpl.mockResolvedValue(
        scenario === "atomic retirement refused"
          ? { retired: false, reason: "notifications-pending" }
          : { retired: true },
      );
      if (scenario === "legacy runtime")
        Object.defineProperty(oldRuntime, "closeIfFailedRoot", { value: undefined });
      const current = yield* oldRuntime.getSession;
      if (scenario === "active root")
        oldRuntime.getSessionImpl.mockResolvedValue({
          ...current,
          status: "running",
          activeTurnId: asTurnId("newer-authorized-root"),
        });
      if (scenario === "missing resume cursor")
        oldRuntime.getSessionImpl.mockResolvedValue({ ...current, resumeCursor: undefined });
      const expected = {
        ...fixture.expectedFailedRoot,
        ...(scenario === "wrong timestamp" ? { observedAt: "2026-10-14T06:00:01.000Z" } : {}),
        ...(scenario === "missing timestamp" ? { observedAt: undefined } : {}),
        ...(scenario === "wrong account"
          ? { providerInstanceId: ProviderInstanceId.make("peer") }
          : {}),
        ...(scenario === "wrong generation" ? { subagentRuntimeId: fixture.generations[1]! } : {}),
        ...(scenario === "wrong native history"
          ? { providerThreadId: "different-private-history" }
          : {}),
        ...(scenario === "wrong root" ? { turnId: asTurnId("different-root") } : {}),
      };
      const outcome = yield* adapter
        .sendTurn({
          threadId: fixture.threadId,
          input: "Continue the unfinished work.",
          expectedFailedRoot: expected,
        })
        .pipe(Effect.exit);
      assert.equal(Exit.isFailure(outcome), true);
      assert.ok(Exit.isFailure(outcome));
      const failure = outcome.cause.reasons.find(Cause.isFailReason)?.error;
      // This fixture requires the exact local error class; structural lookalikes must not satisfy its provenance assertion.
      // @effect-diagnostics-next-line instanceOfSchema:off
      assert.ok(failure instanceof ProviderAdapterRequestError);
      assert.equal(
        failure.failedRootRetirementRefusal,
        scenario === "atomic retirement refused" ? "notifications-pending" : undefined,
      );
      assert.equal(fixture.factory.runtimes.length, 1);
      assert.equal(oldRuntime.closeImpl.mock.calls.length, 0);
      assert.equal(oldRuntime.sendTurnImpl.mock.calls.length, 0);
      assert.equal(oldRuntime.steerTurnImpl.mock.calls.length, 0);
      assert.equal(oldRuntime.closeIfIdleImpl.mock.calls.length, 0);
      assert.equal(
        oldRuntime.closeIfFailedRootImpl.mock.calls.length,
        scenario === "atomic retirement refused" ? 1 : 0,
      );
    }).pipe(Effect.provide(fixture.layer));
  });
}

for (const reason of [
  "invalid-request",
  "owner-changed",
  "native-context-unavailable",
  "history-unavailable",
  "compaction-pending",
  "root-start-pending",
  "closed",
  "root-proof-changed",
  "notifications-pending",
] satisfies ReadonlyArray<ProviderDaemonFailedRootRetirementRefusal>) {
  it.effect(
    `cold retirement witnesses ${reason} only before any teardown, reopening or native send`,
    () => {
      const fixture = makeFailedRootRecoveryFixture();
      return Effect.gen(function* () {
        const { adapter, oldRuntime } = yield* fixture.prepare;
        oldRuntime.closeIfFailedRootImpl.mockResolvedValue({ retired: false, reason });
        const outcome = yield* adapter
          .sendTurn({
            threadId: fixture.threadId,
            input: "Continue existing work.",
            expectedFailedRoot: fixture.expectedFailedRoot,
          })
          .pipe(Effect.exit);
        assert.ok(Exit.isFailure(outcome));
        const failure = outcome.cause.reasons.find(Cause.isFailReason)?.error;
        // This fixture requires the exact local error class; structural lookalikes must not satisfy its provenance assertion.
        // @effect-diagnostics-next-line instanceOfSchema:off
        assert.ok(failure instanceof ProviderAdapterRequestError);
        assert.equal(failure.provider, "codex");
        assert.equal(failure.method, "turn/start");
        assert.equal(failure.failedRootRetirementRefusal, reason);
        assert.deepEqual(oldRuntime.closeIfFailedRootImpl.mock.calls, [
          [fixture.expectedFailedRoot],
        ]);
        assert.equal(fixture.factory.runtimes.length, 1);
        assert.equal(oldRuntime.closeImpl.mock.calls.length, 0);
        assert.equal(oldRuntime.closeIfIdleImpl.mock.calls.length, 0);
        assert.equal(oldRuntime.sendTurnImpl.mock.calls.length, 0);
        assert.equal(oldRuntime.steerTurnImpl.mock.calls.length, 0);
      }).pipe(Effect.provide(fixture.layer));
    },
  );
}

for (const scenario of [
  "legacy true",
  "legacy false",
  "missing reason",
  "unknown reason",
  "ambiguous success",
  "inherited refusal",
  "retired accessor",
  "reason accessor",
  "descriptor failure",
  "proxy retirement",
  "proxy refusal",
  "revoked proxy",
] as const) {
  it.effect(
    `cold retirement rejects ${scenario} without minting refusal or continuation authority`,
    () => {
      const fixture = makeFailedRootRecoveryFixture();
      return Effect.gen(function* () {
        const { adapter, oldRuntime } = yield* fixture.prepare;
        const accessor = vi.fn(() => "notifications-pending");
        const proxyTrap = vi.fn(() => {
          throw new Error("a retirement Proxy trap must never execute");
        });
        const proxy = Proxy.revocable(
          scenario === "proxy retirement"
            ? { retired: true }
            : { retired: false, reason: "notifications-pending" },
          {
            get: proxyTrap,
            getPrototypeOf: proxyTrap,
            getOwnPropertyDescriptor: proxyTrap,
            ownKeys: proxyTrap,
          },
        );
        if (scenario === "revoked proxy") proxy.revoke();
        const value: unknown =
          scenario === "legacy true"
            ? true
            : scenario === "legacy false"
              ? false
              : scenario === "missing reason"
                ? { retired: false }
                : scenario === "unknown reason"
                  ? { retired: false, reason: "native prose is not proof" }
                  : scenario === "ambiguous success"
                    ? { retired: true, reason: "notifications-pending" }
                    : scenario === "inherited refusal"
                      ? Object.create({ retired: false, reason: "notifications-pending" })
                      : scenario === "retired accessor"
                        ? Object.defineProperty({ reason: "notifications-pending" }, "retired", {
                            get: accessor,
                          })
                        : scenario === "reason accessor"
                          ? Object.defineProperty({ retired: false }, "reason", { get: accessor })
                          : scenario === "proxy retirement" ||
                              scenario === "proxy refusal" ||
                              scenario === "revoked proxy"
                            ? proxy.proxy
                            : new Proxy(
                                {},
                                {
                                  ownKeys: () => {
                                    throw new Error("synthetic malformed boundary");
                                  },
                                },
                              );
        // This deliberately malformed runtime seam bypasses the correctly typed
        // fake's close wrapper. Reading an accessor here would itself be a bug.
        const closeIfFailedRoot = vi.fn(() => Effect.succeed(value));
        Object.defineProperty(oldRuntime, "closeIfFailedRoot", { value: closeIfFailedRoot });
        const outcome = yield* adapter
          .sendTurn({
            threadId: fixture.threadId,
            input: "Continue existing work.",
            expectedFailedRoot: fixture.expectedFailedRoot,
          })
          .pipe(Effect.exit);
        assert.ok(Exit.isFailure(outcome));
        const failure = outcome.cause.reasons.find(Cause.isFailReason)?.error;
        // This fixture requires the exact local error class; structural lookalikes must not satisfy its provenance assertion.
        // @effect-diagnostics-next-line instanceOfSchema:off
        assert.ok(failure instanceof ProviderAdapterRequestError);
        assert.equal(failure.failedRootRetirementRefusal, undefined);
        assert.equal(accessor.mock.calls.length, 0);
        assert.equal(proxyTrap.mock.calls.length, 0);
        assert.deepEqual(closeIfFailedRoot.mock.calls, [[fixture.expectedFailedRoot]]);
        assert.equal(fixture.factory.runtimes.length, 1);
        assert.equal(oldRuntime.closeImpl.mock.calls.length, 0);
        assert.equal(oldRuntime.closeIfIdleImpl.mock.calls.length, 0);
        assert.equal(oldRuntime.sendTurnImpl.mock.calls.length, 0);
        assert.equal(oldRuntime.steerTurnImpl.mock.calls.length, 0);
      }).pipe(Effect.provide(fixture.layer));
    },
  );
}

it.effect(
  "cold reopening joins the old session-closed bridge cleanup before installing its replacement",
  () =>
    schedulingCase(({ bindings }) => {
      const fixture = makeFailedRootRecoveryFixture();
      return Effect.gen(function* () {
        const { adapter, oldRuntime } = yield* fixture.prepare;
        const enteredDispose = yield* Deferred.make<void>();
        const releaseDispose = yield* Deferred.make<void>();
        yield* Effect.addFinalizer(() =>
          Deferred.succeed(releaseDispose, undefined).pipe(Effect.asVoid),
        );
        const oldBinding = bindings[0]!;
        const originalDispose = oldBinding.dispose;
        vi.mocked(oldBinding.dispose).mockImplementationOnce(() =>
          Effect.runPromise(
            Deferred.succeed(enteredDispose, undefined).pipe(
              Effect.andThen(Deferred.await(releaseDispose)),
              Effect.andThen(Effect.promise(() => originalDispose())),
            ),
          ),
        );
        oldRuntime.closeIfFailedRootImpl.mockResolvedValue({ retired: true });
        const originalClose = oldRuntime.close;
        let emittedClosed = false;
        oldRuntime.close = Effect.suspend(() => {
          if (emittedClosed) return originalClose;
          emittedClosed = true;
          return oldRuntime
            .emit({
              id: asEventId("exact-old-session-closed-during-recovery"),
              kind: "notification",
              provider: ProviderDriverKind.make("codex"),
              providerInstanceId: fixture.account,
              subagentRuntimeId: fixture.generations[0],
              threadId: fixture.threadId,
              method: "session/closed",
              createdAt: fixture.expectedFailedRoot.observedAt,
              message: "Synthetic old runtime retirement",
            })
            .pipe(Effect.andThen(Deferred.await(enteredDispose)), Effect.andThen(originalClose));
        });
        const recovery = yield* adapter
          .sendTurn({
            threadId: fixture.threadId,
            input: "Continue existing work.",
            expectedFailedRoot: fixture.expectedFailedRoot,
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(enteredDispose);
        assert.equal(fixture.factory.runtimes.length, 1);
        assert.equal(oldRuntime.sendTurnImpl.mock.calls.length, 0);
        // The stopped flag is visible while disposal is held. It is not proof
        // that the old context's teardown/finalizers have completed.
        yield* Deferred.succeed(releaseDispose, undefined);
        const accepted = yield* Fiber.join(recovery);
        assert.equal(fixture.factory.runtimes.length, 2);
        assert.equal(bindings[0]!.disposed, true);
        assert.equal(bindings[1]!.active, true);
        assert.equal(yield* adapter.hasSession(fixture.threadId), true);
        assert.equal(accepted.recoverySession?.subagentRuntimeId, fixture.generations[1]);
        assert.equal(fixture.factory.runtimes[1]!.sendTurnImpl.mock.calls.length, 1);
      }).pipe(Effect.provide(fixture.layer));
    }),
);

it.effect(
  "revoked cold recovery finishes reserved teardown but cannot launch a replacement",
  () => {
    const fixture = makeFailedRootRecoveryFixture();
    return Effect.gen(function* () {
      const { adapter, oldRuntime } = yield* fixture.prepare;
      const reached = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined).pipe(Effect.asVoid));
      oldRuntime.closeIfFailedRootImpl.mockResolvedValue({ retired: true });
      const originalClose = oldRuntime.close;
      oldRuntime.close = Deferred.succeed(reached, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.andThen(originalClose),
      );
      const recovery = yield* adapter
        .sendTurn({
          threadId: fixture.threadId,
          input: "Continue existing work.",
          expectedFailedRoot: fixture.expectedFailedRoot,
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(reached);
      const interrupted = yield* Fiber.interrupt(recovery).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      assert.equal(fixture.factory.runtimes.length, 1);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(interrupted);
      assert.equal(oldRuntime.closeIfFailedRootImpl.mock.calls.length, 1);
      assert.equal(oldRuntime.closeImpl.mock.calls.length > 0, true);
      assert.equal(fixture.factory.runtimes.length, 1);
      assert.equal(oldRuntime.sendTurnImpl.mock.calls.length, 0);
      assert.equal(oldRuntime.steerTurnImpl.mock.calls.length, 0);
    }).pipe(Effect.provide(fixture.layer));
  },
);

for (const mismatch of [
  "native history",
  "reused generation",
  "missing generation",
  "already running",
] as const) {
  it.effect(
    `cold recovery never sends or opens a blank conversation after mismatched replacement ${mismatch}`,
    () => {
      const fixture = makeFailedRootRecoveryFixture();
      return Effect.gen(function* () {
        const { adapter, oldRuntime } = yield* fixture.prepare;
        oldRuntime.closeIfFailedRootImpl.mockResolvedValue({ retired: true });
        const makeRuntime = fixture.factory.factory.getMockImplementation()!;
        fixture.factory.factory.mockImplementationOnce((options) =>
          makeRuntime(options).pipe(
            Effect.map((runtime) => {
              const originalStart = runtime.start.bind(runtime);
              runtime.start = () =>
                originalStart().pipe(
                  Effect.map((session) => ({
                    ...session,
                    ...(mismatch === "native history"
                      ? { resumeCursor: { threadId: "different-private-history" } }
                      : {}),
                    ...(mismatch === "reused generation"
                      ? { subagentRuntimeId: fixture.generations[0] }
                      : {}),
                    ...(mismatch === "missing generation" ? { subagentRuntimeId: undefined } : {}),
                    ...(mismatch === "already running"
                      ? { status: "running" as const, activeTurnId: asTurnId("other-root") }
                      : {}),
                  })),
                );
              return runtime;
            }),
          ),
        );
        const outcome = yield* adapter
          .sendTurn({
            threadId: fixture.threadId,
            input: "Continue existing work.",
            expectedFailedRoot: fixture.expectedFailedRoot,
          })
          .pipe(Effect.exit);
        assert.equal(Exit.isFailure(outcome), true);
        assert.ok(Exit.isFailure(outcome));
        const failure = outcome.cause.reasons.find(Cause.isFailReason)?.error;
        // This fixture requires the exact local error class; structural lookalikes must not satisfy its provenance assertion.
        // @effect-diagnostics-next-line instanceOfSchema:off
        assert.ok(failure instanceof ProviderAdapterRequestError);
        assert.equal(failure.failedRootRetirementRefusal, undefined);
        assert.equal(fixture.factory.runtimes.length, 2);
        assert.equal(oldRuntime.sendTurnImpl.mock.calls.length, 0);
        assert.equal(fixture.factory.runtimes[1]!.sendTurnImpl.mock.calls.length, 0);
        assert.equal(fixture.factory.runtimes[1]!.steerTurnImpl.mock.calls.length, 0);
        assert.equal(fixture.factory.runtimes[1]!.closeImpl.mock.calls.length > 0, true);
        assert.deepEqual(fixture.factory.runtimes[1]!.options.resumeCursor, {
          threadId: fixture.nativeThreadId,
        });
      }).pipe(Effect.provide(fixture.layer));
    },
  );
}

for (const phase of ["opening", "send"] as const) {
  it.effect(
    `cold recovery ${phase} errors cannot borrow pre-retirement refusal proof from native text or fields`,
    () => {
      const fixture = makeFailedRootRecoveryFixture();
      return Effect.gen(function* () {
        const { adapter, oldRuntime } = yield* fixture.prepare;
        oldRuntime.closeIfFailedRootImpl.mockResolvedValue({ retired: true });
        const nativeError = CodexErrors.CodexAppServerRequestError.internalError(
          "The failed Codex root changed before retirement.",
        );
        Object.defineProperty(nativeError, "failedRootRetirementRefusal", {
          value: "notifications-pending",
        });
        const makeRuntime = fixture.factory.factory.getMockImplementation()!;
        fixture.factory.factory.mockImplementationOnce((options) =>
          makeRuntime(options).pipe(
            Effect.map((runtime) => {
              if (phase === "opening") runtime.start = () => Effect.fail(nativeError);
              else {
                const send = runtime.sendTurn.bind(runtime);
                runtime.sendTurn = (input) =>
                  send(input).pipe(Effect.andThen(Effect.fail(nativeError)));
              }
              return runtime;
            }),
          ),
        );
        const outcome = yield* adapter
          .sendTurn({
            threadId: fixture.threadId,
            input: "Continue existing work.",
            expectedFailedRoot: fixture.expectedFailedRoot,
          })
          .pipe(Effect.exit);
        assert.ok(Exit.isFailure(outcome));
        const failure = outcome.cause.reasons.find(Cause.isFailReason)?.error;
        // This fixture requires the exact local error class; structural lookalikes must not satisfy its provenance assertion.
        // @effect-diagnostics-next-line instanceOfSchema:off
        if (phase === "opening") assert.ok(failure instanceof ProviderAdapterProcessError);
        else assert.ok(failure instanceof ProviderAdapterRequestError);
        // This fixture requires the exact local error class; structural lookalikes must not satisfy its provenance assertion.
        // @effect-diagnostics-next-line instanceOfSchema:off
        assert.ok(
          failure instanceof ProviderAdapterProcessError ||
            failure instanceof ProviderAdapterRequestError,
        );
        assert.equal(Object.hasOwn(failure, "failedRootRetirementRefusal"), false);
        assert.equal(failure.cause, nativeError);
        assert.equal(fixture.factory.runtimes.length, 2);
        assert.equal(oldRuntime.closeIfFailedRootImpl.mock.calls.length, 1);
        assert.equal(oldRuntime.closeImpl.mock.calls.length > 0, true);
        assert.equal(oldRuntime.sendTurnImpl.mock.calls.length, 0);
        assert.equal(oldRuntime.steerTurnImpl.mock.calls.length, 0);
        const replacement = fixture.factory.runtimes[1]!;
        assert.equal(replacement.sendTurnImpl.mock.calls.length, phase === "send" ? 1 : 0);
        assert.equal(replacement.steerTurnImpl.mock.calls.length, 0);
      }).pipe(Effect.provide(fixture.layer));
    },
  );
}

it.effect(
  "attaches management tools through the owned Codex launch and retires them with the session",
  () => {
    const factory = makeRuntimeFactory();
    return Effect.gen(function* () {
      let disposed = false;
      const binding = {
        name: "cafe-code-fixture",
        launch: {
          command: process.execPath,
          args: [
            path.join(process.cwd(), "inert-bridge.mjs"),
            path.join(process.cwd(), "inert-connection.json"),
          ],
          env: { ELECTRON_RUN_AS_NODE: "1" },
        },
        dispose: Effect.sync(() => {
          disposed = true;
        }),
      };
      const spy = vi
        .spyOn(ManagementMcp, "makeManagementMcpSession")
        .mockReturnValue(Effect.succeed(binding));
      yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()));
      const account = ProviderInstanceId.make("codex-management-account");
      const adapter = yield* makeCodexAdapter(decodeCodexSettings({}), {
        instanceId: account,
        makeRuntime: factory.factory,
      });
      const threadId = asThreadId("management-launch");
      yield* adapter.startSession({ threadId, runtimeMode: "approval-required" });
      assert.deepEqual(spy.mock.calls[0]?.[0], { threadId, providerInstanceId: account });
      assert.equal(factory.lastRuntime?.options.managementMcp?.name, binding.name);
      assert.equal(factory.lastRuntime?.options.runtimeMode, "approval-required");
      assert.equal(disposed, false);
      yield* adapter.stopSession(threadId);
      assert.equal(disposed, true);
    }).pipe(
      Effect.provide(
        SqlitePersistenceTest.pipe(
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), { prefix: "cafe-management-codex-" }),
          ),
          Layer.provideMerge(ServerSettingsService.layerTest()),
          Layer.provideMerge(providerSessionDirectoryTestLayer),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    );
  },
);

it.effect(
  "reads server custom instructions when materializing each Codex session without changing user turns",
  () => {
    const factory = makeRuntimeFactory();
    return Effect.gen(function* () {
      const config = yield* ServerConfig;
      const files = yield* FileSystem.FileSystem;
      yield* files.writeFileString(config.systemPromptPath, "  Be concise.  ");
      const adapter = yield* makeCodexAdapter(decodeCodexSettings({}), {
        makeRuntime: factory.factory,
      });
      const threadId = asThreadId("custom-instructions-chat");
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      assert.equal(factory.lastRuntime?.options.customInstructions, "Be concise.");
      assert.equal(Object.hasOwn(factory.lastRuntime!.options, "requireExactResume"), false);
      yield* adapter.stopSession(threadId);
      yield* files.writeFileString(config.systemPromptPath, "Use metric units.");
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      assert.equal(factory.lastRuntime?.options.customInstructions, "Use metric units.");
      assert.equal(Object.hasOwn(factory.lastRuntime!.options, "requireExactResume"), false);
    }).pipe(
      Effect.provide(
        SqlitePersistenceTest.pipe(
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), { prefix: "cafe-custom-instructions-" }),
          ),
          Layer.provideMerge(ServerSettingsService.layerTest()),
          Layer.provideMerge(providerSessionDirectoryTestLayer),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    );
  },
);

it.effect(
  "binds durable history safety callbacks to the exact Cafe chat and configured account",
  () => {
    const factory = makeRuntimeFactory();
    return Effect.gen(function* () {
      const account = ProviderInstanceId.make("history-account");
      const threadId = asThreadId("history-chat");
      const adapter = yield* makeCodexAdapter(decodeCodexSettings({}), {
        instanceId: account,
        makeRuntime: factory.factory,
      });
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      const safety = factory.lastRuntime?.options.historySafety;
      assert.ok(safety);
      assert.equal(yield* safety.isBlocked("native-history"), false);
      yield* safety.markBlocked("native-history");
      assert.equal(yield* safety.isBlocked("native-history"), true);
      assert.equal(yield* safety.isBlocked("fresh-native-history"), false);
      yield* adapter.stopSession(threadId);
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      assert.equal(
        yield* factory.lastRuntime!.options.historySafety!.isBlocked("native-history"),
        true,
      );
      yield* adapter.startSession({
        threadId: asThreadId("different-history-chat"),
        runtimeMode: "full-access",
      });
      assert.equal(
        yield* factory.lastRuntime!.options.historySafety!.isBlocked("native-history"),
        false,
      );
      const otherAccount = yield* makeCodexAdapter(decodeCodexSettings({}), {
        instanceId: ProviderInstanceId.make("other-history-account"),
        makeRuntime: factory.factory,
      });
      yield* otherAccount.startSession({ threadId, runtimeMode: "full-access" });
      assert.equal(
        yield* factory.lastRuntime!.options.historySafety!.isBlocked("native-history"),
        false,
      );
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DROP TABLE provider_codex_history_safety`;
      const readError = yield* safety.isBlocked("native-history").pipe(Effect.flip);
      const writeError = yield* safety.markBlocked("native-history").pipe(Effect.flip);
      assert.equal(readError.message, "Could not verify Codex conversation history safety.");
      assert.equal(writeError.message, "Could not persist Codex conversation history safety.");
      assert.doesNotMatch(
        encodeProviderJsonString([readError, writeError]),
        /native-history|history-chat|history-account|SELECT|INSERT|no such table/,
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        SqlitePersistenceTest.pipe(
          Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
          Layer.provideMerge(ServerSettingsService.layerTest()),
          Layer.provideMerge(providerSessionDirectoryTestLayer),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    );
  },
);

it.effect("fails closed when an adapter owner does not supply durable storage", () => {
  const factory = makeRuntimeFactory();
  return Effect.gen(function* () {
    const adapter = yield* CodexAdapter;
    yield* adapter.startSession({
      threadId: asThreadId("missing-storage-chat"),
      runtimeMode: "full-access",
    });
    const safety = factory.lastRuntime?.options.historySafety;
    assert.ok(safety, "the production adapter must never omit its safety boundary");
    assert.equal((yield* Effect.exit(safety.isBlocked("native-chat")))._tag, "Failure");
    assert.equal((yield* Effect.exit(safety.markBlocked("native-chat")))._tag, "Failure");
  }).pipe(Effect.provide(makeConcurrencyTestLayer(factory)));
});

it.effect(
  "preserves finite history recovery errors and strips their retained native bodies",
  () => {
    const factory = makeRuntimeFactory();
    return Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const threadId = asThreadId("history-error-chat");
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      const runtime = factory.lastRuntime!;
      const received = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 2)).pipe(
        Effect.forkChild,
      );
      yield* runtime.emit({
        id: asEventId("history-error"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId,
        turnId: asTurnId("history-turn"),
        createdAt: "2026-10-06T00:00:00.000Z",
        method: "error",
        payload: {
          threadId: "private-native-id",
          turnId: "history-turn",
          willRetry: false,
          error: {
            message: CODEX_HISTORY_RECOVERY_REQUIRED_MESSAGE,
            codexErrorInfo: null,
            additionalDetails: "private body",
          },
        },
      });
      yield* runtime.emit({
        id: asEventId("history-failed-completion"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId,
        turnId: asTurnId("history-turn"),
        createdAt: "2026-10-06T00:00:01.000Z",
        method: "turn/completed",
        payload: {
          threadId: "private-native-id",
          turn: {
            id: "history-turn",
            items: [],
            itemsView: "notLoaded",
            status: "failed",
            error: {
              message: CODEX_HISTORY_RECOVERY_REQUIRED_MESSAGE,
              codexErrorInfo: null,
              additionalDetails: "private body",
            },
          },
        },
      });
      const events = Array.from(yield* Fiber.join(received));
      assert.deepEqual(
        events.map((event) => event.type),
        ["runtime.error", "turn.completed"],
      );
      assert.doesNotMatch(encodeProviderJsonString(events), /private-native-id|private body/);
      for (const event of events) {
        assert.match(encodeProviderJsonString(event.payload), /Codex/);
        assert.deepEqual(event.raw?.payload, { reason: "codex_history_tool_arguments_too_large" });
      }
    }).pipe(Effect.provide(makeConcurrencyTestLayer(factory)));
  },
);

function makeConcurrencyTestLayer(
  factory: ReturnType<typeof makeRuntimeFactory>,
  instanceLimit?: number,
  contextSupport: () => boolean = () => true,
  extraOptions: Pick<CodexAdapterLiveOptions, "captureAuthenticationObserver"> = {},
) {
  return Layer.effect(
    CodexAdapter,
    makeCodexAdapter(
      decodeCodexSettings(
        instanceLimit !== undefined ? { maxConcurrentSubagents: instanceLimit } : {},
      ),
      {
        makeRuntime: factory.factory,
        getSubagentConcurrencySupport: () => true,
        getCodexContextWindowSupport: contextSupport,
        ...extraOptions,
      },
    ),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  );
}

it.effect(
  "reports revoked sign-in only from the exact current account and native generation",
  () => {
    const factory = makeRuntimeFactory();
    const instanceId = ProviderInstanceId.make("codex");
    const generation = SubagentRuntimeId.make("00000000-0000-4000-8000-000000000098");
    factory.factory.mockImplementation((options) => {
      const runtime = new FakeCodexRuntime(options);
      runtime.getSession = runtime.getSession.pipe(
        Effect.map((session) => ({
          ...session,
          providerInstanceId: instanceId,
          subagentRuntimeId: generation,
        })),
      );
      factory.runtimes.push(runtime);
      return Effect.succeed(runtime);
    });
    const notified = Effect.runSync(Deferred.make<void>());
    const observations: boolean[] = [];
    const captureAuthenticationObserver = Effect.succeed((authenticated: boolean) =>
      Effect.sync(() => {
        observations.push(authenticated);
      }).pipe(Effect.andThen(Deferred.succeed(notified, undefined)), Effect.asVoid),
    );
    return Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-auth"),
        runtimeMode: "full-access",
      });
      const runtime = factory.lastRuntime!;
      const event: ProviderEvent = {
        id: asEventId("owned-native-auth-refusal"),
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: instanceId,
        subagentRuntimeId: generation,
        threadId: asThreadId("thread-auth"),
        kind: "notification",
        method: "process/stderr",
        createdAt: "2026-10-19T23:32:39.528Z",
        message:
          "2026-10-19T23:32:39.528101Z ERROR codex_login::auth::manager: Failed to refresh token: Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.",
      };
      for (const foreign of [
        { ...event, providerInstanceId: ProviderInstanceId.make("peer-account") },
        {
          ...event,
          subagentRuntimeId: SubagentRuntimeId.make("00000000-0000-4000-8000-000000000099"),
        },
        { ...event, threadId: asThreadId("peer-thread") },
        { ...event, method: "warning" },
      ])
        yield* runtime.emit(foreign);
      yield* runtime.emit(event);
      yield* Deferred.await(notified);
      assert.deepEqual(observations, [false]);
    }).pipe(
      Effect.provide(
        makeConcurrencyTestLayer(factory, undefined, () => true, { captureAuthenticationObserver }),
      ),
    );
  },
);

it.effect("binds paired compaction support to the current qualified native owner", () => {
  const factory = makeRuntimeFactory();
  let qualified = false;
  return Effect.gen(function* () {
    const adapter = yield* CodexAdapter;
    // Configuration intent must not grant a capability. Both getters observe
    // the same independently qualified native runtime, including later loss.
    assert.equal(adapter.capabilities.codexContextWindow, false);
    assert.equal(adapter.capabilities.codexContextCompaction, false);
    qualified = true;
    assert.equal(adapter.capabilities.codexContextWindow, true);
    assert.equal(adapter.capabilities.codexContextCompaction, true);
    qualified = false;
    assert.equal(adapter.capabilities.codexContextCompaction, false);
    assert.equal(factory.runtimes.length, 0);
  }).pipe(Effect.provide(makeConcurrencyTestLayer(factory, undefined, () => qualified)));
});

it.effect(
  "keeps Codex chat overrides isolated and preserves configured evidence across fork/resume",
  () => {
    const factory = makeRuntimeFactory();
    return Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const one = yield* adapter.startSession({
        threadId: asThreadId("limit-one"),
        runtimeMode: "full-access",
        maxConcurrentSubagents: 1,
      });
      const two = yield* adapter.startSession({
        threadId: asThreadId("limit-two"),
        runtimeMode: "full-access",
        maxConcurrentSubagents: 64,
      });
      const inherited = yield* adapter.startSession({
        threadId: asThreadId("limit-inherited"),
        runtimeMode: "full-access",
        maxConcurrentSubagents: null,
      });
      assert.equal(one.maxConcurrentSubagents, 1);
      assert.equal(two.maxConcurrentSubagents, 64);
      assert.equal(inherited.maxConcurrentSubagents, 12);
      assert.deepEqual(
        factory.runtimes.map((runtime) => runtime.options.maxConcurrentSubagents),
        [1, 64, 12],
      );
      const fork = yield* adapter.forkSession!({
        operationId: "limit-fork",
        sourceThreadId: one.threadId,
        targetThreadId: asThreadId("limit-forked"),
        title: "Fork",
      });
      assert.equal(fork.maxConcurrentSubagents, 1);
      yield* adapter.stopSession(one.threadId);
      const resumed = yield* adapter.startSession({
        threadId: one.threadId,
        runtimeMode: "full-access",
        resumeCursor: fork.resumeCursor,
        maxConcurrentSubagents: fork.maxConcurrentSubagents,
      });
      assert.equal(resumed.maxConcurrentSubagents, 1);
      assert.equal(factory.lastRuntime?.options.maxConcurrentSubagents, 1);
    }).pipe(Effect.provide(makeConcurrencyTestLayer(factory, 12)));
  },
);

it.effect(
  "guarded Codex reconfiguration retains active/uncertain native work and validates before teardown",
  () => {
    const factory = makeRuntimeFactory();
    return Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const session = yield* adapter.startSession({
        threadId: asThreadId("limit-guard"),
        runtimeMode: "full-access",
        maxConcurrentSubagents: 8,
      });
      const original = factory.lastRuntime!;
      original.closeIfIdleImpl.mockResolvedValue(false);
      const denied = yield* adapter
        .startSession({
          threadId: session.threadId,
          runtimeMode: "full-access",
          maxConcurrentSubagents: 4,
          requireIdleForSubagentLimitChange: true,
        })
        .pipe(Effect.result);
      assert.equal(denied._tag, "Failure");
      if (denied._tag === "Failure")
        assert.equal(
          "remoteErrorTag" in denied.failure ? denied.failure.remoteErrorTag : null,
          "subagent-concurrency-active",
        );
      assert.equal(original.closeImpl.mock.calls.length, 0);
      assert.equal(factory.runtimes.length, 1);
      for (const limit of [0, 65, 1.5, NaN, Infinity]) {
        const invalid = yield* adapter
          .startSession({
            threadId: session.threadId,
            runtimeMode: "full-access",
            maxConcurrentSubagents: limit,
          })
          .pipe(Effect.result);
        assert.equal(invalid._tag, "Failure");
      }
      assert.equal(original.closeImpl.mock.calls.length, 0);
      original.closeIfIdleImpl.mockResolvedValue(true);
      const restarted = yield* adapter.startSession({
        threadId: session.threadId,
        runtimeMode: "full-access",
        maxConcurrentSubagents: null,
        resumeCursor: session.resumeCursor,
        requireIdleForSubagentLimitChange: true,
      });
      assert.equal(restarted.maxConcurrentSubagents, null);
      assert.equal(factory.lastRuntime?.options.maxConcurrentSubagents, undefined);
      assert.deepEqual(factory.lastRuntime?.options.resumeCursor, session.resumeCursor);
    }).pipe(Effect.provide(makeConcurrencyTestLayer(factory)));
  },
);

it.effect(
  "applies combined chat context and subagent overrides through one final idle admission and omits native Reset",
  () => {
    const factory = makeRuntimeFactory();
    return Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const initial = yield* adapter.startSession({
        threadId: asThreadId("context-guard"),
        runtimeMode: "full-access",
        codexContextWindowOverride: 500_000,
        maxConcurrentSubagents: 3,
      });
      assert.equal(initial.codexContextWindowOverride, 500_000);
      assert.equal(factory.lastRuntime?.options.codexContextWindowOverride, 500_000);
      // Runtime opening derives the companion request. Adapter options/usage
      // must not manufacture a separately configured threshold from context.
      assert.equal(factory.lastRuntime?.options.autoCompactTokenLimit, undefined);
      const original = factory.lastRuntime!;
      original.closeIfIdleImpl.mockResolvedValue(false);
      const denied = yield* adapter
        .startSession({
          threadId: initial.threadId,
          runtimeMode: "full-access",
          codexContextWindowOverride: 600_000,
          maxConcurrentSubagents: 4,
          requireIdleForCodexContextWindowChange: true,
          requireIdleForSubagentLimitChange: true,
        })
        .pipe(Effect.result);
      assert.equal(denied._tag, "Failure");
      if (denied._tag === "Failure")
        assert.equal(
          "remoteErrorTag" in denied.failure ? denied.failure.remoteErrorTag : null,
          "codex-context-window-active",
        );
      assert.equal(factory.runtimes.length, 1);
      assert.equal(original.closeIfIdleImpl.mock.calls.length, 1);
      assert.equal(original.closeImpl.mock.calls.length, 0);
      for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        const invalid = yield* adapter
          .startSession({
            threadId: initial.threadId,
            runtimeMode: "full-access",
            codexContextWindowOverride: value,
          })
          .pipe(Effect.result);
        assert.equal(invalid._tag, "Failure");
      }
      assert.equal(original.closeImpl.mock.calls.length, 0);
      original.closeIfIdleImpl.mockResolvedValue(true);
      const reset = yield* adapter.startSession({
        threadId: initial.threadId,
        runtimeMode: "full-access",
        resumeCursor: initial.resumeCursor,
        codexContextWindowOverride: null,
        maxConcurrentSubagents: null,
        requireIdleForCodexContextWindowChange: true,
        requireIdleForSubagentLimitChange: true,
      });
      assert.equal(reset.codexContextWindowOverride, null);
      assert.equal(factory.lastRuntime?.options.codexContextWindowOverride, undefined);
      assert.deepEqual(factory.lastRuntime?.options.resumeCursor, initial.resumeCursor);
      assert.equal(original.closeIfIdleImpl.mock.calls.length, 2);
      assert.equal(factory.lastRuntime?.options.autoCompactTokenLimit, undefined);
    }).pipe(Effect.provide(makeConcurrencyTestLayer(factory)));
  },
);

it.effect(
  "refuses unsupported context Reset before native retirement and preserves current configuration",
  () => {
    const factory = makeRuntimeFactory();
    let supported = true;
    return Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const initial = yield* adapter.startSession({
        threadId: asThreadId("context-reset-unsupported"),
        runtimeMode: "full-access",
        codexContextWindowOverride: 500_000,
      });
      const original = factory.lastRuntime!;
      supported = false;
      const result = yield* adapter
        .startSession({
          threadId: initial.threadId,
          runtimeMode: "full-access",
          codexContextWindowOverride: null,
          requireIdleForCodexContextWindowChange: true,
        })
        .pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      assert.equal(factory.runtimes.length, 1);
      assert.equal(original.closeIfIdleImpl.mock.calls.length, 0);
      assert.equal(original.closeImpl.mock.calls.length, 0);
      assert.equal((yield* adapter.listSessions())[0]?.codexContextWindowOverride, 500_000);
    }).pipe(Effect.provide(makeConcurrencyTestLayer(factory, undefined, () => supported)));
  },
);

function makeScopedRuntimeFactory(options?: { readonly failConstruction?: boolean }) {
  const runtimes: Array<FakeCodexRuntime> = [];
  const releasedThreadIds: Array<ThreadId> = [];

  const factory = vi.fn((runtimeOptions: CodexSessionRuntimeOptions) =>
    Effect.gen(function* () {
      yield* Scope.Scope;
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          releasedThreadIds.push(runtimeOptions.threadId);
        }),
      );

      if (options?.failConstruction) {
        return yield* new CodexErrors.CodexAppServerSpawnError({
          command: `${runtimeOptions.binaryPath} app-server`,
          cause: new Error("runtime construction failed"),
        });
      }

      const runtime = new FakeCodexRuntime(runtimeOptions);
      runtimes.push(runtime);
      return runtime;
    }),
  );

  return {
    factory,
    releasedThreadIds,
    get lastRuntime(): FakeCodexRuntime | undefined {
      return runtimes.at(-1);
    },
  };
}

const providerSessionDirectoryTestLayer = Layer.succeed(ProviderSessionDirectory, {
  upsert: () => Effect.void,
  remove: () => Effect.void,
  getProvider: () =>
    Effect.die(new Error("ProviderSessionDirectory.getProvider is not used in test")),
  getBinding: () => Effect.succeed(Option.none()),
  listThreadIds: () => Effect.succeed([]),
  listBindings: () => Effect.succeed([]),
  upsertSubagentHistoryBinding: () => Effect.void,
  getSubagentHistoryBinding: () => Effect.succeed(Option.none()),
});

const validationRuntimeFactory = makeRuntimeFactory();
const advertisedTierModels: readonly ServerProviderModel[] = [
  ...(["daybreakBlue", "daybreakRed"] as const).map((program) => ({
    slug: program,
    name: program,
    isCustom: false,
    capabilities: { optionDescriptors: [makeCodexDaybreakDescriptor(["standard", program])!] },
  })),
  {
    slug: "catalogued-tier-model",
    name: "Catalogued tier model",
    isCustom: false,
    capabilities: {
      optionDescriptors: [
        {
          id: "serviceTier",
          label: "Service tier",
          type: "select",
          options: [
            { id: "default", label: "Standard" },
            { id: "priority", label: "Fast" },
            { id: "ultrafast", label: "Ultra fast" },
          ],
        },
      ],
    },
  },
  {
    slug: "legacy-fast-tier-model",
    name: "Legacy Fast tier model",
    isCustom: false,
    capabilities: {
      optionDescriptors: [{ id: "fastMode", label: "Fast Mode", type: "boolean" }],
    },
  },
  {
    slug: "revoked-fast-tier-model",
    name: "Revoked Fast tier model",
    isCustom: false,
    capabilities: {
      optionDescriptors: [
        { id: "fastMode", label: "Fast Mode", type: "boolean" },
        { id: "serviceTier", label: "Service tier", type: "select", options: [] },
      ],
    },
  },
];
const validationLayer = it.layer(
  Layer.effect(
    CodexAdapter,
    Effect.gen(function* () {
      const codexConfig = decodeCodexSettings({});
      return yield* makeCodexAdapter(codexConfig, {
        makeRuntime: validationRuntimeFactory.factory,
        getModels: () => Effect.succeed(advertisedTierModels),
      });
    }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

validationLayer("CodexAdapterLive validation", (it) => {
  it.effect(
    "routes exact Daybreak levels and explicit Off and rejects unavailable levels before send",
    () =>
      Effect.gen(function* () {
        const adapter = yield* CodexAdapter;
        for (const program of ["daybreakBlue", "daybreakRed"] as const) {
          const threadId = asThreadId(`daybreak-${program}`);
          const selection = (value: string) =>
            createModelSelection(ProviderInstanceId.make("codex"), program, [
              { id: "cyberAccessProgram", value },
            ]);
          yield* adapter.startSession({
            threadId,
            runtimeMode: "approval-required",
            modelSelection: selection(program),
          });
          const runtime = validationRuntimeFactory.lastRuntime;
          assert.ok(runtime);
          runtime.sendTurnImpl.mockClear();
          yield* adapter.sendTurn({ threadId, input: "On", modelSelection: selection(program) });
          const unsupported = yield* Effect.exit(
            adapter.sendTurn({
              threadId,
              input: "Unavailable level",
              modelSelection: selection(
                program === "daybreakBlue" ? "daybreakRed" : "daybreakBlue",
              ),
            }),
          );
          assert.equal(unsupported._tag, "Failure");
          yield* adapter.sendTurn({
            threadId,
            input: "Off",
            modelSelection: selection("standard"),
          });
          assert.deepEqual(
            runtime.sendTurnImpl.mock.calls.map(([input]) => input.cyberAccessProgram),
            [program, "standard"],
          );
          const count = runtime.sendTurnImpl.mock.calls.length;
          const failed = yield* Effect.exit(
            adapter.sendTurn({
              threadId,
              input: "Unavailable",
              modelSelection: createModelSelection(
                ProviderInstanceId.make("codex"),
                "unadvertised",
                [{ id: "cyberAccessProgram", value: program }],
              ),
            }),
          );
          assert.equal(failed._tag, "Failure");
          assert.equal(runtime.sendTurnImpl.mock.calls.length, count);
        }
      }),
  );
  it.effect(
    "passes an advertised tier exactly at start and rejects an unknown tier before runtime construction",
    () =>
      Effect.gen(function* () {
        const adapter = yield* CodexAdapter;
        const threadId = asThreadId("exact-service-tier-start");
        yield* adapter.startSession({
          provider: ProviderDriverKind.make("codex"),
          threadId,
          runtimeMode: "full-access",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("codex"),
            "catalogued-tier-model",
            [{ id: "serviceTier", value: "ultrafast" }],
          ),
        });
        assert.equal(
          validationRuntimeFactory.factory.mock.calls.at(-1)?.[0].serviceTier,
          "ultrafast",
        );
        const count = validationRuntimeFactory.factory.mock.calls.length;
        const failed = yield* Effect.exit(
          adapter.startSession({
            provider: ProviderDriverKind.make("codex"),
            threadId: asThreadId("unknown-service-tier-start"),
            runtimeMode: "full-access",
            modelSelection: createModelSelection(
              ProviderInstanceId.make("codex"),
              "catalogued-tier-model",
              [{ id: "serviceTier", value: "unadvertised" }],
            ),
          }),
        );
        assert.equal(failed._tag, "Failure");
        assert.equal(validationRuntimeFactory.factory.mock.calls.length, count);
      }),
  );
  it.effect(
    "starts with exact priority from the selected model's legacy Fast capability and rejects unavailable tiers before construction",
    () =>
      Effect.gen(function* () {
        const adapter = yield* CodexAdapter;
        const instanceId = ProviderInstanceId.make("codex");
        yield* adapter.startSession({
          provider: ProviderDriverKind.make("codex"),
          threadId: asThreadId("legacy-exact-priority-start"),
          runtimeMode: "full-access",
          modelSelection: createModelSelection(instanceId, "legacy-fast-tier-model", [
            { id: "fastMode", value: false },
            { id: "serviceTier", value: "priority" },
          ]),
        });
        assert.equal(
          validationRuntimeFactory.factory.mock.calls.at(-1)?.[0].serviceTier,
          "priority",
        );
        assert.equal(
          validationRuntimeFactory.factory.mock.calls.at(-1)?.[0].model,
          "legacy-fast-tier-model",
        );
        const count = validationRuntimeFactory.factory.mock.calls.length;
        for (const [index, [model, tier]] of [
          ["revoked-fast-tier-model", "priority"],
          ["missing-fast-tier-model", "priority"],
          ["legacy-fast-tier-model", "ultrafast"],
        ].entries()) {
          const result = yield* Effect.exit(
            adapter.startSession({
              provider: ProviderDriverKind.make("codex"),
              threadId: asThreadId(`rejected-legacy-priority-start-${index}`),
              runtimeMode: "full-access",
              modelSelection: createModelSelection(instanceId, model!, [
                { id: "serviceTier", value: tier! },
              ]),
            }),
          );
          assert.equal(result._tag, "Failure");
          assert.equal(validationRuntimeFactory.factory.mock.calls.length, count);
        }
      }),
  );

  it.effect("returns validation error for non-codex provider on startSession", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const before = validationRuntimeFactory.factory.mock.calls.length;
      const result = yield* adapter
        .startSession({
          provider: ProviderDriverKind.make("claudeAgent"),
          threadId: asThreadId("thread-1"),
          runtimeMode: "full-access",
        })
        .pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      assert.deepStrictEqual(
        result.failure,
        new ProviderAdapterValidationError({
          provider: ProviderDriverKind.make("codex"),
          operation: "startSession",
          issue: "Expected provider 'codex' but received 'claudeAgent'.",
        }),
      );
      assert.equal(validationRuntimeFactory.factory.mock.calls.length, before);
    }),
  );
  it.effect("maps codex model options before starting a session", () =>
    Effect.gen(function* () {
      validationRuntimeFactory.factory.mockClear();
      const adapter = yield* CodexAdapter;

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.3-codex", [
          { id: "fastMode", value: true },
        ]),
        runtimeMode: "full-access",
      });

      const options = validationRuntimeFactory.factory.mock.calls[0]?.[0];
      assert.equal(typeof options?.historySafety?.isBlocked, "function");
      assert.equal(typeof options?.historySafety?.markBlocked, "function");
      assert.deepStrictEqual(options, {
        customInstructions: undefined,
        historySafety: options?.historySafety,
        appServerCwd: path.join(process.cwd(), "userdata"),
        binaryPath: "codex",
        cwd: process.cwd(),
        model: "gpt-5.3-codex",
        providerInstanceId: ProviderInstanceId.make("codex"),
        serviceTier: "priority",
        threadId: asThreadId("thread-1"),
        runtimeMode: "full-access",
      });
    }),
  );

  it.effect(
    "defaults unset Fast to Standard and preserves explicit Off and provider identity on start",
    () =>
      Effect.gen(function* () {
        const adapter = yield* CodexAdapter;
        const selections = [
          createModelSelection(ProviderInstanceId.make("codex"), "gpt-6-astra", [
            { id: "fastMode", value: false },
          ]),
          createModelSelection(ProviderInstanceId.make("codex"), "gpt-6-astra"),
          createModelSelection(ProviderInstanceId.make("other_codex"), "gpt-6-astra", [
            { id: "fastMode", value: true },
          ]),
          undefined,
        ];
        const expectedTiers = ["default", "default", undefined, "default"];
        validationRuntimeFactory.factory.mockClear();
        for (const [index, modelSelection] of selections.entries()) {
          yield* adapter.startSession({
            provider: ProviderDriverKind.make("codex"),
            threadId: asThreadId(`thread-astra-start-${index}`),
            runtimeMode: "approval-required",
            modelSelection,
          });
          const options = validationRuntimeFactory.factory.mock.calls[index]?.[0];
          assert.ok(options);
          assert.equal(options.serviceTier, expectedTiers[index]);
          assert.equal(Object.hasOwn(options, "serviceTier"), index !== 2);
          assert.equal(options.model, index >= 2 ? undefined : "gpt-6-astra");
        }
      }),
  );

  it.effect("forks and discards a persisted Codex thread through the native runtime", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const sourceThreadId = asThreadId("thread-native-fork-source");
      const targetThreadId = asThreadId("thread-native-fork-target");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        threadId: sourceThreadId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const fork = yield* adapter.forkSession!({
        operationId: "cmd-native-codex-fork",
        sourceThreadId,
        targetThreadId,
        title: "Native Codex fork",
      });
      assert.equal(fork.operationId, "cmd-native-codex-fork");
      assert.equal(fork.sourceThreadId, sourceThreadId);
      assert.equal(fork.targetThreadId, targetThreadId);
      assert.equal(fork.provider, ProviderDriverKind.make("codex"));
      assert.equal(fork.providerInstanceId, ProviderInstanceId.make("codex"));
      assert.equal(fork.cwd, process.cwd());
      assert.deepEqual(fork.resumeCursor, { threadId: "provider-thread-fork" });
      assert.equal(validationRuntimeFactory.lastRuntime?.forkThreadImpl.mock.calls.length, 1);

      yield* adapter.discardSessionFork!(fork);
      assert.deepEqual(validationRuntimeFactory.lastRuntime?.discardForkImpl.mock.calls[0]?.[0], {
        threadId: "provider-thread-fork",
      });
    }),
  );
});

const sessionRuntimeFactory = makeRuntimeFactory();
const transientSubagentHistoryRead = vi.fn(
  (
    options: CodexTransientSubagentHistoryReadOptions,
  ): Effect.Effect<CodexThreadSnapshot, CodexErrors.CodexAppServerTransportError> =>
    Effect.succeed({
      threadId: options.subagentThreadId,
      turns: [],
    }),
);
const sessionErrorLayer = it.layer(
  Layer.effect(
    CodexAdapter,
    Effect.gen(function* () {
      const codexConfig = decodeCodexSettings({});
      return yield* makeCodexAdapter(codexConfig, {
        makeRuntime: sessionRuntimeFactory.factory,
        getModels: () => Effect.succeed(advertisedTierModels),
        readTransientSubagentThread: transientSubagentHistoryRead,
      });
    }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

sessionErrorLayer("CodexAdapterLive session errors", (it) => {
  it.effect(
    "sends exact priority from legacy Fast capability without replacing effort and refuses unavailable model tiers before send",
    () =>
      Effect.gen(function* () {
        const adapter = yield* CodexAdapter;
        const threadId = asThreadId("legacy-exact-priority-send");
        const instanceId = ProviderInstanceId.make("codex");
        yield* adapter.startSession({
          provider: ProviderDriverKind.make("codex"),
          threadId,
          runtimeMode: "full-access",
        });
        const runtime = sessionRuntimeFactory.lastRuntime!;
        runtime.sendTurnImpl.mockClear();
        yield* adapter.sendTurn({
          threadId,
          input: "Continue",
          modelSelection: createModelSelection(instanceId, "legacy-fast-tier-model", [
            { id: "fastMode", value: false },
            { id: "serviceTier", value: "priority" },
            { id: "reasoningEffort", value: "high" },
          ]),
        });
        assert.equal(runtime.sendTurnImpl.mock.calls.length, 1);
        assert.equal(runtime.sendTurnImpl.mock.calls[0]?.[0].serviceTier, "priority");
        assert.equal(runtime.sendTurnImpl.mock.calls[0]?.[0].model, "legacy-fast-tier-model");
        assert.equal(runtime.sendTurnImpl.mock.calls[0]?.[0].effort, "high");
        for (const [model, tier] of [
          ["revoked-fast-tier-model", "priority"],
          ["missing-fast-tier-model", "priority"],
          ["legacy-fast-tier-model", "ultrafast"],
        ]) {
          const result = yield* Effect.exit(
            adapter.sendTurn({
              threadId,
              input: "Continue",
              modelSelection: createModelSelection(instanceId, model!, [
                { id: "serviceTier", value: tier! },
              ]),
            }),
          );
          assert.equal(result._tag, "Failure");
          assert.equal(runtime.sendTurnImpl.mock.calls.length, 1);
        }
      }),
  );

  it.effect(
    "sends exact advertised tiers and rejects removed or foreign model tiers without a paid turn",
    () =>
      Effect.gen(function* () {
        const adapter = yield* CodexAdapter;
        const threadId = asThreadId("exact-service-tier-send");
        yield* adapter.startSession({
          provider: ProviderDriverKind.make("codex"),
          threadId,
          runtimeMode: "full-access",
        });
        const runtime = sessionRuntimeFactory.lastRuntime!;
        runtime.sendTurnImpl.mockClear();
        for (const value of ["ultrafast", "default"]) {
          yield* adapter.sendTurn({
            threadId,
            input: "Continue",
            modelSelection: createModelSelection(
              ProviderInstanceId.make("codex"),
              "catalogued-tier-model",
              [{ id: "serviceTier", value }],
            ),
          });
        }
        assert.deepEqual(
          runtime.sendTurnImpl.mock.calls.map(([input]) => input.serviceTier),
          ["ultrafast", "default"],
        );
        for (const [model, value] of [
          ["catalogued-tier-model", "removed"],
          ["other-model", "ultrafast"],
        ]) {
          const result = yield* Effect.exit(
            adapter.sendTurn({
              threadId,
              input: "Continue",
              modelSelection: createModelSelection(ProviderInstanceId.make("codex"), model!, [
                { id: "serviceTier", value: value! },
              ]),
            }),
          );
          assert.equal(result._tag, "Failure");
        }
        assert.equal(runtime.sendTurnImpl.mock.calls.length, 2);
      }),
  );

  it.effect("uses a transient reader without materializing a session or runtime events", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const threadId = asThreadId("sess-ended-subagent-detail");
      const childId = "provider-child-ended";
      const runtimeCountBefore = sessionRuntimeFactory.factory.mock.calls.length;
      transientSubagentHistoryRead.mockClear();

      const readSubagentDetail = adapter.readSubagentDetail;
      assert.ok(readSubagentDetail);
      const detail = yield* readSubagentDetail(threadId, childId, {
        resumeCursor: { threadId: "provider-root-ended" },
      });

      assert.deepEqual(detail, { messages: [], gaps: [], truncated: false });
      assert.equal(sessionRuntimeFactory.factory.mock.calls.length, runtimeCountBefore);
      assert.equal(transientSubagentHistoryRead.mock.calls.length, 1);
      assert.equal(
        typeof transientSubagentHistoryRead.mock.calls[0]?.[0].onHistoryDiagnostic,
        "function",
      );
      assert.deepEqual(transientSubagentHistoryRead.mock.calls[0]?.[0], {
        binaryPath: "codex",
        appServerCwd: path.join(process.cwd(), "userdata"),
        rootProviderThreadId: "provider-root-ended",
        subagentThreadId: childId,
        onHistoryDiagnostic: transientSubagentHistoryRead.mock.calls[0]?.[0].onHistoryDiagnostic,
      });
      assert.equal(
        (yield* adapter.listSessions()).some((session) => session.threadId === threadId),
        false,
      );
    }),
  );

  it.effect("isolates public history reads even when the exact root is live", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const threadId = asThreadId("sess-live-subagent-detail");
      const childId = "provider-child-live";
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId,
        runtimeMode: "full-access",
      });
      const runtime = sessionRuntimeFactory.lastRuntime;
      assert.ok(runtime);
      transientSubagentHistoryRead.mockClear();
      runtime.readSubagentThreadImpl.mockClear();

      const readSubagentDetail = adapter.readSubagentDetail;
      assert.ok(readSubagentDetail);
      yield* readSubagentDetail(threadId, childId, {
        resumeCursor: { threadId: "provider-thread-1" },
      });

      assert.equal(transientSubagentHistoryRead.mock.calls.length, 1);
      assert.equal(runtime.readSubagentThreadImpl.mock.calls.length, 0);
      assert.equal(transientSubagentHistoryRead.mock.calls[0]?.[0].subagentThreadId, childId);
    }),
  );

  it.effect("keeps an ended child pinned to its persisted root when another root is live", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const threadId = asThreadId("sess-live-different-root-subagent-detail");
      const childId = "provider-child-from-ended-root";
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId,
        runtimeMode: "full-access",
      });
      const runtime = sessionRuntimeFactory.lastRuntime;
      assert.ok(runtime);
      transientSubagentHistoryRead.mockClear();
      runtime.readSubagentThreadImpl.mockClear();

      const readSubagentDetail = adapter.readSubagentDetail;
      assert.ok(readSubagentDetail);
      yield* readSubagentDetail(threadId, childId, {
        resumeCursor: { threadId: "provider-root-that-ended" },
      });

      assert.equal(runtime.readSubagentThreadImpl.mock.calls.length, 0);
      assert.equal(transientSubagentHistoryRead.mock.calls.length, 1);
      assert.equal(
        typeof transientSubagentHistoryRead.mock.calls[0]?.[0].onHistoryDiagnostic,
        "function",
      );
      assert.deepEqual(transientSubagentHistoryRead.mock.calls[0]?.[0], {
        binaryPath: "codex",
        appServerCwd: path.join(process.cwd(), "userdata"),
        rootProviderThreadId: "provider-root-that-ended",
        subagentThreadId: childId,
        onHistoryDiagnostic: transientSubagentHistoryRead.mock.calls[0]?.[0].onHistoryDiagnostic,
      });
    }),
  );

  it.effect("bounds concurrent transient history spawns to one per adapter", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const firstStarted = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      transientSubagentHistoryRead.mockClear();
      transientSubagentHistoryRead.mockImplementationOnce((options) =>
        Deferred.succeed(firstStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseFirst)),
          Effect.as({ threadId: options.subagentThreadId, turns: [] }),
        ),
      );
      const readSubagentDetail = adapter.readSubagentDetail;
      assert.ok(readSubagentDetail);

      const first = yield* readSubagentDetail(
        asThreadId("sess-ended-history-first"),
        "provider-child-first",
        { resumeCursor: { threadId: "provider-root-first" } },
      ).pipe(Effect.forkChild);
      yield* Deferred.await(firstStarted);
      const retry = yield* readSubagentDetail(
        asThreadId("sess-ended-history-retry"),
        "provider-child-retry",
        { resumeCursor: { threadId: "provider-root-retry" } },
      ).pipe(Effect.forkChild);
      yield* Effect.yieldNow;

      assert.equal(transientSubagentHistoryRead.mock.calls.length, 1);
      yield* Deferred.succeed(releaseFirst, undefined);
      yield* Effect.all([Fiber.join(first), Fiber.join(retry)]);
      assert.equal(transientSubagentHistoryRead.mock.calls.length, 2);
    }),
  );

  it.effect("times out a wedged transient history read and releases its permit", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      transientSubagentHistoryRead.mockClear();
      transientSubagentHistoryRead.mockImplementationOnce(() => Effect.never);
      const readSubagentDetail = adapter.readSubagentDetail;
      assert.ok(readSubagentDetail);

      const timedOut = yield* readSubagentDetail(
        asThreadId("sess-ended-history-timeout"),
        "provider-child-timeout",
        { resumeCursor: { threadId: "provider-root-timeout" } },
      ).pipe(Effect.result, Effect.forkChild);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("15 seconds");
      const result = yield* Fiber.join(timedOut);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure._tag, "ProviderSubagentDetailReadError");
        if (result.failure._tag === "ProviderSubagentDetailReadError") {
          assert.equal(result.failure.reason, "provider-request-failed");
        }
      }

      const retry = yield* readSubagentDetail(
        asThreadId("sess-ended-history-after-timeout"),
        "provider-child-after-timeout",
        { resumeCursor: { threadId: "provider-root-after-timeout" } },
      );
      assert.deepEqual(retry, { messages: [], gaps: [], truncated: false });
      assert.equal(transientSubagentHistoryRead.mock.calls.length, 2);
    }),
  );

  it.effect("maps missing adapter sessions to ProviderAdapterSessionNotFoundError", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const result = yield* adapter
        .sendTurn({
          threadId: asThreadId("sess-never-started"),
          input: "hello",
          attachments: [],
        })
        .pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      assert.equal(result.failure._tag, "ProviderAdapterSessionNotFoundError");
      assert.equal(result.failure.provider, "codex");
      assert.equal(result.failure.threadId, "sess-never-started");
    }),
  );

  it.effect("preserves uncertain rewind outcome tags for checkpoint compensation", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const threadId = asThreadId("sess-rewind-outcome-unknown");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId,
        runtimeMode: "full-access",
      });
      const runtime = sessionRuntimeFactory.lastRuntime;
      assert.ok(runtime);
      const failure = new ProviderAdapterRewindOutcomeUnknownError({});
      runtime.rollbackThreadImpl.mockRejectedValueOnce(failure);
      const result = yield* adapter.rollbackThread(threadId, 1).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      assert.equal(result.failure, failure);
      assert.equal(runtime.rollbackThreadImpl.mock.calls.length, 1);
    }),
  );

  it.effect("redacts provider child-read messages, causes, ids, and stacks", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const threadId = asThreadId("sess-subagent-detail-redaction");
      const childId = "sentinel-child-id-do-not-log";
      const sentinels = [
        childId,
        "/Users/private-account/.codex/rollouts/secret.jsonl",
        "account-owner@example.invalid",
        "raw-response-body-secret",
        "upstream-stack-secret",
      ];
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId,
        runtimeMode: "full-access",
      });
      const runtime = sessionRuntimeFactory.lastRuntime;
      assert.ok(runtime);

      const upstreamCause = new Error(`${sentinels[1]} ${sentinels[2]} ${sentinels[3]}`);
      upstreamCause.stack = `Error: ${sentinels[4]}\n    at ${sentinels[1]}:1:1`;
      transientSubagentHistoryRead.mockImplementationOnce(() =>
        Effect.fail(
          new CodexErrors.CodexAppServerTransportError({
            detail: `transport rejected ${childId}: ${sentinels[3]}`,
            cause: upstreamCause,
          }),
        ),
      );

      const readSubagentDetail = adapter.readSubagentDetail;
      assert.ok(readSubagentDetail);
      const result = yield* readSubagentDetail(threadId, childId).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      assert.equal(result.failure._tag, "ProviderSubagentDetailReadError");
      if (result.failure._tag !== "ProviderSubagentDetailReadError") return;
      assert.equal(result.failure.reason, "provider-transport-unavailable");
      assert.equal(result.failure.stack, undefined);

      const serialized = encodeProviderJsonString({
        error: result.failure,
        message: result.failure.message,
        stack: result.failure.stack,
      });
      for (const sentinel of sentinels) {
        assert.doesNotMatch(
          serialized,
          new RegExp(sentinel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        );
      }
    }),
  );

  it.effect("preserves explicit native review targets and prohibits active-turn fallback", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const threadId = asThreadId("native-review-routing");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId,
        runtimeMode: "approval-required",
      });
      const runtime = sessionRuntimeFactory.lastRuntime;
      assert.ok(runtime);
      runtime.sendTurnImpl.mockClear();
      const codexReview = { type: "baseBranch" as const, branch: "origin/main" };
      yield* adapter.sendTurn({
        threadId,
        input: "Display-only review description",
        codexReview,
        modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-6.1-sol", [
          { id: "serviceTier", value: "not-advertised" },
          { id: "cyberAccessProgram", value: "not-advertised" },
          { id: "reasoningEffort", value: "ultra" },
        ]),
        interactionMode: "plan",
        allowActiveTurnSteerFallback: true,
        attachments: [],
      });
      assert.equal(runtime.sendTurnImpl.mock.calls.length, 1);
      assert.deepStrictEqual(runtime.sendTurnImpl.mock.calls[0]?.[0]?.codexReview, codexReview);
      assert.equal(runtime.sendTurnImpl.mock.calls[0]?.[0]?.allowActiveTurnSteerFallback, false);
      assert.equal(runtime.sendTurnImpl.mock.calls[0]?.[0]?.model, undefined);
      assert.equal(runtime.sendTurnImpl.mock.calls[0]?.[0]?.effort, undefined);
      assert.equal(runtime.sendTurnImpl.mock.calls[0]?.[0]?.serviceTier, undefined);
      assert.equal(Object.hasOwn(runtime.sendTurnImpl.mock.calls[0]![0], "serviceTier"), false);
      assert.equal(runtime.sendTurnImpl.mock.calls[0]?.[0]?.cyberAccessProgram, undefined);
      assert.equal(runtime.sendTurnImpl.mock.calls[0]?.[0]?.interactionMode, undefined);
      yield* adapter.sendTurn({
        threadId,
        input: "Review the retained native settings",
        codexReview,
      });
      assert.equal(runtime.sendTurnImpl.mock.calls.length, 2);
      assert.equal(Object.hasOwn(runtime.sendTurnImpl.mock.calls[1]![0], "serviceTier"), false);

      const invalid = yield* Effect.exit(
        adapter.sendTurn({
          threadId,
          input: "Native review",
          codexReview,
          modelSelection: createModelSelection(
            ProviderInstanceId.make("different-account"),
            "gpt-6.1-sol",
          ),
        }),
      );
      assert.equal(invalid._tag, "Failure");
      assert.equal(runtime.sendTurnImpl.mock.calls.length, 2);
    }),
  );

  it.effect("maps codex model options before sending a turn", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("sess-missing"),
        runtimeMode: "full-access",
      });
      const runtime = sessionRuntimeFactory.lastRuntime;
      assert.ok(runtime);
      runtime.sendTurnImpl.mockClear();

      yield* Effect.ignore(
        adapter.sendTurn({
          threadId: asThreadId("sess-missing"),
          input: "hello",
          modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.3-codex", [
            { id: "reasoningEffort", value: "high" },
            { id: "fastMode", value: true },
          ]),
          attachments: [],
        }),
      );

      assert.deepStrictEqual(runtime.sendTurnImpl.mock.calls[0]?.[0], {
        input: "hello",
        model: "gpt-5.3-codex",
        effort: "high",
        serviceTier: "priority",
      });
    }),
  );

  it.effect(
    "turns Astra Fast on, off and unset to Standard while retaining Ultra and exact account routing",
    () =>
      Effect.gen(function* () {
        const adapter = yield* CodexAdapter;
        const threadId = asThreadId("sess-astra-fast-toggle");
        yield* adapter.startSession({
          provider: ProviderDriverKind.make("codex"),
          threadId,
          runtimeMode: "approval-required",
        });
        const runtime = sessionRuntimeFactory.lastRuntime;
        assert.ok(runtime);
        runtime.sendTurnImpl.mockClear();

        for (const fastMode of [true, false, undefined]) {
          yield* adapter.sendTurn({
            threadId,
            input: "Continue",
            modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-6-astra", [
              { id: "reasoningEffort", value: "ultra" },
              ...(fastMode === undefined ? [] : [{ id: "fastMode", value: fastMode }]),
            ]),
            attachments: [],
          });
        }
        yield* adapter.sendTurn({ threadId, input: "Continue", attachments: [] });
        yield* adapter.sendTurn({
          threadId,
          input: "Continue",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("other_codex"),
            "gpt-6-astra",
            [{ id: "fastMode", value: false }],
          ),
          attachments: [],
        });

        assert.deepStrictEqual(
          runtime.sendTurnImpl.mock.calls.map(([input]) => input),
          [
            { input: "Continue", model: "gpt-6-astra", effort: "ultra", serviceTier: "priority" },
            { input: "Continue", model: "gpt-6-astra", effort: "ultra", serviceTier: "default" },
            { input: "Continue", model: "gpt-6-astra", effort: "ultra", serviceTier: "default" },
            { input: "Continue", serviceTier: "default" },
            { input: "Continue" },
          ],
        );
      }),
  );

  it.effect(
    "binds unchanged-policy send and steer to the exact native runtime and retains the final fence",
    () =>
      Effect.gen(function* () {
        const adapter = yield* CodexAdapter;
        const threadId = asThreadId("fenced-existing-policy");
        yield* adapter.startSession({
          threadId,
          runtimeMode: "full-access",
          maxConcurrentSubagents: 16,
        });
        const runtime = sessionRuntimeFactory.lastRuntime;
        assert.ok(runtime);
        const expected = {
          threadId,
          providerInstanceId: ProviderInstanceId.make("codex"),
          subagentRuntimeId: SubagentRuntimeId.make("00000000-0000-4000-8000-000000000016"),
          maxConcurrentSubagents: 16,
        };
        const snapshot = yield* runtime.getSession;
        runtime.getSessionImpl.mockResolvedValue({ ...snapshot, ...expected, status: "ready" });
        yield* adapter.sendTurn({
          threadId,
          input: "Synthetic next turn",
          expectedSubagentPolicySession: expected,
        });
        yield* adapter.steerTurn({
          threadId,
          expectedTurnId: asTurnId("active-root"),
          input: "Synthetic steer",
          expectedSubagentPolicySession: expected,
        });
        assert.deepEqual(
          runtime.sendTurnImpl.mock.calls[0]?.[0].expectedSubagentPolicySession,
          expected,
        );
        assert.equal(Object.hasOwn(runtime.sendTurnImpl.mock.calls[0]![0], "serviceTier"), false);
        assert.deepEqual(
          runtime.steerTurnImpl.mock.calls[0]?.[0].expectedSubagentPolicySession,
          expected,
        );
        runtime.getSessionImpl.mockResolvedValue({
          ...snapshot,
          ...expected,
          status: "ready",
          maxConcurrentSubagents: 17,
        });
        assert.equal(
          (yield* adapter
            .sendTurn({
              threadId,
              input: "Synthetic refused send",
              expectedSubagentPolicySession: expected,
            })
            .pipe(Effect.result))._tag,
          "Failure",
        );
        assert.equal(
          (yield* adapter
            .steerTurn({
              threadId,
              expectedTurnId: asTurnId("active-root"),
              input: "Synthetic refused steer",
              expectedSubagentPolicySession: expected,
            })
            .pipe(Effect.result))._tag,
          "Failure",
        );
        assert.equal(runtime.sendTurnImpl.mock.calls.length, 1);
        assert.equal(runtime.steerTurnImpl.mock.calls.length, 1);
        assert.equal(runtime.closeImpl.mock.calls.length, 0);
      }),
  );

  it.effect("routes live steering through Codex turn/steer without turn-start overrides", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("sess-steer"),
        runtimeMode: "full-access",
      });
      const runtime = sessionRuntimeFactory.lastRuntime;
      assert.ok(runtime);
      runtime.steerTurnImpl.mockClear();
      runtime.sendTurnImpl.mockClear();
      const messageId = decodeMessageId(
        `message-steer-\u0000-\u202e-${"provider-state-canary".repeat(80)}`,
      );

      const result = yield* adapter.steerTurn({
        threadId: asThreadId("sess-steer"),
        expectedTurnId: asTurnId("turn-active"),
        messageId,
        input: "keep going but narrow the scope",
        attachments: [],
      });

      assert.equal(runtime.sendTurnImpl.mock.calls.length, 0);
      assert.deepStrictEqual(runtime.steerTurnImpl.mock.calls[0]?.[0], {
        expectedTurnId: asTurnId("turn-active"),
        clientCorrelationId: buildCodexSteerClientCorrelationId(messageId),
        input: "keep going but narrow the scope",
      });
      const serializedRuntimeInput = encodeProviderJsonString(
        runtime.steerTurnImpl.mock.calls[0]?.[0],
      );
      assert.equal(serializedRuntimeInput.includes('"messageId"'), false);
      assert.equal(serializedRuntimeInput.includes("provider-state-canary"), false);
      assert.equal(result.clientCorrelationId, buildCodexSteerClientCorrelationId(messageId));
    }),
  );

  it.effect("maps codex model options for the adapter's bound custom instance id", () => {
    const customInstanceId = ProviderInstanceId.make("codex_personal");
    const customRuntimeFactory = makeRuntimeFactory();
    const customLayer = Layer.effect(
      CodexAdapter,
      Effect.gen(function* () {
        const codexConfig = decodeCodexSettings({});
        return yield* makeCodexAdapter(codexConfig, {
          instanceId: customInstanceId,
          makeRuntime: customRuntimeFactory.factory,
        });
      }),
    ).pipe(
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(providerSessionDirectoryTestLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("sess-custom-instance"),
        runtimeMode: "full-access",
      });
      const runtime = customRuntimeFactory.lastRuntime;
      assert.ok(runtime);
      runtime.sendTurnImpl.mockClear();

      yield* Effect.ignore(
        adapter.sendTurn({
          threadId: asThreadId("sess-custom-instance"),
          input: "hello",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("codex_personal"),
            "gpt-5.3-codex",
            [
              { id: "reasoningEffort", value: "high" },
              { id: "fastMode", value: true },
            ],
          ),
          attachments: [],
        }),
      );

      assert.deepStrictEqual(runtime.sendTurnImpl.mock.calls[0]?.[0], {
        input: "hello",
        model: "gpt-5.3-codex",
        effort: "high",
        serviceTier: "priority",
      });
    }).pipe(Effect.provide(customLayer));
  });

  it.effect(
    "propagates configured Codex runtime limits into runtime options and reported usage",
    () => {
      const customRuntimeFactory = makeRuntimeFactory();
      const configuredTransientHistoryRead = vi.fn(
        (options: CodexTransientSubagentHistoryReadOptions): Effect.Effect<CodexThreadSnapshot> =>
          Effect.succeed({
            threadId: options.subagentThreadId,
            turns: [],
          }),
      );
      const customLayer = Layer.effect(
        CodexAdapter,
        Effect.gen(function* () {
          const codexConfig = decodeCodexSettings({
            autoCompactTokenLimit: 150_000,
            maxConcurrentSubagents: 12,
          });
          return yield* makeCodexAdapter(codexConfig, {
            makeRuntime: customRuntimeFactory.factory,
            readTransientSubagentThread: configuredTransientHistoryRead,
          });
        }),
      ).pipe(
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
        Layer.provideMerge(ServerSettingsService.layerTest()),
        Layer.provideMerge(providerSessionDirectoryTestLayer),
        Layer.provideMerge(NodeServices.layer),
      );

      return Effect.gen(function* () {
        const adapter = yield* CodexAdapter;
        yield* adapter.startSession({
          provider: ProviderDriverKind.make("codex"),
          threadId: asThreadId("sess-custom-auto-compact"),
          runtimeMode: "full-access",
        });
        const runtime = customRuntimeFactory.lastRuntime;
        assert.ok(runtime);
        assert.equal(runtime.options.autoCompactTokenLimit, 150_000);
        assert.equal(runtime.options.maxConcurrentSubagents, 12);

        const readSubagentDetail = adapter.readSubagentDetail;
        assert.ok(readSubagentDetail);
        yield* readSubagentDetail(
          asThreadId("sess-custom-runtime-limits-ended"),
          "provider-child-custom-runtime-limits",
          { resumeCursor: { threadId: "provider-root-custom-runtime-limits" } },
        );
        assert.equal(configuredTransientHistoryRead.mock.calls[0]?.[0].maxConcurrentSubagents, 12);

        const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

        yield* runtime.emit({
          id: asEventId("evt-codex-thread-token-usage-updated-custom-limit"),
          kind: "notification",
          provider: ProviderDriverKind.make("codex"),
          threadId: asThreadId("sess-custom-auto-compact"),
          turnId: asTurnId("turn-1"),
          createdAt: "2026-01-01T00:00:00.000Z",
          method: "thread/tokenUsage/updated",
          payload: {
            threadId: "sess-custom-auto-compact",
            turnId: "turn-1",
            tokenUsage: {
              total: {
                inputTokens: 100,
                cachedInputTokens: 0,
                outputTokens: 6,
                reasoningOutputTokens: 0,
                totalTokens: 106,
              },
              last: {
                inputTokens: 100,
                cachedInputTokens: 0,
                outputTokens: 6,
                reasoningOutputTokens: 0,
                totalTokens: 106,
              },
              modelContextWindow: 258_400,
            },
          },
        } satisfies ProviderEvent);

        const firstEvent = yield* Fiber.join(firstEventFiber);
        assert.equal(firstEvent._tag, "Some");
        if (firstEvent._tag !== "Some") {
          return;
        }
        assert.equal(firstEvent.value.type, "thread.token-usage.updated");
        if (firstEvent.value.type !== "thread.token-usage.updated") {
          return;
        }
        assert.equal(firstEvent.value.payload.usage.autoCompactTokenLimit, 150_000);
      }).pipe(Effect.provide(customLayer));
    },
  );

  for (const request of [
    { label: "explicit compaction", autoCompactTokenLimit: 150_000 },
    { label: "no separate compaction setting", autoCompactTokenLimit: undefined },
    { label: "inherited compaction ignored", autoCompactTokenLimit: undefined, inherited: true },
    { label: "accessor compaction ignored", autoCompactTokenLimit: undefined, accessor: true },
  ] as const) {
    const { autoCompactTokenLimit } = request;
    it.effect(
      `keeps native usage capacity authoritative for an 800K context request with ${request.label}`,
      () => {
        const customRuntimeFactory = makeRuntimeFactory();
        let accessorReads = 0;
        const customLayer = Layer.effect(
          CodexAdapter,
          Effect.gen(function* () {
            const codexConfig = decodeCodexSettings(
              autoCompactTokenLimit !== undefined ? { autoCompactTokenLimit } : {},
            );
            if ("inherited" in request) {
              Object.setPrototypeOf(codexConfig, { autoCompactTokenLimit: 150_000 });
            }
            if ("accessor" in request) {
              Object.defineProperty(codexConfig, "autoCompactTokenLimit", {
                enumerable: true,
                get: () => {
                  accessorReads += 1;
                  return 150_000;
                },
              });
            }
            return yield* makeCodexAdapter(codexConfig, {
              makeRuntime: customRuntimeFactory.factory,
              getCodexContextWindowSupport: () => true,
            });
          }),
        ).pipe(
          Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
          Layer.provideMerge(ServerSettingsService.layerTest()),
          Layer.provideMerge(providerSessionDirectoryTestLayer),
          Layer.provideMerge(NodeServices.layer),
        );

        return Effect.gen(function* () {
          const adapter = yield* CodexAdapter;
          const threadId = asThreadId("sess-context-native-usage");
          const session = yield* adapter.startSession({
            provider: ProviderDriverKind.make("codex"),
            threadId,
            runtimeMode: "full-access",
            codexContextWindowOverride: 800_000,
          });
          const runtime = customRuntimeFactory.lastRuntime;
          assert.ok(runtime);
          assert.equal(session.codexContextWindowOverride, 800_000);
          assert.equal(runtime.options.codexContextWindowOverride, 800_000);
          assert.equal(runtime.options.autoCompactTokenLimit, autoCompactTokenLimit);
          assert.equal(accessorReads, 0);
          // The adapter cannot fabricate new-opening request evidence from
          // settings; only the actual native runtime can report that field.
          assert.equal(session.codexAutoCompactTokenLimit, undefined);
          assert.equal(
            "autoCompactTokenLimit" in runtime.options,
            autoCompactTokenLimit !== undefined,
          );

          const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(
            Effect.forkChild,
          );
          yield* runtime.emit({
            id: asEventId("evt-context-native-usage"),
            kind: "notification",
            provider: ProviderDriverKind.make("codex"),
            threadId,
            turnId: asTurnId("turn-context-native-usage"),
            createdAt: "2026-01-01T00:00:00.000Z",
            method: "thread/tokenUsage/updated",
            payload: {
              threadId: "sess-context-native-usage",
              turnId: "turn-context-native-usage",
              tokenUsage: {
                total: {
                  inputTokens: 100,
                  cachedInputTokens: 0,
                  outputTokens: 6,
                  reasoningOutputTokens: 0,
                  totalTokens: 106,
                },
                last: {
                  inputTokens: 100,
                  cachedInputTokens: 0,
                  outputTokens: 6,
                  reasoningOutputTokens: 0,
                  totalTokens: 106,
                },
                // Received native usable capacity deliberately differs from
                // the nominal request. It is not a compaction-threshold event.
                modelContextWindow: 760_000,
              },
            },
          } satisfies ProviderEvent);

          const firstEvent = yield* Fiber.join(firstEventFiber);
          assert.equal(firstEvent._tag, "Some");
          if (firstEvent._tag !== "Some") {
            return;
          }
          assert.equal(firstEvent.value.type, "thread.token-usage.updated");
          if (firstEvent.value.type !== "thread.token-usage.updated") {
            return;
          }
          const usage = firstEvent.value.payload.usage;
          assert.equal(usage.maxTokens, 760_000);
          assert.equal(usage.usedTokens, 106);
          assert.equal(usage.compactsAutomatically, true);
          assert.equal(usage.autoCompactTokenLimit, autoCompactTokenLimit);
          assert.equal("autoCompactTokenLimit" in usage, autoCompactTokenLimit !== undefined);
          assert.equal(accessorReads, 0);
        }).pipe(Effect.provide(customLayer));
      },
    );
  }
});

const lifecycleRuntimeFactory = makeRuntimeFactory();
const lifecycleLayer = it.layer(
  Layer.effect(
    CodexAdapter,
    Effect.gen(function* () {
      const codexConfig = decodeCodexSettings({});
      return yield* makeCodexAdapter(codexConfig, {
        makeRuntime: lifecycleRuntimeFactory.factory,
      });
    }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

function startLifecycleRuntime(subagentRuntimeId?: string) {
  return Effect.gen(function* () {
    if (subagentRuntimeId !== undefined) {
      lifecycleRuntimeFactory.factory.mockImplementationOnce((options) => {
        const runtime = new FakeCodexRuntime(options);
        // The bridge reads this already-created descriptor before consuming
        // events. Supply synthetic runtime authority without starting a CLI.
        runtime.getSession = runtime.getSession.pipe(
          Effect.map((session) => ({ ...session, subagentRuntimeId })),
        );
        lifecycleRuntimeFactory.runtimes.push(runtime);
        return Effect.succeed(runtime);
      });
    }
    const adapter = yield* CodexAdapter;
    yield* adapter.startSession({
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      runtimeMode: "full-access",
    });
    const runtime = lifecycleRuntimeFactory.lastRuntime;
    assert.ok(runtime);
    return { adapter, runtime };
  });
}

lifecycleLayer("CodexAdapterLive lifecycle", (it) => {
  it.effect(
    "preserves admitted ordinary task owners across item edges without trusting native owner fields",
    () =>
      Effect.gen(function* () {
        const { adapter, runtime } = yield* startLifecycleRuntime();
        const owners: readonly (ProviderTaskOwner | undefined)[] = [
          { type: "child", id: "source-child" },
          { type: "root" },
          undefined,
        ];
        const methods = [
          "item/started",
          "item/commandExecution/terminalInteraction",
          "item/completed",
        ] as const;
        const barrierId = asEventId("owned-item-fixture-barrier");
        const barrierObserved = yield* Deferred.make<void>();
        const eventsFiber = yield* adapter.streamEvents.pipe(
          Stream.tap((event) =>
            event.eventId === barrierId
              ? Deferred.succeed(barrierObserved, undefined)
              : Effect.void,
          ),
          Stream.takeUntil((event) => event.eventId === barrierId),
          Stream.runCollect,
          Effect.forkChild,
        );
        const originals: string[] = [];
        const inputs: ProviderEvent[] = [];
        for (const [index, taskOwner] of owners.entries())
          for (const [edge, method] of methods.entries()) {
            const itemId = asItemId(`owned-item-${index}`);
            const event: ProviderEvent = {
              id: asEventId(`owned-item-${index}-${edge}`),
              kind: "notification",
              provider: ProviderDriverKind.make("codex"),
              createdAt: "2026-10-14T00:00:00.000Z",
              threadId: asThreadId("thread-1"),
              turnId: asTurnId("parent-turn"),
              itemId,
              method,
              ...(taskOwner ? { taskOwner } : {}),
              payload: {
                threadId: taskOwner?.type === "child" ? taskOwner.id : "provider-thread-1",
                turnId: "native-tool-turn",
                ...(method === "item/started"
                  ? { startedAtMs: 1 }
                  : method === "item/completed"
                    ? { completedAtMs: 2 }
                    : {
                        itemId,
                        processId: `synthetic-process-${index}`,
                        stdin: "Synthetic terminal input",
                      }),
                taskOwner: { type: "child", id: "counterfeit-native-owner" },
                item: {
                  id: itemId,
                  type: "commandExecution",
                  command: "node --version",
                  commandActions: [],
                  cwd: "/workspace",
                  status: edge === 2 ? "completed" : "inProgress",
                  taskOwner: { type: "root" },
                  receiverThreadIds: ["receiver-child"],
                },
              },
            };
            // Native lifecycle timestamps and terminal input coordinates are
            // required by the pinned codec. Refuse a malformed fixture before
            // waiting for a mapped event that the adapter correctly omits.
            assert.equal(
              method === "item/started"
                ? isStartedItem(event.payload)
                : method === "item/completed"
                  ? isCompletedItem(event.payload)
                  : isTerminalInteraction(event.payload),
              true,
            );
            inputs.push(event);
            originals.push(encodeProviderJsonString(event));
            yield* runtime.emit(event);
          }
        // Observe this exact real mapped FIFO sentinel, not Queue.offer or a
        // mock call. Missing item edges now fail the same strict count below
        // instead of waiting until the enclosing unchanged test deadline.
        yield* runtime.emit({
          id: barrierId,
          kind: "notification",
          provider: ProviderDriverKind.make("codex"),
          threadId: asThreadId("thread-1"),
          createdAt: "2026-10-14T00:00:00.000Z",
          method: "warning",
          message: "Owner item fixture barrier",
        });
        yield* Deferred.await(barrierObserved);
        const collected = Array.from(yield* Fiber.join(eventsFiber));
        assert.equal(collected.at(-1)?.type, "runtime.warning");
        const events = collected.filter((event) => event.eventId !== barrierId);
        assert.equal(events.length, owners.length * methods.length);
        for (const [index, event] of events.entries()) {
          assert.equal(event.type, ["item.started", "item.updated", "item.completed"][index % 3]);
          if (
            event.type !== "item.started" &&
            event.type !== "item.updated" &&
            event.type !== "item.completed"
          )
            return assert.fail("Expected exact ordinary item lifecycle");
          assert.deepEqual(event.payload.taskOwner, owners[Math.floor(index / 3)]);
          assert.equal(event.payload.itemType, "command_execution");
          assert.equal(event.threadId, "thread-1");
          assert.equal(event.turnId, "parent-turn");
          assert.equal(event.itemId, `owned-item-${Math.floor(index / 3)}`);
          assert.equal(event.payload.individualTaskControl, undefined);
        }
        assert.deepEqual(
          inputs.map((event) => JSON.stringify(event)),
          originals,
        );
        assert.equal(runtime.sendTurnImpl.mock.calls.length, 0);
        assert.equal(runtime.steerTurnImpl.mock.calls.length, 0);
      }),
  );

  it.effect(
    "retains exact child ownership on compaction without adopting its native target data",
    () =>
      Effect.gen(function* () {
        const { adapter, runtime } = yield* startLifecycleRuntime();
        const barrierId = asEventId("child-compaction-fixture-barrier");
        const tracker = makeCodexCompactionDiagnosticsTracker();
        tracker.setRootOpeningRequests({ contextWindow: 800_000, autoCompactTokenLimit: 700_000 });
        const source = {
          sourceId: "source-child",
          sourceOwner: { type: "child" as const, id: "source-child" },
          observedAt: "2026-10-14T00:00:00.000Z",
          nativeTurnId: "child-native-turn",
        };
        tracker.observeUsage({
          ...source,
          tokenUsage: {
            last: {
              inputTokens: 110_000,
              cachedInputTokens: 90_000,
              outputTokens: 10_000,
              reasoningOutputTokens: 5_000,
              totalTokens: 120_000,
            },
            total: { totalTokens: 900_000 },
            modelContextWindow: 760_000,
          },
        });
        const expectedDiagnostics = [];
        const barrierObserved = yield* Deferred.make<void>();
        const eventsFiber = yield* adapter.streamEvents.pipe(
          Stream.tap((event) =>
            event.eventId === barrierId
              ? Deferred.succeed(barrierObserved, undefined)
              : Effect.void,
          ),
          Stream.takeUntil((event) => event.eventId === barrierId),
          Stream.runCollect,
          Effect.forkChild,
        );
        for (const method of ["item/started", "item/completed"] as const) {
          const codexCompactionObservation = tracker.observeCompaction({
            ...source,
            phase: method === "item/started" ? "started" : "completed",
            nativeItemId: "child-compaction",
          });
          assert.ok(codexCompactionObservation);
          expectedDiagnostics.push(codexCompactionObservation);
          const nativePayload = {
            threadId: "source-child",
            turnId: "child-native-turn",
            taskOwner: { type: "root" },
            item: { id: "child-compaction", type: "contextCompaction" },
          };
          const event: ProviderEvent = {
            id: asEventId(`child-compaction-${method}`),
            kind: "notification",
            provider: ProviderDriverKind.make("codex"),
            createdAt: "2026-10-14T00:00:00.000Z",
            threadId: asThreadId("thread-1"),
            turnId: asTurnId("parent-turn"),
            itemId: asItemId("child-compaction"),
            method,
            taskOwner: { type: "child", id: "source-child" },
            codexCompactionObservation,
            payload: {
              ...nativePayload,
              codexCompactionObservation: {
                ...codexCompactionObservation,
                sourceOwner: { type: "root" },
              },
              ...(method === "item/started" ? { startedAtMs: 1 } : { completedAtMs: 2 }),
            },
          };
          const isNativeItem = method === "item/started" ? isStartedItem : isCompletedItem;
          assert.equal(isNativeItem(event.payload), true);
          // Preserve the demonstrated malformed-clock boundary as an exact
          // negative. These two timestamp-less native envelopes must map zero
          // item edges, even with a seemingly valid outer owner witness.
          assert.equal(isNativeItem(nativePayload), false);
          yield* runtime.emit({
            ...event,
            id: asEventId(`child-compaction-missing-clock-${method}`),
            payload: nativePayload,
          });
          yield* runtime.emit(event);
        }
        yield* runtime.emit({
          id: barrierId,
          kind: "notification",
          provider: ProviderDriverKind.make("codex"),
          threadId: asThreadId("thread-1"),
          createdAt: "2026-10-14T00:00:00.000Z",
          method: "warning",
          message: "Child compaction fixture barrier",
        });
        yield* Deferred.await(barrierObserved);
        const collected = Array.from(yield* Fiber.join(eventsFiber));
        assert.equal(collected.at(-1)?.type, "runtime.warning");
        const events = collected.filter((event) => event.eventId !== barrierId);
        assert.deepEqual(
          events.map((event) => event.type),
          ["item.started", "item.completed"],
        );
        for (const [index, event] of events.entries()) {
          if (event.type !== "item.started" && event.type !== "item.completed")
            return assert.fail("Expected compaction item lifecycle");
          assert.equal(event.payload.itemType, "context_compaction");
          assert.deepEqual(event.payload.taskOwner, { type: "child", id: "source-child" });
          assert.equal(event.payload.individualTaskControl, undefined);
          assert.deepEqual(event.payload.codexCompactionObservation, expectedDiagnostics[index]);
        }
        assert.equal(runtime.sendTurnImpl.mock.calls.length, 0);
      }),
  );

  it.effect(
    "omits mismatched, legacy and native-payload-only compaction diagnostics without dropping item edges",
    () =>
      Effect.gen(function* () {
        const { adapter, runtime } = yield* startLifecycleRuntime();
        const tracker = makeCodexCompactionDiagnosticsTracker();
        const source = {
          sourceId: "provider-thread-1",
          sourceOwner: { type: "root" as const },
          observedAt: "2026-10-15T00:00:00.000Z",
          nativeTurnId: "diagnostic-native-turn",
        };
        const diagnostic = tracker.observeCompaction({
          ...source,
          phase: "started",
          nativeItemId: "diagnostic-item",
        });
        assert.ok(diagnostic);
        const variants: readonly unknown[] = [
          undefined,
          { ...diagnostic, phase: "completed" },
          { ...diagnostic, nativeItemId: "receiver-item" },
          { ...diagnostic, nativeTurnId: "routed-parent-turn" },
          { ...diagnostic, sourceOwner: { type: "child", id: "receiver-child" } },
          { ...diagnostic, version: 2 },
          { ...diagnostic, observedAt: "2026-02-30T00:00:00.000Z" },
          { ...diagnostic, resolvedThreshold: 700_000 },
        ];
        const barrierId = asEventId("compaction-diagnostic-negative-barrier");
        const observed = yield* Deferred.make<void>();
        const collected = yield* adapter.streamEvents.pipe(
          Stream.tap((event) =>
            event.eventId === barrierId ? Deferred.succeed(observed, undefined) : Effect.void,
          ),
          Stream.takeUntil((event) => event.eventId === barrierId),
          Stream.runCollect,
          Effect.forkChild,
        );
        let getters = 0;
        for (let index = 0; index < variants.length + 4; index++) {
          const event: ProviderEvent = {
            id: asEventId(`compaction-diagnostic-negative-${index}`),
            kind: "notification",
            provider: ProviderDriverKind.make("codex"),
            threadId: asThreadId("thread-1"),
            turnId: asTurnId("routed-parent-turn"),
            itemId: asItemId("diagnostic-item"),
            createdAt: source.observedAt,
            method: "item/started",
            taskOwner: source.sourceOwner,
            payload: {
              threadId: source.sourceId,
              turnId: source.nativeTurnId,
              startedAtMs: 1,
              item: { id: "diagnostic-item", type: "contextCompaction" },
              codexCompactionObservation: diagnostic,
            },
          };
          if (index < variants.length)
            Object.defineProperty(event, "codexCompactionObservation", { value: variants[index] });
          else if (index === variants.length)
            Object.defineProperty(event, "codexCompactionObservation", {
              get() {
                getters++;
                throw Error("Never execute diagnostic getters");
              },
            });
          else if (index === variants.length + 1)
            Object.setPrototypeOf(event, { codexCompactionObservation: diagnostic });
          else if (index === variants.length + 2)
            Object.defineProperty(event, "taskOwner", { value: undefined });
          else {
            Object.defineProperty(event, "codexCompactionObservation", { value: diagnostic });
            Object.defineProperty(event, "payload", {
              value: {
                threadId: source.sourceId,
                turnId: source.nativeTurnId,
                startedAtMs: 1,
                item: {
                  id: "diagnostic-item",
                  type: "commandExecution",
                  command: "node --version",
                  commandActions: [],
                  cwd: "/workspace",
                  status: "inProgress",
                },
              },
            });
          }
          assert.equal(isStartedItem(event.payload), true);
          yield* runtime.emit(event);
        }
        yield* runtime.emit({
          id: barrierId,
          kind: "notification",
          provider: ProviderDriverKind.make("codex"),
          threadId: asThreadId("thread-1"),
          createdAt: source.observedAt,
          method: "warning",
          message: "Diagnostic negative barrier",
        });
        yield* Deferred.await(observed);
        const events = Array.from(yield* Fiber.join(collected)).filter(
          (event) => event.eventId !== barrierId,
        );
        assert.equal(events.length, variants.length + 4);
        for (const event of events) {
          assert.equal(event.type, "item.started");
          if (event.type !== "item.started")
            return assert.fail("Expected original native item edge");
          assert.equal(event.payload.codexCompactionObservation, undefined);
          assert.equal(event.payload.individualTaskControl, undefined);
        }
        assert.equal(getters, 0);
        assert.equal(runtime.sendTurnImpl.mock.calls.length, 0);
        assert.equal(runtime.steerTurnImpl.mock.calls.length, 0);
      }),
  );

  it.effect("admits post-ACK availability confirmation only from the native runtime marker", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime(
        "79a58c30-cd43-4927-ae4a-d340ba31b613",
      );
      const first = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);
      const base: ProviderEvent = {
        id: asEventId("untrusted-confirmation"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("early-terminal-root"),
        createdAt: "2026-10-10T11:01:00.000Z",
        method: "codex.failedRoot/available",
        payload: {
          state: "failed",
          errorMessage: "Native request failed",
          codexTransientFailure: "server",
          nativeContextAvailable: true,
        },
      };
      yield* runtime.emit(base);
      yield* runtime.emit({
        ...base,
        id: asEventId("owned-confirmation"),
        nativeContextAvailable: true,
      });
      const result = yield* Fiber.join(first);
      assert.equal(result._tag, "Some");
      if (result._tag !== "Some") return;
      assert.equal(result.value.eventId, "owned-confirmation");
      assert.equal(result.value.createdAt, base.createdAt);
      assert.equal(result.value.type, "turn.completed");
      assert.deepEqual(result.value.payload, {
        state: "failed",
        errorMessage: "Native request failed",
        codexTransientFailure: "server",
        nativeContextAvailable: true,
      });
      assert.deepEqual(result.value.raw?.payload, { reason: "codex_failed_root_available" });
    }),
  );
  it.effect(
    "maps only owner-authored native availability and strict terminal retry categories",
    () =>
      Effect.gen(function* () {
        const { adapter, runtime } = yield* startLifecycleRuntime(
          "79a58c30-cd43-4927-ae4a-d340ba31b613",
        );
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 3)).pipe(
          Effect.forkChild,
        );
        for (const [index, codexErrorInfo] of [
          "serverOverloaded",
          "usageLimitExceeded",
          "responseStreamDisconnected",
        ].entries()) {
          yield* runtime.emit({
            id: asEventId(`failed-evidence-${index}`),
            kind: "notification",
            provider: ProviderDriverKind.make("codex"),
            threadId: asThreadId("thread-1"),
            turnId: asTurnId(`failed-${index}`),
            createdAt: "2026-10-10T11:01:00.000Z",
            method: "turn/completed",
            ...(index < 2 ? { nativeContextAvailable: true as const } : {}),
            payload: {
              threadId: "provider-thread-1",
              nativeContextAvailable: true,
              turn: {
                id: `failed-${index}`,
                items: [],
                itemsView: "notLoaded",
                status: "failed",
                error: {
                  message: "Native failure",
                  codexErrorInfo:
                    codexErrorInfo === "responseStreamDisconnected"
                      ? { responseStreamDisconnected: { httpStatusCode: null } }
                      : codexErrorInfo,
                  additionalDetails: null,
                },
              },
            },
          });
        }
        const events = Array.from(yield* Fiber.join(eventsFiber));
        assert.deepEqual(
          events.map((event) => (event.type === "turn.completed" ? event.payload : undefined)),
          [
            {
              state: "failed",
              errorMessage: "Native failure",
              codexTransientFailure: "server",
              nativeContextAvailable: true,
            },
            { state: "failed", errorMessage: "Native failure", nativeContextAvailable: true },
            { state: "failed", errorMessage: "Native failure", codexTransientFailure: "transport" },
          ],
        );
      }),
  );

  it.effect("omits unqualified nested startup error metadata from canonical raw diagnostics", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const error = {
        message: "Public error",
        codexErrorInfo: "serverOverloaded",
        futurePolicy: "private-startup-error-sentinel",
      };
      const turn = { id: "startup-turn", items: [], status: "failed", error };
      const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 2)).pipe(
        Effect.forkChild,
      );
      for (const envelope of [
        { method: "turn/started", params: { threadId: "provider-thread-1", turn } },
        {
          method: "thread/started",
          params: {
            thread: {
              id: "provider-thread-1",
              cliVersion: "0.162.1",
              createdAt: 0,
              updatedAt: 0,
              cwd: "/fixture",
              ephemeral: true,
              modelProvider: "openai",
              preview: "",
              projectId: null,
              sessionId: "session-1",
              source: "appServer",
              status: { type: "idle" },
              turns: [turn],
            },
          },
        },
      ]) {
        const decoded = decodeNativeNotification(envelope);
        yield* runtime.emit({
          id: asEventId(`startup-privacy-${decoded.method}`),
          kind: "notification",
          provider: ProviderDriverKind.make("codex"),
          threadId: asThreadId("thread-1"),
          turnId: asTurnId("startup-turn"),
          createdAt: "2026-10-11T00:00:00.000Z",
          method: decoded.method,
          payload: decoded.params,
        });
      }
      const events = Array.from(yield* Fiber.join(eventsFiber));
      assert.deepEqual(
        events.map((event) => event.type),
        ["turn.started", "thread.started"],
      );
      assert.doesNotMatch(encodeProviderJsonString(events), /private-startup-error-sentinel/);
      assert.equal(runtime.sendTurnImpl.mock.calls.length, 0);
      assert.equal(runtime.steerTurnImpl.mock.calls.length, 0);
    }),
  );

  it.effect(
    "retains conflicting typed native failure evidence without canonical recovery authority",
    () =>
      Effect.gen(function* () {
        const { adapter, runtime } = yield* startLifecycleRuntime();
        const cases: Array<Record<string, unknown>> = [
          { responseStreamDisconnected: { httpStatusCode: 503 }, cyberPolicy: { blocked: true } },
          {
            responseStreamDisconnected: { httpStatusCode: 503 },
            futureFailure: { opaque: "private-error-inner-sentinel" },
          },
          {
            responseStreamDisconnected: { httpStatusCode: 503 },
            httpConnectionFailed: { httpStatusCode: 503 },
          },
          { responseStreamDisconnected: { httpStatusCode: 503, permanent: true } },
          { responseStreamDisconnected: { httpStatusCode: 503, cyberPolicy: { blocked: true } } },
        ].map((codexErrorInfo) => ({ codexErrorInfo }));
        cases.push({
          codexErrorInfo: "serverOverloaded",
          futurePolicy: "private-error-outer-sentinel",
        });
        const eventsFiber = yield* Stream.runCollect(
          Stream.take(adapter.streamEvents, cases.length * 2),
        ).pipe(Effect.forkChild);
        for (const [index, errorMetadata] of cases.entries()) {
          const turnId = `ambiguous-error-${index}`;
          const error = {
            message: "Native stream failure",
            ...errorMetadata,
            additionalDetails: null,
            misalignment: null,
          };
          for (const envelope of [
            {
              method: "error",
              params: { threadId: "provider-thread-1", turnId, willRetry: false, error },
            },
            {
              method: "turn/completed",
              params: {
                threadId: "provider-thread-1",
                turn: { id: turnId, items: [], status: "failed", error },
              },
            },
          ]) {
            // Match the real client boundary before the canonical adapter.
            const decoded = decodeNativeNotification(envelope);
            yield* runtime.emit({
              id: asEventId(`${turnId}-${decoded.method}`),
              kind: "notification",
              provider: ProviderDriverKind.make("codex"),
              threadId: asThreadId("thread-1"),
              turnId: asTurnId(turnId),
              createdAt: "2026-10-10T15:01:00.000Z",
              method: decoded.method,
              nativeContextAvailable: true,
              payload: decoded.params,
            });
          }
        }
        const events = Array.from(yield* Fiber.join(eventsFiber));
        // Unknown error extension data is now available ONLY through the new
        // explicitly owned private diagnostic. The original canonical fields
        // retain the same content-free policy and never acquire recovery proof.
        assert.doesNotMatch(
          encodeProviderJsonString(events.map(({ diagnostic: _private, ...ordinary }) => ordinary)),
          /private-error-(?:inner|outer)-sentinel/,
        );
        assert.doesNotMatch(
          encodeProviderJsonString(events.map((event) => event.diagnostic?.summary)),
          /private-error-(?:inner|outer)-sentinel/,
        );
        assert.match(events[2]!.diagnostic!.snapshot.json, /private-error-inner-sentinel/);
        assert.match(
          events[events.length - 1]!.diagnostic!.snapshot.json,
          /private-error-outer-sentinel/,
        );
        for (const [index, event] of events.entries()) {
          assert.equal(event.type, index % 2 === 0 ? "runtime.error" : "turn.completed");
          if (event.type === "turn.completed")
            assert.deepEqual(event.payload, {
              state: "failed",
              errorMessage: "Native stream failure",
              nativeContextAvailable: true,
            });
        }
        assert.equal(runtime.sendTurnImpl.mock.calls.length, 0);
        assert.equal(runtime.steerTurnImpl.mock.calls.length, 0);
      }),
  );

  it.effect(
    "classifies definitive remote-compaction failures without manufacturing context availability",
    () =>
      Effect.gen(function* () {
        const { adapter, runtime } = yield* startLifecycleRuntime(
          "79a58c30-cd43-4927-ae4a-d340ba31b613",
        );
        const message =
          "Error running remote compact task: stream disconnected before completion: An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID eb45b1d3-36e9-4f02-a321-8ea87f01185c in your message.";
        const cases = [
          { status: "failed", info: "other", ownerAvailable: true },
          { status: "failed", info: "other", ownerAvailable: false },
          { status: "failed", info: "usageLimitExceeded", ownerAvailable: true },
          { status: "failed", info: "bioPolicy", ownerAvailable: true },
          { status: "failed", info: "futureFailure", ownerAvailable: true },
          { status: "failed", info: { futureFailure: { reason: "opaque" } }, ownerAvailable: true },
          { status: "interrupted", info: "other", ownerAvailable: true },
          { status: "completed", info: "other", ownerAvailable: true },
        ] as const;
        const eventsFiber = yield* Stream.runCollect(
          Stream.take(adapter.streamEvents, cases.length),
        ).pipe(Effect.forkChild);
        for (const [index, current] of cases.entries())
          yield* runtime.emit({
            id: asEventId(`remote-compaction-failure-${index}`),
            kind: "notification",
            provider: ProviderDriverKind.make("codex"),
            threadId: asThreadId("thread-1"),
            turnId: asTurnId(`remote-compaction-root-${index}`),
            createdAt: "2026-10-10T15:01:00.000Z",
            method: "turn/completed",
            ...(current.ownerAvailable ? { nativeContextAvailable: true as const } : {}),
            payload: {
              threadId: "provider-thread-1",
              // Provider JSON may describe availability, but it cannot replace
              // the outer runtime-owned proof after Stop, closure or pending I/O.
              nativeContextAvailable: true,
              turn: {
                id: `remote-compaction-root-${index}`,
                items: [],
                itemsView: "notLoaded",
                status: current.status,
                error: { message, codexErrorInfo: current.info, additionalDetails: null },
              },
            },
          });
        const events = Array.from(yield* Fiber.join(eventsFiber));
        for (const [index, event] of events.entries()) {
          assert.equal(event.type, "turn.completed");
          if (event.type !== "turn.completed") continue;
          const current = cases[index]!;
          assert.deepEqual(event.payload, {
            state: current.status,
            errorMessage: message,
            ...(index < 2 ? { codexTransientFailure: "server" } : {}),
            ...(current.ownerAvailable ? { nativeContextAvailable: true } : {}),
          });
        }
        assert.equal(runtime.sendTurnImpl.mock.calls.length, 0);
        assert.equal(runtime.steerTurnImpl.mock.calls.length, 0);
      }),
  );

  it.effect(
    "forwards private failed-root guard only to the same runtime and never steers or restarts",
    () =>
      Effect.gen(function* () {
        const runtimeId = "79a58c30-cd43-4927-ae4a-d340ba31b613";
        const { adapter, runtime } = yield* startLifecycleRuntime(runtimeId);
        const base = yield* runtime.getSession;
        const failure = {
          turnId: asTurnId("failed-root"),
          providerThreadId: "provider-thread-1",
          observedAt: "2026-10-10T11:01:00.000Z",
          category: "server" as const,
        };
        runtime.getSessionImpl.mockResolvedValue({
          ...base,
          status: "ready",
          activeTurnId: undefined,
          codexRootTurnFailure: failure,
        });
        const expectedFailedRoot = {
          turnId: failure.turnId,
          providerThreadId: failure.providerThreadId,
          subagentRuntimeId: runtimeId,
        };
        const before = lifecycleRuntimeFactory.runtimes.length;
        assert.equal(Object.hasOwn(runtime.options, "requireExactResume"), false);
        yield* adapter.sendTurn({
          threadId: asThreadId("thread-1"),
          input: "Continue the interrupted response.",
          expectedFailedRoot,
        });
        assert.deepEqual(
          runtime.sendTurnImpl.mock.calls.at(-1)?.[0].expectedFailedRoot,
          expectedFailedRoot,
        );
        assert.equal(
          runtime.sendTurnImpl.mock.calls.at(-1)?.[0].allowActiveTurnSteerFallback,
          false,
        );
        assert.equal(
          Object.hasOwn(runtime.sendTurnImpl.mock.calls.at(-1)![0], "serviceTier"),
          false,
        );
        assert.equal(runtime.steerTurnImpl.mock.calls.length, 0);
        assert.equal(runtime.closeImpl.mock.calls.length, 0);
        assert.equal(lifecycleRuntimeFactory.runtimes.length, before);
        for (const mismatch of [
          { ...expectedFailedRoot, turnId: asTurnId("different-root") },
          { ...expectedFailedRoot, providerThreadId: "different-thread" },
          { ...expectedFailedRoot, subagentRuntimeId: "acf72c20-f40c-4b9e-acef-e7034279c0dd" },
        ])
          assert.equal(
            (yield* adapter
              .sendTurn({
                threadId: asThreadId("thread-1"),
                input: "Continue",
                expectedFailedRoot: mismatch,
              })
              .pipe(Effect.exit))._tag,
            "Failure",
          );
        runtime.getSessionImpl.mockResolvedValue({
          ...base,
          codexRootTurnFailure: { ...failure, category: undefined },
        });
        assert.equal(
          (yield* adapter
            .sendTurn({ threadId: asThreadId("thread-1"), input: "Continue", expectedFailedRoot })
            .pipe(Effect.exit))._tag,
          "Failure",
        );
        assert.equal(runtime.sendTurnImpl.mock.calls.length, 1);
        assert.equal(runtime.steerTurnImpl.mock.calls.length, 0);
        assert.equal(runtime.closeImpl.mock.calls.length, 0);
        assert.equal(lifecycleRuntimeFactory.runtimes.length, before);
      }),
  );

  it.effect(
    "maps native review items exactly, bounds findings and never completes their turn",
    () =>
      Effect.gen(function* () {
        const { adapter, runtime } = yield* startLifecycleRuntime();
        const results = yield* adapter.streamEvents.pipe(
          Stream.takeUntil((event) => event.eventId === "review-fixture-barrier"),
          Stream.runCollect,
          Effect.forkChild,
        );
        const fixtures = [
          ["item/started", "enteredReviewMode", "Current changes"],
          ["item/completed", "enteredReviewMode", "Current changes"],
          ["item/started", "exitedReviewMode", "Working"],
          ["item/completed", "exitedReviewMode", " Findings\n" + "x".repeat(140_000)],
        ] as const;
        for (const [index, [method, type, review]] of fixtures.entries()) {
          const payload = {
            threadId: "thread-1",
            turnId: "review-turn",
            item: { id: `review-item-${index}`, type, review },
            ...(method === "item/started" ? { startedAtMs: 1 } : { completedAtMs: 2 }),
          };
          // Validate the native fixture before waiting for its mapped stream. A
          // missing required native timestamp must fail here, not hang the test.
          assert.equal(
            method === "item/started" ? isStartedItem(payload) : isCompletedItem(payload),
            true,
          );
          yield* runtime.emit({
            id: asEventId(`review-${index}`),
            kind: "notification",
            provider: ProviderDriverKind.make("codex"),
            threadId: asThreadId("thread-1"),
            turnId: asTurnId("review-turn"),
            itemId: asItemId(`review-item-${index}`),
            createdAt: "2026-10-05T00:00:00.000Z",
            method,
            payload,
          });
        }
        // A real mapped sentinel supplies a FIFO barrier, so restoring the old
        // dropped-review mapping fails the assertion rather than a timeout.
        yield* runtime.emit({
          id: asEventId("review-fixture-barrier"),
          kind: "notification",
          provider: ProviderDriverKind.make("codex"),
          threadId: asThreadId("thread-1"),
          createdAt: "2026-10-05T00:00:00.000Z",
          method: "warning",
          message: "Review fixture barrier",
        });
        const events = Array.from(yield* Fiber.join(results)).filter(
          (event) => event.eventId !== "review-fixture-barrier",
        );
        assert.deepEqual(
          events.map((event) => event.type),
          ["item.started", "item.completed", "item.started", "item.completed"],
        );
        assert.deepEqual(
          events.map((event) => ("itemType" in event.payload ? event.payload.itemType : null)),
          ["review_entered", "review_entered", "review_exited", "review_exited"],
        );
        const final = events[3];
        assert.ok(final?.type === "item.completed");
        assert.equal(final.payload.detail?.length, 131_072);
        assert.equal(final.payload.detail?.startsWith(" Findings\n"), true);
        assert.equal(final.payload.data, undefined);
        assert.deepEqual(final.raw?.payload, {
          itemType: "review_exited",
          reviewTextLength: 140_010,
        });
        assert.equal(final.turnId, "review-turn");
      }),
  );
  it.effect("preserves the originating runtime on child activity and lifecycle envelopes", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const originalId = "42b69839-1c6d-45f5-ab7b-7d7cc374342c";
      const replacementId = "e9480f5a-911a-44ce-906d-c6011f13aaed";
      const resultFiber = yield* Stream.take(adapter.streamEvents, 4).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );
      for (const [index, subagentRuntimeId] of [
        originalId,
        replacementId,
        originalId,
        undefined,
      ].entries()) {
        yield* runtime.emit({
          id: asEventId(`origin-stamp-${index}`),
          kind: "notification",
          provider: ProviderDriverKind.make("codex"),
          threadId: asThreadId("thread-1"),
          turnId: asTurnId("original-owner-turn"),
          createdAt: "2026-10-04T00:00:00.000Z",
          subagentRuntimeId,
          method: index === 1 ? "session/ready" : "codex.subagent/threadStatusChanged",
          payload: { threadId: "same-child", status: { type: "active", activeFlags: [] } },
        });
      }
      const events = Array.from(yield* Fiber.join(resultFiber));
      assert.deepEqual(
        events.map((event) => event.subagentRuntimeId),
        [originalId, replacementId, originalId, undefined],
      );
      for (const event of [events[0], events[2]]) {
        assert.equal(event?.type, "task.progress");
        if (event?.type === "task.progress")
          assert.equal(event.payload.subagent?.runtimeId, originalId);
      }
      const historical = events[3];
      assert.equal(historical?.type, "task.progress");
      if (historical?.type === "task.progress") {
        assert.equal(historical.payload.subagent?.runtimeId, undefined);
        assert.equal(Object.hasOwn(historical.payload.subagent!, "runtimeId"), false);
      }
    }),
  );

  it.effect(
    "does not treat passive child metadata as new-runtime liveness or let it erase terminal provenance",
    () =>
      Effect.gen(function* () {
        const { adapter, runtime } = yield* startLifecycleRuntime();
        const originalId = "42b69839-1c6d-45f5-ab7b-7d7cc374342c";
        const replacementId = "e9480f5a-911a-44ce-906d-c6011f13aaed";
        const resultFiber = yield* Stream.take(adapter.streamEvents, 8).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );
        const frames = [
          [
            originalId,
            "codex.subagent/threadStatusChanged",
            { threadId: "child", status: { type: "active", activeFlags: [] } },
          ],
          [
            originalId,
            "codex.subagent/threadStatusChanged",
            { threadId: "child", status: { type: "idle" } },
          ],
          [
            replacementId,
            "codex.subagent/threadNameUpdated",
            { threadId: "child", threadName: "Updated name" },
          ],
          [
            replacementId,
            "item/completed",
            {
              completedAtMs: 1_791_072_000_000,
              threadId: "native-root",
              turnId: "owner",
              item: {
                id: "control",
                type: "collabAgentToolCall",
                tool: "resumeAgent",
                status: "completed",
                senderThreadId: "native-root",
                receiverThreadIds: ["child"],
                prompt: null,
                model: null,
                reasoningEffort: null,
                agentsStates: {},
              },
            },
          ],
          [
            replacementId,
            "codex.subagent/threadStatusChanged",
            { threadId: "child", status: { type: "active", activeFlags: [] } },
          ],
          [
            replacementId,
            "codex.subagent/threadStatusChanged",
            { threadId: "child", status: { type: "idle" } },
          ],
          [
            undefined,
            "codex.subagent/threadNameUpdated",
            { threadId: "child", threadName: "Unverified historical name" },
          ],
          [
            replacementId,
            "codex.subagent/threadStatusChanged",
            { threadId: "child", status: { type: "active", activeFlags: [] } },
          ],
        ] as const;
        for (const [index, [subagentRuntimeId, method, payload]] of frames.entries()) {
          yield* runtime.emit({
            id: asEventId(`passive-stamp-${index}`),
            kind: "notification",
            provider: ProviderDriverKind.make("codex"),
            threadId: asThreadId("thread-1"),
            turnId: asTurnId("owner"),
            createdAt: index < 2 ? "2026-09-01T00:00:00.000Z" : "2026-10-04T00:00:00.000Z",
            subagentRuntimeId,
            method,
            payload,
          });
        }
        const events = Array.from(yield* Fiber.join(resultFiber));
        const presentations = events.map((event) =>
          event.type === "task.progress" || event.type === "task.completed"
            ? event.payload.subagent
            : undefined,
        );
        assert.deepEqual(
          presentations.map((presentation) => presentation?.runtimeId),
          [
            originalId,
            originalId,
            undefined,
            undefined,
            replacementId,
            replacementId,
            undefined,
            replacementId,
          ],
        );
        assert.deepEqual(
          presentations.map((presentation) => presentation?.status),
          [
            "active",
            "completed",
            "completed",
            "completed",
            "active",
            "completed",
            "completed",
            "completed",
          ],
        );
        assert.equal(presentations[0]?.startedAt, "2026-09-01T00:00:00.000Z");
        assert.equal(presentations[1]?.startedAt, "2026-09-01T00:00:00.000Z");
        // Current-runtime proof starts a new observed clock, never inheriting
        // the old runtime's month-long historical timer. Later same-runtime
        // terminal/progress edges retain the replacement's clock.
        assert.equal(presentations[4]?.startedAt, "2026-10-04T00:00:00.000Z");
        assert.equal(presentations[5]?.startedAt, "2026-10-04T00:00:00.000Z");
        assert.equal(presentations[7]?.startedAt, "2026-10-04T00:00:00.000Z");
      }),
  );

  it.effect(
    "does not treat loaded idle child snapshots or historical creation times as live work",
    () =>
      Effect.gen(function* () {
        const { adapter, runtime } = yield* startLifecycleRuntime();
        const runtimeId = "42b69839-1c6d-45f5-ab7b-7d7cc374342c";
        const resultFiber = yield* Stream.take(adapter.streamEvents, 3).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );
        for (const type of ["idle", "notLoaded", "active"] as const) {
          yield* runtime.emit({
            id: asEventId(`loaded-child-${type}`),
            kind: "notification",
            provider: ProviderDriverKind.make("codex"),
            threadId: asThreadId("thread-1"),
            turnId: asTurnId("owner"),
            createdAt: "2026-10-04T00:00:00.000Z",
            subagentRuntimeId: runtimeId,
            method: "codex.subagent/threadStarted",
            payload: {
              thread: {
                id: `child-${type}`,
                cliVersion: "0.160.0",
                createdAt: Date.parse("2026-09-01T00:00:00.000Z") / 1_000,
                updatedAt: Date.parse("2026-09-01T00:00:00.000Z") / 1_000,
                cwd: process.cwd(),
                ephemeral: false,
                modelProvider: "openai",
                preview: "",
                projectId: null,
                sessionId: "native-session",
                source: "appServer",
                status: type === "active" ? { type, activeFlags: [] } : { type },
                turns: [],
              },
            },
          });
        }
        const events = Array.from(yield* Fiber.join(resultFiber));
        assert.deepEqual(
          events.map((event) => event.type),
          ["task.progress", "task.progress", "task.progress"],
        );
        const presentations = events.map((event) =>
          event.type === "task.progress" ? event.payload.subagent : undefined,
        );
        assert.deepEqual(
          presentations.map((presentation) => presentation?.runtimeId),
          [undefined, undefined, runtimeId],
        );
        assert.equal(presentations[2]?.startedAt, "2026-10-04T00:00:00.000Z");
      }),
  );

  it.effect(
    "publishes authoritative resumed child terminal and bounded native rename without replaying a start",
    () =>
      Effect.gen(function* () {
        const adapter = yield* CodexAdapter;
        yield* adapter.startSession({
          provider: ProviderDriverKind.make("codex"),
          threadId: asThreadId("thread-1"),
          runtimeMode: "full-access",
          resumeCursor: { threadId: "resumed-native-root" },
        });
        const runtime = lifecycleRuntimeFactory.lastRuntime;
        assert.ok(runtime);
        assert.deepEqual(runtime.options.resumeCursor, { threadId: "resumed-native-root" });
        const events = yield* Stream.take(adapter.streamEvents, 2).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );
        // These are the two exact canonical edges emitted by bounded native
        // child metadata reconciliation, not synthesized activity from age.
        for (const [index, method, payload] of [
          [
            0,
            "codex.subagent/threadStatusChanged",
            { threadId: "resumed-exact-child", status: { type: "idle" } },
          ],
          [
            1,
            "codex.subagent/threadNameUpdated",
            { threadId: "resumed-exact-child", threadName: "Latest native child name" },
          ],
        ] as const)
          yield* runtime.emit({
            id: asEventId(`resumed-child-reconciliation-${index}`),
            kind: "notification",
            provider: ProviderDriverKind.make("codex"),
            threadId: asThreadId("thread-1"),
            createdAt: `2026-10-03T00:00:0${index}.000Z`,
            turnId: asTurnId("resumed-original-turn"),
            method,
            payload,
          });
        const result = Array.from(yield* Fiber.join(events));
        assert.deepEqual(
          result.map((event) => event.type),
          ["task.completed", "task.progress"],
        );
        for (const event of result) {
          assert.equal(event.turnId, "resumed-original-turn");
          assert.equal(
            "taskId" in event.payload ? event.payload.taskId : undefined,
            "resumed-exact-child",
          );
          assert.equal(
            "subagent" in event.payload ? event.payload.subagent?.status : undefined,
            "completed",
          );
        }
        const renamed = result[1]!;
        assert.equal(
          "subagent" in renamed.payload ? renamed.payload.subagent?.label : undefined,
          "Latest native child name",
        );
      }),
  );

  it.effect("maps private interaction lifecycle without raw schema or answer payloads", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const eventsFiber = yield* Stream.take(adapter.streamEvents, 2).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );
      const base = {
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        requestId: ApprovalRequestId.make("private-request"),
      };
      yield* runtime.emit({
        ...base,
        id: asEventId("private-requested"),
        kind: "request",
        method: "cafecode/interaction/request",
        payload: {
          interaction: {
            kind: "elicitation",
            mode: "form",
            serverName: "connector",
            message: "Complete form",
            fields: [{ id: "credential", title: "Credential", type: "string", required: true }],
          },
        },
      });
      yield* runtime.emit({
        ...base,
        id: asEventId("private-resolved"),
        kind: "notification",
        method: "cafecode/interaction/resolved",
        payload: {},
      });
      const events = Array.from(yield* Fiber.join(eventsFiber));
      assert.equal(events[0]?.type, "user-input.requested");
      if (events[0]?.type === "user-input.requested") {
        assert.deepEqual(events[0].payload.questions, []);
        assert.equal(events[0].payload.interaction?.kind, "elicitation");
        assert.deepEqual(events[0].raw?.payload, { lifecycle: "requested" });
      }
      assert.equal(events[1]?.type, "user-input.resolved");
      if (events[1]?.type === "user-input.resolved")
        assert.deepEqual(events[1].payload.answers, {});
    }),
  );

  it.effect("preserves the authoritative network host and protocol on command approvals", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const eventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);
      yield* runtime.emit({
        id: asEventId("network-approval"),
        kind: "request",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        requestId: ApprovalRequestId.make("network-request"),
        requestKind: "command",
        method: "item/commandExecution/requestApproval",
        payload: {
          threadId: "native",
          turnId: "turn-1",
          itemId: "command",
          command: "fetch",
          networkApprovalContext: { host: "example.com", protocol: "https" },
        },
      });
      const event = yield* Fiber.join(eventFiber);
      assert.equal(event._tag, "Some");
      if (event._tag === "Some" && event.value.type === "request.opened")
        assert.deepEqual(event.value.payload.networkApproval, {
          host: "example.com",
          protocol: "https",
        });
      else assert.fail("Expected network approval");
    }),
  );
  it.effect("delegates requestUserInput auto-resolution snooze to the live runtime", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const requestId = ApprovalRequestId.make("req-user-input-snooze");
      const snoozeUserInput = adapter.snoozeUserInput;
      assert.ok(snoozeUserInput);

      yield* snoozeUserInput(asThreadId("thread-1"), requestId);

      assert.deepEqual(runtime.snoozeUserInputImpl.mock.calls, [[requestId]]);
    }),
  );

  it.effect("attributes trusted Codex plugin commands in the work log", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-plugin-command"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "item/started",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("command-1"),
        payload: {
          threadId: "provider-thread-1",
          turnId: "turn-1",
          startedAtMs: 1_767_225_600_000,
          item: {
            type: "commandExecution",
            id: "command-1",
            command: "node scripts/audit.mjs",
            commandActions: [],
            cwd: "/workspace",
            status: "inProgress",
            pluginId: "openai/security-audit",
            scriptPath: "scripts/audit.mjs",
          },
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);
      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some" || firstEvent.value.type !== "item.started") {
        return;
      }
      assert.equal(firstEvent.value.payload.itemType, "command_execution");
      assert.equal(firstEvent.value.payload.title, "Ran plugin command");
      assert.equal(
        firstEvent.value.payload.detail,
        "node scripts/audit.mjs\nPlugin: openai/security-audit (scripts/audit.mjs)",
      );
    }),
  );

  it.effect("does not promote unsafe plugin script paths into work-log attribution", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-plugin-command-unsafe-path"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "item/started",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("command-2"),
        payload: {
          threadId: "provider-thread-1",
          turnId: "turn-1",
          startedAtMs: 1_767_225_600_000,
          item: {
            type: "commandExecution",
            id: "command-2",
            command: "node ../private/audit.mjs",
            commandActions: [],
            cwd: "/workspace",
            status: "inProgress",
            pluginId: "openai/security-audit",
            scriptPath: "../private/audit.mjs",
          },
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);
      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some" || firstEvent.value.type !== "item.started") {
        return;
      }
      assert.equal(firstEvent.value.payload.title, "Ran plugin command");
      assert.equal(
        firstEvent.value.payload.detail,
        "node ../private/audit.mjs\nPlugin: openai/security-audit",
      );
    }),
  );

  it.effect("maps Codex web-search queries into visible work-log detail", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const eventsFiber = yield* Stream.take(adapter.streamEvents, 2).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );
      const query = "current Codex five-hour and weekly usage limits";

      yield* runtime.emit({
        id: asEventId("evt-web-search-started"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "item/started",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("web-search-1"),
        payload: {
          threadId: "provider-thread-1",
          turnId: "turn-1",
          startedAtMs: 1_767_225_600_000,
          item: {
            type: "webSearch",
            id: "web-search-1",
            query,
            action: { type: "search", query },
          },
        },
      } satisfies ProviderEvent);
      yield* runtime.emit({
        id: asEventId("evt-web-search-completed"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:01.000Z",
        method: "item/completed",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("web-search-1"),
        payload: {
          threadId: "provider-thread-1",
          turnId: "turn-1",
          completedAtMs: 1_767_225_601_000,
          item: {
            type: "webSearch",
            id: "web-search-1",
            query,
            action: { type: "search", query },
            results: [],
          },
        },
      } satisfies ProviderEvent);

      const events = Array.from(yield* Fiber.join(eventsFiber));
      assert.deepStrictEqual(
        events.map((event) => event.type),
        ["item.started", "item.completed"],
      );
      for (const event of events) {
        if (event.type !== "item.started" && event.type !== "item.completed") {
          continue;
        }
        assert.equal(event.payload.itemType, "web_search");
        assert.equal(event.payload.title, "Web search");
        assert.equal(event.payload.detail, query);
      }
    }),
  );

  it.effect("maps Codex MCP and dynamic-tool identity and arguments into work-log detail", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const eventsFiber = yield* Stream.take(adapter.streamEvents, 2).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* runtime.emit({
        id: asEventId("evt-mcp-tool-started"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "item/started",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("mcp-tool-1"),
        payload: {
          threadId: "provider-thread-1",
          turnId: "turn-1",
          startedAtMs: 1_767_225_600_000,
          item: {
            type: "mcpToolCall",
            id: "mcp-tool-1",
            server: "openaiDeveloperDocs",
            tool: "search_openai_docs",
            arguments: {
              query: "current Responses API tools",
              apiKey: "sk-example-secret-value-1234567890",
            },
            status: "inProgress",
          },
        },
      } satisfies ProviderEvent);
      yield* runtime.emit({
        id: asEventId("evt-dynamic-tool-started"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:01.000Z",
        method: "item/started",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("dynamic-tool-1"),
        payload: {
          threadId: "provider-thread-1",
          turnId: "turn-1",
          startedAtMs: 1_767_225_601_000,
          item: {
            type: "dynamicToolCall",
            id: "dynamic-tool-1",
            namespace: "workspace",
            tool: "read_file",
            arguments: { path: "/workspace/README.md" },
            status: "inProgress",
          },
        },
      } satisfies ProviderEvent);

      const events = Array.from(yield* Fiber.join(eventsFiber));
      assert.equal(events[0]?.type, "item.started");
      assert.equal(events[0]?.payload.itemType, "mcp_tool_call");
      assert.equal(events[0]?.payload.title, "MCP tool call");
      assert.equal(
        events[0]?.payload.detail,
        'openaiDeveloperDocs.search_openai_docs: {"query":"current Responses API tools","apiKey":"[redacted]"}',
      );
      assert.equal(events[1]?.type, "item.started");
      assert.equal(events[1]?.payload.itemType, "dynamic_tool_call");
      assert.equal(events[1]?.payload.title, "Tool call");
      assert.equal(
        events[1]?.payload.detail,
        'workspace.read_file: {"path":"/workspace/README.md"}',
      );
    }),
  );

  it.effect("maps effective Codex thread settings without persisting sensitive fields", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-thread-settings-updated"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "thread/settings/updated",
        threadId: asThreadId("thread-1"),
        payload: {
          threadId: "provider-thread-1",
          threadSettings: {
            activePermissionProfile: { id: ":workspace", extends: null },
            approvalPolicy: "on-request",
            approvalsReviewer: "user",
            collaborationMode: {
              mode: "default",
              settings: {
                model: "gpt-5.4",
                reasoning_effort: "ultra",
                developer_instructions: "private instructions must not enter debug logs",
              },
            },
            cwd: "/private/workspace",
            effort: "ultra",
            model: "gpt-5.4",
            modelProvider: "openai",
            personality: "pragmatic",
            sandboxPolicy: {
              type: "workspaceWrite",
              networkAccess: true,
              writableRoots: ["/private/workspace", "/private/secondary-root"],
            },
            serviceTier: "fast",
            summary: "detailed",
          },
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);
      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some" || firstEvent.value.type !== "session.configured") {
        return;
      }

      assert.deepStrictEqual(firstEvent.value.payload.config, {
        model: "gpt-5.4",
        modelProvider: "openai",
        effort: "ultra",
        serviceTier: "fast",
        personality: "pragmatic",
        summary: "detailed",
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        activePermissionProfile: { id: ":workspace", extends: null },
        sandboxPolicy: { type: "workspaceWrite", networkAccess: true },
        collaborationMode: {
          mode: "default",
          settings: { model: "gpt-5.4", reasoningEffort: "ultra" },
        },
      });
      const rawPayload = firstEvent.value.raw?.payload as Record<string, unknown>;
      const rawSettings = rawPayload.threadSettings as Record<string, unknown>;
      const rawSandbox = rawSettings.sandboxPolicy as Record<string, unknown>;
      const rawCollaboration = rawSettings.collaborationMode as Record<string, unknown>;
      const rawCollaborationSettings = rawCollaboration.settings as Record<string, unknown>;
      assert.equal(Object.hasOwn(rawSettings, "cwd"), false);
      assert.equal(Object.hasOwn(rawSandbox, "writableRoots"), false);
      assert.equal(Object.hasOwn(rawCollaborationSettings, "developer_instructions"), false);
    }),
  );

  it.effect("maps completed agent message items to canonical item.completed events", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-msg-complete"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "item/completed",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("msg_1"),
        payload: {
          completedAtMs: 1_778_000_000_000,
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "agentMessage",
            id: "msg_1",
            text: "done",
          },
        },
      };

      yield* runtime.emit(event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "item.completed");
      if (firstEvent.value.type !== "item.completed") {
        return;
      }
      assert.equal(firstEvent.value.itemId, "msg_1");
      assert.equal(firstEvent.value.turnId, "turn-1");
      assert.equal(firstEvent.value.payload.itemType, "assistant_message");
    }),
  );

  it.effect("maps a live partial answer to commentary without completing its native turn", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);
      yield* runtime.emit({
        id: asEventId("evt-partial-answer"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "item/completed",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("partial-item"),
        payload: {
          completedAtMs: 1_778_000_000_000,
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "agentMessage",
            id: "partial-item",
            text: "Public interim answer",
            phase: "partial_answer",
          },
        },
      });
      const event = yield* Fiber.join(firstEventFiber);
      assert.equal(event._tag, "Some");
      if (event._tag !== "Some") return;
      assert.equal(event.value.type, "item.completed");
      if (event.value.type !== "item.completed") return;
      assert.equal(event.value.payload.itemType, "assistant_message");
      assert.equal(event.value.payload.detail, "Public interim answer");
      assert.deepEqual(event.value.payload.data, {
        completedAtMs: 1_778_000_000_000,
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "agentMessage",
          id: "partial-item",
          text: "Public interim answer",
          phase: "commentary",
        },
      });
      assert.equal(runtime.sendTurnImpl.mock.calls.length, 0);
      assert.equal(runtime.steerTurnImpl.mock.calls.length, 0);
    }),
  );

  it.effect("preserves completed assistant whitespace for exact streamed-prefix verification", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const fixtures = [
        { streamedPrefix: " \tThe", text: " \tThe complete answer.\r\n " },
        { streamedPrefix: "The complete answer.\n", text: "The complete answer.\n" },
        { streamedPrefix: "The complete answer.\r\n ", text: "The complete answer.\r\n " },
        { streamedPrefix: "", text: " \t\r\n " },
      ];

      for (const [index, fixture] of fixtures.entries()) {
        const eventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);
        const itemId = asItemId(`msg-whitespace-${index}`);
        yield* runtime.emit({
          id: asEventId(`evt-msg-whitespace-${index}`),
          kind: "notification",
          provider: ProviderDriverKind.make("codex"),
          createdAt: "2026-01-01T00:00:00.000Z",
          method: "item/completed",
          threadId: asThreadId("thread-1"),
          turnId: asTurnId("turn-1"),
          itemId,
          payload: {
            completedAtMs: 1_778_000_000_000,
            threadId: "thread-1",
            turnId: "turn-1",
            item: { type: "agentMessage", id: itemId, text: fixture.text },
          },
        });
        const event = yield* Fiber.join(eventFiber);
        assert.equal(event._tag, "Some");
        if (event._tag !== "Some" || event.value.type !== "item.completed") {
          assert.fail("Expected canonical completed assistant item");
        }
        const detail = event.value.payload.detail;
        if (fixture.text.trim().length === 0) {
          assert.equal(detail, undefined);
          continue;
        }
        assert.equal(detail, fixture.text);
        assert.equal(event.value.itemId, itemId);
        assert.equal(event.value.turnId, "turn-1");

        // Exercise the same exact commitment used by ingestion: display-only
        // trimming must not make a valid full completion look divergent, while
        // a changed leading character must still fail the security boundary.
        const commitment = new AssistantStreamTextCommitment();
        commitment.append(fixture.streamedPrefix);
        assert.equal(commitment.matchesPrefixOf(detail!), true);
        assert.equal(commitment.matchesPrefixOf(`X${detail!.slice(1)}`), false);
      }
    }),
  );

  it.effect("maps image generation items without conflating them with image views", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-image-generation-complete"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "item/completed",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("image-generation-1"),
        payload: {
          completedAtMs: 1_778_000_000_000,
          threadId: "provider-thread-1",
          turnId: "turn-1",
          item: {
            type: "imageGeneration",
            id: "image-generation-1",
            status: "completed",
            result: "base64-result-is-not-used-as-the-visible-detail",
            fileId: "private-image-adapter-attachment",
            inputImages: [
              { path: "/private-image-adapter-input.png", sha256: "private-image-adapter-digest" },
            ],
            revisedPrompt: "A precise technical diagram",
            savedPath: "/tmp/image-generation-1.png",
          },
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);
      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some" || firstEvent.value.type !== "item.completed") {
        return;
      }
      assert.equal(firstEvent.value.payload.itemType, "image_generation");
      assert.equal(firstEvent.value.payload.title, "Image generation");
      assert.equal(firstEvent.value.payload.detail, "A precise technical diagram");
      assert.doesNotMatch(encodeProviderJsonString(firstEvent.value), /private-image-adapter/);
      assert.match(encodeProviderJsonString(firstEvent.value), /\/tmp\/image-generation-1\.png/);
    }),
  );

  it.effect(
    "preserves inline, file-only and transitional image lifecycle without exposing new metadata",
    () =>
      Effect.gen(function* () {
        const { adapter, runtime } = yield* startLifecycleRuntime();
        const references = [
          { result: "legacy-inline-result" },
          { fileId: "private-image-reference-file" },
          { result: "", fileId: "private-image-reference-both" },
        ];
        const eventsFiber = yield* adapter.streamEvents.pipe(
          Stream.take(references.length * 2),
          Stream.runCollect,
          Effect.forkChild,
        );
        const originals: Array<{ readonly payload: unknown; readonly before: string }> = [];
        for (const [index, reference] of references.entries()) {
          for (const method of ["item/started", "item/completed"] as const) {
            const payload = {
              threadId: "provider-thread-1",
              turnId: "turn-image-references",
              ...(method === "item/started" ? { startedAtMs: 1 } : { completedAtMs: 2 }),
              item: {
                type: "imageGeneration",
                id: `image-reference-${index}`,
                status: method === "item/started" ? "inProgress" : "completed",
                revisedPrompt: "The original visible image prompt",
                savedPath: "/fixture/existing-image.png",
                inputImages: [
                  {
                    path: "/private-image-reference-input.png",
                    sha256: "private-image-reference-digest",
                  },
                ],
                ...reference,
              },
            };
            originals.push({ payload, before: encodeProviderJsonString(payload) });
            yield* runtime.emit({
              id: asEventId(`image-reference-${index}-${method}`),
              kind: "notification",
              provider: ProviderDriverKind.make("codex"),
              createdAt: "2026-10-23T00:00:00.000Z",
              method,
              threadId: asThreadId("thread-1"),
              turnId: asTurnId("turn-image-references"),
              itemId: asItemId(`image-reference-${index}`),
              payload,
            });
          }
        }
        const events = Array.from(yield* Fiber.join(eventsFiber));
        assert.equal(events.length, 6);
        for (const [index, event] of events.entries()) {
          assert.equal(event.type, index % 2 === 0 ? "item.started" : "item.completed");
          if (event.type !== "item.started" && event.type !== "item.completed")
            assert.fail("Expected the original image lifecycle");
          assert.equal(event.payload.itemType, "image_generation");
          assert.equal(event.payload.title, "Image generation");
          assert.equal(event.payload.detail, "The original visible image prompt");
          assert.equal(event.itemId, `image-reference-${Math.floor(index / 2)}`);
          assert.doesNotMatch(encodeProviderJsonString(event), /private-image-reference/);
          assert.match(encodeProviderJsonString(event), /\/fixture\/existing-image\.png/);
        }
        for (const original of originals)
          assert.equal(encodeProviderJsonString(original.payload), original.before);
        assert.equal(runtime.sendTurnImpl.mock.calls.length, 0);
        assert.equal(runtime.steerTurnImpl.mock.calls.length, 0);
      }),
  );

  it.effect(
    "projects image metadata from public read and rollback history without changing native snapshots",
    () =>
      Effect.gen(function* () {
        const { adapter, runtime } = yield* startLifecycleRuntime();
        const snapshot = {
          threadId: "provider-thread-1",
          turns: [
            {
              id: asTurnId("history-image-turn"),
              items: [
                {
                  type: "imageGeneration",
                  id: "inline-image",
                  status: "completed",
                  result: "legacy-inline-result",
                  revisedPrompt: "Visible prompt",
                  savedPath: "/fixture/existing-image.png",
                  inputImages: [
                    {
                      path: "/private-image-history-input.png",
                      sha256: "private-image-history-digest",
                    },
                  ],
                },
                {
                  type: "imageGeneration",
                  id: "file-image",
                  status: "completed",
                  fileId: "private-image-history-file",
                },
                {
                  type: "imageGeneration",
                  id: "both-image",
                  status: "completed",
                  result: "",
                  fileId: "private-image-history-both",
                },
              ],
            },
          ],
        } satisfies CodexThreadSnapshot;
        const before = encodeProviderJsonString(snapshot);
        runtime.readThreadImpl.mockResolvedValueOnce(snapshot);
        runtime.rollbackThreadImpl.mockResolvedValueOnce(snapshot);
        for (const projected of [
          yield* adapter.readThread(asThreadId("thread-1")),
          yield* adapter.rollbackThread(asThreadId("thread-1"), 1),
        ]) {
          assert.equal(projected.threadId, "thread-1");
          assert.equal(projected.turns[0]?.id, "history-image-turn");
          assert.equal(projected.turns[0]?.items.length, 3);
          assert.doesNotMatch(encodeProviderJsonString(projected), /private-image-history/);
          assert.match(encodeProviderJsonString(projected), /legacy-inline-result/);
          assert.match(encodeProviderJsonString(projected), /\/fixture\/existing-image\.png/);
        }
        assert.equal(encodeProviderJsonString(snapshot), before);
        assert.equal(runtime.readThreadImpl.mock.calls.length, 1);
        assert.equal(runtime.rollbackThreadImpl.mock.calls.length, 1);
        assert.equal(runtime.sendTurnImpl.mock.calls.length, 0);
        assert.equal(runtime.steerTurnImpl.mock.calls.length, 0);
      }),
  );

  it.effect("maps Codex interrupt hook lifecycle into canonical hook events", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-hook-complete"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "hook/completed",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("hook-1"),
        payload: {
          threadId: "provider-thread-1",
          turnId: "turn-1",
          run: {
            id: "hook-1",
            eventName: "interrupt",
            scope: "turn",
            source: "project",
            sourcePath: "/tmp/hooks.json",
            handlerType: "command",
            executionMode: "sync",
            status: "failed",
            statusMessage: "Hook rejected the output",
            startedAt: 1_778_000_000,
            completedAt: 1_778_000_001,
            durationMs: 1_000,
            displayOrder: 0,
            entries: [{ kind: "error", text: "Validation failed" }],
          },
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);
      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some" || firstEvent.value.type !== "hook.completed") {
        return;
      }
      assert.equal(firstEvent.value.turnId, "turn-1");
      assert.equal(firstEvent.value.payload.hookId, "hook-1");
      assert.equal(firstEvent.value.payload.outcome, "error");
      assert.equal(
        firstEvent.value.payload.output,
        "Hook rejected the output\nerror: Validation failed",
      );
    }),
  );

  it.effect("maps automatic approval review lifecycle into canonical task activity", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-approval-review-complete"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "item/autoApprovalReview/completed",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("review-1"),
        payload: {
          threadId: "provider-thread-1",
          turnId: "turn-1",
          reviewId: "review-1",
          targetItemId: "command-1",
          startedAtMs: 1_778_000_000_000,
          completedAtMs: 1_778_000_001_000,
          decisionSource: "agent",
          review: {
            status: "denied",
            riskLevel: "high",
            userAuthorization: "low",
            rationale: "The command exceeds the current authorization level.",
          },
          action: {
            type: "writeStdin",
            approvalId: "stdin-approval-secret-id",
            processId: "process-secret-id",
            stdin: "literal terminal input must never be persisted",
            cwd: "/private/terminal/cwd",
          },
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);
      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some" || firstEvent.value.type !== "task.completed") {
        return;
      }
      assert.equal(firstEvent.value.turnId, "turn-1");
      assert.equal(firstEvent.value.payload.taskId, "codex-auto-approval-review:review-1");
      assert.equal(firstEvent.value.payload.status, "failed");
      assert.equal(
        firstEvent.value.payload.summary,
        "The command exceeds the current authorization level.",
      );
      assert.deepStrictEqual(firstEvent.value.raw?.payload, {
        redacted: true,
        reason: "approval-review-provider-content",
        actionType: "writeStdin",
        reviewStatus: "denied",
        decisionSource: "agent",
        startedAtMs: 1_778_000_000_000,
        completedAtMs: 1_778_000_001_000,
        terminalInputPresent: true,
      });
      assert.doesNotMatch(
        encodeProviderJsonString(firstEvent.value.raw),
        /literal terminal input|private\/terminal|process-secret|stdin-approval-secret/,
      );
    }),
  );

  it.effect("keeps Codex guardian warnings visible as recoverable work-log warnings", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-guardian-warning"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "guardianWarning",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        payload: {
          threadId: "provider-thread-1",
          message: "Automatic approval review denied the requested action.",
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);
      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some" || firstEvent.value.type !== "runtime.warning") {
        return;
      }
      assert.equal(
        firstEvent.value.payload.message,
        "Automatic approval review denied the requested action.",
      );
    }),
  );

  it.effect("surfaces account verification as an actionable non-terminal notice", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);
      yield* runtime.emit({
        id: asEventId("evt-model-verification"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "model/verification",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        payload: {
          threadId: "provider-thread-1",
          turnId: "turn-1",
          verifications: ["trustedAccessForCyber"],
        },
      } satisfies ProviderEvent);
      const firstEvent = yield* Fiber.join(firstEventFiber);
      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") return;
      assert.equal(firstEvent.value.type, "runtime.warning");
      if (firstEvent.value.type !== "runtime.warning") return;
      assert.match(firstEvent.value.payload.message, /Trusted Access verification/);
      assert.match(firstEvent.value.payload.message, /choose another model/);
    }),
  );

  it.effect("keeps strict approval review visible without terminalizing the turn", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-strict-review-required"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "autoApprovalReview/strictReviewRequired",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        payload: {
          threadId: "provider-thread-1",
          turnId: "provider-turn-1",
          startedAtMs: 1_778_000_000_000,
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);
      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some" || firstEvent.value.type !== "runtime.warning") {
        return;
      }
      assert.equal(firstEvent.value.turnId, "turn-1");
      assert.equal(
        firstEvent.value.payload.message,
        "Codex is running additional safety checks; some tool calls may take extra time.",
      );
      assert.deepStrictEqual(firstEvent.value.payload.detail, {
        startedAtMs: 1_778_000_000_000,
      });
    }),
  );

  it.effect("maps Codex multi-agent-v2 activity into a structured live subagent task", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-subagent-activity"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "item/started",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-parent"),
        itemId: asItemId("subagent-activity-1"),
        payload: {
          startedAtMs: 1_767_225_600_000,
          threadId: "provider-thread-1",
          turnId: "turn-parent",
          item: {
            type: "subAgentActivity",
            id: "subagent-activity-1",
            kind: "started",
            agentThreadId: "provider-thread-child",
            agentPath: "workers/audit",
          },
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);
      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "task.started");
      if (firstEvent.value.type !== "task.started") {
        return;
      }
      assert.equal(firstEvent.value.turnId, "turn-parent");
      assert.equal(firstEvent.value.payload.taskId, "provider-thread-child");
      assert.equal(firstEvent.value.payload.taskType, "subagent");
      assert.deepStrictEqual(firstEvent.value.payload.subagent, {
        threadId: "provider-thread-child",
        label: "Audit",
        path: "workers/audit",
        status: "active",
        startedAt: "2026-01-01T00:00:00.000Z",
      });
      assert.deepStrictEqual(firstEvent.value.raw?.payload, {
        source: "codex.subAgentActivity",
        kind: "started",
        childThreadIdHash: crypto
          .createHash("sha256")
          .update("provider-thread-child", "utf8")
          .digest("hex"),
      });
    }),
  );

  it.effect("treats Codex multi-agent-v2 completed activity as terminal", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-subagent-activity-completed"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:04.000Z",
        method: "item/completed",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-parent"),
        itemId: asItemId("subagent-activity-completed"),
        payload: {
          completedAtMs: 1_767_225_604_000,
          threadId: "provider-thread-1",
          turnId: "turn-parent",
          item: {
            type: "subAgentActivity",
            id: "subagent-activity-completed",
            kind: "completed",
            agentThreadId: "provider-thread-child",
            agentPath: "/root/workers/audit",
          },
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);
      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some" || firstEvent.value.type !== "task.completed") {
        return;
      }
      assert.equal(firstEvent.value.payload.taskId, "provider-thread-child");
      assert.equal(firstEvent.value.payload.status, "completed");
      assert.equal(firstEvent.value.payload.summary, "Completed");
      assert.equal(firstEvent.value.payload.subagent?.status, "completed");
      assert.deepStrictEqual(firstEvent.value.raw?.payload, {
        source: "codex.subAgentActivity",
        kind: "completed",
        childThreadIdHash: crypto
          .createHash("sha256")
          .update("provider-thread-child", "utf8")
          .digest("hex"),
      });
    }),
  );

  it.effect("keeps Codex 0.150 analytics-only collaboration calls out of the work log", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-collab-send-message"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "item/completed",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-parent"),
        itemId: asItemId("collab-send-message"),
        payload: {
          completedAtMs: 1_767_225_600_000,
          threadId: "provider-thread-1",
          turnId: "turn-parent",
          item: {
            type: "collabAgentToolCall",
            id: "collab-send-message",
            tool: "sendMessage",
            status: "completed",
            senderThreadId: "provider-thread-1",
            receiverThreadIds: ["provider-thread-child"],
            prompt: "Private provider message that must not create a duplicate row.",
            agentsStates: {},
          },
        },
      } satisfies ProviderEvent);
      yield* runtime.emit({
        id: asEventId("evt-collab-analytics-sentinel"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:01.000Z",
        method: "process/stderr",
        turnId: asTurnId("turn-parent"),
        message: "sentinel warning",
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);
      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some" || firstEvent.value.type !== "runtime.warning") {
        return;
      }
      assert.equal(firstEvent.value.payload.message, "sentinel warning");
    }),
  );

  it.effect(
    "attributes reverse-root activity to its source child without creating a root task",
    () =>
      Effect.gen(function* () {
        const { adapter, runtime } = yield* startLifecycleRuntime();
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 2)).pipe(
          Effect.forkChild,
        );

        // An ambiguous root self-edge has no provable child owner and must not
        // enter the canonical task stream at all.
        yield* runtime.emit({
          id: asEventId("evt-subagent-root-self-edge"),
          kind: "notification",
          provider: ProviderDriverKind.make("codex"),
          createdAt: "2026-01-01T00:00:00.000Z",
          method: "item/completed",
          threadId: asThreadId("thread-1"),
          turnId: asTurnId("turn-parent"),
          itemId: asItemId("subagent-root-self-edge"),
          payload: {
            completedAtMs: 1_767_225_600_000,
            // Control/whitespace aliases must compare equal after the exact
            // identity canonicalization used by the production presentation.
            threadId: "\tprovider-thread-root\r",
            turnId: "turn-parent",
            item: {
              type: "subAgentActivity",
              id: "subagent-root-self-edge",
              kind: "interacted",
              agentThreadId: "provider-thread-root",
              agentPath: "/root/",
            },
          },
        } satisfies ProviderEvent);

        yield* runtime.emit({
          id: asEventId("evt-subagent-child-start"),
          kind: "notification",
          provider: ProviderDriverKind.make("codex"),
          createdAt: "2026-01-01T00:00:01.000Z",
          method: "item/started",
          threadId: asThreadId("thread-1"),
          turnId: asTurnId("turn-parent"),
          itemId: asItemId("subagent-child-start"),
          payload: {
            startedAtMs: 1_767_225_601_000,
            threadId: "provider-thread-root",
            turnId: "turn-parent",
            item: {
              type: "subAgentActivity",
              id: "subagent-child-start",
              kind: "started",
              agentThreadId: "provider-thread-child",
              agentPath: "/root/audit_restart",
            },
          },
        } satisfies ProviderEvent);

        // Codex encodes child -> parent interaction with the child as the source
        // payload thread and the primary conversation as the `/root` target.
        yield* runtime.emit({
          id: asEventId("evt-subagent-child-to-root"),
          kind: "notification",
          provider: ProviderDriverKind.make("codex"),
          createdAt: "2026-01-01T00:00:02.000Z",
          method: "item/completed",
          threadId: asThreadId("thread-1"),
          turnId: asTurnId("turn-parent"),
          itemId: asItemId("subagent-child-to-root"),
          payload: {
            completedAtMs: 1_767_225_602_000,
            threadId: "provider-thread-child",
            turnId: "turn-child",
            item: {
              type: "subAgentActivity",
              id: "subagent-child-to-root",
              kind: "interacted",
              agentThreadId: "provider-thread-root",
              agentPath: "/root",
            },
          },
        } satisfies ProviderEvent);

        // A final ordinary child event prevents a regression from hanging this
        // test: if the reverse-root edge is accidentally suppressed, this event
        // becomes the second collected row and the identity assertions fail
        // immediately with useful evidence.
        yield* runtime.emit({
          id: asEventId("evt-subagent-sentinel"),
          kind: "notification",
          provider: ProviderDriverKind.make("codex"),
          createdAt: "2026-01-01T00:00:03.000Z",
          method: "item/started",
          threadId: asThreadId("thread-1"),
          turnId: asTurnId("turn-parent"),
          itemId: asItemId("subagent-sentinel"),
          payload: {
            startedAtMs: 1_767_225_603_000,
            threadId: "provider-thread-root",
            turnId: "turn-parent",
            item: {
              type: "subAgentActivity",
              id: "subagent-sentinel",
              kind: "started",
              agentThreadId: "provider-thread-sentinel",
              agentPath: "/root/sentinel",
            },
          },
        } satisfies ProviderEvent);

        const events = Array.from(yield* Fiber.join(eventsFiber));
        assert.equal(events.length, 2);
        assert.equal(events[0]?.type, "task.started");
        const progress = events[1];
        assert.equal(progress?.type, "task.progress");
        if (progress?.type !== "task.progress") return;
        assert.equal(progress.payload.taskId, "provider-thread-child");
        assert.equal(progress.payload.description, "Working");
        assert.deepStrictEqual(progress.payload.subagent, {
          threadId: "provider-thread-child",
          label: "Audit restart",
          path: "/root/audit_restart",
          status: "active",
          startedAt: "2026-01-01T00:00:01.000Z",
        });
        assert.notEqual(progress.payload.taskId, "provider-thread-root");
      }),
  );

  it.effect("bounds one hostile collab item without collapsing retained receiver identities", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const expectedCount = 256;
      const eventsFiber = yield* Stream.runCollect(
        Stream.take(adapter.streamEvents, expectedCount),
      ).pipe(Effect.forkChild);
      const receiverThreadIds = Array.from(
        { length: expectedCount + 1 },
        (_, index) => `provider-child-${index}`,
      );

      yield* runtime.emit({
        id: asEventId("evt-subagent-receiver-bound"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "item/started",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-parent"),
        itemId: asItemId("collab-many-receivers"),
        payload: {
          startedAtMs: 1_767_225_600_000,
          threadId: "provider-thread-1",
          turnId: "turn-parent",
          item: {
            type: "collabAgentToolCall",
            id: "collab-many-receivers",
            tool: "spawnAgent",
            status: "inProgress",
            senderThreadId: "provider-thread-1",
            receiverThreadIds,
            prompt: "Audit a bounded receiver set.",
            agentsStates: {},
          },
        },
      } satisfies ProviderEvent);

      const events = Array.from(yield* Fiber.join(eventsFiber));
      assert.equal(events.length, expectedCount);
      const taskIds = events.flatMap((event) =>
        event.type === "task.started" ? [event.payload.taskId] : [],
      );
      assert.equal(new Set(taskIds).size, expectedCount);
      assert.equal(taskIds.includes(RuntimeTaskId.make("provider-child-256")), false);
      assert.deepStrictEqual(events[0]?.raw?.payload, {
        source: "codex.collabAgentToolCall",
        tool: "spawnAgent",
        callStatus: "inProgress",
        agentStatus: null,
        objectivePresent: true,
        receiverCount: expectedCount + 1,
        receiversTruncated: true,
        childThreadIdHash: crypto
          .createHash("sha256")
          .update("provider-child-0", "utf8")
          .digest("hex"),
      });
    }),
  );

  it.effect("invalidates child detail for public replies without exposing their text", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 2)).pipe(
        Effect.forkChild,
      );
      for (const [index, phase] of ["commentary", "final_answer"].entries()) {
        yield* runtime.emit({
          id: asEventId(`evt-public-child-${index}`),
          kind: "notification",
          provider: ProviderDriverKind.make("codex"),
          createdAt: "2026-01-01T00:00:12.000Z",
          method: "codex.subagent/itemCompleted",
          threadId: asThreadId("thread-1"),
          turnId: asTurnId("turn-parent"),
          itemId: asItemId(`private-item-${index}`),
          payload: {
            completedAtMs: 1_767_225_612_000,
            threadId: "provider-thread-child",
            turnId: "private-native-turn",
            item: {
              type: "agentMessage",
              id: `private-item-${index}`,
              phase,
              text: "public-message-not-for-lifecycle-storage",
            },
          },
        } satisfies ProviderEvent);
      }
      const events = Array.from(yield* Fiber.join(eventsFiber));
      assert.equal(events.length, 2);
      for (const event of events) {
        assert.equal(event.type, "task.progress");
        if (event.type !== "task.progress") continue;
        assert.equal(event.payload.taskId, "provider-thread-child");
        assert.equal(event.payload.description, "Posted an update");
        assert.equal(event.payload.subagent?.status, "active");
        assert.doesNotMatch(
          encodeProviderJsonString(event),
          /public-message-not-for-lifecycle-storage|private-native-turn/,
        );
        assert.doesNotMatch(encodeProviderJsonString(event.raw?.payload), /private-item/);
      }
    }),
  );

  it.effect("maps routed child reasoning summaries to the matching subagent progress row", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-child-reasoning"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:12.000Z",
        method: "codex.subagent/itemCompleted",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-parent"),
        itemId: asItemId("reasoning-child-1"),
        payload: {
          completedAtMs: 1_767_225_612_000,
          threadId: "provider-thread-child",
          turnId: "provider-turn-child",
          item: {
            type: "reasoning",
            id: "reasoning-child-1",
            summary: ["**I'm refining trigger label filtering.**"],
            content: [],
          },
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);
      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some" || firstEvent.value.type !== "task.progress") return;
      assert.equal(firstEvent.value.payload.taskId, "provider-thread-child");
      assert.equal(firstEvent.value.payload.description, "refining trigger label filtering");
      assert.deepStrictEqual(firstEvent.value.payload.subagent, {
        threadId: "provider-thread-child",
        status: "active",
      });
      assert.deepStrictEqual(firstEvent.value.raw?.payload, {
        source: "codex.child.itemCompleted",
        itemType: "reasoning",
        childThreadIdHash: crypto
          .createHash("sha256")
          .update("provider-thread-child", "utf8")
          .digest("hex"),
      });
    }),
  );

  it.effect("repeats complete Codex subagent presentation on later progress edges", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 3)).pipe(
        Effect.forkChild,
      );

      yield* runtime.emit({
        id: asEventId("evt-collab-spawn"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "item/started",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-parent"),
        itemId: asItemId("collab-spawn-1"),
        payload: {
          startedAtMs: 1_767_225_600_000,
          threadId: "provider-thread-1",
          turnId: "turn-parent",
          item: {
            type: "collabAgentToolCall",
            id: "collab-spawn-1",
            tool: "spawnAgent",
            status: "inProgress",
            senderThreadId: "provider-thread-1",
            receiverThreadIds: ["provider-thread-child"],
            prompt: "Trace child activity into the chat work log.",
            agentsStates: {
              "provider-thread-child": { status: "running" },
            },
          },
        },
      } satisfies ProviderEvent);
      yield* runtime.emit({
        id: asEventId("evt-subagent-path"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:01.000Z",
        method: "item/started",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-parent"),
        itemId: asItemId("subagent-path-1"),
        payload: {
          startedAtMs: 1_767_225_601_000,
          threadId: "provider-thread-1",
          turnId: "turn-parent",
          item: {
            type: "subAgentActivity",
            id: "subagent-path-1",
            kind: "started",
            agentThreadId: "provider-thread-child",
            agentPath: "/root/audit_chat_pipeline",
          },
        },
      } satisfies ProviderEvent);
      yield* runtime.emit({
        id: asEventId("evt-child-progress-after-spawn"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:12.000Z",
        method: "codex.subagent/itemCompleted",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-parent"),
        itemId: asItemId("reasoning-child-2"),
        payload: {
          completedAtMs: 1_767_225_612_000,
          threadId: "provider-thread-child",
          turnId: "provider-turn-child",
          item: {
            type: "reasoning",
            id: "reasoning-child-2",
            summary: ["Checking the durable activity projection."],
            content: [],
          },
        },
      } satisfies ProviderEvent);

      const events = Array.from(yield* Fiber.join(eventsFiber));
      assert.equal(events.length, 3);
      const progress = events[2];
      assert.equal(progress?.type, "task.progress");
      if (progress?.type !== "task.progress") return;
      assert.deepStrictEqual(progress.payload.subagent, {
        threadId: "provider-thread-child",
        label: "Audit chat pipeline",
        path: "/root/audit_chat_pipeline",
        objective: "Trace child activity into the chat work log.",
        status: "active",
        startedAt: "2026-01-01T00:00:00.000Z",
      });
    }),
  );

  it.effect(
    "keeps renamed terminal child metadata fresh without replay reopening, then admits real reuse",
    () =>
      Effect.gen(function* () {
        const { adapter, runtime } = yield* startLifecycleRuntime();
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 10)).pipe(
          Effect.forkChild,
        );
        const emit = (index: number, method: string, payload: unknown) =>
          runtime.emit({
            id: asEventId(`child-refresh-${index}`),
            kind: "notification",
            provider: ProviderDriverKind.make("codex"),
            threadId: asThreadId("thread-1"),
            turnId: asTurnId("parent-refresh"),
            createdAt: `2026-10-03T00:00:0${index}.000Z`,
            method,
            payload,
          });
        yield* emit(0, "item/started", {
          startedAtMs: 1_791_072_000_000,
          threadId: "native-parent",
          turnId: "parent-refresh",
          item: {
            type: "subAgentActivity",
            id: "started-0",
            kind: "started",
            agentThreadId: "renamed-child",
            agentPath: "workers/original",
          },
        });
        // This is also exactly the canonical notification emitted after a safe,
        // unchanged native thread/read idle snapshot (no elapsed-time inference).
        yield* emit(1, "codex.subagent/threadStatusChanged", {
          threadId: "renamed-child",
          status: { type: "idle" },
        });
        yield* emit(2, "codex.subagent/threadNameUpdated", {
          threadId: "renamed-child",
          threadName: "Updated child name",
        });
        yield* emit(3, "codex.subagent/itemCompleted", {
          completedAtMs: 1_791_072_003_000,
          threadId: "renamed-child",
          turnId: "completed-native-turn",
          item: {
            type: "webSearch",
            id: "late-child-search",
            query: "synthetic query",
            action: null,
          },
        });
        yield* emit(4, "item/started", {
          startedAtMs: Date.parse("2026-10-03T00:00:04.000Z"),
          threadId: "native-parent",
          turnId: "parent-refresh",
          item: {
            type: "subAgentActivity",
            id: "started-4",
            kind: "started",
            agentThreadId: "renamed-child",
            agentPath: "workers/updated",
          },
        });
        const activity = (index: number, kind: "interacted" | "completed", agentPath: string) =>
          emit(index, "item/completed", {
            completedAtMs: Date.parse(`2026-10-03T00:00:0${index}.000Z`),
            threadId: "native-parent",
            turnId: "parent-refresh",
            item: {
              type: "subAgentActivity",
              id: `activity-${index}`,
              kind,
              agentThreadId: "renamed-child",
              agentPath,
            },
          });
        // An old address can recur in progress after explicit reuse. It is
        // not permission to rename the new assignment back to the old slug.
        yield* activity(5, "interacted", "workers/original");
        yield* emit(6, "codex.subagent/threadNameUpdated", {
          threadId: "renamed-child",
          threadName: "Fresh reused child title",
        });
        yield* activity(7, "interacted", "workers/updated");
        yield* activity(8, "completed", "workers/original");
        yield* activity(9, "interacted", "workers/updated");
        const events = Array.from(yield* Fiber.join(eventsFiber));
        assert.deepEqual(
          events.map((event) => event.type),
          [
            "task.started",
            "task.completed",
            "task.progress",
            "task.progress",
            "task.started",
            "task.progress",
            "task.progress",
            "task.progress",
            "task.completed",
            "task.progress",
          ],
        );
        const presentations = events.map((event) =>
          "subagent" in event.payload ? event.payload.subagent : undefined,
        );
        assert.equal(presentations[2]?.label, "Updated child name");
        assert.equal(presentations[2]?.status, "completed");
        assert.equal(presentations[3]?.label, "Updated child name");
        assert.equal(presentations[3]?.status, "completed");
        assert.equal(presentations[4]?.status, "active");
        assert.equal(presentations[4]?.startedAt, "2026-10-03T00:00:04.000Z");
        assert.equal(presentations[4]?.label, "Updated");
        assert.equal(presentations[5]?.label, "Updated");
        assert.equal(presentations[5]?.path, "workers/updated");
        for (const presentation of presentations.slice(6)) {
          assert.equal(presentation?.label, "Fresh reused child title");
          assert.equal(presentation?.path, "workers/updated");
        }
        assert.equal(presentations[8]?.status, "completed");
        assert.equal(presentations[9]?.status, "completed");
        assert.doesNotMatch(
          encodeProviderJsonString(events),
          /titleSource|titleRuntimeId|fallbackLabel/u,
        );
      }),
  );

  it.effect("prefers each new child's native name over its path, nickname and role", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 4)).pipe(
        Effect.forkChild,
      );
      for (const [index, title] of ["First fresh title", "Second fresh title"].entries()) {
        const childId = `fresh-child-${index}`;
        yield* runtime.emit({
          id: asEventId(`fresh-thread-${index}`),
          kind: "notification",
          provider: ProviderDriverKind.make("codex"),
          threadId: asThreadId("thread-1"),
          turnId: asTurnId("parent-titles"),
          createdAt: "2026-10-04T00:00:00.000Z",
          method: "codex.subagent/threadStarted",
          payload: {
            thread: {
              id: childId,
              name: title,
              agentNickname: "Lower priority nickname",
              agentRole: "Lower priority role",
              cliVersion: "0.160.0",
              createdAt: 1_791_072_000,
              updatedAt: 1_791_072_000,
              cwd: process.cwd(),
              ephemeral: false,
              modelProvider: "openai",
              preview: "",
              projectId: null,
              sessionId: "native-session",
              source: {
                subAgent: {
                  thread_spawn: {
                    parent_thread_id: "native-parent",
                    depth: 1,
                    agent_path: "/root/same_old_path",
                    agent_nickname: "Lower priority source nickname",
                    agent_role: "Lower priority source role",
                  },
                },
              },
              status: { type: "active", activeFlags: [] },
              turns: [],
            },
          },
        });
        yield* runtime.emit({
          id: asEventId(`fresh-activity-${index}`),
          kind: "notification",
          provider: ProviderDriverKind.make("codex"),
          threadId: asThreadId("thread-1"),
          turnId: asTurnId("parent-titles"),
          createdAt: "2026-10-04T00:00:01.000Z",
          method: "item/started",
          payload: {
            startedAtMs: Date.parse("2026-10-04T00:00:01.000Z"),
            threadId: "native-parent",
            turnId: "parent-titles",
            item: {
              type: "subAgentActivity",
              id: `fresh-start-${index}`,
              kind: "started",
              agentThreadId: childId,
              agentPath: "/root/same_old_path",
            },
          },
        });
      }
      const events = Array.from(yield* Fiber.join(eventsFiber));
      const presentations = events.map((event) =>
        "subagent" in event.payload ? event.payload.subagent : undefined,
      );
      assert.deepEqual(
        presentations.map((value) => value?.label),
        ["First fresh title", "First fresh title", "Second fresh title", "Second fresh title"],
      );
      assert.deepEqual(
        presentations.map((value) => value?.threadId),
        ["fresh-child-0", "fresh-child-0", "fresh-child-1", "fresh-child-1"],
      );
      assert.doesNotMatch(
        encodeProviderJsonString(events),
        /titleSource|titleRuntimeId|fallbackLabel/u,
      );
    }),
  );

  it.effect(
    "clears only an explicit native null title, retaining path fallback and later renames",
    () =>
      Effect.gen(function* () {
        const { adapter, runtime } = yield* startLifecycleRuntime();
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 8)).pipe(
          Effect.forkChild,
        );
        const frames = [
          [
            "item/started",
            {
              startedAtMs: Date.parse("2026-10-04T00:00:00.000Z"),
              threadId: "native-parent",
              turnId: "parent-clear",
              item: {
                type: "subAgentActivity",
                id: "clear-start",
                kind: "started",
                agentThreadId: "clear-child",
                agentPath: "/root/path_fallback",
              },
            },
          ],
          [
            "codex.subagent/threadNameUpdated",
            { threadId: "clear-child", threadName: "Native title" },
          ],
          ["codex.subagent/threadNameUpdated", { threadId: "clear-child" }],
          [
            "codex.subagent/threadNameUpdated",
            { threadId: "clear-child", threadName: "\u0000\u202e " },
          ],
          ["codex.subagent/threadNameUpdated", { threadId: "clear-child", threadName: null }],
          ["codex.subagent/threadNameUpdated", { threadId: "clear-child" }],
          [
            "codex.subagent/threadNameUpdated",
            { threadId: "clear-child", threadName: "New native title" },
          ],
          ["codex.subagent/threadNameUpdated", { threadId: "clear-child", threadName: "   " }],
        ] as const;
        for (const [index, [method, payload]] of frames.entries()) {
          yield* runtime.emit({
            id: asEventId(`clear-title-${index}`),
            kind: "notification",
            provider: ProviderDriverKind.make("codex"),
            threadId: asThreadId("thread-1"),
            turnId: asTurnId("parent-clear"),
            createdAt: "2026-10-04T00:00:00.000Z",
            method,
            payload,
          });
        }
        const events = Array.from(yield* Fiber.join(eventsFiber));
        const presentations = events.map((event) =>
          "subagent" in event.payload ? event.payload.subagent : undefined,
        );
        assert.deepEqual(
          presentations.map((value) => value?.label),
          [
            "Path fallback",
            "Native title",
            "Native title",
            "Native title",
            "Path fallback",
            "Path fallback",
            "New native title",
            "New native title",
          ],
        );
        assert.ok(presentations.every((value) => value?.status === "active"));
      }),
  );

  it.effect("retains a native nickname fallback across progress and foreign role metadata", () =>
    Effect.gen(function* () {
      const currentId = "42b69839-1c6d-45f5-ab7b-7d7cc374342c";
      const foreignId = "e9480f5a-911a-44ce-906d-c6011f13aaed";
      const { adapter, runtime } = yield* startLifecycleRuntime(currentId);
      const thread = {
        id: "nickname-child",
        name: "Native title",
        agentNickname: "Rose",
        agentRole: "worker",
        cliVersion: "0.160.0",
        createdAt: 1_791_072_000,
        updatedAt: 1_791_072_000,
        cwd: process.cwd(),
        ephemeral: false,
        modelProvider: "openai",
        preview: "",
        projectId: null,
        sessionId: "native-session",
        source: "appServer",
        status: { type: "active", activeFlags: [] },
        turns: [],
      };
      const frames = [
        [currentId, "codex.subagent/threadStarted", { thread }],
        [
          currentId,
          "codex.subagent/itemCompleted",
          {
            completedAtMs: Date.parse("2026-10-04T00:00:00.000Z"),
            threadId: "nickname-child",
            turnId: "child-nickname",
            item: { type: "webSearch", id: "nickname-progress", query: "synthetic", action: null },
          },
        ],
        [
          foreignId,
          "codex.subagent/threadStarted",
          {
            thread: {
              ...thread,
              name: "Foreign title",
              agentNickname: "Foreign nickname",
              agentRole: "Foreign role",
            },
          },
        ],
        [
          foreignId,
          "codex.subagent/threadNameUpdated",
          { threadId: "nickname-child", threadName: null },
        ],
        [
          currentId,
          "codex.subagent/itemCompleted",
          {
            completedAtMs: Date.parse("2026-10-04T00:00:00.000Z"),
            threadId: "nickname-child",
            turnId: "child-nickname",
            item: {
              type: "webSearch",
              id: "nickname-progress-again",
              query: "synthetic",
              action: null,
            },
          },
        ],
        [
          currentId,
          "codex.subagent/threadNameUpdated",
          { threadId: "nickname-child", threadName: null },
        ],
      ] as const;
      const eventsFiber = yield* Stream.runCollect(
        Stream.take(adapter.streamEvents, frames.length),
      ).pipe(Effect.forkChild);
      for (const [index, [subagentRuntimeId, method, payload]] of frames.entries()) {
        yield* runtime.emit({
          id: asEventId(`nickname-title-${index}`),
          kind: "notification",
          provider: ProviderDriverKind.make("codex"),
          threadId: asThreadId("thread-1"),
          turnId: asTurnId("parent-nickname"),
          createdAt: "2026-10-04T00:00:00.000Z",
          subagentRuntimeId,
          method,
          payload,
        });
      }
      const events = Array.from(yield* Fiber.join(eventsFiber));
      assert.deepEqual(
        events.map((event) =>
          "subagent" in event.payload ? event.payload.subagent?.label : undefined,
        ),
        ["Native title", "Native title", "Native title", "Native title", "Native title", "Rose"],
      );
      assert.doesNotMatch(
        encodeProviderJsonString(events),
        /titleSource|titleRuntimeId|fallbackLabel/u,
      );
    }),
  );

  it.effect(
    "fences titles to the bridge generation before and after foreign liveness metadata",
    () =>
      Effect.gen(function* () {
        const currentId = "42b69839-1c6d-45f5-ab7b-7d7cc374342c";
        const foreignId = "e9480f5a-911a-44ce-906d-c6011f13aaed";
        const { adapter, runtime } = yield* startLifecycleRuntime(currentId);
        const frames = [
          [
            foreignId,
            "codex.subagent/threadNameUpdated",
            { threadId: "generation-child", threadName: "Foreign first title" },
          ],
          [
            currentId,
            "item/started",
            {
              startedAtMs: Date.parse("2026-10-04T00:00:00.000Z"),
              threadId: "native-parent",
              turnId: "parent-generation",
              item: {
                type: "subAgentActivity",
                id: "generation-start",
                kind: "started",
                agentThreadId: "generation-child",
                agentPath: "/root/current_path",
              },
            },
          ],
          [
            currentId,
            "codex.subagent/threadNameUpdated",
            { threadId: "generation-child", threadName: "Current title" },
          ],
          [
            foreignId,
            "codex.subagent/threadStatusChanged",
            { threadId: "generation-child", status: { type: "active", activeFlags: [] } },
          ],
          [
            foreignId,
            "codex.subagent/threadNameUpdated",
            { threadId: "generation-child", threadName: "Foreign renamed title" },
          ],
          [
            foreignId,
            "codex.subagent/threadNameUpdated",
            { threadId: "generation-child", threadName: null },
          ],
          [
            undefined,
            "codex.subagent/threadNameUpdated",
            { threadId: "generation-child", threadName: "Unstamped stale title" },
          ],
          [
            currentId,
            "codex.subagent/threadNameUpdated",
            { threadId: "generation-child", threadName: "Current fresh title" },
          ],
          [
            currentId,
            "codex.subagent/itemCompleted",
            {
              completedAtMs: Date.parse("2026-10-04T00:00:00.000Z"),
              threadId: "generation-child",
              turnId: "child-generation",
              item: { type: "webSearch", id: "current-progress", query: "synthetic", action: null },
            },
          ],
          [
            foreignId,
            "codex.subagent/threadStatusChanged",
            { threadId: "generation-child", status: { type: "active", activeFlags: [] } },
          ],
          [
            currentId,
            "codex.subagent/threadNameUpdated",
            { threadId: "generation-child", threadName: null },
          ],
          [
            currentId,
            "codex.subagent/itemCompleted",
            {
              completedAtMs: Date.parse("2026-10-04T00:00:00.000Z"),
              threadId: "generation-child",
              turnId: "child-generation",
              item: {
                type: "webSearch",
                id: "current-progress-cleared",
                query: "synthetic",
                action: null,
              },
            },
          ],
        ] as const;
        const eventsFiber = yield* Stream.runCollect(
          Stream.take(adapter.streamEvents, frames.length),
        ).pipe(Effect.forkChild);
        for (const [index, [subagentRuntimeId, method, payload]] of frames.entries()) {
          yield* runtime.emit({
            id: asEventId(`generation-title-${index}`),
            kind: "notification",
            provider: ProviderDriverKind.make("codex"),
            threadId: asThreadId("thread-1"),
            turnId: asTurnId("parent-generation"),
            createdAt: "2026-10-04T00:00:00.000Z",
            subagentRuntimeId,
            method,
            payload,
          });
        }
        const events = Array.from(yield* Fiber.join(eventsFiber));
        const presentations = events.map((event) =>
          "subagent" in event.payload ? event.payload.subagent : undefined,
        );
        assert.deepEqual(
          presentations.map((value) => value?.label),
          [
            undefined,
            "Current path",
            "Current title",
            "Current title",
            "Current title",
            "Current title",
            "Current title",
            "Current fresh title",
            "Current fresh title",
            "Current fresh title",
            "Current path",
            "Current path",
          ],
        );
        // This change concerns naming only. Runtime provenance remains exactly
        // the existing lifecycle policy, including foreign/unverified metadata.
        assert.equal(presentations[3]?.runtimeId, foreignId);
        assert.equal(presentations[7]?.runtimeId, undefined);
        assert.equal(presentations[8]?.runtimeId, currentId);
        assert.equal(presentations[10]?.runtimeId, undefined);
        assert.equal(presentations[11]?.runtimeId, currentId);
        assert.doesNotMatch(
          encodeProviderJsonString(events),
          /titleSource|titleRuntimeId|fallbackLabel/u,
        );
      }),
  );

  it.effect("bounds large turn diff updates before they enter the canonical runtime stream", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);
      const largeDiff = `diff --git a/file.txt b/file.txt\n${"+".repeat(12_000)}`;

      yield* runtime.emit({
        id: asEventId("evt-turn-diff-large"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "turn/diff/updated",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        payload: {
          threadId: "provider-thread-1",
          turnId: "turn-1",
          diff: largeDiff,
        },
      });

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "turn.diff.updated");
      if (firstEvent.value.type !== "turn.diff.updated") {
        return;
      }
      assert.equal(firstEvent.value.payload.unifiedDiff.length, 4_096);
      assert.notEqual(firstEvent.value.payload.unifiedDiff, largeDiff);

      const rawPayload = firstEvent.value.raw?.payload as Record<string, unknown> | undefined;
      assert.ok(rawPayload);
      assert.equal(rawPayload.diffCharLength, largeDiff.length);
      assert.equal(rawPayload.diffTruncated, true);
      assert.equal(
        rawPayload.diffSha256,
        crypto.createHash("sha256").update(largeDiff, "utf8").digest("hex"),
      );
      assert.equal(typeof rawPayload.diffPreview, "string");
      assert.equal((rawPayload.diffPreview as string).length, 4_096);
      assert.equal(Object.hasOwn(rawPayload, "diff"), false);
    }),
  );

  it.effect(
    "maps aggregate child continuation into explicit reopen and terminal lifecycle events",
    () =>
      Effect.gen(function* () {
        const { adapter, runtime } = yield* startLifecycleRuntime();
        const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 3).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );

        yield* runtime.emit({
          id: asEventId("evt-aggregate-reopened"),
          kind: "notification",
          provider: ProviderDriverKind.make("codex"),
          createdAt: "2026-07-14T00:00:01.000Z",
          method: "codex.aggregateTurn/reopened",
          message: "Live child work resumed.",
          threadId: asThreadId("thread-1"),
          turnId: asTurnId("turn-1"),
          payload: { recoveredAt: "2026-07-14T00:00:01.000Z" },
        } satisfies ProviderEvent);
        yield* runtime.emit({
          id: asEventId("evt-aggregate-completed"),
          kind: "notification",
          provider: ProviderDriverKind.make("codex"),
          createdAt: "2026-07-14T00:00:02.000Z",
          method: "codex.aggregateTurn/completed",
          threadId: asThreadId("thread-1"),
          turnId: asTurnId("turn-1"),
          payload: { state: "completed" },
        } satisfies ProviderEvent);

        const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
        assert.deepStrictEqual(
          runtimeEvents.map((event) => event.type),
          ["turn.started", "runtime.warning", "turn.completed"],
        );
        assert.notEqual(runtimeEvents[0]?.eventId, runtimeEvents[1]?.eventId);
        assert.equal(runtimeEvents[0]?.raw?.method, "codex.aggregateTurn/reopened");
        assert.equal(runtimeEvents[2]?.raw?.method, "codex.aggregateTurn/completed");
      }),
  );

  for (const failure of [
    { code: "serverOverloaded", message: "Selected model is at capacity", status: "failed" },
    {
      code: "flexUnavailable",
      message: "Flex capacity is temporarily unavailable",
      status: "failed",
    },
    { code: "tooManyDenials", message: "Too many tool calls were denied", status: "failed" },
    { code: "tooManyDenials", message: "Too many tool calls were denied", status: "interrupted" },
  ] as const) {
    it.effect(
      `preserves a ${failure.code} ${failure.status} root turn while later child work stays observable`,
      () =>
        Effect.gen(function* () {
          const { adapter, runtime } = yield* startLifecycleRuntime();
          const eventsFiber = yield* Stream.take(adapter.streamEvents, 2).pipe(
            Stream.runCollect,
            Effect.forkChild,
          );
          yield* runtime.emit({
            id: asEventId("evt-capacity-root-terminal"),
            kind: "notification",
            provider: ProviderDriverKind.make("codex"),
            createdAt: "2026-09-05T00:00:00.000Z",
            method: "turn/completed",
            threadId: asThreadId("thread-1"),
            turnId: asTurnId("turn-parent"),
            payload: {
              threadId: "provider-thread-1",
              turn: {
                id: "turn-parent",
                status: failure.status,
                items: [],
                itemsView: "notLoaded",
                error: {
                  message: failure.message,
                  codexErrorInfo: failure.code,
                  additionalDetails: null,
                },
              },
            },
          } satisfies ProviderEvent);
          yield* runtime.emit({
            id: asEventId("evt-child-after-capacity-root"),
            kind: "notification",
            provider: ProviderDriverKind.make("codex"),
            createdAt: "2026-09-05T00:00:01.000Z",
            method: "codex.subagent/itemCompleted",
            threadId: asThreadId("thread-1"),
            turnId: asTurnId("turn-parent"),
            itemId: asItemId("child-progress"),
            payload: {
              completedAtMs: 1_788_566_401_000,
              threadId: "provider-child",
              turnId: "native-child-turn",
              item: {
                type: "reasoning",
                id: "child-progress",
                summary: ["Finishing child work"],
                content: [],
              },
            },
          } satisfies ProviderEvent);
          const events = Array.from(yield* Fiber.join(eventsFiber));
          assert.deepStrictEqual(
            events.map((event) => event.type),
            ["turn.completed", "task.progress"],
          );
          const terminal = events[0];
          assert.equal(
            terminal?.type === "turn.completed" ? terminal.payload.state : undefined,
            failure.status,
          );
          assert.equal(
            terminal?.type === "turn.completed" ? terminal.payload.errorMessage : undefined,
            failure.message,
          );
          const child = events[1];
          assert.equal(
            child?.type === "task.progress" ? child.payload.subagent?.threadId : undefined,
            "provider-child",
          );
          assert.equal(child?.turnId, "turn-parent");
          // A new failure classification must never turn failed provider work
          // into a resubmission, including repeated actions that were denied.
          assert.equal(runtime.sendTurnImpl.mock.calls.length, 0);
          assert.equal(runtime.steerTurnImpl.mock.calls.length, 0);
          assert.equal(runtime.respondToRequestImpl.mock.calls.length, 0);
        }),
    );
  }

  it.effect("maps the final Codex notification burst through the canonical bridge", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 3).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* runtime.emit({
        id: asEventId("evt-final-rate-limits"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "account/rateLimits/updated",
        threadId: asThreadId("thread-1"),
        payload: {
          rateLimits: {
            limitId: "codex",
            limitName: null,
            primary: {
              usedPercent: 18,
              windowDurationMins: 300,
              resetsAt: 1_781_219_828,
            },
            secondary: {
              usedPercent: 7,
              windowDurationMins: 10_080,
              resetsAt: 1_781_776_130,
            },
            credits: null,
            individualLimit: null,
            planType: "pro",
            rateLimitReachedType: null,
          },
        },
      } satisfies ProviderEvent);
      yield* runtime.emit({
        id: asEventId("evt-final-thread-idle"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "thread/status/changed",
        threadId: asThreadId("thread-1"),
        payload: {
          threadId: "provider-thread-1",
          status: { type: "idle" },
        },
      } satisfies ProviderEvent);
      yield* runtime.emit({
        id: asEventId("evt-final-turn-completed"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "turn/completed",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        payload: {
          threadId: "provider-thread-1",
          turn: {
            id: "turn-1",
            items: [],
            itemsView: "notLoaded",
            status: "completed",
            error: null,
            startedAt: 1_781_212_032,
            completedAt: 1_781_212_040,
            durationMs: 7_502,
          },
        },
      } satisfies ProviderEvent);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.deepStrictEqual(
        runtimeEvents.map((event) => event.type),
        ["account.rate-limits.updated", "thread.state.changed", "turn.completed"],
      );
      assert.deepStrictEqual(
        runtimeEvents.map((event) => event.eventId),
        [
          asEventId("evt-final-rate-limits"),
          asEventId("evt-final-thread-idle"),
          asEventId("evt-final-turn-completed"),
        ],
      );
    }),
  );

  it.effect(
    "normalizes future account plans in replay events without retaining untyped metadata",
    () =>
      Effect.gen(function* () {
        const { adapter, runtime } = yield* startLifecycleRuntime();
        const eventsFiber = yield* Stream.take(adapter.streamEvents, 2).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );
        // These events bypass the app-server client's compatibility decoder, as
        // persisted or older-runtime events can. The adapter must independently
        // normalize only plan metadata, then retain the schema-decoded payload
        // in both its canonical event and diagnostics.
        yield* runtime.emit({
          id: asEventId("evt-future-plan-account"),
          kind: "notification",
          provider: ProviderDriverKind.make("codex"),
          createdAt: "2026-09-29T00:00:00.000Z",
          method: "account/updated",
          threadId: asThreadId("thread-1"),
          payload: {
            authMode: "chatgpt",
            planType: "future_plan",
            unexpectedMetadata: "ACCOUNT_METADATA_SENTINEL",
          },
        } satisfies ProviderEvent);
        yield* runtime.emit({
          id: asEventId("evt-future-plan-quota"),
          kind: "notification",
          provider: ProviderDriverKind.make("codex"),
          createdAt: "2026-09-29T00:00:01.000Z",
          method: "account/rateLimits/updated",
          threadId: asThreadId("thread-1"),
          payload: {
            unexpectedMetadata: "QUOTA_ENVELOPE_SENTINEL",
            rateLimits: {
              planType: "future_plan",
              limitId: "codex",
              unexpectedMetadata: "QUOTA_METADATA_SENTINEL",
              primary: {
                usedPercent: 23,
                windowDurationMins: 300,
                resetsAt: 1_790_636_400,
                unexpectedMetadata: "WINDOW_METADATA_SENTINEL",
              },
            },
          },
        } satisfies ProviderEvent);

        const events = Array.from(yield* Fiber.join(eventsFiber));
        const account = events[0];
        const quota = events[1];
        assert.equal(account?.type, "account.updated");
        assert.equal(quota?.type, "account.rate-limits.updated");
        if (account?.type !== "account.updated" || quota?.type !== "account.rate-limits.updated")
          return;
        const expectedAccount = { authMode: "chatgpt", planType: "unknown" };
        const expectedQuota = {
          rateLimits: {
            planType: "unknown",
            limitId: "codex",
            primary: { usedPercent: 23, windowDurationMins: 300, resetsAt: 1_790_636_400 },
          },
        };
        assert.deepEqual(account.payload.account, expectedAccount);
        assert.deepEqual(account.raw?.payload, expectedAccount);
        assert.deepEqual(quota.payload.rateLimits, expectedQuota);
        assert.deepEqual(quota.raw?.payload, expectedQuota);
        assert.doesNotMatch(encodeProviderJsonString(events), /SENTINEL|future_plan/);
      }),
  );

  it.effect(
    "rejects malformed account and quota events even when their plan can be normalized",
    () =>
      Effect.gen(function* () {
        const { adapter, runtime } = yield* startLifecycleRuntime();
        const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);
        for (const [method, payload] of [
          ["account/updated", { authMode: "invalid_auth_mode", planType: "future_plan" }],
          [
            "account/rateLimits/updated",
            { rateLimits: { planType: "future_plan", primary: { usedPercent: "23" } } },
          ],
        ] as const) {
          yield* runtime.emit({
            id: asEventId(`evt-malformed-${method}`),
            kind: "notification",
            provider: ProviderDriverKind.make("codex"),
            createdAt: "2026-09-29T00:00:00.000Z",
            method,
            threadId: asThreadId("thread-1"),
            payload,
          } satisfies ProviderEvent);
        }
        // A later valid notification is an ordering barrier: seeing it first
        // proves both malformed predecessors were rejected without a timed wait.
        yield* runtime.emit({
          id: asEventId("evt-after-malformed-account-events"),
          kind: "notification",
          provider: ProviderDriverKind.make("codex"),
          createdAt: "2026-09-29T00:00:01.000Z",
          method: "warning",
          threadId: asThreadId("thread-1"),
          payload: { message: "Account schema validation barrier" },
        } satisfies ProviderEvent);
        const firstEvent = yield* Fiber.join(firstEventFiber);
        assert.equal(firstEvent._tag, "Some");
        if (firstEvent._tag !== "Some") return;
        assert.equal(firstEvent.value.type, "runtime.warning");
        assert.equal(firstEvent.value.eventId, "evt-after-malformed-account-events");
      }),
  );

  it.effect("maps each Codex task-list update as one complete turn-scoped snapshot", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-task-plan-updated"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "turn/plan/updated",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        payload: {
          threadId: "provider-thread-1",
          turnId: "turn-1",
          explanation: "Refined after inspection",
          plan: [
            { step: "Inspect workspace", status: "completed" },
            { step: "Implement fix", status: "inProgress" },
            { step: "Verify behavior", status: "pending" },
          ],
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);
      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some" || firstEvent.value.type !== "turn.plan.updated") {
        return;
      }
      assert.equal(firstEvent.value.turnId, asTurnId("turn-1"));
      assert.equal(firstEvent.value.payload.explanation, "Refined after inspection");
      assert.deepStrictEqual(firstEvent.value.payload.plan, [
        { step: "Inspect workspace", status: "completed" },
        { step: "Implement fix", status: "inProgress" },
        { step: "Verify behavior", status: "pending" },
      ]);
    }),
  );

  it.effect("maps completed plan items to canonical proposed-plan completion events", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-plan-complete"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "item/completed",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("plan_1"),
        payload: {
          completedAtMs: 1_778_000_000_000,
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "plan",
            id: "plan_1",
            text: "## Final plan\n\n- one\n- two",
          },
        },
      };

      yield* runtime.emit(event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "turn.proposed.completed");
      if (firstEvent.value.type !== "turn.proposed.completed") {
        return;
      }
      assert.equal(firstEvent.value.turnId, "turn-1");
      assert.equal(firstEvent.value.payload.planMarkdown, "## Final plan\n\n- one\n- two");
    }),
  );

  it.effect("maps plan deltas to canonical proposed-plan delta events", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-plan-delta"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "item/plan/delta",
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        itemId: asItemId("plan_1"),
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "plan_1",
          delta: "## Final plan",
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "turn.proposed.delta");
      if (firstEvent.value.type !== "turn.proposed.delta") {
        return;
      }
      assert.equal(firstEvent.value.turnId, "turn-1");
      assert.equal(firstEvent.value.payload.delta, "## Final plan");
    }),
  );

  it.effect("maps session/closed lifecycle events to canonical session.exited runtime events", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-session-closed"),
        kind: "session",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "session/closed",
        message: "Session stopped",
      };

      yield* runtime.emit(event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "session.exited");
      if (firstEvent.value.type !== "session.exited") {
        return;
      }
      assert.equal(firstEvent.value.threadId, "thread-1");
      assert.equal(firstEvent.value.payload.reason, "Session stopped");
    }),
  );

  it.effect("retires the active session when the Codex runtime exits", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-session-exited"),
        kind: "session",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "session/exited",
        message: "Codex App Server exited with code 1.",
      };

      yield* runtime.emit(event);
      const firstEvent = yield* Fiber.join(firstEventFiber);
      yield* Effect.yieldNow;

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "session.exited");
      assert.equal(yield* adapter.hasSession(asThreadId("thread-1")), false);
      assert.equal(runtime.closeImpl.mock.calls.length, 1);
    }),
  );

  it.effect("maps retryable Codex error notifications to a finite native retry observation", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-retryable-error"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "error",
        turnId: asTurnId("turn-1"),
        payload: {
          threadId: "provider-thread-1",
          turnId: "turn-1",
          error: {
            message: "Reconnecting... 2/5",
          },
          willRetry: true,
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "runtime.warning");
      if (firstEvent.value.type !== "runtime.warning") {
        return;
      }
      assert.equal(firstEvent.value.turnId, "turn-1");
      assert.deepEqual(firstEvent.value.payload, {
        message: "Provider reconnecting",
        detail: { willRetry: true },
        nativeRetry: { observedCount: 1, timing: "unknown" },
      });
      assert.match(encodeProviderJsonString(firstEvent.value.raw), /Reconnecting\.\.\. 2\/5/);
      assert.deepEqual(firstEvent.value.diagnostic?.summary, {
        version: 1,
        status: "retry",
        subject: { kind: "root" },
        observedRetryCount: 1,
      });
      assert.equal(firstEvent.value.diagnostic?.snapshot.native.threadId, "provider-thread-1");
      assert.equal(firstEvent.value.diagnostic?.snapshot.native.turnId, "turn-1");
      assert.equal(
        decodeDiagnosticMessageJsonString(firstEvent.value.diagnostic!.snapshot.json).error.message,
        "Reconnecting... 2/5",
      );
    }),
  );

  it.effect(
    "publishes cumulative root native retry observations while retaining guarded debug fractions",
    () =>
      Effect.gen(function* () {
        const { adapter, runtime } = yield* startLifecycleRuntime(retryTestRuntimeId);
        const resultFiber = yield* Stream.take(adapter.streamEvents, 3).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );
        for (const [index, fraction] of ["1/5", "2/5", "1/2"].entries()) {
          yield* runtime.emit({
            ...retryObservationFrame(`adapter-native-retry-${index}`, "provider-thread-1"),
            threadId: asThreadId("thread-1"),
            payload: {
              threadId: "provider-thread-1",
              turnId: "native-turn-1",
              willRetry: true,
              error: { message: `Reconnecting... ${fraction}`, codexErrorInfo: "serverOverloaded" },
            },
          });
        }
        const events = Array.from(yield* Fiber.join(resultFiber));
        assert.equal(events.length, 3);
        for (const [index, event] of events.entries()) {
          assert.equal(event.type, "runtime.warning");
          if (event.type !== "runtime.warning") continue;
          assert.deepEqual(event.payload, {
            message: "Provider reconnecting",
            detail: { willRetry: true },
            nativeRetry: { observedCount: index + 1, timing: "unknown" },
          });
          assert.doesNotMatch(
            encodeProviderJsonString(event.payload),
            /Reconnecting|1\/5|2\/5|1\/2/,
          );
          assert.match(encodeProviderJsonString(event.raw), /Reconnecting/);
        }
        assert.equal(runtime.sendTurnImpl.mock.calls.length, 0);
        assert.equal(runtime.steerTurnImpl.mock.calls.length, 0);
      }),
  );

  it.effect(
    "shows child retry observations separately and clears them on substantive activity or completion",
    () =>
      Effect.gen(function* () {
        const { adapter, runtime } = yield* startLifecycleRuntime(retryTestRuntimeId);
        const retry = (id: string): ProviderEvent => ({
          ...retryObservationFrame(id, "native-child", "child-turn", true),
          threadId: asThreadId("thread-1"),
        });
        const frames: ReadonlyArray<ProviderEvent> = [
          retry("child-first-retry"),
          {
            ...retry("child-name"),
            method: "codex.subagent/threadNameUpdated",
            payload: { threadId: "native-child", threadName: "Named child" },
          },
          {
            ...retry("child-real-progress"),
            method: "codex.subagent/itemCompleted",
            payload: {
              completedAtMs: Date.parse("2026-10-11T00:00:00.000Z"),
              threadId: "native-child",
              turnId: "child-turn",
              item: { type: "webSearch", id: "child-search", query: "synthetic", action: null },
            },
          },
          retry("child-second-retry"),
          {
            ...retryTurnFrame("child-turn", true, "native-child", true),
            threadId: asThreadId("thread-1"),
          },
        ];
        const resultFiber = yield* Stream.take(adapter.streamEvents, 7).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );
        for (const frame of frames) yield* runtime.emit(frame);
        const events = Array.from(yield* Fiber.join(resultFiber));
        const tasks = events.filter(
          (event) => event.type === "task.progress" || event.type === "task.completed",
        );
        assert.equal(tasks.length, 5);
        assert.deepEqual(
          tasks.map((event) => event.payload.subagent?.nativeRetry),
          [
            { observedCount: 1, timing: "unknown" },
            { observedCount: 1, timing: "unknown" },
            undefined,
            { observedCount: 2, timing: "unknown" },
            undefined,
          ],
        );
        assert.deepEqual(
          tasks.map((event) =>
            event.type === "task.progress" ? event.payload.description : undefined,
          ),
          [
            "Provider retry · 1",
            "Provider retry · 1",
            "Searched for synthetic",
            "Provider retry · 2",
            undefined,
          ],
        );
        assert.equal(tasks[1]?.payload.subagent?.label, "Named child");
        assert.equal(tasks[4]?.payload.subagent?.status, "failed");
        const warnings = events.filter((event) => event.type === "runtime.warning");
        assert.equal(warnings[1]?.diagnostic?.summary.subject.kind, "subagent");
        assert.equal(warnings[1]?.diagnostic?.summary.subject.label, "Named child");
        assert.equal(warnings[1]?.diagnostic?.summary.observedRetryCount, 2);
        assert.equal(tasks[1]?.diagnostic, undefined);
        assert.equal(runtime.sendTurnImpl.mock.calls.length, 0);
        assert.equal(runtime.steerTurnImpl.mock.calls.length, 0);
      }),
  );

  it.effect(
    "preserves Flex failure detail without treating it as a retryable transport error",
    () =>
      Effect.gen(function* () {
        const { adapter, runtime } = yield* startLifecycleRuntime();
        const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);
        // The new terminal classification must decode through the same typed
        // boundary as older failures. A rejected payload loses both its useful
        // message and willRetry semantics; the native terminal event must remain
        // authoritative rather than suggesting a fresh transport retry.
        yield* runtime.emit({
          id: asEventId("evt-flex-error"),
          kind: "notification",
          provider: ProviderDriverKind.make("codex"),
          threadId: asThreadId("thread-1"),
          createdAt: "2026-09-28T00:00:00.000Z",
          method: "error",
          turnId: asTurnId("turn-1"),
          payload: {
            threadId: "provider-thread-1",
            turnId: "turn-1",
            error: {
              message: "Flex capacity is temporarily unavailable",
              codexErrorInfo: "flexUnavailable",
              additionalDetails: null,
            },
            willRetry: false,
          },
        } satisfies ProviderEvent);

        const firstEvent = yield* Fiber.join(firstEventFiber);
        assert.equal(firstEvent._tag, "Some");
        if (firstEvent._tag !== "Some") return;
        assert.equal(firstEvent.value.type, "runtime.error");
        if (firstEvent.value.type !== "runtime.error") return;
        assert.equal(firstEvent.value.turnId, "turn-1");
        assert.equal(firstEvent.value.payload.class, "provider_error");
        assert.equal(firstEvent.value.payload.message, "Flex capacity is temporarily unavailable");
      }),
  );

  it.effect("retains a complete native error tuple in a minimal failed terminal echo", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime(retryTestRuntimeId);
      const eventsFiber = yield* Stream.take(adapter.streamEvents, 2).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );
      const error = {
        message: "Response stream interrupted",
        codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 503 } },
        additionalDetails: null,
      };
      const frame = {
        kind: "notification" as const,
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        subagentRuntimeId: retryTestRuntimeId,
        createdAt: "2026-10-12T00:00:00.000Z",
        turnId: asTurnId("turn-1"),
      };
      yield* runtime.emit({
        ...frame,
        id: asEventId("complete-error-tuple"),
        method: "error",
        payload: { threadId: "provider-thread-1", turnId: "turn-1", error, willRetry: false },
      });
      yield* runtime.emit({
        ...frame,
        id: asEventId("complete-terminal-echo"),
        method: "turn/completed",
        payload: {
          threadId: "provider-thread-1",
          turn: { id: "turn-1", status: "failed", error, items: [] },
        },
      });
      const events = yield* Fiber.join(eventsFiber);
      assert.deepEqual(
        events.map((event) => event.type),
        ["runtime.error", "turn.completed"],
      );
      const notification = events[0]!.diagnostic!.snapshot;
      const terminal = events[1]!.diagnostic!.snapshot;
      for (const snapshot of [notification, terminal]) {
        assert.equal(snapshot.redacted, false);
        assert.equal(snapshot.truncated, false);
        // Empty native item history removes no actual item bytes. This exact
        // envelope is complete enough for the private store's terminal echo
        // comparison; nonempty/unknown payload omissions remain ineligible.
        assert.equal(snapshot.omittedFields, false);
        assert.equal(snapshot.native.threadId, "provider-thread-1");
        assert.equal(snapshot.native.turnId, "turn-1");
        assert.equal(snapshot.native.subagentRuntimeId, retryTestRuntimeId);
      }
      assert.deepEqual(decodeProviderJsonString(notification.json).error, error);
      assert.deepEqual(decodeTerminalErrorJsonString(terminal.json).turn.error, error);
      assert.equal(runtime.sendTurnImpl.mock.calls.length, 0);
      assert.equal(runtime.steerTurnImpl.mock.calls.length, 0);
    }),
  );

  it.effect(
    "captures terminal-only failed-root diagnostics without copying turn items or credentials",
    () =>
      Effect.gen(function* () {
        const { adapter, runtime } = yield* startLifecycleRuntime();
        const eventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);
        yield* runtime.emit({
          id: asEventId("terminal-only-diagnostic"),
          kind: "notification",
          provider: ProviderDriverKind.make("codex"),
          threadId: asThreadId("thread-1"),
          createdAt: "2026-10-12T00:00:00.000Z",
          method: "turn/completed",
          turnId: asTurnId("turn-1"),
          payload: {
            threadId: "provider-thread-1",
            turn: {
              id: "turn-1",
              status: "failed",
              items: [],
              error: {
                message: "Request interrupted; request ID debug-request-123",
                codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 503 } },
                additionalDetails: "Cookie: first=private; second=private",
                extension: { api_key: "private", auth: { token: "private" }, code: "E_STREAM" },
              },
              prompt: "unrelated-private-prompt",
            },
          },
        });
        const event = yield* Fiber.join(eventFiber);
        assert.equal(event._tag, "Some");
        if (event._tag !== "Some") return;
        assert.equal(event.value.type, "turn.completed");
        if (event.value.type !== "turn.completed") return;
        assert.equal(event.value.payload.state, "failed");
        assert.deepEqual(event.value.diagnostic?.summary, {
          version: 1,
          status: "error",
          subject: { kind: "root" },
        });
        const snapshot = event.value.diagnostic!.snapshot;
        assert.equal(snapshot.native.turnId, "turn-1");
        assert.equal(snapshot.redacted, true);
        assert.equal(snapshot.omittedFields, true);
        assert.equal(snapshot.json.includes("private"), false);
        assert.equal(snapshot.json.includes("items"), false);
        assert.equal(snapshot.json.includes("debug-request-123"), true);
        assert.equal(snapshot.json.includes("E_STREAM"), true);
        assert.equal(runtime.sendTurnImpl.mock.calls.length, 0);
        assert.equal(runtime.steerTurnImpl.mock.calls.length, 0);
      }),
  );

  for (const willRetry of [false, true]) {
    it.effect(`preserves the provider's tooManyDenials willRetry=${willRetry} decision`, () =>
      Effect.gen(function* () {
        const { adapter, runtime } = yield* startLifecycleRuntime();
        const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);
        // Denial exhaustion is a provider failure, not permission to replay a
        // turn or bypass approvals. Only Codex's explicit willRetry flag decides
        // whether this notification is a warning while its existing turn runs.
        yield* runtime.emit({
          id: asEventId("evt-denials-error"),
          kind: "notification",
          provider: ProviderDriverKind.make("codex"),
          threadId: asThreadId("thread-1"),
          createdAt: "2026-09-29T00:00:00.000Z",
          method: "error",
          turnId: asTurnId("turn-1"),
          payload: {
            threadId: "provider-thread-1",
            turnId: "turn-1",
            error: {
              message: "Too many tool calls were denied",
              codexErrorInfo: "tooManyDenials",
              additionalDetails: null,
            },
            willRetry,
          },
        } satisfies ProviderEvent);

        const firstEvent = yield* Fiber.join(firstEventFiber);
        assert.equal(firstEvent._tag, "Some");
        if (firstEvent._tag !== "Some") return;
        assert.equal(firstEvent.value.type, willRetry ? "runtime.warning" : "runtime.error");
        if (
          firstEvent.value.type !== "runtime.warning" &&
          firstEvent.value.type !== "runtime.error"
        )
          return;
        assert.equal(firstEvent.value.turnId, "turn-1");
        assert.equal(
          firstEvent.value.payload.message,
          willRetry ? "Provider reconnecting" : "Too many tool calls were denied",
        );
        if (firstEvent.value.type === "runtime.error") {
          assert.equal(firstEvent.value.payload.class, "provider_error");
        }
        assert.equal(runtime.sendTurnImpl.mock.calls.length, 0);
        assert.equal(runtime.steerTurnImpl.mock.calls.length, 0);
        assert.equal(runtime.respondToRequestImpl.mock.calls.length, 0);
      }),
    );
  }

  it.effect(
    "publishes one qualified failed child task without a duplicate parent-clock warning",
    () =>
      Effect.gen(function* () {
        const { adapter, runtime } = yield* startLifecycleRuntime();
        const eventsFiber = yield* Stream.take(adapter.streamEvents, 2).pipe(
          Stream.runCollect,
          Effect.forkChild,
        );

        yield* runtime.emit({
          id: asEventId("evt-subagent-capacity-error"),
          kind: "notification",
          provider: ProviderDriverKind.make("codex"),
          threadId: asThreadId("thread-1"),
          createdAt: "2026-01-01T00:00:00.000Z",
          method: "codex.subagent/error",
          turnId: asTurnId("turn-parent"),
          payload: {
            threadId: "provider-child-thread",
            turnId: "provider-child-turn",
            error: {
              message: "Selected model is at capacity. Please try a different model.",
              codexErrorInfo: "serverOverloaded",
              additionalDetails: null,
            },
            willRetry: false,
          },
        } satisfies ProviderEvent);
        // An explicit following envelope proves the child produced exactly one
        // event, without waiting for silence or changing any test deadline.
        yield* runtime.emit({
          id: asEventId("terminal-child-boundary"),
          kind: "notification",
          provider: ProviderDriverKind.make("codex"),
          threadId: asThreadId("thread-1"),
          createdAt: "2026-01-01T00:00:01.000Z",
          method: "warning",
          payload: { message: "Terminal child fixture boundary" },
        });
        const events = Array.from(yield* Fiber.join(eventsFiber));
        assert.equal(events.length, 2);
        const child = events[0];
        assert.equal(child?.type, "task.completed");
        if (child?.type !== "task.completed") return;
        assert.equal(child.turnId, "turn-parent");
        assert.equal(child.payload.subagent?.threadId, "provider-child-thread");
        assert.equal(child.payload.subagent?.status, "failed");
        assert.equal(
          child.payload.summary,
          "Selected model is at capacity. Please try a different model.",
        );
        assert.deepEqual(child.raw?.payload, {
          source: "codex.child.error",
          willRetry: false,
          childThreadIdHash: crypto
            .createHash("sha256")
            .update("provider-child-thread")
            .digest("hex"),
        });
        assert.deepEqual(child.diagnostic?.summary, {
          version: 1,
          status: "error",
          subject: { kind: "subagent", id: "provider-child-thread" },
        });
        assert.equal(child.diagnostic?.snapshot.native.turnId, "provider-child-turn");
        assert.equal(child.diagnostic?.snapshot.native.threadId, "provider-child-thread");
        const boundary = events[1];
        assert.equal(boundary?.eventId, "terminal-child-boundary");
        assert.equal(boundary?.type, "runtime.warning");
        if (boundary?.type === "runtime.warning")
          assert.equal(boundary.payload.message, "Terminal child fixture boundary");
        assert.equal(runtime.sendTurnImpl.mock.calls.length, 0);
        assert.equal(runtime.steerTurnImpl.mock.calls.length, 0);
      }),
  );

  it.effect(
    "retains a bounded child warning fallback when malformed payload has no qualified child identity",
    () =>
      Effect.gen(function* () {
        const { adapter, runtime } = yield* startLifecycleRuntime();
        const resultFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);
        yield* runtime.emit({
          id: asEventId("unqualified-child-terminal"),
          kind: "notification",
          provider: ProviderDriverKind.make("codex"),
          threadId: asThreadId("thread-1"),
          turnId: asTurnId("parent-turn"),
          createdAt: "2026-01-01T00:00:00.000Z",
          method: "codex.subagent/error",
          message: "Unqualified child failure",
          payload: { willRetry: false, error: { message: "Native child failure" } },
        });
        const event = yield* Fiber.join(resultFiber);
        assert.equal(event._tag, "Some");
        if (event._tag !== "Some") return;
        assert.equal(event.value.type, "runtime.warning");
        if (event.value.type !== "runtime.warning") return;
        assert.equal(event.value.turnId, "parent-turn");
        assert.equal(event.value.payload.message, "Unqualified child failure");
        assert.equal(event.value.payload.nativeRetry, undefined);
        assert.deepEqual(event.value.diagnostic?.summary.subject, { kind: "unknown" });
        assert.deepEqual(event.value.raw?.payload, {
          source: "codex.child.error",
          willRetry: false,
          childThreadIdHash: null,
        });
      }),
  );

  it.effect("maps Codex warning notifications to runtime.warning", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-warning"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "warning",
        turnId: asTurnId("turn-1"),
        payload: {
          message: "Codex runtime is retrying a transient provider transport failure.",
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "runtime.warning");
      if (firstEvent.value.type !== "runtime.warning") {
        return;
      }
      assert.equal(firstEvent.value.turnId, "turn-1");
      assert.equal(
        firstEvent.value.payload.message,
        "Codex runtime is retrying a transient provider transport failure.",
      );
    }),
  );

  it.effect("maps process stderr notifications to runtime.warning", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-process-stderr"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "process/stderr",
        turnId: asTurnId("turn-1"),
        message: "The filename or extension is too long. (os error 206)",
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "runtime.warning");
      if (firstEvent.value.type !== "runtime.warning") {
        return;
      }
      assert.equal(firstEvent.value.turnId, "turn-1");
      assert.equal(
        firstEvent.value.payload.message,
        "The filename or extension is too long. (os error 206)",
      );
    }),
  );

  it.effect("maps Codex turn-start event starvation diagnostics to runtime.warning", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-turn-start-no-event"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "codex.turnStart/noRuntimeEventYet",
        turnId: asTurnId("turn-1"),
        message: "Codex app-server accepted turn/start but has not emitted a turn event yet.",
        payload: {
          providerThreadId: "provider-thread-1",
          ackLatencyMs: 4,
          firstNotificationMethod: null,
          firstTurnEventMethod: null,
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "runtime.warning");
      if (firstEvent.value.type !== "runtime.warning") {
        return;
      }
      assert.equal(firstEvent.value.turnId, "turn-1");
      assert.equal(
        firstEvent.value.payload.message,
        "Codex app-server accepted turn/start but has not emitted a turn event yet.",
      );
      assert.deepEqual(firstEvent.value.payload.detail, {
        providerThreadId: "provider-thread-1",
        ackLatencyMs: 4,
        firstNotificationMethod: null,
        firstTurnEventMethod: null,
      });
    }),
  );

  it.effect("maps Codex active-turn snapshot polling diagnostics to runtime.warning", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-turn-still-in-progress"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "codex.turnProgress/stillInProgressAfterSnapshotPolling",
        turnId: asTurnId("turn-1"),
        message:
          "Codex still reports the active turn as in progress after delayed snapshot polling.",
        payload: {
          providerThreadId: "provider-thread-1",
          reason: "turn-steer-follow-up",
          elapsedDelay: "300 seconds",
          threadStatus: "active",
          itemCount: 4,
          itemSummary: {
            agentMessageCount: 1,
            commandExecutionInProgressCount: 0,
            commandExecutionTerminalCount: 1,
            collabAgentInProgressCount: 0,
            dynamicToolInProgressCount: 0,
            mcpToolInProgressCount: 0,
            lastItemId: "message-1",
            lastItemStatus: null,
            lastItemType: "agentMessage",
          },
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "runtime.warning");
      if (firstEvent.value.type !== "runtime.warning") {
        return;
      }
      assert.equal(firstEvent.value.turnId, "turn-1");
      assert.equal(
        firstEvent.value.payload.message,
        "Codex still reports the active turn as in progress after delayed snapshot polling.",
      );
      assert.deepEqual(firstEvent.value.payload.detail, {
        providerThreadId: "provider-thread-1",
        reason: "turn-steer-follow-up",
        elapsedDelay: "300 seconds",
        threadStatus: "active",
        itemCount: 4,
        itemSummary: {
          agentMessageCount: 1,
          commandExecutionInProgressCount: 0,
          commandExecutionTerminalCount: 1,
          collabAgentInProgressCount: 0,
          dynamicToolInProgressCount: 0,
          mcpToolInProgressCount: 0,
          lastItemId: "message-1",
          lastItemStatus: null,
          lastItemType: "agentMessage",
        },
      });
    }),
  );

  it.effect("maps Codex turn-start acceptance diagnostics to task progress", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-turn-start-accepted"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "codex.turnStart/accepted",
        turnId: asTurnId("turn-1"),
        message: "Codex app-server accepted turn/start.",
        payload: {
          providerThreadId: "provider-thread-1",
          ackLatencyMs: 4,
          semantics:
            "turn/start is an acknowledgement; turn/started must arrive later from the app-server listener.",
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "task.progress");
      if (firstEvent.value.type !== "task.progress") {
        return;
      }
      assert.equal(firstEvent.value.turnId, "turn-1");
      assert.equal(firstEvent.value.payload.taskId, "codex-turn-start:turn-1");
      assert.equal(firstEvent.value.payload.description, "Codex app-server accepted turn/start.");
      assert.deepEqual(firstEvent.value.payload.usage, {
        providerThreadId: "provider-thread-1",
        ackLatencyMs: 4,
        semantics:
          "turn/start is an acknowledgement; turn/started must arrive later from the app-server listener.",
      });
    }),
  );

  it.effect("strips raw Cafe message identity from Codex steer task diagnostics", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);
      const messageId = decodeMessageId(`message-\u0000-\u202e-${"x".repeat(600)}-tail`);
      const clientCorrelationId = buildCodexSteerClientCorrelationId(messageId);

      yield* runtime.emit({
        id: asEventId("evt-turn-steer-accepted"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "codex.turnSteer/accepted",
        turnId: asTurnId("turn-1"),
        message: "Codex app-server accepted turn/steer.",
        payload: {
          messageId,
          clientCorrelationId,
          providerThreadId: "provider-thread-1",
          expectedTurnId: "turn-1",
          ackLatencyMs: 3,
          semantics:
            "turn/steer appends input to the active turn and does not emit a new turn/started notification.",
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "task.progress");
      if (firstEvent.value.type !== "task.progress") {
        return;
      }
      assert.equal(firstEvent.value.turnId, "turn-1");
      assert.equal(firstEvent.value.payload.taskId, `codex-turn-steer:${clientCorrelationId}`);
      assert.equal(Buffer.byteLength(firstEvent.value.payload.taskId, "utf8") < 128, true);
      assert.equal(/[\p{Cc}\p{Cf}\p{Cs}]/u.test(firstEvent.value.payload.taskId), false);
      assert.equal(firstEvent.value.payload.taskId.includes("x".repeat(64)), false);
      assert.equal(firstEvent.value.payload.description, "Codex app-server accepted turn/steer.");
      assert.deepEqual(firstEvent.value.payload.usage, {
        clientCorrelationId,
        providerThreadId: "provider-thread-1",
        expectedTurnId: "turn-1",
        ackLatencyMs: 3,
        semantics:
          "turn/steer appends input to the active turn and does not emit a new turn/started notification.",
      });
      const serializedEvent = encodeProviderJsonString(firstEvent.value);
      assert.equal(serializedEvent.includes('"messageId"'), false);
      assert.equal(serializedEvent.includes("x".repeat(600)), false);
    }),
  );

  it.effect("maps slow Codex turn-steer processing diagnostics to runtime warnings", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);
      const clientCorrelationId = buildCodexSteerClientCorrelationId("message-1");

      yield* runtime.emit({
        id: asEventId("evt-turn-steer-waiting"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "codex.turnSteer/noProviderItemYet",
        turnId: asTurnId("turn-1"),
        message:
          "Codex app-server accepted turn/steer but has not emitted the steer user message yet.",
        payload: {
          steerId: "steer-1",
          messageId: "message-1",
          clientCorrelationId,
          providerThreadId: "provider-thread-1",
          elapsedDelay: "60 seconds",
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "runtime.warning");
      if (firstEvent.value.type !== "runtime.warning") {
        return;
      }
      assert.equal(
        firstEvent.value.payload.message,
        "Codex app-server accepted turn/steer but has not emitted the steer user message yet.",
      );
      assert.deepEqual(firstEvent.value.payload.detail, {
        steerId: "steer-1",
        clientCorrelationId,
        providerThreadId: "provider-thread-1",
        elapsedDelay: "60 seconds",
      });
      assert.equal(encodeProviderJsonString(firstEvent.value).includes('"messageId"'), false);
    }),
  );

  it.effect("maps Codex turn-steer processing-start diagnostics to task progress", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);
      const clientCorrelationId = buildCodexSteerClientCorrelationId("message-1");

      yield* runtime.emit({
        id: asEventId("evt-turn-steer-processing"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "codex.turnSteer/processingStarted",
        turnId: asTurnId("turn-1"),
        message: "Codex app-server began processing turn/steer.",
        payload: {
          steerId: "steer-1",
          messageId: "message-1",
          clientCorrelationId,
          providerThreadId: "provider-thread-1",
          ackToProviderItemMs: 167_000,
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "task.progress");
      if (firstEvent.value.type !== "task.progress") {
        return;
      }
      assert.equal(
        firstEvent.value.payload.taskId,
        `codex-turn-steer-processing:${clientCorrelationId}`,
      );
      assert.equal(
        firstEvent.value.payload.description,
        "Codex app-server began processing turn/steer.",
      );
      assert.deepEqual(firstEvent.value.payload.usage, {
        steerId: "steer-1",
        clientCorrelationId,
        providerThreadId: "provider-thread-1",
        ackToProviderItemMs: 167_000,
      });
      assert.equal(encodeProviderJsonString(firstEvent.value).includes('"messageId"'), false);
    }),
  );

  it.effect("maps restart-recovered Codex steer processing to token-correlated progress", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);
      const clientCorrelationId = buildCodexSteerClientCorrelationId("message-after-restart");

      yield* runtime.emit({
        id: asEventId("evt-turn-steer-processing-after-restart"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "codex.turnSteer/processingObserved",
        turnId: asTurnId("turn-1"),
        message: "Codex app-server observed the correlated user message after recovery.",
        payload: {
          clientCorrelationId,
          providerThreadId: "provider-thread-1",
          providerUserMessageItemId: "item-after-restart",
          observedAt: "2026-01-01T00:00:00.000Z",
          semantics: "The provider echo is gated by independently persisted acceptance evidence.",
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") return;
      assert.equal(firstEvent.value.type, "task.progress");
      if (firstEvent.value.type !== "task.progress") return;
      assert.equal(
        firstEvent.value.payload.taskId,
        `codex-turn-steer-processing:${clientCorrelationId}`,
      );
      assert.equal(
        firstEvent.value.payload.description,
        "Codex app-server observed the correlated user message after recovery.",
      );
      assert.deepStrictEqual(firstEvent.value.payload.usage, {
        clientCorrelationId,
        providerThreadId: "provider-thread-1",
        providerUserMessageItemId: "item-after-restart",
        observedAt: "2026-01-01T00:00:00.000Z",
        semantics: "The provider echo is gated by independently persisted acceptance evidence.",
      });
    }),
  );

  it.effect("maps Codex turn-steer active-turn mismatch retry diagnostics to task progress", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-turn-steer-retry"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "codex.turnSteer/retryAfterActiveTurnMismatch",
        turnId: asTurnId("turn-new"),
        message:
          "Codex app-server reported a newer active turn; Cafe Code retried turn/steer with that turn id.",
        payload: {
          providerThreadId: "provider-thread-1",
          requestedExpectedTurnId: "turn-old",
          actualTurnId: "turn-new",
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "task.progress");
      if (firstEvent.value.type !== "task.progress") {
        return;
      }
      assert.equal(firstEvent.value.payload.taskId, "codex-turn-steer-retry:turn-new");
      assert.equal(
        firstEvent.value.payload.description,
        "Codex app-server reported a newer active turn; Cafe Code retried turn/steer with that turn id.",
      );
      assert.deepEqual(firstEvent.value.payload.usage, {
        providerThreadId: "provider-thread-1",
        requestedExpectedTurnId: "turn-old",
        actualTurnId: "turn-new",
      });
    }),
  );

  it.effect("maps realtime started notifications with upstream realtime session ids", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-realtime-started"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "thread/realtime/started",
        payload: {
          threadId: "thread-1",
          realtimeSessionId: "realtime-session-1",
          version: "v2",
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "thread.realtime.started");
      if (firstEvent.value.type !== "thread.realtime.started") {
        return;
      }
      assert.equal(firstEvent.value.threadId, "thread-1");
      assert.equal(firstEvent.value.payload.realtimeSessionId, "realtime-session-1");
    }),
  );

  it.effect("drops duplicate websocket stderr diagnostics but keeps generic stderr warnings", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-process-stderr-websocket"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "process/stderr",
        turnId: asTurnId("turn-1"),
        message:
          "2026-03-31T18:14:06.833399Z ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: HTTP error: 503 Service Unavailable, url: wss://chatgpt.com/backend-api/codex/responses",
      } satisfies ProviderEvent);
      yield* runtime.emit({
        id: asEventId("evt-process-stderr-generic"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.001Z",
        method: "process/stderr",
        turnId: asTurnId("turn-1"),
        message: "warning: normal stderr diagnostic",
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "runtime.warning");
      if (firstEvent.value.type !== "runtime.warning") {
        return;
      }
      assert.equal(firstEvent.value.turnId, "turn-1");
      assert.equal(firstEvent.value.payload.message, "warning: normal stderr diagnostic");
    }),
  );

  it.effect("maps terminal-input approvals without retaining command or stdin context", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-terminal-input-approval"),
        kind: "request",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "item/commandExecution/requestApproval",
        requestKind: "terminal-input",
        requestId: ApprovalRequestId.make("stdin-approval-1"),
        payload: {
          approvalId: "stdin-approval-1",
          command: "secret-running-command --token hidden",
          cwd: "/private/terminal/cwd",
          itemId: "command-item-1",
          kind: "writeStdin",
          reason: "Allow input to the running terminal",
          startedAtMs: 1_767_225_600_000,
          threadId: "provider-thread-1",
          turnId: "turn-1",
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);
      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some" || firstEvent.value.type !== "request.opened") {
        return;
      }
      assert.equal(firstEvent.value.payload.requestType, "terminal_input_approval");
      assert.equal(firstEvent.value.payload.detail, "Allow input to the running terminal");
      assert.equal(firstEvent.value.payload.args, undefined);
      assert.deepStrictEqual(firstEvent.value.raw?.payload, {
        redacted: true,
        reason: "terminal-input-approval-provider-content",
        kind: "writeStdin",
        approvalIdPresent: true,
        commandContextPresent: true,
        cwdPresent: true,
        reasonPresent: true,
      });
      assert.doesNotMatch(
        encodeProviderJsonString(firstEvent.value.raw),
        /secret-running-command|private\/terminal|token hidden/,
      );
    }),
  );

  it.effect("preserves request type when mapping serverRequest/resolved", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-request-resolved"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "serverRequest/resolved",
        requestKind: "command",
        requestId: ApprovalRequestId.make("req-1"),
        payload: {
          threadId: "thread-1",
          requestId: "req-1",
        },
      };

      yield* runtime.emit(event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "request.resolved");
      if (firstEvent.value.type !== "request.resolved") {
        return;
      }
      assert.equal(firstEvent.value.payload.requestType, "command_execution_approval");
    }),
  );

  it.effect("preserves file-read request type when mapping serverRequest/resolved", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-file-read-request-resolved"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "serverRequest/resolved",
        requestKind: "file-read",
        requestId: ApprovalRequestId.make("req-file-read-1"),
        payload: {
          threadId: "thread-1",
          requestId: "req-file-read-1",
        },
      };

      yield* runtime.emit(event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "request.resolved");
      if (firstEvent.value.type !== "request.resolved") {
        return;
      }
      assert.equal(firstEvent.value.payload.requestType, "file_read_approval");
    }),
  );

  it.effect("preserves explicit empty multi-select user-input answers", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const event: ProviderEvent = {
        id: asEventId("evt-user-input-empty"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "item/tool/requestUserInput/answered",
        payload: {
          answers: {
            scope: {
              answers: [],
            },
          },
        },
      };

      yield* runtime.emit(event);
      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "user-input.resolved");
      if (firstEvent.value.type !== "user-input.resolved") {
        return;
      }
      assert.deepEqual(firstEvent.value.payload.answers, {
        scope: [],
      });
    }),
  );

  it.effect("maps windowsSandbox/setupCompleted to session state and warning on failure", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 2)).pipe(
        Effect.forkChild,
      );

      const event: ProviderEvent = {
        id: asEventId("evt-windows-sandbox-failed"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "windowsSandbox/setupCompleted",
        message: "Sandbox setup failed",
        payload: {
          mode: "unelevated",
          success: false,
          error: "unsupported environment",
        },
      };

      yield* runtime.emit(event);
      const events = Array.from(yield* Fiber.join(eventsFiber));

      assert.equal(events.length, 2);

      const firstEvent = events[0];
      const secondEvent = events[1];

      assert.equal(firstEvent?.type, "session.state.changed");
      if (firstEvent?.type === "session.state.changed") {
        assert.equal(firstEvent.payload.state, "error");
        assert.equal(firstEvent.payload.reason, "Sandbox setup failed");
      }

      assert.equal(secondEvent?.type, "runtime.warning");
      if (secondEvent?.type === "runtime.warning") {
        assert.equal(secondEvent.payload.message, "Sandbox setup failed");
      }
    }),
  );

  it.effect(
    "maps requestUserInput requests and answered notifications to canonical user-input events",
    () =>
      Effect.gen(function* () {
        const { adapter, runtime } = yield* startLifecycleRuntime();
        const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 2)).pipe(
          Effect.forkChild,
        );

        yield* runtime.emit({
          id: asEventId("evt-user-input-requested"),
          kind: "request",
          provider: ProviderDriverKind.make("codex"),
          threadId: asThreadId("thread-1"),
          createdAt: "2026-01-01T00:00:00.000Z",
          method: "item/tool/requestUserInput",
          requestId: ApprovalRequestId.make("req-user-input-1"),
          payload: {
            itemId: "item-user-input-1",
            threadId: "thread-1",
            turnId: "turn-1",
            isBlocking: false,
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
        } satisfies ProviderEvent);
        yield* runtime.emit({
          id: asEventId("evt-user-input-resolved"),
          kind: "notification",
          provider: ProviderDriverKind.make("codex"),
          threadId: asThreadId("thread-1"),
          createdAt: "2026-01-01T00:00:00.000Z",
          method: "item/tool/requestUserInput/answered",
          requestId: ApprovalRequestId.make("req-user-input-1"),
          payload: {
            answers: {
              sandbox_mode: {
                answers: ["workspace-write"],
              },
            },
            autoResolved: true,
          },
        } satisfies ProviderEvent);

        const events = Array.from(yield* Fiber.join(eventsFiber));
        assert.equal(events[0]?.type, "user-input.requested");
        if (events[0]?.type === "user-input.requested") {
          assert.equal(events[0].requestId, "req-user-input-1");
          assert.equal(events[0].payload.questions[0]?.id, "sandbox_mode");
          assert.equal(events[0].payload.questions[0]?.multiSelect, false);
          assert.equal(events[0].payload.isBlocking, false);
        }

        assert.equal(events[1]?.type, "user-input.resolved");
        if (events[1]?.type === "user-input.resolved") {
          assert.equal(events[1].requestId, "req-user-input-1");
          assert.equal(events[1].payload.autoResolved, true);
          assert.deepEqual(events[1].payload.answers, {
            sandbox_mode: "workspace-write",
          });
        }
      }),
  );

  it.effect("maps child accounting to its durable lane without publishing root context usage", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);
      const accounting = {
        scopeId: "12345678-1234-4234-8234-123456789abc",
        revision: 2,
        completeness: "partial",
        models: [
          {
            model: "gpt-6.1-sol",
            inputTokens: 100,
            cachedInputTokens: 40,
            cacheWriteInputTokens: 10,
            outputTokens: 20,
            reasoningOutputTokens: 5,
          },
        ],
      };
      yield* runtime.emit({
        id: asEventId("evt-child-accounting"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "cafecode/childUsageAccounting",
        payload: accounting,
      } satisfies ProviderEvent);
      const first = yield* Fiber.join(firstEventFiber);
      assert.equal(first._tag, "Some");
      if (first._tag !== "Some") return;
      assert.equal(first.value.type, "thread.usage-accounting.updated");
      assert.deepEqual(first.value.payload, accounting);
      assert.deepEqual(first.value.raw?.payload, { kind: "child-usage" });
      assert.equal(first.value.threadId, "thread-1");
    }),
  );

  it.effect("unwraps Codex token usage payloads for context window events", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-codex-thread-token-usage-updated"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "thread/tokenUsage/updated",
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          tokenUsage: {
            total: {
              inputTokens: 11_833,
              cachedInputTokens: 3456,
              cacheWriteInputTokens: 77,
              outputTokens: 6,
              reasoningOutputTokens: 0,
              totalTokens: 11_839,
            },
            last: {
              inputTokens: 120,
              cachedInputTokens: 0,
              cacheWriteInputTokens: 12,
              outputTokens: 6,
              reasoningOutputTokens: 0,
              totalTokens: 126,
            },
            modelContextWindow: 258_400,
          },
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);
      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "thread.token-usage.updated");
      if (firstEvent.value.type !== "thread.token-usage.updated") {
        return;
      }

      assert.deepEqual(firstEvent.value.payload.usage, {
        usedTokens: 126,
        totalProcessedTokens: 11_839,
        totalOutputTokens: 6,
        maxTokens: 258_400,
        inputTokens: 120,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 12,
        totalCacheWriteInputTokens: 77,
        // Cumulative input counters are forwarded now: the per-request `last`
        // values cannot be summed, so usage accounting needs these.
        totalInputTokens: 11_833,
        totalCachedInputTokens: 3456,
        totalReasoningOutputTokens: 0,
        outputTokens: 6,
        reasoningOutputTokens: 0,
        lastUsedTokens: 126,
        lastInputTokens: 120,
        lastCachedInputTokens: 0,
        lastCacheWriteInputTokens: 12,
        lastOutputTokens: 6,
        lastReasoningOutputTokens: 0,
        compactsAutomatically: true,
      });
    }),
  );

  it.effect("pairs the runtime-timed interval with the last response's output tokens", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 3)).pipe(
        Effect.forkChild,
      );
      const usageNotification = (
        id: string,
        lastOutputTokens: number,
        responseGenerationMs?: number,
      ) =>
        ({
          id: asEventId(id),
          kind: "notification",
          provider: ProviderDriverKind.make("codex"),
          threadId: asThreadId("thread-1"),
          turnId: asTurnId("turn-1"),
          createdAt: "2026-01-01T00:00:00.000Z",
          method: "thread/tokenUsage/updated",
          ...(responseGenerationMs !== undefined ? { responseGenerationMs } : {}),
          payload: {
            threadId: "thread-1",
            turnId: "turn-1",
            tokenUsage: {
              total: {
                inputTokens: 900,
                cachedInputTokens: 0,
                outputTokens: 1_200,
                reasoningOutputTokens: 0,
                totalTokens: 2_100,
              },
              last: {
                inputTokens: 500,
                cachedInputTokens: 0,
                outputTokens: lastOutputTokens,
                reasoningOutputTokens: 0,
                totalTokens: 900,
              },
              modelContextWindow: 258_400,
            },
          },
        }) satisfies ProviderEvent;

      yield* runtime.emit(usageNotification("evt-timed", 400, 5_000));
      // No owner-authored interval: the payload alone is never a measurement.
      yield* runtime.emit(usageNotification("evt-untimed", 400));
      // An interval implying an implausible rate is dropped, not displayed.
      yield* runtime.emit(usageNotification("evt-implausible", 400, 50));

      const samples = Array.from(yield* Fiber.join(eventsFiber)).map((event) =>
        event.type === "thread.token-usage.updated"
          ? event.payload.usage.responseGeneration
          : event.type,
      );
      assert.deepEqual(samples, [{ outputTokens: 400, durationMs: 5_000 }, undefined, undefined]);
    }),
  );

  it.effect("terminalizes Codex auth recovery without retaining provider-authored content", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 2)).pipe(
        Effect.forkChild,
      );

      yield* runtime.emit({
        id: asEventId("evt-auth-recovery-started"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-auth-recovery"),
        createdAt: "2026-09-01T00:00:00.000Z",
        method: "modelProvider/authRecoveryStarted",
        payload: {
          threadId: "provider-thread-secret",
          turnId: "provider-turn-secret",
          provider: "provider-account-secret",
          message: "provider-authored-secret-start-message",
        },
      } satisfies ProviderEvent);
      yield* runtime.emit({
        id: asEventId("evt-auth-recovery-completed"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-auth-recovery"),
        createdAt: "2026-09-01T00:00:01.000Z",
        method: "modelProvider/authRecoveryCompleted",
        payload: {
          threadId: "provider-thread-secret",
          turnId: "provider-turn-secret",
          provider: "provider-account-secret",
          message: "provider-authored-secret-complete-message",
        },
      } satisfies ProviderEvent);

      const events = Array.from(yield* Fiber.join(eventsFiber));
      assert.deepStrictEqual(
        events.map((event) => event.type),
        ["task.started", "task.completed"],
      );
      const taskId = authRecoveryTaskIdForTest("provider-thread-secret", "provider-turn-secret");
      assert.match(taskId, /^codex-auth-recovery-sha256:[0-9a-f]{64}$/u);
      assert.equal(
        events[0]?.type === "task.started" ? events[0].payload.taskId : undefined,
        taskId,
      );
      assert.equal(
        events[0]?.type === "task.started" ? events[0].payload.description : undefined,
        "Codex is refreshing model-provider credentials.",
      );
      assert.equal(
        events[1]?.type === "task.completed" ? events[1].payload.taskId : undefined,
        taskId,
      );
      assert.equal(
        events[1]?.type === "task.completed" ? events[1].payload.status : undefined,
        "completed",
      );
      assert.equal(
        events[1]?.type === "task.completed" ? events[1].payload.summary : undefined,
        "Codex refreshed model-provider credentials.",
      );
      assert.equal(
        events[1]?.type === "task.completed" ? events[1].payload.usage : undefined,
        undefined,
      );
      assert.deepStrictEqual(events[0]?.raw?.payload, {
        redacted: true,
        reason: "model-provider-auth-recovery-content",
        phase: "started",
      });
      assert.deepStrictEqual(events[1]?.raw?.payload, {
        redacted: true,
        reason: "model-provider-auth-recovery-content",
        phase: "completed",
      });
      assert.equal(events[0]?.providerRefs, undefined);
      assert.equal(events[1]?.providerRefs, undefined);
      assert.doesNotMatch(
        encodeProviderJsonString(events),
        /provider-(?:account|authored|thread|turn)-secret/,
      );
    }),
  );

  it.effect("stops active auth recovery before explicit adapter retirement", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const startedFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      yield* runtime.emit({
        id: asEventId("evt-auth-adapter-stop-start"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-parent"),
        createdAt: "2026-09-01T00:00:00.000Z",
        method: "modelProvider/authRecoveryStarted",
        payload: {
          threadId: "provider-adapter-stop-thread-secret",
          turnId: "provider-adapter-stop-turn-secret",
          provider: "provider-adapter-stop-account-secret",
          message: "provider-adapter-stop-message-secret",
        },
      } satisfies ProviderEvent);

      const started = yield* Fiber.join(startedFiber);
      assert.equal(started._tag, "Some");
      if (started._tag !== "Some" || started.value.type !== "task.started") {
        return assert.fail("expected an auth recovery task start before adapter stop");
      }
      const terminalFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);
      yield* adapter.stopSession(asThreadId("thread-1"));
      const terminal = yield* Fiber.join(terminalFiber);
      assert.equal(terminal._tag, "Some");
      if (terminal._tag !== "Some" || terminal.value.type !== "task.completed") {
        return assert.fail("expected an auth recovery task terminal before adapter stop");
      }
      assert.equal(terminal.value.payload.status, "stopped");
      assert.equal(terminal.value.turnId, started.value.turnId);
      assert.equal(terminal.value.turnId, asTurnId("turn-parent"));
      assert.equal(terminal.value.payload.usage, undefined);
      assert.deepStrictEqual(terminal.value.raw?.payload, {
        redacted: true,
        reason: "model-provider-auth-recovery-terminalized",
        terminal: "session-exit",
        status: "stopped",
      });
      assert.equal(terminal.value.providerRefs, undefined);
      assert.doesNotMatch(encodeProviderJsonString(terminal.value), /provider-adapter-stop-/u);
    }),
  );

  it.effect("keeps auth recovery task ids distinct when child turns reuse an id", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 4)).pipe(
        Effect.forkChild,
      );

      for (const [index, providerThreadId] of ["provider-child-a", "provider-child-b"].entries()) {
        yield* runtime.emit({
          id: asEventId(`evt-auth-collision-start-${index}`),
          kind: "notification",
          provider: ProviderDriverKind.make("codex"),
          threadId: asThreadId("thread-1"),
          turnId: asTurnId("turn-parent"),
          createdAt: `2026-09-01T00:00:0${index}.000Z`,
          method: "modelProvider/authRecoveryStarted",
          payload: {
            threadId: providerThreadId,
            turnId: "provider-reused-turn-id",
            provider: `provider-account-${index}`,
            message: `provider-message-${index}`,
          },
        } satisfies ProviderEvent);
        yield* runtime.emit({
          id: asEventId(`evt-auth-collision-complete-${index}`),
          kind: "notification",
          provider: ProviderDriverKind.make("codex"),
          threadId: asThreadId("thread-1"),
          turnId: asTurnId("turn-parent"),
          createdAt: `2026-09-01T00:00:1${index}.000Z`,
          method: "modelProvider/authRecoveryCompleted",
          payload: {
            threadId: providerThreadId,
            turnId: "provider-reused-turn-id",
            provider: `provider-account-${index}`,
            message: `provider-message-${index}`,
          },
        } satisfies ProviderEvent);
      }

      const events = Array.from(yield* Fiber.join(eventsFiber));
      const firstTaskId = authRecoveryTaskIdForTest("provider-child-a", "provider-reused-turn-id");
      const secondTaskId = authRecoveryTaskIdForTest("provider-child-b", "provider-reused-turn-id");
      assert.notEqual(firstTaskId, secondTaskId);
      assert.deepStrictEqual(
        events.map((event) =>
          event.type === "task.started" ||
          event.type === "task.progress" ||
          event.type === "task.completed"
            ? event.payload.taskId
            : undefined,
        ),
        [firstTaskId, firstTaskId, secondTaskId, secondTaskId],
      );
      assert.doesNotMatch(
        encodeProviderJsonString(events),
        /provider-(?:child|reused|account|message)/u,
      );
    }),
  );

  it.effect("fails active auth recovery when the owning turn errors", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 3)).pipe(
        Effect.forkChild,
      );

      yield* runtime.emit({
        id: asEventId("evt-auth-error-start"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-parent"),
        createdAt: "2026-09-01T00:00:00.000Z",
        method: "modelProvider/authRecoveryStarted",
        payload: {
          threadId: "provider-error-thread-secret",
          turnId: "provider-error-turn-secret",
          provider: "provider-error-account-secret",
          message: "provider-error-start-message-secret",
        },
      } satisfies ProviderEvent);
      yield* runtime.emit({
        id: asEventId("evt-auth-owning-turn-error"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-parent"),
        createdAt: "2026-09-01T00:00:01.000Z",
        method: "error",
        payload: {
          threadId: "provider-error-thread-secret",
          turnId: "provider-error-turn-secret",
          willRetry: false,
          error: {
            message: "provider-terminal-error-message-secret",
          },
        },
      } satisfies ProviderEvent);

      const events = Array.from(yield* Fiber.join(eventsFiber));
      assert.deepStrictEqual(
        events.map((event) => event.type),
        ["task.started", "task.completed", "runtime.error"],
      );
      const taskTerminal = events[1];
      assert.equal(
        taskTerminal?.type === "task.completed" ? taskTerminal.payload.taskId : undefined,
        authRecoveryTaskIdForTest("provider-error-thread-secret", "provider-error-turn-secret"),
      );
      assert.equal(
        taskTerminal?.type === "task.completed" ? taskTerminal.payload.status : undefined,
        "failed",
      );
      assert.deepStrictEqual(taskTerminal?.raw?.payload, {
        redacted: true,
        reason: "model-provider-auth-recovery-terminalized",
        terminal: "turn-error",
        status: "failed",
      });
      assert.doesNotMatch(encodeProviderJsonString(taskTerminal), /provider-(?:error|terminal)-/u);
    }),
  );

  it.effect("stops active auth recovery when its owning turn completes", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 3)).pipe(
        Effect.forkChild,
      );

      yield* runtime.emit({
        id: asEventId("evt-auth-turn-complete-start"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-parent"),
        createdAt: "2026-09-01T00:00:00.000Z",
        method: "modelProvider/authRecoveryStarted",
        payload: {
          threadId: "provider-complete-thread-secret",
          turnId: "provider-complete-turn-secret",
          provider: "provider-complete-account-secret",
          message: "provider-complete-start-message-secret",
        },
      } satisfies ProviderEvent);
      yield* runtime.emit({
        id: asEventId("evt-auth-owning-turn-completed"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-parent"),
        createdAt: "2026-09-01T00:00:01.000Z",
        method: "turn/completed",
        payload: {
          threadId: "provider-complete-thread-secret",
          turn: {
            id: "provider-complete-turn-secret",
            items: [],
            itemsView: "notLoaded",
            status: "completed",
            error: null,
          },
        },
      } satisfies ProviderEvent);

      const events = Array.from(yield* Fiber.join(eventsFiber));
      assert.deepStrictEqual(
        events.map((event) => event.type),
        ["task.started", "task.completed", "turn.completed"],
      );
      assert.equal(
        events[1]?.type === "task.completed" ? events[1].payload.status : undefined,
        "stopped",
      );
      assert.deepStrictEqual(events[1]?.raw?.payload, {
        redacted: true,
        reason: "model-provider-auth-recovery-terminalized",
        terminal: "turn-terminal",
        status: "stopped",
      });
      assert.doesNotMatch(encodeProviderJsonString(events[1]), /provider-complete-/u);
    }),
  );

  it.effect("maps Codex MCP startup status updates to visible work-log diagnostics", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 3)).pipe(
        Effect.forkChild,
      );

      yield* runtime.emit({
        id: asEventId("evt-mcp-starting"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "mcpServer/startupStatus/updated",
        payload: {
          name: "github",
          status: "starting",
          threadId: "provider-thread-1",
        },
      } satisfies ProviderEvent);
      yield* runtime.emit({
        id: asEventId("evt-mcp-failed"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.001Z",
        method: "mcpServer/startupStatus/updated",
        payload: {
          name: "github",
          status: "failed",
          error: "OAuth token expired.",
          failureReason: "reauthenticationRequired",
          threadId: "provider-thread-1",
        },
      } satisfies ProviderEvent);

      const events = Array.from(yield* Fiber.join(eventsFiber));

      assert.equal(events[0]?.type, "task.progress");
      if (events[0]?.type === "task.progress") {
        assert.equal(events[0].payload.description, "Codex MCP server 'github' is starting.");
      }

      assert.equal(events[1]?.type, "task.progress");
      if (events[1]?.type === "task.progress") {
        assert.equal(events[1].payload.description, "Codex MCP server 'github' failed to start.");
      }

      assert.equal(events[2]?.type, "runtime.warning");
      if (events[2]?.type === "runtime.warning") {
        assert.equal(events[2].payload.message, "OAuth token expired.");
        assert.deepEqual(events[2].payload.detail, {
          name: "github",
          status: "failed",
          providerThreadId: "provider-thread-1",
          failureReason: "reauthenticationRequired",
          error: "OAuth token expired.",
        });
      }
    }),
  );

  it.effect("maps Codex MCP OAuth completion thread metadata", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 1)).pipe(
        Effect.forkChild,
      );

      yield* runtime.emit({
        id: asEventId("evt-mcp-oauth-completed"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "mcpServer/oauthLogin/completed",
        payload: {
          name: "github",
          success: false,
          error: "OAuth token expired.",
          threadId: "provider-thread-1",
        },
      } satisfies ProviderEvent);

      const events = Array.from(yield* Fiber.join(eventsFiber));

      assert.equal(events[0]?.type, "mcp.oauth.completed");
      if (events[0]?.type === "mcp.oauth.completed") {
        assert.deepEqual(events[0].payload, {
          success: false,
          name: "github",
          providerThreadId: "provider-thread-1",
          error: "OAuth token expired.",
        });
      }
    }),
  );

  it.effect("drops ignored Codex notifications and still delivers the next visible event", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

      const ignoredEvents = [
        {
          id: asEventId("evt-codex-private-prediction"),
          kind: "notification" as const,
          provider: ProviderDriverKind.make("codex"),
          threadId: asThreadId("thread-1"),
          createdAt: "2026-01-01T00:00:00.000Z",
          method: "thread/prediction/updated",
          payload: {
            threadId: "provider-thread-1",
            sourceTurnId: "old-prediction-turn",
            result: { type: "completed", text: "PRIVATE_PREDICTION" },
          },
        },
        {
          id: asEventId("evt-codex-gateway-login"),
          kind: "notification" as const,
          provider: ProviderDriverKind.make("codex"),
          threadId: asThreadId("thread-1"),
          createdAt: "2026-01-01T00:00:00.000Z",
          method: "account/gatewayOAuth/changed",
          payload: {
            providerId: "private-gateway-account",
            status: "inProgress",
            authUrl: "https://example.invalid/login?secret=private-token",
            error: "private-gateway-error",
          },
        },
        {
          id: asEventId("evt-codex-stored-attachment"),
          kind: "notification" as const,
          provider: ProviderDriverKind.make("codex"),
          threadId: asThreadId("thread-1"),
          createdAt: "2026-01-01T00:00:00.000Z",
          method: "thread/attachment/updated",
          payload: {
            threadId: "provider-thread-1",
            attachmentId: "attachment-1",
            attachmentType: "document",
            identityKey: "/private/provider-owned-metadata",
            operation: "created",
          },
        },
        {
          id: asEventId("evt-codex-model-safety-buffering"),
          kind: "notification" as const,
          provider: ProviderDriverKind.make("codex"),
          threadId: asThreadId("thread-1"),
          turnId: asTurnId("turn-1"),
          createdAt: "2026-01-01T00:00:00.000Z",
          method: "model/safetyBuffering/updated",
          payload: {
            threadId: "provider-thread-1",
            turnId: "turn-1",
            model: "gpt-5.5-codex",
            useCases: ["cyber"],
            reasons: ["user_risk"],
            showBufferingUi: true,
            fasterModel: "gpt-5.3-codex",
          },
        },
        {
          id: asEventId("evt-codex-turn-moderation-metadata"),
          kind: "notification" as const,
          provider: ProviderDriverKind.make("codex"),
          threadId: asThreadId("thread-1"),
          turnId: asTurnId("turn-1"),
          createdAt: "2026-01-01T00:00:00.000Z",
          method: "turn/moderationMetadata",
          payload: {
            threadId: "thread-1",
            turnId: "turn-1",
            metadata: { moderation: "provider-private" },
          },
        },
        ...[
          "codex_core_plugins::manifest: ignoring interface.defaultPrompt[0]: prompt must be at most 128 characters path=/tmp/plugin.json",
          "codex_core_skills::loader: ignoring interface.icon_small: icon path with '..' must resolve under plugin assets/",
          "codex_core_skills::loader: ignoring interface.icon_large: icon path with '..' must resolve under plugin assets/",
        ].map((message, index) => ({
          id: asEventId(`evt-codex-ignored-metadata-${index}`),
          kind: "notification" as const,
          provider: ProviderDriverKind.make("codex"),
          threadId: asThreadId("thread-1"),
          turnId: asTurnId("turn-1"),
          createdAt: "2026-01-01T00:00:00.000Z",
          method: "process/stderr",
          message,
        })),
      ] satisfies ReadonlyArray<ProviderEvent>;

      for (const event of ignoredEvents) {
        yield* runtime.emit(event);
      }
      yield* runtime.emit({
        id: asEventId("evt-warning-after-safety-buffering"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-1"),
        turnId: asTurnId("turn-1"),
        createdAt: "2026-01-01T00:00:00.001Z",
        method: "warning",
        payload: {
          message: "visible warning",
        },
      } satisfies ProviderEvent);

      const firstEvent = yield* Fiber.join(firstEventFiber);

      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "runtime.warning");
      if (firstEvent.value.type !== "runtime.warning") {
        return;
      }
      assert.equal(firstEvent.value.payload.message, "visible warning");
    }),
  );
});

it.effect(
  "delivers file manifests on Codex sends and steers without adding sandbox overrides",
  () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "cafe-codex-file-attachments-"));
    const runtimeFactory = makeRuntimeFactory();
    const layer = Layer.effect(
      CodexAdapter,
      makeCodexAdapter(decodeCodexSettings({}), {
        makeRuntime: runtimeFactory.factory,
      }),
    ).pipe(
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(providerSessionDirectoryTestLayer),
      Layer.provideMerge(NodeServices.layer),
    );
    return Effect.gen(function* () {
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => fs.rmSync(baseDir, { recursive: true, force: true })),
      );
      const adapter = yield* CodexAdapter;
      const { attachmentsDir } = yield* ServerConfig;
      const threadId = asThreadId("codex-file-test");
      const attachment = yield* Effect.promise(() =>
        storeFileAttachment({
          attachmentsDir,
          threadId,
          name: "source.html",
          mimeType: "text/html",
          bytes: Buffer.from("PRIVATE_HTML_BODY_NOT_IN_INITIAL_PROMPT"),
        }),
      );
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("codex"),
        runtimeMode: "approval-required",
        cwd: process.cwd(),
      });
      const runtime = runtimeFactory.lastRuntime;
      assert.ok(runtime);
      yield* adapter.sendTurn({ threadId, input: "inspect", attachments: [attachment] });
      yield* adapter.steerTurn({
        threadId,
        expectedTurnId: asTurnId("turn-1"),
        input: "include this too",
        attachments: [attachment],
      });
      for (const request of [
        runtime.sendTurnImpl.mock.calls.at(-1)?.[0],
        runtime.steerTurnImpl.mock.calls.at(-1)?.[0],
      ]) {
        assert.match(request?.input ?? "", /source\.html/);
        assert.match(request?.input ?? "", /\.provider\.html/);
        assert.doesNotMatch(request?.input ?? "", /PRIVATE_HTML_BODY_NOT_IN_INITIAL_PROMPT/);
        assert.equal(request?.attachments, undefined);
        assert.equal("additionalDirectories" in (request ?? {}), false);
        assert.equal("sandboxPolicy" in (request ?? {}), false);
      }
    }).pipe(Effect.provide(layer));
  },
);

it.effect("keeps Codex HTTP fallback scoped to the live app-server by default", () =>
  Effect.gen(function* () {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cafecode-codex-transport-policy-"));
    const policyPath = path.join(tempDir, "userdata", "codex-transport-policy.json");
    let scope1Closed = false;
    let scope2Closed = false;

    const makeLayer = (runtimeFactory: ReturnType<typeof makeRuntimeFactory>) =>
      Layer.effect(
        CodexAdapter,
        Effect.gen(function* () {
          const codexConfig = decodeCodexSettings({});
          return yield* makeCodexAdapter(codexConfig, {
            makeRuntime: runtimeFactory.factory,
          });
        }),
      ).pipe(
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), tempDir)),
        Layer.provideMerge(ServerSettingsService.layerTest()),
        Layer.provideMerge(providerSessionDirectoryTestLayer),
        Layer.provideMerge(NodeServices.layer),
      );

    const scope1 = yield* Scope.make("sequential");
    const scope2 = yield* Scope.make("sequential");
    try {
      const runtimeFactory1 = makeRuntimeFactory();
      const context1 = yield* Layer.buildWithScope(makeLayer(runtimeFactory1), scope1);
      const adapter1 = yield* Effect.service(CodexAdapter).pipe(Effect.provide(context1));

      yield* adapter1.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-policy-1"),
        runtimeMode: "full-access",
      });
      assert.equal(runtimeFactory1.factory.mock.calls[0]?.[0].transportPolicy, undefined);

      const runtime1 = runtimeFactory1.lastRuntime;
      assert.ok(runtime1);

      const retryFiber = yield* Stream.runHead(adapter1.streamEvents).pipe(Effect.forkChild);
      yield* runtime1.emit({
        id: asEventId("evt-policy-retry"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-policy-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "error",
        turnId: asTurnId("turn-policy-1"),
        message: "Reconnecting... 5/5",
        payload: {
          error: {
            message: "Reconnecting... 5/5",
            additionalDetails:
              "stream disconnected before completion: websocket closed by server before response.completed",
          },
          willRetry: true,
        },
      } satisfies ProviderEvent);

      const retryWarning = yield* Fiber.join(retryFiber);
      assert.equal(retryWarning._tag, "Some");
      assert.equal(fs.existsSync(policyPath), false);

      const warningFiber = yield* Stream.runHead(adapter1.streamEvents).pipe(Effect.forkChild);
      yield* runtime1.emit({
        id: asEventId("evt-policy-warning"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-policy-1"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "warning",
        turnId: asTurnId("turn-policy-1"),
        payload: {
          message:
            "Falling back from WebSockets to HTTPS transport. stream disconnected before completion: websocket closed by server before response.completed",
        },
      } satisfies ProviderEvent);

      const warning = yield* Fiber.join(warningFiber);
      assert.equal(warning._tag, "Some");
      assert.equal(fs.existsSync(policyPath), false);

      yield* Scope.close(scope1, Exit.void);
      scope1Closed = true;

      const runtimeFactory2 = makeRuntimeFactory();
      const context2 = yield* Layer.buildWithScope(makeLayer(runtimeFactory2), scope2);
      const adapter2 = yield* Effect.service(CodexAdapter).pipe(Effect.provide(context2));

      yield* adapter2.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-policy-2"),
        runtimeMode: "full-access",
      });

      const launchOptions = runtimeFactory2.factory.mock.calls[0]?.[0];
      assert.equal(launchOptions?.transportPolicy, undefined);
    } finally {
      if (!scope1Closed) {
        yield* Scope.close(scope1, Exit.void).pipe(Effect.ignore);
      }
      if (!scope2Closed) {
        yield* Scope.close(scope2, Exit.void).pipe(Effect.ignore);
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }),
);

it.effect("can opt in to persisted Codex HTTP fallback retirement for diagnostics", () =>
  Effect.gen(function* () {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cafecode-codex-transport-retire-"));
    const threadId = asThreadId("thread-policy-retire");
    const runtimeFactory = makeRuntimeFactory();
    const scope = yield* Scope.make("sequential");
    let scopeClosed = false;

    try {
      const layer = Layer.effect(
        CodexAdapter,
        Effect.gen(function* () {
          const codexConfig = decodeCodexSettings({});
          return yield* makeCodexAdapter(codexConfig, {
            environment: {
              CAFE_CODE_PERSIST_CODEX_HTTP_FALLBACK: "1",
            },
            makeRuntime: runtimeFactory.factory,
          });
        }),
      ).pipe(
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), tempDir)),
        Layer.provideMerge(ServerSettingsService.layerTest()),
        Layer.provideMerge(providerSessionDirectoryTestLayer),
        Layer.provideMerge(NodeServices.layer),
      );
      const context = yield* Layer.buildWithScope(layer, scope);
      const adapter = yield* Effect.service(CodexAdapter).pipe(Effect.provide(context));

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId,
        runtimeMode: "full-access",
      });
      assert.equal(runtimeFactory.factory.mock.calls[0]?.[0].transportPolicy, undefined);

      const runtime = runtimeFactory.lastRuntime;
      assert.ok(runtime);

      const runtimeEventsFiber = yield* Stream.take(adapter.streamEvents, 2).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* runtime.emit({
        id: asEventId("evt-policy-retire-warning"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId,
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "warning",
        payload: {
          message:
            "Falling back from WebSockets to HTTPS transport. stream disconnected before completion: websocket closed by server before response.completed",
        },
      } satisfies ProviderEvent);
      yield* runtime.emit({
        id: asEventId("evt-policy-retire-completed"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId,
        turnId: asTurnId("turn-policy-retire"),
        createdAt: "2026-01-01T00:00:01.000Z",
        method: "turn/completed",
        payload: {
          threadId: "provider-thread-policy-retire",
          turn: {
            id: "turn-policy-retire",
            items: [],
            status: "completed",
          },
        },
      } satisfies ProviderEvent);

      const runtimeEvents = Array.from(yield* Fiber.join(runtimeEventsFiber));
      assert.equal(runtimeEvents[0]?.type, "runtime.warning");
      assert.equal(runtimeEvents[1]?.type, "turn.completed");
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      assert.equal(runtime.closeImpl.mock.calls.length, 1);
      assert.equal(yield* adapter.hasSession(threadId), false);

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId,
        runtimeMode: "full-access",
      });
      assert.equal(
        runtimeFactory.factory.mock.calls[1]?.[0].transportPolicy?.responsesWebsockets,
        "disabled",
      );
    } finally {
      if (!scopeClosed) {
        yield* Scope.close(scope, Exit.void).pipe(Effect.ignore);
      }
      scopeClosed = true;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }),
);

const scopedLifecycleRuntimeFactory = makeScopedRuntimeFactory();
const scopedLifecycleLayer = it.layer(
  Layer.effect(
    CodexAdapter,
    Effect.gen(function* () {
      const codexConfig = decodeCodexSettings({});
      return yield* makeCodexAdapter(codexConfig, {
        makeRuntime: scopedLifecycleRuntimeFactory.factory,
      });
    }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

scopedLifecycleLayer("CodexAdapterLive scoped lifecycle", (it) => {
  it.effect("closes the externally owned session scope on stopSession", () =>
    Effect.gen(function* () {
      scopedLifecycleRuntimeFactory.releasedThreadIds.length = 0;
      const adapter = yield* CodexAdapter;

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-stop"),
        runtimeMode: "full-access",
      });

      const runtime = scopedLifecycleRuntimeFactory.lastRuntime;
      assert.ok(runtime);

      yield* adapter.stopSession(asThreadId("thread-stop"));

      assert.equal(runtime.closeImpl.mock.calls.length, 1);
      assert.deepStrictEqual(scopedLifecycleRuntimeFactory.releasedThreadIds, [
        asThreadId("thread-stop"),
      ]);
      assert.equal(yield* adapter.hasSession(asThreadId("thread-stop")), false);
    }),
  );

  it.effect("retires the local app-server after a successful Codex interrupt", () =>
    Effect.gen(function* () {
      scopedLifecycleRuntimeFactory.releasedThreadIds.length = 0;
      const initialFactoryCallCount = scopedLifecycleRuntimeFactory.factory.mock.calls.length;
      const adapter = yield* CodexAdapter;
      const threadId = asThreadId("thread-interrupt-retire");

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId,
        runtimeMode: "full-access",
      });

      const firstRuntime = scopedLifecycleRuntimeFactory.lastRuntime;
      assert.ok(firstRuntime);

      yield* adapter.interruptTurn(threadId, asTurnId("turn-active"));

      assert.deepStrictEqual(
        firstRuntime.interruptTurnImpl.mock.calls[0]?.[0],
        asTurnId("turn-active"),
      );
      assert.equal(firstRuntime.closeImpl.mock.calls.length, 1);
      assert.deepStrictEqual(scopedLifecycleRuntimeFactory.releasedThreadIds, [threadId]);
      assert.equal(yield* adapter.hasSession(threadId), false);

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId,
        runtimeMode: "full-access",
      });

      const secondRuntime = scopedLifecycleRuntimeFactory.lastRuntime;
      assert.ok(secondRuntime);
      assert.notEqual(secondRuntime, firstRuntime);
      assert.equal(
        scopedLifecycleRuntimeFactory.factory.mock.calls.length,
        initialFactoryCallCount + 2,
      );
    }),
  );

  it.effect("forwards a delayed turn/completed received after interrupt acknowledgement", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
      const threadId = asThreadId("thread-interrupt-delayed-completed");
      const turnId = asTurnId("turn-interrupt-delayed-completed");

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId,
        runtimeMode: "full-access",
      });
      const runtime = scopedLifecycleRuntimeFactory.lastRuntime;
      assert.ok(runtime);
      const forwardedFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);
      const terminalEvent = {
        id: asEventId("evt-interrupt-delayed-completed"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId,
        turnId,
        createdAt: "2026-01-01T00:00:01.000Z",
        method: "turn/completed",
        payload: {
          threadId: "provider-thread-interrupt-delayed-completed",
          turn: { id: turnId, items: [], status: "interrupted" },
        },
      } satisfies ProviderEvent;

      // The hook runs after the fake provider promise acknowledges interrupt,
      // but before CodexAdapter can continue into retireSession. Waiting for
      // the subscribed stream proves this is the real ACK-to-retirement race
      // window rather than a trivial post-retirement queue injection.
      runtime.afterInterruptAcknowledged = runtime
        .emit(terminalEvent)
        .pipe(Effect.andThen(Fiber.join(forwardedFiber)), Effect.asVoid);

      yield* adapter.interruptTurn(threadId, turnId);
      const forwarded = yield* Fiber.join(forwardedFiber);

      assert.equal(forwarded._tag, "Some");
      assert.equal(forwarded._tag === "Some" ? forwarded.value.type : undefined, "turn.completed");
      assert.equal(runtime.closeImpl.mock.calls.length, 1);
      assert.equal(yield* adapter.hasSession(threadId), false);
    }),
  );
});

const scopedFailureRuntimeFactory = makeScopedRuntimeFactory({ failConstruction: true });
const scopedFailureLayer = it.layer(
  Layer.effect(
    CodexAdapter,
    Effect.gen(function* () {
      const codexConfig = decodeCodexSettings({});
      return yield* makeCodexAdapter(codexConfig, {
        makeRuntime: scopedFailureRuntimeFactory.factory,
      });
    }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(providerSessionDirectoryTestLayer),
    Layer.provideMerge(NodeServices.layer),
  ),
);

scopedFailureLayer("CodexAdapterLive scoped startup failure", (it) => {
  it.effect("closes the externally owned session scope when startSession fails", () =>
    Effect.gen(function* () {
      scopedFailureRuntimeFactory.releasedThreadIds.length = 0;
      const adapter = yield* CodexAdapter;

      const result = yield* adapter
        .startSession({
          provider: ProviderDriverKind.make("codex"),
          threadId: asThreadId("thread-fail"),
          runtimeMode: "full-access",
        })
        .pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      assert.equal(result.failure._tag, "ProviderAdapterProcessError");
      assert.deepStrictEqual(scopedFailureRuntimeFactory.releasedThreadIds, [
        asThreadId("thread-fail"),
      ]);
      assert.equal(yield* adapter.hasSession(asThreadId("thread-fail")), false);
    }),
  );
});

for (const phase of ["construction", "descriptor", "handshake"] as const) {
  it.effect(`bounds stalled Codex ${phase} acquisition and retires only its owned scope`, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const threadId = asThreadId(`startup-timeout-${phase}`);
        const siblingId = asThreadId(`startup-timeout-sibling-${phase}`);
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const released: ThreadId[] = [];
        const runtimes: FakeCodexRuntime[] = [];
        let targetAttempts = 0;
        let interrupted = 0;
        let retiredTargetBridges = 0;
        const stall = Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              interrupted += 1;
            }),
          ),
        );
        const adapter = yield* makeCodexAdapter(decodeCodexSettings({}), {
          makeRuntime: (options) =>
            Effect.gen(function* () {
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  released.push(options.threadId);
                }),
              );
              const firstTargetAttempt = options.threadId === threadId && ++targetAttempts === 1;
              if (firstTargetAttempt && phase === "construction") yield* stall;
              const runtime = new FakeCodexRuntime(options);
              runtimes.push(runtime);
              if (firstTargetAttempt) {
                const events = runtime.events;
                Object.defineProperty(runtime, "events", {
                  get: () =>
                    events.pipe(
                      Stream.ensuring(
                        Effect.sync(() => {
                          retiredTargetBridges += 1;
                        }),
                      ),
                    ),
                });
              }
              if (firstTargetAttempt && phase === "descriptor") {
                const descriptor = runtime.getSession;
                runtime.getSession = stall.pipe(Effect.andThen(descriptor));
              }
              if (firstTargetAttempt && phase === "handshake") {
                const start = runtime.start.bind(runtime);
                runtime.start = () => stall.pipe(Effect.andThen(start()));
              }
              return runtime;
            }),
        });
        yield* adapter.startSession({ threadId: siblingId, runtimeMode: "full-access" });
        const sibling = runtimes[0]!;
        const pending = yield* adapter
          .startSession({ threadId, runtimeMode: "full-access" })
          .pipe(Effect.result, Effect.forkChild);
        yield* Deferred.await(entered);
        yield* TestClock.adjust("59 seconds");
        assert.equal(pending.pollUnsafe(), undefined);
        assert.equal(yield* adapter.hasSession(threadId), false);
        yield* TestClock.adjust("1 second");
        const result = yield* Fiber.join(pending);
        assert.equal(result._tag, "Failure");
        assert.equal(result.failure._tag, "ProviderAdapterRequestError");
        assert.equal(
          "remoteErrorTag" in result.failure && result.failure.remoteErrorTag,
          "startup-timeout",
        );
        assert.equal("method" in result.failure && result.failure.method, "session/start");
        assert.equal(
          "detail" in result.failure && result.failure.detail,
          "Codex did not finish starting within 60 seconds. The incomplete session was closed; try again when the provider is available.",
        );
        assert.deepEqual(released, [threadId]);
        assert.equal(interrupted, 1);
        assert.equal(retiredTargetBridges, phase === "handshake" ? 1 : 0);
        assert.equal(yield* adapter.hasSession(threadId), false);
        assert.equal(yield* adapter.hasSession(siblingId), true);
        assert.equal(sibling.closeImpl.mock.calls.length, 0);
        if (phase !== "construction") {
          assert.equal(runtimes[1]!.closeImpl.mock.calls.length, 1);
        }
        assert.equal(
          runtimes.every((runtime) => runtime.sendTurnImpl.mock.calls.length === 0),
          true,
        );

        // A delayed native completion cannot publish the abandoned runtime.
        // Only a new explicit caller may make a second acquisition attempt.
        yield* Deferred.succeed(release, undefined);
        yield* Effect.yieldNow;
        assert.equal(yield* adapter.hasSession(threadId), false);
        assert.equal(targetAttempts, 1);
        yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
        assert.equal(targetAttempts, 2);
        assert.equal(yield* adapter.hasSession(threadId), true);
        assert.equal(runtimes.at(-1)!.startImpl.mock.calls.length, 1);
        assert.equal(runtimes.at(-1)!.closeImpl.mock.calls.length, 0);
        assert.deepEqual(released, [threadId]);
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerConfig.layerTest(process.cwd(), process.cwd()),
          ServerSettingsService.layerTest(),
          providerSessionDirectoryTestLayer,
        ).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    ),
  );
}

it.effect("keeps a Codex session that finishes acquisition before the startup deadline", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let runtime: FakeCodexRuntime | undefined;
      let released = 0;
      const adapter = yield* makeCodexAdapter(decodeCodexSettings({}), {
        makeRuntime: (options) =>
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                released += 1;
              }),
            );
            const created = new FakeCodexRuntime(options);
            runtime = created;
            const start = created.start.bind(created);
            created.start = () =>
              Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(start()),
              );
            return created;
          }),
      });
      const threadId = asThreadId("startup-before-deadline");
      const pending = yield* adapter
        .startSession({ threadId, runtimeMode: "full-access" })
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* TestClock.adjust("59 seconds");
      yield* Deferred.succeed(release, undefined);
      const session = yield* Fiber.join(pending);
      assert.equal(session.status, "ready");
      assert.ok(runtime);
      assert.equal(runtime.startImpl.mock.calls.length, 1);
      assert.equal(runtime.getSessionImpl.mock.calls.length, 1);
      yield* TestClock.adjust("2 seconds");
      assert.equal(yield* adapter.hasSession(threadId), true);
      assert.equal(runtime.closeImpl.mock.calls.length, 0);
      assert.equal(released, 0);
      yield* adapter.stopSession(threadId);
      assert.equal(runtime.closeImpl.mock.calls.length, 1);
      assert.equal(released, 1);
    }),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        ServerConfig.layerTest(process.cwd(), process.cwd()),
        ServerSettingsService.layerTest(),
        providerSessionDirectoryTestLayer,
      ).pipe(Layer.provideMerge(NodeServices.layer)),
    ),
  ),
);

it.effect("flushes managed native logs when the adapter layer shuts down", () =>
  Effect.gen(function* () {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cafecode-codex-adapter-native-log-"));
    const basePath = path.join(tempDir, "provider-native.ndjson");
    const runtimeFactory = makeRuntimeFactory();
    const scope = yield* Scope.make("sequential");
    let scopeClosed = false;

    try {
      const layer = Layer.effect(
        CodexAdapter,
        Effect.gen(function* () {
          const codexConfig = decodeCodexSettings({});
          return yield* makeCodexAdapter(codexConfig, {
            makeRuntime: runtimeFactory.factory,
            nativeEventLogPath: basePath,
          });
        }),
      ).pipe(
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
        Layer.provideMerge(ServerSettingsService.layerTest()),
        Layer.provideMerge(providerSessionDirectoryTestLayer),
        Layer.provideMerge(NodeServices.layer),
      );
      const context = yield* Layer.buildWithScope(layer, scope);
      const adapter = yield* Effect.service(CodexAdapter).pipe(Effect.provide(context));

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-logger"),
        runtimeMode: "full-access",
      });

      const runtime = runtimeFactory.lastRuntime;
      assert.ok(runtime);

      const mappedEventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 6)).pipe(
        Effect.forkChild,
      );
      // The fake runtime deliberately bypasses the live runtime's filter.
      // The following visible events are also an ordering barrier: after all
      // six map, the attachment event must have been discarded before the
      // native logger rather than merely ignored by canonical projection.
      yield* runtime.emit({
        id: asEventId("evt-native-log-stored-attachment"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-logger"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "thread/attachment/updated",
        payload: {
          threadId: "provider-thread-logger",
          attachmentId: "attachment-native-log",
          attachmentType: "document",
          identityKey: "/native-log-secret-attachment-identity",
          operation: "created",
        },
      } satisfies ProviderEvent);
      yield* runtime.emit({
        id: asEventId("evt-native-log-gateway-login"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-logger"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "account/gatewayOAuth/changed",
        payload: {
          providerId: "native-log-secret-gateway-account",
          status: "inProgress",
          authUrl: "https://example.invalid/login?secret=native-log-secret-token",
          error: "native-log-secret-gateway-error",
        },
      } satisfies ProviderEvent);
      yield* runtime.emit({
        id: asEventId("evt-native-log-prediction"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-logger"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "thread/prediction/updated",
        payload: {
          threadId: "provider-thread-logger",
          sourceTurnId: "old-prediction-turn",
          result: { type: "completed", text: "native-log-secret-prediction" },
        },
      } satisfies ProviderEvent);
      for (const [index, reference] of [
        { result: "legacy-inline-result" },
        { fileId: "native-log-secret-image-file" },
        { result: "", fileId: "native-log-secret-image-both" },
      ].entries()) {
        yield* runtime.emit({
          id: asEventId(`evt-native-log-image-${index}`),
          kind: "notification",
          provider: ProviderDriverKind.make("codex"),
          threadId: asThreadId("thread-logger"),
          createdAt: "2026-01-01T00:00:00.000Z",
          method: "item/completed",
          payload: {
            threadId: "provider-thread-logger",
            turnId: "image-log-turn",
            completedAtMs: 1,
            item: {
              type: "imageGeneration",
              id: `native-log-image-${index}`,
              status: "completed",
              revisedPrompt: "Visible image prompt",
              savedPath: "/fixture/existing-log-image.png",
              inputImages: [
                {
                  path: "/native-log-secret-image-input.png",
                  sha256: "native-log-secret-image-digest",
                },
              ],
              ...reference,
            },
          },
        });
      }
      yield* runtime.emit({
        id: asEventId("evt-native-log-unknown-root-error"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-logger"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "error",
        payload: {
          threadId: "provider-thread-1",
          turnId: "private-failed-root",
          willRetry: false,
          error: {
            message: "Public error",
            codexErrorInfo: {
              responseStreamDisconnected: {
                httpStatusCode: 503,
                hidden: "native-log-secret-error-inner",
              },
            },
            futurePolicy: "native-log-secret-error-outer",
          },
        },
      });
      yield* runtime.emit({
        id: asEventId("evt-native-log-unknown-root-completed"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-logger"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "turn/completed",
        payload: {
          threadId: "provider-thread-1",
          turn: {
            id: "private-failed-root",
            items: [],
            status: "failed",
            error: {
              message: "Public error",
              codexErrorInfo: "serverOverloaded",
              futurePolicy: "native-log-secret-terminal-outer",
            },
          },
        },
      });
      yield* runtime.emit({
        id: asEventId("evt-native-log"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-logger"),
        createdAt: "2026-01-01T00:00:00.000Z",
        method: "thread/settings/updated",
        payload: {
          threadId: "provider-thread-logger",
          threadSettings: {
            activePermissionProfile: null,
            approvalPolicy: "never",
            approvalsReviewer: "user",
            collaborationMode: {
              mode: "default",
              settings: {
                model: "gpt-5.4",
                reasoning_effort: "high",
                developer_instructions: "native-log-secret-instructions",
              },
            },
            cwd: "/native-log-secret-cwd",
            effort: "high",
            model: "gpt-5.4",
            modelProvider: "openai",
            personality: null,
            sandboxPolicy: {
              type: "workspaceWrite",
              writableRoots: ["/native-log-secret-root"],
            },
            serviceTier: null,
            summary: "auto",
          },
        },
      } satisfies ProviderEvent);
      yield* runtime.emit({
        id: asEventId("evt-native-log-subagent"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-logger"),
        turnId: asTurnId("turn-native-log-subagent"),
        createdAt: "2026-01-01T00:00:01.000Z",
        method: "codex.subagent/itemCompleted",
        payload: {
          completedAtMs: 1_767_225_601_000,
          threadId: "provider-child-native-log",
          turnId: "provider-turn-native-log",
          item: {
            type: "reasoning",
            id: "reasoning-native-log",
            summary: ["native-log-secret-subagent-reasoning"],
            content: [],
          },
        },
      } satisfies ProviderEvent);
      yield* runtime.emit({
        id: asEventId("evt-native-log-auth-recovery"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread-logger"),
        turnId: asTurnId("turn-native-log-auth-recovery"),
        createdAt: "2026-09-01T00:00:02.000Z",
        method: "modelProvider/authRecoveryStarted",
        payload: {
          threadId: "provider-thread-native-log-secret",
          turnId: "provider-turn-native-log-secret",
          provider: "native-log-secret-provider-account",
          message: "native-log-secret-provider-message",
        },
      } satisfies ProviderEvent);
      yield* Fiber.join(mappedEventsFiber);

      yield* Scope.close(scope, Exit.void);
      scopeClosed = true;

      const threadLogPath = path.join(tempDir, "thread-logger.log");
      assert.equal(fs.existsSync(threadLogPath), true);
      const contents = fs.readFileSync(threadLogPath, "utf8");
      assert.match(contents, /NTIVE: .*"model":"gpt-5\.4"/);
      assert.match(contents, /"reason":"subagent-provider-content"/);
      assert.match(contents, /"reason":"model-provider-auth-recovery-content"/);
      assert.match(contents, /"type":"imageGeneration"/);
      assert.match(contents, /\/fixture\/existing-log-image\.png/);
      assert.doesNotMatch(contents, /thread\/attachment\/updated/);
      assert.doesNotMatch(contents, /account\/gatewayOAuth\/changed/);
      assert.doesNotMatch(contents, /thread\/prediction\/updated/);
      assert.doesNotMatch(contents, /native-log-secret/);
    } finally {
      if (!scopeClosed) {
        yield* Scope.close(scope, Exit.void);
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }),
);

type SchedulingBindingFixture = SchedulingSessionBinding & {
  readonly identity: Parameters<SchedulingSessionBroker["bind"]>[0];
  active: boolean;
  disposed: boolean;
};

function schedulingCase<FixtureError>(
  run: (fixture: {
    bindings: SchedulingBindingFixture[];
    bind: ReturnType<typeof vi.fn<SchedulingSessionBroker["bind"]>>;
    createAdapter: (
      instanceId: ProviderInstanceId,
      makeRuntime: NonNullable<CodexAdapterLiveOptions["makeRuntime"]>,
    ) => ReturnType<typeof makeCodexAdapter>;
  }) => Effect.Effect<void, FixtureError, Effect.Services<ReturnType<typeof makeCodexAdapter>>>,
) {
  const bindings: SchedulingBindingFixture[] = [];
  return Effect.scoped(
    Effect.gen(function* () {
      const bind = vi.fn<SchedulingSessionBroker["bind"]>(async (identity) => {
        const binding: SchedulingBindingFixture = {
          identity,
          name: `cafe-scheduling_fixture_${bindings.length}`,
          launch: {
            command: process.execPath,
            args: ["/synthetic/bridge.mjs", `/synthetic/connection-${bindings.length}.json`],
            env: { ELECTRON_RUN_AS_NODE: "1" },
          },
          active: false,
          disposed: false,
          activate: vi.fn(async () => {
            assert.equal(binding.disposed, false);
            binding.active = true;
          }),
          dispose: vi.fn(async () => {
            binding.active = false;
            binding.disposed = true;
          }),
        };
        bindings.push(binding);
        return binding;
      });
      const uninstall = installSchedulingSessionBroker({ bind });
      yield* Effect.addFinalizer(() => Effect.sync(uninstall));
      yield* run({
        bindings,
        bind,
        createAdapter: (instanceId, makeRuntime) =>
          makeCodexAdapter(decodeCodexSettings({}), { instanceId, makeRuntime }),
      });
    }),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        ServerConfig.layerTest(process.cwd(), process.cwd()),
        ServerSettingsService.layerTest(),
        providerSessionDirectoryTestLayer,
      ).pipe(Layer.provideMerge(NodeServices.layer)),
    ),
    // Adapter-scope retirement must revoke even bindings which were never
    // explicitly stopped by the test body. No filesystem/provider is involved.
    Effect.tap(() =>
      Effect.sync(() =>
        assert.equal(
          bindings.every((binding) => binding.disposed),
          true,
        ),
      ),
    ),
  );
}

it.effect(
  "attaches Glide to exact Codex owners and joins activation, turn resume and interruption cleanup",
  () =>
    schedulingCase(({ createAdapter }) =>
      Effect.gen(function* () {
        const launch = {
          command: process.execPath,
          args: ["/synthetic/glide-bridge.mjs"],
          env: { ELECTRON_RUN_AS_NODE: "1" },
        };
        const bindings = Array.from({ length: 2 }, (_, index) => ({
          name: `cafe-glide-fixture-${index}`,
          launch,
          activate: vi.fn(async () => {}),
          cancel: vi.fn(async () => {}),
          resume: vi.fn(() => {}),
          dispose: vi.fn(async () => {}),
        }));
        let nextBinding = 0;
        const bind = vi.fn<GlideSessionBroker["bind"]>(async () => bindings[nextBinding++]);
        const uninstall = installGlideSessionRuntime({
          bind,
          operation: async () => {
            throw new Error("No HTTP authority in adapter fixture.");
          },
        });
        yield* Effect.addFinalizer(() => Effect.sync(uninstall));
        const factory = makeRuntimeFactory();
        const instance = ProviderInstanceId.make("codex-glide-owner");
        const adapter = yield* createAdapter(instance, factory.factory);
        const first = asThreadId("glide-first"),
          second = asThreadId("glide-second");
        yield* adapter.startSession({ threadId: first, runtimeMode: "approval-required" });
        yield* adapter.startSession({ threadId: second, runtimeMode: "full-access" });
        assert.deepEqual(
          bind.mock.calls.map(([identity]) => identity),
          [
            {
              threadId: first,
              providerInstanceId: instance,
              provider: "codex",
              runtimeMode: "approval-required",
            },
            {
              threadId: second,
              providerInstanceId: instance,
              provider: "codex",
              runtimeMode: "full-access",
            },
          ],
        );
        for (let index = 0; index < 2; index++) {
          assert.deepEqual(factory.runtimes[index]!.options.glideMcp, bindings[index]);
          assert.equal(bindings[index]!.activate.mock.calls.length, 1);
        }
        yield* adapter.sendTurn({ threadId: second, input: "owned turn" });
        assert.equal(bindings[1]!.resume.mock.calls.length, 1);
        assert.equal(bindings[0]!.resume.mock.calls.length, 0);
        yield* adapter.interruptTurn(second);
        assert.equal(bindings[1]!.cancel.mock.calls.length, 1);
        assert.equal(bindings[1]!.dispose.mock.calls.length, 2);
        assert.equal(bindings[0]!.cancel.mock.calls.length, 0);
        assert.equal(bindings[0]!.dispose.mock.calls.length, 0);
        yield* adapter.stopSession(first);
        assert.equal(bindings[0]!.dispose.mock.calls.length, 2);
      }),
    ),
);

it.effect("registers visualization MCP only for the actual Codex Full-access launch", () =>
  schedulingCase(({ createAdapter }) =>
    Effect.gen(function* () {
      const instance = ProviderInstanceId.make("codex-inline-fixture");
      const generation = VisualizationGenerationId.make("00000000-0000-4000-8000-000000000001");
      const launch = { command: process.execPath, args: [], env: { ELECTRON_RUN_AS_NODE: "1" } };
      const activate = vi.fn(async () => {});
      const dispose = vi.fn(async () => {});
      const bind = vi.fn<VisualizationSessionBroker["bind"]>(async (identity) => ({
        name: "cafe-visualizations-fixture",
        launch,
        authority: {
          threadId: identity.threadId,
          providerInstanceId: instance,
          sessionGeneration: generation,
          runtimeGeneration: generation,
          tokenDigest: "a".repeat(64),
          serverName: "cafe-visualizations-fixture",
        },
        activate,
        dispose,
        claimNativeCompletion: async () => undefined,
      }));
      const uninstall = installVisualizationSessionRuntime({
        bind,
        authorize: async () => {
          throw new Error("Fixture has no HTTP capability.");
        },
        close: async () => {},
      });
      yield* Effect.addFinalizer(() => Effect.sync(uninstall));
      const factory = makeRuntimeFactory();
      const adapter = yield* createAdapter(instance, factory.factory);
      const restricted = asThreadId("visualization-restricted");
      const full = asThreadId("visualization-full");
      yield* adapter.startSession({ threadId: restricted, runtimeMode: "approval-required" });
      assert.equal(bind.mock.calls.length, 0);
      assert.equal(factory.runtimes[0]!.options.visualizationMcp, undefined);
      yield* adapter.startSession({ threadId: full, runtimeMode: "full-access" });
      assert.deepEqual(
        bind.mock.calls.map(([identity]) => identity),
        [
          {
            threadId: full,
            providerInstanceId: instance,
            provider: "codex",
            runtimeMode: "full-access",
          },
        ],
      );
      assert.deepEqual(factory.runtimes[1]!.options.visualizationMcp, {
        name: "cafe-visualizations-fixture",
        launch,
      });
      assert.equal(activate.mock.calls.length, 1);
      yield* adapter.stopSession(restricted);
      assert.equal(dispose.mock.calls.length, 0);
      yield* adapter.stopSession(full);
      // Explicit retirement and the existing adapter scope finalizer both
      // request exact-binding cleanup; the production binding is idempotent.
      assert.equal(dispose.mock.calls.length, 2);
    }),
  ),
);

it.effect(
  "isolates scheduling by Codex chat, account and runtime generation while preserving resume",
  () =>
    schedulingCase(({ bindings, bind, createAdapter }) =>
      Effect.gen(function* () {
        const accountA = ProviderInstanceId.make("codex-account-a");
        const accountB = ProviderInstanceId.make("codex-account-b");
        const factoryA = makeRuntimeFactory();
        const factoryB = makeRuntimeFactory();
        const adapterA = yield* createAdapter(accountA, factoryA.factory);
        const adapterB = yield* createAdapter(accountB, factoryB.factory);
        const first = yield* adapterA.startSession({
          threadId: asThreadId("schedule-one"),
          runtimeMode: "approval-required",
        });
        yield* adapterA.startSession({
          threadId: asThreadId("schedule-two"),
          runtimeMode: "full-access",
        });
        yield* adapterB.startSession({
          threadId: asThreadId("schedule-three"),
          runtimeMode: "approval-required",
        });
        assert.deepEqual(
          bind.mock.calls.map(([identity]) => identity),
          [
            { threadId: "schedule-one", providerInstanceId: accountA, provider: "codex" },
            { threadId: "schedule-two", providerInstanceId: accountA, provider: "codex" },
            { threadId: "schedule-three", providerInstanceId: accountB, provider: "codex" },
          ],
        );
        const runtimes = [...factoryA.runtimes, ...factoryB.runtimes];
        for (const [index, runtime] of runtimes.entries()) {
          const binding = bindings[index]!;
          assert.deepEqual(runtime.options.schedulingMcp, {
            name: binding.name,
            launch: binding.launch,
          });
          assert.equal(binding.active, true);
          assert.equal(vi.mocked(binding.activate).mock.calls.length, 1);
        }
        assert.deepEqual(
          runtimes.map((runtime) => runtime.options.runtimeMode),
          ["approval-required", "full-access", "approval-required"],
        );
        assert.equal(new Set(bindings.map((binding) => binding.name)).size, 3);
        assert.equal(new Set(bindings.map((binding) => binding.launch.args[1])).size, 3);
        factoryA.runtimes[0]!.closeImpl.mockImplementation(async () => {
          // Revocation happens before the native provider can finish stopping.
          assert.equal(bindings[0]!.disposed, true);
        });
        yield* adapterA.stopSession(first.threadId);
        assert.equal(bindings[0]!.disposed, true);
        assert.equal(bindings[1]!.disposed, false);
        assert.equal(bindings[2]!.disposed, false);
        const nativeCursor = { threadId: "exact-native-scheduling-resume" };
        yield* adapterA.startSession({
          threadId: first.threadId,
          runtimeMode: "approval-required",
          resumeCursor: nativeCursor,
        });
        assert.deepEqual(factoryA.lastRuntime!.options.resumeCursor, nativeCursor);
        assert.notEqual(bindings[3]!.name, bindings[0]!.name);
        assert.equal(bindings[3]!.active, true);
        // Repeated old-generation cleanup cannot revoke the replacement or any
        // sibling account; the broker owns exact generation fencing as well.
        yield* Effect.promise(() => bindings[0]!.dispose());
        assert.equal(bindings[3]!.active, true);
        assert.equal(factoryA.runtimes[1]!.closeImpl.mock.calls.length, 0);
        assert.equal(factoryB.lastRuntime!.closeImpl.mock.calls.length, 0);
      }),
    ),
);

for (const phase of ["bind", "construction", "handshake", "activation"] as const) {
  it.effect(`revokes only the failed Codex scheduling generation after ${phase} failure`, () =>
    schedulingCase(({ bindings, bind, createAdapter }) =>
      Effect.gen(function* () {
        const failedId = asThreadId(`scheduling-failure-${phase}`);
        const factory = makeRuntimeFactory();
        const adapter = yield* createAdapter(
          ProviderInstanceId.make("codex-scheduling-failure"),
          (options) => {
            if (options.threadId !== failedId) return factory.factory(options);
            assert.equal(bindings[1]!.active, false);
            if (phase === "construction")
              return Effect.fail(
                new CodexErrors.CodexAppServerSpawnError({
                  command: "synthetic codex",
                  cause: new Error("synthetic construction failure"),
                }),
              );
            const runtime = new FakeCodexRuntime(options);
            factory.runtimes.push(runtime);
            if (phase === "handshake")
              runtime.start = () =>
                Effect.fail(
                  CodexErrors.CodexAppServerRequestError.internalError(
                    "synthetic handshake failure",
                  ),
                );
            if (phase === "activation")
              vi.mocked(bindings[1]!.activate).mockRejectedValueOnce(
                new Error("private capability must not leak"),
              );
            return Effect.succeed(runtime);
          },
        );
        yield* adapter.startSession({
          threadId: asThreadId("scheduling-surviving-sibling"),
          runtimeMode: "full-access",
        });
        if (phase === "bind")
          bind.mockRejectedValueOnce(new Error("private capability must not leak"));
        const outcome = yield* adapter
          .startSession({
            threadId: failedId,
            runtimeMode: "approval-required",
            resumeCursor: { threadId: "unchanged-native-cursor" },
          })
          .pipe(Effect.result);
        assert.equal(outcome._tag, "Failure");
        if (outcome._tag !== "Failure") return;
        assert.equal(outcome.failure._tag, "ProviderAdapterProcessError");
        assert.doesNotMatch(encodeProviderJsonString(outcome.failure), /private capability/u);
        assert.equal(yield* adapter.hasSession(failedId), false);
        assert.equal(bindings[0]!.active, true);
        assert.equal(factory.runtimes[0]!.closeImpl.mock.calls.length, 0);
        if (phase !== "bind") {
          assert.equal(bindings[1]!.disposed, true);
          assert.equal(bindings[1]!.active, false);
          assert.equal(
            vi.mocked(bindings[1]!.activate).mock.calls.length,
            phase === "activation" ? 1 : 0,
          );
        }
        if (phase === "handshake" || phase === "activation") {
          assert.equal(factory.runtimes[1]!.closeImpl.mock.calls.length, 1);
          assert.deepEqual(factory.runtimes[1]!.options.resumeCursor, {
            threadId: "unchanged-native-cursor",
          });
          assert.equal(factory.runtimes[1]!.sendTurnImpl.mock.calls.length, 0);
        }
      }),
    ),
  );
}

it.effect(
  "revokes a late scheduling binding when Codex startup was interrupted during acquisition",
  () =>
    schedulingCase(({ bindings, bind, createAdapter }) =>
      Effect.gen(function* () {
        const factory = makeRuntimeFactory();
        const adapter = yield* createAdapter(
          ProviderInstanceId.make("codex-cancelled-bind"),
          factory.factory,
        );
        const originalBind = bind.getMockImplementation()!;
        const gate = Promise.withResolvers<void>();
        const entered = yield* Deferred.make<void>();
        bind.mockImplementationOnce(async (identity) => {
          await Effect.runPromise(Deferred.succeed(entered, undefined));
          await gate.promise;
          return originalBind(identity);
        });
        const pending = yield* adapter
          .startSession({
            threadId: asThreadId("scheduling-cancelled"),
            runtimeMode: "full-access",
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        const interrupting = yield* Fiber.interrupt(pending).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        gate.resolve();
        yield* Fiber.join(interrupting);
        assert.equal(bindings.length, 1);
        assert.equal(bindings[0]!.disposed, true);
        assert.equal(bindings[0]!.active, false);
        assert.equal(factory.runtimes.length, 0);
        assert.equal(yield* adapter.hasSession(asThreadId("scheduling-cancelled")), false);
      }),
    ),
);

it.effect("finishes Codex retirement when revoked scheduling files cannot be cleaned", () =>
  schedulingCase(({ bindings, createAdapter }) =>
    Effect.gen(function* () {
      const factory = makeRuntimeFactory();
      const adapter = yield* createAdapter(
        ProviderInstanceId.make("codex-cleanup-failure"),
        factory.factory,
      );
      const threadId = asThreadId("scheduling-cleanup-failure");
      yield* adapter.startSession({ threadId, runtimeMode: "full-access" });
      const binding = bindings[0]!;
      vi.mocked(binding.dispose).mockImplementation(async () => {
        // The real broker revokes authority before fallible persistence/file
        // cleanup. Model that contract and ensure a private cleanup exception
        // does not strand the old provider after its session is marked stopped.
        binding.active = false;
        binding.disposed = true;
        throw new Error("private scheduling connection path");
      });
      yield* adapter.stopSession(threadId);
      assert.equal(factory.lastRuntime!.closeImpl.mock.calls.length, 1);
      assert.equal(yield* adapter.hasSession(threadId), false);
      assert.equal(binding.active, false);
    }),
  ),
);

it.each(["cafe-desktop", "cafe-native-abcdefghijklmnopqrstuv"])(
  "redacts %s input and images from item and nested thread snapshots",
  (server) => {
    const reference = {
      id: "24ff9ac9-1d98-4bb9-9d3f-1e868663a064",
      capturedAt: "2026-09-09T00:00:00.000Z",
      width: 1280,
      height: 800,
      frame: 4,
      humanControl: false,
      storage: "saved",
    };
    const item = {
      id: "item",
      type: "mcpToolCall",
      server,
      tool: "observe",
      status: "completed",
      arguments: { text: "private input" },
      result: {
        content: [{ type: "image", data: "private image" }],
        structuredContent: {
          desktopObservation: { ...reference, image: "private extra" },
          privateKey: "private key",
        },
      },
      error: { message: "private error" },
      extra: "private future field",
    };
    for (const payload of [{ item }, { thread: { turns: [{ items: [item] }] } }]) {
      const event: ProviderEvent = {
        id: asEventId("desktop-event"),
        kind: "notification",
        provider: ProviderDriverKind.make("codex"),
        threadId: asThreadId("thread"),
        createdAt: "2026-09-08T00:00:00.000Z",
        method: "item/completed",
        payload,
        textDelta: "private text",
        message: "private message",
      };
      const redacted = redactArchivedToolEvent(event);
      assert.doesNotMatch(JSON.stringify(redacted), /private/);
      assert.match(JSON.stringify(redacted), new RegExp(server));
      assert.doesNotMatch(JSON.stringify(redacted), new RegExp(reference.id));
      assert.equal(redacted.itemId, event.itemId);
    }
  },
);
