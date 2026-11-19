import type {
  ModelSelection,
  ProviderOptionChoice,
  SelectProviderOptionDescriptor,
  ServerProviderModel,
} from "@cafecode/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { PromptCapabilities, SessionConfigOption } from "effect-acp/schema";
import type { AcpSessionRuntime } from "./AcpSessionRuntime.ts";

type SelectOption = Extract<SessionConfigOption, { readonly type: "select" }>;
type ConfigOptions = ReadonlyArray<SessionConfigOption>;
type SelectionRuntime = Pick<AcpSessionRuntime["Service"], "getConfigOptions" | "setConfigOption">;

const REASONING_OPTION_ID = "reasoningEffort";
const MAX_CONFIG_OPTIONS = 128;
const MAX_CHOICES = 256;
const CONTROL_CHARACTERS = /[\p{Cc}\p{Cf}]/u;

// Only locally sourced selection failures may be rendered in the user’s
// chat. Native JSON-RPC errors use the shared content-free ACP mapping.
export class GeminiAcpSelectionError extends Data.TaggedError("GeminiAcpSelectionError")<{
  readonly issue: string;
}> {}

function validId(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 256 &&
    value === value.trim() &&
    !CONTROL_CHARACTERS.test(value)
  );
}

function displayText(value: string | null | undefined): string | undefined {
  const text = value?.trim();
  return text && text.length <= 512 && !CONTROL_CHARACTERS.test(text) ? text : undefined;
}

function findSelector(
  options: ConfigOptions,
  category: "model" | "thought_level",
  canonicalId: "model" | "thinking_level",
): SelectOption | undefined {
  if (options.length > MAX_CONFIG_OPTIONS) return undefined;
  const candidates = options.filter(
    (option): option is SelectOption =>
      option.type === "select" &&
      (option.category === category || (option.category == null && option.id === canonicalId)),
  );
  const selected = candidates[0];
  if (
    candidates.length !== 1 ||
    !selected ||
    !validId(selected.id) ||
    options.filter((option) => option.id.trim() === selected.id).length !== 1
  ) {
    return undefined;
  }
  return selected;
}

function selectorChoices(option: SelectOption): ReadonlyArray<ProviderOptionChoice> {
  if (option.options.length > MAX_CHOICES) return [];
  const choices: ProviderOptionChoice[] = [];
  const seen = new Set<string>();
  let count = 0;
  for (const entry of option.options) {
    for (const choice of "value" in entry ? [entry] : entry.options) {
      if (++count > MAX_CHOICES) return [];
      if (!validId(choice.value)) continue;
      if (seen.has(choice.value)) return [];
      seen.add(choice.value);
      const description = displayText(choice.description);
      choices.push({
        id: choice.value,
        label: displayText(choice.name) ?? choice.value,
        ...(description !== undefined ? { description } : {}),
      });
    }
  }
  return choices;
}

function activeValue(option: SelectOption | undefined): string | undefined {
  return option && selectorChoices(option).some((choice) => choice.id === option.currentValue)
    ? option.currentValue
    : undefined;
}

export function readGeminiAcpSelection(options: ConfigOptions): {
  readonly model?: string;
  readonly reasoningEffort?: string;
} {
  const model = activeValue(findSelector(options, "model", "model"));
  if (model === undefined) return {};
  const reasoningEffort = activeValue(findSelector(options, "thought_level", "thinking_level"));
  return { model, ...(reasoningEffort !== undefined ? { reasoningEffort } : {}) };
}

const STANDARD_EFFORTS = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
] as const;

// Google's Antigravity model guide and Gemini API thinking table document
// these exact levels. This catalogue hint is only for a model already offered
// by ACP, when its active selector is not observable. No default is marked:
// the composer submits marked defaults, and native openings choose their own.
// https://antigravity.google/docs/models
// https://aistudio.google.com/docs/thinking#thinking-levels
function documentedEfforts(model: string): ReadonlyArray<ProviderOptionChoice> {
  switch (model) {
    case "gemini-4-neon":
    case "gemini-4-hydrogen":
      return [...STANDARD_EFFORTS, { id: "xhigh", label: "Extra" }];
    case "gemini-4-carbon":
    case "gemini-4-argon":
    case "gemini-3.8-flash":
      return STANDARD_EFFORTS;
    default:
      return [];
  }
}

