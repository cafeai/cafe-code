import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ManualFollowUpId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const threadId = ThreadId.make("thread-auto-nudge-persistence");
const projectId = ProjectId.make("project-auto-nudge-persistence");
const now = "2026-08-11T00:00:00.000Z";

async function seedThread(): Promise<OrchestrationReadModel> {
  return Effect.runPromise(
    projectEvent(createEmptyReadModel(now), {
      sequence: 1,
      eventId: EventId.make("event-thread-created"),
      aggregateKind: "thread",
      aggregateId: threadId,
      type: "thread.created",
      occurredAt: now,
      commandId: CommandId.make("command-thread-created"),
      causationEventId: null,
      correlationId: null,
      metadata: {},
      payload: {
        threadId,
        projectId,
        title: "Auto Nudge persistence",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.6-sol",
        },
        runtimeMode: "full-access",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        branch: null,
        worktreePath: null,
        createdAt: now,
        updatedAt: now,
      },
    }),
  );
}

async function applyPlannedEvents(
  readModel: OrchestrationReadModel,
  planned:
    | Omit<OrchestrationEvent, "sequence">
    | ReadonlyArray<Omit<OrchestrationEvent, "sequence">>,
): Promise<OrchestrationReadModel> {
  let next = readModel;
  for (const event of Array.isArray(planned) ? planned : [planned]) {
    next = await Effect.runPromise(
      projectEvent(next, { ...event, sequence: next.snapshotSequence + 1 }),
    );
  }
  return next;
}

const dispatch = {
  modelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.6-sol",
  },
  titleSeed: "Queued operator follow-up",
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
};

describe("Auto Nudge persistence protocol", () => {
  it("stores exact-thread configuration without dispatching provider work", async () => {
    const readModel = await seedThread();
    const planned = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel,
        command: {
          type: "thread.auto-nudge.configure",
          commandId: CommandId.make("command-auto-nudge-configure"),
          threadId,
          expectedAuthorityRevision: 0,
          mode: "steady-progress",
          prompt: "Continue this exact thread.",
          backgroundContinuation: false,
          maxRounds: 3,
          createdAt: now,
        },
      }),
    );

    const events = Array.isArray(planned) ? planned : [planned];
    expect(events.map((event) => event.type)).toEqual(["thread.auto-nudge-configured"]);

    const projected = await applyPlannedEvents(readModel, planned);
    expect(projected.threads[0]?.autoNudge).toMatchObject({
      authorityRevision: 1,
      mode: "steady-progress",
      prompt: "Continue this exact thread.",
      backgroundContinuation: false,
      maxRounds: 3,
      roundsDispatched: 0,
      lastDispatchedMessageId: null,
    });
  });

  it("reserves prompt-free identity before storing a manual FIFO payload", async () => {
    let readModel = await seedThread();
    const followUpId = ManualFollowUpId.make("manual-follow-up-1");
    const messageId = MessageId.make("message-manual-follow-up-1");
    const reservationCommandId = CommandId.make("command-manual-follow-up-reserve");

    const reserved = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel,
        command: {
          type: "thread.manual-follow-up.reserve",
          commandId: reservationCommandId,
          threadId,
          followUpId,
          messageId,
          dispatch,
          createdAt: now,
        },
      }),
    );
    expect((Array.isArray(reserved) ? reserved : [reserved]).map((event) => event.type)).toEqual([
      "thread.manual-follow-up-reserved",
      "thread.manual-follow-up-count-changed",
    ]);
    readModel = await applyPlannedEvents(readModel, reserved);
    expect(readModel.threads[0]?.manualFollowUps[0]).toMatchObject({
      id: followUpId,
      messageId,
      status: "reserving",
    });

    const enqueued = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel,
        command: {
          type: "thread.manual-follow-up.enqueue",
          commandId: CommandId.make("command-manual-follow-up-enqueue"),
          threadId,
          followUpId,
          reservationCommandId,
          message: {
            messageId,
            role: "user",
            text: "Run this after earlier operator work.",
            attachments: [],
          },
          dispatch,
          createdAt: now,
        },
      }),
    );
    readModel = await applyPlannedEvents(readModel, enqueued);
    expect(readModel.threads[0]?.manualFollowUps).toEqual([
      expect.objectContaining({
        id: followUpId,
        status: "queued",
        message: expect.objectContaining({
          messageId,
          text: "Run this after earlier operator work.",
        }),
      }),
    ]);
  });

  it("rejects reusing a message identity across the exact-thread FIFO", async () => {
    let readModel = await seedThread();
    const messageId = MessageId.make("message-duplicate-manual-follow-up");
    const first = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel,
        command: {
          type: "thread.manual-follow-up.reserve",
          commandId: CommandId.make("command-reserve-first"),
          threadId,
          followUpId: ManualFollowUpId.make("manual-follow-up-first"),
          messageId,
          dispatch,
          createdAt: now,
        },
      }),
    );
    readModel = await applyPlannedEvents(readModel, first);

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          readModel,
          command: {
            type: "thread.manual-follow-up.reserve",
            commandId: CommandId.make("command-reserve-second"),
            threadId,
            followUpId: ManualFollowUpId.make("manual-follow-up-second"),
            messageId,
            dispatch,
            createdAt: now,
          },
        }),
      ),
    ).rejects.toThrow("already exists");
  });
});
