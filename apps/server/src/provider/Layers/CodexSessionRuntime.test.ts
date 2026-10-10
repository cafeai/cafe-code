import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as Toml from "toml";
import { canonicalizeCodexSubagentDetail } from "./CodexAdapter.ts";
import { makeCodexChildUsageAccounting } from "../codexChildUsageAccounting.ts";
import { observeCodexServiceTier, type CodexServiceTierSnapshot } from "../codexServiceTier.ts";

import { it as effectIt } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, it, vi } from "vitest";
import {
  MessageId,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderItemId,
  SubagentRuntimeId,
  type ProviderSession,
  type ProviderUserInputAnswers,
  ThreadId,
  TurnId,
} from "@cafecode/contracts";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as CodexRpc from "effect-codex-app-server/rpc";
import * as EffectCodexSchema from "effect-codex-app-server/schema";

import {
  CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
  CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
} from "../CodexDeveloperInstructions.ts";
import {
  CODEX_SUMMARY_HISTORY_MAX_PAGES,
  CODEX_SUMMARY_HISTORY_MAX_TURNS,
  CODEX_SUMMARY_HISTORY_PAGE_TURN_LIMIT,
  CODEX_SUBAGENT_HISTORY_MAX_INCOMING_LINE_BYTES,
  CODEX_SUBAGENT_HISTORY_MAX_ITEMS,
  CODEX_SUBAGENT_HISTORY_MAX_PAGES,
  CODEX_SUBAGENT_HISTORY_MAX_PUBLIC_BYTES,
  CODEX_SUBAGENT_HISTORY_PAGE_ITEM_LIMIT,
  CODEX_SUBAGENT_SUMMARY_PAGE_TURN_LIMIT,
  CODEX_SUBAGENT_SUMMARY_MAX_TURNS,
  CODEX_PENDING_STEER_UNRESOLVED_CAPACITY,
  CODEX_RESUME_CHILD_RECONCILIATION_LIMIT,
  CODEX_CHILD_ACTIVITY_RECEIVER_LIMIT,
  CODEX_CHILD_CONVERSATION_ROUTE_LIMIT,
  acknowledgeCodexPendingSteerProcessing,
  acknowledgeCodexSteerLifecycleBoundary,
  acknowledgeCodexTurnStartLifecycleBoundary,
  acknowledgeCodexReasoningEffortRequest,
  acceptsCodexChildNotification,
  admitCodexTurnStartLifecycleBoundary,
  assertCodexFailedRootContinuationBoundary,
  commitCodexRootErrorLifecycleBoundary,
  readCodexRootTurnFailure,
  admitCodexPendingSteerProcessing,
  admitCodexReasoningEffortRequest,
  buildCodexAppServerArgs,
  buildCodexChildActivityNotifications,
  buildCodexActiveContextCompactionSteerError,
  buildCodexPendingSteerCapacityError,
  buildCodexThreadSnapshotBackfillEvents,
  buildTurnStartParams,
  buildTurnSteerParams,
  awaitCodexUserInputResolution,
  claimCodexSnapshotBackfillWatcher,
  claimCodexRestartedSteerProcessingObservation,
  codexAggregateNotificationMethod,
  codexAggregateTurnHasUnfinishedChildren,
  codexSuccessfulRootSnapshotIsBlocked,
  commitCodexAggregateRootCompletion,
  commitCodexChildConversationNotification,
  canReopenCodexAggregateRootCompletion,
  reconcileCodexAggregateRootCompletion,
  readCodexAggregateRootCompletion,
  readCodexRootTurnCompletion,
  observeCodexRootTurnStartedLifecycleBoundary,
  reconcileCodexNoActiveSteerLifecycleBoundary,
  rejectCodexTurnStartLifecycleBoundary,
  requestCodexManualCompaction,
  codexChildConversationThreadIdsForTurn,
  codexElapsedDelayMilliseconds,
  codexElapsedDelayRemainingMilliseconds,
  codexTerminalSessionPatch,
  codexSubagentProjectionMethod,
  isRecoverableThreadResumeError,
  isCodexContextCompactionItemType,
  isCodexChildConversationWorkNotification,
  isCodexPrivateMetadataNotification,
  isCodexUserMessageItemType,
  isTerminalCodexChildThreadReadError,
  openCodexThread,
  observeCodexThreadOpenReasoningEffort,
  observeCodexThreadSettingsReasoningEffort,
  prunePendingSteerProcessing,
  publishCodexTurnCompletionAfterLifecycleBoundary,
  readCodexBoundedSummaryThreadWithClient,
  readCodexBoundedThreadSnapshotWithClient,
  readCodexChildLivenessSnapshotWithClient,
  readCodexExpectedActiveTurnMismatchActualTurnId,
  readCodexSubagentThreadWithInitializedClient,
  readCodexSubagentSummaryWithInitializedClient,
  CODEX_SUBAGENT_HISTORY_MAX_ANCESTRY_HOPS,
  readCodexSubagentThreadTransient,
  readCodexNotificationEmittedAtIso,
  readCodexNotificationRouteFields,
  readCodexSteerExpectedTurnMismatchActualTurnId,
  reconcileCodexTerminalSnapshotSteerLifecycle,
  rememberCodexChildConversationTurns,
  retargetCodexPendingSteerProcessing,
  resolveCodexSessionRuntimeSteerClientCorrelationId,
  resolveCodexThreadSettingsSessionModel,
  resolveCodexChildConversationNotification,
  sanitizeCodexProtocolDiagnosticPayload,
  shouldForwardCodexRootGoalNotification,
  selectCodexActiveSnapshotTurn,
  summarizeCodexAppServerChildProcesses,
  terminalizeCodexPendingSteerProcessing,
  updateCodexChildConversationLiveness,
  codexTreeIsIdleForConcurrencyChange,
  reconcileCodexChildLivenessSnapshots,
  reconcileCodexResumedChildSnapshot,
  seedCodexResumedChildConversations,
  makeCodexNotificationRetirementFence,
  makeCodexChildConversationAdmissionFence,
  makeCodexSubagentRuntimeGeneration,
  updateCodexActiveContextCompactions,
  updateCodexPendingSteerProcessingFromNotification,
  validateCodexSubagentThreadReadMetadata,
  type CodexInitializedSubagentHistoryReadClient,
  type CodexBoundedThreadSnapshotClient,
  type CodexPendingSteerProcessing,
  type CodexAggregateRootCompletion,
  type CodexReasoningEffortSnapshot,
  type CodexSubagentHistoryReadClient,
} from "./CodexSessionRuntime.ts";
import {
  buildCodexSteerClientCorrelationId,
  parseCodexSteerClientCorrelationId,
} from "../codexSteerCorrelation.ts";
const isCodexAppServerRequestError = Schema.is(CodexErrors.CodexAppServerRequestError);
const decodeMessageId = Schema.decodeUnknownSync(MessageId);

const publicEntry = (
  id: string,
  text = id,
  turnId = "child-turn",
): EffectCodexSchema.V2ThreadItemsListResponse__ThreadItemEntry => ({
  turnId,
  item: { type: "agentMessage", id, text, phase: "commentary" },
});

type AncestryMetadata = Pick<
  EffectCodexSchema.V2ThreadReadResponse["thread"],
  "id" | "parentThreadId" | "sessionId" | "source"
>;
const childMetadata = (id: string, parentThreadId: string): AncestryMetadata => ({
  id,
  parentThreadId,
  sessionId: id,
  source: { subAgent: { thread_spawn: { depth: 1, parent_thread_id: parentThreadId } } },
});

it("binds native event generations to the originating runtime across resume and delayed publication", () => {
  const original = makeCodexSubagentRuntimeGeneration();
  const replacement = makeCodexSubagentRuntimeGeneration();
  assert.match(
    original.subagentRuntimeId,
    /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u,
  );
  assert.notEqual(original.subagentRuntimeId, replacement.subagentRuntimeId);
  const event = {
    id: EventId.make("generation-event"),
    kind: "notification" as const,
    provider: ProviderDriverKind.make("codex"),
    threadId: ThreadId.make("same-resumed-cafe-thread"),
    createdAt: "2026-10-04T00:00:00.000Z",
    method: "codex.subagent/threadStatusChanged",
    payload: { threadId: "same-native-child", status: { type: "active" } },
  };
  assert.equal(original.stampEvent(event).subagentRuntimeId, original.subagentRuntimeId);
  assert.equal(replacement.stampEvent(event).subagentRuntimeId, replacement.subagentRuntimeId);
  // A queued old publisher remains bound to the original context even if an
  // input envelope attempts to supply the replacement identity.
  assert.equal(
    original.stampEvent({ ...event, subagentRuntimeId: replacement.subagentRuntimeId })
      .subagentRuntimeId,
    original.subagentRuntimeId,
  );
  assert.equal(
    original.stampEvent({ ...event, kind: "session", method: "session/exited" }).subagentRuntimeId,
    original.subagentRuntimeId,
  );
});

