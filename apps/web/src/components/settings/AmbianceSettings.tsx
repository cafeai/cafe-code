import { useUiLocale, useUiPresentation } from "~/i18n";
import { uiText } from "@cafecode/shared/i18n";
import { useMemo, type CSSProperties } from "react";
import {
  DEFAULT_UNIFIED_SETTINGS,
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
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";

const DEFAULT_AMBIANCE_PICKER_COLOR = "#48cfff";

const EFFECT_TILES = AMBIANCE_EFFECTS;

const REACT_MODE_LABELS: Record<AmbianceReactMode, string> = {
  get off() {
    return uiText("Nothing");
  },
  get session() {
    return uiText("Session state");
  },
  get live() {
    return uiText("Session + activity");
  },
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
  surface,
  checked,
  onCheckedChange,
}: {
  surface: "sidebar" | "chat" | "composer";
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const uiLocale = useUiLocale();

  // Select whole accessible sentences from the canonical surface, rather than
  // lowercasing a translated heading and assuming English sentence grammar.
  const label =
    surface === "sidebar"
      ? uiText("Sidebar", undefined, undefined, uiLocale)
      : surface === "chat"
        ? uiText("Chat", undefined, undefined, uiLocale)
        : uiText("Composer", undefined, undefined, uiLocale);
  const accessibleLabel =
    surface === "sidebar"
      ? uiText("Draw ambiance on the sidebar", undefined, undefined, uiLocale)
      : surface === "chat"
        ? uiText("Draw ambiance on the chat", undefined, undefined, uiLocale)
        : uiText("Draw ambiance on the composer", undefined, undefined, uiLocale);
  return (
    <label className="flex items-center gap-2.5 text-xs text-muted-foreground">
      {label}
      <Switch
        checked={checked}
        onCheckedChange={(value) => onCheckedChange(Boolean(value))}
        aria-label={accessibleLabel}
      />
    </label>
  );
}

export function AmbianceSettingsSections() {
  const uiLocale = useUiLocale();
  const uiPresentation = useUiPresentation(UI_PRESENTATION_SOURCES);

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
    <>
      <SettingsSection title={uiText("Weather effects", undefined, undefined, uiLocale)}>
        <SettingsRow
          searchId="appearance.weatherLayer"
          title={uiText("Weather layer", undefined, undefined, uiLocale)}
          description={uiText(
            "Animated weather over the app. Off keeps the sidebar stars.",
            undefined,
            undefined,
            uiLocale,
          )}
          control={
            <Switch
              checked={settings.ambianceEnabled}
              onCheckedChange={(checked) => updateSettings({ ambianceEnabled: Boolean(checked) })}
              aria-label={uiText("Enable ambiance", undefined, undefined, uiLocale)}
            />
          }
        />

        <SettingsRow
          searchId="appearance.weatherEffect"
          title={uiText("Effect", undefined, undefined, uiLocale)}
          description={uiText("Heavier effects use more battery.", undefined, undefined, uiLocale)}
          resetAction={
            settings.ambianceEffect !== DEFAULT_AMBIANCE_EFFECT ? (
              <SettingResetButton
                label={uiText("ambiance effect", undefined, undefined, uiLocale)}
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
            {uiPresentation.EFFECT_TILES.map((tile) => {
              const selected = settings.ambianceEffect === tile.effect;
              return (
                <button
                  key={tile.effect}
                  type="button"
                  aria-pressed={selected}
                  aria-label={uiText(
                    "{value0} effect",
                    { value0: tile.label },
                    undefined,
                    uiLocale,
                  )}
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
                      {tile.backend === "webgl"
                        ? uiText(" · GPU", undefined, undefined, uiLocale)
                        : ""}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </SettingsRow>

        <SettingsRow
          searchId="appearance.weatherIntensity"
          title={uiText("Intensity", undefined, undefined, uiLocale)}
          description={uiText(
            "Base density; chat activity can add more.",
            undefined,
            undefined,
            uiLocale,
          )}
          resetAction={
            intensityDirty ? (
              <SettingResetButton
                label={uiText("ambiance intensity", undefined, undefined, uiLocale)}
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
                aria-label={uiText("Ambiance intensity", undefined, undefined, uiLocale)}
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
          searchId="appearance.weatherOpacity"
          title={uiText("Opacity", undefined, undefined, uiLocale)}
          description={uiText(
            "How visible the weather is, without changing its density.",
            undefined,
            undefined,
            uiLocale,
          )}
          resetAction={
            opacityDirty ? (
              <SettingResetButton
                label={uiText("ambiance opacity", undefined, undefined, uiLocale)}
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
                aria-label={uiText("Ambiance opacity", undefined, undefined, uiLocale)}
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
          searchId="appearance.weatherReact"
          title={uiText("React to chat", undefined, undefined, uiLocale)}
          description={uiText(
            "How much chat activity changes the weather.",
            undefined,
            undefined,
            uiLocale,
          )}
          resetAction={
            settings.ambianceReactMode !== DEFAULT_AMBIANCE_REACT_MODE ? (
              <SettingResetButton
                label={uiText("ambiance chat reaction", undefined, undefined, uiLocale)}
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
              <SelectTrigger
                className="w-full sm:w-44"
                aria-label={uiText("React to chat", undefined, undefined, uiLocale)}
              >
                <SelectValue>
                  {uiPresentation.REACT_MODE_LABELS[settings.ambianceReactMode]}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="off">
                  {uiPresentation.REACT_MODE_LABELS.off}
                </SelectItem>
                <SelectItem hideIndicator value="session">
                  {uiPresentation.REACT_MODE_LABELS.session}
                </SelectItem>
                <SelectItem hideIndicator value="live">
                  {uiPresentation.REACT_MODE_LABELS.live}
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />

        <SettingsRow
          searchId="appearance.weatherSurfaces"
          title={uiText("Surfaces", undefined, undefined, uiLocale)}
          description={uiText(
            "Composer tints the prompt frame instead of drawing weather.",
            undefined,
            undefined,
            uiLocale,
          )}
          control={
            <div className="flex flex-col items-end gap-2">
              <AmbianceSurfaceToggle
                surface="sidebar"
                checked={settings.ambianceSurfaceSidebar}
                onCheckedChange={(checked) => updateSettings({ ambianceSurfaceSidebar: checked })}
              />
              <AmbianceSurfaceToggle
                surface="chat"
                checked={settings.ambianceSurfaceThread}
                onCheckedChange={(checked) => updateSettings({ ambianceSurfaceThread: checked })}
              />
              <AmbianceSurfaceToggle
                surface="composer"
                checked={settings.ambianceSurfaceComposer}
                onCheckedChange={(checked) => updateSettings({ ambianceSurfaceComposer: checked })}
              />
            </div>
          }
        />

        <SettingsRow
          searchId="appearance.weatherColor"
          title={uiText("Weather color", undefined, undefined, uiLocale)}
          description={uiText(
            "Defaults to the accent color set in Appearance.",
            undefined,
            undefined,
            uiLocale,
          )}
          resetAction={
            settings.ambianceColor !== DEFAULT_UNIFIED_SETTINGS.ambianceColor ? (
              <SettingResetButton
                label={uiText("weather color", undefined, undefined, uiLocale)}
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

      <SettingsSection title={uiText("Task Atrium", undefined, undefined, uiLocale)}>
        <SettingsRow
          searchId="appearance.atriumColor"
          title={uiText("Atrium color", undefined, undefined, uiLocale)}
          description={uiText("Defaults to the weather color.", undefined, undefined, uiLocale)}
          resetAction={
            settings.ambianceAtriumColor !== DEFAULT_UNIFIED_SETTINGS.ambianceAtriumColor ? (
              <SettingResetButton
                label={uiText("atrium color", undefined, undefined, uiLocale)}
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
    </>
  );
}

// Finite source-owned labels/helpers only; no received or user data.
const UI_PRESENTATION_SOURCES = { EFFECT_TILES, REACT_MODE_LABELS };
