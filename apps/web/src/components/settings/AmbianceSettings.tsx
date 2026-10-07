import { useMemo, type CSSProperties } from "react";
import {
  DEFAULT_UNIFIED_SETTINGS,
  DEFAULT_AMBIANCE_ATRIUM_ENABLED,
  DEFAULT_AMBIANCE_ATRIUM_COLOR,
  DEFAULT_AMBIANCE_COLOR,
  DEFAULT_AMBIANCE_EFFECT,
  DEFAULT_AMBIANCE_INTENSITY,
  DEFAULT_AMBIANCE_OPACITY,
  DEFAULT_AMBIANCE_REACT_MODE,
  MAX_AMBIANCE_INTENSITY,
  MAX_AMBIANCE_OPACITY,
  MIN_AMBIANCE_INTENSITY,
  MIN_AMBIANCE_OPACITY,
  type AmbianceReactMode,
} from "@cafecode/contracts/settings";

import {
  AMBIANCE_COST_LABEL,
  AMBIANCE_EFFECTS,
  type AmbianceCost,
} from "../../ambiance/ambianceEffects";

import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { normalizeAccentColor } from "../../themeAccent";
import { cn } from "../../lib/utils";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Slider } from "../ui/slider";
import { Switch } from "../ui/switch";
import { ColorWheelPicker } from "./ColorWheelPicker";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";

const DEFAULT_AMBIANCE_PICKER_COLOR = "#48cfff";

const EFFECT_TILES = AMBIANCE_EFFECTS;

const REACT_MODE_LABELS: Record<AmbianceReactMode, string> = {
  off: "Nothing",
  session: "Session state",
  live: "Session + activity",
};

/**
 * Cost dot colors. The range across the catalog is wide — a 50-node 2D graph up
 * to a per-pixel volumetric orb — so the picker says what a choice costs before
 * someone lands on a heavy one on a machine that will struggle.
 */
const COST_DOT_CLASS: Record<AmbianceCost, string> = {
  light: "bg-status-done",
  medium: "bg-status-attention",
  heavy: "bg-status-error",
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
  const opacityDirty = settings.ambianceOpacity !== DEFAULT_AMBIANCE_OPACITY;

  return (
    <SettingsPageContainer title="Ambiance">
      <SettingsSection>
        <SettingsRow
          title="Weather layer"
          description="Animated weather over the app. Off keeps the sidebar stars."
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
          description="Heavier effects use more battery."
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
            className="grid grid-cols-2 gap-2 pt-3 pb-3.5 sm:grid-cols-4 lg:grid-cols-6"
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
                    "group focus-ring overflow-hidden rounded-lg border text-left transition-colors duration-(--duration-fast)",
                    selected
                      ? "border-primary bg-primary/5"
                      : "border-border hover:border-border-strong",
                  )}
                  onClick={() => updateSettings({ ambianceEffect: tile.effect })}
                >
                  <span
                    aria-hidden="true"
                    className={cn("cafe-ambiance-preview block h-9", tile.previewClass)}
                  />
                  <span className="block px-2 py-1.5">
                    <span
                      className={cn(
                        "block text-2xs font-medium",
                        selected ? "text-foreground" : "text-muted-foreground",
                      )}
                    >
                      {tile.label}
                    </span>
                    <span className="mt-0.5 flex items-center gap-1 text-2xs text-subtle-foreground">
                      <span
                        aria-hidden="true"
                        className={cn("size-1.5 shrink-0 rounded-full", COST_DOT_CLASS[tile.cost])}
                      />
                      {AMBIANCE_COST_LABEL[tile.cost]}
                      {tile.backend === "webgl" ? " · GPU" : ""}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </SettingsRow>

        <SettingsRow
          title="Intensity"
          description="Base density; chat activity can add more."
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
          title="Opacity"
          description="How visible the weather is, without changing its density."
          resetAction={
            opacityDirty ? (
              <SettingResetButton
                label="ambiance opacity"
                onClick={() => updateSettings({ ambianceOpacity: DEFAULT_AMBIANCE_OPACITY })}
              />
            ) : null
          }
          control={
            <div className="flex w-full items-center gap-3 sm:w-56">
              <Slider
                value={settings.ambianceOpacity}
                min={MIN_AMBIANCE_OPACITY}
                max={MAX_AMBIANCE_OPACITY}
                step={0.05}
                aria-label="Ambiance opacity"
                onValueChange={(value) =>
                  updateSettings({
                    ambianceOpacity: Math.min(
                      MAX_AMBIANCE_OPACITY,
                      Math.max(MIN_AMBIANCE_OPACITY, Math.round(value * 20) / 20),
                    ),
                  })
                }
              />
              <span className="w-9 shrink-0 text-right font-mono text-xs text-muted-foreground">
                {settings.ambianceOpacity.toFixed(2)}
              </span>
            </div>
          }
        />

        <SettingsRow
          title="React to chat"
          description="How much chat activity changes the weather."
          resetAction={
            settings.ambianceReactMode !== DEFAULT_AMBIANCE_REACT_MODE ? (
              <SettingResetButton
                label="ambiance chat reaction"
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
              <SelectTrigger className="w-full sm:w-44" aria-label="React to chat">
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
          description="Composer tints the prompt frame instead of drawing weather."
          control={
            <div className="flex flex-col items-end gap-2">
              <AmbianceSurfaceToggle
                label="Sidebar"
                checked={settings.ambianceSurfaceSidebar}
                onCheckedChange={(checked) => updateSettings({ ambianceSurfaceSidebar: checked })}
              />
              <AmbianceSurfaceToggle
                label="Chat"
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

      <SettingsSection title="Task Atrium">
        <SettingsRow
          title="Task Atrium"
          description="Adds an Atrium button above Settings: a read-only overview of chats and subagents."
          resetAction={
            settings.ambianceAtriumEnabled !== DEFAULT_AMBIANCE_ATRIUM_ENABLED ? (
              <SettingResetButton
                label="task atrium"
                onClick={() =>
                  updateSettings({ ambianceAtriumEnabled: DEFAULT_AMBIANCE_ATRIUM_ENABLED })
                }
              />
            ) : null
          }
          control={
            <Switch
              checked={settings.ambianceAtriumEnabled}
              onCheckedChange={(checked) =>
                updateSettings({ ambianceAtriumEnabled: Boolean(checked) })
              }
              aria-label="Enable Task Atrium"
            />
          }
        />

        <SettingsRow
          title="Atrium color"
          description="Defaults to the weather color."
          resetAction={
            settings.ambianceAtriumColor !== DEFAULT_UNIFIED_SETTINGS.ambianceAtriumColor ? (
              <SettingResetButton
                label="atrium color"
                onClick={() =>
                  updateSettings({ ambianceAtriumColor: DEFAULT_AMBIANCE_ATRIUM_COLOR })
                }
              />
            ) : null
          }
          control={
            <ColorWheelPicker
              value={settings.ambianceAtriumColor}
              defaultPickerColor={previewAccent ?? DEFAULT_AMBIANCE_PICKER_COLOR}
              emptyValue={DEFAULT_AMBIANCE_ATRIUM_COLOR}
              ariaLabel="Task Atrium color"
              onCommit={(value) => updateSettings({ ambianceAtriumColor: value })}
            />
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
