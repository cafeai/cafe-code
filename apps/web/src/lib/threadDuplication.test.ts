import { scopeThreadRef } from "@cafecode/client-runtime";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  SubagentRuntimeId,
  ThreadId,
  TurnId,
} from "@cafecode/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SidebarThreadSummary, Thread } from "../types";

// Only opaque ID minting is substituted. The real eligibility, scalar receipt,
// shared module ownership and completion behavior are exercised without a UI,
// provider, transcript read, clock wait or native account configuration.
vi.mock("./utils", async () => {
  const { CommandId, ThreadId } = await import("@cafecode/contracts");
  return {
    newCommandId: () => CommandId.make(crypto.randomUUID()),
    newThreadId: () => ThreadId.make(crypto.randomUUID()),
  };
});

const createdAt = "2026-10-15T00:00:00.000Z";
const completedAt = "2026-10-15T00:01:00.000Z";
const runtimeId = SubagentRuntimeId.make("a4c5c122-94bf-45ad-a432-f831c1bcf3b0");
const retiredRuntimeId = SubagentRuntimeId.make("84918b29-0f11-40b0-a934-29f905f75468");

function source(overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.make("source"),
    environmentId: EnvironmentId.make("local"),
    codexThreadId: "native-source",
    projectId: null,
    title: "Source chat",
    modelSelection: { instanceId: ProviderInstanceId.make("personal"), model: "model" },
    runtimeMode: "full-access",
    interactionMode: "default",
    session: {
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("personal"),
      status: "ready",
      createdAt,
      updatedAt: completedAt,
      orchestrationStatus: "ready",
      subagentRuntimeId: runtimeId,
    },
    messages: [],
    proposedPlans: [],
    error: null,
    createdAt,
    updatedAt: completedAt,
    archivedAt: null,
    latestTurn: {
      turnId: TurnId.make("last-turn"),
      state: "completed",
      requestedAt: createdAt,
      startedAt: createdAt,
      completedAt,
      assistantMessageId: null,
    },
    branch: null,
    worktreePath: null,
    turnDiffSummaries: [],
    activities: [],
    ...overrides,
  };
}

let api: typeof import("./threadDuplication");
beforeEach(async () => {
  // Each test owns its registry. Production deliberately has no clear/reset
  // method that could discard an uncertain native mutation's identity.
  vi.resetModules();
  api = await import("./threadDuplication");
});

describe("native chat duplication eligibility", () => {
  it("admits settled Codex and Claude sources while rejecting unavailable or busy sources", () => {
    const ready = source();
    expect(api.canDuplicateThread(ready)).toBe(true);
    expect(
      api.canDuplicateThread({
        ...ready,
        session: { ...ready.session!, provider: ProviderDriverKind.make("claudeAgent") },
      }),
    ).toBe(true);
    const refused = [
      null,
      undefined,
      { ...ready, archivedAt: completedAt },
      { ...ready, deletedAt: completedAt },
      { ...ready, session: null },
      { ...ready, session: { ...ready.session!, provider: ProviderDriverKind.make("grok") } },
      { ...ready, session: { ...ready.session!, provider: ProviderDriverKind.make("axiom") } },
      { ...ready, session: { ...ready.session!, status: "running" as const } },
      { ...ready, session: { ...ready.session!, status: "connecting" as const } },
      { ...ready, session: { ...ready.session!, orchestrationStatus: "starting" as const } },
      { ...ready, session: { ...ready.session!, orchestrationStatus: "running" as const } },
      { ...ready, session: { ...ready.session!, activeTurnId: TurnId.make("unsettled") } },
      { ...ready, latestTurn: null },
      { ...ready, latestTurn: { ...ready.latestTurn!, startedAt: null } },
      { ...ready, latestTurn: { ...ready.latestTurn!, completedAt: null } },
      { ...ready, latestTurn: { ...ready.latestTurn!, state: "running" as const } },
      { ...ready, hasPendingApprovals: true },
      { ...ready, hasPendingUserInput: true },
      {
        ...ready,
        modelSelection: { ...ready.modelSelection, instanceId: ProviderInstanceId.make("other") },
      },
    ];
    for (const candidate of refused) expect(api.canDuplicateThread(candidate)).toBe(false);
  });

  it("binds shell live-work refusal to the current native runtime, not stale historical work", () => {
    const ready = source();
    const shell: SidebarThreadSummary = {
      ...ready,
      latestUserMessageAt: createdAt,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
      liveWork: {
        runtimeId,
        taskCount: 1,
        agentCount: 0,
      },
    };
    expect(api.canDuplicateThread(shell)).toBe(false);
    expect(
      api.canDuplicateThread({
        ...shell,
        liveWork: { ...shell.liveWork!, taskCount: 0, agentCount: 1 },
      }),
    ).toBe(false);
    expect(
      api.canDuplicateThread({ ...shell, liveWork: { ...shell.liveWork!, taskCount: 0 } }),
    ).toBe(true);
    expect(
      api.canDuplicateThread({
        ...shell,
        liveWork: { ...shell.liveWork!, runtimeId: retiredRuntimeId },
      }),
    ).toBe(true);
  });
});

