import * as Effect from "effect/Effect";
import { McpToolError } from "./results.ts";

export const MAX_STATUS_WAITERS = 8;
let active = 0;

/** Request-scoped admission shared across stateless HTTP MCP servers. Acquire
 * and finalizer registration are interruption-safe; no closed requests or
 * completed observations are retained in a global collection. */
export function withStatusWait<A, E, R>(effect: Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.suspend(() =>
      active >= MAX_STATUS_WAITERS
        ? Effect.fail(
            new McpToolError(
              "capacity",
              "Cafe's bounded status wait capacity is full.",
              "Use one lightweight status read or wait for an existing wait to finish.",
            ),
          )
        : Effect.sync(() => {
            active += 1;
          }),
    ),
    () => effect,
    () =>
      Effect.sync(() => {
        active -= 1;
      }),
  );
}
