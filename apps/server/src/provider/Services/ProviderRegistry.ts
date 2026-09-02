/**
 * ProviderRegistry - Provider snapshot service.
 *
 * Owns provider install/auth/version/model snapshots and exposes the latest
 * provider state to transport layers.
 *
 * @module ProviderRegistry
 */
import type {
  ProviderInstanceId,
  ProviderDriverKind,
  ServerProvider,
  ServerProviderAccountRateLimitSnapshot,
  ServerProviderAccountRateLimitWindow,
  ServerProviderUpdateState,
} from "@cafecode/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import type { ProviderMaintenanceCapabilities } from "../providerMaintenance.ts";

export type ProviderMaintenanceActionKind = "update";

export interface ProviderRegistryShape {
  /**
   * Read the latest provider snapshots for every configured instance.
   * Multiple snapshots may share the same `provider` kind (multiple
   * instances of the same driver) and disambiguate via `instanceId`.
   */
  readonly getProviders: Effect.Effect<ReadonlyArray<ServerProvider>>;

  /**
   * Refresh all providers, or the default instance of the specified
   * kind when supplied.
   *
   * Retained for back-compat with legacy call sites (WS refresh RPC,
   * orchestration metrics). New code should prefer `refreshInstance`.
   *
   * @deprecated prefer `refreshInstance` for new call sites.
   */
  readonly refresh: (provider?: ProviderDriverKind) => Effect.Effect<ReadonlyArray<ServerProvider>>;

  /**
   * Refresh the specific configured instance. Returns the updated snapshot
   * list. When the instance id is unknown the call resolves with the
   * currently cached list (no error) — matching the legacy `refresh` shim
   * behaviour so transport layers don't have to special-case unknowns.
   */
  readonly refreshInstance: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ReadonlyArray<ServerProvider>>;

  /**
   * Refresh only account-usage metadata for one provider instance. This is a
   * no-op for providers without a usage-only capability and intentionally
   * never falls back to the provider's full binary health/authentication
   * probe.
   */
  readonly refreshInstanceAccountUsage: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ReadonlyArray<ServerProvider>>;

  /**
   * Refresh only one instance's provider-owned model catalogue. This is a
   * no-op for drivers that do not expose a bounded model-list path and never
   * falls back to a full installation/authentication/account probe.
   */
  readonly refreshInstanceModels?: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ReadonlyArray<ServerProvider>>;

  /**
   * Resolve the maintenance capabilities owned by one live provider instance.
   * Falls back to manual-only capabilities when the instance is not live.
   */
  readonly getProviderMaintenanceCapabilitiesForInstance: (
    instanceId: ProviderInstanceId,
    provider: ProviderDriverKind,
  ) => Effect.Effect<ProviderMaintenanceCapabilities>;

  /**
   * Apply volatile maintenance-action state to one configured instance.
   * This state is never persisted to disk. Today only update actions are
   * projected onto `ServerProvider.updateState`; install/auth actions can
   * extend this action map without adding driver-scoped APIs.
   */
  readonly setProviderMaintenanceActionState: (input: {
    readonly instanceId: ProviderInstanceId;
    readonly action: ProviderMaintenanceActionKind;
    readonly state: ServerProviderUpdateState | null;
  }) => Effect.Effect<ReadonlyArray<ServerProvider>>;

  /**
   * Merge an event-sourced account rate-limit update into one instance's snapshot
   * and republish if it changed. Claude reports one complete window at a time;
   * Codex reports a sparse named snapshot that must be merged into its latest
   * `account/rateLimits/read` result. No-ops when the instance is not tracked.
   */
  readonly updateProviderAccountRateLimits: (
    input:
      | {
          readonly instanceId: ProviderInstanceId;
          readonly slot: "primary" | "secondary";
          readonly window: ServerProviderAccountRateLimitWindow;
          readonly checkedAt: string;
        }
      | {
          readonly instanceId: ProviderInstanceId;
          readonly limitId: string;
          readonly snapshot: ServerProviderAccountRateLimitSnapshot;
          readonly checkedAt: string;
        },
  ) => Effect.Effect<void>;

  /**
   * Stream of provider snapshot updates — one emission per aggregated
   * change. The array contains the full current state.
   */
  readonly streamChanges: Stream.Stream<ReadonlyArray<ServerProvider>>;
}

export class ProviderRegistry extends Context.Service<ProviderRegistry, ProviderRegistryShape>()(
  "cafecode/provider/Services/ProviderRegistry",
) {}
