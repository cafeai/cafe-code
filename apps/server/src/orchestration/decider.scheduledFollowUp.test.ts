import {
  ClientOrchestrationCommand,
  CommandId,
  MessageId,
  type OrchestrationReadModel,
  type OrchestrationThread,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  ThreadTurnStartCommand,
  TurnId,
} from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";

const now = "2026-10-04T10:00:00.000Z";
const threadId = ThreadId.make("scheduled-chat");
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-6-astra",
  options: [{ id: "reasoningEffort", value: "ultra" }],
};

function makeThread(): OrchestrationThread {
  return {
    id: threadId,
    projectId: ProjectId.make("scheduled-project"),
    title: "Scheduled test",
    modelSelection,
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
    session: null,
  };
}

function makeCommand(): typeof ThreadTurnStartCommand.Type {
  return {
    type: "thread.turn.start",
    commandId: CommandId.make("server:scheduled:test-occurrence"),
    threadId,
    message: {
      messageId: MessageId.make("scheduled-message"),
      role: "user",
      text: "Check the build results once.",
      attachments: [],
    },
    modelSelection,
    runtimeMode: "approval-required",
    interactionMode: "default",
    scheduledFollowUp: {
      scheduleId: "test-schedule",
      runId: "test-occurrence",
      revision: 1,
      expectedModelSelection: modelSelection,
      expectedRuntimeMode: "approval-required",
      expectedInteractionMode: "default",
    },
    createdAt: now,
  };
}

function readModel(thread = makeThread()): OrchestrationReadModel {
  return { snapshotSequence: 10, projects: [], threads: [thread], updatedAt: now };
}

function decide(thread = makeThread(), command = makeCommand(), scheduledFollowUpVerified = true) {
  return decideOrchestrationCommand({
    command,
    readModel: readModel(thread),
    scheduledFollowUpVerified,
  });
}

describe("scheduled follow-up idle-only admission", () => {
  it.each(["now", "next", "later"] as const)(
    "rejects an explicit %s priority on a scheduled occurrence",
    async (deliveryPriority) => {
      await expect(
        Effect.runPromise(decide(makeThread(), { ...makeCommand(), deliveryPriority })),
      ).rejects.toThrow();
    },
  );
  it("retains exact server provenance without emitting any steer intent", async () => {
    const events = await Effect.runPromise(decide());
    expect(events).toMatchObject([
      { type: "thread.message-sent" },
      {
        type: "thread.turn-start-requested",
        payload: { scheduledFollowUp: makeCommand().scheduledFollowUp },
      },
    ]);
  });

  it("requires authoritative durable occurrence verification", async () => {
    await expect(Effect.runPromise(decide(makeThread(), makeCommand(), false))).rejects.toThrow(
      "Scheduled follow-up authorization no longer matches this chat.",
    );
    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({ command: makeCommand(), readModel: readModel() }),
      ),
    ).rejects.toThrow("Scheduled follow-up authorization no longer matches this chat.");
  });

  it.each(["starting", "running", "ready"] as const)(
    "never steers a %s session, including the null-turn startup boundary",
    async (status) => {
      const thread: OrchestrationThread = {
        ...makeThread(),
        session: {
          threadId,
          providerName: "codex",
          providerInstanceId: modelSelection.instanceId,
          runtimeMode: "approval-required",
          activeTurnId: status === "ready" ? TurnId.make("busy-native-turn") : null,
          status,
          lastError: null,
          updatedAt: now,
        },
      };
      await expect(Effect.runPromise(decide(thread))).rejects.toThrow(
        "Scheduled follow-up is waiting for an idle chat.",
      );
    },
  );

  it.each([
    ["archived", (thread: OrchestrationThread) => ({ ...thread, archivedAt: now })],
    ["deleted", (thread: OrchestrationThread) => ({ ...thread, deletedAt: now })],
    [
      "account changed",
      (thread: OrchestrationThread) => ({
        ...thread,
        modelSelection: { ...modelSelection, instanceId: ProviderInstanceId.make("other") },
      }),
    ],
    [
      "model changed",
      (thread: OrchestrationThread) => ({
        ...thread,
        modelSelection: { ...modelSelection, model: "gpt-6.1-sol" },
      }),
    ],
    [
      "effort changed",
      (thread: OrchestrationThread) => ({
        ...thread,
        modelSelection: { ...modelSelection, options: [{ id: "reasoningEffort", value: "low" }] },
      }),
    ],
    [
      "permissions changed",
      (thread: OrchestrationThread) => ({ ...thread, runtimeMode: "full-access" as const }),
    ],
    [
      "interaction changed",
      (thread: OrchestrationThread) => ({ ...thread, interactionMode: "plan" as const }),
    ],
  ] as const)("rejects %s without creating a message", async (_label, mutate) => {
    await expect(Effect.runPromise(decide(mutate(makeThread())))).rejects.toThrow();
  });

  it("allows a one-run same-account model override without changing the chat default", async () => {
    const command = {
      ...makeCommand(),
      modelSelection: {
        ...modelSelection,
        model: "gpt-6.1-sol",
        options: [{ id: "reasoningEffort", value: "medium" }],
      },
    };
    const events = await Effect.runPromise(decide(makeThread(), command));
    let state = readModel();
    for (const event of Array.isArray(events) ? events : [events]) {
      state = await Effect.runPromise(
        projectEvent(state, { ...event, sequence: state.snapshotSequence + 1 }),
      );
    }
    expect(state.threads[0]?.modelSelection).toEqual(modelSelection);
    expect(events).toMatchObject([
      { type: "thread.message-sent" },
      { type: "thread.turn-start-requested", payload: { modelSelection: command.modelSelection } },
    ]);
  });

  it.each([
    ["client identity", { commandId: CommandId.make("client:forged-schedule") }],
    [
      "account override",
      { modelSelection: { ...modelSelection, instanceId: ProviderInstanceId.make("other") } },
    ],
    ["permission escalation", { runtimeMode: "full-access" as const }],
    ["interaction override", { interactionMode: "plan" as const }],
    ["workspace bootstrap", { bootstrap: { runSetupScript: true } }],
    ["concurrency mutation", { subagentLimits: { codex: 8 } }],
    [
      "runtime recovery",
      {
        runtimeRecovery: {
          sourceEventSequence: 1,
          turnId: TurnId.make("old"),
          sessionUpdatedAt: now,
        },
      },
    ],
  ] as const)("rejects %s as scheduled authority", async (_label, patch) => {
    await expect(
      Effect.runPromise(decide(makeThread(), { ...makeCommand(), ...patch })),
    ).rejects.toThrow();
  });

  it("strips schedule authority at the external client boundary", () => {
    const command = { ...makeCommand(), commandId: CommandId.make("client:ordinary") };
    expect(Schema.decodeUnknownSync(ClientOrchestrationCommand)(command)).not.toHaveProperty(
      "scheduledFollowUp",
    );
    expect(
      Schema.decodeUnknownSync(ThreadTurnStartCommand)(makeCommand()).scheduledFollowUp,
    ).toEqual(makeCommand().scheduledFollowUp);
  });
});
