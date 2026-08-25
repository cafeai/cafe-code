/**
 * ProviderRuntimeIngestionService - Provider runtime ingestion service interface.
 *
 * Owns background workers that consume provider runtime streams and emit
 * orchestration commands/events.
 *
 * @module ProviderRuntimeIngestionService
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type { ThreadId } from "@cafecode/contracts";

/**
 * ProviderRuntimeIngestionShape - Service API for runtime ingestion lifecycle.
 */
export interface ProviderRuntimeIngestionShape {
  /**
   * Start ingesting provider runtime events into orchestration commands.
   *
   * The returned effect must be run in a scope so all worker fibers can be
   * finalized on shutdown.
   *
   * Uses an internal queue and continues after non-interrupt failures by
   * logging warnings.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /**
   * Resolves when the internal processing queue is empty and idle.
   * Intended for test use to replace timing-sensitive sleeps.
   */
  readonly drain: Effect.Effect<void>;

  /**
   * Permanently fence one thread from provider/domain ingestion in this
   * process, then wait for every item already accepted by the worker to
   * settle. Tombstone lookup keeps the fence effective across restarts.
   */
  readonly retireThreadForHardDelete: (input: {
    readonly threadId: ThreadId;
  }) => Effect.Effect<void>;

  /**
   * Release the short-lived in-process retirement set after the engine has
   * durably installed and purged the tombstoned identity.
   */
  readonly completeThreadHardDelete: (input: {
    readonly threadId: ThreadId;
  }) => Effect.Effect<void>;
}

/**
 * ProviderRuntimeIngestionService - Service tag for runtime ingestion workers.
 */
export class ProviderRuntimeIngestionService extends Context.Service<
  ProviderRuntimeIngestionService,
  ProviderRuntimeIngestionShape
>()("cafecode/orchestration/Services/ProviderRuntimeIngestion/ProviderRuntimeIngestionService") {}
