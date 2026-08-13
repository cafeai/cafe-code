import { useMemo, type CSSProperties } from "react";
import {
  DEFAULT_UNIFIED_SETTINGS,
  DEFAULT_AMBIANCE_COLOR,
  DEFAULT_AMBIANCE_EFFECT,
  DEFAULT_AMBIANCE_INTENSITY,
  DEFAULT_AMBIANCE_REACT_MODE,
  MAX_AMBIANCE_INTENSITY,
  MIN_AMBIANCE_INTENSITY,
  type AmbianceEffect,
  type AmbianceReactMode,
} from "@cafecode/contracts/settings";

import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { normalizeAccentColor } from "../../themeAccent";
import { cn } from "../../lib/utils";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Slider } from "../ui/slider";
import { Switch } from "../ui/switch";
import { ColorWheelPicker } from "./ColorWheelPicker";
import { YouTubeQueueSettingsSection } from "./YouTubeQueueSettings";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";

const DEFAULT_AMBIANCE_PICKER_COLOR = "#48cfff";

const EFFECT_TILES: ReadonlyArray<{ effect: AmbianceEffect; label: string; previewClass: string }> =
  [
    { effect: "stars", label: "Stars", previewClass: "cafe-ambiance-preview-stars" },
    { effect: "rain", label: "Rain", previewClass: "cafe-ambiance-preview-rain" },
    { effect: "snow", label: "Snow", previewClass: "cafe-ambiance-preview-snow" },
    { effect: "matrix", label: "Matrix", previewClass: "cafe-ambiance-preview-matrix" },
    { effect: "fire", label: "Fire", previewClass: "cafe-ambiance-preview-fire" },
  ];

const REACT_MODE_LABELS: Record<AmbianceReactMode, string> = {
  off: "Nothing",
  session: "Session state",
  live: "Session + activity",
};

function AmbianceSurfaceToggle({
  label,
  checked,
  onCheckedChange,
}: {
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2.5 text-xs text-muted-foreground">
      {label}
      <Switch
        checked={checked}
        onCheckedChange={(value) => onCheckedChange(Boolean(value))}
        aria-label={`Draw ambiance on the ${label.toLowerCase()}`}
      />
    </label>
  );
}

