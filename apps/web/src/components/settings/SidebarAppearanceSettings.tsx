import {
  DEFAULT_BRAND_WORDMARK_PREFIX,
  DEFAULT_SHOW_SIDEBAR_ATTRIBUTION,
  DEFAULT_SHOW_SIDEBAR_MASCOT,
  DEFAULT_SHOW_SIDEBAR_SEARCH,
  DEFAULT_SIDEBAR_BRAND_IMAGE,
  DEFAULT_SIDEBAR_IMAGE_SOURCE,
  DEFAULT_UNIFIED_SETTINGS,
  MAX_BRAND_WORDMARK_PREFIX_LENGTH,
  MAX_SIDEBAR_BRAND_IMAGE_FILE_BYTES,
} from "@cafecode/contracts/settings";
import type { DesktopAppIconVariant } from "@cafecode/contracts";
import { uiText, type UiLocale } from "@cafecode/shared/i18n";
import { PlusIcon } from "lucide-react";
import { type ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useUiLocale } from "~/i18n";
import { APP_STAGE_LABEL } from "../../branding";
import { uploadSidebarBrandImage } from "../../brandingImages";
import { useWorkspaceEnvironmentId } from "../../environments/workspace";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { useSidebarImage, type SidebarImageMode } from "../../hooks/useSidebarImage";
import { cn } from "../../lib/utils";
import { renderAppIconPngs } from "../../appIconRendering";
import {
  isDesktopAppIconAvailable,
  renderThemedAppIcon,
  setDesktopAppIcon,
  useDesktopAppIconState,
} from "../../appIconState";
import { themedAppIconUrl } from "../../appIconThemes";
import { useTheme } from "../../hooks/useTheme";
import {
  resolveSidebarImageColor,
  SIDEBAR_IMAGE_COLORS,
  type SidebarImageColorId,
} from "../../sidebarImages";
import { CafeCodeWordmark, SIDEBAR_STAGE_BADGE_CLASS_NAME } from "../CafeCodeWordmark";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { SegmentedControl } from "../ui/segmented-control";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { registerSecretIconTap } from "./secretIconTaps";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";

const SIDEBAR_IMAGE_ACCEPT = "image/png,image/jpeg,image/gif,image/webp";
const SIDEBAR_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const APP_ICON_ACCEPT = "image/png,image/jpeg,image/webp";
const APP_ICON_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_APP_ICON_SOURCE_BYTES = 16 * 1024 * 1024;
const STATUS_CLEAR_MS = 4000;

function sidebarColorName(id: SidebarImageColorId, locale: UiLocale): string {
  switch (id) {
    case "teal":
      return uiText("Teal", undefined, "color name", locale);
    case "blue":
      return uiText("Blue", undefined, "color name", locale);
    case "violet":
      return uiText("Violet", undefined, "color name", locale);
    case "pink":
      return uiText("Pink", undefined, "color name", locale);
    case "red":
      return uiText("Red", undefined, "color name", locale);
    case "amber":
      return uiText("Amber", undefined, "color name", locale);
    case "lime":
      return uiText("Lime", undefined, "color name", locale);
    case "green":
      return uiText("Green", undefined, "color name", locale);
  }
}

/**
 * One-click accent colors: each is exactly the color of one built-in sidebar
 * scene and app icon, so picking one shows that scene (Settings → Accent color).
 */
export function AccentColorSwatches() {
  const uiLocale = useUiLocale();
  const accentColor = useSettings((settings) => settings.appAccentColor);
  const { updateSettings } = useUpdateSettings();
  return (
    <div className="flex flex-wrap justify-end gap-2">
      {SIDEBAR_IMAGE_COLORS.map((color) => {
        const selected = accentColor.toLowerCase() === color.swatch;
        return (
          <button
            key={color.id}
            type="button"
            aria-label={sidebarColorName(color.id, uiLocale)}
            aria-pressed={selected}
            className={cn(
              "size-4.5 cursor-pointer rounded-full ring-1 ring-border ring-inset outline-offset-2",
              selected ? "outline-2 outline-foreground" : "outline-hidden",
              "focus-visible:outline-2 focus-visible:outline-ring",
            )}
            style={{ backgroundColor: color.swatch }}
            onClick={() => updateSettings({ appAccentColor: color.swatch })}
          />
        );
      })}
    </div>
  );
}

