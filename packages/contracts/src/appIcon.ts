import * as Schema from "effect/Schema";

/**
 * Desktop app icon chosen on this computer. The renderer may only pick between
 * finite built-in variants or hand over a custom icon it has already rendered
 * to PNG; the desktop main process independently admits those bytes, stores
 * them privately in its own data folder and never accepts a filesystem path.
 *
 * - `variant`: which built-in icon "Default" means. `dekai` is the hidden
 *   alternative unlocked from Settings.
 * - `source`: `custom` uses the stored custom icon, `default` the variant.
 */
export const DesktopAppIconVariantSchema = Schema.Literals(["standard", "dekai"]);
export type DesktopAppIconVariant = typeof DesktopAppIconVariantSchema.Type;

export const DesktopAppIconSourceSchema = Schema.Literals(["default", "custom"]);
export type DesktopAppIconSource = typeof DesktopAppIconSourceSchema.Type;

/** Custom icons are rendered to this square size before crossing IPC. */
export const DESKTOP_APP_ICON_SIZE = 1024;
/** Upper bound for one square 1024 px RGBA PNG plus headroom. */
export const MAX_DESKTOP_APP_ICON_PNG_BYTES = 8 * 1024 * 1024;
/** Upper bound for the small preview the desktop returns for the custom tile. */
export const MAX_DESKTOP_APP_ICON_PREVIEW_BYTES = 512 * 1024;

const DesktopAppIconPngSchema = Schema.Uint8Array.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_DESKTOP_APP_ICON_PNG_BYTES),
);

export const DesktopCustomAppIconSchema = Schema.Struct({
  /** Full-bleed square artwork, used for Windows/Linux window icons. */
  png: DesktopAppIconPngSchema,
  /** The same artwork on the macOS Dock tile (832/1024 rounded inset). */
  macPng: DesktopAppIconPngSchema,
});
export type DesktopCustomAppIcon = typeof DesktopCustomAppIconSchema.Type;

/**
 * Names one built-in icon colored to match the accent color and theme, for
 * example `standard-blue-dark`. Opaque to the desktop beyond this shape: it only
 * records which rendering is stored so the renderer can skip redundant updates.
 */
export const DesktopThemedAppIconKeySchema = Schema.String.check(
  Schema.isPattern(/^(?:standard|dekai)-[a-z]{1,16}-(?:dark|light)$/u),
);

export const DesktopThemedAppIconSchema = Schema.Struct({
  key: DesktopThemedAppIconKeySchema,
  png: DesktopAppIconPngSchema,
  macPng: DesktopAppIconPngSchema,
});
export type DesktopThemedAppIcon = typeof DesktopThemedAppIconSchema.Type;

export const SetDesktopAppIconInputSchema = Schema.Struct({
  variant: DesktopAppIconVariantSchema,
  source: DesktopAppIconSourceSchema,
  /** Replaces the stored custom icon. Required when choosing `custom` without one. */
  customIcon: Schema.optionalKey(DesktopCustomAppIconSchema),
  /** The built-in icon recolored for the current accent color and theme. */
  themedIcon: Schema.optionalKey(DesktopThemedAppIconSchema),
});
export type SetDesktopAppIconInput = typeof SetDesktopAppIconInputSchema.Type;

export const DesktopAppIconStateSchema = Schema.Struct({
  variant: DesktopAppIconVariantSchema,
  source: DesktopAppIconSourceSchema,
  /** Which themed rendering of the built-in icon is stored, or null for the shipped one. */
  themedIconKey: Schema.NullOr(DesktopThemedAppIconKeySchema),
  /** Small PNG of the stored custom icon, or null when none is stored. */
  customIconPreviewPng: Schema.NullOr(
    Schema.Uint8Array.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(MAX_DESKTOP_APP_ICON_PREVIEW_BYTES),
    ),
  ),
});
export type DesktopAppIconState = typeof DesktopAppIconStateSchema.Type;