effectIt.effect(
  "denies retirement after a child notification is dequeued but before its handler binds work",
  () =>
    Effect.gen(function* () {
      const closed = yield* Ref.make(false);
      const semaphore = yield* Semaphore.make(1);
      const fence = yield* makeCodexNotificationRetirementFence({ closed, semaphore });
      const queue = yield* Queue.unbounded<string>();
      const handlerEntered = yield* Deferred.make<void>();
      const releaseHandler = yield* Deferred.make<void>();
      fence.observeIncomingData();
      assert.equal(fence.isSettled(), false);
      fence.observeIncomingDataProcessed(true);
      assert.equal(fence.isSettled(), false);
      fence.observeIncomingData();
      fence.observeIncomingDataProcessed(false);
      assert.equal(fence.isSettled(), true);
      // Native protocol receipt precedes both its raw stream queue and Cafe's
      // relay. Before the relay starts, that earlier handoff is already fenced.
      fence.observeReceived();
      assert.equal(yield* fence.pendingCount, 1);
      yield* fence.admit(Queue.offer(queue, "turn/started"));
      const notification = yield* Queue.take(queue);
      const handling = yield* fence
        .handle(
          Effect.gen(function* () {
            assert.equal(notification, "turn/started");
            yield* Deferred.succeed(handlerEntered, undefined);
            // Mirrors observation/native logging before the child liveness write.
            yield* Deferred.await(releaseHandler);
          }),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(handlerEntered);
      assert.equal(yield* Queue.size(queue), 0);
      const proof = {
        session: {
          threadId: ThreadId.make("inflight-parent"),
          provider: ProviderDriverKind.make("codex"),
          status: "ready" as const,
          runtimeMode: "full-access" as const,
          createdAt: "2026-10-03T00:00:00.000Z",
          updatedAt: "2026-10-03T00:00:00.000Z",
        },
        rootStartPending: false,
        compactionPending: false,
        unsettledCount: 0,
        routes: new Map<string, TurnId>(),
        children: new Map(),
        queuedNotificationCount: yield* fence.pendingCount,
      };
      assert.equal(codexTreeIsIdleForConcurrencyChange(proof), false);
      yield* Deferred.succeed(releaseHandler, undefined);
      yield* Fiber.join(handling);
      assert.equal(yield* fence.pendingCount, 0);
      // Once retirement reserves the shared fence, late callbacks cannot enqueue.
      yield* semaphore.withPermits(1)(Ref.set(closed, true));
      yield* fence.admit(Queue.offer(queue, "late-child"));
      assert.equal(yield* Queue.size(queue), 0);
      assert.equal(yield* fence.pendingCount, 0);
    }),
);

it("requires native root and every descendant to be conclusively idle before concurrency retirement", () => {
  const parent = TurnId.make("idle-retirement-parent");
  const session = {
    threadId: ThreadId.make("idle-retirement-thread"),
    provider: ProviderDriverKind.make("codex"),
    status: "ready" as const,
    runtimeMode: "full-access" as const,
    createdAt: "2026-10-03T00:00:00.000Z",
    updatedAt: "2026-10-03T00:00:00.000Z",
  };
  const child = {
    parentTurnId: parent,
    state: "inactive" as const,
    observedAt: session.createdAt,
    method: "turn/completed",
  };
  const proof = {
    session,
    rootStartPending: false,
    compactionPending: false,
    unsettledCount: 0,
    queuedNotificationCount: 0,
    routes: new Map([["child", parent]]),
    children: new Map([["child", child]]),
  };
  assert.equal(codexTreeIsIdleForConcurrencyChange(proof), true);
  for (const patch of [
    { rootStartPending: true },
    { compactionPending: true },
    { unsettledCount: 1 },
    { queuedNotificationCount: 1 },
    { admissionIncomplete: true },
    { session: { ...session, status: "running" as const } },
    { session: { ...session, activeTurnId: parent } },
    { children: new Map() },
    { children: new Map([["child", { ...child, state: "active" as const }]]) },
    { children: new Map([["child", { ...child, state: "unknown" as const }]]) },
    { children: new Map([["child", { ...child, parentTurnId: TurnId.make("different-parent") }]]) },
  ])
    assert.equal(codexTreeIsIdleForConcurrencyChange({ ...proof, ...patch }), false);
});

describe("Codex bounded child route admission", () => {
  it("retains exact owners across multiple batches and never evicts at the lifetime ceiling", () => {
    const firstOwner = TurnId.make("first-owner");
    const laterOwner = TurnId.make("later-owner");
    const routes = new Map<string, TurnId>();
    for (
      let offset = 0;
      offset < CODEX_CHILD_CONVERSATION_ROUTE_LIMIT;
      offset += CODEX_CHILD_ACTIVITY_RECEIVER_LIMIT
    ) {
      assert.equal(
        rememberCodexChildConversationTurns(
          routes,
          {
            method: "item/started",
            params: {
              threadId: "root",
              item: {
                type: "collabAgentToolCall",
                receiverThreadIds: Array.from(
                  { length: CODEX_CHILD_ACTIVITY_RECEIVER_LIMIT },
                  (_, index) => `child-${offset + index}`,
                ),
              },
            },
          },
          firstOwner,
          "root",
        ),
        false,
      );
    }
    assert.equal(routes.size, CODEX_CHILD_CONVERSATION_ROUTE_LIMIT);
    assert.equal(
      rememberCodexChildConversationTurns(
        routes,
        {
          method: "item/completed",
          params: {
            threadId: "root",
            item: {
              type: "collabAgentToolCall",
              receiverThreadIds: ["child-0", "root", "unadmitted-child"],
            },
          },
        },
        laterOwner,
        "root",
      ),
      true,
    );
    assert.equal(routes.size, CODEX_CHILD_CONVERSATION_ROUTE_LIMIT);
    assert.equal(routes.get("child-0"), firstOwner);
    assert.equal(routes.get(`child-${CODEX_CHILD_CONVERSATION_ROUTE_LIMIT - 1}`), firstOwner);
    assert.equal(routes.has("root"), false);
    assert.equal(routes.has("unadmitted-child"), false);
    // Repeated references and explicit reuse never consume another slot or
    // rebind a terminal/active owner's stable history identity.
    assert.equal(
      rememberCodexChildConversationTurns(
        routes,
        {
          method: "item/started",
          params: {
            threadId: "root",
            item: {
              type: "subAgentActivity",
              kind: "started",
              agentThreadId: "child-0",
              agentPath: "/root/reused",
            },
          },
        },
        laterOwner,
        "root",
      ),
      false,
    );
    assert.equal(routes.get("child-0"), firstOwner);
  });

  it("marks a truncated receiver envelope incomplete without scanning or admitting its tail", () => {
    const routes = new Map<string, TurnId>();
    const receiverThreadIds = Array.from(
      { length: CODEX_CHILD_ACTIVITY_RECEIVER_LIMIT },
      (_, index) => `child-${index}`,
    );
    Object.defineProperty(receiverThreadIds, CODEX_CHILD_ACTIVITY_RECEIVER_LIMIT, {
      get: () => {
        throw new Error("Unbounded receiver tail must not be read");
      },
    });
    assert.equal(
      rememberCodexChildConversationTurns(
        routes,
        {
          method: "item/started",
          params: { threadId: "root", item: { type: "collabAgentToolCall", receiverThreadIds } },
        },
        TurnId.make("owner"),
        "root",
      ),
      true,
    );
    assert.equal(routes.size, CODEX_CHILD_ACTIVITY_RECEIVER_LIMIT);
    assert.equal(routes.has(`child-${CODEX_CHILD_ACTIVITY_RECEIVER_LIMIT}`), false);
  });

  it("bounds reconnect additions against the same lifetime route capacity", () => {
    const priorOwner = TurnId.make("prior-owner");
    const routes = new Map(
      Array.from(
        { length: CODEX_CHILD_CONVERSATION_ROUTE_LIMIT - 1 },
        (_, index) => [`prior-${index}`, priorOwner] as const,
      ),
    );
    const result = seedCodexResumedChildConversations({
      providerThread: makeCodexResumeChildSnapshot(["new-child", "overflow-child", "prior-0"]),
      routes,
      children: new Map(),
      observedAt: "2026-10-04T00:00:00.000Z",
    });
    assert.equal(result.routes.size, CODEX_CHILD_CONVERSATION_ROUTE_LIMIT);
    assert.equal(result.routes.get("prior-0"), priorOwner);
    assert.equal(result.routes.has("overflow-child"), false);
    assert.equal(result.children.get("new-child")?.state, "unknown");
    assert.equal(result.overflowed, true);
    assert.equal(result.inconclusive, true);
    assert.equal(routes.size, CODEX_CHILD_CONVERSATION_ROUTE_LIMIT - 1);
  });

  effectIt.effect(
    "quarantines unknown child frames only after sticky overflow and reports once",
    () =>
      Effect.gen(function* () {
        let diagnostics = 0;
        const fence = yield* makeCodexChildConversationAdmissionFence(
          Effect.sync(() => {
            diagnostics += 1;
          }),
        );
        const owner = TurnId.make("known-owner");
        const routes = new Map([["known-child", owner]]);
        const originalRoutes = new Map(routes);
        const children = updateCodexChildConversationLiveness(
          new Map(),
          routes,
          {
            method: "turn/started",
            params: { threadId: "known-child", turn: { id: "known-native" } },
          },
          "2026-10-04T00:00:00.000Z",
        );
        const input = {
          rootProviderThreadId: "root",
          routes,
          notification: {
            method: "turn/started",
            params: { threadId: "unknown-child", turn: { id: "unknown-native" } },
          },
        };
        assert.equal(yield* fence.acceptsNotification(input), true);
        assert.equal(yield* fence.isIncomplete, false);
        yield* fence.observeIncomplete(true);
        yield* fence.observeIncomplete(false); // A conclusive later discovery is not a reset.
        yield* fence.observeIncomplete(true);
        assert.equal(yield* fence.isIncomplete, true);
        assert.equal(diagnostics, 1);
        const projected: unknown[] = [];
        for (const notification of [
          input.notification,
          {
            method: "turn/completed",
            params: {
              threadId: "unknown-child",
              turn: { id: "unknown-native", status: "completed" },
            },
          },
          {
            method: "error",
            params: { threadId: "unknown-child", turnId: "unknown-native", willRetry: false },
          },
          {
            method: "item/completed",
            params: {
              threadId: "unknown-child",
              turnId: "unknown-native",
              item: { type: "reasoning", id: "reasoning" },
            },
          },
          {
            method: "item/started",
            params: {
              threadId: "unknown-child",
              turnId: "unknown-native",
              item: {
                type: "subAgentActivity",
                kind: "started",
                agentThreadId: "unowned-grandchild",
                agentPath: "/root/unknown/nested",
              },
            },
          },
        ]) {
          const admitted = yield* fence.acceptsNotification({ ...input, notification });
          assert.equal(admitted, false);
          // The runtime uses this boundary before callbacks, liveness, route
          // registration, private projection and ordinary publication alike.
          if (admitted) {
            rememberCodexChildConversationTurns(routes, notification, owner, "root");
            projected.push(
              updateCodexChildConversationLiveness(
                children,
                routes,
                notification,
                "2026-10-04T00:00:01.000Z",
              ),
            );
            projected.push(codexSubagentProjectionMethod(notification, children, routes));
            projected.push(buildCodexChildActivityNotifications(routes, children, notification));
            projected.push(codexAggregateNotificationMethod(notification.method, false));
          }
        }
        assert.deepEqual(projected, []);
        assert.deepEqual(routes, originalRoutes);
        const knownProgress = {
          method: "item/completed",
          params: {
            threadId: "known-child",
            turnId: "known-native",
            item: { type: "reasoning", id: "current" },
          },
        };
        assert.equal(
          yield* fence.acceptsNotification({ ...input, notification: knownProgress }),
          true,
        );
        assert.equal(
          codexSubagentProjectionMethod(knownProgress, children, routes),
          "codex.subagent/itemCompleted",
        );
        const rootProgress = {
          ...knownProgress,
          params: { ...knownProgress.params, threadId: "root", turnId: "root-native" },
        };
        assert.equal(
          yield* fence.acceptsNotification({ ...input, notification: rootProgress }),
          true,
        );
        assert.equal(
          resolveCodexChildConversationNotification(routes, rootProgress, "root"),
          undefined,
        );
        assert.equal(
          codexAggregateNotificationMethod(rootProgress.method, false),
          "item/completed",
        );
        assert.equal(
          yield* fence.acceptsNotification({
            ...input,
            notification: { method: "warning", params: {} },
          }),
          true,
        );
      }),
  );

  it("fences incomplete successful completion but preserves failure, interruption and explicit Stop", () => {
    const turnId = TurnId.make("overflow-root-turn");
    const hasUnfinishedChildren = codexAggregateTurnHasUnfinishedChildren(
      new Map(),
      new Map(),
      turnId,
      true,
    );
    assert.equal(hasUnfinishedChildren, true);
    for (const state of ["completed", "failed", "interrupted", "cancelled"] as const) {
      const result = reconcileCodexAggregateRootCompletion({
        completion: { turnId, state, observedAt: "2026-10-04T00:00:00.000Z" },
        completions: new Map(),
        managed: new Set(),
        pending: new Set(),
        hasUnfinishedChildren,
      });
      assert.equal(result.action, state === "completed" ? "defer" : "terminal");
      assert.equal(result.pending.has(String(turnId)), state === "completed");
    }
    // Explicit Stop remains the unconditional native scope teardown, not the
    // guarded automatic idle-retirement path. Existing lifecycle tests also
    // prove its closed reservation fences late native start/steer ACKs.
    const runtimeSource = readFileSync(
      new URL("./CodexSessionRuntime.ts", import.meta.url),
      "utf8",
    );
    const explicitClose = runtimeSource.slice(
      runtimeSource.indexOf("    const close = Effect.gen"),
      runtimeSource.indexOf("    const closeIfIdle = Effect.gen"),
    );
    assert.match(explicitClose, /Ref\.getAndSet\(closedRef, true\)/);
    assert.match(explicitClose, /yield\* closeReserved/);
    assert.doesNotMatch(explicitClose, /childAdmissionFence|codexTreeIsIdle|childConversation/);
  });

  effectIt.effect(
    "does not mutate a known child when overflow rejects the second admission check",
    () =>
      Effect.gen(function* () {
        const owner = TurnId.make("race-owner");
        const routes = new Map([["known-child", owner]]);
        const children = updateCodexChildConversationLiveness(
          new Map(),
          routes,
          {
            method: "turn/started",
            params: { threadId: "known-child", turn: { id: "known-native" } },
          },
          "2026-10-04T00:00:00.000Z",
        );
        const notification = {
          method: "item/completed",
          params: {
            threadId: "unknown-source",
            turnId: "unknown-native",
            item: {
              type: "subAgentActivity",
              id: "subagent-completed-known-native",
              kind: "completed",
              agentThreadId: "known-child",
              agentPath: "/root/known",
            },
          },
        };
        // This payload can terminalize a known receiver if mutation bypasses
        // source admission. Establish that the regression is not vacuous.
        assert.equal(
          updateCodexChildConversationLiveness(
            children,
            routes,
            notification,
            "2026-10-04T00:00:01.000Z",
          ).get("known-child")?.state,
          "inactive",
        );
        const routesRef = yield* Ref.make(routes);
        const childrenRef = yield* Ref.make(children);
        const semaphore = yield* Semaphore.make(1);
        const fence = yield* makeCodexChildConversationAdmissionFence(Effect.void);
        const firstAdmission = yield* Deferred.make<void>();
        const releaseObservation = yield* Deferred.make<void>();
        const frame = yield* Effect.gen(function* () {
          assert.equal(
            yield* semaphore.withPermits(1)(
              fence.acceptsNotification({ notification, routes, rootProviderThreadId: "root" }),
            ),
            true,
          );
          yield* Deferred.succeed(firstAdmission, undefined);
          yield* Deferred.await(releaseObservation);
          return yield* semaphore.withPermits(1)(
            Effect.gen(function* () {
              const currentRoutes = new Map(yield* Ref.get(routesRef));
              const currentChildren = yield* Ref.get(childrenRef);
              const admitted =
                (yield* fence.acceptsNotification({
                  notification,
                  routes: currentRoutes,
                  rootProviderThreadId: "root",
                })) && acceptsCodexChildNotification(currentChildren, notification, currentRoutes);
              assert.equal(admitted, false);
              // This is the runtime's complete mutation boundary, not a simulated
              // conditional reducer: rejection must write neither Ref nor clone.
              const committed = yield* commitCodexChildConversationNotification({
                admitted,
                routes: currentRoutes,
                children: currentChildren,
                routesRef,
                childrenRef,
                notification,
                parentTurnId: owner,
                rootProviderThreadId: "root",
                observedAt: "2026-10-04T00:00:02.000Z",
              });
              assert.equal(committed, undefined);
              assert.deepEqual(currentRoutes, routes);
              return committed;
            }),
          );
        }).pipe(Effect.forkChild);
        yield* Deferred.await(firstAdmission);
        // Detached discovery acquires the same mutation permit while observation
        // is pending and makes all unknown native sources inconclusive.
        yield* semaphore.withPermits(1)(fence.observeIncomplete(true));
        yield* Deferred.succeed(releaseObservation, undefined);
        assert.equal(yield* Fiber.join(frame), undefined);
        assert.equal(yield* Ref.get(routesRef), routes);
        assert.equal(yield* Ref.get(childrenRef), children);
        assert.equal((yield* Ref.get(childrenRef)).get("known-child")?.state, "active");
        assert.equal(
          (yield* Ref.get(childrenRef)).get("known-child")?.nativeTurnId,
          "known-native",
        );
      }),
  );

  effectIt.effect(
    "rejects root-only success snapshots after overflow before either projection or session retirement",
    () =>
      Effect.gen(function* () {
        const turnId = TurnId.make("snapshot-overflow-root");
        const semaphore = yield* Semaphore.make(1);
        const fence = yield* makeCodexChildConversationAdmissionFence(Effect.void);
        const snapshotWaiting = yield* Deferred.make<void>();
        const releaseSnapshot = yield* Deferred.make<void>();
        const published = yield* Queue.unbounded<string>();
        const pendingRef = yield* Ref.make(new Map<string, CodexPendingSteerProcessing>());
        const sessionRef = yield* Ref.make<ProviderSession>({
          threadId: ThreadId.make("snapshot-overflow-thread"),
          provider: ProviderDriverKind.make("codex"),
          status: "running",
          activeTurnId: turnId,
          runtimeMode: "full-access",
          createdAt: "2026-10-04T00:00:00.000Z",
          updatedAt: "2026-10-04T00:00:00.000Z",
        });
        // A root snapshot can start before overflow and finish after it. The
        // absence of a pending/managed aggregate record is not success authority.
        const snapshot = yield* Effect.gen(function* () {
          yield* Deferred.succeed(snapshotWaiting, undefined);
          yield* Deferred.await(releaseSnapshot);
          yield* semaphore.withPermits(1)(
            Effect.gen(function* () {
              const input = {
                status: "completed",
                turnId,
                unresolvedTurnIds: new Set<string>(),
                admissionIncomplete: yield* fence.isIncomplete,
              };
              assert.equal(codexSuccessfulRootSnapshotIsBlocked(input), true);
              if (!codexSuccessfulRootSnapshotIsBlocked(input))
                yield* Queue.offer(published, "turn/completed");
              if (!codexSuccessfulRootSnapshotIsBlocked(input))
                yield* reconcileCodexTerminalSnapshotSteerLifecycle({
                  semaphore: yield* Semaphore.make(1),
                  pendingRef,
                  sessionRef,
                  turnId,
                  turnStatus: "completed",
                  observedAt: "2026-10-04T00:00:02.000Z",
                });
            }),
          );
        }).pipe(Effect.forkChild);
        yield* Deferred.await(snapshotWaiting);
        yield* semaphore.withPermits(1)(fence.observeIncomplete(true));
        yield* Deferred.succeed(releaseSnapshot, undefined);
        yield* Fiber.join(snapshot);
        assert.equal(yield* Queue.size(published), 0);
        assert.equal((yield* Ref.get(sessionRef)).status, "running");
        assert.equal((yield* Ref.get(sessionRef)).activeTurnId, turnId);
        // Native terminal failure/interruption still has authority, independent
        // from both unknown children and a prior deferred successful snapshot.
        for (const status of ["failed", "interrupted", "cancelled"] as const) {
          assert.equal(
            codexSuccessfulRootSnapshotIsBlocked({
              status,
              turnId,
              unresolvedTurnIds: new Set([String(turnId)]),
              admissionIncomplete: true,
            }),
            false,
          );
        }
        assert.equal(
          codexSuccessfulRootSnapshotIsBlocked({
            status: "completed",
            turnId,
            unresolvedTurnIds: new Set(),
            admissionIncomplete: false,
          }),
          false,
        );
        assert.equal(
          codexSuccessfulRootSnapshotIsBlocked({
            status: "completed",
            turnId,
            unresolvedTurnIds: new Set([String(turnId)]),
            admissionIncomplete: false,
          }),
          true,
        );
        yield* reconcileCodexTerminalSnapshotSteerLifecycle({
          semaphore,
          pendingRef,
          sessionRef,
          turnId,
          turnStatus: "failed",
          errorMessage: "Synthetic root failure",
          observedAt: "2026-10-04T00:00:03.000Z",
        });
        assert.equal((yield* Ref.get(sessionRef)).status, "error");
        assert.equal((yield* Ref.get(sessionRef)).activeTurnId, undefined);
      }),
  );
});

it("publishes snapshot child terminal facts only while the exact sampled binding remains unchanged", () => {
  const turnId = TurnId.make("snapshot-parent");
  const child = {
    parentTurnId: turnId,
    state: "active" as const,
    observedAt: "2026-10-03T00:00:00.000Z",
    method: "turn/started",
  };
  const sampled = new Map([["child", child]]);
  const input = {
    turnId,
    observedAt: "2026-10-03T00:00:01.000Z",
    sampled,
    current: sampled,
    routes: new Map([["child", turnId]]),
    results: [
      { providerThreadId: "child", state: "inactive" as const, terminalStatus: "idle" as const },
    ],
  };
  const applied = reconcileCodexChildLivenessSnapshots(input);
  assert.equal(applied.liveness.get("child")?.state, "inactive");
  assert.deepEqual(applied.terminals, input.results);
  const restarted = new Map([["child", { ...child, observedAt: "2026-10-03T00:00:00.500Z" }]]);
  assert.deepEqual(
    reconcileCodexChildLivenessSnapshots({ ...input, current: restarted }).terminals,
    [],
  );
  assert.deepEqual(
    reconcileCodexChildLivenessSnapshots({
      ...input,
      routes: new Map([["child", TurnId.make("new-parent")]]),
    }).terminals,
    [],
  );
  assert.deepEqual(
    reconcileCodexChildLivenessSnapshots({
      ...input,
      results: [{ providerThreadId: "child", state: undefined }],
    }).terminals,
    [],
  );
});

it("confirms resumed activity once from an unchanged native metadata read, never from stale or failed observations", () => {
  const turnId = TurnId.make("resume-owner");
  const child = {
    parentTurnId: turnId,
    state: "unknown" as const,
    observedAt: "2026-10-04T00:00:00.000Z",
    method: "session-resume-child-discovery",
  };
  const sampled = new Map([["child", child]]);
  const input = {
    turnId,
    observedAt: "2026-10-04T00:00:01.000Z",
    sampled,
    current: sampled,
    routes: new Map([["child", turnId]]),
    results: [
      { providerThreadId: "child", state: "active" as const, threadName: "Current native worker" },
    ],
  };
  const confirmed = reconcileCodexChildLivenessSnapshots(input);
  assert.deepEqual(confirmed.activeConfirmations, input.results);
  assert.deepEqual(confirmed.terminals, []);
  assert.equal(confirmed.liveness.get("child")?.state, "active");
  assert.deepEqual(
    reconcileCodexChildLivenessSnapshots({
      ...input,
      sampled: confirmed.liveness,
      current: confirmed.liveness,
    }).activeConfirmations,
    [],
  );
  assert.deepEqual(
    reconcileCodexChildLivenessSnapshots({ ...input, current: new Map([["child", { ...child }]]) })
      .activeConfirmations,
    [],
  );
  assert.deepEqual(
    reconcileCodexChildLivenessSnapshots({
      ...input,
      routes: new Map([["child", TurnId.make("different-owner")]]),
    }).activeConfirmations,
    [],
  );
  assert.deepEqual(
    reconcileCodexChildLivenessSnapshots({
      ...input,
      results: [{ providerThreadId: "child", state: undefined }],
    }).activeConfirmations,
    [],
  );
});

it("keeps a child turn terminal across delayed item replay, while admitting an explicit new turn", () => {
  const parent = TurnId.make("replay-parent");
  const routes = new Map([["child", parent]]);
  let states = updateCodexChildConversationLiveness(
    new Map(),
    routes,
    {
      method: "turn/started",
      params: { threadId: "child", turn: { id: "first", status: "inProgress" } },
    },
    "2026-10-03T00:00:00.000Z",
  );
  states = updateCodexChildConversationLiveness(
    states,
    routes,
    {
      method: "turn/completed",
      params: { threadId: "child", turn: { id: "first", status: "completed" } },
    },
    "2026-10-03T00:00:01.000Z",
  );
  states = updateCodexChildConversationLiveness(
    states,
    routes,
    {
      method: "item/completed",
      params: {
        threadId: "child",
        turnId: "first",
        item: { type: "agentMessage", text: "delayed old item" },
      },
    },
    "2026-10-03T00:00:02.000Z",
  );
  assert.equal(states.get("child")?.state, "inactive");
  states = updateCodexChildConversationLiveness(
    states,
    routes,
    {
      method: "turn/started",
      params: { threadId: "child", turn: { id: "second", status: "inProgress" } },
    },
    "2026-10-03T00:00:03.000Z",
  );
  states = updateCodexChildConversationLiveness(
    states,
    routes,
    {
      method: "turn/completed",
      params: { threadId: "child", turn: { id: "first", status: "completed" } },
    },
    "2026-10-03T00:00:04.000Z",
  );
  assert.equal(states.get("child")?.state, "active");
  assert.equal(states.get("child")?.nativeTurnId, "second");
});

function makePendingSteerProcessingFixture(index: number): CodexPendingSteerProcessing {
  return {
    steerId: `steer-${index}`,
    clientCorrelationId: buildCodexSteerClientCorrelationId(`message-${index}`),
    providerThreadId: "provider-thread-1",
    turnId: TurnId.make("turn-active"),
    requestedAt: new Date(Date.UTC(2026, 4, 26) + index).toISOString(),
    promptByteLength: 10,
    attachmentCount: 0,
    warningCount: 0,
  };
}

function makeCodexSummaryTurnFixture(id: string) {
  return {
    id,
    status: "completed" as const,
    itemsView: "summary" as const,
    items: [],
    startedAt: null,
    completedAt: null,
    durationMs: null,
    error: null,
  };
}

function makeCodexMetadataResponseFixture(threadId: string) {
  return {
    thread: {
      id: threadId,
      parentThreadId: null,
      sessionId: "provider-session-1",
      source: "appServer" as const,
      status: { type: "idle" as const },
      turns: [],
    },
  };
}

function makeCodexResumeChildSnapshot(childIds: ReadonlyArray<string>) {
  return {
    ...makeCodexMetadataResponseFixture("resume-root").thread,
    turns: [
      {
        ...makeCodexSummaryTurnFixture("resume-latest-turn"),
        items: childIds.map((agentThreadId, index) => ({
          type: "subAgentActivity" as const,
          id: `resume-child-item-${index}`,
          kind: "started" as const,
          agentThreadId,
          agentPath: `/workers/${index}`,
        })),
      },
    ],
  };
}

describe("Codex bounded reconnect child reconciliation", () => {
  it("seeds only latest-turn exact references as unknown without rebinding older history", () => {
    const existingTurn = TurnId.make("previous-parent");
    const existingChild = {
      parentTurnId: existingTurn,
      state: "inactive" as const,
      observedAt: "2026-10-03T00:00:00.000Z",
      method: "turn/completed",
    };
    const latest = makeCodexResumeChildSnapshot(["new-child", "existing-child", "resume-root"]);
    const oldest = makeCodexResumeChildSnapshot(["old-unreferenced-child"]).turns[0]!;
    const snapshot = { ...latest, turns: [{ ...oldest, id: "old-turn" }, ...latest.turns] };
    const result = seedCodexResumedChildConversations({
      providerThread: snapshot,
      routes: new Map([["existing-child", existingTurn]]),
      children: new Map([["existing-child", existingChild]]),
      observedAt: "2026-10-03T00:00:01.000Z",
    });
    assert.equal(result.inconclusive, false);
    assert.equal(result.routes.has("old-unreferenced-child"), false);
    assert.equal(result.routes.has("resume-root"), false);
    assert.equal(result.routes.get("existing-child"), existingTurn);
    assert.equal(result.children.get("existing-child"), existingChild);
    assert.equal(result.children.get("new-child")?.state, "unknown");
    assert.equal(result.children.get("new-child")?.nativeTurnId, undefined);
    assert.deepEqual(result.parentTurnIds, [TurnId.make("resume-latest-turn")]);
    assert.equal(
      codexAggregateTurnHasUnfinishedChildren(
        result.routes,
        result.children,
        result.parentTurnIds[0]!,
      ),
      true,
    );
  });

  it("bounds discovered child reads and keeps overflow or omitted item bodies inconclusive", () => {
    const input = {
      providerThread: makeCodexResumeChildSnapshot(
        Array.from(
          { length: CODEX_RESUME_CHILD_RECONCILIATION_LIMIT + 2 },
          (_, index) => `bounded-child-${index}`,
        ),
      ),
      routes: new Map<string, TurnId>(),
      children: new Map(),
      observedAt: "2026-10-03T00:00:00.000Z",
    };
    const result = seedCodexResumedChildConversations(input);
    assert.equal(result.routes.size, CODEX_RESUME_CHILD_RECONCILIATION_LIMIT);
    assert.equal(result.overflowed, true);
    assert.equal(result.inconclusive, true);
    for (const itemsView of ["notLoaded" as const, undefined]) {
      const turn = input.providerThread.turns[0]!;
      const { itemsView: _itemsView, ...withoutView } = turn;
      const providerThread = {
        ...input.providerThread,
        turns: [itemsView === undefined ? withoutView : { ...withoutView, itemsView }],
      };
      const omitted = seedCodexResumedChildConversations({ ...input, providerThread });
      assert.equal(omitted.routes.size, 0);
      assert.equal(omitted.inconclusive, true);
    }
  });

  it("refuses late discovery after root generation, native identity or closed authority changes", () => {
    const epoch = Symbol("sampled root generation");
    const input = {
      providerThread: makeCodexResumeChildSnapshot(["child"]),
      expectedProviderThreadId: "resume-root",
      currentProviderThreadId: "resume-root",
      sampledEpoch: epoch,
      currentEpoch: epoch,
      closed: false,
      routes: new Map<string, TurnId>(),
      children: new Map(),
      observedAt: "2026-10-03T00:00:00.000Z",
    };
    assert.equal(reconcileCodexResumedChildSnapshot(input)?.inconclusive, false);
    for (const patch of [
      { currentEpoch: Symbol("new root generation") },
      { closed: true },
      { currentProviderThreadId: "new-native-root" },
      { providerThread: { ...input.providerThread, id: "foreign-native-root" } },
    ])
      assert.equal(reconcileCodexResumedChildSnapshot({ ...input, ...patch }), undefined);
    // The caller leaves its pre-read uncertainty reservation unchanged when
    // discovery is unavailable/stale. Empty routes are not an idle proof.
    assert.equal(
      codexTreeIsIdleForConcurrencyChange({
        session: {
          threadId: ThreadId.make("resume-cafe-thread"),
          provider: ProviderDriverKind.make("codex"),
          status: "ready",
          runtimeMode: "full-access",
          createdAt: input.observedAt,
          updatedAt: input.observedAt,
        },
        rootStartPending: false,
        compactionPending: false,
        unsettledCount: 1,
        queuedNotificationCount: 0,
        routes: input.routes,
        children: input.children,
      }),
      false,
    );
  });

  effectIt.effect(
    "repairs referenced children through one summary and exact metadata reads only",
    () =>
      Effect.gen(function* () {
        const calls: Array<{ method: string; payload: unknown }> = [];
        const root = makeCodexResumeChildSnapshot([
          "idle-child",
          "unloaded-child",
          "error-child",
          "foreign-child",
        ]);
        const request = ((method: string, payload: unknown) =>
          Effect.sync(() => {
            calls.push({ method, payload });
            const threadId = (payload as { threadId: string }).threadId;
            if (method === "thread/turns/list")
              return {
                data: [...root.turns, makeCodexSummaryTurnFixture("provider-ignored-limit")],
                nextCursor: "older-history-never-followed",
              };
            const response = makeCodexMetadataResponseFixture(threadId);
            if (threadId === "idle-child")
              return { thread: { ...response.thread, name: "Updated native child name" } };
            if (threadId === "foreign-child")
              return makeCodexMetadataResponseFixture("different-child");
            if (threadId === "unloaded-child")
              return { thread: { ...response.thread, status: { type: "notLoaded" } } };
            if (threadId === "error-child")
              return { thread: { ...response.thread, status: { type: "systemError" } } };
            return response;
          })) as CodexBoundedThreadSnapshotClient["request"];
        const snapshot = yield* readCodexBoundedThreadSnapshotWithClient({
          client: { request },
          providerThreadId: "resume-root",
        });
        assert.equal(snapshot.thread.turns.length, 1);
        assert.equal(snapshot.thread.turns[0]?.id, "resume-latest-turn");
        const seeded = seedCodexResumedChildConversations({
          providerThread: snapshot.thread,
          routes: new Map(),
          children: new Map(),
          observedAt: "2026-10-03T00:00:00.000Z",
        });
        const results = yield* Effect.forEach(
          Array.from(seeded.routes.keys()),
          (providerThreadId) =>
            readCodexChildLivenessSnapshotWithClient({ client: { request }, providerThreadId }),
        );
        const reconciled = reconcileCodexChildLivenessSnapshots({
          turnId: seeded.parentTurnIds[0]!,
          observedAt: "2026-10-03T00:00:01.000Z",
          sampled: seeded.children,
          current: seeded.children,
          routes: seeded.routes,
          results,
        });
        assert.deepEqual(
          reconciled.terminals.map((result) => result.terminalStatus),
          ["idle", "notLoaded", "systemError"],
        );
        assert.equal(reconciled.terminals[0]?.threadName, "Updated native child name");
        assert.equal(reconciled.liveness.get("foreign-child")?.state, "unknown");
        assert.deepEqual(calls, [
          { method: "thread/read", payload: { threadId: "resume-root", includeTurns: false } },
          {
            method: "thread/turns/list",
            payload: {
              threadId: "resume-root",
              limit: 1,
              sortDirection: "desc",
              itemsView: "summary",
            },
          },
          ...Array.from(seeded.routes.keys()).map((threadId) => ({
            method: "thread/read",
            payload: { threadId, includeTurns: false },
          })),
        ]);
      }),
  );

  effectIt.effect(
    "reuses exact liveness metadata for prospective accounting without another read",
    () =>
      Effect.gen(function* () {
        const calls: unknown[] = [];
        const response = makeCodexMetadataResponseFixture("child");
        const request = ((method: string, payload: unknown) =>
          Effect.sync(() => {
            calls.push({ method, payload });
            return {
              thread: {
                ...response.thread,
                parentThreadId: "root",
                model: "gpt-6.1-sol",
                source: { subAgent: { thread_spawn: { parent_thread_id: "root" } } },
                preview: "private content must not enter accounting",
                cwd: "/private/native",
              },
            };
          })) as CodexBoundedThreadSnapshotClient["request"];
        const result = yield* readCodexChildLivenessSnapshotWithClient({
          client: { request },
          providerThreadId: "child",
        });
        assert.deepEqual(result.usageMetadata, {
          id: "child",
          parentThreadId: "root",
          model: "gpt-6.1-sol",
        });
        const collector = makeCodexChildUsageAccounting();
        collector.observeMetadata(result.usageMetadata!, "root");
        const usage = (inputTokens: number) =>
          collector.observe({
            rootId: "root",
            routes: new Map([["child", "parent-turn"]]),
            method: "thread/tokenUsage/updated",
            payload: {
              threadId: "child",
              tokenUsage: {
                total: {
                  inputTokens,
                  cachedInputTokens: 0,
                  outputTokens: 0,
                  reasoningOutputTokens: 0,
                },
              },
            },
          });
        assert.equal(usage(100), undefined);
        assert.equal(usage(130)?.models[0]?.inputTokens, 30);
        assert.equal(usage(130), undefined);
        assert.deepEqual(calls, [
          { method: "thread/read", payload: { threadId: "child", includeTurns: false } },
        ]);
        const wrongIdentity = yield* readCodexChildLivenessSnapshotWithClient({
          client: { request },
          providerThreadId: "other",
        });
        assert.equal(wrongIdentity.usageMetadata, undefined);
      }),
  );

  effectIt.effect(
    "keeps unavailable native child metadata unknown rather than completing by age",
    () =>
      Effect.gen(function* () {
        const failing = {
          request: ((_method: string, _payload: unknown) =>
            Effect.fail(
              new CodexErrors.CodexAppServerTransportError({
                detail: "synthetic unavailable",
                cause: undefined,
              }),
            )) as CodexBoundedThreadSnapshotClient["request"],
        };
        assert.deepEqual(
          yield* readCodexChildLivenessSnapshotWithClient({
            client: failing,
            providerThreadId: "child",
          }),
          { providerThreadId: "child", state: undefined, terminalStatus: undefined },
        );
        const pending = {
          request: ((_method: string, _payload: unknown) =>
            Effect.never) as CodexBoundedThreadSnapshotClient["request"],
        };
        const read = yield* readCodexChildLivenessSnapshotWithClient({
          client: pending,
          providerThreadId: "child",
        }).pipe(Effect.forkChild);
        yield* TestClock.adjust("10 seconds");
        assert.deepEqual(yield* Fiber.join(read), { providerThreadId: "child", state: undefined });
      }),
  );
});

describe("Codex non-blocking user input", () => {
  effectIt.effect("submits an empty answer map after the upstream 120-second deadline", () =>
    Effect.gen(function* () {
      const answers = yield* Deferred.make<ProviderUserInputAnswers>();
      const autoResolutionSnoozed = yield* Deferred.make<void>();
      const resolutionFiber = yield* awaitCodexUserInputResolution({
        answers,
        autoResolutionSnoozed,
        isBlocking: false,
      }).pipe(Effect.forkChild);

      yield* TestClock.adjust("119 seconds");
      assert.equal(resolutionFiber.pollUnsafe(), undefined);
      yield* TestClock.adjust("1 second");

      assert.deepEqual(yield* Fiber.join(resolutionFiber), {
        answers: {},
        source: "automatic",
      });
    }),
  );

  effectIt.effect("permanently retires the deadline after the user interacts", () =>
    Effect.gen(function* () {
      const answers = yield* Deferred.make<ProviderUserInputAnswers>();
      const autoResolutionSnoozed = yield* Deferred.make<void>();
      const resolutionFiber = yield* awaitCodexUserInputResolution({
        answers,
        autoResolutionSnoozed,
        isBlocking: false,
      }).pipe(Effect.forkChild);

      yield* Deferred.succeed(autoResolutionSnoozed, undefined);
      yield* TestClock.adjust("5 minutes");
      assert.equal(resolutionFiber.pollUnsafe(), undefined);

      yield* Deferred.succeed(answers, { choice: "continue" });
      assert.deepEqual(yield* Fiber.join(resolutionFiber), {
        answers: { choice: "continue" },
        source: "explicit",
      });
    }),
  );
});

describe("Codex subagent thread ownership validation", () => {
  const root = {
    id: "root-provider-thread",
    parentThreadId: null,
    // The isolated native app-server returns the persisted thread ID here,
    // unlike the enriched shared session ID returned for a loaded thread.
    sessionId: "root-provider-thread",
    source: "appServer" as const,
  };
  const nestedChild = {
    id: "nested-provider-child",
    parentThreadId: "intermediate-provider-child",
    sessionId: "nested-provider-child",
    source: {
      subAgent: {
        thread_spawn: {
          depth: 2,
          parent_thread_id: "intermediate-provider-child",
        },
      },
    } as const,
  };
  const intermediateChild = {
    id: "intermediate-provider-child",
    parentThreadId: root.id,
    sessionId: "intermediate-provider-child",
    source: {
      subAgent: {
        thread_spawn: {
          depth: 1,
          parent_thread_id: root.id,
        },
      },
    } as const,
  };
  const ancestryFixture = (
    metadataById: ReadonlyMap<string, AncestryMetadata>,
    subagentThreadId = nestedChild.id,
  ) => {
    const calls: Array<{ method: string; payload: unknown }> = [];
    const request = ((method: string, payload: unknown) => {
      calls.push({ method, payload });
      if (method === "initialize") return Effect.succeed({ userAgent: "codex-test" });
      if (method === "thread/items/list") {
        return Effect.succeed({ data: [publicEntry("verified-update")], nextCursor: null });
      }
      assert.equal(method, "thread/read");
      const thread = metadataById.get((payload as { threadId: string }).threadId);
      return thread === undefined
        ? Effect.fail(CodexErrors.CodexAppServerRequestError.invalidRequest("Missing ancestor"))
        : Effect.succeed({ thread: { ...thread, turns: [] } });
    }) as CodexSubagentHistoryReadClient["request"];
    return {
      calls,
      read: readCodexSubagentThreadWithInitializedClient({
        client: { request, notify: () => Effect.void },
        rootProviderThreadId: root.id,
        subagentThreadId,
      }),
    };
  };

  const readPublicHistoryFixture = (
    readPage: (
      input: EffectCodexSchema.V2ThreadItemsListParams,
    ) => Effect.Effect<
      EffectCodexSchema.V2ThreadItemsListResponse,
      CodexErrors.CodexAppServerError
    >,
  ) => {
    const request = ((method: string, payload: unknown) => {
      if (method === "initialize") return Effect.succeed({ userAgent: "codex-test" });
      if (method === "thread/items/list") {
        return readPage(payload as EffectCodexSchema.V2ThreadItemsListParams);
      }
      if (method === "thread/read") {
        const threadId = (payload as { threadId: string }).threadId;
        const metadata = [root, nestedChild, intermediateChild].find(
          (thread) => thread.id === threadId,
        );
        assert.ok(metadata);
        return Effect.succeed({
          thread: { ...metadata, turns: [] },
        });
      }
      return Effect.die(new Error(`Unexpected history fixture method: ${method}`));
    }) as CodexSubagentHistoryReadClient["request"];
    return readCodexSubagentThreadWithInitializedClient({
      client: { request, notify: () => Effect.void },
      rootProviderThreadId: root.id,
      subagentThreadId: nestedChild.id,
    });
  };

  const readSummaryHistoryFixture = (
    readPage: (
      input: EffectCodexSchema.V2ThreadTurnsListParams,
    ) => Effect.Effect<
      EffectCodexSchema.V2ThreadTurnsListResponse,
      CodexErrors.CodexAppServerError
    >,
  ) => {
    const request = ((method: string, payload: unknown) => {
      if (method === "initialize") return Effect.succeed({ userAgent: "codex-test" });
      if (method === "thread/turns/list") {
        return readPage(payload as EffectCodexSchema.V2ThreadTurnsListParams);
      }
      if (method === "thread/read") {
        const threadId = (payload as { threadId: string }).threadId;
        const metadata = [root, nestedChild, intermediateChild].find(
          (thread) => thread.id === threadId,
        );
        assert.ok(metadata);
        return Effect.succeed({ thread: { ...metadata, turns: [] } });
      }
      return Effect.die(new Error(`Unexpected summary fixture method: ${method}`));
    }) as CodexSubagentHistoryReadClient["request"];
    return readCodexSubagentSummaryWithInitializedClient({
      client: { request, notify: () => Effect.void },
      rootProviderThreadId: root.id,
      subagentThreadId: nestedChild.id,
    });
  };

  effectIt.effect("filters full summary variants and overlapping identities in chronology", () =>
    Effect.gen(function* () {
      let calls = 0;
      const snapshot = yield* readSummaryHistoryFixture((input) => {
        calls += 1;
        assert.equal(input.threadId, nestedChild.id);
        assert.equal(input.itemsView, "summary");
        assert.equal(input.sortDirection, "desc");
        assert.equal(input.limit, CODEX_SUBAGENT_SUMMARY_PAGE_TURN_LIMIT);
        const newer = {
          ...makeCodexSummaryTurnFixture("newer"),
          items: [
            {
              type: "userMessage" as const,
              id: "prompt-id",
              content: [
                { type: "text" as const, text: "Public prompt", text_elements: [] },
                { type: "image" as const, url: "PRIVATE_IMAGE" },
              ],
            },
            {
              type: "reasoning" as const,
              id: "PRIVATE_ID",
              summary: ["PRIVATE_REASONING"],
              content: ["PRIVATE_REASONING"],
            },
            {
              type: "functionCallOutput" as const,
              id: "PRIVATE_OUTPUT_ID",
              name: "PRIVATE_TOOL",
              namespace: null,
              output: "PRIVATE_OUTPUT",
            },
            { ...publicEntry("answer-id", "Public answer").item, phase: "final_answer" as const },
          ],
        };
        return Effect.succeed(
          calls === 1
            ? { data: [newer], nextCursor: "older" }
            : {
                data: [
                  newer,
                  {
                    ...makeCodexSummaryTurnFixture("older"),
                    items: [publicEntry("answer-id", "Older public answer").item],
                  },
                ],
                nextCursor: null,
              },
        );
      });
      assert.equal(calls, 2);
      assert.deepEqual(snapshot.publicHistory, [
        { role: "assistant", text: "Older public answer", phase: "commentary" },
        { role: "user", text: "Public prompt" },
        { role: "assistant", text: "Public answer", phase: "final_answer" },
      ]);
      assert.deepEqual(snapshot.turns, []);
      assert.deepEqual(snapshot.publicActivities, []);
      assert.equal(snapshot.historyIncomplete, true);
      assert.equal(snapshot.activityHistoryIncomplete, true);
      assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE_|prompt-id|answer-id/);
    }),
  );

  effectIt.effect("bounds summary turns, broken cursors and untrusted page sizes", () =>
    Effect.gen(function* () {
      let calls = 0;
      const snapshot = yield* readSummaryHistoryFixture(() => {
        const page = calls++;
        return Effect.succeed({
          data: Array.from({ length: CODEX_SUBAGENT_SUMMARY_PAGE_TURN_LIMIT }, (_, index) => ({
            ...makeCodexSummaryTurnFixture(`turn-${page}-${index}`),
            items: [publicEntry(`item-${page}-${index}`).item],
          })),
          nextCursor: `page-${page}`,
        });
      });
      assert.equal(calls, 4);
      assert.equal(snapshot.publicHistory?.length, CODEX_SUBAGENT_SUMMARY_MAX_TURNS);
      for (const nextCursor of ["repeat", "", "x".repeat(4097)]) {
        let cursorCalls = 0;
        yield* readSummaryHistoryFixture(() => {
          cursorCalls += 1;
          return Effect.succeed({
            data: [makeCodexSummaryTurnFixture(`turn-${cursorCalls}`)],
            nextCursor,
          });
        });
        assert.equal(cursorCalls, nextCursor === "repeat" ? 2 : 1);
      }
      let oversizedCalls = 0;
      const oversized = yield* readSummaryHistoryFixture(() => {
        oversizedCalls += 1;
        return Effect.succeed({
          data: Array.from({ length: 5 }, (_, index) => ({
            ...makeCodexSummaryTurnFixture(`turn-${index}`),
            items: [publicEntry(`item-${index}`).item],
          })),
          nextCursor: "must-not-request",
        });
      });
      assert.equal(oversizedCalls, 1);
      assert.equal(oversized.publicHistory?.length, 4);
    }),
  );

  effectIt.effect(
    "bounds projected summary source bytes and hostile full-variant item counts",
    () =>
      Effect.gen(function* () {
        let calls = 0;
        const snapshot = yield* readSummaryHistoryFixture(() => {
          calls += 1;
          return Effect.succeed({
            data: [
              {
                ...makeCodexSummaryTurnFixture(`turn-${calls}`),
                items: [publicEntry(`item-${calls}`, "x".repeat(900 * 1024)).item],
              },
            ],
            nextCursor: `page-${calls}`,
          });
        });
        assert.equal(calls, 3);
        assert.equal(snapshot.publicHistory?.length, 2);
        assert.ok(
          snapshot.publicHistory!.reduce((sum, item) => sum + Buffer.byteLength(item.text), 0) <=
            CODEX_SUBAGENT_HISTORY_MAX_PUBLIC_BYTES,
        );
        let itemCalls = 0;
        const manyItems = yield* readSummaryHistoryFixture(() => {
          itemCalls += 1;
          return Effect.succeed({
            data: [
              {
                ...makeCodexSummaryTurnFixture("full-variant-turn"),
                items: Array.from(
                  { length: CODEX_SUBAGENT_HISTORY_MAX_ITEMS + 1 },
                  (_, index) => publicEntry(`item-${index}`).item,
                ),
              },
            ],
            nextCursor: "must-not-request",
          });
        });
        assert.equal(itemCalls, 1);
        assert.equal(manyItems.publicHistory?.length, CODEX_SUBAGENT_HISTORY_MAX_ITEMS);
        assert.equal(manyItems.publicHistory?.[0]?.text, "item-1");
      }),
  );

  effectIt.effect(
    "keeps activity-only history on wire exhaustion but rejects canonically invisible prose",
    () =>
      Effect.gen(function* () {
        for (const failure of [
          new CodexErrors.CodexAppServerIncomingMessageTooLargeError({ maxBytes: 123 }),
          new CodexErrors.CodexAppServerIncomingBudgetExceededError({ maxBytes: 456 }),
        ]) {
          let calls = 0;
          const snapshot = yield* readPublicHistoryFixture(() => {
            calls += 1;
            return calls === 1
              ? Effect.succeed({
                  data: [
                    {
                      turnId: "turn",
                      item: { type: "imageView" as const, id: "activity", path: "src/diagram.png" },
                    },
                  ],
                  nextCursor: "older",
                })
              : Effect.fail(failure);
          });
          assert.equal(snapshot.publicActivities?.length, 1);
          assert.deepEqual(snapshot.publicHistory, []);
          assert.equal(snapshot.historyIncomplete, true);
          assert.equal(snapshot.activityHistoryIncomplete, true);
          // The canonicalizer removes control/bidi scalars. A raw nonblank
          // string therefore is not evidence that the owner would see a row.
          for (const text of ["  ", "\u0000\u202e", "\t\r\n\u0080\u2069"]) {
            let emptyCalls = 0;
            const emptyFailure = yield* readPublicHistoryFixture(() => {
              emptyCalls += 1;
              return emptyCalls === 1
                ? Effect.succeed({ data: [publicEntry("empty", text)], nextCursor: "older" })
                : Effect.fail(failure);
            }).pipe(Effect.flip);
            assert.equal(emptyFailure._tag, "CodexSubagentHistorySummaryFallbackRequired");

            let summaryCalls = 0;
            const summaryFailure = yield* readSummaryHistoryFixture(() => {
              summaryCalls += 1;
              return summaryCalls === 1
                ? Effect.succeed({
                    data: [
                      {
                        ...makeCodexSummaryTurnFixture("empty-summary"),
                        items: [publicEntry("empty", text).item],
                      },
                    ],
                    nextCursor: "older",
                  })
                : Effect.fail(failure);
            }).pipe(Effect.flip);
            assert.equal(summaryFailure, failure);
          }
        }
      }),
  );

  effectIt.effect(
    "retains public commentary and final items in chronology without private fields",
    () =>
      Effect.gen(function* () {
        const calls: EffectCodexSchema.V2ThreadItemsListParams[] = [];
        const snapshot = yield* readPublicHistoryFixture((input) => {
          calls.push(input);
          return Effect.succeed(
            input.cursor === undefined
              ? {
                  data: [
                    {
                      ...publicEntry("reply-id", "Latest reply"),
                      startedAtMs: 1234,
                      completedAtMs: 1456,
                      item: {
                        type: "agentMessage",
                        id: "reply-id",
                        text: "Latest reply",
                        phase: "final_answer",
                      },
                    },
                    {
                      turnId: "child-turn",
                      item: {
                        id: "reasoning-id",
                        type: "reasoning",
                        summary: ["PRIVATE_REASONING"],
                        content: ["PRIVATE_REASONING"],
                      },
                    },
                    publicEntry("commentary-id", "New public commentary"),
                    {
                      turnId: "child-turn",
                      item: {
                        id: "tool-id",
                        type: "functionCallOutput",
                        name: "PRIVATE_TOOL",
                        namespace: null,
                        output: "PRIVATE_OUTPUT",
                      },
                    },
                  ],
                  nextCursor: "older-page",
                }
              : {
                  data: [
                    publicEntry(
                      "commentary-id",
                      "Old overlapping commentary must not replace newest",
                    ),
                    {
                      turnId: "child-turn",
                      item: {
                        id: "assignment-id",
                        type: "userMessage",
                        content: [
                          { type: "text", text: "Initial assignment" },
                          { type: "skill", name: "PRIVATE_NAME", path: "/PRIVATE_PATH" },
                          { type: "text", text: "Second public line" },
                        ],
                      },
                    },
                  ],
                  nextCursor: null,
                },
          );
        });
        assert.deepEqual(snapshot.publicHistory, [
          { role: "user", text: "Initial assignment\nSecond public line" },
          { role: "assistant", text: "New public commentary", phase: "commentary" },
          {
            role: "assistant",
            text: "Latest reply",
            phase: "final_answer",
            startedAtMs: 1234,
            completedAtMs: 1456,
          },
        ]);
        assert.deepEqual(snapshot.turns, []);
        assert.equal(snapshot.historyIncomplete, false);
        assert.equal(calls.length, 2);
        assert.equal(calls[1]?.cursor, "older-page");
        assert.ok(
          calls.every((call) => call.sortDirection === "desc" && call.threadId === nestedChild.id),
        );
        assert.doesNotMatch(
          JSON.stringify(snapshot.publicHistory),
          /PRIVATE_|-id|child-turn|overlapping/,
        );
      }),
  );

  effectIt.effect(
    "keeps reused item IDs separate across turns and rejects invalid timestamps",
    () =>
      Effect.gen(function* () {
        const snapshot = yield* readPublicHistoryFixture(() =>
          Effect.succeed({
            data: [
              {
                ...publicEntry("same-id", "Newest", "new-turn"),
                startedAtMs: -1,
                completedAtMs: Number.NaN,
              },
              {
                ...publicEntry("same-id", "Earlier", "old-turn"),
                startedAtMs: 1.5,
                completedAtMs: 8_640_000_000_000_001,
              },
              publicEntry("\ud800", "Distinct malformed identity one"),
              publicEntry("\ud801", "Distinct malformed identity two"),
            ],
            nextCursor: null,
          }),
        );
        assert.deepEqual(
          snapshot.publicHistory?.map((message) => message.text),
          [
            "Distinct malformed identity two",
            "Distinct malformed identity one",
            "Earlier",
            "Newest",
          ],
        );
        assert.ok(
          snapshot.publicHistory?.every(
            (message) => message.startedAtMs === undefined && message.completedAtMs === undefined,
          ),
        );
      }),
  );

  effectIt.effect(
    "projects typed child activities without retaining native payloads or reasoning",
    () =>
      Effect.gen(function* () {
        const command = (
          id: string,
          commandActions: EffectCodexSchema.V2ThreadItemsListResponse__CommandAction[],
        ): EffectCodexSchema.V2ThreadItemsListResponse__ThreadItem => ({
          type: "commandExecution",
          id,
          command: "PRIVATE_COMMAND",
          cwd: "/PRIVATE_CWD",
          commandActions,
          aggregatedOutput: "PRIVATE_OUTPUT",
          status: "completed",
        });
        const items: EffectCodexSchema.V2ThreadItemsListResponse__ThreadItem[] = [
          command("PRIVATE_COMMAND_ID", []),
          command("PRIVATE_READ_ID", [
            {
              type: "read",
              command: "PRIVATE_READ",
              name: "PRIVATE_NAME",
              path: "/.ssh/PRIVATE_PATH",
            },
          ]),
          command("PRIVATE_MIXED_ID", [
            {
              type: "read",
              command: "PRIVATE_READ",
              name: "PRIVATE_NAME",
              path: "/.ssh/PRIVATE_PATH",
            },
            { type: "unknown", command: "PRIVATE_WRITE" },
          ]),
          {
            type: "fileChange",
            id: "PRIVATE_EDIT_ID",
            status: "completed",
            changes: [
              { path: "/.ssh/PRIVATE_EDIT_PATH", kind: { type: "update" }, diff: "PRIVATE_DIFF" },
            ],
          },
          {
            type: "collabAgentToolCall",
            id: "PRIVATE_MESSAGE_ID",
            tool: "sendMessage",
            status: "completed",
            senderThreadId: "PRIVATE_SENDER",
            receiverThreadIds: ["PRIVATE_RECIPIENT"],
            prompt: "PRIVATE_MESSAGE",
            agentsStates: {},
          },
          {
            type: "collabAgentToolCall",
            id: "PRIVATE_WAIT_ID",
            tool: "wait",
            status: "completed",
            senderThreadId: "PRIVATE_SENDER",
            receiverThreadIds: ["PRIVATE_RECIPIENT"],
            agentsStates: {},
          },
          ...[
            "read_file",
            "apply_patch",
            "exec_command",
            "send_message",
            "followup_task",
            "PRIVATE_UNKNOWN_TOOL",
          ].map((tool, index) => ({
            type: "dynamicToolCall" as const,
            id: `PRIVATE_DYNAMIC_${index}`,
            tool,
            arguments: { secret: "PRIVATE_ARGS" },
            contentItems: [{ type: "inputText" as const, text: "PRIVATE_RESULT" }],
            status: "completed" as const,
          })),
          {
            type: "mcpToolCall",
            id: "PRIVATE_MCP_ID",
            tool: "PRIVATE_MCP_TOOL",
            server: "PRIVATE_SERVER",
            arguments: { secret: "PRIVATE_ARGS" },
            result: { content: ["PRIVATE_RESULT"] },
            status: "completed",
          },
          {
            type: "webSearch",
            id: "PRIVATE_SEARCH_ID",
            query: "PRIVATE_QUERY",
            results: ["PRIVATE_RESULT"],
          },
          { type: "imageView", id: "PRIVATE_IMAGE_ID", path: "/.ssh/PRIVATE_IMAGE_PATH" },
          {
            type: "reasoning",
            id: "PRIVATE_REASONING_ID",
            summary: ["PRIVATE_REASONING"],
            content: ["PRIVATE_REASONING"],
          },
          {
            type: "functionCallOutput",
            id: "PRIVATE_RESULT_ID",
            name: "PRIVATE_TOOL",
            output: "PRIVATE_RESULT",
          },
          { type: "agentMessage", id: "PRIVATE_ASSISTANT_ID", text: "Public progress" },
        ];
        const snapshot = yield* readPublicHistoryFixture(() =>
          Effect.succeed({
            data: items.map((item) => ({ turnId: "PRIVATE_TURN_ID", item })).toReversed(),
            nextCursor: null,
          }),
        );
        assert.deepEqual(
          snapshot.publicActivities?.map((activity) => activity.kind),
          [
            "command",
            "file_read",
            "command",
            "file_edit",
            "agent_message",
            "tool",
            "file_read",
            "file_edit",
            "command",
            "agent_message",
            "agent_message",
            "tool",
            "tool",
            "tool",
            "file_read",
          ],
        );
        assert.deepEqual(snapshot.publicHistory, [{ role: "assistant", text: "Public progress" }]);
        assert.doesNotMatch(
          JSON.stringify(snapshot),
          /PRIVATE_|reasoning|aggregatedOutput|arguments|receiverThreadIds|diff/,
        );
      }),
  );

  effectIt.effect(
    "projects useful typed and structured file-command details through the public adapter",
    () =>
      Effect.gen(function* () {
        const items: EffectCodexSchema.V2ThreadItemsListResponse__ThreadItem[] = [
          {
            type: "commandExecution",
            id: "native-command",
            command: "/bin/zsh -lc 'git status --short'",
            cwd: "/PRIVATE_CWD",
            commandActions: [],
            status: "completed",
            aggregatedOutput: "PRIVATE_OUTPUT",
          },
          {
            type: "commandExecution",
            id: "native-read",
            command: "PRIVATE_RAW_COMMAND",
            cwd: "/PRIVATE_CWD",
            commandActions: [
              {
                type: "read",
                command: "PRIVATE_READ_COMMAND",
                name: "PRIVATE_NAME",
                path: "src/Some File.ts",
              },
            ],
            status: "completed",
          },
          {
            type: "fileChange",
            id: "native-edit",
            status: "completed",
            changes: [{ path: "src/auth.ts", kind: { type: "update" }, diff: "PRIVATE_DIFF" }],
          },
          { type: "imageView", id: "native-image", path: "assets/日本語.png" },
          {
            type: "dynamicToolCall",
            id: "native-exec",
            tool: "exec_command",
            arguments: { cmd: "corepack yarn test", private: "PRIVATE_ARGS" },
            contentItems: [],
            status: "completed",
          },
          {
            type: "dynamicToolCall",
            id: "native-file",
            tool: "read_file",
            arguments: { path: "src/provider.ts", private: "PRIVATE_ARGS" },
            contentItems: [],
            status: "completed",
          },
          {
            type: "dynamicToolCall",
            id: "native-code",
            tool: "exec",
            arguments: { cmd: "PRIVATE_CODE", code: "PRIVATE_SOURCE" },
            contentItems: [],
            status: "completed",
          },
          {
            type: "dynamicToolCall",
            id: "native-unstructured",
            tool: "exec_command",
            arguments: "PRIVATE_RAW_ARGUMENTS",
            contentItems: [],
            status: "completed",
          },
        ];
        const snapshot = yield* readPublicHistoryFixture(() =>
          Effect.succeed({
            data: items.map((item) => ({ turnId: "PRIVATE_TURN", item })).toReversed(),
            nextCursor: null,
          }),
        );
        const detail = canonicalizeCodexSubagentDetail(snapshot);
        assert.deepEqual(
          detail.activities?.map(({ kind, detail: text }) => ({ kind, detail: text })),
          [
            { kind: "command", detail: "git status --short" },
            { kind: "file_read", detail: "src/Some File.ts" },
            { kind: "file_edit", detail: "src/auth.ts" },
            { kind: "file_read", detail: "assets/日本語.png" },
            { kind: "command", detail: "corepack yarn test" },
            { kind: "file_read", detail: "src/provider.ts" },
            { kind: "tool", detail: undefined },
            { kind: "command", detail: undefined },
          ],
        );
        assert.doesNotMatch(
          JSON.stringify(detail),
          /PRIVATE_|native-|arguments|aggregatedOutput|identityDigest/,
        );
      }),
  );

  effectIt.effect(
    "retains the newest bounded activity tail in chronology without counting overlap twice",
    () =>
      Effect.gen(function* () {
        const newest = 159;
        let pages = 0;
        const snapshot = yield* readPublicHistoryFixture((input) => {
          const pageIndex = Number(input.cursor ?? "0");
          pages += 1;
          const start = pageIndex * 31;
          const count = Math.min(32, newest - start + 1);
          return Effect.succeed({
            data: Array.from({ length: count }, (_, index) => {
              const sequence = newest - start - index;
              return {
                turnId: "PRIVATE_TURN",
                completedAtMs: 1_800_000_000_000 + sequence,
                item: {
                  type: "imageView" as const,
                  id: `PRIVATE_ITEM_${sequence}`,
                  path: "/.ssh/PRIVATE_IMAGE",
                },
              };
            }),
            nextCursor: start + count > newest ? null : String(pageIndex + 1),
          });
        });
        assert.equal(pages, 6);
        assert.deepEqual(snapshot.publicHistory, []);
        assert.equal(snapshot.publicActivities?.length, 128);
        assert.deepEqual(snapshot.publicActivities?.[0], {
          kind: "file_read",
          identityDigest: createHash("sha256")
            .update(JSON.stringify(["PRIVATE_TURN", "PRIVATE_ITEM_32"]), "utf16le")
            .digest("hex"),
          timestamp: new Date(1_800_000_000_032).toISOString(),
        });
        assert.deepEqual(snapshot.publicActivities?.at(-1), {
          kind: "file_read",
          identityDigest: createHash("sha256")
            .update(JSON.stringify(["PRIVATE_TURN", "PRIVATE_ITEM_159"]), "utf16le")
            .digest("hex"),
          timestamp: new Date(1_800_000_000_159).toISOString(),
        });
        assert.equal(snapshot.activityHistoryIncomplete, true);
        assert.equal(snapshot.historyIncomplete, false);
        assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE_/);
      }),
  );

  effectIt.effect(
    "keeps native activity keys stable as identical untimed tools slide through the bounded window",
    () =>
      Effect.gen(function* () {
        const readWindow = (newest: number) =>
          readPublicHistoryFixture((input) => {
            const offset = Number(input.cursor ?? "0");
            const count = Math.min(input.limit ?? 32, newest - offset + 1);
            return Effect.succeed({
              data: Array.from({ length: count }, (_, index) => ({
                turnId: "PRIVATE_STABLE_TURN",
                item: {
                  type: "imageView" as const,
                  id: `PRIVATE_STABLE_${newest - offset - index}`,
                  path: "/.ssh/PRIVATE_IMAGE",
                },
              })),
              nextCursor: offset + count > newest ? null : String(offset + count),
            });
          });
        const first = canonicalizeCodexSubagentDetail(yield* readWindow(128));
        const next = canonicalizeCodexSubagentDetail(yield* readWindow(129));
        const firstKeys = first.activities?.map((activity) => activity.key);
        const nextKeys = next.activities?.map((activity) => activity.key);
        assert.equal(firstKeys?.length, 128);
        assert.equal(nextKeys?.length, 128);
        assert.deepEqual(firstKeys?.slice(1), nextKeys?.slice(0, -1));
        assert.notEqual(firstKeys?.at(-1), nextKeys?.at(-1));
        assert.equal(new Set(nextKeys).size, 128);
        assert.ok(nextKeys?.every((key) => /^a[0-9a-f]{24}$/.test(key)));
        assert.ok(
          next.activities?.every(
            (activity) => activity.kind === "file_read" && activity.timestamp === undefined,
          ),
        );
        assert.doesNotMatch(JSON.stringify([first, next]), /PRIVATE_|identityDigest|path/);
      }),
  );

  effectIt.effect("bounds scanned private items and reports retained-history cutoff", () =>
    Effect.gen(function* () {
      let pageCalls = 0;
      const snapshot = yield* readPublicHistoryFixture((input) => {
        pageCalls += 1;
        assert.equal(input.limit, CODEX_SUBAGENT_HISTORY_PAGE_ITEM_LIMIT);
        return Effect.succeed({
          data: Array.from({ length: CODEX_SUBAGENT_HISTORY_PAGE_ITEM_LIMIT }, (_, index) => ({
            turnId: "private-turn",
            item: {
              type: "reasoning" as const,
              id: `${pageCalls}-${index}`,
              summary: ["PRIVATE"],
              content: [],
            },
          })),
          nextCursor: `page-${pageCalls}`,
        });
      });
      assert.equal(pageCalls, CODEX_SUBAGENT_HISTORY_MAX_PAGES);
      assert.equal(
        pageCalls * CODEX_SUBAGENT_HISTORY_PAGE_ITEM_LIMIT,
        CODEX_SUBAGENT_HISTORY_MAX_ITEMS,
      );
      assert.deepEqual(snapshot.publicHistory, []);
      assert.equal(snapshot.historyIncomplete, true);
    }),
  );

  effectIt.effect("bounds public bytes and overlarge provider pages without inventing counts", () =>
    Effect.gen(function* () {
      let calls = 0;
      const snapshot = yield* readPublicHistoryFixture(() => {
        calls += 1;
        return Effect.succeed({
          data: [publicEntry(`public-${calls}`, "x".repeat(512 * 1024))],
          nextCursor: `page-${calls}`,
        });
      });
      assert.equal(calls, 5);
      assert.equal(
        snapshot.publicHistory?.reduce(
          (sum, message) => sum + Buffer.byteLength(message.text, "utf8"),
          0,
        ),
        CODEX_SUBAGENT_HISTORY_MAX_PUBLIC_BYTES,
      );
      assert.equal(snapshot.historyIncomplete, true);
      const oversizedPage = yield* readPublicHistoryFixture(() =>
        Effect.succeed({
          data: Array.from({ length: CODEX_SUBAGENT_HISTORY_PAGE_ITEM_LIMIT + 1 }, (_, index) =>
            publicEntry(`message-${index}`),
          ),
          nextCursor: null,
        }),
      );
      assert.equal(oversizedPage.publicHistory?.length, CODEX_SUBAGENT_HISTORY_PAGE_ITEM_LIMIT);
      assert.equal(oversizedPage.historyIncomplete, true);
    }),
  );

  effectIt.effect("reports broken cursor progress as incomplete and fails real read errors", () =>
    Effect.gen(function* () {
      for (const nextCursor of ["repeated", "", "x".repeat(4097)]) {
        let calls = 0;
        const snapshot = yield* readPublicHistoryFixture(() => {
          calls += 1;
          return Effect.succeed({ data: [publicEntry(`item-${calls}`)], nextCursor });
        });
        assert.equal(calls, nextCursor === "repeated" ? 2 : 1);
        assert.equal(snapshot.historyIncomplete, true);
      }
      const emptyContinuation = yield* readPublicHistoryFixture(() =>
        Effect.succeed({ data: [], nextCursor: "more" }),
      );
      assert.equal(emptyContinuation.historyIncomplete, true);
      let calls = 0;
      const failure = CodexErrors.CodexAppServerRequestError.internalError(
        "Synthetic provider read failure",
      );
      const actual = yield* readPublicHistoryFixture(() => {
        calls += 1;
        return calls === 1
          ? Effect.succeed({ data: [publicEntry("newest")], nextCursor: "older" })
          : Effect.fail(failure);
      }).pipe(Effect.flip);
      assert.equal(actual, failure);
    }),
  );

  effectIt.effect(
    "isolates oversized history and suppresses malformed private wire diagnostics",
    () =>
      Effect.gen(function* () {
        let spawnCalls = 0;
        const logs: unknown[] = [];
        const logger = Logger.make(({ message }) => logs.push(message));
        const spawner = ChildProcessSpawner.make(() => {
          spawnCalls += 1;
          return Effect.succeed(
            ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(7001),
              exitCode: Effect.never,
              isRunning: Effect.succeed(true),
              kill: () => Effect.void,
              unref: Effect.succeed(Effect.void),
              stdin: Sink.drain,
              // Separate chunks ensure the malformed first line reaches the
              // decoder before the oversized second chunk closes the transport.
              stdout: Stream.make(
                new TextEncoder().encode('{"PRIVATE_MALFORMED_WIRE":\n'),
                new TextEncoder().encode(
                  "PRIVATE_WIRE".padEnd(CODEX_SUBAGENT_HISTORY_MAX_INCOMING_LINE_BYTES + 1, "x"),
                ),
              ),
              stderr: Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            }),
          );
        });
        const failure = yield* readCodexSubagentThreadTransient({
          binaryPath: "synthetic-provider-never-spawned",
          appServerCwd: "synthetic-cwd",
          rootProviderThreadId: root.id,
          subagentThreadId: nestedChild.id,
          environment: {},
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(References.MinimumLogLevel, "Debug"),
          Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
          Effect.flip,
        );
        assert.equal(spawnCalls, 1);
        assert.ok(failure instanceof CodexErrors.CodexAppServerIncomingMessageTooLargeError);
        assert.equal(failure.maxBytes, CODEX_SUBAGENT_HISTORY_MAX_INCOMING_LINE_BYTES);
        assert.doesNotMatch(JSON.stringify(failure), /PRIVATE_WIRE/);
        assert.deepEqual(logs, []);
      }),
  );

  it("accepts exact nested ancestry with different persisted session IDs", () => {
    assert.equal(
      validateCodexSubagentThreadReadMetadata({
        expectedRootThreadId: "root-provider-thread",
        expectedChildThreadId: "nested-provider-child",
        root,
        child: nestedChild,
        ancestors: [intermediateChild],
      }),
      undefined,
    );
  });

  it("rejects mismatched IDs, unproven ancestry, and inconsistent parent metadata", () => {
    assert.equal(
      validateCodexSubagentThreadReadMetadata({
        expectedRootThreadId: "different-root",
        expectedChildThreadId: "nested-provider-child",
        root,
        child: nestedChild,
      }),
      "root-identity-mismatch",
    );
    assert.equal(
      validateCodexSubagentThreadReadMetadata({
        expectedRootThreadId: "root-provider-thread",
        expectedChildThreadId: "different-child",
        root,
        child: nestedChild,
      }),
      "child-identity-mismatch",
    );
    assert.equal(
      validateCodexSubagentThreadReadMetadata({
        expectedRootThreadId: "root-provider-thread",
        expectedChildThreadId: "nested-provider-child",
        root,
        // Shared labels cannot substitute for the missing parent-chain proof.
        child: { ...nestedChild, sessionId: root.sessionId },
      }),
      "session-tree-mismatch",
    );
    assert.equal(
      validateCodexSubagentThreadReadMetadata({
        expectedRootThreadId: "root-provider-thread",
        expectedChildThreadId: "nested-provider-child",
        root,
        child: {
          ...nestedChild,
          source: {
            subAgent: {
              thread_spawn: {
                depth: 2,
                parent_thread_id: "wrong-immediate-parent",
              },
            },
          },
        },
      }),
      "parent-metadata-mismatch",
    );
    assert.equal(
      validateCodexSubagentThreadReadMetadata({
        expectedRootThreadId: "root-provider-thread",
        expectedChildThreadId: "nested-provider-child",
        root,
        child: { ...nestedChild, source: "appServer" },
      }),
      "missing-subagent-metadata",
    );
  });

  effectIt.effect("validates root and child metadata before reading bounded child history", () =>
    Effect.gen(function* () {
      const calls: Array<{ method: string; payload: unknown }> = [];
      const request = ((method: string, payload: unknown) =>
        Effect.sync(() => {
          calls.push({ method, payload });
          if (method === "initialize") {
            return { userAgent: "codex-test" };
          }
          if (method === "thread/items/list") {
            return {
              data: [
                {
                  turnId: "child-turn-1",
                  item: { id: "update-1", type: "agentMessage", text: "Public update" },
                },
              ],
              nextCursor: null,
            };
          }
          const requestedThreadId = (payload as { threadId: string }).threadId;
          const metadata = [root, nestedChild, intermediateChild].find(
            (thread) => thread.id === requestedThreadId,
          );
          assert.ok(metadata);
          return {
            thread: { ...metadata, turns: [] },
          };
        })) as CodexSubagentHistoryReadClient["request"];
      const notify = ((method: string, payload: unknown) =>
        Effect.sync(() => {
          calls.push({ method, payload });
        })) as CodexInitializedSubagentHistoryReadClient["notify"];

      const snapshot = yield* readCodexSubagentThreadWithInitializedClient({
        client: { request, notify },
        rootProviderThreadId: root.id,
        subagentThreadId: nestedChild.id,
      });

      assert.equal(snapshot.threadId, nestedChild.id);
      assert.deepEqual(
        calls.map((call) => call.method),
        [
          "initialize",
          "initialized",
          "thread/read",
          "thread/read",
          "thread/read",
          "thread/items/list",
        ],
      );
      assert.deepEqual(calls.slice(2), [
        { method: "thread/read", payload: { threadId: root.id, includeTurns: false } },
        { method: "thread/read", payload: { threadId: nestedChild.id, includeTurns: false } },
        {
          method: "thread/read",
          payload: { threadId: intermediateChild.id, includeTurns: false },
        },
        {
          method: "thread/items/list",
          payload: {
            threadId: nestedChild.id,
            limit: CODEX_SUBAGENT_HISTORY_PAGE_ITEM_LIMIT,
            sortDirection: "desc",
          },
        },
      ]);
      assert.deepEqual(snapshot.publicHistory, [{ role: "assistant", text: "Public update" }]);
      assert.equal(snapshot.historyIncomplete, false);
      assert.equal(
        calls.some((call) => call.method === "thread/resume"),
        false,
      );
      assert.equal(
        calls.some((call) => call.method === "thread/start"),
        false,
      );
    }),
  );

  effectIt.effect(
    "admits direct and nested persisted children only after exact ancestry proof",
    () =>
      Effect.gen(function* () {
        for (const nested of [false, true]) {
          const fixture = ancestryFixture(
            new Map<string, AncestryMetadata>([
              [root.id, root],
              [nestedChild.id, nested ? nestedChild : childMetadata(nestedChild.id, root.id)],
              [intermediateChild.id, intermediateChild],
            ]),
          );
          const snapshot = yield* fixture.read;
          assert.equal(snapshot.publicHistory?.length, 1);
          assert.deepEqual(
            fixture.calls
              .filter((call) => call.method === "thread/read")
              .map((call) => call.payload),
            [
              { threadId: root.id, includeTurns: false },
              { threadId: nestedChild.id, includeTurns: false },
              ...(nested ? [{ threadId: intermediateChild.id, includeTurns: false }] : []),
            ],
          );
          assert.equal(fixture.calls.at(-1)?.method, "thread/items/list");
          assert.ok(
            fixture.calls.every((call) =>
              ["initialize", "thread/read", "thread/items/list"].includes(call.method),
            ),
          );
        }
      }),
  );

  effectIt.effect("rejects foreign, cyclic, malformed, or unavailable ancestry before items", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<{
        readonly name: string;
        readonly child?: AncestryMetadata;
        readonly ancestor?: AncestryMetadata;
        readonly selectedId?: string;
        readonly expectedReason?: string;
      }> = [
        {
          name: "matching session label without descendant relationship",
          child: { ...nestedChild, sessionId: root.sessionId },
          ancestor: { ...root, id: intermediateChild.id },
          expectedReason: "missing-subagent-metadata",
        },
        {
          name: "self-selection",
          selectedId: root.id,
          expectedReason: "session-tree-mismatch",
        },
        {
          name: "self-cycle",
          child: childMetadata(nestedChild.id, nestedChild.id),
          expectedReason: "session-tree-mismatch",
        },
        {
          name: "multi-hop cycle",
          ancestor: childMetadata(intermediateChild.id, nestedChild.id),
          expectedReason: "session-tree-mismatch",
        },
        {
          name: "wrong requested child identity",
          child: { ...nestedChild, id: "wrong-child" },
          expectedReason: "child-identity-mismatch",
        },
        {
          name: "wrong requested ancestor identity",
          ancestor: { ...intermediateChild, id: "wrong-ancestor" },
          expectedReason: "child-identity-mismatch",
        },
        {
          name: "inconsistent duplicate ancestor parent",
          ancestor: { ...intermediateChild, parentThreadId: "foreign-root" },
          expectedReason: "parent-metadata-mismatch",
        },
        {
          name: "inconsistent duplicate child parent",
          child: { ...nestedChild, parentThreadId: "foreign-root" },
          expectedReason: "parent-metadata-mismatch",
        },
        {
          name: "non-binding subagent source",
          ancestor: { ...intermediateChild, source: { subAgent: "review" } },
          expectedReason: "missing-subagent-metadata",
        },
        {
          name: "oversized parent identity",
          child: childMetadata(nestedChild.id, "x".repeat(513)),
          expectedReason: "missing-subagent-metadata",
        },
        {
          name: "empty parent identity",
          child: childMetadata(nestedChild.id, " "),
          expectedReason: "missing-subagent-metadata",
        },
        { name: "missing ancestor" },
      ];
      for (const scenario of cases) {
        const metadata = new Map<string, AncestryMetadata>([
          [root.id, root],
          [nestedChild.id, scenario.child ?? nestedChild],
        ]);
        if (scenario.ancestor) metadata.set(intermediateChild.id, scenario.ancestor);
        const fixture = ancestryFixture(metadata, scenario.selectedId);
        const failure = yield* fixture.read.pipe(Effect.flip);
        if (scenario.expectedReason) {
          assert.equal(
            failure._tag,
            "CodexSessionRuntimeInvalidSubagentThreadError",
            scenario.name,
          );
          assert.ok("reason" in failure, scenario.name);
          assert.equal(failure.reason, scenario.expectedReason, scenario.name);
        } else {
          assert.equal(failure._tag, "CodexAppServerRequestError", scenario.name);
        }
        assert.equal(
          fixture.calls.some((call) => call.method === "thread/items/list"),
          false,
          scenario.name,
        );
        const requested = fixture.calls
          .filter((call) => call.method === "thread/read")
          .map((call) => (call.payload as { threadId: string }).threadId);
        assert.equal(new Set(requested).size, requested.length, scenario.name);
      }
    }),
  );

  effectIt.effect("accepts the ancestry budget boundary and fails closed beyond it", () =>
    Effect.gen(function* () {
      for (const depth of [
        CODEX_SUBAGENT_HISTORY_MAX_ANCESTRY_HOPS,
        CODEX_SUBAGENT_HISTORY_MAX_ANCESTRY_HOPS + 1,
      ]) {
        const metadata = new Map<string, AncestryMetadata>([[root.id, root]]);
        for (let index = 0; index < depth; index += 1) {
          const id = `child-${index}`;
          metadata.set(id, childMetadata(id, index + 1 === depth ? root.id : `child-${index + 1}`));
        }
        const fixture = ancestryFixture(metadata, "child-0");
        const exit = yield* fixture.read.pipe(Effect.exit);
        const permitted = depth === CODEX_SUBAGENT_HISTORY_MAX_ANCESTRY_HOPS;
        assert.equal(exit._tag, permitted ? "Success" : "Failure");
        assert.equal(
          fixture.calls.filter((call) => call.method === "thread/read").length,
          1 + CODEX_SUBAGENT_HISTORY_MAX_ANCESTRY_HOPS,
        );
        assert.equal(
          fixture.calls.some((call) => call.method === "thread/items/list"),
          permitted,
        );
      }
    }),
  );

  effectIt.effect("does not disclose the child id upstream when the exact root read fails", () =>
    Effect.gen(function* () {
      const requestMock = vi.fn((method: string, _payload: unknown) =>
        method === "initialize"
          ? Effect.succeed({ userAgent: "codex-test" })
          : Effect.fail(
              new CodexErrors.CodexAppServerTransportError({
                detail: "root history unavailable",
                cause: new Error("closed"),
              }),
            ),
      );
      const request = requestMock as unknown as CodexSubagentHistoryReadClient["request"];
      const notifyMock = vi.fn((_method: string, _payload: unknown) => Effect.void);
      const notify = notifyMock as unknown as CodexInitializedSubagentHistoryReadClient["notify"];

      const exit = yield* readCodexSubagentThreadWithInitializedClient({
        client: { request, notify },
        rootProviderThreadId: root.id,
        subagentThreadId: nestedChild.id,
      }).pipe(Effect.exit);

      assert.equal(exit._tag, "Failure");
      assert.equal(requestMock.mock.calls.length, 2);
      assert.equal(notifyMock.mock.calls.length, 1);
      assert.deepEqual(requestMock.mock.calls[1], [
        "thread/read",
        { threadId: root.id, includeTurns: false },
      ]);
    }),
  );

  effectIt.effect("rejects a substituted root before sending the child identity upstream", () =>
    Effect.gen(function* () {
      const fixture = ancestryFixture(new Map([[root.id, { ...root, id: "substituted-root" }]]));
      const failure = yield* fixture.read.pipe(Effect.flip);
      assert.equal(failure._tag, "CodexSessionRuntimeInvalidSubagentThreadError");
      assert.ok("reason" in failure);
      assert.equal(failure.reason, "root-identity-mismatch");
      assert.deepEqual(
        fixture.calls.map((call) => call.method),
        ["initialize", "thread/read"],
      );
      assert.deepEqual(fixture.calls[1], {
        method: "thread/read",
        payload: { threadId: root.id, includeTurns: false },
      });
    }),
  );
});

