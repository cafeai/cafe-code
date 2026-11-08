import { describe, expect, it } from "vitest";
import {
  EnvironmentId,
  EventId,
  ThreadId,
  ProviderDriverKind,
  ProviderInstanceId,
  TurnId,
  type OrchestrationThreadActivity,
} from "@cafecode/contracts";
import {
  codexRecoveryLabel,
  connectingStopOwner,
  connectingStopCommand,
  finishStopReservation,
  latestCodexPreparationMarker,
  preparationStopOwner,
  preparationStopCommand,
  samePreparationStopIntent,
  acceptPreparationStop,
  deriveCodexRecoveryPresentation,
  shouldSuppressCodexRecoveryErrorNotification,
} from "./codexRecovery";
import { createChatPaneSharedValue } from "./chatPaneContext";
import type { Thread } from "./types";
import type { WorkLogEntry } from "./session-logic";

const observedAt = "2026-10-10T00:00:00.000Z";
const rootTurn = TurnId.make("failed-root");
const runtimeId = "10000000-0000-4000-8000-000000000001";
const account = ProviderInstanceId.make("codex-work");
const thread: Pick<Thread, "session" | "latestTurn" | "archivedAt"> = {
  archivedAt: null,
  latestTurn: {
    turnId: rootTurn,
    state: "error",
    requestedAt: observedAt,
    startedAt: observedAt,
    completedAt: observedAt,
    assistantMessageId: null,
  },
  session: {
    provider: ProviderDriverKind.make("codex"),
    providerInstanceId: account,
    status: "ready",
    orchestrationStatus: "ready",
    createdAt: observedAt,
    updatedAt: observedAt,
    lastError: "Synthetic root failure",
    subagentRuntimeId: runtimeId,
  },
};
const child: WorkLogEntry = {
  id: "child",
  label: "Live worker",
  tone: "thinking",
  createdAt: observedAt,
  subagent: {
    id: "child",
    label: "Live worker",
    status: "active",
    startedAt: observedAt,
    runtimeId,
  },
};
function marker(
  recovery = "codex-transient-root-failed",
  patch: Record<string, unknown> = {},
): OrchestrationThreadActivity {
  return {
    id: EventId.make(`marker-${recovery}`),
    kind: "runtime.warning",
    tone: "info",
    summary: "Bounded operational metadata",
    turnId: rootTurn,
    createdAt: observedAt,
    payload: {
      recovery,
      providerInstanceId: account,
      subagentRuntimeId: runtimeId,
      sessionUpdatedAt: observedAt,
      ...patch,
    },
  };
}
function present(
  activities: OrchestrationThreadActivity[] = [],
  activeSubagents: WorkLogEntry[] = [child],
  owner = thread,
) {
  return deriveCodexRecoveryPresentation({ thread: owner, activities, activeSubagents });
}

