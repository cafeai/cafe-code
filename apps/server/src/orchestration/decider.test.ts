import {
  ClientOrchestrationCommand,
  CommandId,
  MessageId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type OrchestrationThread,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";

const now = "2026-09-23T10:43:00.000Z";
const threadId = ThreadId.make("root-replacement-thread");
const oldRoot = TurnId.make("completed-root");
const newRoot = TurnId.make("replacement-root");
const instanceId = ProviderInstanceId.make("codex");

function makeThread(): OrchestrationThread {
  return {
    id: threadId,
    projectId: ProjectId.make("root-replacement-project"),
    title: "Root replacement",
    modelSelection: { instanceId, model: "gpt-6-astra" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: {
      turnId: oldRoot,
      state: "running",
      requestedAt: now,
      startedAt: now,
      completedAt: null,
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
      status: "running",
      providerName: "codex",
      providerInstanceId: instanceId,
      runtimeMode: "full-access",
      activeTurnId: oldRoot,
      lastError: null,
      updatedAt: now,
    },
  };
}

function makeCommand(): Extract<OrchestrationCommand, { type: "thread.session.set" }> {
  return {
    type: "thread.session.set",
    commandId: CommandId.make("server:root-replacement"),
    threadId,
    session: { ...makeThread().session!, activeTurnId: newRoot },
    codexRootReplacement: {
      expectedTurnId: oldRoot,
      providerInstanceId: instanceId,
      messageId: MessageId.make("saved-steer"),
      intentSequence: 10,
    },
    createdAt: now,
  };
}

function decide(
  thread = makeThread(),
  command = makeCommand(),
  codexRootReplacementVerified = true,
) {
  const readModel: OrchestrationReadModel = {
    snapshotSequence: 10,
    projects: [],
    threads: [thread],
    updatedAt: now,
  };
  return decideOrchestrationCommand({ command, readModel, codexRootReplacementVerified });
}

describe("Codex completed-root replacement admission", () => {
  it("admits the exact authorized replacement without persisting its admission guard", async () => {
    const event = await Effect.runPromise(decide());
    expect(event).toMatchObject({
      type: "thread.session-set",
      payload: { threadId, session: { activeTurnId: newRoot } },
    });
    expect(event).not.toHaveProperty("payload.codexRootReplacement");
  });

  it("fails closed without the engine's durable barrier verification", async () => {
    expect(
      await Effect.runPromise(Effect.exit(decide(makeThread(), makeCommand(), false))),
    ).toMatchObject({ _tag: "Failure" });
  });

  it.each([
    ["archived", (thread: OrchestrationThread) => ({ ...thread, archivedAt: now })],
    ["deleted", (thread: OrchestrationThread) => ({ ...thread, deletedAt: now })],
    ["missing session", (thread: OrchestrationThread) => ({ ...thread, session: null })],
    [
      "stopped",
      (thread: OrchestrationThread) => ({
        ...thread,
        session: { ...thread.session!, status: "stopped" as const, activeTurnId: null },
      }),
    ],
    [
      "newer root",
      (thread: OrchestrationThread) => ({
        ...thread,
        session: { ...thread.session!, activeTurnId: TurnId.make("newer-root") },
      }),
    ],
    [
      "newer latest turn",
      (thread: OrchestrationThread) => ({
        ...thread,
        latestTurn: { ...thread.latestTurn!, turnId: TurnId.make("newer-root") },
      }),
    ],
    [
      "changed provider",
      (thread: OrchestrationThread) => ({
        ...thread,
        session: { ...thread.session!, providerName: "claude" as const },
      }),
    ],
    [
      "changed instance",
      (thread: OrchestrationThread) => ({
        ...thread,
        session: { ...thread.session!, providerInstanceId: ProviderInstanceId.make("codex-other") },
      }),
    ],
  ] as const)("rejects %s even with matching timestamps", async (_label, mutate) => {
    expect(await Effect.runPromise(Effect.exit(decide(mutate(makeThread()))))).toMatchObject({
      _tag: "Failure",
    });
  });

  it.each([
    "client identity",
    "wrong thread",
    "wrong provider",
    "wrong instance",
    "same root",
    "no root",
  ] as const)("rejects an invalid replacement candidate: %s", async (variant) => {
    const command = makeCommand();
    const candidate = {
      ...command,
      ...(variant === "client identity" ? { commandId: CommandId.make("client-replacement") } : {}),
      session: {
        ...command.session,
        ...(variant === "wrong thread" ? { threadId: ThreadId.make("different-thread") } : {}),
        ...(variant === "wrong provider" ? { providerName: "claude" as const } : {}),
        ...(variant === "wrong instance"
          ? { providerInstanceId: ProviderInstanceId.make("different") }
          : {}),
        ...(variant === "same root" ? { activeTurnId: oldRoot } : {}),
        ...(variant === "no root" ? { activeTurnId: null } : {}),
      },
    };
    expect(await Effect.runPromise(Effect.exit(decide(makeThread(), candidate)))).toMatchObject({
      _tag: "Failure",
    });
  });

  it("does not expose session-set or replacement authority through the client command schema", () => {
    expect(() => Schema.decodeUnknownSync(ClientOrchestrationCommand)(makeCommand())).toThrow();
  });
});
