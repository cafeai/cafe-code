import type { ServerProvider, ServerProviderAccountRateLimits } from "@cafecode/contracts";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import type { ProviderMaintenanceCapabilities } from "../providerMaintenance.ts";

export interface ServerProviderShape {
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly getSnapshot: Effect.Effect<ServerProvider>;
  /**
   * Read only the snapshot already owned by this exact provider scope. Unlike
   * getSnapshot, this must not inspect settings, launch a probe, enrich metadata,
   * or mutate state. Registry delivery uses it to avoid replaying an older
   * direct/stream copy after a newer catalogue has already been published.
   * Legacy providers omit it and retain their existing delivery semantics.
   */
  readonly getCurrentSnapshot?: Effect.Effect<ServerProvider>;
  readonly refresh: Effect.Effect<ServerProvider>;
  /**
   * Refresh account-scoped usage metadata without executing the provider's
   * binary health/authentication probes. Providers that do not expose a
   * bounded usage-only path omit this capability.
   */
  readonly refreshAccountUsage?: Effect.Effect<ServerProvider>;
  readonly setAccountUsage?: (
    rateLimits: ServerProviderAccountRateLimits,
  ) => Effect.Effect<ServerProvider>;
  /**
   * Refresh only the provider-owned model catalogue. This deliberately omits
   * installation, authentication, account-usage, and skills probes so a
   * picker-open parity refresh cannot turn into an expensive provider health
   * check. Providers without a bounded model-list API omit this capability.
   */
  readonly refreshModels?: Effect.Effect<ServerProvider>;
  readonly streamChanges: Stream.Stream<ServerProvider>;
}
