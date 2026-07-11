import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";
import type { ProviderSessionDirectoryPersistenceError } from "../Errors.ts";

export interface ProviderSessionReaperShape {
  /** Run one complete reconciliation and inactivity sweep. */
  readonly runSweepOnce: Effect.Effect<
    void,
    ProviderSessionDirectoryPersistenceError | ProjectionRepositoryError
  >;
  /**
   * Start the background provider session reaper within the provided scope.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class ProviderSessionReaper extends Context.Service<
  ProviderSessionReaper,
  ProviderSessionReaperShape
>()("cafecode/provider/Services/ProviderSessionReaper") {}
