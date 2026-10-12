import { describe, expect, it } from "vitest";
import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  TurnId,
  type OrchestrationThreadActivity,
} from "@cafecode/contracts";
import {
  codexRecoveryLabel,
  deriveCodexRecoveryPresentation,
  shouldSuppressCodexRecoveryErrorNotification,
} from "./codexRecovery";
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
