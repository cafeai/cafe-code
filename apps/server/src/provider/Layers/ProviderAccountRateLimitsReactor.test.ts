import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vitest";

import { ProviderRegistry } from "../Services/ProviderRegistry.ts";
import { ProviderService } from "../Services/ProviderService.ts";
import {
  ProviderAccountRateLimitsReactorLive,
  providerAccountRateLimitUpdateFromEvent,
  providerAccountUsageRefreshInstanceFromEvent,
} from "./ProviderAccountRateLimitsReactor.ts";

const settle = Effect.forEach(Array.from({ length: 32 }), () => Effect.yieldNow, {
  discard: true,
});

function makeTurnEvent(input: {
  readonly type: "turn.started" | "turn.completed" | "turn.aborted";
  readonly provider: "codex" | "grok" | "claudeAgent";
  readonly instanceId?: string;
  readonly eventId?: string;
}): ProviderRuntimeEvent {
  const base = {
    eventId: EventId.make(input.eventId ?? `evt-${input.type}`),
    provider: ProviderDriverKind.make(input.provider),
    ...(input.instanceId ? { providerInstanceId: ProviderInstanceId.make(input.instanceId) } : {}),
    threadId: ThreadId.make("thread-usage-refresh"),
    turnId: TurnId.make("turn-usage-refresh"),
    createdAt: "2026-08-16T15:00:00.000Z",
  };
  if (input.type === "turn.completed") {
    return { ...base, type: input.type, payload: { state: "completed" } };
  }
  if (input.type === "turn.aborted") {
    return { ...base, type: input.type, payload: { reason: "interrupted" } };
  }
  return { ...base, type: input.type, payload: {} };
}

describe("providerAccountRateLimitUpdateFromEvent", () => {
  it("routes a live Codex weekly rate-limit notification into the snapshot merge path", () => {
    const event = {
      eventId: EventId.make("evt-rate-limits"),
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      threadId: ThreadId.make("thread-rate-limits"),
      createdAt: "2026-08-12T15:00:00.000Z",
      type: "account.rate-limits.updated",
      payload: {
        rateLimits: {
          rateLimits: {
            limitId: "codex",
            planType: "pro",
            primary: { usedPercent: 1, windowDurationMins: 10_080 },
            secondary: null,
          },
        },
      },
    } as ProviderRuntimeEvent;

    expect(providerAccountRateLimitUpdateFromEvent(event)).toEqual({
      kind: "snapshot",
      instanceId: ProviderInstanceId.make("codex"),
      limitId: "codex",
      snapshot: {
        limitId: "codex",
        planType: "pro",
        primary: { usedPercent: 1, windowDurationMins: 10_080 },
      },
    });
  });
});

describe("providerAccountUsageRefreshInstanceFromEvent", () => {
  it("selects Codex and Grok only after a terminal turn event", () => {
    expect(
      providerAccountUsageRefreshInstanceFromEvent(
        makeTurnEvent({ type: "turn.completed", provider: "grok", instanceId: "grok-work" }),
      ),
    ).toBe(ProviderInstanceId.make("grok-work"));
    expect(
      providerAccountUsageRefreshInstanceFromEvent(
        makeTurnEvent({ type: "turn.aborted", provider: "codex", instanceId: "codex-work" }),
      ),
    ).toBe(ProviderInstanceId.make("codex-work"));
    expect(
      providerAccountUsageRefreshInstanceFromEvent(
        makeTurnEvent({ type: "turn.started", provider: "grok", instanceId: "grok-work" }),
      ),
    ).toBeNull();
    expect(
      providerAccountUsageRefreshInstanceFromEvent(
        makeTurnEvent({
          type: "turn.completed",
          provider: "claudeAgent",
          instanceId: "claude-work",
        }),
      ),
    ).toBeNull();
    expect(
      providerAccountUsageRefreshInstanceFromEvent(
        makeTurnEvent({ type: "turn.completed", provider: "grok" }),
      ),
    ).toBeNull();
  });

  it("refreshes after settlement and throttles duplicate terminal events", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
          const refreshedInstances = yield* Ref.make<ReadonlyArray<ProviderInstanceId>>([]);
          const providerServiceLayer = Layer.mock(ProviderService)({
            streamEvents: Stream.fromPubSub(events),
          });
          const registryLayer = Layer.mock(ProviderRegistry)({
            refreshInstanceAccountUsage: (instanceId: ProviderInstanceId) =>
              Ref.update(refreshedInstances, (current) => [...current, instanceId]).pipe(
                Effect.as([]),
              ),
            updateProviderAccountRateLimits: () => Effect.void,
          });

          yield* Layer.build(
            ProviderAccountRateLimitsReactorLive.pipe(
              Layer.provide(providerServiceLayer),
              Layer.provide(registryLayer),
            ),
          );
          yield* settle;

          yield* PubSub.publish(
            events,
            makeTurnEvent({ type: "turn.started", provider: "grok", instanceId: "grok-work" }),
          );
          yield* settle;
          expect(yield* Ref.get(refreshedInstances)).toEqual([]);

          yield* PubSub.publish(
            events,
            makeTurnEvent({
              type: "turn.completed",
              provider: "grok",
              instanceId: "grok-work",
              eventId: "evt-completed-1",
            }),
          );
          yield* settle;
          expect(yield* Ref.get(refreshedInstances)).toEqual([
            ProviderInstanceId.make("grok-work"),
          ]);

          yield* PubSub.publish(
            events,
            makeTurnEvent({
              type: "turn.completed",
              provider: "grok",
              instanceId: "grok-work",
              eventId: "evt-completed-2",
            }),
          );
          yield* settle;
          expect(yield* Ref.get(refreshedInstances)).toEqual([
            ProviderInstanceId.make("grok-work"),
          ]);
        }),
      ),
    );
  });
});