export function AmbianceSettingsPanel() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();

  // The tile previews are tinted with the same resolution order the live
  // renderer uses: explicit weather color, then the Appearance accent color,
  // then the sidebar color, then the theme's own sidebar accent.
  const previewAccent = useMemo(
    () =>
      normalizeAccentColor(settings.ambianceColor) ??
      normalizeAccentColor(settings.appAccentColor) ??
      normalizeAccentColor(settings.themeAccentColor) ??
      undefined,
    [settings.ambianceColor, settings.appAccentColor, settings.themeAccentColor],
  );

  const intensityDirty = settings.ambianceIntensity !== DEFAULT_AMBIANCE_INTENSITY;

  return (
    <SettingsPageContainer>
      <SettingsSection title="Ambiance">
        <SettingsRow
          title="Ambiance"
          description="Draw an animated weather layer over the app. Off keeps the default sidebar stars."
          control={
            <Switch
              checked={settings.ambianceEnabled}
              onCheckedChange={(checked) => updateSettings({ ambianceEnabled: Boolean(checked) })}
              aria-label="Enable ambiance"
            />
          }
        />

        <SettingsRow
          title="Effect"
          description="Pick the weather drawn behind your work. Previews are live."
          resetAction={
            settings.ambianceEffect !== DEFAULT_AMBIANCE_EFFECT ? (
              <SettingResetButton
                label="ambiance effect"
                onClick={() => updateSettings({ ambianceEffect: DEFAULT_AMBIANCE_EFFECT })}
              />
            ) : null
          }
        >
          <div
            className="grid grid-cols-3 gap-2 pt-3 pb-3.5 sm:grid-cols-5"
            style={
              previewAccent
                ? ({ "--cafe-ambiance-accent": previewAccent } as CSSProperties)
                : undefined
            }
          >
            {EFFECT_TILES.map((tile) => {
              const selected = settings.ambianceEffect === tile.effect;
              return (
                <button
                  key={tile.effect}
                  type="button"
                  aria-pressed={selected}
                  aria-label={`${tile.label} effect`}
                  className={cn(
                    "group overflow-hidden rounded-lg border text-left transition-colors",
                    selected
                      ? "border-primary/70 ring-1 ring-primary/45 ring-inset"
                      : "border-border hover:border-foreground/25",
                  )}
                  onClick={() => updateSettings({ ambianceEffect: tile.effect })}
                >
                  <span
                    aria-hidden="true"
                    className={cn("cafe-ambiance-preview block h-9", tile.previewClass)}
                  />
                  <span
                    className={cn(
                      "block px-2 py-1.5 text-[11px]",
                      selected ? "text-foreground" : "text-muted-foreground",
                    )}
                  >
                    {tile.label}
                  </span>
                </button>
              );
            })}
          </div>
        </SettingsRow>

        <SettingsRow
          title="Intensity"
          description="Baseline density before the thread has any say."
          resetAction={
            intensityDirty ? (
              <SettingResetButton
                label="ambiance intensity"
                onClick={() => updateSettings({ ambianceIntensity: DEFAULT_AMBIANCE_INTENSITY })}
              />
            ) : null
          }
          control={
            <div className="flex w-full items-center gap-3 sm:w-56">
              <Slider
                value={settings.ambianceIntensity}
                min={MIN_AMBIANCE_INTENSITY}
                max={MAX_AMBIANCE_INTENSITY}
                step={0.05}
                aria-label="Ambiance intensity"
                onValueChange={(value) =>
                  updateSettings({
                    ambianceIntensity: Math.min(
                      MAX_AMBIANCE_INTENSITY,
                      Math.max(MIN_AMBIANCE_INTENSITY, Math.round(value * 20) / 20),
                    ),
                  })
                }
              />
              <span className="w-9 shrink-0 text-right font-mono text-xs text-muted-foreground">
                {settings.ambianceIntensity.toFixed(2)}
              </span>
            </div>
          }
        />

        <SettingsRow
          title="React to thread"
          description="How much of the run the weather is allowed to hear."
          resetAction={
            settings.ambianceReactMode !== DEFAULT_AMBIANCE_REACT_MODE ? (
              <SettingResetButton
                label="ambiance thread reaction"
                onClick={() => updateSettings({ ambianceReactMode: DEFAULT_AMBIANCE_REACT_MODE })}
              />
            ) : null
          }
          control={
            <Select
              value={settings.ambianceReactMode}
              onValueChange={(value) => {
                if (value === "off" || value === "session" || value === "live") {
                  updateSettings({ ambianceReactMode: value });
                }
              }}
            >
              <SelectTrigger className="w-full sm:w-44" aria-label="React to thread">
                <SelectValue>{REACT_MODE_LABELS[settings.ambianceReactMode]}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="off">
                  {REACT_MODE_LABELS.off}
                </SelectItem>
                <SelectItem hideIndicator value="session">
                  {REACT_MODE_LABELS.session}
                </SelectItem>
                <SelectItem hideIndicator value="live">
                  {REACT_MODE_LABELS.live}
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          title="Surfaces"
          description="Where the weather draws. Turning off the thread area keeps message text on a flat background; the composer surface tints the prompt frame with the current conditions."
          control={
            <div className="flex flex-col items-end gap-2">
              <AmbianceSurfaceToggle
                label="Sidebar"
                checked={settings.ambianceSurfaceSidebar}
                onCheckedChange={(checked) => updateSettings({ ambianceSurfaceSidebar: checked })}
              />
              <AmbianceSurfaceToggle
                label="Thread"
                checked={settings.ambianceSurfaceThread}
                onCheckedChange={(checked) => updateSettings({ ambianceSurfaceThread: checked })}
              />
              <AmbianceSurfaceToggle
                label="Composer"
                checked={settings.ambianceSurfaceComposer}
                onCheckedChange={(checked) => updateSettings({ ambianceSurfaceComposer: checked })}
              />
            </div>
          }
        />

        <SettingsRow
          title="Weather color"
          description="Defaults to the accent color set in Appearance."
          resetAction={
            settings.ambianceColor !== DEFAULT_UNIFIED_SETTINGS.ambianceColor ? (
              <SettingResetButton
                label="weather color"
                onClick={() => updateSettings({ ambianceColor: DEFAULT_AMBIANCE_COLOR })}
              />
            ) : null
          }
          control={
            <ColorWheelPicker
              value={settings.ambianceColor}
              defaultPickerColor={previewAccent ?? DEFAULT_AMBIANCE_PICKER_COLOR}
              emptyValue={DEFAULT_AMBIANCE_COLOR}
              ariaLabel="Ambiance weather color"
              onCommit={(value) => updateSettings({ ambianceColor: value })}
            />
          }
        />
      </SettingsSection>
      <YouTubeQueueSettingsSection />
    </SettingsPageContainer>
  );
}
