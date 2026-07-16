import {
  OrchestrationGetSnapshotError,
  type OrchestrationEvent,
  type ThreadId,
} from "@cafecode/contracts";
import {
  encodedJsonByteLength,
  PROVIDER_PIPELINE_POLICY,
} from "@cafecode/shared/providerPipelinePolicy";
import { setProviderSubscriptionDiagnostics } from "@cafecode/shared/providerPipelineDiagnostics";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import type { OrchestrationEngineShape } from "./OrchestrationEngine.ts";
import { classifyOutboundOrchestrationEvent } from "../outboundEventPolicy.ts";

export type OrchestrationSubscriptionRoute =
  | { readonly kind: "shell" }
  | { readonly kind: "thread"; readonly threadId: ThreadId };

export interface OrchestrationSubscriptionHubSnapshot {
  readonly cursor: number;
  readonly replayRingEvents: number;
  readonly replayRingBytes: number;
  readonly activeShellSubscriptions: number;
  readonly activeThreadSubscriptions: number;
  readonly tailReadCount: number;
  readonly tailEventCount: number;
  readonly slowSubscriberCloseCount: number;
  readonly durableCatchupCount: number;
  readonly coalescedEventCount: number;
}

export interface OrchestrationSubscriptionHubShape {
  readonly eventsFrom: (input: {
    readonly fromSequenceExclusive: number;
    readonly route: OrchestrationSubscriptionRoute;
  }) => Stream.Stream<OrchestrationEvent, OrchestrationGetSnapshotError>;
  readonly diagnosticsSnapshot: Effect.Effect<OrchestrationSubscriptionHubSnapshot>;
}

interface QueuedEvent {
  event: OrchestrationEvent;
  bytes: number;
  readonly replaceableKey: string | null;
}

interface Subscriber {
  readonly id: number;
  readonly route: OrchestrationSubscriptionRoute;
  readonly queue: Queue.Dequeue<QueuedEvent> & Queue.Enqueue<QueuedEvent>;
  queuedBytes: number;
  overflowed: boolean;
  coalescingEpoch: number;
  readonly pendingReplaceable: Map<string, QueuedEvent>;
}

function isThreadDetailEvent(event: OrchestrationEvent): boolean {
  return (
    event.type === "thread.message-sent" ||
    event.type === "thread.message.assistant-repair-applied" ||
    event.type === "thread.proposed-plan-upserted" ||
    event.type === "thread.activity-appended" ||
    event.type === "thread.turn-diff-completed" ||
    event.type === "thread.reverted" ||
    event.type === "thread.session-set"
  );
}

function doesActivityAffectShell(event: OrchestrationEvent): boolean {
  if (event.type !== "thread.activity-appended") return true;
  switch (event.payload.activity.kind) {
    case "approval.requested":
    case "approval.resolved":
    case "provider.approval.respond.failed":
    case "user-input.requested":
    case "user-input.resolved":
    case "provider.user-input.respond.failed":
      return true;
    default:
      return false;
  }
}

function eventMatchesRoute(
  event: OrchestrationEvent,
  route: OrchestrationSubscriptionRoute,
): boolean {
  if (route.kind === "thread") {
    return (
      event.aggregateKind === "thread" &&
      event.aggregateId === route.threadId &&
      isThreadDetailEvent(event)
    );
  }
  if (
    event.type === "thread.message-sent" &&
    event.payload.role === "assistant" &&
    event.payload.streaming
  ) {
    return false;
  }
  return doesActivityAffectShell(event);
}

function subscriptionError(): OrchestrationGetSnapshotError {
  return new OrchestrationGetSnapshotError({
    message: "Subscription fell behind its bounded replay window; reload the snapshot",
    cause: "subscription-resync-required",
  });
}

