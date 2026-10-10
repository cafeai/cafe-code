import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  RuntimeItemId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
} from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import { createEmptyReadModel, projectEvent } from "./projector.ts";

function makeEvent(input: {
  sequence: number;
  type: OrchestrationEvent["type"];
  occurredAt: string;
  aggregateKind: OrchestrationEvent["aggregateKind"];
  aggregateId: string;
  commandId: string | null;
  payload: unknown;
}): OrchestrationEvent {
  return {
    sequence: input.sequence,
    eventId: EventId.make(`event-${input.sequence}`),
    type: input.type,
    aggregateKind: input.aggregateKind,
    aggregateId:
      input.aggregateKind === "project"
        ? ProjectId.make(input.aggregateId)
        : ThreadId.make(input.aggregateId),
    occurredAt: input.occurredAt,
    commandId: input.commandId === null ? null : CommandId.make(input.commandId),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: input.payload as never,
  } as OrchestrationEvent;
}

describe("orchestration projector", () => {
  it.each(["unobserved", "running", "error"] as const)(
    "associates an accepted failed root without inventing or erasing observed timing: %s",
    async (state) => {
      const createdAt = "2026-01-01T00:00:00.000Z";
      const requestedAt = "2026-01-01T00:00:03.000Z";
      const startedAt = "2026-01-01T00:00:04.000Z";
      const completedAt = "2026-01-01T00:00:05.000Z";
      const confirmationAt = "2026-01-01T00:00:06.000Z";
      const threadId = ThreadId.make("thread-failed-acceptance");
      const turnId = TurnId.make("accepted-failed-B");
      let model = await Effect.runPromise(
        projectEvent(
          createEmptyReadModel(createdAt),
          makeEvent({
            sequence: 1,
            type: "thread.created",
            aggregateKind: "thread",
            aggregateId: threadId,
            occurredAt: createdAt,
            commandId: "server:create-acceptance-thread",
            payload: {
              threadId,
              projectId: "project-1",
              title: "Accepted failure",
              modelSelection: { instanceId: "codex", model: "gpt-6-astra" },
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              createdAt,
              updatedAt: createdAt,
            },
          }),
        ),
      );
      const thread = model.threads[0]!;
      const session = {
        threadId,
        providerName: "codex",
        providerInstanceId: thread.modelSelection.instanceId,
        status: "ready" as const,
        runtimeMode: "full-access" as const,
        activeTurnId: null,
        lastError: "Root failed.",
        updatedAt: createdAt,
      };
      // These fixtures explicitly distinguish genuinely observed B timing
      // from an absent B: an accepted-send receipt is never a turn-start event.
      model = {
        ...model,
        threads: [
          {
            ...thread,
            session,
            latestTurn:
              state === "unobserved"
                ? {
                    turnId: TurnId.make("failed-A"),
                    state: "error",
                    requestedAt: createdAt,
                    startedAt: createdAt,
                    completedAt: createdAt,
                    assistantMessageId: null,
                  }
                : {
                    turnId,
                    state,
                    requestedAt,
                    startedAt,
                    completedAt: state === "error" ? completedAt : null,
                    assistantMessageId: MessageId.make("assistant-B"),
                  },
            messages:
              state === "unobserved"
                ? []
                : [
                    {
                      id: MessageId.make("assistant-B"),
                      role: "assistant",
                      text: "Visible partial answer",
                      turnId,
                      streaming: true,
                      createdAt: startedAt,
                      updatedAt: completedAt,
                    },
                  ],
          },
        ],
      };
      const associated = await Effect.runPromise(
        projectEvent(
          model,
          makeEvent({
            sequence: 2,
            type: "thread.session-set",
            aggregateKind: "thread",
            aggregateId: threadId,
            occurredAt: confirmationAt,
            commandId: "server:associate-failed-B",
            payload: {
              threadId,
              session: { ...session, updatedAt: confirmationAt },
              codexFailedRoot: {
                turnId,
                previousTurnId: "failed-A",
                messageId: "admitted-continuation",
                intentSequence: 10,
                requestedAt,
                completedAt: confirmationAt,
              },
            },
          }),
        ),
      );
      expect(associated.threads[0]?.latestTurn).toEqual({
        turnId,
        state: "error",
        requestedAt,
        startedAt: state === "unobserved" ? null : startedAt,
        completedAt: state === "error" ? completedAt : confirmationAt,
        assistantMessageId: state === "unobserved" ? null : MessageId.make("assistant-B"),
      });
      expect(associated.threads[0]?.session).toMatchObject({ status: "ready", activeTurnId: null });
      if (state !== "unobserved")
        expect(associated.threads[0]?.messages[0]).toMatchObject({
          text: "Visible partial answer",
          streaming: false,
          turnId,
        });
      expect(model.threads[0]?.latestTurn?.state).toBe(state === "unobserved" ? "error" : state);
      // Replaying the same terminal association cannot advance its completion
      // clock or resurrect the provider/assistant spinner.
      const replayed = await Effect.runPromise(
        projectEvent(
          associated,
          makeEvent({
            sequence: 3,
            type: "thread.session-set",
            aggregateKind: "thread",
            aggregateId: threadId,
            occurredAt: confirmationAt,
            commandId: "server:associate-failed-B-replay",
            payload: {
              threadId,
              session: associated.threads[0]!.session,
              codexFailedRoot: {
                turnId,
                previousTurnId: "failed-A",
                messageId: "admitted-continuation",
                intentSequence: 10,
                requestedAt,
                completedAt: confirmationAt,
              },
            },
          }),
        ),
      );
      expect(replayed.threads[0]?.latestTurn).toEqual(associated.threads[0]?.latestTurn);
    },
  );

  it.each([false, true])(
    "preserves failed context only for a transient recovery intent: %s",
    async (transient) => {
      const createdAt = "2026-01-01T00:00:00.000Z";
      const failedAt = "2026-01-01T00:00:02.000Z";
      let model = createEmptyReadModel(createdAt);
      const append = async (
        sequence: number,
        type: OrchestrationEvent["type"],
        payload: unknown,
        occurredAt = failedAt,
      ) => {
        model = await Effect.runPromise(
          projectEvent(
            model,
            makeEvent({
              sequence,
              type,
              payload,
              aggregateKind: "thread",
              aggregateId: "thread-recovery",
              occurredAt,
              commandId: `cmd-recovery-${sequence}`,
            }),
          ),
        );
      };
      await append(
        1,
        "thread.created",
        {
          threadId: "thread-recovery",
          projectId: "project-1",
          title: "Recovery",
          modelSelection: { instanceId: "codex", model: "gpt-5-codex" },
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt,
          updatedAt: createdAt,
        },
        createdAt,
      );
      const session = {
        threadId: "thread-recovery",
        providerName: "codex",
        providerInstanceId: "codex",
        subagentRuntimeId: "00000000-0000-4000-8000-000000000051",
        runtimeMode: "approval-required",
        status: "running",
        activeTurnId: "failed-root",
        lastError: null,
        updatedAt: createdAt,
      };
      await append(2, "thread.session-set", { threadId: "thread-recovery", session });
      await append(3, "thread.session-set", {
        threadId: "thread-recovery",
        session: {
          ...session,
          status: "error",
          activeTurnId: null,
          lastError: "Root failed",
          updatedAt: failedAt,
        },
      });
      await append(4, "thread.session-set", {
        threadId: "thread-recovery",
        session: {
          ...session,
          status: "ready",
          activeTurnId: null,
          lastError: "Root failed",
          updatedAt: failedAt,
        },
      });
      const ready = model.threads[0]!.session;
      const failedRoot = model.threads[0]!.latestTurn;
      await append(
        5,
        "thread.turn-start-requested",
        {
          threadId: "thread-recovery",
          messageId: "recovery-message",
          runtimeMode: "approval-required",
          interactionMode: "default",
          createdAt: "2026-01-01T00:00:03.000Z",
          ...(transient
            ? {
                runtimeRecovery: {
                  sourceEventSequence: 4,
                  turnId: "failed-root",
                  sessionUpdatedAt: failedAt,
                  codexTransientFailure: {
                    providerInstanceId: "codex",
                    subagentRuntimeId: session.subagentRuntimeId,
                    chainSourceEventSequence: 4,
                    retryAttempt: 0,
                  },
                },
              }
            : {}),
        },
        "2026-01-01T00:00:03.000Z",
      );
      expect(model.threads[0]!.session?.status).toBe(transient ? "ready" : "starting");
      expect(model.threads[0]!.session?.lastError).toBe(transient ? "Root failed" : null);
      expect(model.threads[0]!.latestTurn).toEqual(failedRoot);
      if (transient) expect(model.threads[0]!.session).toEqual(ready);
      expect(failedRoot?.state).toBe("error");
    },
  );

  it("applies thread.created events", async () => {
    const now = "2026-01-01T00:00:00.000Z";
    const model = createEmptyReadModel(now);

    const next = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: now,
          commandId: "cmd-thread-create",
          payload: {
            threadId: "thread-1",
            projectId: "project-1",
            title: "demo",
            modelSelection: {
              provider: ProviderDriverKind.make("codex"),
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt: now,
            updatedAt: now,
          },
        }),
      ),
    );

    expect(next.snapshotSequence).toBe(1);
    expect(next.threads).toEqual([
      {
        id: "thread-1",
        projectId: "project-1",
        title: "demo",
        modelSelection: {
          instanceId: "codex",
          model: "gpt-5-codex",
        },
        runtimeMode: "full-access",
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
        goal: null,
      },
    ]);
  });

  it("keeps diff placeholders non-terminal and permits only explicit live continuation recovery", async () => {
    const createdAt = "2026-07-14T00:00:00.000Z";
    const created = await Effect.runPromise(
      projectEvent(
        createEmptyReadModel(createdAt),
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-live-continuation",
          occurredAt: createdAt,
          commandId: "cmd-create-live-continuation",
          payload: {
            threadId: "thread-live-continuation",
            projectId: "project-1",
            title: "Live continuation",
            modelSelection: { instanceId: "codex", model: "gpt-5.4" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );
    const running = await Effect.runPromise(
      projectEvent(
        created,
        makeEvent({
          sequence: 2,
          type: "thread.session-set",
          aggregateKind: "thread",
          aggregateId: "thread-live-continuation",
          occurredAt: "2026-07-14T00:00:01.000Z",
          commandId: "cmd-running-live-continuation",
          payload: {
            threadId: "thread-live-continuation",
            session: {
              threadId: "thread-live-continuation",
              status: "running",
              providerName: "codex",
              providerInstanceId: "codex",
              runtimeMode: "full-access",
              activeTurnId: "turn-live-continuation",
              lastError: null,
              updatedAt: "2026-07-14T00:00:01.000Z",
            },
          },
        }),
      ),
    );
    const withMissingDiff = await Effect.runPromise(
      projectEvent(
        running,
        makeEvent({
          sequence: 3,
          type: "thread.turn-diff-completed",
          aggregateKind: "thread",
          aggregateId: "thread-live-continuation",
          occurredAt: "2026-07-14T00:00:02.000Z",
          commandId: "cmd-missing-diff-live-continuation",
          payload: {
            threadId: "thread-live-continuation",
            turnId: "turn-live-continuation",
            checkpointTurnCount: 1,
            checkpointRef: "provider-diff:event-1",
            status: "missing",
            files: [],
            assistantMessageId: null,
            completedAt: "2026-07-14T00:00:02.000Z",
          },
        }),
      ),
    );

    expect(withMissingDiff.threads[0]?.session?.status).toBe("running");
    expect(withMissingDiff.threads[0]?.latestTurn).toMatchObject({
      turnId: "turn-live-continuation",
      state: "running",
      completedAt: null,
    });

    const completed = await Effect.runPromise(
      projectEvent(
        withMissingDiff,
        makeEvent({
          sequence: 4,
          type: "thread.session-set",
          aggregateKind: "thread",
          aggregateId: "thread-live-continuation",
          occurredAt: "2026-07-14T00:00:03.000Z",
          commandId: "cmd-complete-live-continuation",
          payload: {
            threadId: "thread-live-continuation",
            session: {
              threadId: "thread-live-continuation",
              status: "ready",
              providerName: "codex",
              providerInstanceId: "codex",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: "2026-07-14T00:00:03.000Z",
            },
          },
        }),
      ),
    );
    const staleReplay = await Effect.runPromise(
      projectEvent(
        completed,
        makeEvent({
          sequence: 5,
          type: "thread.session-set",
          aggregateKind: "thread",
          aggregateId: "thread-live-continuation",
          occurredAt: "2026-07-14T00:00:04.000Z",
          commandId: "cmd-stale-live-continuation",
          payload: {
            threadId: "thread-live-continuation",
            session: {
              threadId: "thread-live-continuation",
              status: "running",
              providerName: "codex",
              providerInstanceId: "codex",
              runtimeMode: "full-access",
              activeTurnId: "turn-live-continuation",
              lastError: null,
              updatedAt: "2026-07-14T00:00:04.000Z",
            },
          },
        }),
      ),
    );
    expect(staleReplay.threads[0]?.session?.status).toBe("ready");

    const recovered = await Effect.runPromise(
      projectEvent(
        staleReplay,
        makeEvent({
          sequence: 6,
          type: "thread.session-set",
          aggregateKind: "thread",
          aggregateId: "thread-live-continuation",
          occurredAt: "2026-07-14T00:00:05.000Z",
          commandId: "cmd-recover-live-continuation",
          payload: {
            threadId: "thread-live-continuation",
            session: {
              threadId: "thread-live-continuation",
              status: "running",
              providerName: "codex",
              providerInstanceId: "codex",
              runtimeMode: "full-access",
              activeTurnId: "turn-live-continuation",
              lastError: null,
              updatedAt: "2026-07-14T00:00:05.000Z",
            },
            terminalTurnRecovery: "live-provider-continuation",
          },
        }),
      ),
    );
    expect(recovered.threads[0]?.session?.status).toBe("running");
    expect(recovered.threads[0]?.latestTurn).toMatchObject({
      turnId: "turn-live-continuation",
      state: "running",
      completedAt: null,
    });
  });

  it("ignores an older provisional starting session in the renderer projection", async () => {
    const createdAt = "2026-08-24T15:20:00.000Z";
    const created = await Effect.runPromise(
      projectEvent(
        createEmptyReadModel(createdAt),
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-stale-session-clock",
          occurredAt: createdAt,
          commandId: "cmd-create-stale-session-clock",
          payload: {
            threadId: "thread-stale-session-clock",
            projectId: "project-1",
            title: "Stale session clock",
            modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );
    const recovered = await Effect.runPromise(
      projectEvent(
        created,
        makeEvent({
          sequence: 2,
          type: "thread.session-set",
          aggregateKind: "thread",
          aggregateId: "thread-stale-session-clock",
          occurredAt: "2026-08-24T15:31:06.753Z",
          commandId: "cmd-recover-stale-session-clock",
          payload: {
            threadId: "thread-stale-session-clock",
            session: {
              threadId: "thread-stale-session-clock",
              status: "ready",
              providerName: "codex",
              providerInstanceId: "codex",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: "2026-08-24T15:31:06.753Z",
            },
          },
        }),
      ),
    );
    const replayed = await Effect.runPromise(
      projectEvent(
        recovered,
        makeEvent({
          sequence: 3,
          type: "thread.session-set",
          aggregateKind: "thread",
          aggregateId: "thread-stale-session-clock",
          occurredAt: "2026-08-24T15:31:07.000Z",
          commandId: "cmd-replay-stale-session-clock",
          payload: {
            threadId: "thread-stale-session-clock",
            session: {
              threadId: "thread-stale-session-clock",
              status: "starting",
              providerName: "codex",
              providerInstanceId: "codex",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: "2026-08-24T14:25:45.050Z",
            },
          },
        }),
      ),
    );

    expect(replayed.threads[0]?.session).toMatchObject({
      status: "ready",
      updatedAt: "2026-08-24T15:31:06.753Z",
    });
  });

  it("applies assistant repair suffix events without reopening streaming state", async () => {
    const now = "2026-01-01T00:00:00.000Z";
    const created = await Effect.runPromise(
      projectEvent(
        createEmptyReadModel(now),
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-repair",
          occurredAt: now,
          commandId: "cmd-thread-create",
          payload: {
            threadId: "thread-repair",
            projectId: "project-1",
            title: "Repair Thread",
            modelSelection: {
              instanceId: "codex",
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: now,
            updatedAt: now,
          },
        }),
      ),
    );
    const withMessage = await Effect.runPromise(
      projectEvent(
        created,
        makeEvent({
          sequence: 2,
          type: "thread.message-sent",
          aggregateKind: "thread",
          aggregateId: "thread-repair",
          occurredAt: "2026-01-01T00:00:01.000Z",
          commandId: "cmd-message",
          payload: {
            threadId: "thread-repair",
            messageId: "assistant:item-1",
            role: "assistant",
            text: "visible prefix",
            turnId: "turn-1",
            streaming: false,
            createdAt: "2026-01-01T00:00:01.000Z",
            updatedAt: "2026-01-01T00:00:01.000Z",
          },
        }),
      ),
    );
    const repaired = await Effect.runPromise(
      projectEvent(
        withMessage,
        makeEvent({
          sequence: 3,
          type: "thread.message.assistant-repair-applied",
          aggregateKind: "thread",
          aggregateId: "thread-repair",
          occurredAt: "2026-01-01T00:00:02.000Z",
          commandId: "cmd-repair",
          payload: {
            threadId: "thread-repair",
            messageId: "assistant:item-1",
            turnId: "turn-1",
            suffix: " plus repaired suffix",
            provider: ProviderDriverKind.make("codex"),
            providerInstanceId: "codex",
            itemId: RuntimeItemId.make("item-1"),
            sourceEventId: "evt-item-completed",
            oldLength: "visible prefix".length,
            newLength: "visible prefix plus repaired suffix".length,
            appendedLength: " plus repaired suffix".length,
            repairedAt: "2026-01-01T00:00:02.000Z",
          },
        }),
      ),
    );

    const thread = repaired.threads.find((entry) => entry.id === "thread-repair");
    expect(thread?.messages[0]?.text).toBe("visible prefix plus repaired suffix");
    expect(thread?.messages[0]?.streaming).toBe(false);
    expect(thread?.session?.activeTurnId ?? null).toBe(null);
  });

  it("moves threads between projects on thread.meta-updated events", async () => {
    const now = "2026-01-01T00:00:00.000Z";
    const later = "2026-01-01T00:00:01.000Z";
    const created = await Effect.runPromise(
      projectEvent(
        createEmptyReadModel(now),
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: now,
          commandId: "cmd-thread-create",
          payload: {
            threadId: "thread-1",
            projectId: "project-1",
            title: "demo",
            modelSelection: {
              provider: ProviderDriverKind.make("codex"),
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: now,
            updatedAt: now,
          },
        }),
      ),
    );

    const moved = await Effect.runPromise(
      projectEvent(
        created,
        makeEvent({
          sequence: 2,
          type: "thread.meta-updated",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: later,
          commandId: "cmd-thread-move",
          payload: {
            threadId: "thread-1",
            projectId: "project-2",
            updatedAt: later,
          },
        }),
      ),
    );

    expect(moved.threads[0]?.projectId).toBe("project-2");
    expect(moved.threads[0]?.title).toBe("demo");
    expect(moved.threads[0]?.updatedAt).toBe(later);
  });

  it("fails when event payload cannot be decoded by runtime schema", async () => {
    const now = "2026-01-01T00:00:00.000Z";
    const model = createEmptyReadModel(now);

    await expect(
      Effect.runPromise(
        projectEvent(
          model,
          makeEvent({
            sequence: 1,
            type: "thread.created",
            aggregateKind: "thread",
            aggregateId: "thread-1",
            occurredAt: now,
            commandId: "cmd-invalid",
            payload: {
              // missing required threadId
              projectId: "project-1",
              title: "demo",
              modelSelection: {
                provider: ProviderDriverKind.make("codex"),
                model: "gpt-5-codex",
              },
              branch: null,
              worktreePath: null,
              createdAt: now,
              updatedAt: now,
            },
          }),
        ),
      ),
    ).rejects.toBeDefined();
  });

  it("applies thread.archived and thread.unarchived events", async () => {
    const now = "2026-01-01T00:00:00.000Z";
    const later = "2026-01-01T00:00:01.000Z";
    const created = await Effect.runPromise(
      projectEvent(
        createEmptyReadModel(now),
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: now,
          commandId: "cmd-thread-create",
          payload: {
            threadId: "thread-1",
            projectId: "project-1",
            title: "demo",
            modelSelection: {
              provider: ProviderDriverKind.make("codex"),
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: now,
            updatedAt: now,
          },
        }),
      ),
    );

    const archived = await Effect.runPromise(
      projectEvent(
        created,
        makeEvent({
          sequence: 2,
          type: "thread.archived",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: later,
          commandId: "cmd-thread-archive",
          payload: {
            threadId: "thread-1",
            archivedAt: later,
            updatedAt: later,
          },
        }),
      ),
    );
    expect(archived.threads[0]?.archivedAt).toBe(later);

    const unarchived = await Effect.runPromise(
      projectEvent(
        archived,
        makeEvent({
          sequence: 3,
          type: "thread.unarchived",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: later,
          commandId: "cmd-thread-unarchive",
          payload: {
            threadId: "thread-1",
            updatedAt: later,
          },
        }),
      ),
    );
    expect(unarchived.threads[0]?.archivedAt).toBeNull();
  });

  it("keeps projector forward-compatible for unhandled event types", async () => {
    const now = "2026-01-01T00:00:00.000Z";
    const model = createEmptyReadModel(now);

    const next = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 7,
          type: "thread.turn-start-requested",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: "2026-01-01T00:00:00.000Z",
          commandId: "cmd-unhandled",
          payload: {
            threadId: "thread-1",
            messageId: "message-1",
            runtimeMode: "approval-required",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        }),
      ),
    );

    expect(next.snapshotSequence).toBe(7);
    expect(next.updatedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(next.threads).toEqual([]);
  });

  it("tracks latest turn id from session lifecycle events", async () => {
    const createdAt = "2026-02-23T08:00:00.000Z";
    const startedAt = "2026-02-23T08:00:05.000Z";
    const completedAt = "2026-02-23T08:00:10.000Z";
    const model = createEmptyReadModel(createdAt);

    const afterCreate = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: createdAt,
          commandId: "cmd-create",
          payload: {
            threadId: "thread-1",
            projectId: "project-1",
            title: "demo",
            modelSelection: {
              provider: ProviderDriverKind.make("codex"),
              model: "gpt-5.3-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );

    const afterRunning = await Effect.runPromise(
      projectEvent(
        afterCreate,
        makeEvent({
          sequence: 2,
          type: "thread.session-set",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: startedAt,
          commandId: "cmd-running",
          payload: {
            threadId: "thread-1",
            session: {
              threadId: "thread-1",
              status: "running",
              providerName: "codex",
              providerSessionId: "session-1",
              providerThreadId: "provider-thread-1",
              runtimeMode: "approval-required",
              activeTurnId: "turn-1",
              lastError: null,
              updatedAt: startedAt,
            },
          },
        }),
      ),
    );

    const thread = afterRunning.threads[0];
    expect(thread?.latestTurn?.turnId).toBe("turn-1");
    expect(thread?.latestTurn?.state).toBe("running");
    expect(thread?.session?.status).toBe("running");

    const afterReady = await Effect.runPromise(
      projectEvent(
        afterRunning,
        makeEvent({
          sequence: 3,
          type: "thread.session-set",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: completedAt,
          commandId: "cmd-ready",
          payload: {
            threadId: "thread-1",
            session: {
              threadId: "thread-1",
              status: "ready",
              providerName: "codex",
              providerSessionId: "session-1",
              providerThreadId: "provider-thread-1",
              runtimeMode: "approval-required",
              activeTurnId: null,
              lastError: null,
              updatedAt: completedAt,
            },
          },
        }),
      ),
    );

    const completedThread = afterReady.threads[0];
    expect(completedThread?.latestTurn).toMatchObject({
      turnId: "turn-1",
      state: "completed",
      completedAt,
    });
    expect(completedThread?.session?.status).toBe("ready");
    expect(completedThread?.session?.activeTurnId).toBeNull();
  });

  it("closes active sessions when a turn interrupt is requested", async () => {
    const createdAt = "2026-05-24T15:00:00.000Z";
    const startedAt = "2026-05-24T15:00:01.000Z";
    const interruptedAt = "2026-05-24T15:00:02.000Z";
    const threadId = ThreadId.make("thread-interrupt");
    const turnId = TurnId.make("turn-interrupt");
    const model = createEmptyReadModel(createdAt);

    const afterCreate = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: createdAt,
          commandId: "cmd-create",
          payload: {
            threadId,
            projectId: "project-1",
            title: "demo",
            modelSelection: {
              provider: ProviderDriverKind.make("codex"),
              model: "gpt-5.3-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );

    const afterRunning = await Effect.runPromise(
      projectEvent(
        afterCreate,
        makeEvent({
          sequence: 2,
          type: "thread.session-set",
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: startedAt,
          commandId: "cmd-running",
          payload: {
            threadId,
            session: {
              threadId,
              status: "running",
              providerName: "codex",
              providerInstanceId: "codex",
              runtimeMode: "full-access",
              activeTurnId: turnId,
              lastError: null,
              updatedAt: startedAt,
            },
          },
        }),
      ),
    );

    const afterInterrupt = await Effect.runPromise(
      projectEvent(
        afterRunning,
        makeEvent({
          sequence: 3,
          type: "thread.turn-interrupt-requested",
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: interruptedAt,
          commandId: "cmd-interrupt",
          payload: {
            threadId,
            turnId,
            createdAt: interruptedAt,
          },
        }),
      ),
    );

    const interruptedThread = afterInterrupt.threads[0];
    expect(interruptedThread?.session).toMatchObject({
      status: "interrupted",
      activeTurnId: null,
      updatedAt: interruptedAt,
    });
    expect(interruptedThread?.latestTurn).toMatchObject({
      turnId,
      state: "interrupted",
      completedAt: interruptedAt,
    });
  });

  it("updates canonical thread runtime mode from thread.runtime-mode-set", async () => {
    const createdAt = "2026-02-23T08:00:00.000Z";
    const updatedAt = "2026-02-23T08:00:05.000Z";
    const model = createEmptyReadModel(createdAt);

    const afterCreate = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: createdAt,
          commandId: "cmd-create",
          payload: {
            threadId: "thread-1",
            projectId: "project-1",
            title: "demo",
            modelSelection: {
              provider: ProviderDriverKind.make("codex"),
              model: "gpt-5.3-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );

    const afterUpdate = await Effect.runPromise(
      projectEvent(
        afterCreate,
        makeEvent({
          sequence: 2,
          type: "thread.runtime-mode-set",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: updatedAt,
          commandId: "cmd-runtime-mode-set",
          payload: {
            threadId: "thread-1",
            runtimeMode: "approval-required",
            updatedAt,
          },
        }),
      ),
    );

    expect(afterUpdate.threads[0]?.runtimeMode).toBe("approval-required");
    expect(afterUpdate.threads[0]?.updatedAt).toBe(updatedAt);
  });

  it("marks assistant messages completed with non-streaming updates", async () => {
    const createdAt = "2026-02-23T09:00:00.000Z";
    const deltaAt = "2026-02-23T09:00:01.000Z";
    const completeAt = "2026-02-23T09:00:03.500Z";
    const model = createEmptyReadModel(createdAt);

    const afterCreate = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: createdAt,
          commandId: "cmd-create",
          payload: {
            threadId: "thread-1",
            projectId: "project-1",
            title: "demo",
            modelSelection: {
              provider: ProviderDriverKind.make("codex"),
              model: "gpt-5.3-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );

    const afterDelta = await Effect.runPromise(
      projectEvent(
        afterCreate,
        makeEvent({
          sequence: 2,
          type: "thread.message-sent",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: deltaAt,
          commandId: "cmd-delta",
          payload: {
            threadId: "thread-1",
            messageId: "assistant:msg-1",
            role: "assistant",
            text: "hello",
            turnId: "turn-1",
            streaming: true,
            createdAt: deltaAt,
            updatedAt: deltaAt,
          },
        }),
      ),
    );

    const afterComplete = await Effect.runPromise(
      projectEvent(
        afterDelta,
        makeEvent({
          sequence: 3,
          type: "thread.message-sent",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: completeAt,
          commandId: "cmd-complete",
          payload: {
            threadId: "thread-1",
            messageId: "assistant:msg-1",
            role: "assistant",
            text: "",
            turnId: "turn-1",
            streaming: false,
            createdAt: completeAt,
            updatedAt: completeAt,
          },
        }),
      ),
    );

    const message = afterComplete.threads[0]?.messages[0];
    expect(message?.id).toBe("assistant:msg-1");
    expect(message?.text).toBe("hello");
    expect(message?.streaming).toBe(false);
    expect(message?.updatedAt).toBe(completeAt);
  });

  it("prunes reverted turn messages from in-memory thread snapshot", async () => {
    const createdAt = "2026-02-23T10:00:00.000Z";
    const model = createEmptyReadModel(createdAt);

    const afterCreate = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: createdAt,
          commandId: "cmd-create",
          payload: {
            threadId: "thread-1",
            projectId: "project-1",
            title: "demo",
            modelSelection: {
              provider: ProviderDriverKind.make("codex"),
              model: "gpt-5.3-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );

    const events: ReadonlyArray<OrchestrationEvent> = [
      makeEvent({
        sequence: 2,
        type: "thread.message-sent",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: "2026-02-23T10:00:01.000Z",
        commandId: "cmd-user-1",
        payload: {
          threadId: "thread-1",
          messageId: "user-msg-1",
          role: "user",
          text: "First edit",
          turnId: null,
          streaming: false,
          createdAt: "2026-02-23T10:00:01.000Z",
          updatedAt: "2026-02-23T10:00:01.000Z",
        },
      }),
      makeEvent({
        sequence: 3,
        type: "thread.message-sent",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: "2026-02-23T10:00:02.000Z",
        commandId: "cmd-assistant-1",
        payload: {
          threadId: "thread-1",
          messageId: "assistant-msg-1",
          role: "assistant",
          text: "Updated README to v2.\n",
          turnId: "turn-1",
          streaming: false,
          createdAt: "2026-02-23T10:00:02.000Z",
          updatedAt: "2026-02-23T10:00:02.000Z",
        },
      }),
      makeEvent({
        sequence: 4,
        type: "thread.turn-diff-completed",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: "2026-02-23T10:00:02.500Z",
        commandId: "cmd-turn-1-complete",
        payload: {
          threadId: "thread-1",
          turnId: "turn-1",
          checkpointTurnCount: 1,
          checkpointRef: "refs/t3/checkpoints/thread-1/turn/1",
          status: "ready",
          files: [],
          assistantMessageId: "assistant-msg-1",
          completedAt: "2026-02-23T10:00:02.500Z",
        },
      }),
      makeEvent({
        sequence: 5,
        type: "thread.activity-appended",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: "2026-02-23T10:00:02.750Z",
        commandId: "cmd-activity-1",
        payload: {
          threadId: "thread-1",
          activity: {
            id: "activity-1",
            tone: "tool",
            kind: "tool.started",
            summary: "Edit file started",
            payload: { toolKind: "command" },
            turnId: "turn-1",
            createdAt: "2026-02-23T10:00:02.750Z",
          },
        },
      }),
      makeEvent({
        sequence: 6,
        type: "thread.message-sent",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: "2026-02-23T10:00:03.000Z",
        commandId: "cmd-user-2",
        payload: {
          threadId: "thread-1",
          messageId: "user-msg-2",
          role: "user",
          text: "Second edit",
          turnId: null,
          streaming: false,
          createdAt: "2026-02-23T10:00:03.000Z",
          updatedAt: "2026-02-23T10:00:03.000Z",
        },
      }),
      makeEvent({
        sequence: 7,
        type: "thread.message-sent",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: "2026-02-23T10:00:04.000Z",
        commandId: "cmd-assistant-2",
        payload: {
          threadId: "thread-1",
          messageId: "assistant-msg-2",
          role: "assistant",
          text: "Updated README to v3.\n",
          turnId: "turn-2",
          streaming: false,
          createdAt: "2026-02-23T10:00:04.000Z",
          updatedAt: "2026-02-23T10:00:04.000Z",
        },
      }),
      makeEvent({
        sequence: 8,
        type: "thread.turn-diff-completed",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: "2026-02-23T10:00:04.500Z",
        commandId: "cmd-turn-2-complete",
        payload: {
          threadId: "thread-1",
          turnId: "turn-2",
          checkpointTurnCount: 2,
          checkpointRef: "refs/t3/checkpoints/thread-1/turn/2",
          status: "ready",
          files: [],
          assistantMessageId: "assistant-msg-2",
          completedAt: "2026-02-23T10:00:04.500Z",
        },
      }),
      makeEvent({
        sequence: 9,
        type: "thread.activity-appended",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: "2026-02-23T10:00:04.750Z",
        commandId: "cmd-activity-2",
        payload: {
          threadId: "thread-1",
          activity: {
            id: "activity-2",
            tone: "tool",
            kind: "tool.completed",
            summary: "Edit file complete",
            payload: { toolKind: "command" },
            turnId: "turn-2",
            createdAt: "2026-02-23T10:00:04.750Z",
          },
        },
      }),
      makeEvent({
        sequence: 10,
        type: "thread.reverted",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: "2026-02-23T10:00:05.000Z",
        commandId: "cmd-revert",
        payload: {
          threadId: "thread-1",
          turnCount: 1,
        },
      }),
    ];

    const afterRevert = await events.reduce<Promise<ReturnType<typeof createEmptyReadModel>>>(
      (statePromise, event) =>
        statePromise.then((state) => Effect.runPromise(projectEvent(state, event))),
      Promise.resolve(afterCreate),
    );

    const thread = afterRevert.threads[0];
    expect(thread?.messages.map((message) => ({ role: message.role, text: message.text }))).toEqual(
      [
        { role: "user", text: "First edit" },
        { role: "assistant", text: "Updated README to v2.\n" },
      ],
    );
    expect(
      thread?.activities.map((activity) => ({ id: activity.id, turnId: activity.turnId })),
    ).toEqual([{ id: "activity-1", turnId: "turn-1" }]);
    expect(thread?.checkpoints.map((checkpoint) => checkpoint.checkpointTurnCount)).toEqual([1]);
    expect(thread?.latestTurn?.turnId).toBe("turn-1");
  });

  it("does not fallback-retain messages tied to removed turn IDs", async () => {
    const createdAt = "2026-02-26T12:00:00.000Z";
    const model = createEmptyReadModel(createdAt);

    const afterCreate = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-revert",
          occurredAt: createdAt,
          commandId: "cmd-create-revert",
          payload: {
            threadId: "thread-revert",
            projectId: "project-1",
            title: "demo",
            modelSelection: {
              provider: ProviderDriverKind.make("codex"),
              model: "gpt-5.3-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );

    const events: ReadonlyArray<OrchestrationEvent> = [
      makeEvent({
        sequence: 2,
        type: "thread.turn-diff-completed",
        aggregateKind: "thread",
        aggregateId: "thread-revert",
        occurredAt: "2026-02-26T12:00:01.000Z",
        commandId: "cmd-turn-1",
        payload: {
          threadId: "thread-revert",
          turnId: "turn-1",
          checkpointTurnCount: 1,
          checkpointRef: "refs/t3/checkpoints/thread-revert/turn/1",
          status: "ready",
          files: [],
          assistantMessageId: "assistant-keep",
          completedAt: "2026-02-26T12:00:01.000Z",
        },
      }),
      makeEvent({
        sequence: 3,
        type: "thread.message-sent",
        aggregateKind: "thread",
        aggregateId: "thread-revert",
        occurredAt: "2026-02-26T12:00:01.100Z",
        commandId: "cmd-assistant-keep",
        payload: {
          threadId: "thread-revert",
          messageId: "assistant-keep",
          role: "assistant",
          text: "kept",
          turnId: "turn-1",
          streaming: false,
          createdAt: "2026-02-26T12:00:01.100Z",
          updatedAt: "2026-02-26T12:00:01.100Z",
        },
      }),
      makeEvent({
        sequence: 4,
        type: "thread.turn-diff-completed",
        aggregateKind: "thread",
        aggregateId: "thread-revert",
        occurredAt: "2026-02-26T12:00:02.000Z",
        commandId: "cmd-turn-2",
        payload: {
          threadId: "thread-revert",
          turnId: "turn-2",
          checkpointTurnCount: 2,
          checkpointRef: "refs/t3/checkpoints/thread-revert/turn/2",
          status: "ready",
          files: [],
          assistantMessageId: "assistant-remove",
          completedAt: "2026-02-26T12:00:02.000Z",
        },
      }),
      makeEvent({
        sequence: 5,
        type: "thread.message-sent",
        aggregateKind: "thread",
        aggregateId: "thread-revert",
        occurredAt: "2026-02-26T12:00:02.050Z",
        commandId: "cmd-user-remove",
        payload: {
          threadId: "thread-revert",
          messageId: "user-remove",
          role: "user",
          text: "removed",
          turnId: "turn-2",
          streaming: false,
          createdAt: "2026-02-26T12:00:02.050Z",
          updatedAt: "2026-02-26T12:00:02.050Z",
        },
      }),
      makeEvent({
        sequence: 6,
        type: "thread.message-sent",
        aggregateKind: "thread",
        aggregateId: "thread-revert",
        occurredAt: "2026-02-26T12:00:02.100Z",
        commandId: "cmd-assistant-remove",
        payload: {
          threadId: "thread-revert",
          messageId: "assistant-remove",
          role: "assistant",
          text: "removed",
          turnId: "turn-2",
          streaming: false,
          createdAt: "2026-02-26T12:00:02.100Z",
          updatedAt: "2026-02-26T12:00:02.100Z",
        },
      }),
      makeEvent({
        sequence: 7,
        type: "thread.reverted",
        aggregateKind: "thread",
        aggregateId: "thread-revert",
        occurredAt: "2026-02-26T12:00:03.000Z",
        commandId: "cmd-revert",
        payload: {
          threadId: "thread-revert",
          turnCount: 1,
        },
      }),
    ];

    const afterRevert = await events.reduce<Promise<ReturnType<typeof createEmptyReadModel>>>(
      (statePromise, event) =>
        statePromise.then((state) => Effect.runPromise(projectEvent(state, event))),
      Promise.resolve(afterCreate),
    );

    const thread = afterRevert.threads[0];
    expect(
      thread?.messages.map((message) => ({
        id: message.id,
        role: message.role,
        turnId: message.turnId,
      })),
    ).toEqual([{ id: "assistant-keep", role: "assistant", turnId: "turn-1" }]);
  });

  it("caps message and checkpoint retention for long-lived threads", async () => {
    const createdAt = "2026-03-01T10:00:00.000Z";
    const model = createEmptyReadModel(createdAt);

    const afterCreate = await Effect.runPromise(
      projectEvent(
        model,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-capped",
          occurredAt: createdAt,
          commandId: "cmd-create-capped",
          payload: {
            threadId: "thread-capped",
            projectId: "project-1",
            title: "capped",
            modelSelection: {
              provider: ProviderDriverKind.make("codex"),
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );

    const messageEvents: ReadonlyArray<OrchestrationEvent> = Array.from(
      { length: 2_100 },
      (_, index) =>
        makeEvent({
          sequence: index + 2,
          type: "thread.message-sent",
          aggregateKind: "thread",
          aggregateId: "thread-capped",
          occurredAt: `2026-03-01T10:00:${String(index % 60).padStart(2, "0")}.000Z`,
          commandId: `cmd-message-${index}`,
          payload: {
            threadId: "thread-capped",
            messageId: `msg-${index}`,
            role: "assistant",
            text: `message-${index}`,
            turnId: `turn-${index}`,
            streaming: false,
            createdAt: `2026-03-01T10:00:${String(index % 60).padStart(2, "0")}.000Z`,
            updatedAt: `2026-03-01T10:00:${String(index % 60).padStart(2, "0")}.000Z`,
          },
        }),
    );
    const afterMessages = await messageEvents.reduce<
      Promise<ReturnType<typeof createEmptyReadModel>>
    >(
      (statePromise, event) =>
        statePromise.then((state) => Effect.runPromise(projectEvent(state, event))),
      Promise.resolve(afterCreate),
    );

    const checkpointEvents: ReadonlyArray<OrchestrationEvent> = Array.from(
      { length: 600 },
      (_, index) =>
        makeEvent({
          sequence: index + 2_102,
          type: "thread.turn-diff-completed",
          aggregateKind: "thread",
          aggregateId: "thread-capped",
          occurredAt: `2026-03-01T10:30:${String(index % 60).padStart(2, "0")}.000Z`,
          commandId: `cmd-checkpoint-${index}`,
          payload: {
            threadId: "thread-capped",
            turnId: `turn-${index}`,
            checkpointTurnCount: index + 1,
            checkpointRef: `refs/t3/checkpoints/thread-capped/turn/${index + 1}`,
            status: "ready",
            files: [],
            assistantMessageId: `msg-${index}`,
            completedAt: `2026-03-01T10:30:${String(index % 60).padStart(2, "0")}.000Z`,
          },
        }),
    );
    const finalState = await checkpointEvents.reduce<
      Promise<ReturnType<typeof createEmptyReadModel>>
    >(
      (statePromise, event) =>
        statePromise.then((state) => Effect.runPromise(projectEvent(state, event))),
      Promise.resolve(afterMessages),
    );

    const thread = finalState.threads[0];
    expect(thread?.messages).toHaveLength(2_000);
    expect(thread?.messages[0]?.id).toBe("msg-100");
    expect(thread?.messages.at(-1)?.id).toBe("msg-2099");
    expect(thread?.checkpoints).toHaveLength(500);
    expect(thread?.checkpoints[0]?.turnId).toBe("turn-100");
    expect(thread?.checkpoints.at(-1)?.turnId).toBe("turn-599");
  });
});
