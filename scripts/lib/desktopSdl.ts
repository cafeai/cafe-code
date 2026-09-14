import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import * as path from "node:path";

// Official release asset digest, not a mutable branch/archive URL:
// https://github.com/libsdl-org/SDL/releases/tag/release-3.4.14
export const DESKTOP_SDL_VERSION = "3.4.14";
const SHA256 = "30d4aa2b3037718142b32dffd4e72f917ebb6cc5227150e7bb9c45efb2153aeb";
export async function desktopSdlPrefix(buildRoot: string): Promise<string> {
  const root = path.join(buildRoot, `SDL-${DESKTOP_SDL_VERSION}-minimal-v1`);
  const prefix = path.join(root, "installed");
  if (existsSync(path.join(prefix, "lib/libSDL3.a"))) return prefix;
  mkdirSync(root, { recursive: true });
  const response = await fetch(
    `https://github.com/libsdl-org/SDL/releases/download/release-${DESKTOP_SDL_VERSION}/SDL3-${DESKTOP_SDL_VERSION}.tar.gz`,
    { signal: AbortSignal.timeout(60_000) },
  );
  if (!response.ok || Number(response.headers.get("content-length")) > 32 * 1024 * 1024)
    throw new Error("Could not download the pinned SDL source.");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (
    bytes.length > 32 * 1024 * 1024 ||
    createHash("sha256").update(bytes).digest("hex") !== SHA256
  )
    throw new Error("Pinned SDL source digest mismatch.");
  const archive = path.join(root, "source.tar.gz");
  writeFileSync(archive, bytes);
  const source = path.join(root, "source");
  mkdirSync(source, { recursive: true });
  execFileSync("tar", ["-xzf", archive, "--strip-components=1", "-C", source], {
    stdio: "inherit",
  });
  const build = path.join(root, "build");
  execFileSync(
    "cmake",
    [
      "-S",
      source,
      "-B",
      build,
      "-DCMAKE_BUILD_TYPE=Release",
      `-DCMAKE_INSTALL_PREFIX=${prefix}`,
      "-DCMAKE_INSTALL_LIBDIR=lib",
      "-DSDL_SHARED=OFF",
      "-DSDL_STATIC=ON",
      "-DSDL_TESTS=OFF",
      "-DSDL_EXAMPLES=OFF",
      "-DSDL_AUDIO=OFF",
      "-DSDL_JOYSTICK=OFF",
      "-DSDL_HAPTIC=OFF",
      "-DSDL_CAMERA=OFF",
      "-DSDL_SENSOR=OFF",
      "-DSDL_X11=ON",
      "-DSDL_WAYLAND=ON",
    ],
    { stdio: "inherit" },
  );
  execFileSync(
    "cmake",
    ["--build", build, "--parallel", String(Math.min(8, availableParallelism()))],
    { stdio: "inherit" },
  );
  execFileSync("cmake", ["--install", build], { stdio: "inherit" });
  return prefix;
}
