import type { ModelSelection, ProviderInstanceId, ServerProviderModel } from "@cafecode/contracts";
import { getModelSelectionOptionValue } from "@cafecode/shared/model";

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
