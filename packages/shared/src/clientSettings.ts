import { type ClientSettings, type ClientSettingsPatch } from "@cafecode/contracts";

/**
 * Client settings patches are field-level preference replacements. Nested maps
 * such as model preferences are small and intentionally replaced as a whole so
 * every connected client observes the same canonical value.
 */
export function applyClientSettingsPatch(
  current: ClientSettings,
  patch: ClientSettingsPatch,
): ClientSettings {
  return {
    ...current,
    ...patch,
  };
}
