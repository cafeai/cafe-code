import { UsageAccountingSnapshot, type ProviderDriverKind } from "@cafecode/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

type AuxiliaryUsageSink = (
  provider: ProviderDriverKind,
  snapshot: UsageAccountingSnapshot,
  observedAtMs: number,
) => Effect.Effect<void>;

export interface AuxiliaryUsageShape {
  /** The one usage accumulator installs its sink after hydration finishes. */
  readonly installSink: (sink: AuxiliaryUsageSink) => Effect.Effect<void>;
  /** Await ledger acknowledgement, without making generation retry on failure. */
  readonly record: AuxiliaryUsageSink;
}

/**
 * A runtime-scoped bridge, not a global publisher or a second usage ledger.
 * Provider factories are constructed before UsageStatsService, which itself
 * consumes ProviderService. This small dependency lets factories capture a
 * publisher without creating that circular initialization dependency. Isolated
 * provider/test runtimes may omit it; the main server provides one shared layer.
 */
export class AuxiliaryUsage extends Context.Service<AuxiliaryUsage, AuxiliaryUsageShape>()(
  "cafecode/usageStats/Services/AuxiliaryUsage",
) {}

export const AuxiliaryUsageLive = Layer.effect(
  AuxiliaryUsage,
  Effect.gen(function* () {
    const sink = yield* Deferred.make<AuxiliaryUsageSink>();
    const decodeSnapshot = Schema.decodeEffect(UsageAccountingSnapshot);
    return {
      installSink: (handler) => Deferred.succeed(sink, handler).pipe(Effect.asVoid),
      record: (provider, snapshot, observedAtMs) =>
        Effect.gen(function* () {
          const validated = yield* decodeSnapshot(snapshot);
          const handler = yield* Deferred.await(sink);
          yield* handler(provider, validated, observedAtMs);
        }).pipe(
          // Missing initialization or a stalled ledger must not hold a helper
          // open indefinitely or turn a completed paid request into a retry.
          // Neither diagnostics path includes provider output, model metadata,
          // account identity, paths, or the underlying exception/cause.
          Effect.timeoutOption(1_000),
          Effect.flatMap((result) =>
            Option.isNone(result)
              ? Effect.logWarning("usage stats: auxiliary accounting acknowledgement timed out")
              : Effect.void,
          ),
          Effect.catchCause(() =>
            Effect.logWarning(
              "usage stats: auxiliary accounting observation could not be acknowledged",
            ),
          ),
        ),
    } satisfies AuxiliaryUsageShape;
  }),
);
