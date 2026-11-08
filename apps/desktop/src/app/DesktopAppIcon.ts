import {
  DESKTOP_APP_ICON_SIZE,
  MAX_DESKTOP_APP_ICON_PNG_BYTES,
  MAX_DESKTOP_APP_ICON_PREVIEW_BYTES,
  type DesktopAppIconState,
  type DesktopCustomAppIcon,
  type DesktopThemedAppIcon,
  type SetDesktopAppIconInput,
} from "@cafecode/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as Electron from "electron";
import { randomUUID } from "node:crypto";
// Native filesystem boundary: exclusive, no-follow, owner-only writes need flags Effect FileSystem does not expose.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { constants } from "node:fs";
// Native filesystem boundary: exclusive, no-follow, owner-only writes need flags Effect FileSystem does not expose.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
// Native path boundary: preserve host drive, namespace and separator semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { decodePng, type DecodedPngImage } from "../imageExport/PngExport.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopAssets from "./DesktopAssets.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

/**
 * This computer's app icon (Settings → Appearance → App icon).
 *
 * Electron can only replace the icon of the running app: the macOS Dock tile
 * (`app.dock.setIcon`) and Windows/Linux window icons (`BrowserWindow.setIcon`).
 * Finder, Launchpad, Start menu shortcuts and Linux launchers keep the icon
 * shipped in the signed app; rewriting the bundle would break code signing.
 *
 * Custom icons arrive as renderer-rendered PNG bytes, never as paths. They are
 * re-admitted with the strict PNG parser used for image export, decoded by
 * Electron, and stored as private files in Cafe's own data folder.
 */

const PREVIEW_SIZE = 176;
const MIN_CUSTOM_ICON_SIZE = 256;
const CUSTOM_ICON_DIRECTORY = "app-icon";
const CUSTOM_ICON_FILE = "custom.png";
const CUSTOM_MAC_ICON_FILE = "custom-macos.png";
// The built-in icon recolored by the renderer for the current accent color and
// theme. Stored like a custom icon so the next launch shows it immediately.
const THEMED_ICON_FILE = "themed.png";
const THEMED_MAC_ICON_FILE = "themed-macos.png";
const DEKAI_ICON_FILE = "icon-dekai.png";
const DEKAI_MAC_ICON_FILE = "icon-dekai-macos.png";

export class DesktopAppIconError extends Data.TaggedError("DesktopAppIconError")<{}> {
  override get message() {
    return "The app icon could not be changed.";
  }
}

export interface DesktopAppIconShape {
  /** Icon for the current choice: the Dock tile on macOS, the window icon elsewhere. */
  readonly effectiveIconPath: Effect.Effect<Option.Option<string>>;
  readonly getState: Effect.Effect<DesktopAppIconState>;
  readonly setIcon: (
    input: SetDesktopAppIconInput,
  ) => Effect.Effect<DesktopAppIconState, DesktopAppIconError>;
}

export class DesktopAppIcon extends Context.Service<DesktopAppIcon, DesktopAppIconShape>()(
  "cafecode/desktop/AppIcon",
) {}

const decodeNativeImage = (data: Buffer) => Electron.nativeImage.createFromBuffer(data);

/** Admits one custom icon PNG: strict structure, square, bounded size, decodable. */
export function admitCustomIconPng(
  png: Uint8Array,
  decode: (data: Buffer) => DecodedPngImage = decodeNativeImage,
): Buffer {
  if (png.byteLength > MAX_DESKTOP_APP_ICON_PNG_BYTES) throw new DesktopAppIconError();
  try {
    const { bytes, image } = decodePng(png, decode);
    const { width, height } = image.getSize();
    if (width !== height || width < MIN_CUSTOM_ICON_SIZE || width > DESKTOP_APP_ICON_SIZE) {
      throw new DesktopAppIconError();
    }
    return bytes;
  } catch {
    throw new DesktopAppIconError();
  }
}

/** A Cafe-owned regular file, never a symlink, within the PNG byte bound. */
async function readableIconFile(path: string): Promise<boolean> {
  try {
    const stats = await lstat(path);
    return (
      stats.isFile() && !stats.isSymbolicLink() && stats.size <= MAX_DESKTOP_APP_ICON_PNG_BYTES
    );
  } catch {
    return false;
  }
}

/**
 * Writes through an exclusive, no-follow, owner-only temporary file and then
 * renames it into place, so a partial write never replaces a stored icon.
 */
