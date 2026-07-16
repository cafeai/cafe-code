import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
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
