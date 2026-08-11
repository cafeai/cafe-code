import {
  DEFAULT_AMBIENT_COLOR,
  DEFAULT_AMBIENT_OPACITY,
  DEFAULT_FALLING_EFFECT_DENSITY,
  DEFAULT_FALLING_EFFECT_JAPANESE_RATIO,
  DEFAULT_FALLING_EFFECT_KIND,
  DEFAULT_FALLING_EFFECT_MATRIX_COLOR_MODE,
  DEFAULT_FALLING_EFFECT_SPEED,
  DEFAULT_FALLING_EFFECTS_ENABLED,
  DEFAULT_HEXAGONS_BACKGROUND_ENABLED,
  DEFAULT_HEXAGONS_BACKGROUND_PRESET_JSON,
  MAX_AMBIENT_OPACITY,
  MAX_FALLING_EFFECT_DENSITY,
  MAX_FALLING_EFFECT_JAPANESE_RATIO,
  MAX_FALLING_EFFECT_SPEED,
  MIN_AMBIENT_OPACITY,
  MIN_FALLING_EFFECT_DENSITY,
  MIN_FALLING_EFFECT_JAPANESE_RATIO,
  MIN_FALLING_EFFECT_SPEED,
} from "@cafecode/contracts/settings";
import { useMemo, useRef, useState } from "react";

import {
  parseStoredHexagonsBackground,
  readHexagonsBackgroundFile,
} from "../../hexagonsBackgroundPreset";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { useServerConfig } from "../../rpc/serverState";
import {
  clampAtmosphereDensitySetting,
  clampAtmosphereJapanesePercentSetting,
  clampAtmosphereOpacityPercentSetting,
  clampAtmosphereSpeedSetting,
} from "../../windowAtmosphereSettings";
import { Button } from "../ui/button";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { Radio, RadioGroup } from "../ui/radio-group";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { ColorWheelPicker } from "./ColorWheelPicker";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";

const DEFAULT_ATMOSPHERE_PICKER_COLOR = "#38bdf8";