describe("Codex received recovery presentation", () => {
  it("suppresses only a matching failed-root provider error with exact pending automatic recovery", () => {
    const owner = {
      ...thread,
      error: thread.session!.lastError!,
      modelSelection: { instanceId: account, model: "gpt-6.1-sol" },
    };
    const waiting = marker("codex-transient-recovery-waiting", {
      stage: "backoff",
      retryAttempt: 3,
      continuationOrdinal: 37,
      retryAt: "2026-10-10T00:00:45.000Z",
    });
    const attempted = marker("codex-transient-continuation-attempted", {
      sourceEventSequence: 12,
      attemptOwnerId: "20000000-0000-4000-8000-000000000002",
      continuationOrdinal: 38,
    });
    const suppress = (
      activities: OrchestrationThreadActivity[],
      current: NonNullable<
        Parameters<typeof shouldSuppressCodexRecoveryErrorNotification>[0]["thread"]
      > = owner,
    ) => shouldSuppressCodexRecoveryErrorNotification({ thread: current, activities });
    const before = structuredClone(owner);
    expect(suppress([waiting])).toBe(true);
    expect(
      suppress([{ ...waiting, payload: { ...(waiting.payload as object), stage: "reconciling" } }]),
    ).toBe(true);
    expect(suppress([waiting, attempted])).toBe(true);
    expect(owner).toEqual(before);

    for (const recovery of [
      "codex-transient-root-failed",
      "codex-transient-recovery-cancelled",
      "codex-transient-recovery-uncertain",
      "codex-transient-continuation-accepted",
    ]) {
      expect(suppress([marker(recovery)])).toBe(false);
      expect(suppress([waiting, marker(recovery)])).toBe(false);
    }
    expect(suppress([])).toBe(false);
    expect(suppress([waiting], { ...owner, error: null })).toBe(false);
    expect(suppress([waiting], { ...owner, archivedAt: observedAt })).toBe(false);
    expect(suppress([waiting], { ...owner, session: null })).toBe(false);
    expect(
      suppress([waiting], { ...owner, latestTurn: { ...owner.latestTurn!, state: "completed" } }),
    ).toBe(false);
    expect(suppress([waiting], { ...owner, error: "A manual command failed" })).toBe(false);
    expect(
      suppress([waiting], {
        ...owner,
        modelSelection: { ...owner.modelSelection, instanceId: ProviderInstanceId.make("foreign") },
      }),
    ).toBe(false);
    expect(
      suppress([waiting], {
        ...owner,
        latestTurn: { ...owner.latestTurn!, completedAt: "2026-10-10T00:00:01.000Z" },
      }),
    ).toBe(false);
    expect(suppress([waiting], { ...owner, session: { ...owner.session!, status: "error" } })).toBe(
      false,
    );
    expect(
      suppress([waiting], {
        ...owner,
        session: { ...owner.session!, activeTurnId: TurnId.make("new-root") },
      }),
    ).toBe(false);
    for (const patch of [
      { providerInstanceId: "foreign" },
      { subagentRuntimeId: "replacement" },
      { sessionUpdatedAt: "2026-10-10T00:00:01.000Z" },
      { retryAttempt: -1 },
      { retryAt: "not-a-deadline" },
    ]) {
      const other = { ...waiting, payload: { ...(waiting.payload as object), ...patch } };
      expect(suppress([other])).toBe(false);
    }
    expect(suppress([{ ...waiting, turnId: TurnId.make("old-root") }])).toBe(false);
    for (const patch of [
      { sourceEventSequence: undefined },
      { sourceEventSequence: 0 },
      { attemptOwnerId: "not-a-server-owner" },
    ])
      expect(
        suppress([{ ...attempted, payload: { ...(attempted.payload as object), ...patch } }]),
      ).toBe(false);
    // A malformed later wait does not inherit the older automatic decision.
    expect(
      suppress([
        waiting,
        { ...waiting, payload: { ...(waiting.payload as object), retryAt: "bad" } },
      ]),
    ).toBe(false);
    // Foreign observations cannot retract the exact pending-owner presentation.
    expect(
      suppress([
        waiting,
        marker("codex-transient-recovery-uncertain", { providerInstanceId: "foreign" }),
      ]),
    ).toBe(true);
    let reads = 0;
    const accessor = Object.defineProperty({ ...(waiting.payload as object) }, "stage", {
      get() {
        reads++;
        return "backoff";
      },
    });
    expect(suppress([{ ...waiting, payload: accessor }])).toBe(false);
    expect(suppress([{ ...waiting, payload: Object.create(waiting.payload as object) }])).toBe(
      false,
    );
    expect(reads).toBe(0);
  });
  it("ends the old backoff at an exact attempted continuation without claiming an ACK", () => {
    const waiting = marker("codex-transient-recovery-waiting", {
      stage: "backoff",
      retryAttempt: 30,
      continuationOrdinal: 36,
      retryAt: "2026-10-10T00:00:45.000Z",
    });
    const attempted = marker("codex-transient-continuation-attempted", { continuationOrdinal: 37 });
    const result = present([waiting, attempted], [])!;
    expect(result).toEqual({
      activeAgentCount: 0,
      stage: "reconnecting",
      retryAtMs: null,
      continuationOrdinal: 37,
    });
    expect(codexRecoveryLabel(result, Date.parse(observedAt))).toBe("Retry #37");
    expect(thread.latestTurn?.state).toBe("error");
    expect(
      present(
        [
          waiting,
          {
            ...attempted,
            payload: { ...(attempted.payload as object), providerInstanceId: "foreign" },
          },
        ],
        [],
      ),
    ).toMatchObject({ stage: "backoff", continuationOrdinal: 36 });
    expect(present([attempted, marker("codex-transient-recovery-uncertain")], [])).toMatchObject({
      stage: "uncertain",
      retryAtMs: null,
    });
  });
  it("shows received continuation ordinals beyond the saturated delay index without inventing totals", () => {
    const waiting = marker("codex-transient-recovery-waiting", {
      stage: "backoff",
      retryAttempt: 30,
      continuationOrdinal: 37,
      continuationOrdinalLowerBound: true,
      retryAt: "2026-10-10T00:00:45.000Z",
    });
    const result = present([waiting], [])!;
    expect(result).toMatchObject({ continuationOrdinal: 37, continuationOrdinalLowerBound: true });
    expect(codexRecoveryLabel(result, Date.parse(observedAt))).toBe("Retry #37+ in 45s");
    expect(codexRecoveryLabel(result, result.retryAtMs!)).toBe("Retry #37+");
    expect(present([waiting, marker("codex-transient-recovery-cancelled")], [])).toBeNull();
    for (const continuationOrdinal of [
      undefined,
      0,
      -1,
      0.5,
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
      "37",
    ]) {
      const legacy = present(
        [{ ...waiting, payload: { ...(waiting.payload as object), continuationOrdinal } }],
        [],
      )!;
      expect(legacy).not.toHaveProperty("continuationOrdinal");
      expect(legacy).not.toHaveProperty("continuationOrdinalLowerBound");
      expect(codexRecoveryLabel(legacy, Date.parse(observedAt))).toBe("Retry in 45s");
    }
    expect(
      present(
        [
          waiting,
          marker("codex-transient-recovery-waiting", {
            stage: "backoff",
            retryAttempt: 30,
            continuationOrdinal: 999,
            providerInstanceId: "foreign-account",
            retryAt: "2026-10-10T00:00:59.000Z",
          }),
        ],
        [],
      ),
    ).toEqual(result);
    let reads = 0;
    const accessorPayload = Object.defineProperty(
      { ...(waiting.payload as object) },
      "continuationOrdinal",
      {
        get() {
          reads += 1;
          return 37;
        },
      },
    );
    expect(present([{ ...waiting, payload: accessorPayload }], [])).toBeNull();
    expect(reads).toBe(0);
    for (const continuationOrdinalLowerBound of [false, "true", 1, undefined]) {
      const malformed = present(
        [
          {
            ...waiting,
            payload: { ...(waiting.payload as object), continuationOrdinalLowerBound },
          },
        ],
        [],
      )!;
      expect(malformed).not.toHaveProperty("continuationOrdinal");
      expect(malformed).not.toHaveProperty("continuationOrdinalLowerBound");
      expect(codexRecoveryLabel(malformed, Date.parse(observedAt))).toBe("Retry in 45s");
    }
  });
  it("separates a failed root from exact surviving agents without reopening it", () => {
    const before = structuredClone(thread);
    expect(present()).toEqual({ activeAgentCount: 1, stage: null, retryAtMs: null });
    expect(thread).toEqual(before);
    expect(
      present([], [{ ...child, subagent: { ...child.subagent!, status: "completed" } }]),
    ).toBeNull();
    expect(
      present([], [{ ...child, subagent: { ...child.subagent!, runtimeId: "replacement" } }]),
    ).toBeNull();
  });
  it("does not borrow root, account, session timestamp or generation evidence", () => {
    for (const session of [
      null,
      { ...thread.session!, status: "error" as const },
      { ...thread.session!, orchestrationStatus: "stopped" as const },
      { ...thread.session!, subagentRuntimeId: null },
      { ...thread.session!, activeTurnId: TurnId.make("new-root") },
      { ...thread.session!, provider: ProviderDriverKind.make("claudeAgent") },
    ]) {
      expect(present([marker()], [], { ...thread, session })).toBeNull();
    }
    for (const patch of [
      { providerInstanceId: "other-account" },
      { subagentRuntimeId: "replacement" },
      { sessionUpdatedAt: "2026-10-10T01:00:00.000Z" },
    ])
      expect(present([marker(undefined, patch)], [])).toBeNull();
    expect(present([{ ...marker(), turnId: TurnId.make("other-root") }], [])).toBeNull();
    expect(
      present([marker()], [], {
        ...thread,
        latestTurn: { ...thread.latestTurn!, state: "completed" },
      }),
    ).toBeNull();
    expect(present([marker()], [], { ...thread, archivedAt: observedAt })).toBeNull();
  });
  it("renders only bounded received deadlines and never claims dispatch at expiry", () => {
    const waiting = marker("codex-transient-recovery-waiting", {
      stage: "backoff",
      retryAttempt: 30,
      retryAt: "2026-10-10T00:00:12.000Z",
    });
    const result = present([marker(), waiting], [])!;
    expect(result).toEqual({
      activeAgentCount: 0,
      stage: "backoff",
      retryAtMs: Date.parse("2026-10-10T00:00:12.000Z"),
    });
    expect(codexRecoveryLabel(result, Date.parse(observedAt) + 500)).toBe("Retry in 12s");
    expect(codexRecoveryLabel(result, result.retryAtMs!)).toBe("Reconnecting");
    expect(codexRecoveryLabel(present([marker()], [])!, Date.parse(observedAt))).toBe(
      "Reconnecting",
    );
    expect(codexRecoveryLabel({ ...result, stage: "reconciling" }, Date.parse(observedAt))).toBe(
      "Checking recovery",
    );
    for (const patch of [
      { retryAttempt: -1 },
      { retryAttempt: 31 },
      { retryAttempt: 0.5 },
      { retryAt: "not-a-date" },
      { retryAt: "2026-10-10T00:01:01.000Z" },
      { retryAt: "2026-10-09T23:59:59.000Z" },
      { stage: "running" },
    ]) {
      expect(
        present([{ ...waiting, payload: { ...(waiting.payload as object), ...patch } }], []),
      ).toBeNull();
    }
  });
  it("removes retry after cancellation while retaining verified children", () => {
    const cancelled = marker("codex-transient-recovery-cancelled");
    expect(present([marker(), cancelled], [])).toBeNull();
    expect(present([marker(), cancelled])).toEqual({
      activeAgentCount: 1,
      stage: null,
      retryAtMs: null,
    });
  });
  it("retains unknown ACK reconciliation and Stop without inventing a retry or live child", () => {
    const uncertain = marker("codex-transient-recovery-uncertain");
    const withoutChildren = present([marker(), uncertain], [])!;
    expect(withoutChildren).toEqual({ activeAgentCount: 0, stage: "uncertain", retryAtMs: null });
    expect(codexRecoveryLabel(withoutChildren, Date.parse(observedAt))).toBe(
      "Needs reconciliation",
    );
    expect(present([marker(), uncertain])).toEqual({
      activeAgentCount: 1,
      stage: "uncertain",
      retryAtMs: null,
    });
  });
  it("does not execute own accessors or inherited payload metadata", () => {
    let reads = 0;
    const accessor = Object.defineProperty({}, "recovery", {
      get: () => {
        reads += 1;
        return "codex-transient-root-failed";
      },
    });
    expect(present([{ ...marker(), payload: accessor }], [])).toBeNull();
    expect(
      present([{ ...marker(), payload: Object.create(marker().payload as object) }], []),
    ).toBeNull();
    expect(reads).toBe(0);
  });
});

