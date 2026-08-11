import { createHexagonBackground } from "./runtime/portable.js";
import backgroundPreset from "./background-preset.mjs";

export { backgroundPreset };

export async function mountClubCodeHexagonsBackground(options = {}) {
  const {
    useBundledFallingEffects: requestedBundledFallingEffects,
    settings: requestedSettings,
    ...runtimeOptions
  } = options;
  const useBundledFallingEffects = requestedBundledFallingEffects ?? false;
  const settingsOverride = requestedSettings ?? {};
  const settings = {
    ...backgroundPreset.settings,
    enabled: backgroundPreset.activationHints.backgroundEnabled,
    ...settingsOverride,
    fallingEffectsEnabled:
      useBundledFallingEffects &&
      (settingsOverride.fallingEffectsEnabled ?? backgroundPreset.activationHints.fallingEffectsEnabled),
  };
  return createHexagonBackground({ ...runtimeOptions, preset: undefined, settings });
}

export default mountClubCodeHexagonsBackground;