export function SidebarSettingsSection() {
  const uiLocale = useUiLocale();
  const environmentId = useWorkspaceEnvironmentId();
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const sidebarImage = useSidebarImage();
  const mode = sidebarImage.mode;

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const previewUrlRef = useRef<string | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  // DraftInput commits on blur; this mirrors keystrokes for the live wordmark.
  // A draft typed against an older saved value is ignored once the saved value changes.
  const [prefixDraft, setPrefixDraft] = useState<{
    readonly saved: string;
    readonly value: string;
  } | null>(null);
  const previewPrefix =
    prefixDraft && prefixDraft.saved === settings.brandWordmarkPrefix
      ? prefixDraft.value
      : settings.brandWordmarkPrefix;

  const clearPreviewUrl = useCallback(() => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    previewUrlRef.current = null;
    setPreviewUrl(null);
  }, []);
  useEffect(() => clearPreviewUrl, [clearPreviewUrl]);

  const setMode = useCallback(
    (next: SidebarImageMode) => {
      if (next === "off") {
        updateSettings({ showSidebarMascot: false });
        return;
      }
      updateSettings({ showSidebarMascot: true, sidebarImageSource: next });
      if (next === "custom" && settings.sidebarBrandImage === null) {
        fileInputRef.current?.click();
      }
    },
    [settings.sidebarBrandImage, updateSettings],
  );

  const handleImageChange = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.currentTarget.files?.[0];
      event.currentTarget.value = "";
      if (!file) return;
      if (!SIDEBAR_IMAGE_MIME_TYPES.has(file.type)) {
        setImageError(
          uiText("Choose a PNG, JPEG, GIF, or WebP image.", undefined, undefined, uiLocale),
        );
        return;
      }
      if (file.size > MAX_SIDEBAR_BRAND_IMAGE_FILE_BYTES) {
        setImageError(uiText("Choose an image under 1 MB.", undefined, undefined, uiLocale));
        return;
      }
      clearPreviewUrl();
      const url = URL.createObjectURL(file);
      previewUrlRef.current = url;
      setPreviewUrl(url);
      setUploading(true);
      try {
        const sidebarBrandImage = await uploadSidebarBrandImage(file, environmentId);
        setImageError(null);
        updateSettings({
          sidebarBrandImage,
          sidebarBrandImageDataUrl: "",
          showSidebarMascot: true,
          sidebarImageSource: "custom",
        });
      } catch (error) {
        setImageError(
          error instanceof Error
            ? error.message
            : uiText("Could not upload that image.", undefined, undefined, uiLocale),
        );
      } finally {
        clearPreviewUrl();
        setUploading(false);
      }
    },
    [clearPreviewUrl, environmentId, updateSettings, uiLocale],
  );

  const imageModeChanged =
    settings.showSidebarMascot !== DEFAULT_SHOW_SIDEBAR_MASCOT ||
    settings.sidebarImageSource !== DEFAULT_SIDEBAR_IMAGE_SOURCE ||
    settings.sidebarBrandImage !== DEFAULT_SIDEBAR_BRAND_IMAGE;
  const showsEmptyCustomCard =
    mode === "custom" && settings.sidebarBrandImage === null && !previewUrl;

  return (
    <SettingsSection title={uiText("Sidebar", undefined, undefined, uiLocale)}>
      <SettingsRow
        searchId="appearance.sidebarImage"
        title={uiText("Sidebar image", undefined, undefined, uiLocale)}
        resetAction={
          imageModeChanged && !uploading ? (
            <SettingResetButton
              label={uiText("sidebar image", undefined, undefined, uiLocale)}
              onClick={() => {
                setImageError(null);
                updateSettings({
                  showSidebarMascot: DEFAULT_SHOW_SIDEBAR_MASCOT,
                  sidebarImageSource: DEFAULT_SIDEBAR_IMAGE_SOURCE,
                  sidebarBrandImage: DEFAULT_SIDEBAR_BRAND_IMAGE,
                  sidebarBrandImageDataUrl: "",
                });
              }}
            />
          ) : null
        }
        status={
          imageError ? <span className="text-destructive-foreground">{imageError}</span> : null
        }
        control={
          <div className="flex flex-col items-end gap-3">
            <SegmentedControl<SidebarImageMode>
              aria-label={uiText("Sidebar image", undefined, undefined, uiLocale)}
              value={mode}
              onValueChange={setMode}
              options={[
                { value: "off", label: uiText("Off", undefined, undefined, uiLocale) },
                { value: "match", label: uiText("Match color", undefined, undefined, uiLocale) },
                { value: "custom", label: uiText("Custom", undefined, undefined, uiLocale) },
              ]}
            />
            <div className={cn("flex items-end gap-3", mode === "off" && "opacity-50")}>
              {mode === "custom" ? (
                <Button
                  disabled={uploading}
                  size="xs"
                  variant="outline"
                  onClick={() => fileInputRef.current?.click()}
                >
                  {uploading ? <Spinner aria-hidden="true" className="size-3.5" /> : null}
                  {uiText("Choose image", undefined, undefined, uiLocale)}
                </Button>
              ) : null}
              {showsEmptyCustomCard ? (
                <div className="flex h-32 w-[6.4rem] items-center justify-center rounded-2xl border border-dashed border-border-strong text-2xs text-subtle-foreground">
                  {uiText("No image", undefined, undefined, uiLocale)}
                </div>
              ) : (
                <img
                  alt=""
                  aria-hidden="true"
                  className="h-32 w-[6.4rem] shrink-0 select-none rounded-2xl object-cover ring-1 ring-border"
                  draggable={false}
                  height={128}
                  width={102}
                  sizes={previewUrl ? undefined : sidebarImage.sizes}
                  src={previewUrl ?? sidebarImage.src}
                  srcSet={previewUrl ? undefined : sidebarImage.srcSet}
                />
              )}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept={SIDEBAR_IMAGE_ACCEPT}
              aria-label={uiText("Sidebar image file", undefined, undefined, uiLocale)}
              className="sr-only"
              disabled={uploading}
              tabIndex={-1}
              onChange={(event) => void handleImageChange(event)}
            />
          </div>
        }
      />

      <SettingsRow
        searchId="appearance.brandingPrefix"
        title={uiText("Branding prefix", undefined, undefined, uiLocale)}
        resetAction={
          settings.brandWordmarkPrefix !== DEFAULT_UNIFIED_SETTINGS.brandWordmarkPrefix ? (
            <SettingResetButton
              label={uiText("branding prefix", undefined, undefined, uiLocale)}
              onClick={() => updateSettings({ brandWordmarkPrefix: DEFAULT_BRAND_WORDMARK_PREFIX })}
            />
          ) : null
        }
        control={
          <div className="flex w-full flex-col items-stretch gap-2 sm:w-52">
            <DraftInput
              aria-label={uiText("Branding prefix", undefined, undefined, uiLocale)}
              maxLength={MAX_BRAND_WORDMARK_PREFIX_LENGTH}
              placeholder={DEFAULT_BRAND_WORDMARK_PREFIX}
              value={settings.brandWordmarkPrefix}
              onInput={(event) =>
                setPrefixDraft({
                  saved: settings.brandWordmarkPrefix,
                  value: event.currentTarget.value,
                })
              }
              onCommit={(value) =>
                updateSettings({
                  brandWordmarkPrefix: value.trim().slice(0, MAX_BRAND_WORDMARK_PREFIX_LENGTH),
                })
              }
            />
            <div
              aria-hidden="true"
              className="flex min-w-0 items-center gap-1 rounded-lg border border-border-subtle bg-sunken px-3 py-2"
            >
              <CafeCodeWordmark className="min-w-0 truncate" prefix={previewPrefix} />
              <span className={SIDEBAR_STAGE_BADGE_CLASS_NAME}>{APP_STAGE_LABEL}</span>
            </div>
          </div>
        }
      />

      <SettingsRow
        searchId="appearance.sidebarSearch"
        title={uiText("Sidebar search", undefined, undefined, uiLocale)}
        resetAction={
          settings.showSidebarSearch !== DEFAULT_UNIFIED_SETTINGS.showSidebarSearch ? (
            <SettingResetButton
              label={uiText("sidebar search", undefined, undefined, uiLocale)}
              onClick={() => updateSettings({ showSidebarSearch: DEFAULT_SHOW_SIDEBAR_SEARCH })}
            />
          ) : null
        }
        control={
          <Switch
            checked={settings.showSidebarSearch}
            onCheckedChange={(checked) => updateSettings({ showSidebarSearch: Boolean(checked) })}
            aria-label={uiText("Show sidebar search", undefined, undefined, uiLocale)}
          />
        }
      />

      <SettingsRow
        searchId="appearance.sidebarAttribution"
        title={uiText("Sidebar attribution", undefined, undefined, uiLocale)}
        resetAction={
          settings.showSidebarAttribution !== DEFAULT_UNIFIED_SETTINGS.showSidebarAttribution ? (
            <SettingResetButton
              label={uiText("sidebar attribution", undefined, undefined, uiLocale)}
              onClick={() =>
                updateSettings({ showSidebarAttribution: DEFAULT_SHOW_SIDEBAR_ATTRIBUTION })
              }
            />
          ) : null
        }
        control={
          <Switch
            checked={settings.showSidebarAttribution}
            onCheckedChange={(checked) =>
              updateSettings({ showSidebarAttribution: Boolean(checked) })
            }
            aria-label={uiText("Show sidebar attribution", undefined, undefined, uiLocale)}
          />
        }
      />
    </SettingsSection>
  );
}