describe("explicit connecting-session cancellation", () => {
  const connecting = {
    ...thread,
    id: ThreadId.make("connecting-chat"),
    environmentId: EnvironmentId.make("connecting-environment"),
    session: {
      ...thread.session!,
      status: "connecting" as const,
      orchestrationStatus: "starting" as const,
    },
  };
  it("stops the same start, or interrupts its accepted active turn", () => {
    const owner = connectingStopOwner(connecting)!;
    expect(connectingStopCommand(owner, connecting)).toBe("session-stop");
    expect(
      connectingStopCommand(owner, {
        ...connecting,
        session: {
          ...connecting.session,
          status: "running",
          orchestrationStatus: "running",
          activeTurnId: TurnId.make("accepted"),
        },
      }),
    ).toBe("turn-interrupt");
  });
  it("refuses a retired, foreign or replaced owner", () => {
    const owner = connectingStopOwner(connecting)!;
    for (const value of [
      undefined,
      { ...connecting, archivedAt: observedAt },
      { ...connecting, id: ThreadId.make("other-chat") },
      { ...connecting, environmentId: EnvironmentId.make("other-environment") },
      {
        ...connecting,
        session: {
          ...connecting.session,
          providerInstanceId: ProviderInstanceId.make("other-account"),
        },
      },
      { ...connecting, session: { ...connecting.session, subagentRuntimeId: "other-runtime" } },
      { ...connecting, session: { ...connecting.session, status: "closed" as const } },
      { ...connecting, session: { ...connecting.session, status: "ready" as const } },
    ])
      expect(connectingStopCommand(owner, value)).toBeNull();
    expect(
      connectingStopOwner({
        ...connecting,
        session: { ...connecting.session, providerInstanceId: undefined },
      }),
    ).toBeNull();
  });
  it("does not treat absent runtime as a stable identity across updates", () => {
    const missing = {
      ...connecting,
      session: { ...connecting.session, subagentRuntimeId: undefined },
    };
    const owner = connectingStopOwner(missing)!;
    expect(connectingStopCommand(owner, missing)).toBe("session-stop");
    expect(
      connectingStopCommand(owner, {
        ...missing,
        session: { ...missing.session, updatedAt: "2026-10-10T00:00:01.000Z" },
      }),
    ).toBeNull();
  });
});

