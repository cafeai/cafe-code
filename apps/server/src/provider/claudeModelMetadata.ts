import type {
  ModelCapabilities,
  ProviderOptionDescriptor,
  ServerProviderModel,
} from "@cafecode/contracts";
import { createModelCapabilities } from "@cafecode/shared/model";

export interface ClaudeNativeModel {
  readonly value: string;
  readonly resolvedModel?: string;
  readonly displayName: string;
  readonly supportedEffortLevels?: ReadonlyArray<string>;
  readonly supportsEffort?: boolean;
  readonly supportsFastMode?: boolean;
  readonly supportsAutoMode?: boolean;
}
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
function clean(value: unknown, max: number): value is string {
  if (typeof value !== "string" || value.length > max || !value.trim()) return false;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return false;
  }
  return true;
}
const canonical = (value: string) => value.replace(/\[1m\]$/, "");

/** Native initialization is already fetched by the existing admitted probe.
 * Bound and allowlist its model metadata; never trigger an extra query, infer
 * availability from an alias omission, or forward arbitrary option values.
 * https://code.claude.com/docs/en/agent-sdk/typescript#modelinfo
 */
export function normalizeClaudeNativeModels(
  value: unknown,
): ReadonlyArray<ClaudeNativeModel> | undefined {
  if (!Array.isArray(value) || value.length > 128) return undefined;
  const models: ClaudeNativeModel[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || !clean(raw.value, 256) || !clean(raw.displayName, 256))
      continue;
    if (raw.resolvedModel !== undefined && !clean(raw.resolvedModel, 256)) continue;
    if (models.some((model) => model.value === raw.value)) continue;
    const levels =
      Array.isArray(raw.supportedEffortLevels) && raw.supportedEffortLevels.length <= 8
        ? EFFORTS.filter((effort) => raw.supportedEffortLevels.includes(effort))
        : undefined;
    models.push({
      value: raw.value,
      displayName: raw.displayName,
      ...(raw.resolvedModel ? { resolvedModel: raw.resolvedModel } : {}),
      ...(typeof raw.supportsEffort === "boolean" ? { supportsEffort: raw.supportsEffort } : {}),
      ...(typeof raw.supportsFastMode === "boolean"
        ? { supportsFastMode: raw.supportsFastMode }
        : {}),
      ...(typeof raw.supportsAutoMode === "boolean"
        ? { supportsAutoMode: raw.supportsAutoMode }
        : {}),
      ...(levels?.length ? { supportedEffortLevels: levels } : {}),
    });
  }
  return models.length ? models : undefined;
}

export function findClaudeNativeModel(
  models: ReadonlyArray<ClaudeNativeModel> | undefined,
  slug: string,
): ClaudeNativeModel | undefined {
  return (
    models?.find((model) => canonical(model.value) === canonical(slug)) ??
    models?.find(
      (model) => model.resolvedModel && canonical(model.resolvedModel) === canonical(slug),
    )
  );
}

export function reconcileClaudeModelCapabilities(
  caps: ModelCapabilities,
  native: ClaudeNativeModel | undefined,
): ModelCapabilities {
  if (!native) return caps;
  let descriptors: ProviderOptionDescriptor[] = [...(caps.optionDescriptors ?? [])];
  if (native.supportsEffort === false)
    descriptors = descriptors.filter((item) => item.id !== "effort");
  else if (native.supportedEffortLevels) {
    const prior = descriptors.find((item) => item.id === "effort" && item.type === "select");
    const levels = native.supportedEffortLevels;
    const current =
      prior?.type === "select" &&
      typeof prior.currentValue === "string" &&
      levels.includes(prior.currentValue)
        ? prior.currentValue
        : levels.includes("high")
          ? "high"
          : levels[0]!;
    const injected =
      prior?.type === "select"
        ? prior.options.filter((option) => prior.promptInjectedValues?.includes(option.id))
        : [];
    descriptors = descriptors.filter((item) => item.id !== "effort");
    descriptors.push({
      id: "effort",
      label: "Reasoning",
      type: "select",
      currentValue: current,
      options: [
        ...levels.map((id) =>
          Object.assign(
            {
              id,
              label: id === "xhigh" ? "Extra High" : id[0]!.toUpperCase() + id.slice(1),
            },
            id === current ? { isDefault: true } : {},
          ),
        ),
        ...injected,
      ],
      ...(injected.length ? { promptInjectedValues: injected.map((option) => option.id) } : {}),
    });
  }
  if (native.supportsFastMode === false)
    descriptors = descriptors.filter((item) => item.id !== "fastMode");
  else if (native.supportsFastMode === true && !descriptors.some((item) => item.id === "fastMode"))
    descriptors.push({ id: "fastMode", label: "Fast Mode", type: "boolean" });
  return createModelCapabilities({
    ...caps,
    optionDescriptors: descriptors,
    ...(native.supportsAutoMode !== undefined ? { supportsAutoMode: native.supportsAutoMode } : {}),
  });
}

export function reconcileClaudeModels(
  models: ReadonlyArray<ServerProviderModel>,
  native: ReadonlyArray<ClaudeNativeModel> | undefined,
  fallback: ModelCapabilities,
): ReadonlyArray<ServerProviderModel> {
  if (!native) return models;
  const reconciled = models.map((model) => ({
    ...model,
    capabilities: reconcileClaudeModelCapabilities(
      model.capabilities ?? fallback,
      findClaudeNativeModel(native, model.slug),
    ),
  }));
  for (const model of native) {
    // A native alias resolving to an existing explicit row is metadata for that
    // row, not a duplicate picker entry. Unlisted historical/custom IDs remain
    // available: supportedModels() is a picker, not an exhaustive access list.
    if (
      reconciled.some(
        (row) =>
          row.slug === model.value || row.slug === model.resolvedModel?.replace(/\[1m\]$/, ""),
      )
    )
      continue;
    reconciled.push({
      slug: model.value,
      name: model.displayName,
      isCustom: false,
      capabilities: reconcileClaudeModelCapabilities(fallback, model),
    });
  }
  return reconciled;
}