describe("Codex bounded lifecycle snapshots", () => {
  effectIt.effect(
    "reads metadata plus one summarized newest turn without full-history hydration",
    () =>
      Effect.gen(function* () {
        const calls: Array<{ method: string; payload: unknown }> = [];
        const request = ((method: string, payload: unknown) =>
          Effect.sync(() => {
            calls.push({ method, payload });
            if (method === "thread/read") {
              return {
                thread: {
                  id: "provider-thread-1",
                  parentThreadId: null,
                  sessionId: "provider-session-1",
                  source: "appServer",
                  status: { type: "active", activeFlags: [] },
                  turns: [],
                },
              };
            }
            if (method === "thread/turns/list") {
              return {
                data: [
                  {
                    id: "turn-latest",
                    status: "inProgress",
                    itemsView: "summary",
                    items: [],
                    startedAt: 1_788_174_288,
                    completedAt: null,
                    durationMs: null,
                    error: null,
                  },
                ],
                nextCursor: "older-turns",
              };
            }
            throw new Error(`Unexpected method: ${method}`);
          })) as CodexBoundedThreadSnapshotClient["request"];

        const response = yield* readCodexBoundedThreadSnapshotWithClient({
          client: { request },
          providerThreadId: "provider-thread-1",
        });

        assert.deepEqual(calls, [
          {
            method: "thread/read",
            payload: { threadId: "provider-thread-1", includeTurns: false },
          },
          {
            method: "thread/turns/list",
            payload: {
              threadId: "provider-thread-1",
              limit: 1,
              sortDirection: "desc",
              itemsView: "summary",
            },
          },
        ]);
        assert.equal(response.thread.turns.length, 1);
        assert.equal(response.thread.turns[0]?.id, "turn-latest");
        assert.equal(
          calls.some(
            (call) =>
              call.method === "thread/read" &&
              (call.payload as { includeTurns?: boolean }).includeTurns === true,
          ),
          false,
        );
      }),
  );
});

