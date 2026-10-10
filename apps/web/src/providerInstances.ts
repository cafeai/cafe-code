/**
 * Instance-aware view over the wire `ServerProvider[]`.
 *
 * The wire carries one `ServerProvider` per *configured instance* — the
 * default built-in codex instance, a user-authored `codex_personal`, an
 * unavailable shadow for a fork driver, etc. Legacy UI code collapsed these
 * into a single bucket per built-in driver via `.find((p) => p.driver === kind)`,
 * which silently dropped every custom instance after the first. This module
 * replaces that pattern with `ProviderInstanceEntry[]`, keyed on
 * `ProviderInstanceId`, so the model picker, settings list, and composer
 * can treat built-in and custom instances uniformly.
 *
 * @module providerInstances
 */
import {
  defaultInstanceIdForDriver,
  PROVIDER_DISPLAY_NAMES,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderModel,
  type ServerProviderState,
} from "@cafecode/contracts";

import { formatProviderDriverKindLabel } from "./providerModels";

/**
 * UI-facing projection of one configured provider instance. Carries the
 * snapshot verbatim for callers that need server-side fields we don't
 * hoist here, plus the precomputed `instanceId` / `driverKind` /
 * `displayName` used by every picker and settings view.
 */
export interface ProviderInstanceEntry {
  readonly instanceId: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind;
  readonly displayName: string;
  readonly accentColor?: string | undefined;
  readonly continuationGroupKey?: string | undefined;
  readonly enabled: boolean;
  readonly installed: boolean;
  readonly status: ServerProviderState;
  /**
   * True when this entry is the default instance for its driver kind —
   * i.e. its instance id equals `defaultInstanceIdForDriver(driverKind)`.
   * The settings panel and picker sort defaults before customs.
   */
  readonly isDefault: boolean;
  /** True when `availability === "unavailable"` is absent or "available". */
  readonly isAvailable: boolean;
  readonly snapshot: ServerProvider;
  readonly models: ReadonlyArray<ServerProviderModel>;
}

/**
 * The composer's established exact-account resolution, shared with policy
 * presentation so the rail cannot describe a different account from send.
 * Preserve the existing enabled/driver/continuation candidate filters and
 * explicit unavailable fallback: this extraction does not change routing or
 * assert that an unavailable fallback is eligible for execution.
 */
export function resolveComposerProviderInstance(input: {
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
  readonly activeProvider: ProviderInstanceId | null | undefined;
  readonly sessionInstanceId: ProviderInstanceId | null | undefined;
  readonly threadInstanceId: ProviderInstanceId | null | undefined;
  readonly defaultInstanceId: ProviderInstanceId | null | undefined;
  readonly projectInstanceId: ProviderInstanceId | null | undefined;
  readonly selectedProvider: ProviderDriverKind;
  readonly lockedProvider: ProviderDriverKind | null;
  readonly lockedContinuationGroupKey: string | null;
}): ProviderInstanceId {
  const candidates = [
    input.activeProvider,
    input.sessionInstanceId,
    input.threadInstanceId,
    input.defaultInstanceId,
    input.projectInstanceId,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const match = input.entries.find((entry) => entry.instanceId === candidate && entry.enabled);
    if (!match) continue;
    if (input.lockedProvider && match.driverKind !== input.lockedProvider) continue;
    if (
      input.lockedContinuationGroupKey &&
      match.continuationGroupKey !== input.lockedContinuationGroupKey
    )
      continue;
    return match.instanceId;
  }
  const explicit =
    input.activeProvider ??
    input.sessionInstanceId ??
    input.threadInstanceId ??
    input.projectInstanceId;
  if (explicit) return explicit;
  const byKind = input.entries.find(
    (entry) =>
      entry.enabled &&
      entry.driverKind === input.selectedProvider &&
      (!input.lockedContinuationGroupKey ||
        entry.continuationGroupKey === input.lockedContinuationGroupKey),
  );
  if (byKind) return byKind.instanceId;
  return (
    input.entries.find((entry) => entry.enabled)?.instanceId ??
    input.entries[0]?.instanceId ??
    input.threadInstanceId ??
    input.projectInstanceId ??
    defaultInstanceIdForDriver(ProviderDriverKind.make("codex"))
  );
}

