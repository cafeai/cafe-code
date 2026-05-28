import type { ThreadId } from "@cafecode/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import {
  ThreadDetailSubscriptionRegistry,
  type ThreadDetailSubscriptionRegistryShape,
} from "../Services/ThreadDetailSubscriptionRegistry.ts";

interface SubscriptionEntry {
  readonly subscriberCount: number;
  readonly noSubscribersSinceMs: number | null;
}

const makeThreadDetailSubscriptionRegistry = Effect.gen(function* () {
  const startedAtMs = yield* Clock.currentTimeMillis;
  const state = yield* Ref.make(new Map<ThreadId, SubscriptionEntry>());

  const retain: ThreadDetailSubscriptionRegistryShape["retain"] = (threadId) =>
    Ref.update(state, (current) => {
      const next = new Map(current);
      const entry = next.get(threadId);
      next.set(threadId, {
        subscriberCount: (entry?.subscriberCount ?? 0) + 1,
        noSubscribersSinceMs: null,
      });
      return next;
    });

  const release: ThreadDetailSubscriptionRegistryShape["release"] = (threadId) =>
    Effect.gen(function* () {
      const releasedAtMs = yield* Clock.currentTimeMillis;
      yield* Ref.update(state, (current) => {
        const entry = current.get(threadId);
        if (entry === undefined || entry.subscriberCount <= 0) {
          return current;
        }

        const next = new Map(current);
        const subscriberCount = entry.subscriberCount - 1;
        next.set(threadId, {
          subscriberCount,
          noSubscribersSinceMs: subscriberCount === 0 ? releasedAtMs : entry.noSubscribersSinceMs,
        });
        return next;
      });
    });

  const snapshot: ThreadDetailSubscriptionRegistryShape["snapshot"] = (threadId) =>
    Ref.get(state).pipe(
      Effect.map(
        (current) =>
          current.get(threadId) ?? {
            subscriberCount: 0,
            // Upstream Codex starts the no-subscriber timer when the app-server
            // first observes no listeners for the loaded thread. Cafe's backend
            // only knows subscriptions that happened during this process
            // lifetime, so an unseen thread is treated as no-subscriber since
            // backend startup rather than immediately eligible for teardown.
            noSubscribersSinceMs: startedAtMs,
          },
      ),
    );

  return {
    retain,
    release,
    snapshot,
  } satisfies ThreadDetailSubscriptionRegistryShape;
});

export const ThreadDetailSubscriptionRegistryLive = Layer.effect(
  ThreadDetailSubscriptionRegistry,
  makeThreadDetailSubscriptionRegistry,
);