describe("per-chat Stop reservations", () => {
  it("publishes the same chat's reservation to both pane subscribers", () => {
    const shared = createChatPaneSharedValue<Readonly<Record<string, string>>>({});
    const first: string[] = [];
    const second: string[] = [];
    const offFirst = shared.subscribe(() =>
      first.push(shared.snapshot()["environment/chat"] ?? "idle"),
    );
    const offSecond = shared.subscribe(() =>
      second.push(shared.snapshot()["environment/chat"] ?? "idle"),
    );
    shared.set({ "environment/chat": "stop-a" });
    shared.set((current) => finishStopReservation(current, "environment/chat", "stop-a"));
    offFirst();
    offSecond();
    expect(first).toEqual(["stop-a", "idle"]);
    expect(second).toEqual(first);
  });
  it("keeps another chat and a newer reservation when an older Stop settles", () => {
    const both = { "environment-a/chat-a": "stop-a", "environment-a/chat-b": "stop-b" };
    expect(finishStopReservation(both, "environment-a/chat-a", "stop-a")).toEqual({
      "environment-a/chat-b": "stop-b",
    });
    const newer = { ...both, "environment-a/chat-a": "stop-a-new" };
    expect(finishStopReservation(newer, "environment-a/chat-a", "stop-a")).toBe(newer);
    expect(finishStopReservation(newer, "environment-b/chat-a", "stop-a")).toBe(newer);
    expect(finishStopReservation(newer, "environment-a/chat-b", "stop-b")).toEqual({
      "environment-a/chat-a": "stop-a-new",
    });
  });
});