describe("Codex bounded summary history", () => {
  effectIt.effect("paginates newest-first summaries and returns chronological turns", () =>
    Effect.gen(function* () {
      const calls: Array<{ method: string; payload: unknown }> = [];
      const request = ((method: string, payload: unknown) =>
        Effect.sync(() => {
          calls.push({ method, payload });
          if (method === "thread/read") {
            return makeCodexMetadataResponseFixture("provider-thread-1");
          }
          if (method === "thread/turns/list") {
            const cursor = (payload as { cursor?: string }).cursor;
            return cursor === undefined
              ? {
                  data: [
                    makeCodexSummaryTurnFixture("turn-3"),
                    makeCodexSummaryTurnFixture("turn-2"),
                  ],
                  nextCursor: "older-page",
                }
              : { data: [makeCodexSummaryTurnFixture("turn-1")], nextCursor: null };
          }
          throw new Error(`Unexpected method: ${method}`);
        })) as CodexBoundedThreadSnapshotClient["request"];

      const response = yield* readCodexBoundedSummaryThreadWithClient({
        client: { request },
        providerThreadId: "provider-thread-1",
      });

      assert.deepEqual(
        response.thread.turns.map((turn) => turn.id),
        ["turn-1", "turn-2", "turn-3"],
      );
      assert.deepEqual(calls, [
        {
          method: "thread/read",
          payload: { threadId: "provider-thread-1", includeTurns: false },
        },
        {
          method: "thread/turns/list",
          payload: {
            threadId: "provider-thread-1",
            limit: CODEX_SUMMARY_HISTORY_PAGE_TURN_LIMIT,
            sortDirection: "desc",
            itemsView: "summary",
          },
        },
        {
          method: "thread/turns/list",
          payload: {
            threadId: "provider-thread-1",
            limit: CODEX_SUMMARY_HISTORY_PAGE_TURN_LIMIT,
            sortDirection: "desc",
            itemsView: "summary",
            cursor: "older-page",
          },
        },
      ]);
      assert.equal(
        calls.some(
          (call) =>
            call.method === "thread/turns/list" &&
            (call.payload as { itemsView?: string }).itemsView === "full",
        ),
        false,
      );
    }),
  );

  effectIt.effect("fails closed when app-server repeats a pagination cursor", () =>
    Effect.gen(function* () {
      let turnsListCalls = 0;
      const request = ((method: string, _payload: unknown) =>
        Effect.sync(() => {
          if (method === "thread/read") {
            return makeCodexMetadataResponseFixture("provider-thread-1");
          }
          if (method === "thread/turns/list") {
            turnsListCalls += 1;
            return {
              data: [makeCodexSummaryTurnFixture(`turn-${turnsListCalls}`)],
              nextCursor: "repeated-cursor",
            };
          }
          throw new Error(`Unexpected method: ${method}`);
        })) as CodexBoundedThreadSnapshotClient["request"];

      const exit = yield* readCodexBoundedSummaryThreadWithClient({
        client: { request },
        providerThreadId: "provider-thread-1",
      }).pipe(Effect.exit);

      assert.equal(exit._tag, "Failure");
      assert.equal(turnsListCalls, 2);
    }),
  );

  effectIt.effect("enforces both page and retained-turn caps", () =>
    Effect.gen(function* () {
      let pageBoundCalls = 0;
      const pageBoundRequest = ((method: string, _payload: unknown) =>
        Effect.sync(() => {
          if (method === "thread/read") {
            return makeCodexMetadataResponseFixture("provider-thread-pages");
          }
          if (method === "thread/turns/list") {
            pageBoundCalls += 1;
            return {
              data: [makeCodexSummaryTurnFixture(`turn-${pageBoundCalls}`)],
              nextCursor: `cursor-${pageBoundCalls}`,
            };
          }
          throw new Error(`Unexpected method: ${method}`);
        })) as CodexBoundedThreadSnapshotClient["request"];
      const pageBoundResponse = yield* readCodexBoundedSummaryThreadWithClient({
        client: { request: pageBoundRequest },
        providerThreadId: "provider-thread-pages",
      });

      assert.equal(pageBoundCalls, CODEX_SUMMARY_HISTORY_MAX_PAGES);
      assert.equal(pageBoundResponse.thread.turns.length, CODEX_SUMMARY_HISTORY_MAX_PAGES);

      let turnBoundCalls = 0;
      const turnBoundRequest = ((method: string, _payload: unknown) =>
        Effect.sync(() => {
          if (method === "thread/read") {
            return makeCodexMetadataResponseFixture("provider-thread-turns");
          }
          if (method === "thread/turns/list") {
            turnBoundCalls += 1;
            return {
              data: Array.from({ length: CODEX_SUMMARY_HISTORY_MAX_TURNS + 10 }, (_, index) =>
                makeCodexSummaryTurnFixture(`turn-${index}`),
              ),
              nextCursor: "ignored-after-turn-cap",
            };
          }
          throw new Error(`Unexpected method: ${method}`);
        })) as CodexBoundedThreadSnapshotClient["request"];
      const turnBoundResponse = yield* readCodexBoundedSummaryThreadWithClient({
        client: { request: turnBoundRequest },
        providerThreadId: "provider-thread-turns",
      });

      assert.equal(turnBoundCalls, 1);
      assert.equal(turnBoundResponse.thread.turns.length, CODEX_SUMMARY_HISTORY_MAX_TURNS);
    }),
  );

  it("contains no live full-history thread/read request", () => {
    const runtimeSource = readFileSync(
      new URL("./CodexSessionRuntime.ts", import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(runtimeSource, /^\s*includeTurns:\s*true,\s*$/m);
  });
});

describe("Codex notification emission timestamps", () => {
  it("accepts valid provider emission time and rejects malformed or future values", () => {
    const receivedAtMs = Date.parse("2026-07-14T08:00:00.000Z");
    assert.equal(
      readCodexNotificationEmittedAtIso(
        {
          method: "turn/started",
          params: {},
          emittedAtMs: Date.parse("2026-07-14T07:59:58.000Z"),
        },
        receivedAtMs,
      ),
      "2026-07-14T07:59:58.000Z",
    );
    assert.equal(
      readCodexNotificationEmittedAtIso(
        {
          method: "turn/started",
          params: {},
          emittedAtMs: Number.NaN,
        },
        receivedAtMs,
      ),
      undefined,
    );
    assert.equal(
      readCodexNotificationEmittedAtIso(
        {
          method: "turn/started",
          params: {},
          emittedAtMs: receivedAtMs + 5 * 60_000 + 1,
        },
        receivedAtMs,
      ),
      undefined,
    );
  });
});

describe("buildCodexAppServerArgs", () => {
  it("attaches a required isolated scheduling catalog without changing permissions or other MCPs", () => {
    const schedulingMcp = {
      name: "cafe-fixture_generation",
      launch: {
        command: 'C:\\Program Files\\Cafe & Code\\Cafe "fixture".exe',
        args: ["/fixture/bridge ' spaced.mjs", "C:\\private\\connection %literal%.json"],
        env: { ELECTRON_RUN_AS_NODE: "1", FIXTURE_LITERAL: 'line\nquote"\tDEL\u007f' },
      },
    };
    const args = buildCodexAppServerArgs({
      schedulingMcp,
      desktopMcp: { bridgePath: "/fixture/desktop.mjs", connectionPath: null },
      maxConcurrentSubagents: 4,
    });
    const config = args.find((argument) => argument.startsWith("mcp_servers.cafe-fixture_"));
    assert.ok(config);
    assert.equal(args[args.indexOf(config) - 1], "-c");
    // Parse the emitted TOML independently rather than mirroring its quoting.
    // Shell metacharacters, spaces and host-native separators must be literal
    // values inside the single structured CLI argument.
    assert.deepEqual(JSON.parse(JSON.stringify(Toml.parse(config))), {
      mcp_servers: {
        [schedulingMcp.name]: {
          ...schedulingMcp.launch,
          enabled: true,
          required: true,
          startup_timeout_sec: 15,
          tool_timeout_sec: 60,
        },
      },
    });
    assert.equal(args.includes("agents.max_concurrent_threads_per_session=4"), true);
    assert.equal(
      args.some((argument) => argument.startsWith("mcp_servers.cafe-desktop=")),
      true,
    );
    assert.doesNotMatch(config, /approval|sandbox|bearer|token|threadId|providerInstanceId/u);
  });

  it("rejects malformed scheduling names and launch values before process creation", () => {
    const launch = { command: "/fixture/node", args: ["/fixture/bridge.mjs"], env: {} };
    for (const name of ["", "cafe.other", 'cafe"={enabled=false}', "a".repeat(129)]) {
      assert.throws(
        () => buildCodexAppServerArgs({ schedulingMcp: { name, launch } }),
        /Invalid scheduling MCP server name/u,
      );
    }
    for (const command of ["private\u0000command", "private\ud800command"]) {
      assert.throws(
        () =>
          buildCodexAppServerArgs({
            schedulingMcp: { name: "cafe-fixture", launch: { ...launch, command } },
          }),
        /^TypeError: Invalid scheduling MCP launch value\.$/u,
      );
    }
  });

  it("enables Cafe task plans while preserving Codex concurrency defaults when unset", () => {
    assert.deepStrictEqual(buildCodexAppServerArgs({}), [
      "app-server",
      "-c",
      "tools.update_plan.enabled=true",
    ]);
    assert.deepStrictEqual(
      buildCodexAppServerArgs({
        transportPolicy: { responsesWebsockets: "auto" },
      }),
      ["app-server", "-c", "tools.update_plan.enabled=true"],
    );
  });

  it("overrides both V1 and root-inclusive V2 capacity when explicitly configured", () => {
    assert.deepStrictEqual(buildCodexAppServerArgs({ maxConcurrentSubagents: 12 }), [
      "app-server",
      "-c",
      "tools.update_plan.enabled=true",
      "-c",
      "agents.max_concurrent_threads_per_session=12",
      "-c",
      "features.multi_agent_v2.max_concurrent_threads_per_session=13",
    ]);
    for (const limit of [1, 64]) {
      const args = buildCodexAppServerArgs({ maxConcurrentSubagents: limit });
      assert.equal(args.includes(`agents.max_concurrent_threads_per_session=${limit}`), true);
      assert.equal(
        args.includes(`features.multi_agent_v2.max_concurrent_threads_per_session=${limit + 1}`),
        true,
      );
    }
  });

  it("uses a Cafe-scoped OpenAI provider when Responses WebSockets are disabled", () => {
    assert.deepStrictEqual(
      buildCodexAppServerArgs({
        maxConcurrentSubagents: 24,
        transportPolicy: { responsesWebsockets: "disabled" },
      }),
      [
        "app-server",
        "-c",
        "tools.update_plan.enabled=true",
        "-c",
        "agents.max_concurrent_threads_per_session=24",
        "-c",
        "features.multi_agent_v2.max_concurrent_threads_per_session=25",
        "-c",
        'model_provider="cafecode-openai-http"',
        "-c",
        'model_providers.cafecode-openai-http.name="OpenAI"',
        "-c",
        'model_providers.cafecode-openai-http.wire_api="responses"',
        "-c",
        "model_providers.cafecode-openai-http.requires_openai_auth=true",
        "-c",
        'model_providers.cafecode-openai-http.env_http_headers.OpenAI-Organization="OPENAI_ORGANIZATION"',
        "-c",
        'model_providers.cafecode-openai-http.env_http_headers.OpenAI-Project="OPENAI_PROJECT"',
        "-c",
        "model_providers.cafecode-openai-http.supports_websockets=false",
      ],
    );
  });

  it("rejects subagent limits outside the decoded provider-setting bounds", () => {
    for (const maxConcurrentSubagents of [0, 65, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () => buildCodexAppServerArgs({ maxConcurrentSubagents }),
        /maxConcurrentSubagents must be an integer between 1 and 64/,
      );
    }
  });
});

describe("Codex protocol diagnostic redaction", () => {
  it("does not retain private wire content in methodless framing failures", () => {
    const redacted = sanitizeCodexProtocolDiagnosticPayload({
      direction: "incoming",
      stage: "decode_failed",
      payload: {
        detail: "Malformed JSON containing private-gateway-token",
        cause: { actual: '"authUrl":"https://example.invalid/?private-gateway-token"' },
        lineByteLength: 87,
      },
    });
    assert.deepEqual(redacted, {
      diagnosticClass: "unclassified-protocol-decode-failure",
      lineByteLength: 87,
    });
    assert.doesNotMatch(JSON.stringify(redacted), /private-gateway-token/);
    for (const lineByteLength of ["private-gateway-token", -1, Number.NaN]) {
      assert.deepEqual(
        sanitizeCodexProtocolDiagnosticPayload({
          direction: "incoming",
          stage: "decode_failed",
          payload: { lineByteLength, cause: "private-gateway-token" },
        }),
        { diagnosticClass: "unclassified-protocol-decode-failure", lineByteLength: null },
      );
    }
  });
  it("never logs authorization links, schema defaults or answers from private interaction diagnostics", () => {
    for (const method of [
      "mcpServer/elicitation/request",
      "item/permissions/requestApproval",
      "account/gatewayOAuth/changed",
    ]) {
      for (const stage of ["decoded", "decode_failed"] as const) {
        const redacted = sanitizeCodexProtocolDiagnosticPayload({
          direction: "incoming",
          stage,
          payload: {
            method,
            params: {
              url: "https://example.com/?token=private",
              authUrl: "https://example.com/?token=private",
              error: "private-gateway-error",
              requestedSchema: { default: "private-default" },
            },
            cause: "private-answer",
          },
        });
        assert.doesNotMatch(
          JSON.stringify(redacted),
          /token=private|private-default|private-answer|private-gateway-error/u,
        );
        assert.equal((redacted as { method: string }).method, method);
      }
    }
  });
  it("redacts raw wire content and valid decoded auth recovery payloads", () => {
    const raw = sanitizeCodexProtocolDiagnosticPayload({
      direction: "incoming",
      stage: "raw",
      payload:
        '{"method":"modelProvider/authRecoveryStarted","params":{"message":"raw-auth-sentinel"}}',
    });
    assert.deepStrictEqual(raw, {
      redacted: true,
      diagnosticClass: "incoming-raw-protocol-content",
      byteLength: 87,
    });
    assert.doesNotMatch(JSON.stringify(raw), /raw-auth-sentinel/u);

    const decoded = sanitizeCodexProtocolDiagnosticPayload({
      direction: "incoming",
      stage: "decoded",
      payload: {
        method: "modelProvider/authRecoveryCompleted",
        params: {
          provider: "decoded-provider-sentinel",
          message: "decoded-message-sentinel",
          threadId: "decoded-thread-sentinel",
          turnId: "decoded-turn-sentinel",
        },
      },
    });
    assert.deepStrictEqual(decoded, {
      method: "modelProvider/authRecoveryCompleted",
      phase: "completed",
      diagnosticClass: "notification-payload-redacted",
    });
    assert.doesNotMatch(
      JSON.stringify(decoded),
      /decoded-(?:provider|message|thread|turn)-sentinel/u,
    );
  });

  it("removes credential-bearing values from malformed auth recovery diagnostics", () => {
    for (const method of [
      "modelProvider/authRecoveryStarted",
      "modelProvider/authRecoveryCompleted",
    ] as const) {
      const sanitized = sanitizeCodexProtocolDiagnosticPayload({
        stage: "decode_failed",
        payload: {
          detail: "schema failed against provider-message-sentinel",
          method,
          message: "provider-message-sentinel",
          cause: {
            actual: {
              provider: "provider-account-sentinel",
              threadId: "provider-thread-sentinel",
              turnId: "provider-turn-sentinel",
            },
          },
        },
      });

      assert.deepStrictEqual(sanitized, {
        method,
        phase: method === "modelProvider/authRecoveryStarted" ? "started" : "completed",
        errorClass: "notification-schema-decode-failed",
      });
      assert.doesNotMatch(
        JSON.stringify(sanitized),
        /provider-(?:message|account|thread|turn)-sentinel/u,
      );
    }
  });
});

describe("Codex terminal session state", () => {
  it("retains failed-turn evidence while the verified owning context stays ready", () => {
    assert.deepStrictEqual(
      codexTerminalSessionPatch({
        turnStatus: "failed",
        errorMessage: "current turn failed",
        nativeContextAvailable: true,
      }),
      { status: "ready", activeTurnId: undefined, lastError: "current turn failed" },
    );
  });
  it("clears a previous runtime error after successful completion", () => {
    assert.deepStrictEqual(codexTerminalSessionPatch({ turnStatus: "completed" }), {
      status: "ready",
      activeTurnId: undefined,
      lastError: undefined,
    });
  });

  it("retains the current failure message after failed completion", () => {
    assert.deepStrictEqual(
      codexTerminalSessionPatch({
        turnStatus: "failed",
        errorMessage: "current turn failed",
      }),
      {
        status: "error",
        activeTurnId: undefined,
        lastError: "current turn failed",
      },
    );
  });
});

describe("Codex failed-root continuation authority", () => {
  const failedTurnId = TurnId.make("failed-native-root");
  const runtimeId = SubagentRuntimeId.make("79a58c30-cd43-4927-ae4a-d340ba31b613");
  const session: ProviderSession = {
    provider: ProviderDriverKind.make("codex"),
    providerInstanceId: ProviderInstanceId.make("exact-account"),
    status: "ready",
    runtimeMode: "full-access",
    threadId: ThreadId.make("cafe-thread"),
    resumeCursor: { threadId: "native-thread" },
    subagentRuntimeId: runtimeId,
    lastError: "Native request failed",
    createdAt: "2026-10-10T11:00:00.000Z",
    updatedAt: "2026-10-10T11:01:00.000Z",
  };
  const completion: CodexAggregateRootCompletion = {
    turnId: failedTurnId,
    providerThreadId: "native-thread",
    state: "failed",
    observedAt: "2026-10-10T11:01:00.000Z",
    codexTransientFailure: "server",
  };
  const expectedFailedRoot = {
    turnId: failedTurnId,
    providerThreadId: "native-thread",
    subagentRuntimeId: runtimeId,
  };
  const makeBoundary = () =>
    Effect.gen(function* () {
      return {
        semaphore: yield* Semaphore.make(1),
        completionsRef: yield* Ref.make(new Map([[String(failedTurnId), completion]])),
        latestRootTurnIdRef: yield* Ref.make<string | undefined>(String(failedTurnId)),
        rootLifecycleEpochRef: yield* Ref.make(Symbol()),
        nativeTurnStartPendingRef: yield* Ref.make(false),
        nativeTurnStartRequestRef: yield* Ref.make<symbol | undefined>(undefined),
        manualCompactionPendingRef: yield* Ref.make(false),
        closedRef: yield* Ref.make(false),
        sessionRef: yield* Ref.make(session),
        nativeContextAvailable: Effect.succeed(true),
      };
    });

  it("requires fresh exact newest transient-root and native-owner evidence", () => {
    const input = {
      session,
      completions: new Map([[String(failedTurnId), completion]]),
      latestRootTurnId: String(failedTurnId),
      nativeContextAvailable: true,
      nativeTurnStartPending: false,
      manualCompactionPending: false,
      closed: false,
    };
    assert.deepEqual(readCodexRootTurnFailure(input), {
      turnId: failedTurnId,
      providerThreadId: "native-thread",
      observedAt: completion.observedAt,
      category: "server",
    });
    for (const changed of [
      { closed: true },
      { nativeContextAvailable: false },
      { nativeTurnStartPending: true },
      { manualCompactionPending: true },
      { latestRootTurnId: "newer-root" },
      { latestRootTurnId: undefined },
      { session: { ...session, status: "error" as const } },
      { session: { ...session, activeTurnId: TurnId.make("newer-root") } },
      { session: { ...session, resumeCursor: { threadId: "different-thread" } } },
      { session: { ...session, subagentRuntimeId: undefined } },
      {
        completions: new Map([
          [String(failedTurnId), { ...completion, state: "completed" as const }],
        ]),
      },
    ])
      assert.equal(readCodexRootTurnFailure({ ...input, ...changed }), undefined);
    assert.deepEqual(
      readCodexRootTurnFailure({
        ...input,
        completions: new Map([
          [String(failedTurnId), { ...completion, codexTransientFailure: undefined }],
        ]),
      }),
      {
        turnId: failedTurnId,
        providerThreadId: "native-thread",
        observedAt: completion.observedAt,
      },
    );
  });

  effectIt.effect(
    "reserves and checks the same owner without changing the failed root or children",
    () =>
      Effect.gen(function* () {
        const boundary = yield* makeBoundary();
        const before = yield* Ref.get(boundary.sessionRef);
        const admission = yield* admitCodexTurnStartLifecycleBoundary({
          ...boundary,
          expectedFailedRoot,
          allowActiveTurnSteerFallback: false,
        });
        yield* assertCodexFailedRootContinuationBoundary({
          ...boundary,
          ...admission,
          expectedFailedRoot,
        });
        assert.deepEqual(yield* Ref.get(boundary.sessionRef), before);
        assert.deepEqual(
          yield* Ref.get(boundary.completionsRef),
          new Map([[String(failedTurnId), completion]]),
        );
        assert.equal(yield* Ref.get(boundary.nativeTurnStartPendingRef), true);
        assert.equal(yield* Ref.get(boundary.nativeTurnStartRequestRef), admission.requestToken);
      }),
  );

  effectIt.effect(
    "refuses old generation, unknown, closed and permanent roots before reservation",
    () =>
      Effect.gen(function* () {
        for (const scenario of [
          "runtime",
          "thread",
          "unknown",
          "closed",
          "permanent",
          "active",
          "missing-context",
        ] as const) {
          const boundary = yield* makeBoundary();
          if (scenario === "runtime")
            yield* Ref.update(boundary.sessionRef, (value) => ({
              ...value,
              subagentRuntimeId: SubagentRuntimeId.make("acf72c20-f40c-4b9e-acef-e7034279c0dd"),
            }));
          if (scenario === "thread")
            yield* Ref.update(boundary.sessionRef, (value) => ({
              ...value,
              resumeCursor: { threadId: "changed-native" },
            }));
          if (scenario === "unknown") yield* Ref.set(boundary.latestRootTurnIdRef, undefined);
          if (scenario === "closed") yield* Ref.set(boundary.closedRef, true);
          if (scenario === "permanent")
            yield* Ref.set(
              boundary.completionsRef,
              new Map([
                [String(failedTurnId), { ...completion, codexTransientFailure: undefined }],
              ]),
            );
          if (scenario === "active")
            yield* Ref.update(boundary.sessionRef, (value) => ({
              ...value,
              status: "running" as const,
              activeTurnId: TurnId.make("new-root"),
            }));
          const result = yield* admitCodexTurnStartLifecycleBoundary({
            ...boundary,
            expectedFailedRoot,
            nativeContextAvailable: Effect.succeed(scenario !== "missing-context"),
          }).pipe(Effect.exit);
          assert.equal(result._tag, "Failure", scenario);
          assert.equal(yield* Ref.get(boundary.nativeTurnStartPendingRef), false);
        }
      }),
  );

  effectIt.effect(
    "Stop, fresh-root and owner changes after preparation suppress all continuation I/O",
    () =>
      Effect.gen(function* () {
        for (const scenario of [
          "stop",
          "epoch",
          "root",
          "runtime",
          "request",
          "compaction",
          "context",
        ] as const) {
          const boundary = yield* makeBoundary();
          const admission = yield* admitCodexTurnStartLifecycleBoundary({
            ...boundary,
            expectedFailedRoot,
          });
          if (scenario === "stop") yield* Ref.set(boundary.closedRef, true);
          if (scenario === "epoch") yield* Ref.set(boundary.rootLifecycleEpochRef, Symbol());
          if (scenario === "root") yield* Ref.set(boundary.latestRootTurnIdRef, "another-root");
          if (scenario === "runtime")
            yield* Ref.update(boundary.sessionRef, (value) => ({
              ...value,
              subagentRuntimeId: SubagentRuntimeId.make("acf72c20-f40c-4b9e-acef-e7034279c0dd"),
            }));
          if (scenario === "request") yield* Ref.set(boundary.nativeTurnStartRequestRef, Symbol());
          if (scenario === "compaction") yield* Ref.set(boundary.manualCompactionPendingRef, true);
          let nativeRequests = 0;
          const result = yield* assertCodexFailedRootContinuationBoundary({
            ...boundary,
            ...admission,
            expectedFailedRoot,
            nativeContextAvailable: Effect.succeed(scenario !== "context"),
          }).pipe(
            Effect.andThen(
              Effect.sync(() => {
                nativeRequests += 1;
              }),
            ),
            Effect.exit,
          );
          assert.equal(result._tag, "Failure", scenario);
          assert.equal(nativeRequests, 0, scenario);
        }
      }),
  );

  effectIt.effect(
    "late failed-root errors cannot poison a new live root or revive terminal evidence",
    () =>
      Effect.gen(function* () {
        const boundary = yield* makeBoundary();
        const errorInput = {
          ...boundary,
          providerThreadId: "native-thread",
          turnId: failedTurnId,
          willRetry: false,
          errorMessage: "late old error",
        };
        assert.equal(yield* commitCodexRootErrorLifecycleBoundary(errorInput), false);
        assert.deepEqual(yield* Ref.get(boundary.sessionRef), session);
        const newTurnId = TurnId.make("new-live-root");
        yield* Ref.set(boundary.latestRootTurnIdRef, String(newTurnId));
        yield* Ref.update(boundary.sessionRef, (value) => ({
          ...value,
          status: "running" as const,
          activeTurnId: newTurnId,
          lastError: undefined,
        }));
        assert.equal(yield* commitCodexRootErrorLifecycleBoundary(errorInput), false);
        assert.equal((yield* Ref.get(boundary.sessionRef)).lastError, undefined);
        assert.equal(
          yield* commitCodexRootErrorLifecycleBoundary({
            ...errorInput,
            turnId: newTurnId,
            willRetry: true,
            errorMessage: "current transport retry",
          }),
          true,
        );
        assert.equal((yield* Ref.get(boundary.sessionRef)).status, "running");
        assert.equal((yield* Ref.get(boundary.sessionRef)).lastError, "current transport retry");
      }),
  );

  effectIt.effect(
    "terminal-before-ACK binds the new failed root without resurrection, while Stop still progresses",
    () =>
      Effect.gen(function* () {
        for (const stop of [false, true]) {
          const boundary = yield* makeBoundary();
          const admission = yield* admitCodexTurnStartLifecycleBoundary({
            ...boundary,
            expectedFailedRoot,
          });
          yield* assertCodexFailedRootContinuationBoundary({
            ...boundary,
            ...admission,
            expectedFailedRoot,
          });
          const ackGate = yield* Deferred.make<void>();
          const newTurnId = TurnId.make("continued-root-failed-before-ack");
          const ackFiber = yield* Deferred.await(ackGate).pipe(
            Effect.andThen(
              acknowledgeCodexTurnStartLifecycleBoundary({
                ...boundary,
                ...admission,
                latestHistoryRootTurnRef: boundary.latestRootTurnIdRef,
                turnId: newTurnId,
                acknowledgedAt: "2026-10-10T11:02:00.000Z",
              }),
            ),
            Effect.forkChild,
          );
          // The pending response wait holds no lifecycle permit. A terminal
          // callback and explicit Stop both enter it before the ACK is released.
          yield* boundary.semaphore.withPermits(1)(
            Effect.gen(function* () {
              yield* Ref.update(boundary.completionsRef, (entries) =>
                new Map(entries).set(String(newTurnId), {
                  ...completion,
                  turnId: newTurnId,
                  errorMessage: "new request failed",
                }),
              );
              yield* Ref.set(boundary.rootLifecycleEpochRef, Symbol());
              if (stop) {
                yield* Ref.set(boundary.closedRef, true);
                yield* Ref.update(boundary.sessionRef, (value) => ({
                  ...value,
                  status: "closed" as const,
                }));
              }
            }),
          );
          yield* Deferred.succeed(ackGate, undefined);
          assert.equal(yield* Fiber.join(ackFiber), false);
          const after = yield* Ref.get(boundary.sessionRef);
          assert.equal(after.activeTurnId, undefined);
          if (stop) {
            assert.equal(after.status, "closed");
            assert.equal(yield* Ref.get(boundary.latestRootTurnIdRef), String(failedTurnId));
          } else {
            assert.equal(after.status, "ready");
            assert.equal(after.lastError, "new request failed");
            assert.equal(yield* Ref.get(boundary.latestRootTurnIdRef), String(newTurnId));
            assert.equal(yield* Ref.get(boundary.nativeTurnStartPendingRef), false);
            assert.equal(
              readCodexRootTurnFailure({
                session: after,
                completions: yield* Ref.get(boundary.completionsRef),
                latestRootTurnId: yield* Ref.get(boundary.latestRootTurnIdRef),
                nativeContextAvailable: true,
                nativeTurnStartPending: false,
                manualCompactionPending: false,
                closed: false,
              })?.turnId,
              newTurnId,
            );
          }
        }
      }),
  );
});

function makeReasoningEffortSnapshot(
  effort: string | null | undefined,
): CodexReasoningEffortSnapshot {
  return {
    providerThreadId: "provider-thread-1",
    effort,
    revision: Symbol(),
  };
}

describe("Codex thread settings reconciliation", () => {
  const notification = {
    threadId: "provider-thread-1",
    threadSettings: {
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      collaborationMode: {
        mode: "default",
        settings: {
          model: "gpt-5.4",
          reasoning_effort: "ultra",
        },
      },
      cwd: "/workspace",
      effort: "ultra",
      model: "gpt-5.4",
      modelProvider: "openai",
      sandboxPolicy: { type: "workspaceWrite" },
    },
  } satisfies EffectCodexSchema.V2ThreadSettingsUpdatedNotification;

  it("accepts the authoritative model only for the current provider thread", () => {
    assert.equal(
      resolveCodexThreadSettingsSessionModel({
        currentProviderThreadId: "provider-thread-1",
        notification,
      }),
      "gpt-5.4",
    );
    assert.equal(
      resolveCodexThreadSettingsSessionModel({
        currentProviderThreadId: "provider-thread-child",
        notification,
      }),
      undefined,
    );
  });

  it("distinguishes opening native-default null from unknown older-server effort", () => {
    const unknown = observeCodexThreadOpenReasoningEffort({
      current: undefined,
      opened: makeThreadOpenResponse("provider-thread-1"),
    });
    const delegated = observeCodexThreadOpenReasoningEffort({
      current: undefined,
      opened: { ...makeThreadOpenResponse("provider-thread-1"), reasoningEffort: null },
    });
    assert.equal(unknown.effort, undefined);
    assert.equal(delegated.effort, null);
    for (const effort of ["high", "max", "ultra"]) {
      assert.equal(
        observeCodexThreadOpenReasoningEffort({
          current: undefined,
          opened: { ...makeThreadOpenResponse("provider-thread-1"), reasoningEffort: effort },
        }).effort,
        effort,
      );
    }
  });

  it("does not let a late opening ACK replace newer matching settings", () => {
    const current = observeCodexThreadSettingsReasoningEffort({
      current: makeReasoningEffortSnapshot("low"),
      currentProviderThreadId: "provider-thread-1",
      notification,
    });
    assert.equal(current?.effort, "ultra");
    assert.strictEqual(
      observeCodexThreadOpenReasoningEffort({
        current,
        opened: { ...makeThreadOpenResponse("provider-thread-1"), reasoningEffort: "low" },
      }),
      current,
    );
    assert.equal(
      observeCodexThreadOpenReasoningEffort({
        current,
        opened: { ...makeThreadOpenResponse("different-root"), reasoningEffort: "high" },
      }).effort,
      "high",
    );
  });

  it("ignores child and unidentified-root settings without changing ACK fences", () => {
    const current = makeReasoningEffortSnapshot("high");
    for (const currentProviderThreadId of ["provider-thread-child", undefined]) {
      assert.strictEqual(
        observeCodexThreadSettingsReasoningEffort({
          current,
          currentProviderThreadId,
          notification,
        }),
        current,
      );
    }
  });

  it("preserves observed effort and ACK authority when a legacy notification omits effort", () => {
    const { effort: _effort, ...threadSettings } = notification.threadSettings;
    const { reasoning_effort: _reasoningEffort, ...settings } =
      threadSettings.collaborationMode.settings;
    const current = makeReasoningEffortSnapshot("max");
    const observed = observeCodexThreadSettingsReasoningEffort({
      current,
      currentProviderThreadId: "provider-thread-1",
      notification: {
        ...notification,
        threadSettings: {
          ...threadSettings,
          collaborationMode: { ...threadSettings.collaborationMode, settings },
        },
      },
    });
    assert.strictEqual(observed, current);
  });

  it("retains an explicit accepted legacy request, but never an unacknowledged selection", () => {
    for (const effort of ["high", "max", "ultra"]) {
      const initial = makeReasoningEffortSnapshot(null);
      const requestToken = Symbol();
      const admitted = admitCodexReasoningEffortRequest({
        current: initial,
        providerThreadId: initial.providerThreadId,
        requestToken,
      });
      // Explicit rejection, transport uncertainty and malformed ACKs do not
      // invoke the acceptance boundary and cannot alter the native selection.
      assert.equal(admitted.effort, null);
      assert.equal(
        acknowledgeCodexReasoningEffortRequest({
          current: admitted,
          providerThreadId: initial.providerThreadId,
          requestToken,
          requestedRevision: initial.revision,
          requestedEffort: effort,
        })?.effort,
        effort,
      );
      assert.strictEqual(
        acknowledgeCodexReasoningEffortRequest({
          current: admitted,
          providerThreadId: initial.providerThreadId,
          requestToken,
          requestedRevision: initial.revision,
          requestedEffort: undefined,
        }),
        admitted,
      );
    }
  });

  it("fences an old explicit ACK after a newer admitted root or native settings notification", () => {
    const initial = makeReasoningEffortSnapshot("low");
    const requestToken = Symbol();
    const admitted = admitCodexReasoningEffortRequest({
      current: initial,
      providerThreadId: initial.providerThreadId,
      requestToken,
    });
    const newerRequest = admitCodexReasoningEffortRequest({
      current: admitted,
      providerThreadId: initial.providerThreadId,
      requestToken: Symbol(),
    });
    const newerSettings = observeCodexThreadSettingsReasoningEffort({
      current: admitted,
      currentProviderThreadId: initial.providerThreadId,
      notification: {
        ...notification,
        threadSettings: { ...notification.threadSettings, effort: null },
      },
    });
    assert.equal(newerSettings?.effort, null);
    for (const current of [newerRequest, newerSettings, makeReasoningEffortSnapshot("max")]) {
      assert.strictEqual(
        acknowledgeCodexReasoningEffortRequest({
          current,
          providerThreadId: initial.providerThreadId,
          requestToken,
          requestedRevision: initial.revision,
          requestedEffort: "high",
        }),
        current,
      );
    }
  });
});

describe("codex elapsed watchdog scheduling", () => {
  it("treats delay labels as elapsed deadlines instead of cumulative sleeps", () => {
    assert.equal(codexElapsedDelayMilliseconds("60 seconds"), 60_000);
    assert.equal(
      codexElapsedDelayRemainingMilliseconds({
        startedAtMs: 1_000,
        nowMs: 31_000,
        delay: "60 seconds",
      }),
      30_000,
    );
    assert.equal(
      codexElapsedDelayRemainingMilliseconds({
        startedAtMs: 1_000,
        nowMs: 90_000,
        delay: "60 seconds",
      }),
      0,
    );
  });

  it("allows only one snapshot backfill watcher per active turn", () => {
    const turnId = TurnId.make("turn-backfill");
    const [firstClaimed, afterFirstClaim] = claimCodexSnapshotBackfillWatcher(new Set(), turnId);
    const [duplicateClaimed, afterDuplicateClaim] = claimCodexSnapshotBackfillWatcher(
      afterFirstClaim,
      turnId,
    );

    assert.equal(firstClaimed, true);
    assert.equal(duplicateClaimed, false);
    assert.equal(afterDuplicateClaim, afterFirstClaim);
    assert.deepEqual([...afterDuplicateClaim], [String(turnId)]);
  });
});

describe("Codex child conversation routing", () => {
  it("keeps child errors out of primary runtime error state", () => {
    assert.equal(codexAggregateNotificationMethod("error", true), "codex.subagent/error");
    assert.equal(codexAggregateNotificationMethod("error", false), "error");
    assert.equal(codexAggregateNotificationMethod("item/completed", true), "item/completed");
  });

  it("projects only bounded child lifecycle snapshots needed by the subagent UI", () => {
    assert.equal(
      codexSubagentProjectionMethod({
        method: "thread/status/changed",
        params: { threadId: "thread-child", status: { type: "active", activeFlags: [] } },
      }),
      "codex.subagent/threadStatusChanged",
    );
    assert.equal(
      codexSubagentProjectionMethod({
        method: "item/completed",
        params: {
          threadId: "thread-child",
          item: { id: "reasoning-1", type: "reasoning", summary: ["Working"] },
        },
      }),
      "codex.subagent/itemCompleted",
    );
    assert.equal(
      codexSubagentProjectionMethod({
        method: "item/reasoning/summaryTextDelta",
        params: { threadId: "thread-child", delta: "token" },
      }),
      undefined,
    );
  });

  it("routes multi-agent-v2 child output to the parent without forwarding child lifecycle", () => {
    const parentTurnId = TurnId.make("turn-parent");
    const routes = new Map<string, TurnId>();

    rememberCodexChildConversationTurns(
      routes,
      {
        method: "item/completed",
        params: {
          threadId: "thread-parent",
          turnId: "turn-parent",
          item: {
            type: "subAgentActivity",
            id: "subagent-activity-1",
            kind: "started",
            agentThreadId: "thread-child",
            agentPath: "/root/workers/audit",
          },
        },
      },
      parentTurnId,
      "thread-parent",
    );

    assert.equal(routes.get("thread-child"), parentTurnId);
    assert.deepStrictEqual(
      resolveCodexChildConversationNotification(
        routes,
        {
          method: "turn/started",
          params: {
            threadId: "thread-child",
            turn: {
              id: "turn-child",
              status: "inProgress",
            },
          },
        },
        "thread-parent",
      ),
      {
        parentTurnId,
        suppressLifecycle: true,
      },
    );
    assert.deepStrictEqual(
      resolveCodexChildConversationNotification(
        routes,
        {
          method: "modelProvider/authRecoveryStarted",
          params: {
            threadId: "thread-child",
            turnId: "turn-child",
            provider: "bedrock",
            message: "Refreshing credentials.",
          },
        },
        "thread-parent",
      ),
      {
        parentTurnId,
        suppressLifecycle: false,
      },
    );
    assert.deepStrictEqual(
      resolveCodexChildConversationNotification(
        routes,
        {
          method: "modelProvider/authRecoveryCompleted",
          params: {
            threadId: "thread-parent",
            turnId: "turn-parent",
            provider: "bedrock",
            message: "Credentials refreshed.",
          },
        },
        "thread-parent",
      ),
      undefined,
    );
    assert.deepStrictEqual(
      resolveCodexChildConversationNotification(
        routes,
        {
          method: "autoApprovalReview/strictReviewRequired",
          params: {
            threadId: "thread-child",
            turnId: "turn-child",
            startedAtMs: 1_778_000_000_000,
          },
        },
        "thread-parent",
      ),
      {
        parentTurnId,
        suppressLifecycle: false,
      },
    );
    assert.deepStrictEqual(
      resolveCodexChildConversationNotification(
        routes,
        {
          method: "item/agentMessage/delta",
          params: {
            threadId: "thread-child",
            turnId: "turn-child",
            itemId: "message-child",
            delta: "progress",
          },
        },
        "thread-parent",
      ),
      {
        parentTurnId,
        suppressLifecycle: false,
      },
    );
    assert.deepStrictEqual(
      resolveCodexChildConversationNotification(
        routes,
        {
          method: "guardianWarning",
          params: {
            threadId: "thread-child",
            message: "Automatic approval review denied the requested action.",
          },
        },
        "thread-parent",
      ),
      {
        parentTurnId,
        suppressLifecycle: false,
      },
    );
    assert.deepStrictEqual(
      resolveCodexChildConversationNotification(
        routes,
        {
          method: "thread/environment/disconnected",
          params: {
            threadId: "thread-child",
            environmentId: "local",
          },
        },
        "thread-parent",
      ),
      {
        parentTurnId,
        suppressLifecycle: true,
      },
    );
    assert.deepStrictEqual(
      resolveCodexChildConversationNotification(
        routes,
        {
          method: "thread/goal/updated",
          params: {
            threadId: "thread-child",
            goal: {
              threadId: "thread-child",
              objective: "Child objective",
              status: "active",
              tokenBudget: null,
              tokensUsed: 0,
              timeUsedSeconds: 0,
              createdAt: 1,
              updatedAt: 1,
            },
          },
        },
        "thread-parent",
      ),
      {
        parentTurnId,
        suppressLifecycle: true,
      },
    );
    assert.deepStrictEqual(
      resolveCodexChildConversationNotification(
        routes,
        {
          method: "turn/plan/updated",
          params: {
            threadId: "thread-child",
            turnId: "turn-child",
            explanation: "Child-only checklist",
            plan: [{ step: "Inspect child workspace", status: "inProgress" }],
          },
        },
        "thread-parent",
      ),
      {
        parentTurnId,
        suppressLifecycle: true,
      },
    );
  });

  it("forwards goal notifications only from the root provider thread", () => {
    const rootGoal = {
      method: "thread/goal/cleared",
      params: { threadId: "thread-parent" },
    } as const;
    const childGoal = {
      method: "thread/goal/cleared",
      params: { threadId: "thread-child" },
    } as const;

    assert.equal(shouldForwardCodexRootGoalNotification(rootGoal, "thread-parent"), true);
    assert.equal(shouldForwardCodexRootGoalNotification(childGoal, "thread-parent"), false);
    assert.equal(shouldForwardCodexRootGoalNotification(rootGoal, undefined), false);
    assert.equal(
      shouldForwardCodexRootGoalNotification(
        {
          method: "item/completed",
          params: { threadId: "thread-child" },
        },
        "thread-parent",
      ),
      true,
    );
  });

  it("keeps nested subagent output on the original visible parent turn", () => {
    const parentTurnId = TurnId.make("turn-parent");
    const routes = new Map<string, TurnId>([["thread-child", parentTurnId]]);
    const nestedActivity = {
      method: "item/completed",
      params: {
        threadId: "thread-child",
        turnId: "turn-child",
        item: {
          type: "subAgentActivity",
          id: "subagent-activity-2",
          kind: "started",
          agentThreadId: "thread-grandchild",
          agentPath: "/root/workers/nested-audit",
        },
      },
    };
    const childRoute = resolveCodexChildConversationNotification(routes, nestedActivity);

    rememberCodexChildConversationTurns(
      routes,
      nestedActivity,
      childRoute?.parentTurnId ?? TurnId.make("turn-child"),
      "thread-parent",
    );

    assert.equal(routes.get("thread-grandchild"), parentTurnId);
  });

  it("does not reverse-route the primary thread when a child interacts with root", () => {
    const parentTurnId = TurnId.make("turn-parent");
    const routes = new Map<string, TurnId>([
      ["thread-child", parentTurnId],
      // Reproduce the poisoned state created by the older implementation so
      // the regression also proves that processing later activity heals it.
      ["thread-parent", TurnId.make("turn-stale")],
    ]);

    rememberCodexChildConversationTurns(
      routes,
      {
        method: "item/completed",
        params: {
          threadId: "thread-child",
          turnId: "turn-child",
          item: {
            type: "subAgentActivity",
            id: "subagent-activity-to-root",
            kind: "interacted",
            agentThreadId: "thread-parent",
            agentPath: "/root",
          },
        },
      },
      parentTurnId,
      "thread-parent",
    );

    assert.equal(routes.has("thread-parent"), false);
    assert.equal(routes.get("thread-child"), parentTurnId);
    assert.equal(
      resolveCodexChildConversationNotification(
        routes,
        {
          method: "item/agentMessage/delta",
          params: {
            threadId: "thread-parent",
            turnId: "turn-current",
            itemId: "message-root",
            delta: "root output",
          },
        },
        "thread-parent",
      ),
      undefined,
    );
  });

  it.each(["interacted", "started", "completed", "interrupted"] as const)(
    "preserves exact child owner for paired %s activity from a newer root turn",
    (kind) => {
      const firstParent = TurnId.make("original-parent");
      const laterParent = TurnId.make("later-parent");
      const routes = new Map([["child", firstParent]]);
      const initial = updateCodexChildConversationLiveness(
        new Map(),
        routes,
        { method: "turn/started", params: { threadId: "child", turn: { id: "native-active" } } },
        "2026-10-04T00:00:00.000Z",
      );
      let states = initial;
      for (const method of ["item/started", "item/completed"]) {
        const notification = {
          method,
          params: {
            threadId: "root",
            turnId: String(laterParent),
            item: {
              id: "activity",
              type: "subAgentActivity",
              kind,
              agentThreadId: "child",
              agentPath: "/root/audit",
            },
          },
        };
        rememberCodexChildConversationTurns(routes, notification, laterParent, "root");
        states = updateCodexChildConversationLiveness(
          states,
          routes,
          notification,
          "2026-10-04T00:00:01.000Z",
        );
        const publications = buildCodexChildActivityNotifications(routes, states, notification);
        assert.deepEqual(publications, [{ parentTurnId: firstParent, notification }]);
      }
      assert.deepEqual([...routes], [["child", firstParent]]);
      assert.equal(states.get("child")?.nativeTurnId, "native-active");
      assert.equal(states.get("child")?.parentTurnId, firstParent);
      if (kind === "interacted") {
        // Sending another task to a still-active child neither resets liveness
        // nor creates a second [turn,child] row/detail authorization tuple.
        assert.equal(states.get("child"), initial.get("child"));
        assert.equal(codexAggregateTurnHasUnfinishedChildren(routes, states, firstParent), true);
        assert.equal(codexAggregateTurnHasUnfinishedChildren(routes, states, laterParent), false);
      }
    },
  );

  it("reopens explicit reused-child work under its original history owner, with late rename still there", () => {
    const owner = TurnId.make("spawn-parent");
    const routes = new Map([["child", owner]]);
    const terminal = updateCodexChildConversationLiveness(
      new Map(),
      routes,
      {
        method: "turn/completed",
        params: { threadId: "child", turn: { id: "native-old", status: "completed" } },
      },
      "2026-10-04T00:00:00.000Z",
    );
    const restart = {
      method: "item/started",
      params: {
        threadId: "root",
        turnId: "later-parent",
        item: {
          id: "resume-call",
          type: "collabAgentToolCall",
          tool: "resumeAgent",
          status: "inProgress",
          senderThreadId: "root",
          receiverThreadIds: ["child"],
          prompt: null,
          model: null,
          reasoningEffort: null,
          agentsStates: { child: { status: "running", message: null } },
        },
      },
    };
    rememberCodexChildConversationTurns(routes, restart, TurnId.make("later-parent"), "root");
    assert.equal(
      buildCodexChildActivityNotifications(routes, terminal, restart)?.[0]?.parentTurnId,
      owner,
    );
    const running = updateCodexChildConversationLiveness(
      terminal,
      routes,
      {
        method: "turn/started",
        params: { threadId: "child", turn: { id: "native-new", status: "inProgress" } },
      },
      "2026-10-04T00:00:01.000Z",
    );
    const rename = {
      method: "thread/name/updated",
      params: { threadId: "child", threadName: "Renamed audit" },
    };
    assert.deepEqual(resolveCodexChildConversationNotification(routes, rename, "root"), {
      parentTurnId: owner,
      suppressLifecycle: true,
    });
    assert.equal(
      codexSubagentProjectionMethod(rename, running),
      "codex.subagent/threadNameUpdated",
    );
    const afterRename = updateCodexChildConversationLiveness(
      running,
      routes,
      rename,
      "2026-10-04T00:00:02.000Z",
    );
    assert.equal(afterRename.get("child"), running.get("child"));
    assert.equal(afterRename.get("child")?.state, "active");
    assert.equal(afterRename.get("child")?.nativeTurnId, "native-new");
    assert.deepEqual([...routes], [["child", owner]]);
  });

  it.each(["turn/completed", "item/started", "item/completed"])(
    "rejects stale %s completion in both liveness and canonical publication after child reuse",
    (method) => {
      const owner = TurnId.make("original-parent");
      const routes = new Map([["child", owner]]);
      const current = updateCodexChildConversationLiveness(
        new Map(),
        routes,
        {
          method: "turn/started",
          params: { threadId: "child", turn: { id: "native-current", status: "inProgress" } },
        },
        "2026-10-04T00:00:00.000Z",
      );
      const lateProgress = updateCodexChildConversationLiveness(
        current,
        routes,
        {
          method: "item/completed",
          params: {
            threadId: "child",
            turnId: "native-retired",
            item: { type: "reasoning", id: "old-reasoning", summary: ["Old work"] },
          },
        },
        "2026-10-04T00:00:01.000Z",
      );
      assert.equal(lateProgress.get("child"), current.get("child"));
      const stale =
        method === "turn/completed"
          ? {
              method,
              params: { threadId: "child", turn: { id: "native-retired", status: "completed" } },
            }
          : {
              method,
              params: {
                threadId: "root",
                turnId: "original-parent",
                item: {
                  type: "subAgentActivity",
                  id: "subagent-completed-native-retired",
                  kind: "completed",
                  agentThreadId: "child",
                  agentPath: "/root/audit",
                },
              },
            };
      const afterStale = updateCodexChildConversationLiveness(
        lateProgress,
        routes,
        stale,
        "2026-10-04T00:00:02.000Z",
      );
      assert.equal(afterStale.get("child"), current.get("child"));
      assert.equal(codexSubagentProjectionMethod(stale, afterStale), undefined);
      if (method !== "turn/completed") {
        assert.deepEqual(buildCodexChildActivityNotifications(routes, afterStale, stale), []);
      }
      const currentCompletion =
        method === "turn/completed"
          ? {
              method,
              params: { threadId: "child", turn: { id: "native-current", status: "completed" } },
            }
          : {
              method,
              params: {
                threadId: "root",
                turnId: "later-parent",
                item: {
                  type: "subAgentActivity",
                  id: "subagent-completed-native-current",
                  kind: "completed",
                  agentThreadId: "child",
                  agentPath: "/root/audit",
                },
              },
            };
      const settled = updateCodexChildConversationLiveness(
        afterStale,
        routes,
        currentCompletion,
        "2026-10-04T00:00:03.000Z",
      );
      assert.equal(settled.get("child")?.state, "inactive");
      assert.equal(settled.get("child")?.parentTurnId, owner);
      assert.equal(
        method === "turn/completed"
          ? codexSubagentProjectionMethod(currentCompletion, settled)
          : buildCodexChildActivityNotifications(routes, settled, currentCompletion)?.[0]
              ?.parentTurnId,
        method === "turn/completed" ? "codex.subagent/turnCompleted" : owner,
      );
    },
  );

  it.each(["error", "reasoning", "nested-spawn"])(
    "rejects stale child %s before routing, liveness, private and ordinary publication",
    (kind) => {
      const owner = TurnId.make("original-parent");
      const routes = new Map([["child", owner]]);
      const current = updateCodexChildConversationLiveness(
        new Map(),
        routes,
        {
          method: "turn/started",
          params: { threadId: "child", turn: { id: "native-current" } },
        },
        "2026-10-04T00:00:00.000Z",
      );
      const params = {
        threadId: "child",
        turnId: "native-retired",
        ...(kind === "error"
          ? { willRetry: false, error: { message: "Old child failure" } }
          : {
              item:
                kind === "reasoning"
                  ? { type: "reasoning", id: "old-reasoning", summary: ["Old work"] }
                  : {
                      type: "subAgentActivity",
                      id: "old-nested-spawn",
                      kind: "started",
                      agentThreadId: "grandchild",
                      agentPath: "/root/audit/nested",
                    },
            }),
      };
      const notification = {
        method:
          kind === "error" ? "error" : kind === "reasoning" ? "item/completed" : "item/started",
        params,
      };
      const admitted = acceptsCodexChildNotification(current, notification, routes);
      assert.equal(admitted, false);
      // The live handler uses this exact shared predicate before remembering
      // descendants and returns before *any* canonical publication, including
      // ordinary child errors that have no private projection method.
      if (admitted) rememberCodexChildConversationTurns(routes, notification, owner, "root");
      assert.equal(routes.has("grandchild"), false);
      assert.equal(
        updateCodexChildConversationLiveness(
          current,
          routes,
          notification,
          "2026-10-04T00:00:01.000Z",
        ).get("child"),
        current.get("child"),
      );
      assert.equal(codexSubagentProjectionMethod(notification, current, routes), undefined);
      if (kind !== "error")
        assert.deepEqual(buildCodexChildActivityNotifications(routes, current, notification), []);
      assert.equal(
        admitted ? codexAggregateNotificationMethod(notification.method, true) : undefined,
        undefined,
      );

      const matching = { ...notification, params: { ...params, turnId: "native-current" } };
      assert.equal(acceptsCodexChildNotification(current, matching, routes), true);
      const { turnId: _retiredTurn, ...withoutTurnProof } = params;
      const compatible = { ...notification, params: withoutTurnProof };
      assert.equal(acceptsCodexChildNotification(current, compatible, routes), true);
      if (kind === "error") {
        assert.equal(
          updateCodexChildConversationLiveness(
            current,
            routes,
            matching,
            "2026-10-04T00:00:02.000Z",
          ).get("child")?.state,
          "inactive",
        );
        assert.equal(
          updateCodexChildConversationLiveness(
            current,
            routes,
            compatible,
            "2026-10-04T00:00:02.000Z",
          ).get("child")?.state,
          "inactive",
        );
      } else if (kind === "reasoning") {
        assert.equal(
          codexSubagentProjectionMethod(matching, current, routes),
          "codex.subagent/itemCompleted",
        );
        assert.equal(
          codexSubagentProjectionMethod(compatible, current, routes),
          "codex.subagent/itemCompleted",
        );
      } else {
        rememberCodexChildConversationTurns(routes, matching, owner, "root");
        assert.equal(routes.get("grandchild"), owner);
        assert.equal(
          buildCodexChildActivityNotifications(routes, current, matching)?.[0]?.parentTurnId,
          owner,
        );
      }
      const explicitNewStart = {
        method: "turn/started",
        params: { threadId: "child", turn: { id: "native-next" } },
      };
      assert.equal(acceptsCodexChildNotification(current, explicitNewStart, routes), true);
      assert.equal(
        updateCodexChildConversationLiveness(
          current,
          routes,
          explicitNewStart,
          "2026-10-04T00:00:03.000Z",
        ).get("child")?.nativeTurnId,
        "native-next",
      );
    },
  );

  it("retains compatible completion admission when older envelopes provide no exact native turn proof", () => {
    const owner = TurnId.make("owner");
    const routes = new Map([["child", owner]]);
    const current = updateCodexChildConversationLiveness(
      new Map(),
      routes,
      { method: "turn/started", params: { threadId: "child", turn: { id: "current" } } },
      "2026-10-04T00:00:00.000Z",
    );
    const notification = {
      method: "item/completed",
      params: {
        threadId: "root",
        item: {
          type: "subAgentActivity",
          id: "older-opaque-completion-id",
          kind: "completed",
          agentThreadId: "child",
          agentPath: "/root/audit",
        },
      },
    };
    const settled = updateCodexChildConversationLiveness(
      current,
      routes,
      notification,
      "2026-10-04T00:00:01.000Z",
    );
    assert.equal(settled.get("child")?.state, "inactive");
    assert.equal(
      buildCodexChildActivityNotifications(routes, settled, notification)?.[0]?.parentTurnId,
      owner,
    );
    assert.equal(
      codexSubagentProjectionMethod(
        { method: "turn/completed", params: { threadId: "child", turn: { status: "completed" } } },
        current,
      ),
      "codex.subagent/turnCompleted",
    );
  });

  it("splits legacy lifecycle only by receiver owner without changing native source or leaking other groups", () => {
    const first = TurnId.make("first");
    const second = TurnId.make("second");
    const routes = new Map([
      ["child-a", first],
      ["child-b", second],
    ]);
    const original = {
      method: "item/completed",
      params: {
        threadId: "root",
        turnId: "latest-root",
        startedAtMs: 123,
        item: {
          id: "one-native-item",
          type: "collabAgentToolCall",
          tool: "wait",
          status: "completed",
          senderThreadId: "native-sender",
          receiverThreadIds: ["child-a", "child-b"],
          prompt: "Delegated objective",
          agentsStates: {
            "child-a": { status: "completed", message: "A" },
            "child-b": { status: "running", message: "B" },
            unrelated: { status: "running", message: "Do not copy" },
          },
        },
      },
    };
    rememberCodexChildConversationTurns(routes, original, TurnId.make("latest-root"), "root");
    const copies = buildCodexChildActivityNotifications(routes, new Map(), original);
    assert.equal(copies?.length, 2);
    assert.deepEqual(
      copies?.map((copy) => copy.parentTurnId),
      [first, second],
    );
    for (const [index, copy] of (copies ?? []).entries()) {
      const child = index === 0 ? "child-a" : "child-b";
      assert.deepEqual(copy.notification, {
        ...original,
        params: {
          ...original.params,
          item: {
            ...original.params.item,
            receiverThreadIds: [child],
            agentsStates: {
              [child]: original.params.item.agentsStates[child as "child-a" | "child-b"],
            },
          },
        },
      });
      assert.notEqual(copy.notification, original);
    }
    assert.deepEqual(original.params.item.receiverThreadIds, ["child-a", "child-b"]);
    assert.equal(Object.keys(original.params.item.agentsStates).length, 3);
    assert.deepEqual(
      buildCodexChildActivityNotifications(routes, new Map(), {
        method: "item/completed",
        params: { threadId: "root", item: { type: "reasoning", summary: ["ordinary work"] } },
      }),
      undefined,
    );
  });

  it("bounds all legacy ownership groups together and never registers a root or overflow receiver", () => {
    const receivers = Array.from(
      { length: CODEX_CHILD_ACTIVITY_RECEIVER_LIMIT + 10 },
      (_, index) => `child-${index}`,
    );
    const routes = new Map(receivers.map((child, index) => [child, TurnId.make(`owner-${index}`)]));
    const original = {
      method: "item/started",
      params: {
        threadId: "root",
        item: {
          type: "collabAgentToolCall",
          receiverThreadIds: receivers,
          agentsStates: {},
        },
      },
    };
    const copies = buildCodexChildActivityNotifications(routes, new Map(), original);
    assert.equal(copies?.length, CODEX_CHILD_ACTIVITY_RECEIVER_LIMIT);
    const newlyRegistered = new Map<string, TurnId>();
    rememberCodexChildConversationTurns(newlyRegistered, original, TurnId.make("owner"), "root");
    assert.equal(newlyRegistered.size, CODEX_CHILD_ACTIVITY_RECEIVER_LIMIT);
    assert.equal(newlyRegistered.has(`child-${CODEX_CHILD_ACTIVITY_RECEIVER_LIMIT}`), false);
    const rootInteraction = {
      method: "item/completed",
      params: {
        threadId: "child-0",
        item: {
          type: "subAgentActivity",
          kind: "interacted",
          id: "reverse",
          agentThreadId: "root",
          agentPath: "/root",
        },
      },
    };
    rememberCodexChildConversationTurns(
      newlyRegistered,
      rootInteraction,
      TurnId.make("later"),
      "root",
    );
    assert.equal(newlyRegistered.has("root"), false);
    assert.equal(
      buildCodexChildActivityNotifications(newlyRegistered, new Map(), rootInteraction)?.[0]
        ?.parentTurnId,
      TurnId.make("owner"),
    );
    assert.deepEqual(
      buildCodexChildActivityNotifications(newlyRegistered, new Map(), {
        ...rootInteraction,
        params: { ...rootInteraction.params, threadId: "unknown-source" },
      }),
      [],
    );
  });

  it.each(["failed", "interrupted", "cancelled"] as const)(
    "does not defer or reopen a %s root while routed children remain live",
    (state) => {
      const completion = readCodexAggregateRootCompletion(
        {
          method: "turn/completed",
          params: {
            threadId: "native-root",
            turn: {
              id: "root-turn",
              status: state,
              error: { message: "Selected model is at capacity" },
            },
          },
        },
        "2026-09-05T00:00:00.000Z",
      )!;
      const result = reconcileCodexAggregateRootCompletion({
        completion,
        completions: new Map(),
        managed: new Set(),
        pending: new Set(),
        hasUnfinishedChildren: true,
      });
      assert.equal(result.action, "terminal");
      assert.equal(result.pending.size, 0);
      assert.equal(canReopenCodexAggregateRootCompletion(result.completion), false);
      assert.equal(
        result.completion.errorMessage,
        state === "failed" ? "Selected model is at capacity" : undefined,
      );
      const replayedSuccess = reconcileCodexAggregateRootCompletion({
        ...result,
        completion: { ...completion, state: "completed" },
        hasUnfinishedChildren: true,
      });
      assert.equal(replayedSuccess.action, "duplicate");
      assert.equal(replayedSuccess.completion.state, state);
      assert.equal(replayedSuccess.pending.size, 0);
    },
  );

  it("retains successful aggregation but lets failed snapshots release an older deferred root", () => {
    const completion: CodexAggregateRootCompletion = {
      turnId: TurnId.make("root-turn"),
      state: "completed",
      observedAt: "2026-09-05T00:00:00.000Z",
    };
    const deferred = reconcileCodexAggregateRootCompletion({
      completion,
      completions: new Map(),
      managed: new Set(),
      pending: new Set(),
      hasUnfinishedChildren: true,
    });
    assert.equal(deferred.action, "defer");
    assert.equal(deferred.pending.has("root-turn"), true);
    assert.equal(canReopenCodexAggregateRootCompletion(completion), true);
    const duplicate = reconcileCodexAggregateRootCompletion({
      ...deferred,
      completion,
      hasUnfinishedChildren: true,
    });
    assert.equal(duplicate.action, "duplicate");
    const failed = reconcileCodexAggregateRootCompletion({
      ...deferred,
      completion: { ...completion, state: "failed", errorMessage: "Selected model is at capacity" },
      hasUnfinishedChildren: true,
    });
    assert.equal(failed.action, "terminal");
    assert.equal(failed.pending.size, 0);
    assert.equal(canReopenCodexAggregateRootCompletion(failed.completion), false);
    // Repair a stale already-deferred failure without requiring descendants to
    // stop or treating an unreadable child channel as terminal evidence.
    const stale = reconcileCodexAggregateRootCompletion({
      ...failed,
      completion: failed.completion,
      pending: new Set(["root-turn"]),
      hasUnfinishedChildren: true,
    });
    assert.equal(stale.action, "terminal");
    assert.equal(stale.pending.size, 0);
  });

  it("tracks aggregate child liveness from the same live-channel events as the TUI", () => {
    const parentTurnId = TurnId.make("turn-parent");
    const routes = new Map<string, TurnId>([
      ["thread-child-b", parentTurnId],
      ["thread-child-a", parentTurnId],
    ]);
    const registered = updateCodexChildConversationLiveness(
      new Map(),
      routes,
      { method: "item/completed", params: { threadId: "thread-parent" } },
      "2026-07-14T00:00:00.000Z",
    );

    assert.deepEqual(codexChildConversationThreadIdsForTurn(routes, parentTurnId), [
      "thread-child-a",
      "thread-child-b",
    ]);
    assert.equal(codexAggregateTurnHasUnfinishedChildren(routes, registered, parentTurnId), true);

    const childAStarted = updateCodexChildConversationLiveness(
      registered,
      routes,
      {
        method: "turn/started",
        params: {
          threadId: "thread-child-a",
          turn: { id: "turn-child-a", status: "inProgress" },
        },
      },
      "2026-07-14T00:00:01.000Z",
    );
    const childACompleted = updateCodexChildConversationLiveness(
      childAStarted,
      routes,
      {
        method: "turn/completed",
        params: {
          threadId: "thread-child-a",
          turn: { id: "turn-child-a", status: "completed" },
        },
      },
      "2026-07-14T00:00:02.000Z",
    );
    const childAAuthCompletionReplay = updateCodexChildConversationLiveness(
      childACompleted,
      routes,
      {
        method: "modelProvider/authRecoveryCompleted",
        params: {
          threadId: "thread-child-a",
          turnId: "turn-child-a",
          provider: "example-provider",
          message: "Credentials refreshed.",
        },
      },
      "2026-07-14T00:00:02.500Z",
    );
    const allCompleted = updateCodexChildConversationLiveness(
      childAAuthCompletionReplay,
      routes,
      {
        method: "thread/status/changed",
        params: { threadId: "thread-child-b", status: { type: "idle" } },
      },
      "2026-07-14T00:00:03.000Z",
    );

    assert.equal(childAStarted.get("thread-child-a")?.state, "active");
    assert.equal(childACompleted.get("thread-child-a")?.state, "inactive");
    assert.equal(childAAuthCompletionReplay.get("thread-child-a")?.state, "inactive");
    assert.equal(childAAuthCompletionReplay.get("thread-child-a")?.method, "turn/completed");
    assert.equal(allCompleted.get("thread-child-b")?.state, "inactive");
    assert.equal(
      codexAggregateTurnHasUnfinishedChildren(routes, allCompleted, parentTurnId),
      false,
    );
  });

  it("uses parent-emitted completed subagent activity as authoritative child liveness", () => {
    const parentTurnId = TurnId.make("turn-parent");
    const routes = new Map<string, TurnId>([["thread-child", parentTurnId]]);
    const started = updateCodexChildConversationLiveness(
      new Map(),
      routes,
      {
        method: "item/started",
        params: {
          threadId: "thread-parent",
          turnId: "turn-parent",
          item: {
            type: "subAgentActivity",
            id: "subagent-activity-started",
            kind: "started",
            agentThreadId: "thread-child",
            agentPath: "/root/workers/audit",
          },
        },
      },
      "2026-08-27T00:00:00.000Z",
    );
    const completed = updateCodexChildConversationLiveness(
      started,
      routes,
      {
        method: "item/completed",
        params: {
          threadId: "thread-parent",
          turnId: "turn-parent",
          item: {
            type: "subAgentActivity",
            id: "subagent-activity-completed",
            kind: "completed",
            agentThreadId: "thread-child",
            agentPath: "/root/workers/audit",
          },
        },
      },
      "2026-08-27T00:00:01.000Z",
    );

    assert.deepStrictEqual(started.get("thread-child"), {
      parentTurnId,
      state: "active",
      observedAt: "2026-08-27T00:00:00.000Z",
      method: "subAgentActivity:started",
    });
    assert.deepStrictEqual(completed.get("thread-child"), {
      parentTurnId,
      state: "inactive",
      observedAt: "2026-08-27T00:00:01.000Z",
      method: "subAgentActivity:completed",
    });
    assert.equal(codexAggregateTurnHasUnfinishedChildren(routes, completed, parentTurnId), false);
  });

  it("resets child liveness when Codex reuses a child thread for a later parent turn", () => {
    const firstParentTurnId = TurnId.make("turn-parent-first");
    const secondParentTurnId = TurnId.make("turn-parent-second");
    const firstRoutes = new Map<string, TurnId>([["thread-child", firstParentTurnId]]);
    const firstTurnCompleted = updateCodexChildConversationLiveness(
      new Map(),
      firstRoutes,
      {
        method: "turn/completed",
        params: {
          threadId: "thread-child",
          turn: { id: "turn-child-first", status: "completed" },
        },
      },
      "2026-07-14T00:00:00.000Z",
    );
    assert.equal(firstTurnCompleted.get("thread-child")?.state, "inactive");

    const secondRoutes = new Map<string, TurnId>([["thread-child", secondParentTurnId]]);
    const reassigned = updateCodexChildConversationLiveness(
      firstTurnCompleted,
      secondRoutes,
      { method: "item/completed", params: { threadId: "thread-parent" } },
      "2026-07-14T00:00:01.000Z",
    );

    assert.equal(reassigned.get("thread-child")?.parentTurnId, secondParentTurnId);
    assert.equal(reassigned.get("thread-child")?.state, "unknown");
    assert.equal(
      codexAggregateTurnHasUnfinishedChildren(secondRoutes, reassigned, secondParentTurnId),
      true,
    );
  });

  it("classifies live child work and terminal thread/read errors conservatively", () => {
    assert.equal(isCodexPrivateMetadataNotification("thread/attachment/updated"), true);
    assert.equal(isCodexPrivateMetadataNotification("account/gatewayOAuth/changed"), true);
    assert.equal(isCodexPrivateMetadataNotification("item/agentMessage/delta"), false);
    assert.equal(
      isCodexChildConversationWorkNotification({
        method: "account/gatewayOAuth/changed",
        params: {
          providerId: "gateway-private-account",
          status: "inProgress",
          authUrl: "https://example.invalid/login?secret=private-token",
          error: null,
        },
      }),
      false,
    );
    assert.equal(
      isCodexChildConversationWorkNotification({
        method: "thread/attachment/updated",
        params: {
          threadId: "thread-child",
          turnId: "must-not-imply-live-work",
          attachmentId: "attachment-1",
          attachmentType: "document",
          identityKey: "/private/provider-metadata",
          operation: "created",
        },
      }),
      false,
    );
    assert.equal(
      isCodexChildConversationWorkNotification({
        method: "item/agentMessage/delta",
        params: { threadId: "thread-child", turnId: "turn-child", delta: "progress" },
      }),
      true,
    );
    for (const method of [
      "thread/tokenUsage/updated",
      "thread/settings/updated",
      "model/rerouted",
    ]) {
      assert.deepEqual(
        resolveCodexChildConversationNotification(
          new Map([["thread-child", TurnId.make("owner-turn")]]),
          { method, params: { threadId: "thread-child" } } as Parameters<
            typeof resolveCodexChildConversationNotification
          >[1],
          "root-thread",
        ),
        { parentTurnId: "owner-turn", suppressLifecycle: true },
      );
    }
    assert.equal(
      isCodexChildConversationWorkNotification({
        method: "thread/tokenUsage/updated",
        params: { threadId: "thread-child" },
      }),
      false,
    );
    assert.equal(
      isCodexChildConversationWorkNotification({
        method: "modelProvider/authRecoveryStarted",
        params: {
          threadId: "thread-child",
          turnId: "turn-child",
          provider: "example-provider",
          message: "Refreshing credentials.",
        },
      }),
      false,
    );
    assert.equal(
      isCodexChildConversationWorkNotification({
        method: "modelProvider/authRecoveryCompleted",
        params: {
          threadId: "thread-child",
          turnId: "turn-child",
          provider: "example-provider",
          message: "Credentials refreshed.",
        },
      }),
      false,
    );
    assert.equal(
      isTerminalCodexChildThreadReadError(new Error("thread not loaded: child-1")),
      true,
    );
    assert.equal(
      isTerminalCodexChildThreadReadError(new Error("thread/read transport error: broken pipe")),
      false,
    );
  });
});

describe("Codex notification route fields", () => {
  it("retains turn and native item identities for hook and approval review lifecycle", () => {
    assert.deepStrictEqual(
      readCodexNotificationRouteFields({
        method: "hook/started",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          run: { id: "hook-1" },
        },
      }),
      {
        turnId: TurnId.make("turn-1"),
        itemId: ProviderItemId.make("hook-1"),
      },
    );
    assert.deepStrictEqual(
      readCodexNotificationRouteFields({
        method: "item/autoApprovalReview/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          reviewId: "review-1",
        },
      }),
      {
        turnId: TurnId.make("turn-1"),
        itemId: ProviderItemId.make("review-1"),
      },
    );
    assert.deepStrictEqual(
      readCodexNotificationRouteFields({
        method: "autoApprovalReview/strictReviewRequired",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          startedAtMs: 1_778_000_000_000,
        },
      }),
      {
        turnId: TurnId.make("turn-1"),
        itemId: undefined,
      },
    );
  });

  it("retains turn and item identities for progress and model lifecycle notifications", () => {
    assert.deepStrictEqual(
      readCodexNotificationRouteFields({
        method: "item/mcpToolCall/progress",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "mcp-1",
        },
      }),
      {
        turnId: TurnId.make("turn-1"),
        itemId: ProviderItemId.make("mcp-1"),
      },
    );
    assert.deepStrictEqual(
      readCodexNotificationRouteFields({
        method: "rawResponse/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          responseId: "response-1",
          usage: null,
        },
      }),
      {
        turnId: TurnId.make("turn-1"),
        itemId: undefined,
      },
    );
    assert.deepStrictEqual(
      readCodexNotificationRouteFields({
        method: "model/rerouted",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
        },
      }),
      {
        turnId: TurnId.make("turn-1"),
        itemId: undefined,
      },
    );
    assert.deepStrictEqual(
      readCodexNotificationRouteFields({
        method: "modelProvider/authRecoveryStarted",
        params: {
          threadId: "thread-1",
          turnId: "turn-auth-recovery",
          provider: "bedrock",
          message: "Refreshing credentials.",
        },
      }),
      {
        turnId: TurnId.make("turn-auth-recovery"),
        itemId: undefined,
      },
    );
    assert.deepStrictEqual(
      readCodexNotificationRouteFields({
        method: "modelProvider/authRecoveryCompleted",
        params: {
          threadId: "thread-1",
          turnId: "turn-auth-recovery",
          provider: "bedrock",
          message: "Credentials refreshed.",
        },
      }),
      {
        turnId: TurnId.make("turn-auth-recovery"),
        itemId: undefined,
      },
    );
    assert.deepStrictEqual(
      readCodexNotificationRouteFields({
        method: "thread/realtime/item/started",
        params: {
          threadId: "thread-1",
          item: {
            type: "bemItemPromoted",
            id: "realtime-item-1",
            realtimeSessionId: "realtime-session-1",
            item_id: "provider-item-1",
            turn_id: "turn-realtime-1",
            presentation: { type: "wholeItem" },
          },
        },
      }),
      {
        turnId: TurnId.make("turn-realtime-1"),
        itemId: ProviderItemId.make("realtime-item-1"),
      },
    );
    assert.deepStrictEqual(
      readCodexNotificationRouteFields({
        method: "thread/realtime/item/transcript/delta",
        params: {
          threadId: "thread-1",
          itemId: "realtime-transcript-1",
          delta: "private transcript text",
        },
      }),
      {
        turnId: undefined,
        itemId: ProviderItemId.make("realtime-transcript-1"),
      },
    );
  });
});

