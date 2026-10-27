import {
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderOptionSelection,
  type ScopedThreadRef,
  type ServerProviderModel,
} from "@cafecode/contracts";
import {
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
  getProviderOptionStringSelectionValue,
  isClaudeUltrathinkPrompt,
} from "@cafecode/shared/model";
import type { ReactNode } from "react";

import type { DraftId } from "../../composerDraftStore";
import { getProviderModelCapabilities } from "../../providerModels";
import {
  getTraitsTriggerLabel,
  shouldRenderTraitsControls,
  TraitsMenuContent,
  TraitsPicker,
} from "./TraitsPicker";

export type ComposerProviderStateInput = {
  provider: ProviderDriverKind;
  model: string;
  models: ReadonlyArray<ServerProviderModel>;
  prompt: string;
  modelOptions: ReadonlyArray<ProviderOptionSelection> | null | undefined;
};

export type ComposerProviderState = {
  provider: ProviderDriverKind;
  promptEffort: string | null;
  traitsTriggerLabel: string | null;
  modelOptionsForDispatch: ReadonlyArray<ProviderOptionSelection> | undefined;
  composerFrameClassName?: string;
  composerSurfaceClassName?: string;
  modelPickerIconClassName?: string;
};

type TraitsRenderInput = {
  provider: ProviderDriverKind;
  providerInstanceId: ProviderInstanceId;
  threadRef?: ScopedThreadRef;
  draftId?: DraftId;
  model: string;
  models: ReadonlyArray<ServerProviderModel>;
  modelOptions: ReadonlyArray<ProviderOptionSelection> | undefined;
  section?: "model" | "daybreak";
  prompt: string;
  onPromptChange: (prompt: string) => void;
};

/** A model switch can turn Daybreak off, but never select a different enabled level. */
export function getModelOptionsForModelChange(
  input: Omit<ComposerProviderStateInput, "prompt">,
): ReadonlyArray<ProviderOptionSelection> | undefined {
  const options = input.modelOptions ?? undefined;
  const program = getProviderOptionStringSelectionValue(options, "cyberAccessProgram");
  if (input.provider !== "codex" || (program !== "daybreakBlue" && program !== "daybreakRed")) {
    return options;
  }
  const descriptor = getProviderModelCapabilities(
    input.models,
    input.model,
    input.provider,
  ).optionDescriptors?.find((entry) => entry.id === "cyberAccessProgram");
  if (descriptor !== undefined) {
    // A program-only model has no Off choice. Keep the saved level for
    // explicit correction rather than enabling a different program.
    if (
      descriptor.type !== "select" ||
      descriptor.options.some((option) => option.id === program) ||
      !descriptor.options.some((option) => option.id === "standard")
    ) {
      return options;
    }
  }
  return options?.map((option) =>
    option.id === "cyberAccessProgram" ? { ...option, value: "standard" } : option,
  );
}

export function getComposerProviderState(input: ComposerProviderStateInput): ComposerProviderState {
  const { provider, model, models, prompt, modelOptions } = input;
  const caps = getProviderModelCapabilities(models, model, provider);
  const descriptors = getProviderOptionDescriptors({ caps, selections: modelOptions });
  const primarySelectDescriptor = descriptors.find(
    (descriptor): descriptor is Extract<(typeof descriptors)[number], { type: "select" }> =>
      descriptor.type === "select",
  );
  const primaryValue = getProviderOptionCurrentValue(primarySelectDescriptor ?? null);
  const promptEffort = typeof primaryValue === "string" ? primaryValue : null;
  const ultrathinkActive =
    (primarySelectDescriptor?.promptInjectedValues?.length ?? 0) > 0 &&
    isClaudeUltrathinkPrompt(prompt);
  const traitsTriggerLabel = getTraitsTriggerLabel(
    descriptors,
    primarySelectDescriptor ?? null,
    ultrathinkActive,
  );
  const dispatchOptions = buildProviderOptionSelectionsFromDescriptors(descriptors);
  const retainedDaybreak =
    provider === "codex"
      ? modelOptions?.find((option) => option.id === "cyberAccessProgram")
      : undefined;

  return {
    provider,
    promptEffort,
    traitsTriggerLabel: traitsTriggerLabel || null,
    // A disappeared entitlement must reach server validation, not silently
    // erase an explicit On/Off choice and fall back to provider auto-routing.
    modelOptionsForDispatch:
      retainedDaybreak && !descriptors.some((entry) => entry.id === "cyberAccessProgram")
        ? [...(dispatchOptions ?? []), retainedDaybreak]
        : dispatchOptions,
    ...(ultrathinkActive
      ? {
          composerFrameClassName: "ultrathink-frame",
          composerSurfaceClassName: "shadow-[0_0_0_1px_rgba(255,255,255,0.04)_inset]",
          modelPickerIconClassName: "ultrathink-chroma",
        }
      : {}),
  };
}

function renderTraitsControl(
  Component: typeof TraitsMenuContent | typeof TraitsPicker,
  input: TraitsRenderInput,
): ReactNode {
  const {
    provider,
    providerInstanceId,
    threadRef,
    draftId,
    model,
    models,
    modelOptions,
    prompt,
    onPromptChange,
    section = "all",
  } = input;
  const hasTarget = threadRef !== undefined || draftId !== undefined;
  if (
    !hasTarget ||
    !shouldRenderTraitsControls({ provider, models, model, modelOptions, prompt, section })
  ) {
    return null;
  }
  return (
    <Component
      provider={provider}
      providerInstanceId={providerInstanceId}
      models={models}
      {...(threadRef ? { threadRef } : {})}
      {...(draftId ? { draftId } : {})}
      model={model}
      modelOptions={modelOptions}
      section={section}
      prompt={prompt}
      onPromptChange={onPromptChange}
    />
  );
}

export function renderProviderTraitsMenuContent(input: TraitsRenderInput): ReactNode {
  return renderTraitsControl(TraitsMenuContent, input);
}

export function renderProviderTraitsPicker(input: TraitsRenderInput): ReactNode {
  return renderTraitsControl(TraitsPicker, input);
}
