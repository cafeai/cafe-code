import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  SubagentRuntimeId,
  TurnId,
} from "@cafecode/contracts";
import { describe, expect, it } from "vitest";
import { deriveTurnCompletionSummary } from "./turnCompletion";

const runtimeId = SubagentRuntimeId.make("10000000-0000-4000-8000-000000000001");
const account = ProviderInstanceId.make("codex-owner");
const turnId = TurnId.make("failed-root");
const start = "2026-10-10T00:00:00.000Z";
const end = "2026-10-10T02:30:39.000Z";
type FooterThread = NonNullable<Parameters<typeof deriveTurnCompletionSummary>[0]["thread"]>;
const base: FooterThread = {
  archivedAt: null,
  latestTurn: {
    turnId,
    state: "error",
    requestedAt: start,
    startedAt: start,
    completedAt: end,
    assistantMessageId: null,
  },
  session: {
    provider: ProviderDriverKind.make("codex"),
    providerInstanceId: account,
    status: "ready",
    orchestrationStatus: "ready",
    createdAt: start,
    updatedAt: end,
    subagentRuntimeId: runtimeId,
  },
  activities: [
    {
      id: EventId.make("finished-command"),
      turnId,
      kind: "tool.completed",
      tone: "tool",
      summary: "Ran command",
      createdAt: end,
      payload: { itemId: "command", status: "completed" },
    },
  ],
};
const child = {
  id: EventId.make("active-child"),
  turnId,
  kind: "task.started",
  tone: "info" as const,
  summary: "Subagent started",
  createdAt: start,
  payload: {
    taskId: "child",
    taskType: "subagent",
    subagent: {
      threadId: "child",
      label: "Worker",
      status: "active",
      startedAt: start,
      runtimeId,
    },
  },
};
const marker = (recovery: string, patch: Record<string, unknown> = {}) => ({
  id: EventId.make(recovery),
  turnId,
  kind: "runtime.warning",
  tone: "info" as const,
  summary: "Recovery metadata",
  createdAt: end,
  payload: {
    recovery,
    providerInstanceId: account,
    subagentRuntimeId: runtimeId,
    sessionUpdatedAt: end,
    ...patch,
  },
});
const present = (
  thread = base,
  liveWork?: Parameters<typeof deriveTurnCompletionSummary>[0]["liveWork"],
) => deriveTurnCompletionSummary({ thread, ...(liveWork ? { liveWork } : {}) });

describe("terminal root duration presentation", () => {
  it("keeps the historical root duration while its current child is still active", () => {
    const thread = { ...base, activities: [...base.activities, child] };
    expect(present(thread)).toBe("Agents running · root 2h 30m 39s");
    expect(thread.latestTurn).toEqual(base.latestTurn);
  });
  it.each(["codex-transient-root-failed", "codex-transient-continuation-attempted"])(
    "keeps %s distinct from whole-session completion",
    (kind) => {
      expect(present({ ...base, activities: [...base.activities, marker(kind)] })).toBe(
        "Reconnecting · root 2h 30m 39s",
      );
    },
  );
  it("shows actual received recovery waits and unknown ACKs without claiming an active root", () => {
    const waiting = marker("codex-transient-recovery-waiting", {
      stage: "backoff",
      retryAttempt: 30,
      retryAt: "2026-10-10T02:31:24.000Z",
    });
    expect(present({ ...base, activities: [...base.activities, waiting] })).toBe(
      "Reconnecting · root 2h 30m 39s",
    );
    expect(
      present({
        ...base,
        activities: [...base.activities, waiting, marker("codex-transient-recovery-uncertain")],
      }),
    ).toBe("Needs reconciliation · root 2h 30m 39s");
    expect(
      present({
        ...base,
        activities: [...base.activities, waiting, marker("codex-transient-recovery-cancelled")],
      }),
    ).toBe("Worked for 2h 30m 39s");
  });
  it.each([
    { providerInstanceId: "foreign" },
    { subagentRuntimeId: "foreign" },
    { sessionUpdatedAt: start },
  ])("ignores a foreign or stale recovery tuple %j", (patch) => {
    expect(
      present({
        ...base,
        activities: [...base.activities, marker("codex-transient-root-failed", patch)],
      }),
    ).toBe("Worked for 2h 30m 39s");
  });
  it("ignores recovery markers from another root", () => {
    expect(
      present({
        ...base,
        activities: [
          ...base.activities,
          { ...marker("codex-transient-root-failed"), turnId: TurnId.make("old-root") },
        ],
      }),
    ).toBe("Worked for 2h 30m 39s");
  });
  it("uses current-runtime live work and its authoritative zero rather than stale local rows", () => {
    const thread = { ...base, activities: [...base.activities, child] };
    expect(present(thread, { runtimeId, taskCount: 0, agentCount: 0 })).toBe(
      "Worked for 2h 30m 39s",
    );
    expect(present(base, { runtimeId, taskCount: 2, agentCount: 0 })).toBe(
      "Tasks running · root 2h 30m 39s",
    );
    expect(present(base, { runtimeId, taskCount: 0, agentCount: 2 })).toBe(
      "Agents running · root 2h 30m 39s",
    );
    expect(
      present(base, {
        runtimeId: SubagentRuntimeId.make("10000000-0000-4000-8000-000000000002"),
        taskCount: 2,
        agentCount: 2,
      }),
    ).toBe("Worked for 2h 30m 39s");
  });
  it.each(["error", "closed"] as const)(
    "does not make a %s session look active from old children",
    (status) => {
      expect(
        present({
          ...base,
          session: { ...base.session!, status, orchestrationStatus: "error" },
          activities: [...base.activities, child, marker("codex-transient-root-failed")],
        }),
      ).toBe("Worked for 2h 30m 39s");
    },
  );
  it("ignores foreign generations, stopped children and archived native contexts", () => {
    for (const patch of [
      { runtimeId: "foreign-runtime" },
      { status: "stopped" },
      { status: "failed" },
    ]) {
      expect(
        present({
          ...base,
          activities: [
            ...base.activities,
            {
              ...child,
              payload: { ...child.payload, subagent: { ...child.payload.subagent, ...patch } },
            },
          ],
        }),
      ).toBe("Worked for 2h 30m 39s");
    }
    expect(
      present({
        ...base,
        archivedAt: end,
        activities: [...base.activities, child, marker("codex-transient-root-failed")],
      }),
    ).toBe("Worked for 2h 30m 39s");
  });
  it("keeps completed-root children visible but does not manufacture a recovery loop", () => {
    expect(
      present({
        ...base,
        latestTurn: { ...base.latestTurn!, state: "completed" },
        activities: [...base.activities, child],
      }),
    ).toBe("Agents running · root 2h 30m 39s");
  });
  it("requires a settled tool-using root and a valid fixed duration", () => {
    expect(deriveTurnCompletionSummary({ thread: undefined })).toBeNull();
    expect(present({ ...base, activities: [] })).toBeNull();
    expect(
      present({
        ...base,
        latestTurn: { ...base.latestTurn!, state: "running", completedAt: null },
      }),
    ).toBeNull();
    expect(
      present({ ...base, latestTurn: { ...base.latestTurn!, startedAt: end, completedAt: start } }),
    ).toBeNull();
    expect(
      present({
        ...base,
        session: {
          ...base.session!,
          status: "running",
          orchestrationStatus: "running",
          activeTurnId: TurnId.make("new-root"),
        },
      }),
    ).toBeNull();
  });
});
