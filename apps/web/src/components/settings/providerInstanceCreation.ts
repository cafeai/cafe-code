import {
  DEFAULT_LM_STUDIO_BASE_URL,
  type ProviderDriverKind,
  type ProviderInstanceConfig,
} from "@cafecode/contracts";

import { normalizeProviderAccentColor } from "../../providerInstances";

export const LM_STUDIO_PROVIDER_TEMPLATE_ID = "lmstudio" as const;
export const LM_STUDIO_LOCAL_DISPLAY_NAME = "LM Studio Local" as const;
export type ProviderCreationTemplateId = ProviderDriverKind | typeof LM_STUDIO_PROVIDER_TEMPLATE_ID;

function slugifyLabel(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
}

export function deriveProviderCreationInstanceId(
  templateId: ProviderCreationTemplateId,
  driver: ProviderDriverKind,
  label: string,
): string {
  const slug = slugifyLabel(label);
  if (templateId === LM_STUDIO_PROVIDER_TEMPLATE_ID) {
    return slug.length === 0 || slug === "lm_studio" ? "lmstudio" : `lmstudio_${slug}`;
  }
  return slug ? `${driver}_${slug}` : "";
}

export function buildProviderCreationConfig(input: {
  readonly templateId: ProviderCreationTemplateId;
  readonly driver: ProviderDriverKind;
  readonly label: string;
  readonly accentColor: string;
  readonly config: Readonly<Record<string, unknown>>;
}): ProviderInstanceConfig {
  const lmStudio = input.templateId === LM_STUDIO_PROVIDER_TEMPLATE_ID;
  const requestedLabel = input.label.trim();
  const accentColor = normalizeProviderAccentColor(input.accentColor);
  const config = lmStudio
    ? {
        ...input.config,
        ossMode: true,
        ossBaseUrl:
          typeof input.config.ossBaseUrl === "string"
            ? input.config.ossBaseUrl
            : DEFAULT_LM_STUDIO_BASE_URL,
      }
    : { ...input.config };
  return {
    driver: input.driver,
    enabled: true,
    ...(requestedLabel
      ? { displayName: requestedLabel }
      : lmStudio
        ? { displayName: LM_STUDIO_LOCAL_DISPLAY_NAME }
        : {}),
    ...(accentColor ? { accentColor } : {}),
    ...(Object.keys(config).length > 0 ? { config } : {}),
  };
}

export function validateProviderCreationInstanceId(
  value: string,
  existingIds: ReadonlySet<string>,
): string | null {
  if (value.length === 0) return "Instance ID is required.";
  if (value.length > 64) return "Instance ID must be 64 characters or fewer.";
  if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/u.test(value)) {
    return "Instance ID must start with a letter and use only letters, digits, '-', or '_'.";
  }
  if (existingIds.has(value)) return `An instance named '${value}' already exists.`;
  return null;
}
