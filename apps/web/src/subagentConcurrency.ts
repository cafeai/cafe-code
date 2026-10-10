import type {
  ProviderDriverKind,
  ProviderInstanceId,
  SubagentLimits,
  ServerSettings,
} from "@cafecode/contracts";

/** Provider-native controls have different semantics; never share their remembered choice. */
export function subagentLimitKey(provider: ProviderDriverKind | string): "codex" | "claude" | null {
  return provider === "codex" ? "codex" : provider === "claudeAgent" ? "claude" : null;
}

export function validSubagentLimit(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 64;
}

/** Reset removes only this driver. An empty object is intentional durable reset, not omission. */
export function withSubagentLimit(
  current: SubagentLimits | undefined,
  provider: ProviderDriverKind,
  value: number | undefined,
): SubagentLimits {
  const key = subagentLimitKey(provider);
  if (key === null) return current ?? {};
  if (value !== undefined && !validSubagentLimit(value)) throw new RangeError("Enter 1–64.");
  const next = { ...current };
  delete next[key];
  if (value !== undefined) next[key] = value;
  return next;
}

export function subagentLimitsEqual(
  left: SubagentLimits | undefined,
  right: SubagentLimits | undefined,
) {
  // Absence and an explicit empty reset are different wire instructions.
  return (
    left === right ||
    (left !== undefined &&
      right !== undefined &&
      left.codex === right.codex &&
      left.claude === right.claude)
  );
}

/** Legacy runtime fallback remains separate from the live account preference. */
export function configuredInstanceSubagentLimit(
  settings: ServerSettings,
  instanceId: ProviderInstanceId,
): number | undefined {
  const envelope = settings.providerInstances?.[instanceId];
  const legacy =
    instanceId === "codex"
      ? settings.providers.codex
      : instanceId === "claudeAgent"
        ? settings.providers.claudeAgent
        : undefined;
  const config = envelope?.config ?? legacy;
  if (config === null || typeof config !== "object") return undefined;
  const value = (config as Record<string, unknown>).maxConcurrentSubagents;
  return validSubagentLimit(value) ? value : undefined;
}

export interface InheritedSubagentPolicy {
  readonly limit: number | undefined;
  readonly source:
    | "Account default"
    | "Legacy instance configuration"
    | "Provider / inherited default";
}

/**
 * Resolve only the selected account. The mutable account preference is not
 * copied into chat metadata: an absent/reset chat policy keeps inheriting it.
 * Disabled, missing and wrong-driver envelopes cannot lend numeric authority
 * to another account. Legacy built-in slots retain their existing fallback.
 */
export function inheritedInstanceSubagentPolicy(
  settings: ServerSettings,
  instanceId: ProviderInstanceId,
  provider: ProviderDriverKind | string,
): InheritedSubagentPolicy {
  const unknown = { limit: undefined, source: "Provider / inherited default" } as const;
  if (subagentLimitKey(provider) === null) return unknown;
  const envelope = settings.providerInstances?.[instanceId];
  if (envelope) {
    if (envelope.enabled === false || envelope.driver !== provider) return unknown;
    if (validSubagentLimit(envelope.defaultMaxConcurrentSubagents)) {
      return { limit: envelope.defaultMaxConcurrentSubagents, source: "Account default" };
    }
  } else if (instanceId !== provider) {
    return unknown;
  } else {
    const legacy = provider === "codex" ? settings.providers.codex : settings.providers.claudeAgent;
    if (!legacy.enabled) return unknown;
  }
  const limit = configuredInstanceSubagentLimit(settings, instanceId);
  return limit === undefined ? unknown : { limit, source: "Legacy instance configuration" };
}

/** Exact current settings plus durable chat intent, used at every send boundary. */
export function effectiveSubagentLimit(input: {
  readonly settings: ServerSettings;
  readonly instanceId: ProviderInstanceId;
  readonly provider: ProviderDriverKind | string;
  readonly limits: SubagentLimits | undefined;
}): number | undefined {
  const key = subagentLimitKey(input.provider);
  return key === null
    ? undefined
    : (input.limits?.[key] ??
        inheritedInstanceSubagentPolicy(input.settings, input.instanceId, input.provider).limit);
}

export interface SubagentConcurrencyPresentation {
  readonly requested: number | undefined;
  readonly configured: number | null | undefined;
  readonly source:
    | "Chat override"
    | "Account default"
    | "Legacy instance configuration"
    | "Provider / inherited default";
  readonly pending: boolean;
}

/**
 * Compact configured → requested transition, never a native-enforcement claim.
 * "When idle" is deliberately not "next turn": live children can keep the
 * replacement fenced across turns. Unrecorded process evidence stays unknown.
 */
export function formatSubagentConcurrencyLimit(
  presentation: SubagentConcurrencyPresentation | null | undefined,
): string | null {
  if (!presentation) return null;
  const { requested, configured, pending } = presentation;
  if (pending && configured !== undefined) {
    return `Subagent limit: ${configured ?? "Provider default"} → ${requested ?? "Provider default"} when idle`;
  }
  if (requested === undefined) return null;
  return `Subagent limit: ${requested}${configured === undefined ? " · saved" : ""}`;
}

export function deriveSubagentConcurrencyPresentation(input: {
  readonly provider: ProviderDriverKind | string;
  readonly limits: SubagentLimits | undefined;
  readonly inheritedLimit: number | undefined;
  readonly inheritedSource?: InheritedSubagentPolicy["source"];
  readonly configuredLimit: number | null | undefined;
}): SubagentConcurrencyPresentation | null {
  const key = subagentLimitKey(input.provider);
  if (key === null) return null;
  const override = input.limits?.[key];
  const requested = override ?? input.inheritedLimit;
  return {
    requested,
    configured: input.configuredLimit,
    source:
      override !== undefined
        ? "Chat override"
        : input.inheritedLimit !== undefined
          ? (input.inheritedSource ?? "Legacy instance configuration")
          : "Provider / inherited default",
    // A numeric value is Cafe's configured override, not proof that the native
    // provider admits that many agents. Older snapshots remain explicitly unknown.
    pending: input.configuredLimit !== undefined && (requested ?? null) !== input.configuredLimit,
  };
}