export function buildGeminiAcpModels(
  options: ConfigOptions,
  promptCapabilities?: PromptCapabilities | null,
): ReadonlyArray<ServerProviderModel> {
  const model = findSelector(options, "model", "model");
  if (!model) return [];
  const thinking = findSelector(options, "thought_level", "thinking_level");
  const selected = activeValue(model);
  const currentEffort = activeValue(thinking);
  const liveEfforts = thinking ? selectorChoices(thinking) : [];
  return selectorChoices(model).map((choice) => {
    // The negotiated thought selector belongs to only the active model.
    // In particular, an empty native selector must not become a static menu.
    const current = choice.id === selected;
    const efforts = current ? liveEfforts : documentedEfforts(choice.id);
    const descriptor: SelectProviderOptionDescriptor = {
      type: "select",
      id: REASONING_OPTION_ID,
      label: current ? (displayText(thinking?.name) ?? "Thinking") : "Thinking",
      options: efforts,
      ...(current && currentEffort !== undefined ? { currentValue: currentEffort } : {}),
    };
    return {
      slug: choice.id,
      name: choice.label,
      isCustom: false,
      capabilities: {
        inputModalities: promptCapabilities?.image === true ? ["text", "image"] : ["text"],
        optionDescriptors: efforts.length > 0 ? [descriptor] : [],
      },
    };
  });
}

export const applyGeminiAcpSelection = (
  runtime: SelectionRuntime,
  selection?: Pick<ModelSelection, "model" | "options">,
) =>
  Effect.gen(function* () {
    const selections = selection?.options ?? [];
    const effort = selections[0];
    if (
      selections.length > 1 ||
      (effort && (effort.id !== REASONING_OPTION_ID || typeof effort.value !== "string"))
    ) {
      return yield* new GeminiAcpSelectionError({
        issue: "Invalid Antigravity thinking selection.",
      });
    }

    let options = yield* runtime.getConfigOptions;
    const modelOption = findSelector(options, "model", "model");
    const observed = activeValue(modelOption);
    const model = selection?.model ?? observed;
    if (
      !modelOption ||
      model === undefined ||
      !selectorChoices(modelOption).some((choice) => choice.id === model)
    ) {
      return yield* new GeminiAcpSelectionError({
        issue: "The requested model is not advertised by this Antigravity session.",
      });
    }
    if (observed !== model) {
      const acknowledgement = yield* runtime.setConfigOption(modelOption.id, model);
      if (readGeminiAcpSelection(acknowledgement.configOptions).model !== model) {
        return yield* new GeminiAcpSelectionError({
          issue: "Antigravity did not confirm the requested model.",
        });
      }
      options = yield* runtime.getConfigOptions;
      if (readGeminiAcpSelection(options).model !== model) {
        return yield* new GeminiAcpSelectionError({
          issue: "The active Antigravity model changed.",
        });
      }
    }

    // Validate against the new model's negotiated options, even if a catalogue
    // preview offered more choices. Never send a guessed thinking value.
    const thinking = findSelector(options, "thought_level", "thinking_level");
    const thinkingValue = activeValue(thinking);
    if (!effort) {
      return { model, ...(thinkingValue !== undefined ? { reasoningEffort: thinkingValue } : {}) };
    }
    const value = effort.value;
    if (
      !thinking ||
      typeof value !== "string" ||
      !selectorChoices(thinking).some((choice) => choice.id === value)
    ) {
      return yield* new GeminiAcpSelectionError({
        issue: "The requested thinking level is not advertised for the active Antigravity model.",
      });
    }
    if (thinkingValue !== value) {
      const acknowledgement = yield* runtime.setConfigOption(thinking.id, value);
      const confirmed = readGeminiAcpSelection(acknowledgement.configOptions);
      const active = readGeminiAcpSelection(yield* runtime.getConfigOptions);
      if (
        confirmed.model !== model ||
        confirmed.reasoningEffort !== value ||
        active.model !== model ||
        active.reasoningEffort !== value
      ) {
        return yield* new GeminiAcpSelectionError({
          issue: "Antigravity did not confirm the requested thinking level.",
        });
      }
    }
    return { model, reasoningEffort: value };
  });