export async function writePrivateIconFile(directory: string, fileName: string, bytes: Buffer) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.${fileName}.${randomUUID()}.tmp`);
  const handle = await open(
    temporary,
    // O_NOFOLLOW is POSIX-only; on Windows the flag is undefined and ignored.
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  await handle.close();
  try {
    await rename(temporary, join(directory, fileName));
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const assets = yield* DesktopAssets.DesktopAssets;
  const settings = yield* DesktopAppSettings.DesktopAppSettings;
  const electronApp = yield* ElectronApp.ElectronApp;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const mutex = yield* Semaphore.make(1);

  const isMac = environment.platform === "darwin";
  const customDirectory = join(environment.stateDir, CUSTOM_ICON_DIRECTORY);
  const customIconPath = join(customDirectory, isMac ? CUSTOM_MAC_ICON_FILE : CUSTOM_ICON_FILE);

  const hasCustomIcon = Effect.promise(() => readableIconFile(customIconPath));
  const themedIconPath = join(customDirectory, isMac ? THEMED_MAC_ICON_FILE : THEMED_ICON_FILE);

  const standardIconPath = Effect.gen(function* () {
    const iconPaths = yield* assets.iconPaths;
    if (environment.platform === "win32") return iconPaths.ico;
    return iconPaths.png;
  });

  const variantIconPath = (variant: DesktopAppIconState["variant"]) =>
    Effect.gen(function* () {
      if (variant === "dekai") {
        const dekai = yield* assets.resolveResourcePath(
          isMac ? DEKAI_MAC_ICON_FILE : DEKAI_ICON_FILE,
        );
        if (Option.isSome(dekai)) return dekai;
      }
      return yield* standardIconPath;
    });

  const effectiveIconPath = Effect.gen(function* () {
    const current = yield* settings.get;
    if (current.appIconSource === "custom" && (yield* hasCustomIcon)) {
      return Option.some(customIconPath);
    }
    // Use the stored themed rendering only while it belongs to the current variant.
    if (
      current.appIconThemedKey?.startsWith(`${current.appIconVariant}-`) &&
      (yield* Effect.promise(() => readableIconFile(themedIconPath)))
    ) {
      return Option.some(themedIconPath);
    }
    return yield* variantIconPath(current.appIconVariant);
  }).pipe(Effect.withSpan("desktop.appIcon.effectiveIconPath"));

  const applyToRunningApp = Effect.gen(function* () {
    const iconPath = yield* effectiveIconPath;
    if (Option.isNone(iconPath)) return;
    if (isMac) {
      yield* electronApp.setDockIcon(iconPath.value);
      return;
    }
    yield* electronWindow.syncAllAppearance((window) =>
      Effect.sync(() => {
        if (!window.isDestroyed()) window.setIcon(iconPath.value);
      }),
    );
  }).pipe(
    // A native refusal leaves the previous icon visible; the saved choice is retried next launch.
    Effect.catchCause(() => Effect.logWarning("Could not apply the app icon to the running app.")),
  );

  const customPreview = Effect.promise(async (): Promise<Uint8Array | null> => {
    const sourcePath = join(customDirectory, CUSTOM_ICON_FILE);
    if (!(await readableIconFile(sourcePath))) return null;
    try {
      const bytes = await readFile(sourcePath);
      const { image } = decodePng(bytes, decodeNativeImage);
      const preview = image.resize({ width: PREVIEW_SIZE, height: PREVIEW_SIZE, quality: "best" });
      const png = new Uint8Array(preview.toPNG());
      return png.byteLength > 0 && png.byteLength <= MAX_DESKTOP_APP_ICON_PREVIEW_BYTES
        ? png
        : null;
    } catch {
      return null;
    }
  });

  const getState = Effect.gen(function* () {
    const current = yield* settings.get;
    const preview = yield* customPreview;
    return {
      variant: current.appIconVariant,
      // A missing or damaged custom file must not leave the UI claiming it is in use.
      source: current.appIconSource === "custom" && preview !== null ? "custom" : "default",
      themedIconKey: current.appIconThemedKey,
      customIconPreviewPng: preview,
    } satisfies DesktopAppIconState;
  }).pipe(Effect.withSpan("desktop.appIcon.getState"));

  const storeCustomIcon = (icon: DesktopCustomAppIcon) =>
    Effect.tryPromise({
      try: async () => {
        const png = admitCustomIconPng(icon.png);
        const macPng = admitCustomIconPng(icon.macPng);
        await writePrivateIconFile(customDirectory, CUSTOM_ICON_FILE, png);
        await writePrivateIconFile(customDirectory, CUSTOM_MAC_ICON_FILE, macPng);
      },
      catch: () => new DesktopAppIconError(),
    });

  const storeThemedIcon = (icon: DesktopThemedAppIcon) =>
    Effect.tryPromise({
      try: async () => {
        const png = admitCustomIconPng(icon.png);
        const macPng = admitCustomIconPng(icon.macPng);
        await writePrivateIconFile(customDirectory, THEMED_ICON_FILE, png);
        await writePrivateIconFile(customDirectory, THEMED_MAC_ICON_FILE, macPng);
      },
      catch: () => new DesktopAppIconError(),
    });

  const setIcon = (input: SetDesktopAppIconInput) =>
    mutex
      .withPermits(1)(
        Effect.gen(function* () {
          if (input.customIcon) yield* storeCustomIcon(input.customIcon);
          if (input.themedIcon) yield* storeThemedIcon(input.themedIcon);
          if (input.source === "custom" && !(yield* hasCustomIcon)) {
            return yield* new DesktopAppIconError();
          }
          yield* settings
            .setAppIcon({
              variant: input.variant,
              source: input.source,
              ...(input.themedIcon ? { themedKey: input.themedIcon.key } : {}),
            })
            .pipe(Effect.mapError(() => new DesktopAppIconError()));
          yield* applyToRunningApp;
          return yield* getState;
        }),
      )
      .pipe(
        Effect.withSpan("desktop.appIcon.setIcon", {
          attributes: {
            variant: input.variant,
            source: input.source,
            replacesCustomIcon: input.customIcon !== undefined,
            ...(input.themedIcon ? { themedKey: input.themedIcon.key } : {}),
          },
        }),
      );

  return DesktopAppIcon.of({ effectiveIconPath, getState, setIcon });
});

export const layer = Layer.effect(DesktopAppIcon, make);
