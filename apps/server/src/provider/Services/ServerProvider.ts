import type { ServerProvider } from "@cafecode/contracts";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import type { ProviderMaintenanceCapabilities } from "../providerMaintenance.ts";

export interface ServerProviderShape {
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly getSnapshot: Effect.Effect<ServerProvider>;
  readonly refresh: Effect.Effect<ServerProvider>;
  /**
   * Refresh account-scoped usage metadata without executing the provider's
   * binary health/authentication probes. Providers that do not expose a
   * bounded usage-only path omit this capability.
   */
  readonly refreshAccountUsage?: Effect.Effect<ServerProvider>;
  readonly streamChanges: Stream.Stream<ServerProvider>;
}