/**
 * Turn an instance id slug into a human-readable label. Splits on `_` / `-`
 * and camelCase boundaries and title-cases each token, so `codex_personal`
 * becomes "Codex Personal" and `myCustomInstance` becomes "My Custom
 * Instance".
 *
 * This is a fallback used only when the wire snapshot's `displayName`
 * doesn't disambiguate a non-default instance from the default one of the
 * same driver (today every built-in driver hard-codes a single presentation
 * label per kind, so two instances of the same kind arrive with identical
 * display names). When a server/driver later plumbs the user's configured
 * `ProviderInstanceConfig.displayName` through to the snapshot, that value
 * will take precedence over this fallback.
 */
function humanizeInstanceId(instanceId: ProviderInstanceId): string {
  return instanceId
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(" ")
    .filter((token) => token.length > 0)
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
    .join(" ");
}

function driverKindLabel(driverKind: ProviderDriverKind): string {
  return PROVIDER_DISPLAY_NAMES[driverKind] ?? formatProviderDriverKindLabel(driverKind);
}

export function normalizeProviderAccentColor(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return /^#[0-9a-fA-F]{6}$/u.test(trimmed) ? trimmed : undefined;
}

/**
 * Resolve an entry's displayName with a tiered priority:
 *
 *   1. A snapshot `displayName` that differs from the driver-kind label —
 *      the server has explicitly named this instance, trust it.
 *   2. For non-default instances, a humanized `instanceId` — the server
 *      fell back to the driver-level presentation constant (which is the
 *      same for every instance of that kind), so we differentiate at the
 *      UI layer by slug. This is what keeps "Codex" + "Codex Personal"
 *      distinguishable in tooltips and list labels today.
 *   3. The snapshot's `displayName` (if any) — default instance, trust
 *      whatever label the driver stamped.
 *   4. `driverKindLabel(driverKind)` — nothing else on hand, so use the
 *      canonical brand label from contracts (falling back to a generic
 *      title-case of the kind slug).
 */
function resolveInstanceDisplayName(
  snapshot: ServerProvider,
  instanceId: ProviderInstanceId,
  driverKind: ProviderDriverKind,
  isDefault: boolean,
): string {
  const trimmedSnapshotName = snapshot.displayName?.trim();
  const kindLabel = driverKindLabel(driverKind);
  if (trimmedSnapshotName && trimmedSnapshotName !== kindLabel) {
    return trimmedSnapshotName;
  }
  if (!isDefault) {
    const humanized = humanizeInstanceId(instanceId);
    if (humanized.length > 0) return humanized;
  }
  return trimmedSnapshotName || kindLabel;
}

/**
 * Project the wire `ServerProvider[]` into instance entries, one per
 * configured instance. Preserves the server's ordering (which sources
 * from `deriveProviderInstanceConfigMap` — explicit `providerInstances.*`
 * first, synthesized defaults after) so callers that want "default first"
 * should sort with `sortProviderInstanceEntries` below.
 */
