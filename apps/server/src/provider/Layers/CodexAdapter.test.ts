// @effect-diagnostics nodeBuiltinImport:off
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ApprovalRequestId,
  CodexSettings,
  EventId,
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderItemId,
  RuntimeTaskId,
  type ProviderApprovalDecision,
  type ProviderEvent,
  type ProviderSession,
  type ProviderThreadGoal,
  type ProviderThreadGoalSetInput,
  type ProviderTurnStartResult,
  type ProviderTurnSteerResult,
  type ProviderUserInputAnswers,
  ThreadId,
  THREAD_TURN_SUBAGENT_DETAIL_MAX_MESSAGE_BYTES,
  THREAD_TURN_SUBAGENT_DETAIL_MAX_MESSAGES,
  THREAD_TURN_SUBAGENT_DETAIL_MAX_TOTAL_BYTES,
  TurnId,
} from "@cafecode/contracts";
import { createModelSelection } from "@cafecode/shared/model";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, vi } from "@effect/vitest";

import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as CodexErrors from "effect-codex-app-server/errors";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderAdapterValidationError } from "../Errors.ts";
import type { CodexAdapterShape } from "../Services/CodexAdapter.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import { buildCodexSteerClientCorrelationId } from "../codexSteerCorrelation.ts";
import {
  type CodexSessionRuntimeOptions,
  type CodexSessionRuntimeError,
  type CodexSessionRuntimeSendTurnInput,
  type CodexSessionRuntimeSteerTurnInput,
  type CodexSessionRuntimeShape,
  type CodexTransientSubagentHistoryReadOptions,
  type CodexThreadSnapshot,
} from "./CodexSessionRuntime.ts";
import { canonicalizeCodexSubagentDetail, makeCodexAdapter } from "./CodexAdapter.ts";
const decodeCodexSettings = Schema.decodeSync(CodexSettings);
const decodeMessageId = Schema.decodeUnknownSync(MessageId);

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

it("canonicalizes only public subagent chat text and strips unsafe controls", () => {
  const detail = canonicalizeCodexSubagentDetail({
    threadId: "provider-child-1",
    turns: [
      {
        id: asTurnId("provider-child-turn-1"),
        items: [
          {
            id: "user-message-1",
            type: "userMessage",
            content: [
              { type: "text", text: "# Task\r\n\tAudit\u202ethe provider\u0000" },
              { type: "skill", name: "private", path: "/secret/skill/path" },
            ],
          },
          {
            id: "reasoning-1",
            type: "reasoning",
            summary: ["private chain of thought"],
            content: ["private reasoning content"],
          },
          {
            id: "assistant-message-1",
            type: "agentMessage",
            text: "## Result\r\n\tDone\u2066 safely.\u0007",
          },
        ],
      },
    ],
  });

  assert.deepStrictEqual(detail, {
    messages: [
      { key: "m0", role: "user", text: "# Task\n    Auditthe provider" },
      { key: "m1", role: "assistant", text: "## Result\n    Done safely." },
    ],
    gaps: [],
    truncated: false,
  });
  assert.doesNotMatch(JSON.stringify(detail), /private chain|secret\/skill/);
});

