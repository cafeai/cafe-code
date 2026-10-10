import {
  ClientOrchestrationCommand,
  CommandId,
  MessageId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type OrchestrationThread,
  ProjectId,
  ProviderInstanceId,
  SubagentRuntimeId,
  ThreadId,
  ThreadTurnStartCommand,
  TurnId,
} from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { sessionLifecycleSnapshot } from "./sessionLifecycle.ts";

const decodeClientCommand = Schema.decodeUnknownSync(ClientOrchestrationCommand);
const decodeStartCommand = Schema.decodeUnknownSync(ThreadTurnStartCommand);
const now = "2026-09-16T01:00:00.000Z";
const threadId = ThreadId.make("runtime-recovery-thread");
const turnId = TurnId.make("runtime-recovery-lost-turn");
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-6-astra",
  options: [{ id: "reasoningEffort", value: "max" }],
};

function makeThread(): OrchestrationThread {
  return {
    id: threadId,
    projectId: ProjectId.make("runtime-recovery-project"),
    title: "Runtime recovery",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: {
      turnId,
      state: "interrupted",
      requestedAt: now,
      startedAt: now,
      completedAt: now,
      assistantMessageId: null,
    },
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: {
      threadId,
      status: "stopped",
      providerName: "codex",
      providerInstanceId: modelSelection.instanceId,
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: null,
      updatedAt: now,
    },
  };
}

function makeCommand(): typeof ThreadTurnStartCommand.Type {
  return {
    type: "thread.turn.start",
    commandId: CommandId.make("server:runtime-recovery"),
    threadId,
    message: {
      messageId: MessageId.make("runtime-recovery-message"),
      role: "user",
      text: "Continue the interrupted work.",
      attachments: [],
    },
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    runtimeRecovery: { sourceEventSequence: 10, turnId, sessionUpdatedAt: now },
    createdAt: now,
  };
}

function decide(
  thread = makeThread(),
  command = makeCommand(),
  runtimeRecoveryBarrierVerified = true,
) {
  const readModel: OrchestrationReadModel = {
    snapshotSequence: 10,
    projects: [],
    threads: [thread],
    updatedAt: now,
  };
  return decideOrchestrationCommand({ command, readModel, runtimeRecoveryBarrierVerified });
}

