import { desktopSdlPrefix } from "./lib/desktopSdl.ts";
import { execFileSync } from "node:child_process";
import { mkdirSync, chmodSync, copyFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** Linux-only native resource. JS/package execution stays on Node/Corepack. */
export async function buildVirtualDesktopNative() {
  if (process.platform !== "linux") return;
  const root = fileURLToPath(new URL("../", import.meta.url));
  const source = path.join(root, "native/virtual-desktop");
  const generated = path.join(root, "build/virtual-desktop");
  const destination = path.join(root, "apps/server/dist/cafe-desktop-native");
  mkdirSync(generated, { recursive: true });
  mkdirSync(path.dirname(destination), { recursive: true });
  const prefix = await desktopSdlPrefix(generated);
  const flags = execFileSync(
    "pkg-config",
    [
      "--static",
      "--cflags",
      "--libs",
      "wayland-client",
      "sdl3",
      "libpng",
      "json-c",
      "xkbcommon",
      "xtst",
      "x11",
      "gbm",
      "egl",
      "glesv2",
      "pangocairo",
      "gio-2.0",
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PKG_CONFIG_PATH: [path.join(prefix, "lib/pkgconfig"), process.env.PKG_CONFIG_PATH]
          .filter(Boolean)
          .join(":"),
      },
    },
  )
    .trim()
    .split(/\s+/);
  const protocols = [
    "linux-dmabuf-v1",
    "wlr-screencopy-unstable-v1",
    "wlr-virtual-pointer-unstable-v1",
    "virtual-keyboard-unstable-v1",
  ];
  const objects: string[] = [];
  for (const name of protocols) {
    const xml = path.join(source, "protocols", `${name}.xml`);
    const code = path.join(generated, `${name}.c`);
    const object = path.join(generated, `${name}.o`);
    execFileSync(
      "wayland-scanner",
      ["client-header", xml, path.join(generated, `${name}-client-protocol.h`)],
      { stdio: "inherit" },
    );
    execFileSync("wayland-scanner", ["private-code", xml, code], { stdio: "inherit" });
    execFileSync("cc", ["-O2", "-c", code, "-o", object], { stdio: "inherit" });
    objects.push(object);
  }
  execFileSync(
    "c++",
    [
      "-std=c++20",
      "-O2",
      "-Wall",
      "-Wextra",
      "-Wno-unused-parameter",
      "-Wno-misleading-indentation",
      "-fstack-protector-strong",
      "-fPIE",
      "-pie",
      "-Wl,-z,relro,-z,now,-z,noexecstack",
      "-D_FORTIFY_SOURCE=2",
      "-I",
      generated,
      ...["main", "worker", "viewer", "session-services"].map((name) =>
        path.join(source, `${name}.cpp`),
      ),
      ...objects,
      ...flags,
      "-o",
      destination,
    ],
    { stdio: "inherit" },
  );
  chmodSync(destination, 0o755);
  const notices = path.join(path.dirname(destination), "cafe-desktop-licenses");
  mkdirSync(notices, { recursive: true });
  copyFileSync(path.join(prefix, "../source/LICENSE.txt"), path.join(notices, "SDL3.txt"));
  for (const name of protocols)
    copyFileSync(path.join(source, "protocols", `${name}.xml`), path.join(notices, `${name}.xml`));
}

if (import.meta.main) await buildVirtualDesktopNative();