function makeThreadOpenResponse(
  threadId: string,
): CodexRpc.ClientRequestResponsesByMethod["thread/start"] {
  return {
    cwd: "/tmp/project",
    model: "gpt-5.3-codex",
    modelProvider: "openai",
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "dangerFullAccess" },
    thread: {
      cliVersion: "0.143.0",
      createdAt: 1_713_403_200,
      cwd: "/tmp/project",
      ephemeral: false,
      id: threadId,
      modelProvider: "openai",
      preview: "",
      projectId: null,
      sessionId: "session-1",
      source: "cli",
      turns: [],
      status: {
        type: "idle",
      },
      updatedAt: 1_713_403_200,
    },
  } as unknown as CodexRpc.ClientRequestResponsesByMethod["thread/start"];
}

describe("buildTurnStartParams", () => {
  it("includes plan collaboration mode when requested", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        prompt: "Make a plan",
        model: "gpt-5.3-codex",
        effort: "medium",
        interactionMode: "plan",
      }),
    );

    assert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      approvalPolicy: "never",
      sandboxPolicy: {
        type: "dangerFullAccess",
      },
      input: [
        {
          type: "text",
          text: "Make a plan",
        },
      ],
      model: "gpt-5.3-codex",
      effort: "medium",
      collaborationMode: {
        mode: "plan",
        settings: {
          model: "gpt-5.3-codex",
          reasoning_effort: "medium",
          developer_instructions: CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
        },
      },
    });
  });

  it("includes default collaboration mode and image attachments", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "auto-accept-edits",
        prompt: "Implement it",
        model: "gpt-5.3-codex",
        interactionMode: "default",
        nativeReasoningEffort: null,
        attachments: [
          {
            type: "image",
            url: "data:image/png;base64,abc",
          },
        ],
      }),
    );

    assert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      approvalPolicy: "on-request",
      sandboxPolicy: {
        type: "workspaceWrite",
      },
      input: [
        {
          type: "text",
          text: "Implement it",
        },
        {
          type: "image",
          url: "data:image/png;base64,abc",
        },
      ],
      model: "gpt-5.3-codex",
      collaborationMode: {
        mode: "default",
        settings: {
          model: "gpt-5.3-codex",
          reasoning_effort: null,
          developer_instructions: CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
        },
      },
    });
  });

  it("normalizes a persisted Claude auto mode when a thread switches to Codex", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "auto-accept-edits",
        prompt: "Continue with Codex",
        model: "gpt-5.3-codex",
        interactionMode: "auto",
        nativeReasoningEffort: null,
      }),
    );

    assert.equal(params.collaborationMode?.mode, "default");
    assert.equal(
      params.collaborationMode?.settings.developer_instructions,
      CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
    );
  });

  it("omits collaboration mode when interaction mode is absent", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "approval-required",
        prompt: "Review",
      }),
    );

    assert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      approvalPolicy: "untrusted",
      sandboxPolicy: {
        type: "readOnly",
      },
      input: [
        {
          type: "text",
          text: "Review",
        },
      ],
    });
  });

  it("preserves a native selected effort when the caller omits its override", () => {
    for (const effort of ["low", "high", "ultra", "max"]) {
      const params = Effect.runSync(
        buildTurnStartParams({
          threadId: "provider-thread-1",
          runtimeMode: "full-access",
          model: "gpt-6.1-sol",
          interactionMode: "plan",
          nativeReasoningEffort: effort,
        }),
      );
      assert.equal(params.collaborationMode?.settings.reasoning_effort, effort);
      assert.equal(params.effort, undefined);
    }
  });

  it("gives explicit effort precedence over native selection and native-default delegation", () => {
    for (const nativeReasoningEffort of ["high", null, undefined]) {
      const params = Effect.runSync(
        buildTurnStartParams({
          threadId: "provider-thread-1",
          runtimeMode: "full-access",
          interactionMode: "default",
          effort: "ultra",
          ...(nativeReasoningEffort !== undefined ? { nativeReasoningEffort } : {}),
        }),
      );
      assert.equal(params.collaborationMode?.settings.reasoning_effort, "ultra");
      assert.equal(params.effort, "ultra");
    }
  });

  it("refuses an unknown native effort rather than guessing or clearing it", () => {
    const exit = Effect.runSyncExit(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        interactionMode: "default",
      }),
    );
    assert.equal(exit._tag, "Failure");
    if (exit._tag === "Failure") {
      assert.match(String(exit.cause), /Select a reasoning effort/);
    }
  });

  it("includes additional directories as workspace-write writable roots", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        cwd: "/tmp/project",
        runtimeMode: "auto-accept-edits",
        prompt: "Implement it",
        additionalDirectories: ["/tmp/docs", "/tmp/tools"],
      }),
    );

    assert.equal(params.cwd, "/tmp/project");
    assert.deepStrictEqual(params.environments, [
      {
        environmentId: "local",
        cwd: "/tmp/project",
        runtimeWorkspaceRoots: ["/tmp/project", "/tmp/docs", "/tmp/tools"],
      },
    ]);
    assert.deepStrictEqual(params.runtimeWorkspaceRoots, [
      "/tmp/project",
      "/tmp/docs",
      "/tmp/tools",
    ]);
    assert.deepStrictEqual(params.sandboxPolicy, {
      type: "workspaceWrite",
      writableRoots: ["/tmp/docs", "/tmp/tools"],
    });
  });
});

