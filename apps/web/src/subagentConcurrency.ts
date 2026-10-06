import type {
  ProviderDriverKind,
  ProviderInstanceId,
  SubagentLimits,
  UnifiedSettings,
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

/** Legacy configuration remains a runtime fallback, never the new-chat default editor's target. */
export function configuredInstanceSubagentLimit(
  settings: UnifiedSettings,
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

export interface SubagentConcurrencyPresentation {
  readonly requested: number | undefined;
  readonly configured: number | null | undefined;
  readonly source:
    | "Chat override"
    | "Legacy instance configuration"
    | "Provider / inherited default";
  readonly pending: boolean;
}

/**
 * Show the saved numeric choice immediately, including while a session still
 * uses its previous policy. An inherited provider default has no known number.
 * The label describes a setting, not independently verified native enforcement.
 */
export function formatSubagentConcurrencyLimit(
  presentation: SubagentConcurrencyPresentation | null | undefined,
): string | null {
  return presentation?.requested === undefined ? null : `Subagent limit: ${presentation.requested}`;
}

export function deriveSubagentConcurrencyPresentation(input: {
  readonly provider: ProviderDriverKind | string;
  readonly limits: SubagentLimits | undefined;
  readonly inheritedLimit: number | undefined;
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
          ? "Legacy instance configuration"
          : "Provider / inherited default",
    // A numeric value is Cafe's configured override, not proof that the native
    // provider admits that many agents. Older snapshots remain explicitly unknown.
    pending: input.configuredLimit !== undefined && (requested ?? null) !== input.configuredLimit,
  };
}