export function WindowAtmosphereSettings() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const backgroundFileInputRef = useRef<HTMLInputElement | null>(null);
  const [backgroundImportBusy, setBackgroundImportBusy] = useState(false);
  const hexagonsBackground = useMemo(
    () => parseStoredHexagonsBackground(settings.hexagonsBackgroundPresetJson),
    [settings.hexagonsBackgroundPresetJson],
  );
  const serverConfig = useServerConfig();
  const atmosphereAvailable = serverConfig?.ambientExperienceCapabilities.atmosphere === true;
  const hasNonDefaultValue =
    settings.hexagonsBackgroundEnabled !== DEFAULT_HEXAGONS_BACKGROUND_ENABLED ||
    settings.hexagonsBackgroundPresetJson !== DEFAULT_HEXAGONS_BACKGROUND_PRESET_JSON ||
    settings.fallingEffectsEnabled !== DEFAULT_FALLING_EFFECTS_ENABLED ||
    settings.fallingEffectKind !== DEFAULT_FALLING_EFFECT_KIND ||
    settings.fallingEffectColor !== DEFAULT_AMBIENT_COLOR ||
    settings.fallingEffectMatrixColorMode !== DEFAULT_FALLING_EFFECT_MATRIX_COLOR_MODE ||
    settings.fallingEffectOpacity !== DEFAULT_AMBIENT_OPACITY ||
    settings.fallingEffectSpeed !== DEFAULT_FALLING_EFFECT_SPEED ||
    settings.fallingEffectDensity !== DEFAULT_FALLING_EFFECT_DENSITY ||
    settings.fallingEffectJapaneseRatio !== DEFAULT_FALLING_EFFECT_JAPANESE_RATIO;
  const controlsEnabled = atmosphereAvailable && settings.fallingEffectsEnabled;

  const importHexagonsBackground = async (file: File) => {
    setBackgroundImportBusy(true);
    try {
      const imported = await readHexagonsBackgroundFile(file);
      updateSettings({ hexagonsBackgroundPresetJson: imported.serialized });
      toastManager.add(
        stackedThreadToast({ type: "success", title: "Background preset imported" }),
      );
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Background was not imported",
          description: error instanceof Error ? error.message : "Choose a valid .hexbg.json file.",
        }),
      );
    } finally {
      setBackgroundImportBusy(false);
      if (backgroundFileInputRef.current) backgroundFileInputRef.current.value = "";
    }
  };

  const removeHexagonsBackground = () => {
    updateSettings({
      hexagonsBackgroundEnabled: false,
      hexagonsBackgroundPresetJson: null,
    });
    toastManager.add(stackedThreadToast({ type: "success", title: "Background preset removed" }));
  };

  return (
    <SettingsSection title="Window atmosphere">
      <SettingsRow
        title="The Hexagons background"
        description="Show an imported .hexbg.json design behind Cafe Code. Cafe Code keeps control of falling effects and motion safety."
        status={
          hexagonsBackground ? (
            <span className="text-muted-foreground">
              Imported preset: {hexagonsBackground.document.name}
            </span>
          ) : (
            <span className="text-muted-foreground">
              Import a preset before you turn on this background.
            </span>
          )
        }
        control={
          <Switch
            checked={settings.hexagonsBackgroundEnabled && hexagonsBackground !== null}
            disabled={hexagonsBackground === null || backgroundImportBusy}
            onCheckedChange={(checked) =>
              updateSettings({ hexagonsBackgroundEnabled: Boolean(checked) })
            }
            aria-label="Show imported The Hexagons background"
          />
        }
      />

      <SettingsRow
        title="Background preset"
        description="Create and edit the preset in The Hexagons. Cafe Code imports the finished design."
        control={
          <div className="flex flex-wrap justify-end gap-2">
            <input
              ref={backgroundFileInputRef}
              className="sr-only"
              type="file"
              accept=".hexbg.json,application/json"
              aria-label="Import The Hexagons background preset"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                if (file) void importHexagonsBackground(file);
              }}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={backgroundImportBusy}
              onClick={() => backgroundFileInputRef.current?.click()}
            >
              {hexagonsBackground ? "Replace preset" : "Import preset"}
            </Button>
            {hexagonsBackground ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={backgroundImportBusy}
                onClick={removeHexagonsBackground}
              >
                Remove preset
              </Button>
            ) : null}
          </div>
        }
      />

      <SettingsRow
        title="Falling effects"
        description="Let snow, rain, or Matrix characters drift across the whole Cafe Code window."
        status={
          atmosphereAvailable ? null : (
            <span className="text-amber-600 dark:text-amber-400">
              This server has not enabled the window atmosphere capability.
            </span>
          )
        }
        resetAction={
          hasNonDefaultValue ? (
            <SettingResetButton
              label="window atmosphere"
              onClick={() =>
                updateSettings({
                  hexagonsBackgroundEnabled: DEFAULT_HEXAGONS_BACKGROUND_ENABLED,
                  hexagonsBackgroundPresetJson: DEFAULT_HEXAGONS_BACKGROUND_PRESET_JSON,
                  fallingEffectsEnabled: DEFAULT_FALLING_EFFECTS_ENABLED,
                  fallingEffectKind: DEFAULT_FALLING_EFFECT_KIND,
                  fallingEffectColor: DEFAULT_AMBIENT_COLOR,
                  fallingEffectMatrixColorMode: DEFAULT_FALLING_EFFECT_MATRIX_COLOR_MODE,
                  fallingEffectOpacity: DEFAULT_AMBIENT_OPACITY,
                  fallingEffectSpeed: DEFAULT_FALLING_EFFECT_SPEED,
                  fallingEffectDensity: DEFAULT_FALLING_EFFECT_DENSITY,
                  fallingEffectJapaneseRatio: DEFAULT_FALLING_EFFECT_JAPANESE_RATIO,
                })
              }
            />
          ) : null
        }
        control={
          <Switch
            checked={settings.fallingEffectsEnabled}
            disabled={!atmosphereAvailable}
            onCheckedChange={(checked) =>
              updateSettings({ fallingEffectsEnabled: Boolean(checked) })
            }
            aria-label="Show falling effects"
          />
        }
      />

      {controlsEnabled ? (
        <SettingsRow
          title="Effect"
          description="Choose what falls through the window."
          control={
            <RadioGroup
              value={settings.fallingEffectKind}
              onValueChange={(value) => {
                if (value === "snow" || value === "rain" || value === "matrix") {
                  updateSettings({ fallingEffectKind: value });
                }
              }}
              aria-label="Falling effect"
              className="flex-row gap-4"
            >
              {(
                [
                  ["snow", "Snow"],
                  ["rain", "Rain"],
                  ["matrix", "Matrix"],
                ] as const
              ).map(([value, label]) => (
                <label
                  key={value}
                  className="flex cursor-pointer items-center gap-1.5 text-xs font-medium"
                >
                  <Radio value={value} />
                  <span>{label}</span>
                </label>
              ))}
            </RadioGroup>
          }
        />
      ) : null}

      {controlsEnabled && settings.fallingEffectKind === "matrix" ? (
        <>
          <SettingsRow
            title="Matrix color mode"
            description="Rainbow Extra gives every falling stream its own deterministic color phase."
            control={
              <RadioGroup
                value={settings.fallingEffectMatrixColorMode}
                onValueChange={(value) => {
                  if (value === "fixed" || value === "rainbow" || value === "rainbow-extra") {
                    updateSettings({ fallingEffectMatrixColorMode: value });
                  }
                }}
                aria-label="Matrix color mode"
                className="flex-row flex-wrap gap-4"
              >
                {(
                  [
                    ["fixed", "Fixed"],
                    ["rainbow", "Rainbow"],
                    ["rainbow-extra", "Rainbow Extra"],
                  ] as const
                ).map(([value, label]) => (
                  <label
                    key={value}
                    className="flex cursor-pointer items-center gap-1.5 text-xs font-medium"
                  >
                    <Radio value={value} />
                    <span>{label}</span>
                  </label>
                ))}
              </RadioGroup>
            }
          />
          <SettingsRow
            title="Roman / Japanese mix"
            description="At 0%, streams use Roman glyphs. At 100%, they use Japanese glyphs."
            control={
              <div className="flex items-center gap-2">
                <NumberField
                  value={Math.round(settings.fallingEffectJapaneseRatio * 100)}
                  min={Math.round(MIN_FALLING_EFFECT_JAPANESE_RATIO * 100)}
                  max={Math.round(MAX_FALLING_EFFECT_JAPANESE_RATIO * 100)}
                  step={5}
                  size="sm"
                  className="w-28"
                  onValueChange={(value) =>
                    updateSettings({
                      fallingEffectJapaneseRatio: clampAtmosphereJapanesePercentSetting(value),
                    })
                  }
                >
                  <NumberFieldGroup>
                    <NumberFieldDecrement aria-label="Decrease Japanese stream ratio" />
                    <NumberFieldInput aria-label="Japanese stream ratio percent" />
                    <NumberFieldIncrement aria-label="Increase Japanese stream ratio" />
                  </NumberFieldGroup>
                </NumberField>
                <span className="text-xs text-muted-foreground">%</span>
              </div>
            }
          />
        </>
      ) : null}

      <SettingsRow
        title={
          settings.fallingEffectKind === "matrix" &&
          settings.fallingEffectMatrixColorMode !== "fixed"
            ? "Fixed / fallback color"
            : "Effect color"
        }
        description="Use an automatic theme-aware color, or pick your own."
        control={
          <fieldset
            disabled={!controlsEnabled}
            className="flex items-center gap-2 disabled:opacity-60"
          >
            <Button
              type="button"
              size="xs"
              variant="outline"
              aria-pressed={settings.fallingEffectColor === "auto"}
              onClick={() => updateSettings({ fallingEffectColor: "auto" })}
            >
              Auto
            </Button>
            <ColorWheelPicker
              value={
                settings.fallingEffectColor === "auto"
                  ? DEFAULT_ATMOSPHERE_PICKER_COLOR
                  : settings.fallingEffectColor
              }
              defaultPickerColor={DEFAULT_ATMOSPHERE_PICKER_COLOR}
              emptyValue={DEFAULT_ATMOSPHERE_PICKER_COLOR}
              ariaLabel="Falling effect color"
              onCommit={(value) => updateSettings({ fallingEffectColor: value })}
            />
          </fieldset>
        }
      />

      <SettingsRow
        title="Effect opacity"
        description="Lower is more transparent; 5% is faint and 100% is solid."
        control={
          <div className="flex items-center gap-2">
            <NumberField
              value={Math.round(settings.fallingEffectOpacity * 100)}
              min={Math.round(MIN_AMBIENT_OPACITY * 100)}
              max={Math.round(MAX_AMBIENT_OPACITY * 100)}
              step={5}
              disabled={!controlsEnabled}
              size="sm"
              className="w-28"
              onValueChange={(value) =>
                updateSettings({
                  fallingEffectOpacity: clampAtmosphereOpacityPercentSetting(value),
                })
              }
            >
              <NumberFieldGroup>
                <NumberFieldDecrement aria-label="Decrease falling effect opacity" />
                <NumberFieldInput aria-label="Falling effect opacity percent" />
                <NumberFieldIncrement aria-label="Increase falling effect opacity" />
              </NumberFieldGroup>
            </NumberField>
            <span className="text-xs text-muted-foreground">%</span>
          </div>
        }
      />

      <SettingsRow
        title="Effect speed"
        description="Adjust how quickly the selected effect falls."
        control={
          <div className="flex items-center gap-2">
            <NumberField
              value={settings.fallingEffectSpeed}
              min={MIN_FALLING_EFFECT_SPEED}
              max={MAX_FALLING_EFFECT_SPEED}
              step={0.25}
              disabled={!controlsEnabled}
              size="sm"
              className="w-28"
              onValueChange={(value) =>
                updateSettings({ fallingEffectSpeed: clampAtmosphereSpeedSetting(value) })
              }
            >
              <NumberFieldGroup>
                <NumberFieldDecrement aria-label="Decrease falling effect speed" />
                <NumberFieldInput aria-label="Falling effect speed multiplier" />
                <NumberFieldIncrement aria-label="Increase falling effect speed" />
              </NumberFieldGroup>
            </NumberField>
            <span className="text-xs text-muted-foreground">x</span>
          </div>
        }
      />

      <SettingsRow
        title="Effect density"
        description="Adjust how many flakes, drops, or Matrix columns fill the window."
        control={
          <div className="flex items-center gap-2">
            <NumberField
              value={settings.fallingEffectDensity}
              min={MIN_FALLING_EFFECT_DENSITY}
              max={MAX_FALLING_EFFECT_DENSITY}
              step={0.25}
              disabled={!controlsEnabled}
              size="sm"
              className="w-28"
              onValueChange={(value) =>
                updateSettings({ fallingEffectDensity: clampAtmosphereDensitySetting(value) })
              }
            >
              <NumberFieldGroup>
                <NumberFieldDecrement aria-label="Decrease falling effect density" />
                <NumberFieldInput aria-label="Falling effect density multiplier" />
                <NumberFieldIncrement aria-label="Increase falling effect density" />
              </NumberFieldGroup>
            </NumberField>
            <span className="text-xs text-muted-foreground">x</span>
          </div>
        }
      />
    </SettingsSection>
  );
}