it("enforces subagent transcript message, per-message, and total limits", () => {
  const oversized = canonicalizeCodexSubagentDetail({
    threadId: "provider-child-oversized",
    turns: [
      {
        id: asTurnId("provider-child-turn-oversized"),
        items: [
          {
            id: "oversized-message",
            type: "agentMessage",
            text: "x".repeat(THREAD_TURN_SUBAGENT_DETAIL_MAX_MESSAGE_BYTES + 100),
          },
        ],
      },
    ],
  });
  assert.equal(retainedDetailBytes(oversized), THREAD_TURN_SUBAGENT_DETAIL_MAX_MESSAGE_BYTES);
  assert.deepEqual(oversized.messages[0]?.omission, {
    tail: "x".repeat(24_576),
    omittedUtf8Bytes: 100,
  });
  assert.equal(oversized.truncated, true);

  const manyMessages = canonicalizeCodexSubagentDetail({
    threadId: "provider-child-many",
    turns: [
      {
        id: asTurnId("provider-child-turn-many"),
        items: Array.from({ length: THREAD_TURN_SUBAGENT_DETAIL_MAX_MESSAGES + 6 }, (_, index) => ({
          id: `message-${index}`,
          type: "agentMessage" as const,
          text: `message ${index}`,
        })),
      },
    ],
  });
  assert.equal(manyMessages.messages.length, THREAD_TURN_SUBAGENT_DETAIL_MAX_MESSAGES);
  assert.equal(manyMessages.messages[0]?.text, "message 0");
  assert.deepEqual(manyMessages.gaps, [
    { afterMessageKey: "m3", omittedMessages: 6, omittedUtf8Bytes: 54 },
  ]);
  assert.equal(
    manyMessages.messages[THREAD_TURN_SUBAGENT_DETAIL_MAX_MESSAGES - 1]?.text,
    `message ${THREAD_TURN_SUBAGENT_DETAIL_MAX_MESSAGES + 5}`,
  );
  assert.equal(manyMessages.truncated, true);

  const totalLimited = canonicalizeCodexSubagentDetail({
    threadId: "provider-child-total",
    turns: [
      {
        id: asTurnId("provider-child-turn-total"),
        items: Array.from({ length: 5 }, (_, index) => ({
          id: `large-message-${index}`,
          type: "agentMessage" as const,
          text: "y".repeat(THREAD_TURN_SUBAGENT_DETAIL_MAX_MESSAGE_BYTES),
        })),
      },
    ],
  });
  assert.equal(retainedDetailBytes(totalLimited), THREAD_TURN_SUBAGENT_DETAIL_MAX_TOTAL_BYTES);
  assert.equal(totalLimited.truncated, true);
});

it("keeps the initial assignment and final result around the newest bounded tail", () => {
  const finalResult = "FINAL_ASSISTANT_RESULT_SENTINEL";
  const detail = canonicalizeCodexSubagentDetail({
    threadId: "provider-child-anchored-tail",
    turns: [
      {
        id: asTurnId("provider-child-turn-anchored-tail"),
        items: [
          {
            id: "initial-assignment",
            type: "userMessage",
            content: [{ type: "text", text: "Audit the child transcript boundary" }],
          },
          ...Array.from({ length: THREAD_TURN_SUBAGENT_DETAIL_MAX_MESSAGES + 8 }, (_, index) => ({
            id: `assistant-update-${index}`,
            type: "agentMessage" as const,
            text:
              index === THREAD_TURN_SUBAGENT_DETAIL_MAX_MESSAGES + 7
                ? finalResult
                : `progress update ${index}`,
          })),
        ],
      },
    ],
  });

  assert.equal(detail.messages.length, THREAD_TURN_SUBAGENT_DETAIL_MAX_MESSAGES);
  assert.deepEqual(detail.messages[0], {
    key: "m0",
    role: "user",
    text: "Audit the child transcript boundary",
  });
  assert.deepEqual(detail.messages.at(-1), {
    key: "m20",
    role: "assistant",
    text: finalResult,
  });
  assert.deepEqual(detail.gaps, [
    { afterMessageKey: "m3", omittedMessages: 9, omittedUtf8Bytes: 155 },
  ]);
  assert.equal(detail.truncated, true);
});

it("retains the final assistant with exact gaps under trailing-user pressure", () => {
  const detail = canonicalizeCodexSubagentDetail({
    threadId: "provider-child-final-anchor",
    turns: [
      {
        id: asTurnId("provider-child-turn-final-anchor"),
        items: [
          {
            id: "initial-assignment",
            type: "userMessage",
            content: [{ type: "text", text: "Audit the adversarial tail" }],
          },
          ...Array.from({ length: 10 }, (_, index) => ({
            id: `early-assistant-${index}`,
            type: "agentMessage" as const,
            text: `early assistant ${index}`,
          })),
          {
            id: "final-assistant-provider-id-must-not-leak",
            type: "agentMessage",
            text: "FINAL ASSISTANT RESULT",
          },
          ...Array.from({ length: 70 }, (_, index) => ({
            id: `trailing-user-${index}`,
            type: "userMessage" as const,
            content: [{ type: "text" as const, text: `trailing user ${index}` }],
          })),
        ],
      },
    ],
  });

  assert.equal(detail.messages.length, THREAD_TURN_SUBAGENT_DETAIL_MAX_MESSAGES);
  assert.ok(detail.messages.some((message) => message.text === "FINAL ASSISTANT RESULT"));
  assert.deepEqual(detail.gaps, [
    { afterMessageKey: "m3", omittedMessages: 7, omittedUtf8Bytes: 119 },
    { afterMessageKey: "mb", omittedMessages: 11, omittedUtf8Bytes: 166 },
  ]);
  assert.doesNotMatch(JSON.stringify(detail), /provider-id-must-not-leak/u);
});