function useObjectUrl(bytes: Uint8Array | null | undefined): string | null {
  const url = useMemo(
    () =>
      bytes ? URL.createObjectURL(new Blob([bytes.slice().buffer], { type: "image/png" })) : null,
    [bytes],
  );
  useEffect(() => () => (url ? URL.revokeObjectURL(url) : undefined), [url]);
  return url;
}

function appIconTileClass(selected: boolean) {
  return cn(
    "flex size-18 items-center justify-center overflow-hidden rounded-2xl bg-muted ring-1 ring-border transition-shadow duration-(--duration-fast)",
    selected && "ring-2 ring-primary ring-offset-2 ring-offset-card",
  );
}

/**
 * Desktop app only: this computer's Dock/taskbar icon. Default is colored like
 * the accent color and theme; clicking the "Icon" title 10 times swaps it for
 * Dekai (and back). A custom upload replaces both.
 */
export function AppIconSettingsSection() {
  const uiLocale = useUiLocale();
  const { resolvedTheme } = useTheme();
  const accentColor = useSettings((settings) => settings.appAccentColor);
  const state = useDesktopAppIconState();
  const available = isDesktopAppIconAvailable();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ readonly text: string; readonly error: boolean } | null>(
    null,
  );
  const tapsRef = useRef<readonly number[]>([]);
  const statusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const customPreviewUrl = useObjectUrl(state?.customIconPreviewPng);
  const colorId = resolveSidebarImageColor(accentColor, resolvedTheme);

  useEffect(
    () => () => {
      if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
    },
    [],
  );

  const showStatus = useCallback((text: string, error = false) => {
    if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
    setStatus({ text, error });
    statusTimerRef.current = setTimeout(() => setStatus(null), STATUS_CLEAR_MS);
  }, []);

  const failed = useCallback(
    () =>
      showStatus(uiText("Could not change the app icon.", undefined, undefined, uiLocale), true),
    [showStatus, uiLocale],
  );

  // The built-in icon travels with its themed rendering in one change, so the
  // Dock never flashes the uncolored icon in between.
  const applyDefault = useCallback(
    async (variant: DesktopAppIconVariant, successText?: string) => {
      setBusy(true);
      try {
        const themedIcon = await renderThemedAppIcon(variant, colorId, resolvedTheme).catch(
          () => undefined,
        );
        await setDesktopAppIcon({
          variant,
          source: "default",
          ...(themedIcon ? { themedIcon } : {}),
        });
        if (successText) showStatus(successText);
      } catch {
        failed();
      } finally {
        setBusy(false);
      }
    },
    [colorId, failed, resolvedTheme, showStatus],
  );

  const handleTitleClick = useCallback(() => {
    if (!state || busy) return;
    const tap = registerSecretIconTap(tapsRef.current, performance.now());
    tapsRef.current = tap.taps;
    if (tap.toggled) {
      const unlocking = state.variant === "standard";
      void applyDefault(
        unlocking ? "dekai" : "standard",
        unlocking
          ? uiText("Secret icon unlocked.", undefined, undefined, uiLocale)
          : uiText("Default icon restored.", undefined, undefined, uiLocale),
      );
      return;
    }
    if (tap.remaining !== null) {
      showStatus(
        state.variant === "standard"
          ? uiText(
              "{count, plural, one {You''re # click away from unlocking a secret icon.} other {You''re # clicks away from unlocking a secret icon.}}",
              { count: tap.remaining },
              undefined,
              uiLocale,
            )
          : uiText(
              "{count, plural, one {You''re # click away from restoring the default icon.} other {You''re # clicks away from restoring the default icon.}}",
              { count: tap.remaining },
              undefined,
              uiLocale,
            ),
      );
    }
  }, [applyDefault, busy, showStatus, state, uiLocale]);

  const handleCustomFile = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.currentTarget.files?.[0];
      event.currentTarget.value = "";
      if (!file || !state) return;
      if (!APP_ICON_MIME_TYPES.has(file.type) || file.size > MAX_APP_ICON_SOURCE_BYTES) {
        showStatus(
          uiText("Choose a PNG, JPEG, or WebP image.", undefined, undefined, uiLocale),
          true,
        );
        return;
      }
      setBusy(true);
      try {
        let customIcon: Awaited<ReturnType<typeof renderAppIconPngs>>;
        try {
          customIcon = await renderAppIconPngs(file);
        } catch {
          showStatus(uiText("Could not read that image.", undefined, undefined, uiLocale), true);
          return;
        }
        await setDesktopAppIcon({ variant: state.variant, source: "custom", customIcon });
      } catch {
        failed();
      } finally {
        setBusy(false);
      }
    },
    [failed, showStatus, state, uiLocale],
  );

  if (!available) return null;

  const variant = state?.variant ?? "standard";
  const selectedSource = state?.source ?? "default";

  return (
    <SettingsSection title={uiText("App icon", undefined, undefined, uiLocale)}>
      <SettingsRow
        searchId="appearance.appIcon"
        title={
          <button
            type="button"
            className="cursor-default select-none outline-hidden focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring"
            onClick={handleTitleClick}
          >
            {uiText("Icon", undefined, "app icon setting", uiLocale)}
          </button>
        }
        description={uiText("Default follows the accent color.", undefined, undefined, uiLocale)}
        resetAction={
          state && (state.variant !== "standard" || state.source !== "default") && !busy ? (
            <SettingResetButton
              label={uiText("app icon", undefined, undefined, uiLocale)}
              onClick={() => void applyDefault("standard")}
            />
          ) : null
        }
        status={
          status ? (
            <span className={status.error ? "text-destructive-foreground" : undefined}>
              {status.text}
            </span>
          ) : null
        }
        control={
          <div className="flex items-start gap-4" aria-busy={busy}>
            <button
              type="button"
              aria-pressed={selectedSource === "default"}
              disabled={!state || busy}
              className="flex cursor-pointer flex-col items-center gap-1.5 text-2xs text-muted-foreground outline-hidden disabled:cursor-default aria-pressed:text-foreground focus-visible:[&>span]:ring-2 focus-visible:[&>span]:ring-ring"
              onClick={() => void applyDefault(variant)}
            >
              <span className={appIconTileClass(selectedSource === "default")}>
                <img
                  alt=""
                  className="size-full object-cover"
                  draggable={false}
                  src={themedAppIconUrl(variant, colorId, resolvedTheme)}
                />
              </span>
              {variant === "dekai"
                ? uiText("Dekai", undefined, "secret app icon name", uiLocale)
                : uiText("Default", undefined, "default app icon", uiLocale)}
            </button>
            <button
              type="button"
              aria-pressed={selectedSource === "custom"}
              disabled={!state || busy}
              className="flex cursor-pointer flex-col items-center gap-1.5 text-2xs text-muted-foreground outline-hidden disabled:cursor-default aria-pressed:text-foreground focus-visible:[&>span]:ring-2 focus-visible:[&>span]:ring-ring"
              onClick={() => {
                if (!state) return;
                // Without a stored icon, or when it is already in use, choose a new image.
                if (!customPreviewUrl || state.source === "custom") {
                  fileInputRef.current?.click();
                  return;
                }
                setBusy(true);
                void setDesktopAppIcon({ variant: state.variant, source: "custom" })
                  .catch(failed)
                  .finally(() => setBusy(false));
              }}
            >
              <span className={appIconTileClass(selectedSource === "custom")}>
                {busy ? (
                  <Spinner aria-hidden="true" className="size-4" />
                ) : customPreviewUrl ? (
                  <img
                    alt=""
                    className="size-full object-cover"
                    draggable={false}
                    src={customPreviewUrl}
                  />
                ) : (
                  <PlusIcon aria-hidden="true" className="size-5 text-subtle-foreground" />
                )}
              </span>
              {uiText("Custom", undefined, undefined, uiLocale)}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept={APP_ICON_ACCEPT}
              aria-label={uiText("App icon file", undefined, undefined, uiLocale)}
              className="sr-only"
              tabIndex={-1}
              onChange={(event) => void handleCustomFile(event)}
            />
          </div>
        }
      />
    </SettingsSection>
  );
}
