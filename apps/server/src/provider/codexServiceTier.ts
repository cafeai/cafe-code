import type { ModelSelection, ProviderInstanceId, ServerProviderModel } from "@cafecode/contracts";
import { getModelSelectionOptionValue } from "@cafecode/shared/model";

/** Private, runtime-bound native routing evidence; never a billing receipt. */
export interface CodexServiceTierSnapshot {
  readonly providerThreadId: string;
  readonly serviceTier: string | undefined;
}

export function readCodexServiceTier(value: string | null | undefined): string | undefined {
  // Codex 0.160.0's native config snapshot uses null for standard routing.
  // An omitted experimental field from an older runtime carries no evidence.
  if (value === null) return "default";
  return typeof value === "string" && /^[a-z][a-z0-9_-]{0,63}$/.test(value) ? value : undefined;
}

export function observeCodexServiceTier(input: {
  readonly current: CodexServiceTierSnapshot | undefined;
  readonly providerThreadId: string;
  readonly serviceTier: string | null | undefined;
}): CodexServiceTierSnapshot {
  const serviceTier = readCodexServiceTier(input.serviceTier);
  // Missing/invalid metadata cannot clear matching known native settings.
  if (serviceTier === undefined && input.current?.providerThreadId === input.providerThreadId) {
    return input.current;
  }
  return { providerThreadId: input.providerThreadId, serviceTier };
}

export function resolveCodexTurnServiceTier(input: {
  readonly providerThreadId: string;
  readonly snapshot: CodexServiceTierSnapshot | undefined;
  readonly requestedTier: string | undefined;
}): string | undefined {
  return (
    readCodexServiceTier(input.requestedTier) ??
    (input.snapshot?.providerThreadId === input.providerThreadId
      ? input.snapshot.serviceTier
      : undefined)
  );
}

export function acknowledgeCodexServiceTier(input: {
  readonly current: CodexServiceTierSnapshot | undefined;
  readonly admitted: CodexServiceTierSnapshot | undefined;
  readonly providerThreadId: string;
  readonly requestedTier: string | undefined;
}): CodexServiceTierSnapshot | undefined {
  // A native settings notification is newer than the admitted snapshot. A
  // delayed ACK may retain an explicit choice only if no observation replaced
  // that snapshot; it must never overwrite newer settings or another root.
  if (input.current !== input.admitted || input.requestedTier === undefined) return input.current;
  return observeCodexServiceTier({
    current: input.current,
    providerThreadId: input.providerThreadId,
    serviceTier: input.requestedTier,
  });
}

/** Resolve only this account's selection. Native ids are opaque catalogue
 * values, never aliases or inferred prices. Legacy Fast retains its exact old
 * mapping; explicit modern choices require model-specific catalogue evidence. */
export function resolveCodexServiceTier(
  selection: ModelSelection | undefined,
  instanceId: ProviderInstanceId,
  models: ReadonlyArray<ServerProviderModel> | undefined,
): { readonly serviceTier?: string; readonly error?: string } {
  if (selection?.instanceId !== instanceId) return {};
  const raw = getModelSelectionOptionValue(selection, "serviceTier");
  const fast = getModelSelectionOptionValue(selection, "fastMode");
  if (raw === undefined && typeof fast !== "boolean") return {};
  const tier = raw ?? (fast ? "priority" : "default");
  if (typeof tier !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(tier)) {
    return {
      error: "The selected Codex service tier is invalid. Choose an available service tier.",
    };
  }
  if (tier === "default") return { serviceTier: tier };
  const descriptor = models
    ?.find((model) => model.slug === selection.model)
    ?.capabilities?.optionDescriptors?.find((option) => option.id === "serviceTier");
  if (descriptor?.type === "select" && descriptor.options.some((option) => option.id === tier)) {
    return { serviceTier: tier };
  }
  // Cached legacy fallback catalogues predate the advertised-tier descriptor.
  // Preserve old saved Fast semantics, but never infer new-tier eligibility
  // from those fallback rows or another model's/account's capabilities.
  if (raw === undefined && descriptor === undefined) return { serviceTier: tier };
  return {
    error:
      "This Codex model/account no longer advertises the selected service tier. Refresh the model list and choose an available tier.",
  };
}