export function deriveProviderInstanceEntries(
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ProviderInstanceEntry> {
  return providers.map((snapshot) => {
    const instanceId = snapshot.instanceId;
    const driverKind = snapshot.driver;
    const defaultId = defaultInstanceIdForDriver(driverKind);
    const isDefault = instanceId === defaultId;
    const displayName = resolveInstanceDisplayName(snapshot, instanceId, driverKind, isDefault);
    return {
      instanceId,
      driverKind,
      displayName,
      accentColor: normalizeProviderAccentColor(snapshot.accentColor),
      continuationGroupKey: snapshot.continuation?.groupKey,
      enabled: snapshot.enabled,
      installed: snapshot.installed,
      status: snapshot.status,
      isDefault,
      isAvailable: snapshot.availability !== "unavailable",
      snapshot,
      models: snapshot.models,
    } satisfies ProviderInstanceEntry;
  });
}

/**
 * Sort instance entries so the default instance of each driver kind appears
 * before any custom instances of the same kind. Within a kind, custom
 * instances keep their settings-author order (which is how the server
 * emits them). Stable across kinds: entries retain the server's
 * cross-driver ordering.
 */
export function sortProviderInstanceEntries(
  entries: ReadonlyArray<ProviderInstanceEntry>,
): ReadonlyArray<ProviderInstanceEntry> {
  // Group by driver kind preserving first-appearance order, then emit
  // default-first within each kind. Using a Map keeps the "first-seen"
  // semantics for kinds whose default instance is absent (unusual but
  // possible during the migration).
  const byKind = new Map<ProviderDriverKind, ProviderInstanceEntry[]>();
  for (const entry of entries) {
    const bucket = byKind.get(entry.driverKind);
    if (bucket) {
      bucket.push(entry);
    } else {
      byKind.set(entry.driverKind, [entry]);
    }
  }
  const sorted: ProviderInstanceEntry[] = [];
  for (const bucket of byKind.values()) {
    const defaults = bucket.filter((entry) => entry.isDefault);
    const customs = bucket.filter((entry) => !entry.isDefault);
    sorted.push(...defaults, ...customs);
  }
  return sorted;
}

/**
 * Look up a single instance entry by exact `instanceId`. Missing snapshots
 * are not inferred from driver kind in UI routing code.
 */
export function getProviderInstanceEntry(
  providers: ReadonlyArray<ServerProvider>,
  instanceId: ProviderInstanceId,
): ProviderInstanceEntry | undefined {
  return deriveProviderInstanceEntries(providers).find((entry) => entry.instanceId === instanceId);
}

/**
 * Model list for a specific instance. Returns `[]` when the instance isn't
 * present so callers don't have to thread optionality through render code.
 */
export function getProviderInstanceModels(
  providers: ReadonlyArray<ServerProvider>,
  instanceId: ProviderInstanceId,
): ReadonlyArray<ServerProviderModel> {
  return getProviderInstanceEntry(providers, instanceId)?.models ?? [];
}

/**
 * Resolve the routing key for a selection that may reference an instance
 * id that no longer exists (e.g. a persisted thread selection after the
 * user deleted the custom instance). Returns the first enabled instance
 * as a fallback so downstream code can still send a turn.
 */
export function resolveSelectableProviderInstance(
  providers: ReadonlyArray<ServerProvider>,
  instanceId: ProviderInstanceId | undefined,
): ProviderInstanceId | undefined {
  if (instanceId === undefined) {
    return deriveProviderInstanceEntries(providers).find(
      (entry) => entry.enabled && entry.isAvailable,
    )?.instanceId;
  }
  const entries = deriveProviderInstanceEntries(providers);
  const requested = entries.find((entry) => entry.instanceId === instanceId);
  if (requested && requested.enabled && requested.isAvailable) {
    return instanceId;
  }
  return entries.find((entry) => entry.enabled && entry.isAvailable)?.instanceId;
}

/**
 * Resolve an open model-selection routing key back to a driver kind.
 * Custom instance ids such as `claude_openrouter` are not themselves
 * driver-kind slugs, but the composer still needs the owning driver kind
 * for capabilities, options, icons, and turn dispatch metadata.
 */
export function resolveProviderDriverKindForInstanceSelection(
  entries: ReadonlyArray<ProviderInstanceEntry>,
  providers: ReadonlyArray<ServerProvider>,
  selection: ProviderInstanceId | ProviderDriverKind | null | undefined,
): ProviderDriverKind | undefined {
  const matchedEntry = entries.find((entry) => entry.instanceId === selection);
  if (matchedEntry) {
    return matchedEntry.driverKind;
  }
  return undefined;
}