it("retains scalar-safe UTF-8 head and tail fragments for one oversized message", () => {
  const detail = canonicalizeCodexSubagentDetail({
    threadId: "provider-child-unicode",
    turns: [
      {
        id: asTurnId("provider-child-turn-unicode"),
        items: [
          {
            id: "unicode-assignment",
            type: "userMessage",
            content: [
              {
                type: "text",
                text: `${"🙂".repeat(10_000)}\ud800\u202eLATEST_SCALAR_TAIL`,
              },
            ],
          },
        ],
      },
    ],
  });

  const message = detail.messages[0];
  assert.ok(message?.omission);
  assert.ok(message.omission.tail.endsWith("�LATEST_SCALAR_TAIL"));
  assert.equal(retainedDetailBytes(detail) <= THREAD_TURN_SUBAGENT_DETAIL_MAX_MESSAGE_BYTES, true);
  assert.doesNotMatch(`${message.text}${message.omission.tail}`, /[\ud800-\udfff]/u);
});

class FakeCodexRuntime implements CodexSessionRuntimeShape {
  private readonly eventQueue = Effect.runSync(Queue.unbounded<ProviderEvent>());
  private readonly now = "2026-01-01T00:00:00.000Z";

  public readonly startImpl = vi.fn(() =>
    Promise.resolve({
      provider: ProviderDriverKind.make("codex"),
      status: "ready" as const,
      runtimeMode: this.options.runtimeMode,
      threadId: this.options.threadId,
      cwd: this.options.cwd,
      ...(this.options.model ? { model: this.options.model } : {}),
      resumeCursor: this.options.resumeCursor ?? { threadId: "provider-thread-1" },
      createdAt: this.now,
      updatedAt: this.now,
    } satisfies ProviderSession),
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

  public readonly interruptTurnImpl = vi.fn(
    (_turnId?: TurnId): Promise<void> => Promise.resolve(undefined),
  );

  public readonly forkThreadImpl = vi.fn(() =>
    Promise.resolve({ threadId: "provider-thread-fork" }),
  );

  public readonly discardForkImpl = vi.fn((_resumeCursor: unknown) => Promise.resolve());

  public readonly readThreadImpl = vi.fn(
    (): Promise<CodexThreadSnapshot> =>
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

  public readonly rollbackThreadImpl = vi.fn(
    (_numTurns: number): Promise<CodexThreadSnapshot> =>
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

  public readonly snoozeUserInputImpl = vi.fn(
    (_requestId: ApprovalRequestId): Promise<void> => Promise.resolve(undefined),
  );

  public readonly closeImpl = vi.fn(() => Promise.resolve(undefined));

  /** Test-only hook that runs after the provider interrupt promise ACKs. */
  public afterInterruptAcknowledged: Effect.Effect<void> | undefined;

  readonly options: CodexSessionRuntimeOptions;

  constructor(options: CodexSessionRuntimeOptions) {
    this.options = options;
  }

  start() {
    return Effect.promise(() => this.startImpl());
  }

  getSession = Effect.promise(() => this.startImpl());

  sendTurn(input: CodexSessionRuntimeSendTurnInput) {
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
    return Effect.promise(() => this.rollbackThreadImpl(numTurns));
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

  close = Effect.promise(() => this.closeImpl()).pipe(
    Effect.andThen(Queue.shutdown(this.eventQueue)),
  );

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
    get lastRuntime(): FakeCodexRuntime | undefined {
      return runtimes.at(-1);
    },
  };
}

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
const validationLayer = it.layer(
  Layer.effect(
    CodexAdapter,
    Effect.gen(function* () {
      const codexConfig = decodeCodexSettings({});
      return yield* makeCodexAdapter(codexConfig, {
        makeRuntime: validationRuntimeFactory.factory,
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
  it.effect("returns validation error for non-codex provider on startSession", () =>
    Effect.gen(function* () {
      const adapter = yield* CodexAdapter;
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
      assert.equal(validationRuntimeFactory.factory.mock.calls.length, 0);
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

      assert.deepStrictEqual(validationRuntimeFactory.factory.mock.calls[0]?.[0], {
        appServerCwd: path.join(process.cwd(), "userdata"),
        binaryPath: "codex",
        cwd: process.cwd(),
        model: "gpt-5.3-codex",
        providerInstanceId: ProviderInstanceId.make("codex"),
        serviceTier: "fast",
        threadId: asThreadId("thread-1"),
        runtimeMode: "full-access",
      });
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
  (options: { readonly subagentThreadId: string }): Effect.Effect<CodexThreadSnapshot> =>
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
      assert.deepEqual(transientSubagentHistoryRead.mock.calls[0]?.[0], {
        binaryPath: "codex",
        appServerCwd: path.join(process.cwd(), "userdata"),
        rootProviderThreadId: "provider-root-ended",
        subagentThreadId: childId,
      });
      assert.equal(
        (yield* adapter.listSessions()).some((session) => session.threadId === threadId),
        false,
      );
    }),
  );

  it.effect("reuses a live root without invoking the transient reader", () =>
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

      assert.equal(transientSubagentHistoryRead.mock.calls.length, 0);
      assert.deepEqual(runtime.readSubagentThreadImpl.mock.calls[0], [childId]);
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
      assert.deepEqual(transientSubagentHistoryRead.mock.calls[0]?.[0], {
        binaryPath: "codex",
        appServerCwd: path.join(process.cwd(), "userdata"),
        rootProviderThreadId: "provider-root-that-ended",
        subagentThreadId: childId,
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
      runtime.readSubagentThreadImpl.mockRejectedValueOnce(
        new CodexErrors.CodexAppServerTransportError({
          detail: `transport rejected ${childId}: ${sentinels[3]}`,
          cause: upstreamCause,
        }),
      );

      const readSubagentDetail = adapter.readSubagentDetail;
      assert.ok(readSubagentDetail);
      const result = yield* readSubagentDetail(threadId, childId).pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      assert.equal(result.failure._tag, "ProviderSubagentDetailReadError");
      if (result.failure._tag !== "ProviderSubagentDetailReadError") return;
      assert.equal(result.failure.reason, "provider-transport-unavailable");
      assert.equal(result.failure.stack, undefined);

      const serialized = JSON.stringify({
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
        serviceTier: "fast",
      });
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
      const serializedRuntimeInput = JSON.stringify(runtime.steerTurnImpl.mock.calls[0]?.[0]);
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
        serviceTier: "fast",
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

function startLifecycleRuntime() {
  return Effect.gen(function* () {
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
        JSON.stringify(firstEvent.value.raw),
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

  it.effect("maps retryable Codex error notifications to runtime.warning", () =>
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
          threadId: "thread-1",
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
      assert.equal(firstEvent.value.payload.message, "Reconnecting... 2/5");
    }),
  );

  it.effect("maps terminal Codex subagent errors to work-log warnings", () =>
    Effect.gen(function* () {
      const { adapter, runtime } = yield* startLifecycleRuntime();
      const firstEventFiber = yield* Stream.runHead(adapter.streamEvents).pipe(Effect.forkChild);

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

      const firstEvent = yield* Fiber.join(firstEventFiber);
      assert.equal(firstEvent._tag, "Some");
      if (firstEvent._tag !== "Some") {
        return;
      }
      assert.equal(firstEvent.value.type, "runtime.warning");
      if (firstEvent.value.type !== "runtime.warning") {
        return;
      }
      assert.equal(firstEvent.value.turnId, "turn-parent");
      assert.equal(
        firstEvent.value.payload.message,
        "Selected model is at capacity. Please try a different model.",
      );
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
      const serializedEvent = JSON.stringify(firstEvent.value);
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
      assert.equal(JSON.stringify(firstEvent.value).includes('"messageId"'), false);
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
      assert.equal(JSON.stringify(firstEvent.value).includes('"messageId"'), false);
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
        JSON.stringify(firstEvent.value.raw),
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
        JSON.stringify(events),
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
      assert.doesNotMatch(JSON.stringify(terminal.value), /provider-adapter-stop-/u);
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
      assert.doesNotMatch(JSON.stringify(events), /provider-(?:child|reused|account|message)/u);
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
      assert.doesNotMatch(JSON.stringify(taskTerminal), /provider-(?:error|terminal)-/u);
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
      assert.doesNotMatch(JSON.stringify(events[1]), /provider-complete-/u);
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

      const mappedEventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 3)).pipe(
        Effect.forkChild,
      );
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
      assert.doesNotMatch(contents, /native-log-secret/);
    } finally {
      if (!scopeClosed) {
        yield* Scope.close(scope, Exit.void);
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }),
);
