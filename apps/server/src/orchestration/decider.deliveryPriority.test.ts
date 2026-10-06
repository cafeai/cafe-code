import {
  CommandId,
  MessageId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type OrchestrationCommand,
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
        if (active && priority && event?.type === "thread.turn-steer-requested") {
          expect(event.payload.expectedPrioritySession).toEqual({
            providerInstanceId: selection.instanceId,
            subagentRuntimeId: null,
            activeTurnId: "running-turn",
          });
        }
        expect(events.filter((entry) => entry.type === "thread.message-sent")).toHaveLength(1);
      });
    }
  }

  for (const deliveryPriority of ["now", "next", "later"] as const) {
    it(`binds explicit ${deliveryPriority} steering to the observed account, runtime and turn`, async () => {
      const activeTurnId = TurnId.make("priority-bound-turn");
      const subagentRuntimeId = "b4613f5d-dd81-4c5d-a49f-8f51e331ef51";
      const session = {
        threadId,
        providerName: "claudeAgent",
        providerInstanceId: selection.instanceId,
        subagentRuntimeId,
        runtimeMode: "approval-required" as const,
        activeTurnId,
        status: "running" as const,
        lastError: null,
        updatedAt: now,
      };
      const expectedPrioritySession = {
        providerInstanceId: selection.instanceId,
        subagentRuntimeId,
        activeTurnId,
      };
      const command: Extract<OrchestrationCommand, { type: "thread.turn.steer" }> = {
        type: "thread.turn.steer",
        commandId: CommandId.make(`bound-priority-${deliveryPriority}`),
        threadId,
        deliveryPriority,
        expectedPrioritySession,
        message: {
          messageId: MessageId.make("bound-message"),
          role: "user",
          text: "Guidance",
          attachments: [],
        },
        createdAt: now,
      };
      const decide = (currentSession: OrchestrationThread["session"], input = command) =>
        Effect.runPromise(
          decideOrchestrationCommand({
            command: input,
            readModel: {
              snapshotSequence: 1,
              projects: [],
              threads: [{ ...thread, session: currentSession }],
              updatedAt: now,
            },
          }),
        );
      const result = await decide(session);
      expect(result).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "thread.turn-steer-requested",
            payload: expect.objectContaining({
              deliveryPriority,
              expectedPrioritySession,
              expectedTurnId: activeTurnId,
            }),
          }),
        ]),
      );
      for (const changed of [
        { ...session, providerInstanceId: ProviderInstanceId.make("claude-other") },
        { ...session, providerName: "codex" },
        { ...session, subagentRuntimeId: "a992f68b-fdb9-49b7-bc63-cc662b177b46" },
        { ...session, subagentRuntimeId: null },
        { ...session, activeTurnId: TurnId.make("new-turn") },
        { ...session, status: "ready" as const, activeTurnId: null },
        null,
      ]) {
        await expect(decide(changed)).rejects.toThrow("explicit-priority Claude session changed");
      }
      const { expectedPrioritySession: _missing, ...unbound } = command;
      await expect(decide(session, unbound)).rejects.toThrow(
        "explicit-priority Claude session changed",
      );
      // Unknown runtime must match unknown runtime, never any later known one.
      const legacy = {
        ...command,
        expectedPrioritySession: { ...expectedPrioritySession, subagentRuntimeId: null },
      };
      await expect(decide({ ...session, subagentRuntimeId: null }, legacy)).resolves.toBeDefined();
      await expect(decide(session, legacy)).rejects.toThrow(
        "explicit-priority Claude session changed",
      );
    });
  }
});