describe("buildTurnSteerParams", () => {
  it("builds the upstream Codex turn/steer shape without turn-start overrides", () => {
    const clientCorrelationId = buildCodexSteerClientCorrelationId("message-1");
    const params = Effect.runSync(
      buildTurnSteerParams({
        threadId: "provider-thread-1",
        expectedTurnId: TurnId.make("turn-active"),
        clientUserMessageId: clientCorrelationId,
        prompt: "stay on this path",
        attachments: [
          {
            type: "image",
            url: "data:image/png;base64,abc",
          },
        ],
      }),
    );

    assert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      expectedTurnId: "turn-active",
      clientUserMessageId: clientCorrelationId,
      input: [
        {
          type: "text",
          text: "stay on this path",
        },
        {
          type: "image",
          url: "data:image/png;base64,abc",
        },
      ],
    });
  });
});

describe("readCodexSteerExpectedTurnMismatchActualTurnId", () => {
  it("extracts the app-server reported active turn id from upstream mismatch errors", () => {
    const actualTurnId = readCodexSteerExpectedTurnMismatchActualTurnId(
      CodexErrors.CodexAppServerRequestError.invalidRequest(
        "expected active turn id `turn-old` but found `turn-new`",
      ),
    );

    assert.equal(actualTurnId, "turn-new");
  });

  it("extracts the app-server reported active turn id from upstream interrupt mismatches", () => {
    const actualTurnId = readCodexExpectedActiveTurnMismatchActualTurnId(
      CodexErrors.CodexAppServerRequestError.invalidRequest(
        "expected active turn id turn-old but found turn-new",
      ),
    );

    assert.equal(actualTurnId, "turn-new");
  });

  it("ignores unrelated turn/steer request errors", () => {
    const actualTurnId = readCodexSteerExpectedTurnMismatchActualTurnId(
      CodexErrors.CodexAppServerRequestError.invalidRequest("cannot steer a review turn"),
    );

    assert.equal(actualTurnId, undefined);
  });
});

describe("Codex context compaction steer guard", () => {
  it("recognizes upstream context-compaction item type spellings", () => {
    assert.equal(isCodexContextCompactionItemType("contextCompaction"), true);
    assert.equal(isCodexContextCompactionItemType("context_compaction"), true);
    assert.equal(isCodexContextCompactionItemType("context-compaction"), true);
    assert.equal(isCodexContextCompactionItemType("commandExecution"), false);
    assert.equal(isCodexContextCompactionItemType(undefined), false);
  });

  it("tracks context compaction item lifecycle until item or turn completion", () => {
    const turnId = TurnId.make("turn-active");
    const itemId = ProviderItemId.make("context-1");

    const started = updateCodexActiveContextCompactions(new Map(), {
      method: "item/started",
      providerThreadId: "provider-thread-1",
      turnId,
      itemId,
      itemType: "contextCompaction",
      observedAt: "2026-05-26T00:00:00.000Z",
    });

    assert.deepStrictEqual(Array.from(started.values()), [
      {
        providerThreadId: "provider-thread-1",
        turnId,
        itemId,
        startedAt: "2026-05-26T00:00:00.000Z",
      },
    ]);

    const ignored = updateCodexActiveContextCompactions(started, {
      method: "item/started",
      providerThreadId: "provider-thread-1",
      turnId,
      itemId: ProviderItemId.make("command-1"),
      itemType: "commandExecution",
      observedAt: "2026-05-26T00:00:01.000Z",
    });
    assert.equal(ignored.size, 1);

    const completed = updateCodexActiveContextCompactions(started, {
      method: "item/completed",
      providerThreadId: "provider-thread-1",
      turnId,
      itemId,
      itemType: undefined,
      observedAt: "2026-05-26T00:00:02.000Z",
    });
    assert.equal(completed.size, 0);

    const restarted = updateCodexActiveContextCompactions(completed, {
      method: "item/started",
      providerThreadId: "provider-thread-1",
      turnId,
      itemId,
      itemType: "contextCompaction",
      observedAt: "2026-05-26T00:00:03.000Z",
    });
    const turnCompleted = updateCodexActiveContextCompactions(restarted, {
      method: "turn/completed",
      providerThreadId: "provider-thread-1",
      turnId,
      observedAt: "2026-05-26T00:00:04.000Z",
    });
    assert.equal(turnCompleted.size, 0);
  });

  it("builds a structured compact-turn steer precondition error without prompt data", () => {
    const error = buildCodexActiveContextCompactionSteerError({
      providerThreadId: "provider-thread-1",
      turnId: TurnId.make("turn-active"),
      itemId: ProviderItemId.make("context-1"),
      startedAt: "2026-05-26T00:00:00.000Z",
    });

    assert.equal(error.code, -32600);
    assert.equal(error.errorMessage, "cannot steer a compact turn");
    assert.deepStrictEqual(error.data, {
      message: "cannot steer a compact turn",
      codexErrorInfo: {
        activeTurnNotSteerable: {
          turnKind: "compact",
        },
      },
      additionalDetails: {
        providerThreadId: "provider-thread-1",
        turnId: "turn-active",
        itemId: "context-1",
        contextCompactionStartedAt: "2026-05-26T00:00:00.000Z",
      },
    });
  });
});

describe("Codex native root completion and aggregate input admission", () => {
  const rootTurnId = TurnId.make("completed-root-with-live-children");
  const nextTurnId = TurnId.make("next-native-root");
  const completion: CodexAggregateRootCompletion = {
    turnId: rootTurnId,
    providerThreadId: "native-root-thread",
    state: "completed",
    observedAt: "2026-09-23T10:40:00.000Z",
  };
  const session: ProviderSession = {
    provider: ProviderDriverKind.make("codex"),
    status: "running",
    runtimeMode: "full-access",
    threadId: ThreadId.make("cafe-thread"),
    resumeCursor: { threadId: completion.providerThreadId },
    activeTurnId: rootTurnId,
    createdAt: "2026-09-23T09:00:00.000Z",
    updatedAt: "2026-09-23T10:42:00.000Z",
  };
  const makeBoundary = () =>
    Effect.gen(function* () {
      return {
        semaphore: yield* Semaphore.make(1),
        completionsRef: yield* Ref.make(new Map([[String(rootTurnId), completion]])),
        rootLifecycleEpochRef: yield* Ref.make(Symbol()),
        nativeTurnStartPendingRef: yield* Ref.make(false),
        nativeTurnStartRequestRef: yield* Ref.make<symbol | undefined>(undefined),
        manualCompactionPendingRef: yield* Ref.make(false),
        closedRef: yield* Ref.make(false),
        sessionRef: yield* Ref.make(session),
      };
    });

  effectIt.effect(
    "captures newer native effort atomically with admission instead of sending preflight effort",
    () =>
      Effect.gen(function* () {
        for (const effort of ["ultra", null]) {
          const boundary = yield* makeBoundary();
          const initial = {
            ...makeReasoningEffortSnapshot("low"),
            providerThreadId: "native-root-thread",
          };
          const reasoningEffortSnapshotRef = yield* Ref.make<
            CodexReasoningEffortSnapshot | undefined
          >(initial);
          const preflightParams = yield* buildTurnStartParams({
            threadId: "native-root-thread",
            runtimeMode: "full-access",
            interactionMode: "default",
            ...(initial.effort !== undefined ? { nativeReasoningEffort: initial.effort } : {}),
          });
          // Model native settings arriving after preflight but before the
          // waiting sender owns the lifecycle boundary. Settings observation
          // and effort/request admission use the same runtime semaphore.
          yield* boundary.semaphore.withPermits(1)(
            Ref.update(reasoningEffortSnapshotRef, (current) =>
              observeCodexThreadSettingsReasoningEffort({
                current,
                currentProviderThreadId: "native-root-thread",
                notification: {
                  threadId: "native-root-thread",
                  threadSettings: {
                    model: "gpt-6.1-sol",
                    modelProvider: "openai",
                    cwd: "/workspace",
                    approvalPolicy: "never",
                    approvalsReviewer: "user",
                    sandboxPolicy: { type: "dangerFullAccess" },
                    effort,
                    collaborationMode: {
                      mode: "default",
                      settings: { model: "gpt-6.1-sol", reasoning_effort: effort },
                    },
                  },
                },
              }),
            ),
          );
          const admission = yield* admitCodexTurnStartLifecycleBoundary({
            ...boundary,
            reasoningEffortSnapshotRef,
            expectedCompletedRootTurnId: rootTurnId,
          });
          assert.notEqual(admission.reasoningEffortSnapshot?.revision, initial.revision);
          assert.equal(admission.reasoningEffortSnapshot?.effort, effort);
          assert.equal(admission.reasoningEffortSnapshot?.requestToken, admission.requestToken);
          const admittedEffort = admission.reasoningEffortSnapshot?.effort;
          const admittedParams = yield* buildTurnStartParams({
            threadId: "native-root-thread",
            runtimeMode: "full-access",
            interactionMode: "default",
            ...(admittedEffort !== undefined ? { nativeReasoningEffort: admittedEffort } : {}),
          });
          assert.equal(preflightParams.collaborationMode?.settings.reasoning_effort, "low");
          assert.equal(admittedParams.collaborationMode?.settings.reasoning_effort, effort);
        }
      }),
  );

  effectIt.effect(
    "freezes native routing at admission while later settings remain independent",
    () =>
      Effect.gen(function* () {
        const boundary = yield* makeBoundary();
        const providerThreadId = "native-root-thread";
        const serviceTierSnapshotRef = yield* Ref.make<CodexServiceTierSnapshot | undefined>(
          observeCodexServiceTier({
            current: undefined,
            providerThreadId,
            serviceTier: "priority",
          }),
        );
        yield* boundary.semaphore.withPermits(1)(
          Ref.update(serviceTierSnapshotRef, (current) =>
            observeCodexServiceTier({
              current,
              providerThreadId,
              serviceTier: null,
            }),
          ),
        );
        const admission = yield* admitCodexTurnStartLifecycleBoundary({
          ...boundary,
          serviceTierSnapshotRef,
          expectedCompletedRootTurnId: rootTurnId,
        });
        yield* boundary.semaphore.withPermits(1)(
          Ref.update(serviceTierSnapshotRef, (current) =>
            observeCodexServiceTier({
              current,
              providerThreadId,
              serviceTier: "ultrafast",
            }),
          ),
        );
        assert.equal(admission.serviceTierSnapshot?.serviceTier, "default");
        assert.equal((yield* Ref.get(serviceTierSnapshotRef))?.serviceTier, "ultrafast");
      }),
  );

  it("exports exact successful root proof without mistaking child liveness for root activity", () => {
    const input = {
      session,
      completions: new Map([[String(rootTurnId), completion]]),
      nativeTurnStartPending: false,
      manualCompactionPending: false,
      closed: false,
    };
    assert.deepEqual(readCodexRootTurnCompletion(input), {
      turnId: rootTurnId,
      providerThreadId: "native-root-thread",
      observedAt: completion.observedAt,
    });
    for (const overrides of [
      { completions: new Map() },
      { nativeTurnStartPending: true },
      { manualCompactionPending: true },
      { closed: true },
      { session: { ...session, status: "error" as const } },
      { session: { ...session, status: "closed" as const } },
      { session: { ...session, activeTurnId: nextTurnId } },
      { session: { ...session, resumeCursor: { threadId: "different-native-thread" } } },
      { session: { ...session, provider: ProviderDriverKind.make("claude") } },
      { completions: new Map([[String(rootTurnId), { ...completion, state: "failed" as const }]]) },
      {
        completions: new Map([
          [String(rootTurnId), { ...completion, state: "interrupted" as const }],
        ]),
      },
      {
        completions: new Map([[String(rootTurnId), { ...completion, turnId: nextTurnId }]]),
      },
      {
        // An older daemon's aggregate-only session carries no native proof.
        session: { ...session, resumeCursor: undefined },
      },
    ]) {
      assert.equal(readCodexRootTurnCompletion({ ...input, ...overrides }), undefined);
    }
  });

  effectIt.effect(
    "starts a new root after child reopening without retiring the prior aggregate",
    () =>
      Effect.gen(function* () {
        const boundary = yield* makeBoundary();
        const admission = yield* admitCodexTurnStartLifecycleBoundary({
          ...boundary,
          expectedCompletedRootTurnId: rootTurnId,
        });
        assert.equal(admission.supersededAggregateTurnId, rootTurnId);
        assert.deepEqual(yield* Ref.get(boundary.sessionRef), session);
        assert.equal(yield* Ref.get(boundary.nativeTurnStartPendingRef), true);
        assert.equal(
          readCodexRootTurnCompletion({
            session,
            completions: yield* Ref.get(boundary.completionsRef),
            nativeTurnStartPending: true,
            manualCompactionPending: false,
            closed: false,
          }),
          undefined,
        );
        // Child-only activity can keep the old aggregate running while the
        // root start is in flight. It must not advance the native root epoch.
        yield* Ref.update(boundary.sessionRef, (current) => ({
          ...current,
          updatedAt: "2026-09-23T10:43:01.000Z",
        }));
        assert.equal(
          yield* acknowledgeCodexTurnStartLifecycleBoundary({
            ...boundary,
            ...admission,
            turnId: nextTurnId,
            acknowledgedAt: "2026-09-23T10:43:02.000Z",
          }),
          true,
        );
        assert.equal((yield* Ref.get(boundary.sessionRef)).activeTurnId, nextTurnId);
        assert.equal(yield* Ref.get(boundary.nativeTurnStartPendingRef), false);
        // The previous aggregate's terminal record remains available to its
        // independent child-completion watcher; starting T2 does not delete T1.
        assert.deepEqual(
          (yield* Ref.get(boundary.completionsRef)).get(String(rootTurnId)),
          completion,
        );
      }),
  );

  effectIt.effect(
    "acknowledges its reserved replacement root after an unrelated delayed completion",
    () =>
      Effect.gen(function* () {
        const boundary = yield* makeBoundary();
        const admission = yield* admitCodexTurnStartLifecycleBoundary({
          ...boundary,
          expectedCompletedRootTurnId: rootTurnId,
        });
        const managedRef = yield* Ref.make<ReadonlySet<string>>(new Set());
        const pendingRef = yield* Ref.make<ReadonlySet<string>>(new Set());
        yield* boundary.semaphore.withPermits(1)(
          commitCodexAggregateRootCompletion({
            ...boundary,
            managedRef,
            pendingRef,
            completion: { ...completion, turnId: TurnId.make("delayed-older-root") },
            hasUnfinishedChildren: false,
          }),
        );
        assert.notEqual(
          yield* Ref.get(boundary.rootLifecycleEpochRef),
          admission.requestedRootLifecycleEpoch,
        );
        assert.equal(
          yield* acknowledgeCodexTurnStartLifecycleBoundary({
            ...boundary,
            ...admission,
            turnId: nextTurnId,
            acknowledgedAt: "2026-09-23T10:43:02.000Z",
          }),
          true,
        );
        assert.equal((yield* Ref.get(boundary.sessionRef)).activeTurnId, nextTurnId);
        assert.equal(yield* Ref.get(boundary.nativeTurnStartPendingRef), false);
        assert.equal(
          readCodexRootTurnCompletion({
            session: yield* Ref.get(boundary.sessionRef),
            completions: yield* Ref.get(boundary.completionsRef),
            nativeTurnStartPending: yield* Ref.get(boundary.nativeTurnStartPendingRef),
            manualCompactionPending: yield* Ref.get(boundary.manualCompactionPendingRef),
            closed: false,
          }),
          undefined,
        );
        assert.equal(
          (yield* admitCodexTurnStartLifecycleBoundary(boundary).pipe(Effect.exit))._tag,
          "Failure",
        );
      }),
  );

  effectIt.effect(
    "rejects active, unknown, compacting, closed, and mismatched root admission",
    () =>
      Effect.gen(function* () {
        for (const scenario of ["active", "unknown", "compacting", "closed", "mismatch"] as const) {
          const boundary = yield* makeBoundary();
          if (scenario === "active") yield* Ref.set(boundary.completionsRef, new Map());
          if (scenario === "unknown")
            yield* Ref.update(boundary.sessionRef, (current) => ({
              ...current,
              activeTurnId: undefined,
            }));
          if (scenario === "compacting") yield* Ref.set(boundary.manualCompactionPendingRef, true);
          if (scenario === "closed") yield* Ref.set(boundary.closedRef, true);
          const exit = yield* admitCodexTurnStartLifecycleBoundary({
            ...boundary,
            expectedCompletedRootTurnId: scenario === "mismatch" ? nextTurnId : rootTurnId,
          }).pipe(Effect.exit);
          assert.equal(exit._tag, "Failure", scenario);
          assert.equal(yield* Ref.get(boundary.nativeTurnStartPendingRef), false, scenario);
        }
      }),
  );

  effectIt.effect(
    "allows strict recovery only for idle roots or the explicitly pinned completed root",
    () =>
      Effect.gen(function* () {
        for (const scenario of [
          "unpinned-aggregate",
          "pinned-aggregate",
          "idle",
          "error",
        ] as const) {
          const boundary = yield* makeBoundary();
          if (scenario === "idle" || scenario === "error") {
            yield* Ref.update(boundary.sessionRef, (current) => ({
              ...current,
              status: scenario === "idle" ? ("ready" as const) : ("error" as const),
              activeTurnId: undefined,
            }));
          }
          const result = yield* admitCodexTurnStartLifecycleBoundary({
            ...boundary,
            allowActiveTurnSteerFallback: false,
            ...(scenario === "pinned-aggregate" ? { expectedCompletedRootTurnId: rootTurnId } : {}),
          }).pipe(Effect.exit);
          assert.equal(
            result._tag,
            scenario === "pinned-aggregate" || scenario === "idle" ? "Success" : "Failure",
            scenario,
          );
        }
      }),
  );

  effectIt.effect(
    "keeps pending native admission across missing-id starts and unrelated old completions",
    () =>
      Effect.gen(function* () {
        const boundary = yield* makeBoundary();
        yield* admitCodexTurnStartLifecycleBoundary(boundary);
        const before = yield* Ref.get(boundary.sessionRef);
        const epoch = yield* Ref.get(boundary.rootLifecycleEpochRef);
        yield* observeCodexRootTurnStartedLifecycleBoundary({ ...boundary, turnId: undefined });
        assert.equal(yield* Ref.get(boundary.nativeTurnStartPendingRef), true);
        assert.equal(yield* Ref.get(boundary.rootLifecycleEpochRef), epoch);
        assert.deepEqual(yield* Ref.get(boundary.sessionRef), before);

        const olderTurnId = TurnId.make("unrelated-older-completed-root");
        const managedRef = yield* Ref.make<ReadonlySet<string>>(new Set());
        const pendingRef = yield* Ref.make<ReadonlySet<string>>(new Set());
        yield* boundary.semaphore.withPermits(1)(
          commitCodexAggregateRootCompletion({
            ...boundary,
            managedRef,
            pendingRef,
            completion: { ...completion, turnId: olderTurnId },
            hasUnfinishedChildren: false,
          }),
        );
        assert.equal(yield* Ref.get(boundary.nativeTurnStartPendingRef), true);
        assert.notEqual(yield* Ref.get(boundary.rootLifecycleEpochRef), epoch);
        yield* observeCodexRootTurnStartedLifecycleBoundary({ ...boundary, turnId: olderTurnId });
        assert.equal(yield* Ref.get(boundary.nativeTurnStartPendingRef), true);
        assert.deepEqual(yield* Ref.get(boundary.sessionRef), before);
        assert.equal(
          (yield* admitCodexTurnStartLifecycleBoundary(boundary).pipe(Effect.exit))._tag,
          "Failure",
        );

        yield* observeCodexRootTurnStartedLifecycleBoundary({ ...boundary, turnId: nextTurnId });
        assert.equal(yield* Ref.get(boundary.nativeTurnStartPendingRef), false);
        assert.equal((yield* Ref.get(boundary.sessionRef)).activeTurnId, nextTurnId);
      }),
  );

  effectIt.effect(
    "releases the matching start reservation when terminal precedes ACK without turn/started",
    () =>
      Effect.gen(function* () {
        const boundary = yield* makeBoundary();
        yield* Ref.update(boundary.sessionRef, (current) => ({
          ...current,
          status: "ready" as const,
          activeTurnId: undefined,
        }));
        const admission = yield* admitCodexTurnStartLifecycleBoundary(boundary);
        const managedRef = yield* Ref.make<ReadonlySet<string>>(new Set());
        const pendingRef = yield* Ref.make<ReadonlySet<string>>(new Set());
        yield* boundary.semaphore.withPermits(1)(
          commitCodexAggregateRootCompletion({
            ...boundary,
            managedRef,
            pendingRef,
            completion: { ...completion, turnId: nextTurnId },
            hasUnfinishedChildren: false,
          }),
        );
        assert.equal(yield* Ref.get(boundary.nativeTurnStartPendingRef), true);
        const terminalSession = yield* Ref.get(boundary.sessionRef);
        assert.equal(
          yield* acknowledgeCodexTurnStartLifecycleBoundary({
            ...boundary,
            ...admission,
            turnId: nextTurnId,
            acknowledgedAt: "2026-09-23T10:43:02.000Z",
          }),
          false,
        );
        assert.deepEqual(yield* Ref.get(boundary.sessionRef), terminalSession);
        assert.equal(yield* Ref.get(boundary.nativeTurnStartPendingRef), false);
        assert.equal(yield* Ref.get(boundary.nativeTurnStartRequestRef), undefined);
        assert.equal(
          (yield* admitCodexTurnStartLifecycleBoundary(boundary).pipe(Effect.exit))._tag,
          "Success",
        );
      }),
  );

  effectIt.effect("never lets an older ACK or rejection release a newer start reservation", () =>
    Effect.gen(function* () {
      const boundary = yield* makeBoundary();
      const olderAdmission = yield* admitCodexTurnStartLifecycleBoundary(boundary);
      yield* observeCodexRootTurnStartedLifecycleBoundary({ ...boundary, turnId: nextTurnId });
      assert.equal(yield* Ref.get(boundary.nativeTurnStartRequestRef), undefined);
      const managedRef = yield* Ref.make<ReadonlySet<string>>(new Set());
      const pendingRef = yield* Ref.make<ReadonlySet<string>>(new Set());
      yield* boundary.semaphore.withPermits(1)(
        commitCodexAggregateRootCompletion({
          ...boundary,
          managedRef,
          pendingRef,
          completion: { ...completion, turnId: nextTurnId },
          hasUnfinishedChildren: true,
        }),
      );
      const newerAdmission = yield* admitCodexTurnStartLifecycleBoundary({
        ...boundary,
        expectedCompletedRootTurnId: nextTurnId,
      });
      const newerSession = yield* Ref.get(boundary.sessionRef);
      assert.notEqual(olderAdmission.requestToken, newerAdmission.requestToken);
      assert.equal(
        yield* acknowledgeCodexTurnStartLifecycleBoundary({
          ...boundary,
          ...olderAdmission,
          turnId: nextTurnId,
          acknowledgedAt: "2026-09-23T10:43:02.000Z",
        }),
        false,
      );
      yield* rejectCodexTurnStartLifecycleBoundary({
        ...boundary,
        ...olderAdmission,
        error: CodexErrors.CodexAppServerRequestError.invalidRequest("rejected"),
      });
      assert.equal(yield* Ref.get(boundary.nativeTurnStartPendingRef), true);
      assert.equal(yield* Ref.get(boundary.nativeTurnStartRequestRef), newerAdmission.requestToken);
      assert.deepEqual(yield* Ref.get(boundary.sessionRef), newerSession);
      const newestTurnId = TurnId.make("newest-native-root");
      assert.equal(
        yield* acknowledgeCodexTurnStartLifecycleBoundary({
          ...boundary,
          ...newerAdmission,
          turnId: newestTurnId,
          acknowledgedAt: "2026-09-23T10:43:03.000Z",
        }),
        true,
      );
      assert.equal(yield* Ref.get(boundary.nativeTurnStartPendingRef), false);
      assert.equal((yield* Ref.get(boundary.sessionRef)).activeTurnId, newestTurnId);
    }),
  );

  effectIt.effect(
    "retains exact aggregate proof after no-active rejection and protects newer/failed state",
    () =>
      Effect.gen(function* () {
        for (const scenario of ["aggregate", "stale", "newer", "failed", "compacting"] as const) {
          const boundary = yield* makeBoundary();
          if (scenario === "stale") yield* Ref.set(boundary.completionsRef, new Map());
          if (scenario === "newer")
            yield* Ref.update(boundary.sessionRef, (current) => ({
              ...current,
              activeTurnId: nextTurnId,
            }));
          if (scenario === "failed")
            yield* Ref.update(boundary.sessionRef, (current) => ({
              ...current,
              status: "error" as const,
            }));
          if (scenario === "compacting") yield* Ref.set(boundary.manualCompactionPendingRef, true);
          const before = yield* Ref.get(boundary.sessionRef);
          const result = yield* reconcileCodexNoActiveSteerLifecycleBoundary({
            ...boundary,
            expectedTurnId: rootTurnId,
            observedAt: "2026-09-23T10:43:00.000Z",
          });
          assert.equal(
            result,
            scenario === "aggregate"
              ? "aggregate-retained"
              : scenario === "stale"
                ? "stale-root-cleared"
                : "superseded",
          );
          const after = yield* Ref.get(boundary.sessionRef);
          if (scenario === "stale") {
            assert.equal(after.status, "ready");
            assert.equal(after.activeTurnId, undefined);
          } else assert.deepEqual(after, before);
        }
      }),
  );

  effectIt.effect(
    "keeps transport-ambiguous starts reserved but releases explicit rejections",
    () =>
      Effect.gen(function* () {
        for (const ambiguous of [true, false]) {
          const boundary = yield* makeBoundary();
          const admission = yield* admitCodexTurnStartLifecycleBoundary(boundary);
          yield* rejectCodexTurnStartLifecycleBoundary({
            ...boundary,
            ...admission,
            error: ambiguous
              ? new CodexErrors.CodexAppServerTransportError({ detail: "closed", cause: null })
              : CodexErrors.CodexAppServerRequestError.invalidRequest("rejected"),
          });
          assert.equal(yield* Ref.get(boundary.nativeTurnStartPendingRef), ambiguous);
          const retry = yield* admitCodexTurnStartLifecycleBoundary(boundary).pipe(Effect.exit);
          assert.equal(retry._tag, ambiguous ? "Failure" : "Success");
        }
      }),
  );

  effectIt.effect("keeps idle-only native reviews behind the active-child aggregate fence", () =>
    Effect.gen(function* () {
      const boundary = yield* makeBoundary();
      // makeBoundary owns a completed native root whose aggregate is still
      // running for children. A review must not borrow the specialized saved
      // follow-up proof that can deliberately supersede that aggregate.
      const before = yield* Ref.get(boundary.sessionRef);
      assert.equal(before.status, "running");
      const outcome = yield* admitCodexTurnStartLifecycleBoundary({
        ...boundary,
        allowActiveTurnSteerFallback: false,
        expectedCompletedRootTurnId: undefined,
      }).pipe(Effect.exit);
      assert.equal(outcome._tag, "Failure");
      assert.deepEqual(yield* Ref.get(boundary.sessionRef), before);
      assert.equal(yield* Ref.get(boundary.nativeTurnStartPendingRef), false);
      assert.equal(yield* Ref.get(boundary.nativeTurnStartRequestRef), undefined);
    }),
  );

  effectIt.effect("serializes native start and manual compaction admission before either RPC", () =>
    Effect.gen(function* () {
      const boundary = yield* makeBoundary();
      yield* Ref.update(boundary.sessionRef, (current) => ({
        ...current,
        status: "ready" as const,
        activeTurnId: undefined,
      }));
      const results = yield* Effect.all(
        [
          admitCodexTurnStartLifecycleBoundary(boundary).pipe(Effect.exit),
          requestCodexManualCompaction({
            sessionRef: boundary.sessionRef,
            pendingRef: boundary.manualCompactionPendingRef,
            lifecycleEpochRef: boundary.rootLifecycleEpochRef,
            semaphore: boundary.semaphore,
            nativeTurnStartPendingRef: boundary.nativeTurnStartPendingRef,
            request: () => Effect.void,
          }).pipe(Effect.exit),
        ],
        { concurrency: "unbounded" },
      );
      assert.equal(results.filter((result) => result._tag === "Success").length, 1);
      assert.notEqual(
        yield* Ref.get(boundary.nativeTurnStartPendingRef),
        yield* Ref.get(boundary.manualCompactionPendingRef),
      );
    }),
  );

  effectIt.effect("never lets a replacement-root ACK cross a newer native lifecycle or Stop", () =>
    Effect.gen(function* () {
      for (const scenario of ["newer", "closed", "failed-root", "compacting"] as const) {
        const boundary = yield* makeBoundary();
        const admission = yield* admitCodexTurnStartLifecycleBoundary(boundary);
        if (scenario === "newer") {
          yield* Ref.set(boundary.rootLifecycleEpochRef, Symbol());
          yield* Ref.update(boundary.sessionRef, (current) => ({
            ...current,
            activeTurnId: TurnId.make("newer-native-root"),
          }));
        } else if (scenario === "closed") yield* Ref.set(boundary.closedRef, true);
        else if (scenario === "compacting")
          yield* Ref.set(boundary.manualCompactionPendingRef, true);
        else {
          yield* Ref.set(boundary.rootLifecycleEpochRef, Symbol());
          yield* Ref.update(boundary.sessionRef, (current) => ({
            ...current,
            status: "error" as const,
            activeTurnId: undefined,
          }));
        }
        const before = yield* Ref.get(boundary.sessionRef);
        assert.equal(
          yield* acknowledgeCodexTurnStartLifecycleBoundary({
            ...boundary,
            ...admission,
            turnId: nextTurnId,
            acknowledgedAt: "2026-09-23T10:43:02.000Z",
          }),
          false,
        );
        assert.deepEqual(yield* Ref.get(boundary.sessionRef), before);
      }
    }),
  );
});

