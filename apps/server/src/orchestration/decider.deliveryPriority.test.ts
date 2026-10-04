import {
  CommandId,
  MessageId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type ThreadTurnStartCommand,
} from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { decideOrchestrationCommand } from "./decider.ts";

const now = "2026-10-05T00:00:00.000Z";
const threadId = ThreadId.make("priority-chat");
const selection = {
  instanceId: ProviderInstanceId.make("claude-account"),
  model: "claude-fable-5-1",
  options: [],
};
const thread: OrchestrationThread = {
  id: threadId,
  projectId: null,
  title: "Priority",
  modelSelection: selection,
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

describe("durable explicit delivery priority", () => {
  for (const priority of [undefined, "now", "next", "later"] as const) {
    for (const active of [false, true]) {
      it(`preserves ${priority ?? "native default"} when ${active ? "steering" : "starting"}`, async () => {
        const command: typeof ThreadTurnStartCommand.Type = {
          type: "thread.turn.start",
          commandId: CommandId.make("priority-send"),
          threadId,
          message: {
            messageId: MessageId.make("priority-message"),
            role: "user",
            text: "Guidance",
            attachments: [],
          },
          modelSelection: selection,
          runtimeMode: "approval-required",
          interactionMode: "default",
          createdAt: now,
          ...(priority ? { deliveryPriority: priority } : {}),
        };
        const current = active
          ? {
              ...thread,
              session: {
                threadId,
                providerName: "claudeAgent",
                providerInstanceId: selection.instanceId,
                runtimeMode: "approval-required" as const,
                activeTurnId: TurnId.make("running-turn"),
                status: "running" as const,
                lastError: null,
                updatedAt: now,
              },
            }
          : thread;
        const model: OrchestrationReadModel = {
          snapshotSequence: 1,
          projects: [],
          threads: [current],
          updatedAt: now,
        };
        const decided = await Effect.runPromise(
          decideOrchestrationCommand({ command, readModel: model }),
        );
        const events = Array.isArray(decided) ? decided : [decided];
        const event = events.find(
          (entry) =>
            entry.type === (active ? "thread.turn-steer-requested" : "thread.turn-start-requested"),
        );
        expect(event).toBeDefined();
        expect((event?.payload as { deliveryPriority?: string }).deliveryPriority).toBe(priority);
        expect(events.filter((entry) => entry.type === "thread.message-sent")).toHaveLength(1);
      });
    }
  }
});