describe("explicit Stop during detached preparation", () => {
  const mk = (
    intent: number,
    source: number,
    sequence: number,
    phase: "preparing" | "uncertain" | "retryable" | "retired",
    eventSequence: number,
  ): OrchestrationThreadActivity => ({
    id: EventId.make(`server:codex-preparation:${intent}:${sequence}:${phase}`),
    kind: "runtime.warning",
    tone: "info",
    summary: "Synthetic preparation",
    turnId: rootTurn,
    createdAt: observedAt,
    sequence: eventSequence,
    payload: {
      recovery: "codex-transient-preparation",
      phase,
      recoveryIntentSequence: intent,
      sourceEventSequence: source,
      preparationSequence: sequence,
      observedWaits: 0,
    },
  });
  const pending = mk(20, 10, 0, "preparing", 30);
  const subject = {
    ...thread,
    id: ThreadId.make("preparing-chat"),
    environmentId: EnvironmentId.make("preparing-environment"),
    session: null,
    modelSelection: { instanceId: account, model: "synthetic-model" },
    runtimeMode: "full-access",
    messages: [],
    activities: [pending],
  } as unknown as Thread;
  it("offers a human Stop with no live session but never for terminal/newer-root observations", () => {
    const owner = preparationStopOwner(subject)!;
    expect(preparationStopCommand(owner, subject)).toBe("session-stop");
    expect(
      preparationStopOwner({ ...subject, activities: [pending, mk(20, 10, 0, "retired", 31)] }),
    ).toBeNull();
    expect(
      preparationStopCommand(owner, {
        ...subject,
        latestTurn: { ...subject.latestTurn!, state: "completed" },
      }),
    ).toBeNull();
    expect(preparationStopCommand(owner, { ...subject, archivedAt: observedAt })).toBeNull();
  });
  it("refuses changed intent, account, session and environment", () => {
    const owner = preparationStopOwner(subject)!;
    for (const next of [
      { ...subject, environmentId: EnvironmentId.make("other") },
      {
        ...subject,
        modelSelection: { ...subject.modelSelection, instanceId: ProviderInstanceId.make("other") },
      },
      { ...subject, session: thread.session },
      { ...subject, activities: [pending, mk(21, 10, 0, "preparing", 32)] },
    ])
      expect(preparationStopCommand(owner, next as Thread)).toBeNull();
  });
  it("fences only the accepted current intent across progress, never a newer intent", () => {
    const owner = preparationStopOwner(subject)!;
    const original = new Map();
    const accepted = acceptPreparationStop(original, "chat", owner, subject);
    expect(accepted.get("chat")).toBe(owner);
    const progress = { ...subject, activities: [pending, mk(20, 10, 0, "uncertain", 31)] };
    expect(samePreparationStopIntent(owner, progress)).toBe(true);
    const next = { ...subject, activities: [pending, mk(21, 10, 0, "preparing", 32)] };
    expect(samePreparationStopIntent(owner, next)).toBe(false);
    expect(acceptPreparationStop(original, "chat", owner, next)).toBe(original);
    expect(
      samePreparationStopIntent(owner, {
        ...subject,
        activities: [pending, mk(20, 10, 0, "retired", 33)],
      }),
    ).toBe(false);
  });
  it("keeps explicit Stop available while unrelated child messages and activity arrive", () => {
    const owner = preparationStopOwner(subject)!;
    const next = {
      ...subject,
      messages: [
        {
          id: "child-output",
          role: "assistant",
          text: "synthetic",
          createdAt: observedAt,
          streaming: true,
        },
      ],
      activities: [
        pending,
        { ...pending, id: EventId.make("unrelated-child"), kind: "runtime.info" },
      ],
    } as unknown as Thread;
    expect(preparationStopCommand(owner, next)).toBe("session-stop");
  });
  it("retains the highest intent and never resurrects earlier progress after terminal", () => {
    const terminal = mk(20, 10, 0, "retired", 31);
    expect(
      latestCodexPreparationMarker([pending, terminal, mk(20, 10, 0, "preparing", 32)], rootTurn)
        ?.phase,
    ).toBe("retired");
    expect(
      latestCodexPreparationMarker([terminal, mk(20, 10, 1, "preparing", 32)], rootTurn)?.phase,
    ).toBe("retired");
    expect(
      latestCodexPreparationMarker([terminal, mk(21, 10, 0, "preparing", 32)], rootTurn)?.intent,
    ).toBe(21);
    expect(
      latestCodexPreparationMarker([pending, mk(20, 11, 0, "preparing", 32)], rootTurn),
    ).toBeNull();
    expect(
      latestCodexPreparationMarker([{ ...pending, id: EventId.make("foreign-id") }], rootTurn),
    ).toBeNull();
  });
});
