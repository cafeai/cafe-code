import * as ProviderDateTime from "effect/DateTime";
import {
  CodexSettings,
  EventId,
  isCodexNativeRetryWarningPayload,
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderItemId,
  RuntimeTaskId,
  THREAD_TURN_SUBAGENT_DETAIL_MAX_MESSAGE_BYTES,
  THREAD_TURN_SUBAGENT_DETAIL_MAX_MESSAGES,
  THREAD_TURN_SUBAGENT_DETAIL_MAX_TOTAL_BYTES,
  ThreadId,
  TurnId,
  type ProviderEvent,
} from "@cafecode/contracts";
import {
  makeProviderDiagnostic,
  readProviderDiagnosticSummary,
} from "@cafecode/shared/providerDiagnostic";
import { it } from "@effect/vitest";
import * as EffectCodexSchema from "effect-codex-app-server/schema";
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import type { CodexAdapterShape } from "../Services/CodexAdapter.ts";
import {
  bridgeEventLogContext,
  canonicalizeCodexSubagentDetail,
  makeCodexNativeRetryTracker,
} from "./CodexAdapter.ts";

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
it("counts unique qualified native warning envelopes without interpreting restarted fractions", () => {
  const observe = boundRetryTracker();
  for (const [index, fraction] of ["1/5", "2/5", "1/5", "1/2", "2/2"].entries()) {
    const event = retryObservationFrame(`retry-${index}`);
    const payload = event.payload as { error: { message: string } };
    payload.error.message = `Reconnecting... ${fraction}`;
    assert.deepEqual(observe(event, "native-root"), {
      observedCount: index + 1,
      timing: "unknown",
    });
    assert.deepEqual(observe(event, "native-root"), {
      observedCount: index + 1,
      timing: "unknown",
    });
  }
  const policy = {
    ...retryObservationFrame("native-policy-retry"),
    payload: {
      threadId: "native-root",
      turnId: "native-turn-1",
      willRetry: true,
      error: { message: "Too many tool calls were denied", codexErrorInfo: "tooManyDenials" },
    },
  };
  // A typed native retry is an observation even when Cafe must not auto-replay
  // the terminal category. This counter is never continuation admission.
  assert.deepEqual(observe(policy, "native-root"), { observedCount: 6, timing: "unknown" });
});
it("binds native retry observations to the exact account, runtime, visible thread and root target", () => {
  const observe = boundRetryTracker();
  const valid = retryObservationFrame("valid-retry");
  for (const invalid of [
    { ...valid, provider: ProviderDriverKind.make("claude") },
    { ...valid, providerInstanceId: ProviderInstanceId.make("codex_foreign") },
    { ...valid, providerInstanceId: undefined },
    { ...valid, subagentRuntimeId: "bd89b1eb-f8d6-42b6-916f-cf6ee08a2642" },
    { ...valid, subagentRuntimeId: undefined },
    { ...valid, threadId: asThreadId("foreign-visible-thread") },
    { ...valid, turnId: asTurnId("foreign-turn") },
    { ...valid, kind: "request" as const },
    retryObservationFrame("wrong-root", "native-child"),
    retryObservationFrame("child-cannot-own-root", "native-root", "native-turn-1", true),
  ])
    assert.equal(observe(invalid, "native-root"), undefined);
  assert.equal(observe(valid, undefined), undefined);
  assert.equal(
    observe(
      retryObservationFrame("unknown-child-owner", "native-child", "child-turn", true),
      undefined,
    ),
    undefined,
  );
  assert.deepEqual(observe(valid, "native-root"), { observedCount: 1, timing: "unknown" });
  assert.deepEqual(
    observe(retryObservationFrame("child-1", "native-child", "child-turn", true), "native-root"),
    { observedCount: 1, timing: "unknown" },
  );
  assert.deepEqual(observe(retryObservationFrame("root-2"), "native-root"), {
    observedCount: 2,
    timing: "unknown",
  });
  assert.deepEqual(boundRetryTracker()(valid, "native-root"), {
    observedCount: 1,
    timing: "unknown",
  });
});
it("resets native retry observations only for a new proven turn and never reopens a terminal turn", () => {
  const observe = boundRetryTracker();
  assert.equal(observe(retryTurnFrame("native-turn-1"), "native-root"), undefined);
  assert.deepEqual(observe(retryObservationFrame("old-1"), "native-root"), {
    observedCount: 1,
    timing: "unknown",
  });
  assert.equal(observe(retryTurnFrame("native-turn-1"), "native-root"), undefined);
  assert.deepEqual(observe(retryObservationFrame("old-2"), "native-root"), {
    observedCount: 2,
    timing: "unknown",
  });
  assert.equal(observe(retryTurnFrame("native-turn-2"), "native-root"), undefined);
  assert.equal(observe(retryTurnFrame("native-turn-1"), "native-root"), undefined);
  assert.equal(observe(retryObservationFrame("late-old"), "native-root"), undefined);
  assert.deepEqual(
    observe(retryObservationFrame("new-1", "native-root", "native-turn-2"), "native-root"),
    { observedCount: 1, timing: "unknown" },
  );
  assert.equal(observe(retryTurnFrame("native-turn-1", true), "native-root"), undefined);
  assert.deepEqual(
    observe(retryObservationFrame("new-2", "native-root", "native-turn-2"), "native-root"),
    { observedCount: 2, timing: "unknown" },
  );
  assert.equal(observe(retryTurnFrame("native-turn-2", true), "native-root"), undefined);
  assert.equal(
    observe(retryObservationFrame("after-terminal", "native-root", "native-turn-2"), "native-root"),
    undefined,
  );
  assert.equal(observe(retryTurnFrame("native-turn-2"), "native-root"), undefined);
  assert.equal(
    observe(
      retryObservationFrame("after-late-start", "native-root", "native-turn-2"),
      "native-root",
    ),
    undefined,
  );
  assert.equal(observe(retryTurnFrame("native-turn-3"), "native-root"), undefined);
  assert.deepEqual(
    observe(
      retryObservationFrame("fresh-after-terminal", "native-root", "native-turn-3"),
      "native-root",
    ),
    { observedCount: 1, timing: "unknown" },
  );
});
it("bounds native retry counters without evicting targets or claiming a precise count after saturation", () => {
  const observe = boundRetryTracker();
  for (let index = 1; index <= 1_024; index++) {
    assert.deepEqual(observe(retryObservationFrame(`retry-${index}`), "native-root"), {
      observedCount: index,
      timing: "unknown",
    });
  }
  assert.deepEqual(observe(retryObservationFrame("retry-1"), "native-root"), {
    observedCount: 1_024,
    timing: "unknown",
  });
  assert.deepEqual(observe(retryObservationFrame("retry-overflow"), "native-root"), {
    observedCount: 1_024,
    timing: "unknown",
    countLimited: true,
  });
  assert.deepEqual(observe(retryObservationFrame("retry-1"), "native-root"), {
    observedCount: 1_024,
    timing: "unknown",
    countLimited: true,
  });
  for (let index = 1; index < 256; index++) {
    assert.deepEqual(
      observe(
        retryObservationFrame(`child-${index}`, `child-${index}`, "child-turn", true),
        "native-root",
      ),
      { observedCount: 1, timing: "unknown" },
    );
  }
  assert.equal(
    observe(
      retryObservationFrame("untracked-child", "child-256", "child-turn", true),
      "native-root",
    ),
    undefined,
  );
  assert.deepEqual(
    observe(retryObservationFrame("child-second", "child-1", "child-turn", true), "native-root"),
    { observedCount: 2, timing: "unknown" },
  );
  assert.equal(observe(retryTurnFrame("new-bounded-turn"), "native-root"), undefined);
  assert.deepEqual(
    observe(
      retryObservationFrame("reset-bounded", "native-root", "new-bounded-turn"),
      "native-root",
    ),
    { observedCount: 1, timing: "unknown" },
  );
});
it("bounds total retry fingerprint memory without recycling an unavailable counter", () => {
  const observe = boundRetryTracker();
  for (let target = 0; target < 16; target++) {
    for (let index = 1; index <= 1_024; index++) {
      const result = observe(
        retryObservationFrame(`memory-${target}-${index}`, `child-${target}`, "child-turn", true),
        "native-root",
      );
      if (target < 15) assert.deepEqual(result, { observedCount: index, timing: "unknown" });
      else
        assert.deepEqual(
          result,
          index <= 1_008
            ? { observedCount: index, timing: "unknown" }
            : { observedCount: 1_008, timing: "unknown", countLimited: true },
        );
      if (target === 15 && index === 1_024) {
        assert.ok(result);
        const diagnostic = makeProviderDiagnostic({
          observedAt: "2026-01-01T00:00:00.000Z",
          source: "codex.app-server.notification",
          status: "retry",
          subject: { kind: "subagent", id: "child-15" },
          observedRetryCount: result.observedCount,
          ...(result.countLimited === true ? { countLimited: true } : {}),
          payload: { error: { message: "Provider reconnecting" }, willRetry: true },
        });
        // Tracking all admitted targets can exhaust the global budget before
        // this target's counter saturates. The summary must remain finite
        // native retry evidence for downstream immutable clock classification.
        assert.equal(diagnostic.summary.observedRetryCount, 1_008);
        assert.equal(diagnostic.summary.countLimited, true);
        assert.deepEqual(readProviderDiagnosticSummary(diagnostic.summary), diagnostic.summary);
        assert.equal(
          isCodexNativeRetryWarningPayload({
            message: "Provider reconnecting",
            retrying: true,
            detail: { willRetry: true },
            nativeRetry: result,
            providerDiagnostic: diagnostic.summary,
          }),
          true,
        );
      }
    }
  }
  assert.equal(
    observe(
      retryObservationFrame("unavailable-memory", "child-new", "child-turn", true),
      "native-root",
    ),
    undefined,
  );
  assert.equal(
    observe(
      {
        ...retryObservationFrame("stop-child", "child-0", "child-turn", true),
        method: "codex.subagent/threadStopped",
        payload: { threadId: "child-0" },
      },
      "native-root",
    ),
    undefined,
  );
  assert.equal(
    observe(
      retryObservationFrame("stopped-late-retry", "child-0", "child-turn", true),
      "native-root",
    ),
    undefined,
  );
  assert.equal(
    observe(
      retryObservationFrame("still-unavailable-after-stop", "child-new", "child-turn", true),
      "native-root",
    ),
    undefined,
  );
  assert.deepEqual(
    observe(
      retryObservationFrame("tracked-after-release", "child-15", "child-turn", true),
      "native-root",
    ),
    { observedCount: 1_009, timing: "unknown", countLimited: true },
  );
  assert.deepEqual(
    observe(retryObservationFrame("memory-15-1", "child-15", "child-turn", true), "native-root"),
    { observedCount: 1_009, timing: "unknown", countLimited: true },
  );
});
it("terminal retry observation admission does not inspect large native item history", () => {
  const observe = boundRetryTracker();
  assert.deepEqual(observe(retryObservationFrame("before-large-terminal"), "native-root"), {
    observedCount: 1,
    timing: "unknown",
  });
  let historyReads = 0;
  const items = new Proxy(new Array(100_000), {
    ownKeys: () => {
      historyReads++;
      throw new Error("history must remain unread");
    },
  });
  const terminal = retryTurnFrame("native-turn-1", true);
  assert.equal(
    observe(
      {
        ...terminal,
        payload: {
          threadId: "native-root",
          turn: { id: "native-turn-1", status: "failed", items, error: null },
        },
      },
      "native-root",
    ),
    undefined,
  );
  assert.equal(historyReads, 0);
  assert.equal(observe(retryObservationFrame("after-large-terminal"), "native-root"), undefined);
});
it("fails closed on malformed or executable retry metadata without reading getters", () => {
  const observe = boundRetryTracker();
  const valid = retryObservationFrame("valid-after-malformed");
  let getterCalls = 0;
  const accessor = { ...(valid.payload as object) };
  Object.defineProperty(accessor, "turnId", {
    enumerable: true,
    get: () => {
      getterCalls++;
      return "native-turn-1";
    },
  });
  const nestedAccessor = { message: "Native retry" };
  Object.defineProperty(nestedAccessor, "codexErrorInfo", {
    enumerable: true,
    get: () => {
      getterCalls++;
      return "serverOverloaded";
    },
  });
  const malformed = [
    { ...(valid.payload as object), willRetry: false },
    { ...(valid.payload as object), willRetry: "true" },
    { ...(valid.payload as object), turnId: "" },
    { ...(valid.payload as object), threadId: "native-root\n" },
    { ...(valid.payload as object), error: { message: 3 } },
    { ...(valid.payload as object), error: { message: "Native retry", codexErrorInfo: 3 } },
    Object.create(valid.payload as object),
    accessor,
    { ...(valid.payload as object), error: nestedAccessor },
    {
      ...(valid.payload as object),
      future: ProviderDateTime.toDateUtc(ProviderDateTime.nowUnsafe()),
    },
    {
      ...(valid.payload as object),
      future: new Proxy(
        {},
        {
          ownKeys: () => {
            throw new Error("inert proxy refusal");
          },
        },
      ),
    },
  ];
  for (const payload of malformed)
    assert.equal(observe({ ...valid, payload }, "native-root"), undefined);
  assert.equal(observe({ ...valid, id: asEventId("x".repeat(513)) }, "native-root"), undefined);
  assert.equal(getterCalls, 0);
  assert.deepEqual(observe(valid, "native-root"), { observedCount: 1, timing: "unknown" });
});
it("redacts bridge causes for unqualified native error metadata without changing owner references", () => {
  const error = {
    message: "Public native error",
    codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 503 } },
    futurePolicy: "private-bridge-metadata-sentinel",
  };
  const event: ProviderEvent = {
    id: asEventId("bridge-error-event"),
    kind: "notification",
    provider: ProviderDriverKind.make("codex"),
    threadId: asThreadId("bridge-thread"),
    turnId: asTurnId("bridge-turn"),
    createdAt: "2026-10-11T00:00:00.000Z",
    method: "error",
    payload: { threadId: "bridge-thread", turnId: "bridge-turn", willRetry: false, error },
  };
  const original = JSON.stringify(event);
  const context = bridgeEventLogContext(event, {
    stage: "failed",
    cause: "private-bridge-cause-sentinel",
  });
  assert.equal(context.cause, "Codex error diagnostic cause redacted.");
  assert.equal(context.threadId, event.threadId);
  assert.equal(context.turnId, event.turnId);
  assert.equal(context.eventId, event.id);
  assert.doesNotMatch(JSON.stringify(context), /private-bridge-(?:metadata|cause)-sentinel/);
  assert.equal(JSON.stringify(event), original);
  assert.equal(
    bridgeEventLogContext(
      {
        ...event,
        payload: {
          threadId: "bridge-thread",
          turnId: "bridge-turn",
          willRetry: false,
          error: { message: "Public error", codexErrorInfo: "serverOverloaded" },
        },
      },
      { cause: "Known public cause" },
    ).cause,
    "Known public cause",
  );
});
it("preserves public reply phase and canonical item times with honest native cutoff", () => {
  const detail = canonicalizeCodexSubagentDetail({
    threadId: "private-native-child",
    turns: [],
    historyIncomplete: true,
    publicHistory: [
      { role: "assistant", text: "Prior final", phase: "final_answer", completedAtMs: 0 },
      { role: "user", text: "Continue" },
      {
        role: "assistant",
        text: "New work\u202e safely",
        phase: "commentary",
        startedAtMs: 1_767_225_612_000,
      },
      { role: "assistant", text: "Unknown item time", completedAtMs: Infinity },
    ],
  });
  assert.deepEqual(detail, {
    messages: [
      {
        key: "m0",
        role: "assistant",
        text: "Prior final",
        phase: "final_answer",
        timestamp: "1970-01-01T00:00:00.000Z",
      },
      {
        key: "m1",
        role: "user",
        text: "Continue",
      },
      {
        key: "m2",
        role: "assistant",
        text: "New work safely",
        phase: "commentary",
        timestamp: "2026-01-01T00:00:12.000Z",
      },
      { key: "m3", role: "assistant", text: "Unknown item time" },
    ],
    gaps: [],
    truncated: true,
    historyIncomplete: true,
  });
  assert.doesNotMatch(JSON.stringify(detail), /private-native-child|Infinity/);
});
it("presents native partial answers as public commentary, never a completed final answer", () => {
  const detail = canonicalizeCodexSubagentDetail({
    threadId: "native-child",
    turns: [
      {
        id: asTurnId("child-turn"),
        items: [
          {
            type: "agentMessage",
            id: "partial-item",
            text: "Public interim answer",
            phase: "partial_answer",
          },
        ],
      },
    ],
  });
  assert.deepEqual(detail.messages, [
    { key: "m0", role: "assistant", text: "Public interim answer", phase: "commentary" },
  ]);
});
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
it("forwards safe activity summaries with fresh local keys and no private fields", () => {
  const snapshot = {
    threadId: "PRIVATE_CHILD_ID",
    turns: [],
    publicHistory: [
      {
        role: "assistant" as const,
        text: "Public update",
        phase: "commentary" as const,
        completedAtMs: 0,
      },
    ],
    publicActivities: [
      {
        kind: "command" as const,
        detail: "git status --short",
        timestamp: "2026-10-07T00:00:00.000Z",
        nativeId: "PRIVATE_ACTIVITY_ID",
        command: "PRIVATE_COMMAND",
        arguments: { token: "PRIVATE_TOKEN" },
      },
      {
        kind: "agent_message" as const,
        timestamp: "2026-99-07T00:00:00.000Z",
        recipient: "PRIVATE_RECIPIENT",
        text: "PRIVATE_MESSAGE",
      },
      { kind: "file_read" as const, timestamp: "2026-10-07T00:00:00+00:00", path: "/PRIVATE_PATH" },
    ],
    activityHistoryIncomplete: true,
  };
  const detail = canonicalizeCodexSubagentDetail(snapshot);
  assert.deepEqual(detail.activities, [
    {
      key: "a0",
      kind: "command",
      detail: "git status --short",
      timestamp: "2026-10-07T00:00:00.000Z",
    },
    { key: "a1", kind: "agent_message" },
    { key: "a2", kind: "file_read" },
  ]);
  assert.equal(detail.activityHistoryIncomplete, true);
  assert.deepEqual(detail.messages, [
    {
      key: "m0",
      role: "assistant",
      text: "Public update",
      phase: "commentary",
      timestamp: "1970-01-01T00:00:00.000Z",
    },
  ]);
  assert.doesNotMatch(
    JSON.stringify(detail),
    /PRIVATE_|nativeId|command":|arguments|recipient|path/,
  );
});
it("bounds activity summaries independently from public text and preserves legacy absence", () => {
  const detail = canonicalizeCodexSubagentDetail({
    threadId: "activity-tail",
    turns: [],
    publicHistory: [],
    publicActivities: Array.from({ length: 129 }, (_, index) => ({
      kind: "tool" as const,
      timestamp: ProviderDateTime.formatIso(ProviderDateTime.makeUnsafe(index)),
    })),
  });
  assert.equal(detail.activities?.length, 128);
  assert.deepEqual(detail.activities?.[0], {
    key: "a1",
    kind: "tool",
    timestamp: ProviderDateTime.formatIso(ProviderDateTime.makeUnsafe(1)),
  });
  assert.deepEqual(detail.activities?.at(-1), {
    key: `a${(128).toString(36)}`,
    kind: "tool",
    timestamp: ProviderDateTime.formatIso(ProviderDateTime.makeUnsafe(128)),
  });
  assert.equal(detail.activityHistoryIncomplete, true);
  assert.equal(detail.truncated, false);
  assert.deepEqual(detail.messages, []);
  const legacy = canonicalizeCodexSubagentDetail({
    threadId: "legacy",
    turns: [],
    publicHistory: [],
  });
  assert.equal(Object.hasOwn(legacy, "activities"), false);
  assert.equal(Object.hasOwn(legacy, "activityHistoryIncomplete"), false);
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
