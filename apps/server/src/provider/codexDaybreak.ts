import type {
  ModelSelection,
  ProviderInstanceId,
  SelectProviderOptionDescriptor,
  ServerProviderModel,
} from "@cafecode/contracts";
import { getModelSelectionOptionValue } from "@cafecode/shared/model";
import type { V2TurnStartParams__CyberAccessProgram } from "effect-codex-app-server/schema";

export type CodexCyberAccessProgram = V2TurnStartParams__CyberAccessProgram;

/**
 * Codex 0.159.1/0.162.0 model/list advertises caller-specific accepted programs.
 * Red approval does not make daybreakRed valid on a Blue-only mainline model:
 * https://developers.openai.com/api/docs/guides/daybreak
 * Offer and submit only exact advertised levels, never infer access from a slug.
 */
export function makeCodexDaybreakDescriptor(
  programs: ReadonlyArray<CodexCyberAccessProgram> | undefined,
): SelectProviderOptionDescriptor | undefined {
  const levels = (["daybreakBlue", "daybreakRed"] as const).filter((level) =>
    programs?.includes(level),
  );
  if (levels.length === 0) return undefined;
  const canDisable = programs?.includes("standard") === true;
  return {
    id: "cyberAccessProgram",
    label: "Daybreak",
    type: "select",
    ...(!canDisable
      ? {
          description:
            "This model requires Daybreak. Choose a Standard-capable model to turn it off.",
        }
      : {}),
    options: [
      ...(canDisable ? [{ id: "standard", label: "Off" }] : []),
      ...levels.map((id) => ({ id, label: id === "daybreakBlue" ? "Blue" : "Red" })),
    ],
    // Opening a menu must not opt a user in. A program-only model has no
    // Standard choice; leave its selection unset until explicitly selected.
    ...(canDisable ? { currentValue: "standard" } : {}),
  };
}

export function resolveCodexDaybreak(
  selection: ModelSelection | undefined,
  instanceId: ProviderInstanceId,
  models: ReadonlyArray<ServerProviderModel> | undefined,
): { readonly cyberAccessProgram?: CodexCyberAccessProgram; readonly error?: string } {
  if (selection?.instanceId !== instanceId) return {};
  const raw = getModelSelectionOptionValue(selection, "cyberAccessProgram");
  if (raw === undefined) return {};
  if (raw !== "standard" && raw !== "daybreakBlue" && raw !== "daybreakRed") {
    return { error: "The Daybreak level is invalid. Choose a supported level in model settings." };
  }
  const descriptor = models
    ?.find((model) => model.slug === selection.model)
    ?.capabilities?.optionDescriptors?.find((option) => option.id === "cyberAccessProgram");
  // Standard is the explicit safe escape for ordinary models and older
  // catalogs. A known program-only model cannot accept this selection.
  if (raw === "standard" && descriptor === undefined) return { cyberAccessProgram: raw };
  if (descriptor?.type === "select") {
    if (descriptor.options.some((option) => option.id === raw)) {
      return { cyberAccessProgram: raw };
    }
  }
  return {
    error:
      "This Codex account/model does not support the selected Daybreak setting. Refresh the model list and choose a supported model or setting.",
  };
}
