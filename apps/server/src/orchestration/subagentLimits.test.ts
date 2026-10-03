import {
  CommandId,
  MessageId,
  OrchestrationEvent,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type OrchestrationSession,
} from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-10-03T00:00:00.000Z";
const threadId = ThreadId.make("limits-source");
const instanceId = ProviderInstanceId.make("codex");
const create: OrchestrationCommand = {
  type: "thread.create",
  commandId: CommandId.make("limits-create"),
  threadId,
  projectId: null,
  title: "Limits fixture",
  modelSelection: { instanceId, model: "synthetic" },
  subagentLimits: { codex: 4, claude: 2 },
  runtimeMode: "approval-required",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  createdAt: now,
};
const session = (overrides: Partial<OrchestrationSession> = {}): OrchestrationSession => ({
  threadId,
  status: "ready",
  providerName: "codex",
  providerInstanceId: instanceId,
  runtimeMode: "approval-required",
  activeTurnId: null,
  lastError: null,
  updatedAt: now,
  ...overrides,
});
async function apply(command: OrchestrationCommand, readModel = createEmptyReadModel(now)) {
  const decision = await Effect.runPromise(decideOrchestrationCommand({ command, readModel }));
  const planned = Array.isArray(decision) ? decision : [decision];
  const events: OrchestrationEvent[] = [];
  let next: OrchestrationReadModel = readModel;
  for (const entry of planned) {
    const event = Schema.decodeUnknownSync(OrchestrationEvent)({
      ...entry,
      sequence: next.snapshotSequence + 1,
    });
    events.push(event);
    next = await Effect.runPromise(projectEvent(next, event));
  }
  return { next, events };
}
const update = (fields: {
  subagentLimits?: { codex?: number; claude?: number };
  title?: string;
}): OrchestrationCommand => ({
  type: "thread.meta.update",
  commandId: CommandId.make("limits-update"),
  threadId,
  ...fields,
});
const turn = (limits?: { codex?: number; claude?: number }): OrchestrationCommand => ({
  type: "thread.turn.start",
  commandId: CommandId.make("limits-turn"),
  threadId,
  message: {
    messageId: MessageId.make("limits-message"),
    role: "user",
    text: "Synthetic fixture",
    attachments: [],
  },
  ...(limits !== undefined ? { subagentLimits: limits } : {}),
  runtimeMode: "approval-required",
  interactionMode: "default",
  createdAt: now,
});

describe("subagent policy orchestration", () => {
  it("replaces the entire desired policy, preserves omission, and retains an explicit reset", async () => {
    let { next } = await apply(create);
    expect(next.threads[0]?.subagentLimits).toEqual({ codex: 4, claude: 2 });
    ({ next } = await apply(update({ subagentLimits: { claude: 3 } }), next));
    expect(next.threads[0]?.subagentLimits).toEqual({ claude: 3 });
    ({ next } = await apply(update({ title: "Renamed" }), next));
    expect(next.threads[0]?.subagentLimits).toEqual({ claude: 3 });
    ({ next } = await apply(update({ subagentLimits: {} }), next));
    expect(next.threads[0]?.subagentLimits).toEqual({});
  });

  it("copies requested policy into duplicate and native-fork targets without resolving defaults", async () => {
    const { next } = await apply(create);
    for (const kind of ["duplicate", "fork"] as const) {
      const targetThreadId = ThreadId.make(`limits-${kind}`);
      const command: OrchestrationCommand =
        kind === "duplicate"
          ? {
              type: "thread.duplicate",
              commandId: CommandId.make("limits-duplicate"),
              sourceThreadId: threadId,
              targetThreadId,
              title: "Duplicate",
              createdAt: now,
            }
          : {
              type: "thread.fork.commit",
              commandId: CommandId.make("limits-fork"),
              sourceThreadId: threadId,
              targetThreadId,
              title: "Fork",
              createdAt: now,
              session: session({
                threadId: targetThreadId,
                status: "stopped",
                maxConcurrentSubagents: 4,
              }),
            };
      const copied = (await apply(command, next)).next.threads.find(
        (entry) => entry.id === targetThreadId,
      );
      expect(copied?.subagentLimits).toEqual({ codex: 4, claude: 2 });
      expect(copied?.session?.maxConcurrentSubagents).toBe(kind === "fork" ? 4 : undefined);
    }
  });

  it("preserves materialized evidence only for an exact same-instance lifecycle omission", async () => {
    let { next } = await apply(create);
    const set = (value: OrchestrationSession): OrchestrationCommand => ({
      type: "thread.session.set",
      commandId: CommandId.make("limits-session"),
      threadId,
      session: value,
      createdAt: now,
    });
    ({ next } = await apply(set(session({ maxConcurrentSubagents: 4 })), next));
    ({ next } = await apply(set(session()), next));
    expect(next.threads[0]?.session?.maxConcurrentSubagents).toBe(4);
    ({ next } = await apply(set(session({ maxConcurrentSubagents: null })), next));
    expect(next.threads[0]?.session?.maxConcurrentSubagents).toBeNull();
    ({ next } = await apply(
      set(session({ providerInstanceId: ProviderInstanceId.make("another-account") })),
      next,
    ));
    expect(next.threads[0]?.session).not.toHaveProperty("maxConcurrentSubagents");
  });

  it("makes active edits pending and a stale-ready submit a steer, never process reconfiguration", async () => {
    let { next } = await apply(create);
    const activeTurnId = TurnId.make("active-root");
    ({ next } = await apply(
      {
        type: "thread.session.set",
        commandId: CommandId.make("limits-running"),
        threadId,
        session: session({ status: "running", activeTurnId, maxConcurrentSubagents: 4 }),
        createdAt: now,
      },
      next,
    ));
    ({ next } = await apply(update({ subagentLimits: { codex: 6 } }), next));
    expect(next.threads[0]?.session?.maxConcurrentSubagents).toBe(4);
    const steered = await apply(turn({ codex: 8 }), next);
    expect(steered.events.map((event) => event.type)).toEqual([
      "thread.meta-updated",
      "thread.message-sent",
      "thread.turn-steer-requested",
    ]);
    expect(steered.next.threads[0]?.subagentLimits).toEqual({ codex: 8 });
    expect(steered.next.threads[0]?.session?.maxConcurrentSubagents).toBe(4);
    expect(steered.next.threads[0]?.session?.activeTurnId).toBe(activeTurnId);
  });

  it("freezes explicit turn intent separately from prior configured process evidence", async () => {
    let { next } = await apply(create);
    ({ next } = await apply(
      {
        type: "thread.session.set",
        commandId: CommandId.make("limits-ready"),
        threadId,
        session: session({ maxConcurrentSubagents: 4 }),
        createdAt: now,
      },
      next,
    ));
    const started = await apply(turn({}), next);
    expect(
      started.events.find((event) => event.type === "thread.turn-start-requested")?.payload,
    ).toHaveProperty("subagentLimits", {});
    expect(started.next.threads[0]?.subagentLimits).toEqual({});
    expect(started.next.threads[0]?.session?.maxConcurrentSubagents).toBe(4);
  });
});
