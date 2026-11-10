import {
  EnvironmentId,
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  SubagentRuntimeId,
  ThreadId,
  TurnId,
} from "@cafecode/contracts";
import { describe, expect, it } from "vitest";
import { backgroundWorkStopCommand, backgroundWorkStopOwner } from "./backgroundWorkStop";

type BackgroundThread = NonNullable<Parameters<typeof backgroundWorkStopOwner>[0]>;
const runtimeId = SubagentRuntimeId.make("00000000-0000-4000-8000-000000000001");
const account = ProviderInstanceId.make("claude-account");
const at = "2026-11-09T00:00:00.000Z";
const base: BackgroundThread = {
  id: ThreadId.make("chat"),
  environmentId: EnvironmentId.make("local"),
  archivedAt: null,
  latestTurn: {
    turnId: TurnId.make("finished-root"),
    state: "completed",
    requestedAt: at,
    startedAt: at,
    completedAt: at,
    assistantMessageId: null,
  },
  session: {
    provider: ProviderDriverKind.make("claudeAgent"),
    providerInstanceId: account,
    subagentRuntimeId: runtimeId,
    status: "ready",
    orchestrationStatus: "ready",
    createdAt: at,
    updatedAt: at,
  },
  activities: [],
};
const liveWork = { runtimeId, taskCount: 1, agentCount: 0 };
const foreground = {
  id: EventId.make("foreground-tool"),
  kind: "tool.started",
  turnId: base.latestTurn!.turnId,
  tone: "info" as const,
  createdAt: at,
  sequence: 1,
  summary: "Shell command",
  payload: {
    itemId: "tool-id-is-not-a-native-task-id",
    individualTaskControl: {
      taskId: "background-only-reference",
      runtimeId,
      capability: {
        providerInstanceId: account,
        taskGeneration: "00000000-0000-4000-8000-000000000002",
        canStop: false,
        canBackground: true,
      },
    },
  },
};

describe("whole-chat Stop for background work", () => {
  it.each(["completed", "interrupted", "error"] as const)(
    "offers explicit Stop after a %s root without changing its state",
    (state) => {
      const thread = { ...base, latestTurn: { ...base.latestTurn!, state } };
      const owner = backgroundWorkStopOwner(thread, liveWork)!;
      expect(owner).toMatchObject({ runtimeId, providerInstanceId: account });
      expect(backgroundWorkStopCommand(owner, thread, liveWork)).toBe("session-stop");
      expect(thread.latestTurn.state).toBe(state);
      expect(
        backgroundWorkStopOwner(thread, { ...liveWork, taskCount: 0, agentCount: 1 }),
      ).not.toBeNull();
    },
  );

  it("uses current bound lifecycle evidence when the summary is absent, including background-only tools", () => {
    const thread = { ...base, activities: [foreground] };
    expect(backgroundWorkStopOwner(thread)).not.toBeNull();
    expect(foreground.payload.individualTaskControl.capability.canStop).toBe(false);
    const terminal = {
      ...foreground,
      id: EventId.make("ended-tool"),
      kind: "tool.completed",
      sequence: 2,
    };
    expect(backgroundWorkStopOwner({ ...thread, activities: [terminal, foreground] })).toBeNull();
    expect(
      backgroundWorkStopOwner({
        ...base,
        activities: [{ ...foreground, payload: { itemId: "unbound" } }],
      }),
    ).toBeNull();
  });

  it("honors an exact-runtime zero and ignores foreign summaries or replaced lifecycle owners", () => {
    const thread = { ...base, activities: [foreground] };
    expect(backgroundWorkStopOwner(thread, { ...liveWork, taskCount: 0 })).toBeNull();
    const foreign = {
      ...liveWork,
      runtimeId: SubagentRuntimeId.make("00000000-0000-4000-8000-000000000003"),
    };
    expect(backgroundWorkStopOwner(base, foreign)).toBeNull();
    expect(backgroundWorkStopOwner(thread, foreign)).not.toBeNull();
    expect(
      backgroundWorkStopOwner({
        ...thread,
        session: { ...base.session!, subagentRuntimeId: foreign.runtimeId },
      }),
    ).toBeNull();
  });

  it("leaves running roots, opening, closed, failed and unbound sessions to their existing controls", () => {
    expect(backgroundWorkStopOwner(undefined, liveWork)).toBeNull();
    expect(backgroundWorkStopOwner({ ...base, session: null }, liveWork)).toBeNull();
    expect(backgroundWorkStopOwner({ ...base, archivedAt: at }, liveWork)).toBeNull();
    expect(
      backgroundWorkStopOwner(
        { ...base, latestTurn: { ...base.latestTurn!, state: "running", completedAt: null } },
        liveWork,
      ),
    ).toBeNull();
    for (const patch of [
      { status: "running" as const },
      { status: "connecting" as const },
      { status: "closed" as const },
      { status: "error" as const },
      { activeTurnId: TurnId.make("new-root") },
      { orchestrationStatus: "stopped" as const },
      { orchestrationStatus: "error" as const },
      { providerInstanceId: undefined },
      { subagentRuntimeId: undefined },
    ])
      expect(
        backgroundWorkStopOwner({ ...base, session: { ...base.session!, ...patch } }, liveWork),
      ).toBeNull();
  });

  it("rejects a stale click after completion, another root, runtime, provider, account, chat or environment", () => {
    const owner = backgroundWorkStopOwner(base, liveWork)!;
    expect(backgroundWorkStopCommand(owner, base, { ...liveWork, taskCount: 0 })).toBeNull();
    for (const thread of [
      { ...base, id: ThreadId.make("other-chat") },
      { ...base, environmentId: EnvironmentId.make("other-environment") },
      { ...base, latestTurn: { ...base.latestTurn!, turnId: TurnId.make("new-root") } },
      { ...base, session: { ...base.session!, provider: ProviderDriverKind.make("codex") } },
      {
        ...base,
        session: { ...base.session!, providerInstanceId: ProviderInstanceId.make("other-account") },
      },
      { ...base, session: { ...base.session!, subagentRuntimeId: "replacement-runtime" } },
      {
        ...base,
        session: {
          ...base.session!,
          status: "running" as const,
          activeTurnId: TurnId.make("new-root"),
        },
      },
    ])
      expect(backgroundWorkStopCommand(owner, thread, liveWork)).toBeNull();
  });
});
