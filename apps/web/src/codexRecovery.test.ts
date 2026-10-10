import { describe, expect, it } from "vitest";
import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  TurnId,
  type OrchestrationThreadActivity,
} from "@cafecode/contracts";
import { codexRecoveryLabel, deriveCodexRecoveryPresentation } from "./codexRecovery";
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
