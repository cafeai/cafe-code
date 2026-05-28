import type { ThreadId } from "@cafecode/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface ThreadDetailSubscriptionSnapshot {
  readonly subscriberCount: number;
  readonly noSubscribersSinceMs: number | null;
}

export interface ThreadDetailSubscriptionRegistryShape {
  readonly retain: (threadId: ThreadId) => Effect.Effect<void>;
  readonly release: (threadId: ThreadId) => Effect.Effect<void>;
  readonly snapshot: (threadId: ThreadId) => Effect.Effect<ThreadDetailSubscriptionSnapshot>;
}

export class ThreadDetailSubscriptionRegistry extends Context.Service<
  ThreadDetailSubscriptionRegistry,
  ThreadDetailSubscriptionRegistryShape
>()("cafecode/orchestration/Services/ThreadDetailSubscriptionRegistry") {}
