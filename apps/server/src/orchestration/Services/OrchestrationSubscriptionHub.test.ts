import {
  CommandId,
  EventId,
  ManualFollowUpId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationEvent,
} from "@cafecode/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vitest";

import type { OrchestrationEngineShape } from "./OrchestrationEngine.ts";
import { makeOrchestrationSubscriptionHub } from "./OrchestrationSubscriptionHub.ts";

function makeEvent(input: {
  readonly sequence: number;
  readonly aggregateKind: "project" | "thread";
  readonly aggregateId: string;
}): OrchestrationEvent {
  return {
    sequence: input.sequence,
    eventId: EventId.make(`event-${input.sequence}`),
    type: "project.deleted",
    aggregateKind: input.aggregateKind,
    aggregateId:
      input.aggregateKind === "project"
        ? ProjectId.make(input.aggregateId)
        : ThreadId.make(input.aggregateId),
    occurredAt: "2026-07-16T00:00:00.000Z",
    commandId: CommandId.make(`command-${input.sequence}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: {
      projectId: ProjectId.make(input.aggregateId),
      deletedAt: "2026-07-16T00:00:00.000Z",
    },
  } as OrchestrationEvent;
}

function makeMessageEvent(input: {
  readonly sequence: number;
  readonly threadId: string;
  readonly messageId: string;
  readonly text: string;
  readonly streaming: boolean;
}): OrchestrationEvent {
  return {
    sequence: input.sequence,
    eventId: EventId.make(`event-${input.sequence}`),
    type: "thread.message-sent",
    aggregateKind: "thread",
    aggregateId: ThreadId.make(input.threadId),
    occurredAt: "2026-07-16T00:00:00.000Z",
    commandId: CommandId.make(`command-${input.sequence}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: {
      threadId: ThreadId.make(input.threadId),
      messageId: MessageId.make(input.messageId),
      role: "assistant",
      text: input.text,
      turnId: null,
      streaming: input.streaming,
      createdAt: "2026-07-16T00:00:00.000Z",
      updatedAt: "2026-07-16T00:00:00.000Z",
    },
  };
}

const yieldHub = Effect.forEach(Array.from({ length: 10 }), () => Effect.yieldNow, {
  discard: true,
});

describe("OrchestrationSubscriptionHub", () => {
  it("uses one durable tail read regardless of active subscription count", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          let durableReadCount = 0;
          const live = yield* PubSub.unbounded<OrchestrationEvent>();
          const engine: OrchestrationEngineShape = {
            readEvents: () => {
              durableReadCount += 1;
              return Stream.empty;
            },
            dispatch: () => Effect.die("unused"),
            diagnosticsSnapshot: Effect.die("unused"),
            streamDomainEvents: Stream.fromPubSub(live),
          };
          const hub = yield* makeOrchestrationSubscriptionHub({
            orchestrationEngine: engine,
            initialCursor: 0,
            pollInterval: Duration.hours(1),
          });

          for (let index = 0; index < 10; index += 1) yield* Effect.yieldNow;
          const subscribers = yield* Effect.forEach(
            Array.from({ length: 32 }, (_, index) => index),
            () =>
              Stream.runHead(
                hub.eventsFrom({
                  fromSequenceExclusive: 0,
                  route: { kind: "shell" },
                }),
              ).pipe(Effect.forkScoped),
          );
          for (let index = 0; index < 10; index += 1) yield* Effect.yieldNow;

          expect((yield* hub.diagnosticsSnapshot).activeShellSubscriptions).toBe(32);
          expect(durableReadCount).toBe(1);
          yield* Effect.forEach(subscribers, Fiber.interrupt, { discard: true });
        }),
      ),
    );
  });

  it("replays an event from the bounded ring without another durable query", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          let durableReadCount = 0;
          const live = yield* PubSub.unbounded<OrchestrationEvent>();
          const engine: OrchestrationEngineShape = {
            readEvents: () => {
              durableReadCount += 1;
              return Stream.empty;
            },
            dispatch: () => Effect.die("unused"),
            diagnosticsSnapshot: Effect.die("unused"),
            streamDomainEvents: Stream.fromPubSub(live),
          };
          const hub = yield* makeOrchestrationSubscriptionHub({
            orchestrationEngine: engine,
            initialCursor: 0,
            pollInterval: Duration.hours(1),
          });
          for (let index = 0; index < 10; index += 1) yield* Effect.yieldNow;
          yield* PubSub.publish(
            live,
            makeEvent({ sequence: 1, aggregateKind: "project", aggregateId: "project-1" }),
          );
          for (let index = 0; index < 10; index += 1) yield* Effect.yieldNow;

          const replayed = yield* Stream.runHead(
            hub.eventsFrom({
              fromSequenceExclusive: 0,
              route: { kind: "shell" },
            }),
          );

          expect(Option.getOrThrow(replayed).sequence).toBe(1);
          expect(durableReadCount).toBe(1);
          expect((yield* hub.diagnosticsSnapshot).replayRingEvents).toBe(1);
        }),
      ),
    );
  });

  it("keeps Auto Nudge prompts exact-thread-only for live and replay subscribers", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const live = yield* PubSub.unbounded<OrchestrationEvent>();
          const engine: OrchestrationEngineShape = {
            readEvents: () => Stream.empty,
            dispatch: () => Effect.die("unused"),
            diagnosticsSnapshot: Effect.die("unused"),
            streamDomainEvents: Stream.fromPubSub(live),
          };
          const hub = yield* makeOrchestrationSubscriptionHub({
            orchestrationEngine: engine,
            initialCursor: 0,
            pollInterval: Duration.hours(1),
          });
          const threadId = ThreadId.make("thread-auto-nudge-target");
          const event = {
            sequence: 1,
            eventId: EventId.make("event-auto-nudge-target"),
            type: "thread.auto-nudge-configured",
            aggregateKind: "thread",
            aggregateId: threadId,
            occurredAt: "2026-08-11T00:00:00.000Z",
            commandId: CommandId.make("command-auto-nudge-target"),
            causationEventId: null,
            correlationId: CommandId.make("command-auto-nudge-target"),
            metadata: {},
            payload: {
              threadId,
              config: {
                authorityRevision: 1,
                mode: "steady-progress",
                prompt: "EXACT-THREAD-AUTO-NUDGE-PROMPT",
                backgroundContinuation: false,
                maxRounds: 5,
                armedAt: "2026-08-11T00:00:00.000Z",
                baselineSettledTurnId: null,
                lastDispatchedSettledTurnId: null,
                lastDispatchedMessageId: null,
                roundsDispatched: 0,
                lastDispatchedAt: null,
              },
            },
          } satisfies Extract<OrchestrationEvent, { type: "thread.auto-nudge-configured" }>;

          yield* yieldHub;
          const liveShellFiber = yield* Stream.runHead(
            hub.eventsFrom({ fromSequenceExclusive: 0, route: { kind: "shell" } }),
          ).pipe(Effect.forkScoped);
          yield* yieldHub;
          yield* PubSub.publish(live, event);
          const liveShell = Option.getOrThrow(yield* Fiber.join(liveShellFiber));
          expect(liveShell.type).toBe("thread.auto-nudge-summary-changed");
          expect(JSON.stringify(liveShell)).not.toContain("EXACT-THREAD-AUTO-NUDGE-PROMPT");

          const detail = Option.getOrThrow(
            yield* Stream.runHead(
              hub.eventsFrom({
                fromSequenceExclusive: 0,
                route: { kind: "thread", threadId },
              }),
            ),
          );
          expect(detail).toEqual(event);

          const shellReplay = Option.getOrThrow(
            yield* Stream.runHead(
              hub.eventsFrom({ fromSequenceExclusive: 0, route: { kind: "shell" } }),
            ),
          );
          expect(shellReplay.type).toBe("thread.auto-nudge-summary-changed");
          if (shellReplay.type === "thread.auto-nudge-summary-changed") {
            expect(shellReplay.payload.summary).toEqual({
              authorityRevision: 1,
              mode: "steady-progress",
              backgroundContinuation: false,
              maxRounds: 5,
              armedAt: "2026-08-11T00:00:00.000Z",
              baselineSettledTurnId: null,
              lastDispatchedSettledTurnId: null,
              lastDispatchedMessageId: null,
              roundsDispatched: 0,
              lastDispatchedAt: null,
            });
          }
          expect(JSON.stringify(shellReplay)).not.toContain("EXACT-THREAD-AUTO-NUDGE-PROMPT");
        }),
      ),
    );
  });

  it("keeps manual follow-up items exact-thread-only while shell receives the count", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const live = yield* PubSub.unbounded<OrchestrationEvent>();
          const engine: OrchestrationEngineShape = {
            readEvents: () => Stream.empty,
            dispatch: () => Effect.die("unused"),
            diagnosticsSnapshot: Effect.die("unused"),
            streamDomainEvents: Stream.fromPubSub(live),
          };
          const hub = yield* makeOrchestrationSubscriptionHub({
            orchestrationEngine: engine,
            initialCursor: 0,
            pollInterval: Duration.hours(1),
          });
          const threadId = ThreadId.make("thread-manual-follow-up-target");
          const reservationCommandId = CommandId.make("command-manual-follow-up-reserve");
          const enqueued = {
            sequence: 1,
            eventId: EventId.make("event-manual-follow-up-enqueued"),
            type: "thread.manual-follow-up-enqueued",
            aggregateKind: "thread",
            aggregateId: threadId,
            occurredAt: "2026-08-11T00:00:00.000Z",
            commandId: CommandId.make("command-manual-follow-up-enqueued"),
            causationEventId: null,
            correlationId: CommandId.make("command-manual-follow-up-enqueued"),
            metadata: {},
            payload: {
              threadId,
              item: {
                id: ManualFollowUpId.make("manual-follow-up-secret"),
                message: {
                  messageId: MessageId.make("manual-follow-up-message-secret"),
                  role: "user",
                  text: "EXACT-THREAD-MANUAL-PROMPT",
                  attachments: [],
                },
                dispatch: {
                  modelSelection: {
                    instanceId: ProviderInstanceId.make("codex"),
                    model: "gpt-5.6-sol",
                  },
                  titleSeed: "Target thread",
                  runtimeMode: "full-access",
                  interactionMode: "default",
                },
                status: "queued",
                reservationCommandId,
                enqueuedAt: "2026-08-11T00:00:00.000Z",
                activatedAt: null,
                activationCommandId: null,
              },
            },
          } satisfies Extract<OrchestrationEvent, { type: "thread.manual-follow-up-enqueued" }>;
          const countChanged = {
            sequence: 2,
            eventId: EventId.make("event-manual-follow-up-count"),
            type: "thread.manual-follow-up-count-changed",
            aggregateKind: "thread",
            aggregateId: threadId,
            occurredAt: "2026-08-11T00:00:00.000Z",
            commandId: CommandId.make("command-manual-follow-up-count"),
            causationEventId: enqueued.eventId,
            correlationId: CommandId.make("command-manual-follow-up-enqueued"),
            metadata: {},
            payload: {
              threadId,
              count: 1,
              updatedAt: "2026-08-11T00:00:00.000Z",
            },
          } satisfies Extract<
            OrchestrationEvent,
            { type: "thread.manual-follow-up-count-changed" }
          >;

          yield* yieldHub;
          yield* PubSub.publish(live, enqueued);
          yield* PubSub.publish(live, countChanged);
          yield* yieldHub;

          const detail = Option.getOrThrow(
            yield* Stream.runHead(
              hub.eventsFrom({
                fromSequenceExclusive: 0,
                route: { kind: "thread", threadId },
              }),
            ),
          );
          expect(detail).toEqual(enqueued);

          const shell = Option.getOrThrow(
            yield* Stream.runHead(
              hub.eventsFrom({ fromSequenceExclusive: 0, route: { kind: "shell" } }),
            ),
          );
          expect(shell).toEqual(countChanged);
          expect(JSON.stringify(shell)).not.toContain("EXACT-THREAD-MANUAL-PROMPT");
        }),
      ),
    );
  });

  it("coalesces only replaceable updates and preserves protected barriers", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const live = yield* PubSub.unbounded<OrchestrationEvent>();
          const engine: OrchestrationEngineShape = {
            readEvents: () => Stream.empty,
            dispatch: () => Effect.die("unused"),
            diagnosticsSnapshot: Effect.die("unused"),
            streamDomainEvents: Stream.fromPubSub(live),
          };
          const hub = yield* makeOrchestrationSubscriptionHub({
            orchestrationEngine: engine,
            initialCursor: 0,
            pollInterval: Duration.hours(1),
          });
          yield* yieldHub;
          const pull = yield* Stream.toPull(
            hub.eventsFrom({
              fromSequenceExclusive: 0,
              route: { kind: "thread", threadId: ThreadId.make("thread-1") },
            }),
          );
          const initialPull = yield* Effect.forkChild(pull);
          yield* Effect.yieldNow;
          yield* PubSub.publish(
            live,
            makeMessageEvent({
              sequence: 1,
              threadId: "thread-1",
              messageId: "initial",
              text: "initial",
              streaming: false,
            }),
          );
          yield* Fiber.join(initialPull);

          for (const event of [
            makeMessageEvent({
              sequence: 2,
              threadId: "thread-1",
              messageId: "stream",
              text: "a",
              streaming: true,
            }),
            makeMessageEvent({
              sequence: 3,
              threadId: "thread-1",
              messageId: "stream",
              text: "latest-before-barrier",
              streaming: true,
            }),
            makeMessageEvent({
              sequence: 4,
              threadId: "thread-1",
              messageId: "protected",
              text: "protected",
              streaming: false,
            }),
            makeMessageEvent({
              sequence: 5,
              threadId: "thread-1",
              messageId: "stream",
              text: "after",
              streaming: true,
            }),
            makeMessageEvent({
              sequence: 6,
              threadId: "thread-1",
              messageId: "stream",
              text: "latest-after-barrier",
              streaming: true,
            }),
          ]) {
            yield* PubSub.publish(live, event);
          }
          yield* yieldHub;

          const delivered: number[] = [];
          for (let index = 0; index < 3; index += 1) {
            const chunk = yield* pull;
            const event = Array.from(chunk)[0];
            if (event !== undefined) delivered.push(event.sequence);
          }

          expect(delivered).toEqual([3, 4, 6]);
          expect((yield* hub.diagnosticsSnapshot).coalescedEventCount).toBe(2);
        }),
      ),
    );
  });

  it("disconnects one slow subscriber without preventing ring replay for a healthy one", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const live = yield* PubSub.unbounded<OrchestrationEvent>();
          const engine: OrchestrationEngineShape = {
            readEvents: () => Stream.empty,
            dispatch: () => Effect.die("unused"),
            diagnosticsSnapshot: Effect.die("unused"),
            streamDomainEvents: Stream.fromPubSub(live),
          };
          const hub = yield* makeOrchestrationSubscriptionHub({
            orchestrationEngine: engine,
            initialCursor: 0,
            pollInterval: Duration.hours(1),
          });
          yield* yieldHub;
          const slowPull = yield* Stream.toPull(
            hub.eventsFrom({
              fromSequenceExclusive: 0,
              route: { kind: "thread", threadId: ThreadId.make("thread-slow") },
            }),
          );
          const initialPull = yield* Effect.forkChild(slowPull);
          yield* Effect.yieldNow;
          yield* PubSub.publish(
            live,
            makeMessageEvent({
              sequence: 1,
              threadId: "thread-slow",
              messageId: "message-1",
              text: "one",
              streaming: false,
            }),
          );
          yield* Fiber.join(initialPull);

          for (let sequence = 2; sequence <= 520; sequence += 1) {
            yield* PubSub.publish(
              live,
              makeMessageEvent({
                sequence,
                threadId: "thread-slow",
                messageId: `message-${sequence}`,
                text: `message ${sequence}`,
                streaming: false,
              }),
            );
          }
          yield* yieldHub;

          const diagnostics = yield* hub.diagnosticsSnapshot;
          expect(diagnostics.slowSubscriberCloseCount).toBe(1);
          expect(diagnostics.activeThreadSubscriptions).toBe(0);

          const healthyReplay = yield* hub
            .eventsFrom({
              fromSequenceExclusive: 510,
              route: { kind: "thread", threadId: ThreadId.make("thread-slow") },
            })
            .pipe(Stream.take(10), Stream.runCollect);
          expect(Array.from(healthyReplay, (event) => event.sequence)).toEqual([
            511, 512, 513, 514, 515, 516, 517, 518, 519, 520,
          ]);
        }),
      ),
    );
  });
});
