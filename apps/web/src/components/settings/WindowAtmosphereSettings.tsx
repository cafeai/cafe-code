import {
  DEFAULT_AMBIENT_COLOR,
  DEFAULT_AMBIENT_OPACITY,
  DEFAULT_FALLING_EFFECT_DENSITY,
  DEFAULT_FALLING_EFFECT_USAGE_REACTIVE,
  DEFAULT_FALLING_EFFECT_JAPANESE_RATIO,
  DEFAULT_FALLING_EFFECT_KIND,
  DEFAULT_FALLING_EFFECT_MATRIX_COLOR_MODE,
  DEFAULT_FALLING_EFFECT_SPEED,
  DEFAULT_FALLING_EFFECTS_ENABLED,
  MAX_AMBIENT_OPACITY,
  MAX_FALLING_EFFECT_DENSITY,
  MAX_FALLING_EFFECT_JAPANESE_RATIO,
  MAX_FALLING_EFFECT_SPEED,
  MIN_AMBIENT_OPACITY,
  MIN_FALLING_EFFECT_DENSITY,
  MIN_FALLING_EFFECT_JAPANESE_RATIO,
  MIN_FALLING_EFFECT_SPEED,
} from "@cafecode/contracts/settings";

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
import { ColorWheelPicker } from "./ColorWheelPicker";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";

const DEFAULT_ATMOSPHERE_PICKER_COLOR = "#38bdf8";

export function WindowAtmosphereSettings() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const serverConfig = useServerConfig();
  const atmosphereAvailable = serverConfig?.ambientExperienceCapabilities.atmosphere === true;
  const hasNonDefaultValue =
    settings.fallingEffectsEnabled !== DEFAULT_FALLING_EFFECTS_ENABLED ||
    settings.fallingEffectKind !== DEFAULT_FALLING_EFFECT_KIND ||
    settings.fallingEffectColor !== DEFAULT_AMBIENT_COLOR ||
    settings.fallingEffectMatrixColorMode !== DEFAULT_FALLING_EFFECT_MATRIX_COLOR_MODE ||
    settings.fallingEffectOpacity !== DEFAULT_AMBIENT_OPACITY ||
    settings.fallingEffectSpeed !== DEFAULT_FALLING_EFFECT_SPEED ||
    settings.fallingEffectDensity !== DEFAULT_FALLING_EFFECT_DENSITY ||
    settings.fallingEffectUsageReactive !== DEFAULT_FALLING_EFFECT_USAGE_REACTIVE ||
    settings.fallingEffectJapaneseRatio !== DEFAULT_FALLING_EFFECT_JAPANESE_RATIO;
  const controlsEnabled = atmosphereAvailable && settings.fallingEffectsEnabled;

  return (
    <SettingsSection title="Window atmosphere">
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
                  fallingEffectsEnabled: DEFAULT_FALLING_EFFECTS_ENABLED,
                  fallingEffectKind: DEFAULT_FALLING_EFFECT_KIND,
                  fallingEffectColor: DEFAULT_AMBIENT_COLOR,
                  fallingEffectMatrixColorMode: DEFAULT_FALLING_EFFECT_MATRIX_COLOR_MODE,
                  fallingEffectOpacity: DEFAULT_AMBIENT_OPACITY,
                  fallingEffectSpeed: DEFAULT_FALLING_EFFECT_SPEED,
                  fallingEffectDensity: DEFAULT_FALLING_EFFECT_DENSITY,
                  fallingEffectUsageReactive: DEFAULT_FALLING_EFFECT_USAGE_REACTIVE,
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
        title="Usage-reactive rain and snow"
        description="Use aggregate output-token activity from all threads. Rain and snow increase within the renderer limits, then return to the selected baseline."
        status={
          settings.fallingEffectUsageReactive && !settings.usageStatsEnabled ? (
            <span className="text-amber-600 dark:text-amber-400">
              Usage collection is off. The effect will stay at its baseline.
            </span>
          ) : settings.fallingEffectKind === "matrix" ? (
            <span className="text-muted-foreground">Select rain or snow to use this setting.</span>
          ) : null
        }
        control={
          <Switch
            checked={settings.fallingEffectUsageReactive}
            disabled={!controlsEnabled}
            onCheckedChange={(checked) =>
              updateSettings({ fallingEffectUsageReactive: Boolean(checked) })
            }
            aria-label="Make rain and snow react to aggregate token usage"
          />
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
