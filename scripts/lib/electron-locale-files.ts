// Only a fresh launcher-owned Electron copy reaches this boundary. Native
// lstat checks reject linked locale entries before deleting that exact copy;
// installed Electron and held older runtime generations remain untouched.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { lstatSync, readdirSync, rmSync } from "node:fs";
// Locale paths must agree with the native copied bundle on every platform.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";
import { DESKTOP_ELECTRON_LANGUAGES } from "./desktop-runtime-files.ts";

export function pruneCopiedElectronLocales(directory: string, platform: NodeJS.Platform): void {
  const root = lstatSync(directory);
  if (!root.isDirectory() || root.isSymbolicLink())
    throw new Error("Invalid copied Electron runtime.");
  const directories =
    platform === "darwin"
      ? [
          join(directory, "Contents/Resources"),
          join(directory, "Contents/Frameworks/Electron Framework.framework/Versions/A/Resources"),
        ]
      : platform === "linux" || platform === "win32"
        ? [join(directory, "locales")]
        : [];
  if (directories.length === 0) throw new Error("Unsupported Electron locale layout.");
  const keep = new Set(
    DESKTOP_ELECTRON_LANGUAGES.map((language) => language.toLowerCase().replaceAll("_", "-")),
  );
  const extension = platform === "darwin" ? ".lproj" : ".pak";
  for (const current of directories) {
    const metadata = lstatSync(current);
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
      throw new Error("Invalid copied Electron locale directory.");
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (!entry.name.endsWith(extension)) continue;
      const filename = join(current, entry.name);
      const metadata = lstatSync(filename);
      if (
        metadata.isSymbolicLink() ||
        (platform === "darwin"
          ? !metadata.isDirectory()
          : !metadata.isFile() || metadata.nlink !== 1)
      )
        throw new Error("Linked or unsupported copied Electron locale.");
      const language = entry.name.slice(0, -extension.length).toLowerCase().replaceAll("_", "-");
      if (!keep.has(language)) rmSync(filename, { recursive: platform === "darwin" });
    }
  }
}