describe("Codex steer processing diagnostics", () => {
  it("accepts only fixed-size correlations inside provider runtime state", () => {
    const token = buildCodexSteerClientCorrelationId("message-1");

    assert.equal(
      resolveCodexSessionRuntimeSteerClientCorrelationId({
        clientCorrelationId: token,
        fallbackSource: "unused",
      }),
      token,
    );
    assert.equal(
      resolveCodexSessionRuntimeSteerClientCorrelationId({
        clientCorrelationId: `raw-message-${"x".repeat(4_096)}`,
        fallbackSource: "unused",
      }),
      undefined,
    );
    assert.equal(
      resolveCodexSessionRuntimeSteerClientCorrelationId({
        clientCorrelationId: undefined,
        fallbackSource: "steer-random-source",
      }),
      buildCodexSteerClientCorrelationId("steer-random-source"),
    );
  });

  it("recognizes upstream user-message item type spellings", () => {
    assert.equal(isCodexUserMessageItemType("userMessage"), true);
    assert.equal(isCodexUserMessageItemType("user_message"), true);
    assert.equal(isCodexUserMessageItemType("user-message"), true);
    assert.equal(isCodexUserMessageItemType("commandExecution"), false);
    assert.equal(isCodexUserMessageItemType(undefined), false);
  });

  it("recovers a bounded content-free message correlation after runtime restart", () => {
    const clientCorrelationId = buildCodexSteerClientCorrelationId("message-after-restart");
    const result = updateCodexPendingSteerProcessingFromNotification(new Map(), {
      method: "item/started",
      providerThreadId: "provider-thread-1",
      turnId: TurnId.make("turn-active"),
      itemId: ProviderItemId.make("user-message-after-restart"),
      itemType: "userMessage",
      clientUserMessageId: clientCorrelationId,
      observedAt: "2026-05-26T00:00:03.000Z",
      observedAtMs: 3_000,
    });

    assert.equal(result.pending, undefined);
    assert.deepStrictEqual(result.restartedObservation, {
      clientCorrelationId,
      providerThreadId: "provider-thread-1",
      turnId: "turn-active",
      providerUserMessageItemId: "user-message-after-restart",
      providerUserMessageMethod: "item/started",
      observedAt: "2026-05-26T00:00:03.000Z",
    });
    assert.equal(result.next.size, 0);
  });

  it("rejects malformed or oversized provider client ids from restart correlation", () => {
    const valid = buildCodexSteerClientCorrelationId("message-1");
    assert.equal(parseCodexSteerClientCorrelationId(" message-1"), undefined);
    assert.equal(parseCodexSteerClientCorrelationId("message-1\nspoof"), undefined);
    assert.equal(parseCodexSteerClientCorrelationId(`message-${"x".repeat(600)}`), undefined);
    assert.equal(parseCodexSteerClientCorrelationId(valid), valid);

    const malformed = updateCodexPendingSteerProcessingFromNotification(new Map(), {
      method: "item/started",
      turnId: TurnId.make("turn-active"),
      itemType: "userMessage",
      clientUserMessageId: "message-1\u202Espoof",
      observedAt: "2026-05-26T00:00:03.000Z",
      observedAtMs: 3_000,
    });
    assert.equal(malformed.restartedObservation, undefined);
  });

  it("deduplicates restart observations across the provider item lifecycle with bounded history", () => {
    const observation = {
      clientCorrelationId: buildCodexSteerClientCorrelationId("message-after-restart"),
      providerThreadId: "provider-thread-1",
      turnId: TurnId.make("turn-active"),
      providerUserMessageItemId: ProviderItemId.make("item-after-restart"),
      providerUserMessageMethod: "item/started",
      observedAt: "2026-05-26T00:00:03.000Z",
    };
    const started = claimCodexRestartedSteerProcessingObservation(new Map(), observation);
    const completed = claimCodexRestartedSteerProcessingObservation(started.next, {
      ...observation,
      providerUserMessageMethod: "item/completed",
      observedAt: "2026-05-26T00:00:03.100Z",
    });

    assert.equal(started.claimed, true);
    assert.equal(completed.claimed, false);
    assert.equal(completed.next.size, 1);

    let bounded = completed.next;
    for (let index = 0; index < 1_000; index += 1) {
      const claim = claimCodexRestartedSteerProcessingObservation(bounded, {
        ...observation,
        clientCorrelationId: buildCodexSteerClientCorrelationId(`message-${index}`),
        observedAt: new Date(Date.UTC(2026, 4, 26) + index).toISOString(),
      });
      assert.equal(claim.claimed, true);
      bounded = claim.next;
    }
    assert.equal(bounded.size, 256);
    assert.equal(bounded.has(buildCodexSteerClientCorrelationId("message-after-restart")), false);
    assert.equal(bounded.has(buildCodexSteerClientCorrelationId("message-999")), true);
  });

  it("summarizes active app-server child processes without leaking credential material", () => {
    const diagnostics = summarizeCodexAppServerChildProcesses({
      appServerPid: 100,
      diagnosticsRootPid: 1,
      rows: [
        {
          pid: 100,
          ppid: 1,
          pgid: 100,
          status: "S",
          cpuPercent: 0.1,
          rssBytes: 10_000,
          elapsed: "12:00",
          command: "codex app-server",
        },
        {
          pid: 101,
          ppid: 100,
          pgid: 100,
          status: "S",
          cpuPercent: 1.5,
          rssBytes: 20_000,
          elapsed: "21:50",
          command:
            "/opt/anaconda3/bin/python /opt/anaconda3/bin/selene burst . 262 --token npm_abcdEFGHijklMNOPqrstUVWX",
        },
        {
          pid: 102,
          ppid: 101,
          pgid: 100,
          status: "R",
          cpuPercent: 2.25,
          rssBytes: 30_000,
          elapsed: "00:05",
          command: "codex exec --model gpt-5.5 --auth-file /Users/mike/.codex/auth.json",
        },
        {
          pid: 200,
          ppid: 1,
          pgid: 200,
          status: "S",
          cpuPercent: 99,
          rssBytes: 99_000,
          elapsed: "00:01",
          command: "unrelated",
        },
      ],
    });

    assert.equal(diagnostics.status, "available");
    if (diagnostics.status !== "available") return;
    assert.equal(diagnostics.processCount, 2);
    assert.equal(diagnostics.activeProcessCount, 2);
    assert.equal(diagnostics.supportProcessCount, 0);
    assert.equal(diagnostics.totalCpuPercent, 3.75);
    assert.equal(diagnostics.totalRssBytes, 50_000);
    assert.equal(diagnostics.longestElapsed, "21:50");
    assert.deepStrictEqual(
      diagnostics.processes.map((process) => [
        process.pid,
        process.ppid,
        process.depth,
        process.role,
        process.command,
      ]),
      [
        [101, 100, 0, "active", "selene burst . 262"],
        [102, 101, 1, "active", "codex exec --model gpt-5.5"],
      ],
    );
    assert.equal(diagnostics.processes[0]?.childPids[0], 102);
    assert.ok(!diagnostics.processes[0]?.command.includes("npm_abcd"));
    assert.ok(!diagnostics.processes[1]?.command.includes("auth.json"));
  });

  it("classifies persistent Codex helper processes as support instead of active turn work", () => {
    const diagnostics = summarizeCodexAppServerChildProcesses({
      appServerPid: 100,
      diagnosticsRootPid: 1,
      rows: [
        {
          pid: 100,
          ppid: 1,
          pgid: 100,
          status: "S",
          cpuPercent: 0,
          rssBytes: 10_000,
          elapsed: "12:00",
          command: "codex app-server",
        },
        {
          pid: 101,
          ppid: 100,
          pgid: 100,
          status: "S",
          cpuPercent: 0,
          rssBytes: 20_000,
          elapsed: "11:50",
          command: "/Applications/Codex.app/Contents/Resources/SkyComputerUseClient mcp",
        },
        {
          pid: 102,
          ppid: 100,
          pgid: 100,
          status: "S",
          cpuPercent: 0,
          rssBytes: 30_000,
          elapsed: "11:45",
          command: "/Applications/Codex.app/Contents/Resources/node_repl",
        },
        {
          pid: 103,
          ppid: 100,
          pgid: 100,
          status: "S",
          cpuPercent: 0,
          rssBytes: 40_000,
          elapsed: "11:40",
          command: "/Applications/Codex.app/Contents/Resources/codex app-server --listen stdio://",
        },
        {
          pid: 104,
          ppid: 100,
          pgid: 100,
          status: "R",
          cpuPercent: 5,
          rssBytes: 50_000,
          elapsed: "00:02",
          command: "bash -lc yarn build",
        },
        {
          pid: 105,
          ppid: 100,
          pgid: 100,
          status: "S",
          cpuPercent: 0,
          rssBytes: 60_000,
          elapsed: "11:35",
          command:
            "/Users/mike/.nvm/versions/node/v25.9.0/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex app-server",
        },
      ],
    });

    assert.equal(diagnostics.status, "available");
    if (diagnostics.status !== "available") return;
    assert.equal(diagnostics.processCount, 5);
    assert.equal(diagnostics.activeProcessCount, 1);
    assert.equal(diagnostics.supportProcessCount, 4);
    assert.deepStrictEqual(
      diagnostics.processes.map((process) => [process.pid, process.role, process.supportReason]),
      [
        [101, "support", "codex-bundled-computer-use-mcp"],
        [102, "support", "codex-bundled-node-repl"],
        [103, "support", "codex-bundled-nested-app-server"],
        [104, "active", undefined],
        [105, "support", "codex-app-server-runtime"],
      ],
    );
  });

  it("marks the oldest unprocessed steer when Codex emits the injected user message item", () => {
    const turnId = TurnId.make("turn-active");
    const first = {
      steerId: "steer-1",
      clientCorrelationId: buildCodexSteerClientCorrelationId("message-1"),
      providerThreadId: "provider-thread-1",
      turnId,
      requestedAt: "2026-05-26T00:00:00.000Z",
      acknowledgedAt: "2026-05-26T00:00:00.100Z",
      acknowledgedAtMs: 100,
      ackLatencyMs: 100,
      promptByteLength: 10,
      attachmentCount: 0,
      warningCount: 0,
    };
    const second = {
      ...first,
      steerId: "steer-2",
      requestedAt: "2026-05-26T00:00:02.000Z",
      acknowledgedAt: "2026-05-26T00:00:02.100Z",
      acknowledgedAtMs: 2_100,
    };

    const { pending, next } = updateCodexPendingSteerProcessingFromNotification(
      new Map([
        [first.steerId, first],
        [second.steerId, second],
      ]),
      {
        method: "item/started",
        providerThreadId: "provider-thread-1",
        turnId,
        itemId: ProviderItemId.make("user-message-1"),
        itemType: "userMessage",
        observedAt: "2026-05-26T00:00:03.000Z",
        observedAtMs: 3_000,
      },
    );

    assert.equal(pending?.steerId, "steer-1");
    assert.equal(pending?.providerUserMessageItemId, "user-message-1");
    assert.equal(pending?.providerUserMessageMethod, "item/started");
    assert.equal(pending?.ackToProviderItemMs, 2_900);
    assert.equal(next.get("steer-2")?.processedAt, undefined);
  });

  it("matches an injected user message to its client correlation instead of acknowledgement order", () => {
    const turnId = TurnId.make("turn-active");
    const secondMessageId = decodeMessageId(`message-\u0000-\u202e-${"x".repeat(600)}-tail`);
    const first: CodexPendingSteerProcessing = {
      steerId: "steer-1",
      clientCorrelationId: buildCodexSteerClientCorrelationId("message-1"),
      providerThreadId: "provider-thread-1",
      turnId,
      requestedAt: "2026-05-26T00:00:00.000Z",
      acknowledgedAt: "2026-05-26T00:00:00.100Z",
      acknowledgedAtMs: 100,
      ackLatencyMs: 100,
      promptByteLength: 10,
      attachmentCount: 0,
      warningCount: 0,
    };
    const second: CodexPendingSteerProcessing = {
      ...first,
      steerId: "steer-2",
      clientCorrelationId: buildCodexSteerClientCorrelationId(secondMessageId),
      requestedAt: "2026-05-26T00:00:02.000Z",
      acknowledgedAt: "2026-05-26T00:00:02.100Z",
      acknowledgedAtMs: 2_100,
    };

    const { pending, next } = updateCodexPendingSteerProcessingFromNotification(
      new Map([
        [first.steerId, first],
        [second.steerId, second],
      ]),
      {
        method: "item/started",
        providerThreadId: "provider-thread-1",
        turnId,
        itemId: ProviderItemId.make("user-message-2"),
        itemType: "userMessage",
        clientUserMessageId: second.clientCorrelationId,
        observedAt: "2026-05-26T00:00:03.000Z",
        observedAtMs: 3_000,
      },
    );

    assert.equal(pending?.steerId, "steer-2");
    assert.equal(pending?.clientCorrelationId, buildCodexSteerClientCorrelationId(secondMessageId));
    assert.equal(pending?.providerUserMessageItemId, "user-message-2");
    assert.equal(next.get("steer-1")?.processedAt, undefined);
    const serializedPendingState = JSON.stringify([...next]);
    assert.equal(serializedPendingState.includes('"messageId"'), false);
    assert.equal(serializedPendingState.includes("x".repeat(600)), false);
  });

  it("does not consume another pending steer for an unknown client correlation", () => {
    const turnId = TurnId.make("turn-active");
    const pendingSteer = {
      steerId: "steer-1",
      clientCorrelationId: buildCodexSteerClientCorrelationId("message-1"),
      providerThreadId: "provider-thread-1",
      turnId,
      requestedAt: "2026-05-26T00:00:00.000Z",
      acknowledgedAt: "2026-05-26T00:00:00.100Z",
      acknowledgedAtMs: 100,
      ackLatencyMs: 100,
      promptByteLength: 10,
      attachmentCount: 0,
      warningCount: 0,
    };

    const { pending, restartedObservation, next } =
      updateCodexPendingSteerProcessingFromNotification(
        new Map([[pendingSteer.steerId, pendingSteer]]),
        {
          method: "item/started",
          providerThreadId: "provider-thread-1",
          turnId,
          itemId: ProviderItemId.make("unrelated-user-message"),
          itemType: "userMessage",
          clientUserMessageId: buildCodexSteerClientCorrelationId("some-other-client-message"),
          observedAt: "2026-05-26T00:00:03.000Z",
          observedAtMs: 3_000,
        },
      );

    assert.equal(pending, undefined);
    assert.equal(
      restartedObservation?.clientCorrelationId,
      buildCodexSteerClientCorrelationId("some-other-client-message"),
    );
    assert.equal(next.get("steer-1")?.processedAt, undefined);
  });

  it("does not let an exact client id rebind a steer from another turn", () => {
    const targetTurnId = TurnId.make("turn-target");
    const unrelatedTurnId = TurnId.make("turn-unrelated");
    const pendingSteer = {
      steerId: "steer-1",
      clientCorrelationId: buildCodexSteerClientCorrelationId("message-1"),
      providerThreadId: "provider-thread-1",
      turnId: targetTurnId,
      requestedAt: "2026-05-26T00:00:00.000Z",
      acknowledgedAt: "2026-05-26T00:00:00.100Z",
      acknowledgedAtMs: 100,
      ackLatencyMs: 100,
      promptByteLength: 10,
      attachmentCount: 0,
      warningCount: 0,
    };

    const { pending, restartedObservation, next } =
      updateCodexPendingSteerProcessingFromNotification(
        new Map([[pendingSteer.steerId, pendingSteer]]),
        {
          method: "item/started",
          providerThreadId: pendingSteer.providerThreadId,
          turnId: unrelatedTurnId,
          itemId: ProviderItemId.make("spoofed-user-message"),
          itemType: "userMessage",
          clientUserMessageId: pendingSteer.clientCorrelationId,
          observedAt: "2026-05-26T00:00:03.000Z",
          observedAtMs: 3_000,
        },
      );

    assert.equal(pending, undefined);
    assert.equal(restartedObservation, undefined);
    assert.equal(next.get(pendingSteer.steerId)?.turnId, targetTurnId);
    assert.equal(next.get(pendingSteer.steerId)?.processedAt, undefined);
  });

  it("records provider processing when the correlated user message arrives before acknowledgement", () => {
    const turnId = TurnId.make("turn-active");
    const inFlightSteer = {
      steerId: "steer-1",
      clientCorrelationId: buildCodexSteerClientCorrelationId("message-1"),
      providerThreadId: "provider-thread-1",
      turnId,
      requestedAt: "2026-05-26T00:00:00.000Z",
      promptByteLength: 10,
      attachmentCount: 0,
      warningCount: 0,
    };

    const { pending, next } = updateCodexPendingSteerProcessingFromNotification(
      new Map([[inFlightSteer.steerId, inFlightSteer]]),
      {
        method: "item/started",
        providerThreadId: "provider-thread-1",
        turnId,
        itemId: ProviderItemId.make("user-message-1"),
        itemType: "userMessage",
        clientUserMessageId: inFlightSteer.clientCorrelationId,
        observedAt: "2026-05-26T00:00:00.050Z",
        observedAtMs: 50,
      },
    );

    assert.equal(pending?.steerId, "steer-1");
    assert.equal(pending?.processedAt, "2026-05-26T00:00:00.050Z");
    assert.equal(pending?.providerUserMessageItemId, "user-message-1");
    assert.equal(pending?.ackToProviderItemMs, undefined);
    assert.equal(next.get("steer-1")?.processedAt, "2026-05-26T00:00:00.050Z");
  });

  it("preserves terminal state when acknowledgement arrives after completion", () => {
    const turnId = TurnId.make("turn-active");
    const inFlightSteer = {
      steerId: "steer-1",
      clientCorrelationId: buildCodexSteerClientCorrelationId("message-1"),
      providerThreadId: "provider-thread-1",
      turnId,
      requestedAt: "2026-05-26T00:00:00.000Z",
      promptByteLength: 10,
      attachmentCount: 0,
      warningCount: 0,
    };

    const terminal = terminalizeCodexPendingSteerProcessing(
      new Map([[inFlightSteer.steerId, inFlightSteer]]),
      {
        turnId,
        terminalState: "interrupted",
        observedAt: "2026-05-26T00:00:00.050Z",
      },
    );
    const acknowledged = acknowledgeCodexPendingSteerProcessing(terminal.next, {
      steerId: inFlightSteer.steerId,
      turnId,
      acknowledgedAt: "2026-05-26T00:00:00.100Z",
      acknowledgedAtMs: 100,
      ackLatencyMs: 100,
    });
    assert.equal(acknowledged.pending?.steerId, inFlightSteer.steerId);
    assert.equal(acknowledged.pending?.terminalState, "interrupted");

    const replayedTerminal = terminalizeCodexPendingSteerProcessing(acknowledged.next, {
      turnId,
      terminalState: "interrupted",
      observedAt: "2026-05-26T00:00:00.200Z",
    });
    assert.equal(replayedTerminal.next.get(inFlightSteer.steerId)?.terminalState, "interrupted");
  });

  effectIt.effect(
    "keeps an authoritative thread/read terminal snapshot final when the steer ACK resumes late",
    () =>
      Effect.gen(function* () {
        const turnId = TurnId.make("turn-active");
        const pending = makePendingSteerProcessingFixture(1);
        const pendingRef = yield* Ref.make(
          new Map<string, CodexPendingSteerProcessing>([[pending.steerId, pending]]),
        );
        const sessionRef = yield* Ref.make<ProviderSession>({
          provider: ProviderDriverKind.make("codex"),
          status: "running",
          runtimeMode: "full-access",
          cwd: "/workspace",
          threadId: ThreadId.make("thread-1"),
          activeTurnId: turnId,
          createdAt: "2026-05-26T00:00:00.000Z",
          updatedAt: "2026-05-26T00:00:00.000Z",
          lastError: "stale failure from a previous turn",
        });
        const semaphore = yield* Semaphore.make(1);
        const ackWaiting = yield* Deferred.make<void>();
        const releaseAck = yield* Deferred.make<void>();

        // Model the JSON-RPC response continuation being runnable but held
        // until the authoritative thread/read handler has committed. This
        // gives the regression a deterministic late-ACK order without sleeps.
        const acknowledgementFiber = yield* Effect.gen(function* () {
          yield* Deferred.succeed(ackWaiting, undefined);
          yield* Deferred.await(releaseAck);
          return yield* acknowledgeCodexSteerLifecycleBoundary({
            semaphore,
            pendingRef,
            sessionRef,
            steerId: pending.steerId,
            expectedTurnId: turnId,
            turnId,
            acknowledgedAt: "2026-05-26T00:00:00.100Z",
            acknowledgedAtMs: 100,
            ackLatencyMs: 100,
          });
        }).pipe(Effect.forkChild);

        yield* Deferred.await(ackWaiting);
        yield* reconcileCodexTerminalSnapshotSteerLifecycle({
          semaphore,
          pendingRef,
          sessionRef,
          turnId,
          turnStatus: "completed",
          observedAt: "2026-05-26T00:00:00.050Z",
        });
        yield* Deferred.succeed(releaseAck, undefined);

        const acknowledgement = yield* Fiber.join(acknowledgementFiber);
        const finalSession = yield* Ref.get(sessionRef);
        const finalPending = (yield* Ref.get(pendingRef)).get(pending.steerId);

        assert.equal(acknowledgement.restoredRunning, false);
        assert.equal(acknowledgement.pending?.acknowledgedAt, "2026-05-26T00:00:00.100Z");
        assert.equal(finalSession.status, "ready");
        assert.equal(finalSession.activeTurnId, undefined);
        assert.equal(finalSession.lastError, undefined);
        assert.equal(finalSession.updatedAt, "2026-05-26T00:00:00.050Z");
        assert.equal(finalPending?.terminalState, "completed");
        assert.equal(finalPending?.terminalObservedAt, "2026-05-26T00:00:00.050Z");
        assert.equal(finalPending?.acknowledgedAt, "2026-05-26T00:00:00.100Z");
      }),
  );

  effectIt.effect("settles a capacity-failed root before publication and a late steer ACK", () =>
    Effect.gen(function* () {
      const pending = makePendingSteerProcessingFixture(1);
      const turnId = pending.turnId;
      const completion = readCodexAggregateRootCompletion(
        {
          method: "turn/completed",
          params: {
            threadId: "provider-thread-1",
            turn: {
              id: turnId,
              status: "failed",
              error: { message: "Selected model is at capacity" },
            },
          },
        },
        "2026-09-05T00:00:00.050Z",
      )!;
      const routes = new Map(["child-a", "child-b", "child-c"].map((id) => [id, turnId]));
      const decision = reconcileCodexAggregateRootCompletion({
        completion,
        completions: new Map(),
        managed: new Set(),
        pending: new Set(),
        hasUnfinishedChildren: codexAggregateTurnHasUnfinishedChildren(routes, new Map(), turnId),
      });
      assert.equal(decision.action, "terminal");
      assert.equal(routes.size, 3);
      const pendingRef = yield* Ref.make(new Map([[pending.steerId, pending]]));
      const sessionRef = yield* Ref.make<ProviderSession>({
        provider: ProviderDriverKind.make("codex"),
        status: "running",
        runtimeMode: "full-access",
        threadId: ThreadId.make("thread-1"),
        activeTurnId: turnId,
        createdAt: "2026-09-05T00:00:00.000Z",
        updatedAt: "2026-09-05T00:00:00.000Z",
      });
      const semaphore = yield* Semaphore.make(1);
      yield* publishCodexTurnCompletionAfterLifecycleBoundary({
        semaphore,
        pendingRef,
        sessionRef,
        turnId,
        turnStatus: completion.state,
        errorMessage: completion.errorMessage,
        observedAt: completion.observedAt,
        publish: Effect.gen(function* () {
          const session = yield* Ref.get(sessionRef);
          assert.equal(session.status, "error");
          assert.equal(session.activeTurnId, undefined);
          assert.equal(session.lastError, "Selected model is at capacity");
          assert.equal((yield* Ref.get(pendingRef)).get(pending.steerId)?.terminalState, "failed");
        }),
      });
      const acknowledgement = yield* acknowledgeCodexSteerLifecycleBoundary({
        semaphore,
        pendingRef,
        sessionRef,
        steerId: pending.steerId,
        expectedTurnId: turnId,
        turnId,
        acknowledgedAt: "2026-09-05T00:00:00.100Z",
        acknowledgedAtMs: 100,
        ackLatencyMs: 100,
      });
      assert.equal(acknowledgement.restoredRunning, false);
      assert.equal((yield* Ref.get(sessionRef)).activeTurnId, undefined);
      assert.equal((yield* Ref.get(sessionRef)).lastError, "Selected model is at capacity");
      assert.equal(canReopenCodexAggregateRootCompletion(decision.completion), false);
    }),
  );

  effectIt.effect("keeps root terminal/newer/Stop truth ahead of delayed turn/start ACKs", () =>
    Effect.gen(function* () {
      const firstTurnId = TurnId.make("turn-start-ack");
      for (const scenario of [
        "ordinary",
        "old-success-replay",
        "native-started",
        "failed",
        "completed",
        "interrupted",
        "cancelled",
        "terminal-recorded",
        "newer-active",
        "provisional-terminal",
        "closed",
        "deferred-success",
      ] as const) {
        const semaphore = yield* Semaphore.make(1);
        const requestedRootLifecycleEpoch = Symbol();
        const rootLifecycleEpochRef = yield* Ref.make<symbol>(requestedRootLifecycleEpoch);
        const closedRef = yield* Ref.make(false);
        const completionsRef = yield* Ref.make(new Map<string, CodexAggregateRootCompletion>());
        const sessionRef = yield* Ref.make<ProviderSession>({
          provider: ProviderDriverKind.make("codex"),
          status: "ready",
          runtimeMode: "full-access",
          threadId: ThreadId.make("thread-1"),
          model: "gpt-6-astra",
          createdAt: "2026-09-05T00:00:00.000Z",
          updatedAt: "2026-09-05T00:00:00.000Z",
        });
        const waiting = yield* Deferred.make<void>();
        const releaseAck = yield* Deferred.make<void>();
        const ackFiber = yield* Effect.gen(function* () {
          yield* Deferred.succeed(waiting, undefined);
          yield* Deferred.await(releaseAck);
          return yield* acknowledgeCodexTurnStartLifecycleBoundary({
            semaphore,
            completionsRef,
            rootLifecycleEpochRef,
            requestedRootLifecycleEpoch,
            closedRef,
            sessionRef,
            turnId: firstTurnId,
            model: "gpt-5.6-sol",
            acknowledgedAt: "2026-09-05T00:00:00.100Z",
          });
        }).pipe(Effect.forkChild);
        yield* Deferred.await(waiting);
        if (scenario === "old-success-replay") {
          const oldCompletion: CodexAggregateRootCompletion = {
            turnId: TurnId.make("old-completed-turn"),
            state: "completed",
            observedAt: "2026-09-04T00:00:00.000Z",
          };
          const replay = reconcileCodexAggregateRootCompletion({
            completion: { ...oldCompletion, observedAt: "2026-09-05T00:00:00.050Z" },
            completions: new Map([[String(oldCompletion.turnId), oldCompletion]]),
            managed: new Set(),
            pending: new Set(),
            hasUnfinishedChildren: false,
          });
          yield* Ref.set(completionsRef, replay.completions);
          if (replay.rootLifecycleChanged) yield* Ref.set(rootLifecycleEpochRef, Symbol());
          assert.equal(replay.rootLifecycleChanged, false);
        } else if (scenario === "native-started") {
          yield* Ref.set(rootLifecycleEpochRef, Symbol());
          yield* Ref.update(sessionRef, (session): ProviderSession => ({
            ...session,
            status: "running",
            activeTurnId: firstTurnId,
            updatedAt: "2026-09-05T00:00:00.050Z",
          }));
        } else if (scenario === "newer-active") {
          // The final exact-active compare is still required if the typed
          // observer made concrete ownership visible before an epoch update.
          yield* Ref.update(sessionRef, (session): ProviderSession => ({
            ...session,
            status: "running",
            activeTurnId: TurnId.make("newer-concrete-turn"),
          }));
        } else if (scenario === "closed") {
          yield* Ref.set(closedRef, true);
          yield* Ref.update(sessionRef, (session): ProviderSession => ({
            ...session,
            status: "closed",
          }));
        } else if (scenario !== "ordinary") {
          const state =
            scenario === "failed" ||
            scenario === "provisional-terminal" ||
            scenario === "terminal-recorded"
              ? "failed"
              : scenario === "interrupted" || scenario === "cancelled"
                ? scenario
                : "completed";
          const concreteTurnId =
            scenario === "provisional-terminal"
              ? TurnId.make("concrete-terminal-turn")
              : firstTurnId;
          yield* Ref.set(
            completionsRef,
            new Map([
              [
                String(concreteTurnId),
                {
                  turnId: concreteTurnId,
                  state,
                  observedAt: "2026-09-05T00:00:00.050Z",
                },
              ],
            ]),
          );
          if (scenario === "provisional-terminal" || scenario === "deferred-success")
            yield* Ref.set(rootLifecycleEpochRef, Symbol());
          yield* Ref.update(sessionRef, (session): ProviderSession => ({
            ...session,
            status:
              scenario === "deferred-success" || scenario === "terminal-recorded"
                ? "running"
                : state === "failed"
                  ? "error"
                  : "ready",
            activeTurnId:
              scenario === "deferred-success" || scenario === "terminal-recorded"
                ? firstTurnId
                : undefined,
            lastError: state === "failed" ? "Selected model is at capacity" : undefined,
            updatedAt: "2026-09-05T00:00:00.050Z",
          }));
        }
        const beforeAck = yield* Ref.get(sessionRef);
        yield* Deferred.succeed(releaseAck, undefined);
        const ordinaryAck = scenario === "ordinary" || scenario === "old-success-replay";
        assert.equal(yield* Fiber.join(ackFiber), ordinaryAck, scenario);
        const afterAck = yield* Ref.get(sessionRef);
        if (ordinaryAck) {
          assert.equal(afterAck.status, "running");
          assert.equal(afterAck.activeTurnId, firstTurnId);
          assert.equal(afterAck.model, "gpt-5.6-sol");
        } else if (scenario === "native-started") {
          assert.deepStrictEqual(afterAck, { ...beforeAck, model: "gpt-5.6-sol" });
        } else {
          assert.deepStrictEqual(afterAck, beforeAck, scenario);
        }
      }
    }),
  );

  effectIt.effect("commits a late T1 completion before publication without clearing live T2", () =>
    Effect.gen(function* () {
      const firstTurnId = TurnId.make("turn-1");
      const secondTurnId = TurnId.make("turn-2");
      const pending = {
        ...makePendingSteerProcessingFixture(1),
        turnId: firstTurnId,
      } satisfies CodexPendingSteerProcessing;
      const pendingRef = yield* Ref.make(
        new Map<string, CodexPendingSteerProcessing>([[pending.steerId, pending]]),
      );
      const sessionRef = yield* Ref.make<ProviderSession>({
        provider: ProviderDriverKind.make("codex"),
        status: "running",
        runtimeMode: "full-access",
        cwd: "/workspace",
        threadId: ThreadId.make("thread-1"),
        activeTurnId: firstTurnId,
        createdAt: "2026-05-26T00:00:00.000Z",
        updatedAt: "2026-05-26T00:00:00.000Z",
      });
      const semaphore = yield* Semaphore.make(1);
      const terminalWaiting = yield* Deferred.make<void>();
      const releaseTerminal = yield* Deferred.make<void>();
      const stateObservedAtPublication = yield* Ref.make<{
        readonly session: ProviderSession;
        readonly pending: CodexPendingSteerProcessing | undefined;
      } | null>(null);

      // Hold the old turn's terminal handler until the newer turn has become
      // visible. This models independent notification fibers without sleeps
      // or relying on scheduler/semaphore FIFO behavior.
      const terminalFiber = yield* Effect.gen(function* () {
        yield* Deferred.succeed(terminalWaiting, undefined);
        yield* Deferred.await(releaseTerminal);
        return yield* publishCodexTurnCompletionAfterLifecycleBoundary({
          semaphore,
          pendingRef,
          sessionRef,
          turnId: firstTurnId,
          turnStatus: "completed",
          observedAt: "2026-05-26T00:00:00.200Z",
          publish: Effect.gen(function* () {
            const session = yield* Ref.get(sessionRef);
            const pendingAtPublication = (yield* Ref.get(pendingRef)).get(pending.steerId);
            yield* Ref.set(stateObservedAtPublication, {
              session,
              pending: pendingAtPublication,
            });
          }),
        });
      }).pipe(Effect.forkChild);

      yield* Deferred.await(terminalWaiting);
      yield* Ref.update(sessionRef, (session) => ({
        ...session,
        status: "running" as const,
        activeTurnId: secondTurnId,
        lastError: "turn-2 remains live",
        updatedAt: "2026-05-26T00:00:00.100Z",
      }));
      yield* Deferred.succeed(releaseTerminal, undefined);

      const terminalizedVisibleSession = yield* Fiber.join(terminalFiber);
      const finalSession = yield* Ref.get(sessionRef);
      const finalPending = (yield* Ref.get(pendingRef)).get(pending.steerId);
      const publishedState = yield* Ref.get(stateObservedAtPublication);

      assert.equal(terminalizedVisibleSession, false);
      assert.equal(finalSession.status, "running");
      assert.equal(finalSession.activeTurnId, secondTurnId);
      assert.equal(finalSession.lastError, "turn-2 remains live");
      assert.equal(finalSession.updatedAt, "2026-05-26T00:00:00.100Z");
      assert.equal(finalPending?.terminalState, "completed");
      assert.equal(finalPending?.terminalObservedAt, "2026-05-26T00:00:00.200Z");
      assert.equal(publishedState?.session.activeTurnId, secondTurnId);
      assert.equal(publishedState?.pending?.terminalState, "completed");
    }),
  );

  effectIt.effect("does not apply a late T1 failure to live T2", () =>
    Effect.gen(function* () {
      const firstTurnId = TurnId.make("turn-1");
      const secondTurnId = TurnId.make("turn-2");
      const pending = {
        ...makePendingSteerProcessingFixture(1),
        turnId: firstTurnId,
      } satisfies CodexPendingSteerProcessing;
      const pendingRef = yield* Ref.make(
        new Map<string, CodexPendingSteerProcessing>([[pending.steerId, pending]]),
      );
      const sessionRef = yield* Ref.make<ProviderSession>({
        provider: ProviderDriverKind.make("codex"),
        status: "running",
        runtimeMode: "full-access",
        cwd: "/workspace",
        threadId: ThreadId.make("thread-1"),
        activeTurnId: secondTurnId,
        createdAt: "2026-05-26T00:00:00.000Z",
        updatedAt: "2026-05-26T00:00:00.100Z",
        lastError: "turn-2 diagnostic",
      });
      const semaphore = yield* Semaphore.make(1);
      const stateObservedAtPublication = yield* Ref.make<ProviderSession | null>(null);

      const terminalizedVisibleSession = yield* publishCodexTurnCompletionAfterLifecycleBoundary({
        semaphore,
        pendingRef,
        sessionRef,
        turnId: firstTurnId,
        turnStatus: "failed",
        errorMessage: "turn-1 failed late",
        observedAt: "2026-05-26T00:00:00.200Z",
        publish: Ref.get(sessionRef).pipe(
          Effect.flatMap((session) => Ref.set(stateObservedAtPublication, session)),
        ),
      });

      const finalSession = yield* Ref.get(sessionRef);
      const finalPending = (yield* Ref.get(pendingRef)).get(pending.steerId);
      const publishedSession = yield* Ref.get(stateObservedAtPublication);

      assert.equal(terminalizedVisibleSession, false);
      assert.equal(finalSession.activeTurnId, secondTurnId);
      assert.equal(finalSession.status, "running");
      assert.equal(finalSession.lastError, "turn-2 diagnostic");
      assert.equal(finalPending?.terminalState, "failed");
      assert.equal(publishedSession?.activeTurnId, secondTurnId);
      assert.equal(publishedSession?.lastError, "turn-2 diagnostic");
    }),
  );

  it("does not recover a steer whose correlated user message was processed before terminal", () => {
    const turnId = TurnId.make("turn-active");
    const inFlightSteer = {
      steerId: "steer-1",
      clientCorrelationId: buildCodexSteerClientCorrelationId("message-1"),
      providerThreadId: "provider-thread-1",
      turnId,
      requestedAt: "2026-05-26T00:00:00.000Z",
      promptByteLength: 10,
      attachmentCount: 0,
      warningCount: 0,
    };
    const processed = updateCodexPendingSteerProcessingFromNotification(
      new Map([[inFlightSteer.steerId, inFlightSteer]]),
      {
        method: "item/started",
        providerThreadId: inFlightSteer.providerThreadId,
        turnId,
        itemId: ProviderItemId.make("user-message-1"),
        itemType: "userMessage",
        clientUserMessageId: inFlightSteer.clientCorrelationId,
        observedAt: "2026-05-26T00:00:00.050Z",
        observedAtMs: 50,
      },
    );
    const acknowledged = acknowledgeCodexPendingSteerProcessing(processed.next, {
      steerId: inFlightSteer.steerId,
      turnId,
      acknowledgedAt: "2026-05-26T00:00:00.100Z",
      acknowledgedAtMs: 100,
      ackLatencyMs: 100,
    });
    assert.equal(acknowledged.pending?.ackToProviderItemMs, 0);

    const terminal = terminalizeCodexPendingSteerProcessing(acknowledged.next, {
      turnId,
      terminalState: "completed",
      observedAt: "2026-05-26T00:00:00.200Z",
    });
    assert.equal(terminal.next.get(inFlightSteer.steerId)?.processedAt !== undefined, true);
  });

  it("retargets a stale expected-turn correlation before retrying provider I/O", () => {
    const staleTurnId = TurnId.make("turn-stale");
    const activeTurnId = TurnId.make("turn-active");
    const pending = {
      steerId: "steer-1",
      clientCorrelationId: buildCodexSteerClientCorrelationId("message-1"),
      providerThreadId: "provider-thread-1",
      turnId: staleTurnId,
      requestedAt: "2026-05-26T00:00:00.000Z",
      promptByteLength: 10,
      attachmentCount: 0,
      warningCount: 0,
      terminalObservedAt: "2026-05-26T00:00:00.050Z",
      terminalState: "completed" as const,
    };

    const retargeted = retargetCodexPendingSteerProcessing(new Map([[pending.steerId, pending]]), {
      steerId: pending.steerId,
      turnId: activeTurnId,
    });
    assert.equal(retargeted.get(pending.steerId)?.turnId, activeTurnId);
    assert.equal(retargeted.get(pending.steerId)?.terminalObservedAt, undefined);

    const terminal = terminalizeCodexPendingSteerProcessing(retargeted, {
      turnId: activeTurnId,
      terminalState: "interrupted",
      observedAt: "2026-05-26T00:00:00.100Z",
    });
    const acknowledged = acknowledgeCodexPendingSteerProcessing(terminal.next, {
      steerId: pending.steerId,
      turnId: activeTurnId,
      acknowledgedAt: "2026-05-26T00:00:00.150Z",
      acknowledgedAtMs: 150,
      ackLatencyMs: 150,
    });
    assert.equal(acknowledged.pending?.turnId, activeTurnId);
    assert.equal(acknowledged.pending?.terminalState, "interrupted");
  });

  it("never evicts unresolved steer correlations to enforce the history cap", () => {
    const unresolved = new Map<string, CodexPendingSteerProcessing>(
      Array.from({ length: 51 }, (_, index) => {
        const steerId = `steer-${index.toString().padStart(2, "0")}`;
        return [
          steerId,
          {
            steerId,
            clientCorrelationId: buildCodexSteerClientCorrelationId(`message-${index}`),
            providerThreadId: "provider-thread-1",
            turnId: TurnId.make("turn-active"),
            requestedAt: `2026-05-26T00:00:${index.toString().padStart(2, "0")}.000Z`,
            promptByteLength: 10,
            attachmentCount: 0,
            warningCount: 0,
          },
        ] as const;
      }),
    );

    assert.equal(prunePendingSteerProcessing(unresolved).size, 51);

    const withSettledOldest = new Map(unresolved);
    const oldest = withSettledOldest.get("steer-00")!;
    withSettledOldest.set("steer-00", {
      ...oldest,
      processedAt: "2026-05-26T00:01:00.000Z",
    });
    const pruned = prunePendingSteerProcessing(withSettledOldest);
    assert.equal(pruned.size, 50);
    assert.equal(pruned.has("steer-00"), false);
  });

  it("applies bounded backpressure without evicting unresolved accepted or ambiguous steers", () => {
    let current = new Map<string, CodexPendingSteerProcessing>();
    for (let index = 0; index < CODEX_PENDING_STEER_UNRESOLVED_CAPACITY; index += 1) {
      const admission = admitCodexPendingSteerProcessing(
        current,
        makePendingSteerProcessingFixture(index),
      );
      assert.equal(admission.admitted, true);
      current = admission.next;
    }

    const protectedIds = [...current.keys()];
    for (let index = 0; index < 2_000; index += 1) {
      const denied = admitCodexPendingSteerProcessing(
        current,
        makePendingSteerProcessingFixture(CODEX_PENDING_STEER_UNRESOLVED_CAPACITY + index),
      );
      assert.equal(denied.admitted, false);
      assert.equal(denied.unresolvedCount, CODEX_PENDING_STEER_UNRESOLVED_CAPACITY);
      assert.equal(denied.next.size, CODEX_PENDING_STEER_UNRESOLVED_CAPACITY);
      current = denied.next;
    }
    assert.deepStrictEqual([...current.keys()], protectedIds);

    const settled = current.get("steer-0")!;
    current.set("steer-0", {
      ...settled,
      processedAt: "2026-05-26T00:01:00.000Z",
    });
    const admittedAfterSettlement = admitCodexPendingSteerProcessing(
      current,
      makePendingSteerProcessingFixture(CODEX_PENDING_STEER_UNRESOLVED_CAPACITY + 2_001),
    );
    assert.equal(admittedAfterSettlement.admitted, true);
    assert.equal(admittedAfterSettlement.next.has("steer-0"), false);
    assert.equal(admittedAfterSettlement.next.size, CODEX_PENDING_STEER_UNRESOLVED_CAPACITY);
    for (const id of protectedIds.slice(1)) {
      assert.equal(admittedAfterSettlement.next.has(id), true);
    }
  });

  it("builds content-free steer admission backpressure errors", () => {
    const error = buildCodexPendingSteerCapacityError({
      unresolvedCount: CODEX_PENDING_STEER_UNRESOLVED_CAPACITY,
      capacity: CODEX_PENDING_STEER_UNRESOLVED_CAPACITY,
    });

    assert.equal(error.code, -32600);
    assert.equal(error.errorMessage, "cannot steer while unresolved steer capacity is exhausted");
    assert.deepStrictEqual(error.data, {
      message: "cannot steer while unresolved steer capacity is exhausted",
      additionalDetails: {
        unresolvedCount: CODEX_PENDING_STEER_UNRESOLVED_CAPACITY,
        capacity: CODEX_PENDING_STEER_UNRESOLVED_CAPACITY,
        retryableAfterReconciliation: true,
      },
    });
  });

  it("binds a user message lifecycle pair to only one pending steer", () => {
    const turnId = TurnId.make("turn-active");
    const first = {
      steerId: "steer-1",
      clientCorrelationId: buildCodexSteerClientCorrelationId("message-1"),
      providerThreadId: "provider-thread-1",
      turnId,
      requestedAt: "2026-05-26T00:00:00.000Z",
      acknowledgedAt: "2026-05-26T00:00:00.100Z",
      acknowledgedAtMs: 100,
      ackLatencyMs: 100,
      promptByteLength: 10,
      attachmentCount: 0,
      warningCount: 0,
    };
    const second = {
      ...first,
      steerId: "steer-2",
      requestedAt: "2026-05-26T00:00:02.000Z",
      acknowledgedAt: "2026-05-26T00:00:02.100Z",
      acknowledgedAtMs: 2_100,
    };
    const itemId = ProviderItemId.make("user-message-1");
    const started = updateCodexPendingSteerProcessingFromNotification(
      new Map([
        [first.steerId, first],
        [second.steerId, second],
      ]),
      {
        method: "item/started",
        providerThreadId: "provider-thread-1",
        turnId,
        itemId,
        itemType: "userMessage",
        observedAt: "2026-05-26T00:00:03.000Z",
        observedAtMs: 3_000,
      },
    );

    const completed = updateCodexPendingSteerProcessingFromNotification(started.next, {
      method: "item/completed",
      providerThreadId: "provider-thread-1",
      turnId,
      itemId,
      itemType: "userMessage",
      observedAt: "2026-05-26T00:00:03.100Z",
      observedAtMs: 3_100,
    });

    assert.equal(started.pending?.steerId, "steer-1");
    assert.equal(completed.pending, undefined);
    assert.equal(completed.restartedObservation, undefined);
    assert.equal(completed.next.get("steer-1")?.providerUserMessageMethod, "item/started");
    assert.equal(completed.next.get("steer-2")?.processedAt, undefined);
  });

  it("ignores non-user-message notifications when tracking steer processing", () => {
    const turnId = TurnId.make("turn-active");
    const pendingSteer = {
      steerId: "steer-1",
      clientCorrelationId: buildCodexSteerClientCorrelationId("message-1"),
      providerThreadId: "provider-thread-1",
      turnId,
      requestedAt: "2026-05-26T00:00:00.000Z",
      acknowledgedAt: "2026-05-26T00:00:00.000Z",
      acknowledgedAtMs: 0,
      ackLatencyMs: 0,
      promptByteLength: 10,
      attachmentCount: 0,
      warningCount: 0,
    };

    const result = updateCodexPendingSteerProcessingFromNotification(
      new Map([[pendingSteer.steerId, pendingSteer]]),
      {
        method: "item/started",
        providerThreadId: "provider-thread-1",
        turnId,
        itemId: ProviderItemId.make("command-1"),
        itemType: "commandExecution",
        observedAt: "2026-05-26T00:00:03.000Z",
        observedAtMs: 3_000,
      },
    );

    assert.equal(result.pending, undefined);
    assert.equal(result.next.get("steer-1")?.processedAt, undefined);
  });
});

