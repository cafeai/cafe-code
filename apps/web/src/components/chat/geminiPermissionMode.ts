import type { ProviderInteractionMode, RuntimeMode } from "@cafecode/contracts";

/** Cafe's full-access carrier leaves the CLI's own permission policy in place. */
export function usesGeminiCliPermissions(
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
): boolean {
  return runtimeMode === "full-access" && interactionMode === "default";
}