export const makeOrchestrationSubscriptionHub = (options: {
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly initialCursor: number;
  readonly pollInterval?: Duration.Duration;
}): Effect.Effect<OrchestrationSubscriptionHubShape, never, Scope.Scope> =>
  Effect.gen(function* () {
    const orchestrationEngine = options.orchestrationEngine;
    const subscribers = new Map<number, Subscriber>();
    const replayRing: QueuedEvent[] = [];
    let replayRingBytes = 0;
    let cursor = Math.max(0, Math.trunc(options.initialCursor));
    let nextSubscriberId = 1;
    let tailReadCount = 0;
    let tailEventCount = 0;
    let slowSubscriberCloseCount = 0;
    let durableCatchupCount = 0;
    let coalescedEventCount = 0;

    const updateSubscriptionDiagnostics = (): void => {
      setProviderSubscriptionDiagnostics({
        cursor,
        replayRingEvents: replayRing.length,
        replayRingBytes,
        activeShellSubscribers: Array.from(subscribers.values()).filter(
          (subscriber) => subscriber.route.kind === "shell",
        ).length,
        activeThreadSubscribers: Array.from(subscribers.values()).filter(
          (subscriber) => subscriber.route.kind === "thread",
        ).length,
        durableTailReadCount: tailReadCount,
        durableEventCount: tailEventCount,
        catchupReadCount: durableCatchupCount,
        slowSubscriberCloseCount,
        coalescedEventCount,
      });
    };

    const publish = (event: OrchestrationEvent): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (event.sequence <= cursor) return;
        cursor = event.sequence;
        tailEventCount += 1;
        const bytes = encodedJsonByteLength(event);
        const queued = { event, bytes, replaceableKey: null } satisfies QueuedEvent;

        if (bytes <= PROVIDER_PIPELINE_POLICY.subscriptionReplayMaxBytes) {
          replayRing.push(queued);
          replayRingBytes += bytes;
          while (
            replayRing.length > PROVIDER_PIPELINE_POLICY.subscriptionReplayMaxEvents ||
            replayRingBytes > PROVIDER_PIPELINE_POLICY.subscriptionReplayMaxBytes
          ) {
            const removed = replayRing.shift();
            if (removed === undefined) break;
            replayRingBytes = Math.max(0, replayRingBytes - removed.bytes);
          }
        }

        for (const subscriber of Array.from(subscribers.values())) {
          if (!eventMatchesRoute(event, subscriber.route)) continue;
          const classification = classifyOutboundOrchestrationEvent(event);
          const replaceableKey =
            classification.kind === "replaceable"
              ? `${subscriber.coalescingEpoch}:${classification.key}`
              : null;
          const previous =
            replaceableKey === null ? undefined : subscriber.pendingReplaceable.get(replaceableKey);
          if (previous !== undefined) {
            const nextQueuedBytes = subscriber.queuedBytes - previous.bytes + bytes;
            if (nextQueuedBytes > PROVIDER_PIPELINE_POLICY.subscriptionQueueMaxBytes) {
              subscriber.overflowed = true;
              subscribers.delete(subscriber.id);
              slowSubscriberCloseCount += 1;
              yield* Queue.shutdown(subscriber.queue);
              continue;
            }
            subscriber.queuedBytes = nextQueuedBytes;
            previous.event = event;
            previous.bytes = bytes;
            coalescedEventCount += 1;
            continue;
          }
          if (
            subscriber.queuedBytes + bytes > PROVIDER_PIPELINE_POLICY.subscriptionQueueMaxBytes ||
            (yield* Queue.size(subscriber.queue)) >=
              PROVIDER_PIPELINE_POLICY.subscriptionQueueMaxEvents
          ) {
            subscriber.overflowed = true;
            subscribers.delete(subscriber.id);
            slowSubscriberCloseCount += 1;
            yield* Queue.shutdown(subscriber.queue);
            continue;
          }
          const subscriberEntry: QueuedEvent = { event, bytes, replaceableKey };
          const accepted = yield* Queue.offer(subscriber.queue, subscriberEntry);
          if (accepted) {
            subscriber.queuedBytes += bytes;
            if (replaceableKey !== null) {
              subscriber.pendingReplaceable.set(replaceableKey, subscriberEntry);
            } else {
              // Never move a later replaceable update across a protected event.
              subscriber.coalescingEpoch += 1;
            }
          }
        }
        updateSubscriptionDiagnostics();
      });

    const tailCursorRef = yield* Ref.make(cursor);
    const readAndAdvanceCursor = Ref.get(tailCursorRef).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          tailReadCount += 1;
        }),
      ),
      Effect.flatMap((fromSequence) =>
        Stream.runCollect(orchestrationEngine.readEvents(fromSequence)).pipe(
          Effect.map((chunk) => Array.from(chunk)),
        ),
      ),
      Effect.flatMap((events) =>
        Ref.modify(tailCursorRef, (currentSequence) => {
          const freshEvents = events.filter((event) => event.sequence > currentSequence);
          const nextSequence = freshEvents.at(-1)?.sequence ?? currentSequence;
          return [freshEvents, nextSequence] as const;
        }),
      ),
      Effect.catchCause((_cause) =>
        Effect.logWarning("shared orchestration tail read failed", {
          category: "orchestration-event-store-read-failed",
        }).pipe(Effect.as([] as OrchestrationEvent[])),
      ),
    );
    const liveStream = orchestrationEngine.streamDomainEvents.pipe(
      Stream.mapEffect((event) =>
        Ref.modify(tailCursorRef, (currentSequence) => {
          if (event.sequence <= currentSequence) {
            return [Option.none<OrchestrationEvent>(), currentSequence] as const;
          }
          return [Option.some(event), event.sequence] as const;
        }),
      ),
      Stream.flatMap((event) => (Option.isSome(event) ? Stream.make(event.value) : Stream.empty)),
    );
    yield* liveStream.pipe(Stream.runForEach(publish), Effect.forkScoped);
    yield* readAndAdvanceCursor.pipe(
      Effect.flatMap((events) => Effect.forEach(events, publish, { discard: true })),
      Effect.andThen(Effect.sleep(options.pollInterval ?? Duration.seconds(1))),
      Effect.forever,
      Effect.forkScoped,
    );

    const eventsFrom: OrchestrationSubscriptionHubShape["eventsFrom"] = (input) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const queue = yield* Queue.dropping<QueuedEvent>(
            PROVIDER_PIPELINE_POLICY.subscriptionQueueMaxEvents,
          );
          const subscriber: Subscriber = {
            id: nextSubscriberId,
            route: input.route,
            queue,
            queuedBytes: 0,
            overflowed: false,
            coalescingEpoch: 0,
            pendingReplaceable: new Map(),
          };
          nextSubscriberId += 1;

          const registration = yield* Effect.acquireRelease(
            Effect.sync(() => {
              const capturedCursor = cursor;
              const oldestRingSequence = replayRing[0]?.event.sequence ?? capturedCursor + 1;
              const ringEvents = replayRing.filter(
                (entry) =>
                  entry.event.sequence > input.fromSequenceExclusive &&
                  entry.event.sequence <= capturedCursor &&
                  eventMatchesRoute(entry.event, input.route),
              );
              subscribers.set(subscriber.id, subscriber);
              updateSubscriptionDiagnostics();
              return { capturedCursor, oldestRingSequence, ringEvents };
            }),
            () =>
              Effect.sync(() => {
                subscribers.delete(subscriber.id);
                updateSubscriptionDiagnostics();
              }).pipe(Effect.andThen(Queue.shutdown(queue))),
          );

          const needsDurableCatchup =
            input.fromSequenceExclusive < registration.oldestRingSequence - 1;
          if (needsDurableCatchup) durableCatchupCount += 1;
          updateSubscriptionDiagnostics();
          const replay = needsDurableCatchup
            ? orchestrationEngine.readEvents(input.fromSequenceExclusive).pipe(
                Stream.takeWhile((event) => event.sequence <= registration.capturedCursor),
                Stream.filter((event) => eventMatchesRoute(event, input.route)),
                Stream.mapError(
                  (cause) =>
                    new OrchestrationGetSnapshotError({
                      message: "Failed to catch up orchestration subscription",
                      cause,
                    }),
                ),
              )
            : Stream.fromIterable(registration.ringEvents.map((entry) => entry.event));

          const live = Stream.fromQueue(queue).pipe(
            Stream.mapEffect((entry) =>
              Effect.sync(() => {
                subscriber.queuedBytes = Math.max(0, subscriber.queuedBytes - entry.bytes);
                if (
                  entry.replaceableKey !== null &&
                  subscriber.pendingReplaceable.get(entry.replaceableKey) === entry
                ) {
                  subscriber.pendingReplaceable.delete(entry.replaceableKey);
                }
                updateSubscriptionDiagnostics();
                return entry.event;
              }),
            ),
          );
          const overflowSignal = Stream.suspend(() =>
            subscriber.overflowed ? Stream.fail(subscriptionError()) : Stream.empty,
          );
          return Stream.concat(replay, Stream.concat(live, overflowSignal));
        }),
      );

    const diagnosticsSnapshot = Effect.sync((): OrchestrationSubscriptionHubSnapshot => {
      const snapshot = {
        cursor,
        replayRingEvents: replayRing.length,
        replayRingBytes,
        activeShellSubscriptions: Array.from(subscribers.values()).filter(
          (subscriber) => subscriber.route.kind === "shell",
        ).length,
        activeThreadSubscriptions: Array.from(subscribers.values()).filter(
          (subscriber) => subscriber.route.kind === "thread",
        ).length,
        tailReadCount,
        tailEventCount,
        slowSubscriberCloseCount,
        durableCatchupCount,
        coalescedEventCount,
      };
      updateSubscriptionDiagnostics();
      return snapshot;
    });

    return { eventsFrom, diagnosticsSnapshot };
  });