describe("isRecoverableThreadResumeError", () => {
  it("matches missing thread errors", () => {
    assert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Thread does not exist",
        }),
      ),
      true,
    );
  });

  it("ignores non-recoverable resume errors", () => {
    assert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Permission denied",
        }),
      ),
      false,
    );
  });

  it("ignores unrelated missing-resource errors that do not mention threads", () => {
    assert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Config file not found",
        }),
      ),
      false,
    );
    assert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Model does not exist",
        }),
      ),
      false,
    );
  });
});

describe("buildCodexThreadSnapshotBackfillEvents", () => {
  it("never turns historical child collaboration into current-runtime task evidence", () => {
    const root = makeCodexResumeChildSnapshot(["historical-child"]);
    const events = buildCodexThreadSnapshotBackfillEvents({
      threadId: ThreadId.make("cafe-root"),
      providerThread: root,
      reason: "session-resume",
      createdAt: "2026-10-04T00:00:00.000Z",
    });
    assert.ok(root.turns[0]!.items.length > 0);
    assert.ok(events.length > 0);
    assert.equal(
      events.some((event) => event.method.startsWith("codex.subagent/")),
      false,
    );
    assert.equal(
      events.some((event) => event.method === "item/completed"),
      false,
    );
    const generation = makeCodexSubagentRuntimeGeneration();
    for (const event of events) {
      assert.ok(event.method === "turn/started" || event.method === "turn/completed");
      assert.equal(generation.stampEvent(event).subagentRuntimeId, generation.subagentRuntimeId);
    }
  });

  it("emits normal lifecycle events for the latest assistant snapshot turn", () => {
    const events = buildCodexThreadSnapshotBackfillEvents({
      threadId: ThreadId.make("thread-1"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      providerThread: {
        id: "provider-thread-1",
        turns: [
          {
            id: "turn-old",
            status: "completed",
            startedAt: 1_779_000_000,
            completedAt: 1_779_000_001,
            items: [
              {
                id: "old-message",
                type: "agentMessage",
                text: "old response",
              },
            ],
          },
          {
            id: "turn-new",
            status: "interrupted",
            startedAt: 1_779_000_100,
            completedAt: null,
            items: [
              {
                id: "new-message",
                type: "agentMessage",
                text: "new response",
              },
              {
                id: "empty-message",
                type: "agentMessage",
                text: "   ",
              },
              {
                id: "context-1",
                type: "contextCompaction",
              },
            ],
          },
        ],
      },
      createdAt: "2026-05-24T00:00:00.000Z",
      reason: "session-resume",
    });

    assert.deepStrictEqual(
      events.map((event) => ({
        id: event.id,
        method: event.method,
        turnId: event.turnId,
        itemId: event.itemId,
        createdAt: event.createdAt,
      })),
      [
        {
          id: "codex-snapshot:session-resume:provider-thread-1:turn-new:turn-started",
          method: "turn/started",
          turnId: "turn-new",
          itemId: undefined,
          createdAt: "2026-05-17T06:41:40.000Z",
        },
        {
          id: "codex-snapshot:session-resume:provider-thread-1:turn-new:new-message:item-completed",
          method: "item/completed",
          turnId: "turn-new",
          itemId: "new-message",
          createdAt: "2026-05-24T00:00:00.000Z",
        },
        {
          id: "codex-snapshot:session-resume:provider-thread-1:turn-new:turn-completed",
          method: "turn/completed",
          turnId: "turn-new",
          itemId: undefined,
          createdAt: "2026-05-24T00:00:00.000Z",
        },
      ],
    );
    assert.deepStrictEqual(events[1]?.payload, {
      completedAtMs: Date.parse("2026-05-24T00:00:00.000Z"),
      threadId: "provider-thread-1",
      turnId: "turn-new",
      item: {
        id: "new-message",
        type: "agentMessage",
        text: "new response",
      },
    });
  });

  it("can focus a non-latest turn for delayed send-turn snapshot polling", () => {
    const events = buildCodexThreadSnapshotBackfillEvents({
      threadId: ThreadId.make("thread-1"),
      providerThread: {
        id: "provider-thread-1",
        turns: [
          {
            id: "turn-target",
            status: "completed",
            startedAt: 1_779_000_000,
            completedAt: 1_779_000_010,
            items: [
              {
                id: "target-message",
                type: "agentMessage",
                text: "target response",
              },
            ],
          },
          {
            id: "turn-latest",
            status: "completed",
            startedAt: 1_779_000_020,
            completedAt: 1_779_000_030,
            items: [
              {
                id: "latest-message",
                type: "agentMessage",
                text: "latest response",
              },
            ],
          },
        ],
      },
      createdAt: "2026-05-24T00:00:00.000Z",
      reason: "send-turn-follow-up",
      focusTurnId: TurnId.make("turn-target"),
    });

    assert.deepStrictEqual(
      events.map((event) => event.turnId),
      ["turn-target", "turn-target", "turn-target"],
    );
    assert.equal(events[1]?.itemId, "target-message");
  });

  it("keeps in-progress turns running when thread/read reports idle with a live in-progress turn", () => {
    const events = buildCodexThreadSnapshotBackfillEvents({
      threadId: ThreadId.make("thread-1"),
      providerThread: {
        id: "provider-thread-1",
        status: { type: "idle" },
        turns: [
          {
            id: "turn-stale",
            status: "inProgress",
            startedAt: 1_779_000_000,
            completedAt: null,
            items: [
              {
                id: "target-message",
                type: "agentMessage",
                text: "target response",
              },
            ],
          },
        ],
      },
      createdAt: "2026-05-24T00:00:00.000Z",
      reason: "thread-status-idle-reconciliation",
      focusTurnId: TurnId.make("turn-stale"),
    });

    assert.deepStrictEqual(
      events.map((event) => event.method),
      ["turn/started", "item/completed"],
    );
    assert.equal(events.at(-1)?.method, "item/completed");
  });

  it("interrupts in-progress turns when thread/read reports a system error thread", () => {
    const events = buildCodexThreadSnapshotBackfillEvents({
      threadId: ThreadId.make("thread-1"),
      providerThread: {
        id: "provider-thread-1",
        status: { type: "systemError" },
        turns: [
          {
            id: "turn-stale",
            status: "inProgress",
            startedAt: 1_779_000_000,
            completedAt: null,
            items: [
              {
                id: "target-message",
                type: "agentMessage",
                text: "target response",
              },
            ],
          },
        ],
      },
      createdAt: "2026-05-24T00:00:00.000Z",
      reason: "thread-status-idle-reconciliation",
      focusTurnId: TurnId.make("turn-stale"),
    });

    assert.deepStrictEqual(
      events.map((event) => event.method),
      ["turn/started", "item/completed", "turn/completed"],
    );
    assert.deepStrictEqual(events[2]?.payload, {
      threadId: "provider-thread-1",
      turn: {
        id: "turn-stale",
        status: "interrupted",
        startedAt: 1_779_000_000,
        completedAt: null,
        items: [
          {
            id: "target-message",
            type: "agentMessage",
            text: "target response",
          },
        ],
      },
    });
  });
});

describe("selectCodexActiveSnapshotTurn", () => {
  it("restores only an in-progress Codex turn from a resumed thread snapshot", () => {
    const activeTurn = selectCodexActiveSnapshotTurn({
      id: "provider-thread-1",
      status: { type: "active", activeFlags: [] },
      turns: [
        {
          id: "turn-completed",
          status: "completed",
          items: [],
        },
        {
          id: "turn-running",
          status: "inProgress",
          items: [],
        },
      ],
    });

    assert.equal(activeTurn?.id, "turn-running");
  });

  it("does not restore stale active state when thread/read has no in-progress turn", () => {
    const activeTurn = selectCodexActiveSnapshotTurn({
      id: "provider-thread-1",
      status: { type: "active", activeFlags: [] },
      turns: [
        {
          id: "turn-completed",
          status: "completed",
          items: [],
        },
      ],
    });

    assert.equal(activeTurn, undefined);
  });

  it("does not restore active state from an idle Codex thread snapshot", () => {
    const activeTurn = selectCodexActiveSnapshotTurn({
      id: "provider-thread-1",
      status: { type: "idle" },
      turns: [
        {
          id: "turn-completed",
          status: "completed",
          items: [],
        },
      ],
    });

    assert.equal(activeTurn, undefined);
  });
});

describe("openCodexThread", () => {
  it.each(["thread/start", "thread/resume"] as const)(
    "preserves native routing from %s without changing requested settings",
    async (method) => {
      for (const serviceTier of [undefined, null, "priority", "ultrafast"]) {
        const calls: Array<{ method: string; payload: unknown }> = [];
        const opened = await Effect.runPromise(
          openCodexThread({
            client: {
              raw: {
                request: (requestedMethod, payload) => {
                  calls.push({ method: requestedMethod, payload });
                  return Effect.succeed({
                    ...makeThreadOpenResponse("native-root"),
                    ...(serviceTier !== undefined ? { serviceTier } : {}),
                    privateConfig: { secret: "not-public" },
                  });
                },
              },
            },
            threadId: ThreadId.make("thread-1"),
            runtimeMode: "full-access",
            cwd: process.cwd(),
            requestedModel: "gpt-6.1-sol",
            serviceTier: undefined,
            resumeThreadId: method === "thread/resume" ? "native-root" : undefined,
          }),
        );
        assert.equal(opened.serviceTier, serviceTier);
        assert.equal(Reflect.has(opened, "privateConfig"), false);
        assert.equal(calls.length, 1);
        assert.equal(calls[0]?.method, method);
        assert.equal(Reflect.has(calls[0]!.payload as object, "serviceTier"), false);
      }
    },
  );

  it.each(["list_turns", "list_items"])(
    "preserves the native thread when its SQLite history rejects %s",
    async (operation) => {
      const calls: Array<{ method: "thread/start" | "thread/resume"; payload: unknown }> = [];
      // Upstream also emits this exact MethodNotFound error for a paginated
      // rollout whose SQLite metadata is missing or still legacy. It is not
      // evidence that the native thread disappeared or that a fresh identity
      // is safe. Its mandatory resume cursor reads also run without an
      // initialTurnsPage, so dropping pagination is not a proven recovery.
      const unsupportedHistory = new CodexErrors.CodexAppServerRequestError({
        code: -32601,
        errorMessage: `${operation} is not supported yet`,
      });
      const client = {
        raw: {
          request: (method: "thread/start" | "thread/resume", payload: unknown) => {
            calls.push({ method, payload });
            return method === "thread/resume"
              ? Effect.fail(unsupportedHistory)
              : Effect.succeed(makeThreadOpenResponse("incorrect-fresh-thread"));
          },
        },
      };

      const failure = await Effect.runPromise(
        openCodexThread({
          client,
          threadId: ThreadId.make("thread-1"),
          runtimeMode: "full-access",
          cwd: "/tmp/project",
          requestedModel: "gpt-5.3-codex",
          serviceTier: undefined,
          resumeThreadId: "existing-thread",
        }).pipe(Effect.flip),
      );

      assert.equal(failure, unsupportedHistory);
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.method, "thread/resume");
      assert.equal(Reflect.get(calls[0]!.payload as object, "threadId"), "existing-thread");
      assert.equal(Reflect.get(calls[0]!.payload as object, "excludeTurns"), true);
      assert.deepStrictEqual(Reflect.get(calls[0]!.payload as object, "initialTurnsPage"), {
        itemsView: "notLoaded",
        limit: 1,
        sortDirection: "desc",
      });
    },
  );

  it("resumes with one metadata-only recent turn instead of the full thread history", async () => {
    const calls: Array<{ method: "thread/start" | "thread/resume"; payload: unknown }> = [];
    const response = {
      ...makeThreadOpenResponse("existing-thread"),
      thread: {
        ...makeThreadOpenResponse("existing-thread").thread,
        status: { type: "active", activeFlags: [] },
        turns: [],
      },
      initialTurnsPage: {
        data: [
          {
            id: "active-turn",
            items: [],
            itemsView: "notLoaded",
            status: "inProgress",
          },
        ],
        nextCursor: "older-turns",
      },
    };
    const client = {
      raw: {
        request: (method: "thread/start" | "thread/resume", payload: unknown) => {
          calls.push({ method, payload });
          return Effect.succeed(response);
        },
      },
    };

    const opened = await Effect.runPromise(
      openCodexThread({
        client,
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        requestedModel: "gpt-5.3-codex",
        serviceTier: undefined,
        resumeThreadId: "existing-thread",
      }),
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.method, "thread/resume");
    assert.deepStrictEqual(
      calls[0]?.payload && typeof calls[0].payload === "object"
        ? {
            excludeTurns: Reflect.get(calls[0].payload, "excludeTurns"),
            initialTurnsPage: Reflect.get(calls[0].payload, "initialTurnsPage"),
          }
        : null,
      {
        excludeTurns: true,
        initialTurnsPage: {
          itemsView: "notLoaded",
          limit: 1,
          sortDirection: "desc",
        },
      },
    );
    assert.deepStrictEqual(opened.thread.turns, response.initialTurnsPage.data);
    assert.equal(selectCodexActiveSnapshotTurn(opened.thread)?.id, "active-turn");
  });

  it("falls back to thread/start when resume fails recoverably", async () => {
    const calls: Array<{ method: "thread/start" | "thread/resume"; payload: unknown }> = [];
    const started = makeThreadOpenResponse("fresh-thread");
    const client = {
      raw: {
        request: (method: "thread/start" | "thread/resume", payload: unknown) => {
          calls.push({ method, payload });
          if (method === "thread/resume") {
            return Effect.fail(
              new CodexErrors.CodexAppServerRequestError({
                code: -32603,
                errorMessage: "thread not found",
              }),
            );
          }
          return Effect.succeed(started);
        },
      },
    };

    const opened = await Effect.runPromise(
      openCodexThread({
        client,
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        requestedModel: "gpt-5.3-codex",
        serviceTier: undefined,
        resumeThreadId: "stale-thread",
      }),
    );

    assert.equal(opened.thread.id, "fresh-thread");
    assert.deepStrictEqual(
      calls.map((call) => call.method),
      ["thread/resume", "thread/start"],
    );
    for (const call of calls) {
      const payload = call.payload as {
        readonly config?: Record<string, unknown>;
        readonly environments?: ReadonlyArray<{
          readonly environmentId: string;
          readonly cwd: string;
          readonly runtimeWorkspaceRoots?: ReadonlyArray<string>;
        }>;
        readonly runtimeWorkspaceRoots?: ReadonlyArray<string>;
      };
      assert.deepStrictEqual(payload.config, {});
      assert.deepStrictEqual(payload.environments, [
        {
          environmentId: "local",
          cwd: "/tmp/project",
          runtimeWorkspaceRoots: ["/tmp/project"],
        },
      ]);
      assert.deepStrictEqual(payload.runtimeWorkspaceRoots, ["/tmp/project"]);
    }
  });

  it("preserves workspace-write roots without injecting Codex compaction defaults", async () => {
    const calls: Array<{ method: "thread/start" | "thread/resume"; payload: unknown }> = [];
    const client = {
      raw: {
        request: (method: "thread/start" | "thread/resume", payload: unknown) => {
          calls.push({ method, payload });
          return Effect.succeed(makeThreadOpenResponse("fresh-thread"));
        },
      },
    };

    await Effect.runPromise(
      openCodexThread({
        client,
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "auto-accept-edits",
        cwd: "/tmp/project",
        requestedModel: "gpt-5.3-codex",
        serviceTier: undefined,
        resumeThreadId: undefined,
        additionalDirectories: ["/tmp/extra"],
      }),
    );

    const payload = calls[0]?.payload as {
      readonly config?: Record<string, unknown>;
      readonly environments?: ReadonlyArray<{
        readonly environmentId: string;
        readonly cwd: string;
        readonly runtimeWorkspaceRoots?: ReadonlyArray<string>;
      }>;
      readonly runtimeWorkspaceRoots?: ReadonlyArray<string>;
    };
    assert.deepStrictEqual(payload.config, {
      sandbox_workspace_write: {
        writable_roots: ["/tmp/extra"],
      },
    });
    assert.deepStrictEqual(payload.environments, [
      {
        environmentId: "local",
        cwd: "/tmp/project",
        runtimeWorkspaceRoots: ["/tmp/project", "/tmp/extra"],
      },
    ]);
    assert.deepStrictEqual(payload.runtimeWorkspaceRoots, ["/tmp/project", "/tmp/extra"]);
  });

  it("uses a configured auto-compact token limit for both thread/start and thread/resume", async () => {
    const calls: Array<{ method: "thread/start" | "thread/resume"; payload: unknown }> = [];
    const client = {
      raw: {
        request: (method: "thread/start" | "thread/resume", payload: unknown) => {
          calls.push({ method, payload });
          return Effect.succeed(makeThreadOpenResponse("fresh-thread"));
        },
      },
    };

    await Effect.runPromise(
      openCodexThread({
        client,
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        requestedModel: "gpt-5.3-codex",
        serviceTier: undefined,
        resumeThreadId: undefined,
        autoCompactTokenLimit: 150_000,
      }),
    );
    await Effect.runPromise(
      openCodexThread({
        client,
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        requestedModel: "gpt-5.3-codex",
        serviceTier: undefined,
        resumeThreadId: "existing-thread",
        autoCompactTokenLimit: 150_000,
      }),
    );

    assert.deepStrictEqual(
      calls.map((call) => call.method),
      ["thread/start", "thread/resume"],
    );
    for (const call of calls) {
      const payload = call.payload as { readonly config?: Record<string, unknown> };
      assert.deepStrictEqual(payload.config, {
        model_auto_compact_token_limit: 150_000,
      });
    }
  });

  it("propagates non-recoverable resume failures", async () => {
    const client = {
      raw: {
        request: (method: "thread/start" | "thread/resume", _payload: unknown) => {
          if (method === "thread/resume") {
            return Effect.fail(
              new CodexErrors.CodexAppServerRequestError({
                code: -32603,
                errorMessage: "timed out waiting for server",
              }),
            );
          }
          return Effect.succeed(makeThreadOpenResponse("fresh-thread"));
        },
      },
    };

    await assert.rejects(
      Effect.runPromise(
        openCodexThread({
          client,
          threadId: ThreadId.make("thread-1"),
          runtimeMode: "full-access",
          cwd: "/tmp/project",
          requestedModel: "gpt-5.3-codex",
          serviceTier: undefined,
          resumeThreadId: "stale-thread",
        }),
      ),
      (error: unknown) =>
        isCodexAppServerRequestError(error) &&
        error.errorMessage === "timed out waiting for server",
    );
  });
});