describe("shared native chat duplication receipts", () => {
  it("shares pending admission across hooks but distinguishes equal chat IDs in different environments", () => {
    const local = source();
    const remote = source({ environmentId: EnvironmentId.make("remote") });
    const localRef = scopeThreadRef(local.environmentId, local.id);
    const remoteRef = scopeThreadRef(remote.environmentId, remote.id);
    const first = api.claimThreadDuplication(local, "Source chat (copy)")!;
    expect(first.command).toMatchObject({
      type: "thread.fork",
      sourceThreadId: local.id,
      title: "Source chat (copy)",
    });
    expect(first.command.targetThreadId).not.toBe(local.id);
    expect(api.isThreadDuplicationPending(localRef)).toBe(true);
    expect(api.isThreadDuplicationPending(remoteRef)).toBe(false);
    expect(api.claimThreadDuplication(local, "Another copy")).toBeNull();
    const second = api.claimThreadDuplication(remote, "Remote copy")!;
    expect(second.command.targetThreadId).not.toBe(first.command.targetThreadId);
    expect(api.isThreadDuplicationPending(remoteRef)).toBe(true);
    first.finish("acknowledged");
    second.finish("acknowledged");
    expect(api.isThreadDuplicationPending(localRef)).toBe(false);
    expect(api.isThreadDuplicationPending(remoteRef)).toBe(false);
  });

  it("reuses the exact uncertain command and fences late completion of a former owner", () => {
    const original = source();
    const ref = scopeThreadRef(original.environmentId, original.id);
    const first = api.claimThreadDuplication(original, "First copy")!;
    first.finish("uncertain");
    expect(api.isThreadDuplicationPending(ref)).toBe(false);
    const retry = api.claimThreadDuplication(source(), "A translated label")!;
    expect(retry.command).toBe(first.command);
    expect(Object.isFrozen(retry.command)).toBe(true);
    first.finish("acknowledged");
    expect(api.isThreadDuplicationPending(ref)).toBe(true);
    expect(api.claimThreadDuplication(original, "Third copy")).toBeNull();
    retry.finish("acknowledged");
    expect(api.isThreadDuplicationPending(ref)).toBe(false);
    const next = api.claimThreadDuplication(original, "Deliberate later copy")!;
    expect(next.command.commandId).not.toBe(first.command.commandId);
    expect(next.command.targetThreadId).not.toBe(first.command.targetThreadId);
    retry.finish("uncertain");
    expect(api.isThreadDuplicationPending(ref)).toBe(true);
    next.finish("acknowledged");
  });

  it("refuses replay after any captured source, account, runtime or policy boundary changes", () => {
    const original = source();
    const first = api.claimThreadDuplication(original, "Copy")!;
    first.finish("uncertain");
    const changed: Thread[] = [
      source({ updatedAt: "2026-10-15T00:02:00.000Z" }),
      source({ title: "Renamed source" }),
      source({ branch: "new-branch" }),
      source({ worktreePath: "/different-workspace" }),
      source({ codexThreadId: "replacement-native-thread" }),
      source({ runtimeMode: "approval-required" }),
      source({ interactionMode: "plan" }),
      source({ codexContextWindowOverride: null }),
      source({ subagentLimits: {} }),
      source({ modelSelection: { ...original.modelSelection, options: [] } }),
      source({ modelSelection: { ...original.modelSelection, model: "other-model" } }),
      source({ session: { ...original.session!, subagentRuntimeId: retiredRuntimeId } }),
      source({ latestTurn: { ...original.latestTurn!, turnId: TurnId.make("later-turn") } }),
      source({ session: { ...original.session!, codexAutoCompactTokenLimit: null } }),
    ];
    for (const candidate of changed)
      expect(api.claimThreadDuplication(candidate, "Copy")).toBeNull();
    const retry = api.claimThreadDuplication(original, "Copy")!;
    expect(retry.command).toBe(first.command);
    retry.finish("acknowledged");
  });

  it("does not read or retain transcript, activity or proposed-plan bodies", () => {
    const ready = source();
    for (const key of ["messages", "activities", "proposedPlans", "turnDiffSummaries"] as const) {
      Object.defineProperty(ready, key, {
        get: () => {
          throw new Error("Content must not be read");
        },
      });
    }
    const operation = api.claimThreadDuplication(ready, "Copy")!;
    expect(operation.command).toMatchObject({ type: "thread.fork", sourceThreadId: ready.id });
    operation.finish("uncertain");
    const retry = api.claimThreadDuplication(source(), "Copy")!;
    expect(retry.command).toBe(operation.command);
    retry.finish("acknowledged");
  });

  it("refuses oversized metadata and bounded-registry exhaustion without evicting uncertain identity", () => {
    expect(api.claimThreadDuplication(source(), " ")).toBeNull();
    expect(api.claimThreadDuplication(source(), "x".repeat(513))).toBeNull();
    expect(api.claimThreadDuplication(source({ title: "x".repeat(4097) }), "Copy")).toBeNull();
    expect(
      api.claimThreadDuplication(
        source({
          modelSelection: {
            instanceId: ProviderInstanceId.make("personal"),
            model: "model",
            options: Array.from({ length: 65 }, (_, index) => ({
              id: `option-${index}`,
              value: true,
            })),
          },
        }),
        "Copy",
      ),
    ).toBeNull();
    const firstSource = source({ id: ThreadId.make("source-0") });
    let first: ReturnType<typeof api.claimThreadDuplication> = null;
    for (let index = 0; index < 128; index++) {
      const operation = api.claimThreadDuplication(
        source({ id: ThreadId.make(`source-${index}`) }),
        "Copy",
      );
      expect(operation).not.toBeNull();
      if (index === 0) first = operation;
      operation!.finish("uncertain");
    }
    expect(
      api.claimThreadDuplication(source({ id: ThreadId.make("overflow") }), "Copy"),
    ).toBeNull();
    const retained = api.claimThreadDuplication(firstSource, "Copy")!;
    expect(retained.command).toBe(first!.command);
    retained.finish("acknowledged");
    const admitted = api.claimThreadDuplication(source({ id: ThreadId.make("overflow") }), "Copy")!;
    expect(admitted.command).toBeDefined();
    admitted.finish("acknowledged");
  });
});
