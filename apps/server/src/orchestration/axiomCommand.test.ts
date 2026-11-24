import {
  ClientOrchestrationCommand,
  CommandId,
  MessageId,
  OrchestrationCommand,
  type OrchestrationReadModel,
  type OrchestrationThread,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";
import { decideOrchestrationCommand } from "./decider.ts";

const now = "2026-11-16T17:00:00.000Z";
const threadId = ThreadId.make("axiom-command-thread");
const instanceId = ProviderInstanceId.make("axiom-command-account");
const decodeClient = Schema.decodeUnknownSync(ClientOrchestrationCommand);
const decodeDomain = Schema.decodeUnknownSync(OrchestrationCommand);
const thread: OrchestrationThread = {
  id: threadId,
  projectId: null,
  title: "Native commands",
  modelSelection: { instanceId, model: "native-model" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
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
    status: "ready",
    providerName: "axiom",
    providerInstanceId: instanceId,
    runtimeMode: "approval-required",
    activeTurnId: null,
    lastError: null,
    updatedAt: now,
  },
};
const start = {
  type: "thread.turn.start" as const,
  commandId: CommandId.make("axiom-explicit-command"),
  threadId,
  message: {
    messageId: MessageId.make("axiom-command-message"),
    role: "user" as const,
    text: "/help",
    attachments: [],
  },
  modelSelection: thread.modelSelection,
  runtimeMode: thread.runtimeMode,
  interactionMode: thread.interactionMode,
  createdAt: now,
};
function decide(command: unknown, current = thread) {
  const readModel: OrchestrationReadModel = {
    snapshotSequence: 0,
    projects: [],
    threads: [current],
    updatedAt: now,
  };
  return decideOrchestrationCommand({ command: decodeDomain(command), readModel });
}

describe("explicit Axiom command handoff", () => {
  it("retains selected command intent through client decoding and durable turn admission", async () => {
    const selected = decodeClient({ ...start, axiomCommand: { name: "help" } });
    const events = await Effect.runPromise(decide(selected));
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "thread.turn-start-requested",
          payload: expect.objectContaining({ axiomCommand: { name: "help" } }),
        }),
      ]),
    );
  });

  it("keeps a pasted slash prompt free of native command intent", async () => {
    const literal = decodeClient(start);
    const events = await Effect.runPromise(decide(literal));
    expect(Array.isArray(events)).toBe(true);
    for (const event of Array.isArray(events) ? events : [events])
      expect(event.payload).not.toHaveProperty("axiomCommand");
  });

  it("refuses to convert selected commands into steering when the canonical turn is busy", async () => {
    const activeTurnId = TurnId.make("axiom-active-turn");
    const busy: OrchestrationThread = {
      ...thread,
      session: { ...thread.session!, status: "running", activeTurnId },
    };
    const selected = decodeClient({ ...start, axiomCommand: { name: "help" } });
    expect(await Effect.runPromise(Effect.exit(decide(selected, busy)))).toMatchObject({
      _tag: "Failure",
    });
    const steer = decodeClient({
      type: "thread.turn.steer",
      commandId: "axiom-command-steer",
      threadId,
      message: start.message,
      axiomCommand: { name: "help" },
      createdAt: now,
    });
    expect(await Effect.runPromise(Effect.exit(decide(steer, busy)))).toMatchObject({
      _tag: "Failure",
    });
  });

  it("refuses selected command intent on unattended scheduled input", async () => {
    const command: OrchestrationCommand = {
      ...start,
      commandId: CommandId.make("server:scheduled-native-command"),
      axiomCommand: { name: "help" },
      scheduledFollowUp: {
        scheduleId: "schedule",
        runId: "run",
        revision: 1,
        expectedModelSelection: thread.modelSelection,
        expectedRuntimeMode: thread.runtimeMode,
        expectedInteractionMode: thread.interactionMode,
      },
    };
    expect(await Effect.runPromise(Effect.exit(decide(command)))).toMatchObject({
      _tag: "Failure",
    });
  });
});