describe("runtime recovery admission", () => {
  it("requires engine-authenticated acceptance and the exact failed-context CAS for terminal association", async () => {
    const runtimeId = SubagentRuntimeId.make("00000000-0000-4000-8000-000000000142");
    const nextTurnId = TurnId.make("accepted-failed-continuation");
    const completedAt = "2026-09-16T01:00:03.000Z";
    const base = makeThread();
    const thread: OrchestrationThread = {
      ...base,
      latestTurn: { ...base.latestTurn!, state: "error" },
      session: {
        ...base.session!,
        status: "ready",
        subagentRuntimeId: runtimeId,
        lastError: "Root failed.",
      },
    };
    const command: Extract<OrchestrationCommand, { type: "thread.session.set" }> = {
      type: "thread.session.set",
      commandId: CommandId.make("server:associate-exact-failed-root"),
      threadId,
      expectedSessionLifecycle: sessionLifecycleSnapshot(thread.session),
      expectedSubagentRuntimeId: runtimeId,
      codexFailedRoot: {
        turnId: nextTurnId,
        previousTurnId: turnId,
        messageId: MessageId.make("accepted-failed-message"),
        intentSequence: 12,
        requestedAt: now,
        completedAt,
      },
      session: { ...thread.session!, status: "ready", activeTurnId: null, updatedAt: completedAt },
      createdAt: completedAt,
    };
    const associate = (current = thread, candidate = command, verified = true) =>
      decideOrchestrationCommand({
        command: candidate,
        codexFailedRootVerified: verified,
        readModel: { snapshotSequence: 14, projects: [], threads: [current], updatedAt: now },
      });
    const event = await Effect.runPromise(associate());
    expect(event).toMatchObject({
      type: "thread.session-set",
      payload: {
        codexFailedRoot: command.codexFailedRoot,
        session: { status: "ready", activeTurnId: null },
      },
    });
    for (const [current, candidate, verified] of [
      [thread, command, false],
      [thread, { ...command, commandId: CommandId.make("client:associate-failed-root") }, true],
      [thread, { ...command, expectedSessionLifecycle: undefined }, true],
      [thread, { ...command, expectedSubagentRuntimeId: undefined }, true],
      [{ ...thread, session: { ...thread.session!, status: "stopped" as const } }, command, true],
      [
        { ...thread, session: { ...thread.session!, activeTurnId: TurnId.make("newer-root") } },
        command,
        true,
      ],
      [
        {
          ...thread,
          session: {
            ...thread.session!,
            subagentRuntimeId: SubagentRuntimeId.make("00000000-0000-4000-8000-000000000143"),
          },
        },
        command,
        true,
      ],
      [
        {
          ...thread,
          modelSelection: { ...modelSelection, instanceId: ProviderInstanceId.make("peer") },
        },
        command,
        true,
      ],
      [
        { ...thread, latestTurn: { ...thread.latestTurn!, turnId: TurnId.make("newer-root") } },
        command,
        true,
      ],
      [{ ...thread, archivedAt: now }, command, true],
      [
        thread,
        {
          ...command,
          session: { ...command.session, status: "running" as const, activeTurnId: nextTurnId },
        },
        true,
      ],
      [thread, { ...command, session: { ...command.session, updatedAt: now } }, true],
    ] as const) {
      expect(
        (await Effect.runPromise(Effect.exit(associate(current, candidate, verified))))._tag,
      ).toBe("Failure");
    }
    expect(() => decodeClientCommand(command)).toThrow();
  });

  it("admits only an exact ready failed Codex generation for transient continuation", async () => {
    const runtimeId = SubagentRuntimeId.make("00000000-0000-4000-8000-000000000142");
    const thread = makeThread();
    const transientThread: OrchestrationThread = {
      ...thread,
      latestTurn: { ...thread.latestTurn!, state: "error" },
      session: { ...thread.session!, status: "ready", subagentRuntimeId: runtimeId },
    };
    const command = makeCommand();
    const transientCommand = {
      ...command,
      runtimeRecovery: {
        ...command.runtimeRecovery!,
        codexTransientFailure: {
          providerInstanceId: modelSelection.instanceId,
          subagentRuntimeId: runtimeId,
          chainSourceEventSequence: 10,
          retryAttempt: 30,
        },
      },
    };
    expect(await Effect.runPromise(decide(transientThread, transientCommand))).toMatchObject([
      { type: "thread.message-sent" },
      {
        type: "thread.turn-start-requested",
        payload: {
          runtimeRecovery: transientCommand.runtimeRecovery,
        },
      },
    ]);
    for (const modified of [
      { ...transientThread, session: { ...transientThread.session!, status: "stopped" as const } },
      {
        ...transientThread,
        session: { ...transientThread.session!, subagentRuntimeId: undefined },
      },
      {
        ...transientThread,
        session: {
          ...transientThread.session!,
          providerInstanceId: ProviderInstanceId.make("peer"),
        },
      },
      { ...transientThread, session: { ...transientThread.session!, providerName: "claudeAgent" } },
      {
        ...transientThread,
        latestTurn: { ...transientThread.latestTurn!, state: "completed" as const },
      },
      {
        ...transientThread,
        session: { ...transientThread.session!, activeTurnId: TurnId.make("new-root") },
      },
    ]) {
      expect((await Effect.runPromise(Effect.exit(decide(modified, transientCommand))))._tag).toBe(
        "Failure",
      );
    }
    expect(() =>
      decodeStartCommand({
        ...transientCommand,
        runtimeRecovery: {
          ...transientCommand.runtimeRecovery,
          codexTransientFailure: {
            ...transientCommand.runtimeRecovery.codexTransientFailure,
            retryAttempt: 31,
          },
        },
      }),
    ).toThrow();
    expect(
      decodeClientCommand({ ...transientCommand, commandId: "client:transient" }),
    ).not.toHaveProperty("runtimeRecovery");
  });

  it("retains the exact server guard on the admitted start intent", async () => {
    const events = await Effect.runPromise(decide());
    expect(Array.isArray(events)).toBe(true);
    expect(events).toMatchObject([
      { type: "thread.message-sent" },
      {
        type: "thread.turn-start-requested",
        payload: { runtimeRecovery: makeCommand().runtimeRecovery, modelSelection },
      },
    ]);
  });

  it("never admits recovery without trusted durable barrier verification", async () => {
    expect(
      await Effect.runPromise(Effect.exit(decide(makeThread(), makeCommand(), false))),
    ).toMatchObject({ _tag: "Failure" });
  });

  it.each([
    [
      "running",
      (thread: OrchestrationThread) => ({
        ...thread,
        session: { ...thread.session!, status: "running" as const, activeTurnId: turnId },
      }),
    ],
    [
      "new active turn",
      (thread: OrchestrationThread) => ({
        ...thread,
        session: { ...thread.session!, activeTurnId: TurnId.make("new-turn") },
      }),
    ],
    [
      "changed stopped row",
      (thread: OrchestrationThread) => ({
        ...thread,
        session: { ...thread.session!, updatedAt: "2026-09-16T01:00:01.000Z" },
      }),
    ],
    [
      "new latest turn",
      (thread: OrchestrationThread) => ({
        ...thread,
        latestTurn: { ...thread.latestTurn!, turnId: TurnId.make("new-turn") },
      }),
    ],
    ["archived", (thread: OrchestrationThread) => ({ ...thread, archivedAt: now })],
    ["deleted", (thread: OrchestrationThread) => ({ ...thread, deletedAt: now })],
    ["missing session", (thread: OrchestrationThread) => ({ ...thread, session: null })],
    [
      "provider changed",
      (thread: OrchestrationThread) => ({
        ...thread,
        modelSelection: { ...modelSelection, instanceId: ProviderInstanceId.make("other") },
      }),
    ],
    [
      "reasoning setting changed",
      (thread: OrchestrationThread) => ({
        ...thread,
        modelSelection: { ...modelSelection, options: [{ id: "reasoningEffort", value: "ultra" }] },
      }),
    ],
    [
      "runtime changed",
      (thread: OrchestrationThread) => ({
        ...thread,
        runtimeMode: "approval-required" as const,
      }),
    ],
    [
      "interaction changed",
      (thread: OrchestrationThread) => ({
        ...thread,
        interactionMode: "plan" as const,
      }),
    ],
  ] as const)("rejects %s before creating a user message or steer", async (_name, modify) => {
    const result = await Effect.runPromise(Effect.exit(decide(modify(makeThread()))));
    expect(result._tag).toBe("Failure");
  });

  it("rejects internal recovery fields on a non-server command identity", async () => {
    const result = await Effect.runPromise(
      Effect.exit(
        decide(makeThread(), {
          ...makeCommand(),
          commandId: CommandId.make("client-recovery"),
        }),
      ),
    );
    expect(result._tag).toBe("Failure");
  });

  it("does not decode runtime-recovery authority from the client command schema", () => {
    const command = { ...makeCommand(), commandId: CommandId.make("client-recovery") };
    const decoded = decodeClientCommand(command);
    expect(decoded).not.toHaveProperty("runtimeRecovery");
    expect(decodeStartCommand(makeCommand()).runtimeRecovery).toEqual(
      makeCommand().runtimeRecovery,
    );
  });
});
