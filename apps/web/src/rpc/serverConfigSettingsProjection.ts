import type { ServerConfig, ServerConfigSettingsUpdatedPayload } from "@cafecode/contracts";

/**
 * Settings and their derived provider-home presentation form one received
 * observation. Never retain old paths after a legacy/optimistic update that
 * cannot describe the new settings. Omission is unknown, not a guessed profile
 * or permission to recompute a native path in the renderer.
 */
export function projectServerConfigSettings(
  current: ServerConfig,
  update: ServerConfigSettingsUpdatedPayload,
): ServerConfig {
  const { providerDataProfiles: _retired, ...rest } = current;
  return {
    ...rest,
    settings: update.settings,
    ...(update.providerDataProfiles === undefined
      ? {}
      : { providerDataProfiles: update.providerDataProfiles }),
  };
}
