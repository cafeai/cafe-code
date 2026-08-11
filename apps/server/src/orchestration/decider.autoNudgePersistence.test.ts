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
  TurnId,
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

async function seedArmedCompletedThread(): Promise<OrchestrationReadModel> {
  const readModel = await seedThread();
  const thread = readModel.threads[0]!;
  return {
    ...readModel,
    threads: [
      {
        ...thread,
        autoNudge: {
          authorityRevision: 1,
          mode: "steady-progress",
          prompt: "Continue this exact thread.",
          backgroundContinuation: false,
          maxRounds: 3,
          armedAt: now,
          baselineSettledTurnId: null,
          lastDispatchedSettledTurnId: null,
          lastDispatchedMessageId: null,
          roundsDispatched: 0,
          lastDispatchedAt: null,
        },
        latestTurn: {
          turnId: TurnId.make("completed-turn"),
          state: "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: "2026-08-11T00:01:00.000Z",
          assistantMessageId: null,
        },
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-08-11T00:01:00.000Z",
        },
      },
    ],
  };
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
  it("admits one prompt-free dispatch only for the exact completed turn", async () => {
    const readModel = await seedArmedCompletedThread();
    const messageId = MessageId.make("auto-nudge-message");
    const planned = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel,
        command: {
          type: "thread.auto-nudge.dispatch",
          commandId: CommandId.make("command-auto-nudge-dispatch"),
          threadId,
          expectedAuthorityRevision: 1,
          completedTurnId: TurnId.make("completed-turn"),
          dispatchSource: "foreground",
          messageId,
          createdAt: "2026-08-11T00:01:01.000Z",
        },
      }),
    );
    const events = Array.isArray(planned) ? planned : [planned];
    expect(events.map((event) => event.type)).toEqual([
      "thread.auto-nudge-dispatched",
      "thread.message-sent",
      "thread.turn-start-requested",
    ]);
    expect(events[1]?.payload).toMatchObject({ messageId, text: "Continue this exact thread." });
    expect(events[2]?.payload).toMatchObject({
      dispatchSource: "auto-nudge",
      autoNudgeAuthority: {
        authorityRevision: 1,
        completedTurnId: TurnId.make("completed-turn"),
        completedAt: "2026-08-11T00:01:00.000Z",
      },
    });

    const projected = await applyPlannedEvents(readModel, planned);
    expect(projected.threads[0]?.autoNudge).toMatchObject({
      lastDispatchedSettledTurnId: TurnId.make("completed-turn"),
      lastDispatchedMessageId: messageId,
      roundsDispatched: 1,
    });
  });

  it("rejects elapsed-idle guesses and continued provider output", async () => {
    const completed = await seedArmedCompletedThread();
    const command = {
      type: "thread.auto-nudge.dispatch" as const,
      commandId: CommandId.make("command-auto-nudge-rejected"),
      threadId,
      expectedAuthorityRevision: 1,
      completedTurnId: TurnId.make("completed-turn"),
      dispatchSource: "foreground" as const,
      messageId: MessageId.make("auto-nudge-rejected"),
      createdAt: "2026-08-11T23:59:59.000Z",
    };
    const running = {
      ...completed,
      threads: [
        {
          ...completed.threads[0]!,
          latestTurn: {
            turnId: TurnId.make("completed-turn"),
            state: "running" as const,
            requestedAt: now,
            startedAt: now,
            completedAt: null,
            assistantMessageId: null,
          },
        },
      ],
    };
    await expect(
      Effect.runPromise(decideOrchestrationCommand({ readModel: running, command })),
    ).rejects.toThrow("exact current completed turn");

    const continued = {
      ...completed,
      threads: [
        {
          ...completed.threads[0]!,
          messages: [
            {
              id: MessageId.make("assistant-after-completion"),
              role: "assistant" as const,
              text: "late provider text",
              turnId: TurnId.make("completed-turn"),
              streaming: false,
              createdAt: "2026-08-11T00:01:01.000Z",
              updatedAt: "2026-08-11T00:01:01.000Z",
            },
          ],
        },
      ],
    };
    await expect(
      Effect.runPromise(decideOrchestrationCommand({ readModel: continued, command })),
    ).rejects.toThrow("continued provider output");
  });

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

  it("keeps manual FIFO work ahead of Auto Nudge and hands off only its head", async () => {
    let readModel = await seedArmedCompletedThread();
    const followUpId = ManualFollowUpId.make("manual-priority");
    const messageId = MessageId.make("manual-priority-message");
    const reservationCommandId = CommandId.make("manual-priority-reserve");
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
    readModel = await applyPlannedEvents(readModel, reserved);
    const enqueued = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel,
        command: {
          type: "thread.manual-follow-up.enqueue",
          commandId: CommandId.make("manual-priority-enqueue"),
          threadId,
          followUpId,
          reservationCommandId,
          message: { messageId, role: "user", text: "Operator work first.", attachments: [] },
          dispatch,
          createdAt: now,
        },
      }),
    );
    readModel = await applyPlannedEvents(readModel, enqueued);

    await expect(
      Effect.runPromise(
        decideOrchestrationCommand({
          readModel,
          command: {
            type: "thread.auto-nudge.dispatch",
            commandId: CommandId.make("auto-nudge-behind-manual"),
            threadId,
            expectedAuthorityRevision: 1,
            completedTurnId: TurnId.make("completed-turn"),
            dispatchSource: "foreground",
            messageId: MessageId.make("auto-nudge-behind-manual-message"),
            createdAt: now,
          },
        }),
      ),
    ).rejects.toThrow("Manual operator work has priority");

    const activated = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel,
        command: {
          type: "thread.manual-follow-up.activate",
          commandId: CommandId.make("manual-priority-activate"),
          threadId,
          followUpId,
          activationMode: "automatic-after-settlement",
          createdAt: now,
        },
      }),
    );
    expect((Array.isArray(activated) ? activated : [activated]).map((event) => event.type)).toEqual(
      ["thread.manual-follow-up-activated", "thread.message-sent", "thread.turn-start-requested"],
    );
    const projected = await applyPlannedEvents(readModel, activated);
    expect(projected.threads[0]?.manualFollowUps[0]).toMatchObject({
      id: followUpId,
      status: "handoff",
      activationCommandId: CommandId.make("manual-priority-activate"),
    });
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
