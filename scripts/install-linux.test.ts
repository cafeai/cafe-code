// These boundaries run the exact installer against test-owned files and synthetic
// curl/uname peers. They never download or execute Cafe or a provider runtime.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const installer = resolve(import.meta.dirname, "install-linux.sh");
const roots: string[] = [];
const releases = "https://github.com/cafeai/cafe-code/releases";
const syntheticApp =
  '#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "$CAFE_FIXTURE_LAUNCH"\nprintf "%s" "${ELECTRON_RUN_AS_NODE:-}:${CAFE_CODE_DESKTOP_DEV:-}" >> "$CAFE_FIXTURE_LAUNCH"\n';

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cafe-linux-installer-")));
  roots.push(root);
  const home = join(root, "user home");
  const peers = join(root, "peers");
  const data = join(home, "data files");
  const install = join(data, "cafe-code-desktop");
  const launcher = join(home, ".local/bin/cafe-code");
  const desktop = join(data, "applications/cafe-code-appimage.desktop");
  const appImage = join(install, "Cafe-Code.AppImage");
  const digest = createHash("sha256").update(syntheticApp).digest("hex");
  const sums = `${digest}  Cafe-Code-1.2.3-x86_64.AppImage\n`;
  await mkdir(home);
  await mkdir(peers);
  await writeFile(join(root, "app"), syntheticApp);
  await writeFile(join(root, "sums"), sums);
  await writeFile(
    join(peers, "uname"),
    '#!/usr/bin/env bash\ncase "$1" in -s) printf "%s" "${CAFE_FIXTURE_OS:-Linux}";; -m) printf "%s" "${CAFE_FIXTURE_ARCH:-x86_64}";; esac\n',
  );
  await writeFile(
    join(peers, "curl"),
    `#!/usr/bin/env bash
set -euo pipefail
output=''
url=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output) output=$2; shift ;;
    https://*) url=$1 ;;
  esac
  shift
done
printf '%s\\n' "$url" >> "$CAFE_FIXTURE_ROOT/requests"
case "$url" in
  */latest) printf '%s' "\${CAFE_FIXTURE_LATEST:-${releases}/tag/v1.2.3}" ;;
  */download/v1.2.3/SHA256SUMS.txt) cat "$CAFE_FIXTURE_ROOT/sums" > "$output" ;;
  */download/v1.2.3/Cafe-Code-1.2.3-x86_64.AppImage)
    [[ \${CAFE_FIXTURE_DOWNLOAD_FAIL:-} != 1 ]] || exit 22
    cat "$CAFE_FIXTURE_ROOT/app" > "$output" ;;
  *) printf 'Unexpected URL' >&2; exit 99 ;;
esac
`,
  );
  await chmod(join(peers, "uname"), 0o755);
  await chmod(join(peers, "curl"), 0o755);
  const env: NodeJS.ProcessEnv = {
    PATH: `${peers}:${process.env.PATH}`,
    HOME: home,
    XDG_DATA_HOME: data,
    CAFE_FIXTURE_ROOT: root,
    CAFE_FIXTURE_LAUNCH: join(root, "launched"),
  };
  const run = (
    args: string[] = [installer],
    extra: NodeJS.ProcessEnv = {},
    stdin?: string,
  ): Promise<{ code: number; stdout: string; stderr: string }> =>
    new Promise((resolveResult) => {
      const child = execFile(
        "bash",
        args,
        { env: { ...env, ...extra }, timeout: 10_000 },
        (error, stdout, stderr) => {
          resolveResult({
            code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
            stdout,
            stderr,
          });
        },
      );
      child.stdin?.end(stdin);
    });
  return { root, home, data, install, launcher, desktop, appImage, sums, env, run };
}

describe.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
  "Linux user installer (synthetic release transport)",
  () => {
    it("bootstraps from stdin, pins both downloads to one stable tag and launches with literal arguments", async () => {
      const f = await fixture();
      const result = await f.run([], {}, await readFile(installer, "utf8"));
      expect(result.code, result.stderr).toBe(0);
      expect(await readFile(f.appImage, "utf8")).toBe(syntheticApp);
      expect((await lstat(f.appImage)).mode & 0o777).toBe(0o755);
      expect(await readFile(f.desktop, "utf8")).toContain(`Exec="${f.launcher}" %U`);
      expect(await readdir(f.install)).toEqual(["Cafe-Code.AppImage"]);
      expect(await readFile(join(f.root, "requests"), "utf8")).toBe(
        `${releases}/latest\n${releases}/download/v1.2.3/SHA256SUMS.txt\n${releases}/download/v1.2.3/Cafe-Code-1.2.3-x86_64.AppImage\n`,
      );
      await expect(lstat(join(f.root, "launched"))).rejects.toMatchObject({ code: "ENOENT" });
      const launch = await f.run([f.launcher, "a b", "$(never-execute)", "--flag"], {
        ELECTRON_RUN_AS_NODE: "1",
        CAFE_CODE_DESKTOP_DEV: "1",
      });
      expect(launch.code, launch.stderr).toBe(0);
      expect(await readFile(join(f.root, "launched"), "utf8")).toBe(
        "a b\n$(never-execute)\n--flag\n:",
      );
    });

    it("updates the same versionless target and verifies an identical release without replacing its inode", async () => {
      const f = await fixture();
      expect((await f.run()).code).toBe(0);
      const before = await lstat(f.appImage);
      expect((await f.run([f.launcher, "up"])).code).toBe(0);
      expect((await lstat(f.appImage)).ino).toBe(before.ino);
      const updatedApp = `${syntheticApp}# updated\n`;
      await writeFile(join(f.root, "app"), updatedApp);
      await writeFile(
        join(f.root, "sums"),
        `${createHash("sha256").update(updatedApp).digest("hex")}  Cafe-Code-1.2.3-x86_64.AppImage\n`,
      );
      expect((await f.run([f.launcher, "up"])).code).toBe(0);
      expect(await readFile(f.appImage, "utf8")).toBe(updatedApp);
      await expect(lstat(join(f.root, "launched"))).rejects.toMatchObject({ code: "ENOENT" });
    });

    it.each(["checksum", "duplicate", "missing", "download"])(
      "preserves an existing installation after %s failure and retires staging",
      async (failure) => {
        const f = await fixture();
        expect((await f.run()).code).toBe(0);
        const launcher = await readFile(f.launcher, "utf8");
        const desktop = await readFile(f.desktop, "utf8");
        if (failure === "checksum") await writeFile(join(f.root, "app"), "corrupt");
        if (failure === "duplicate") await writeFile(join(f.root, "sums"), f.sums.repeat(2));
        if (failure === "missing")
          await writeFile(join(f.root, "sums"), f.sums.replace("x86_64", "arm64"));
        const result = await f.run([f.launcher, "up"], {
          CAFE_FIXTURE_DOWNLOAD_FAIL: failure === "download" ? "1" : "",
        });
        expect(result.code).not.toBe(0);
        expect(await readFile(f.appImage, "utf8")).toBe(syntheticApp);
        expect(await readFile(f.launcher, "utf8")).toBe(launcher);
        expect(await readFile(f.desktop, "utf8")).toBe(desktop);
        expect(await readdir(f.install)).toEqual(["Cafe-Code.AppImage"]);
      },
    );

    it.each([
      `${releases}/tag/v1.2.3-nightly.20261025.1`,
      "https://example.com/tag/v1.2.3",
      `${releases}/tag/v1.2.3/../../bad`,
    ])("refuses an unqualified latest URL %s before requesting payloads", async (latest) => {
      const f = await fixture();
      expect((await f.run([installer], { CAFE_FIXTURE_LATEST: latest })).code).not.toBe(0);
      expect(await readFile(join(f.root, "requests"), "utf8")).toBe(`${releases}/latest\n`);
      expect(await readdir(f.install)).toEqual([]);
    });

    it("refuses another install reservation without deleting its lock", async () => {
      const f = await fixture();
      await mkdir(join(f.install, "up.lock"), { recursive: true });
      const result = await f.run();
      expect(result.stderr).toContain("Another install is reserved");
      expect((await lstat(join(f.install, "up.lock"))).isDirectory()).toBe(true);
      await expect(lstat(join(f.root, "requests"))).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("refuses unrelated launchers and symlink targets without changing their contents", async () => {
      const f = await fixture();
      await mkdir(join(f.home, ".local/bin"), { recursive: true });
      await writeFile(f.launcher, "another installation");
      expect((await f.run()).stderr).toContain("unrelated");
      expect(await readFile(f.launcher, "utf8")).toBe("another installation");
      await rm(f.launcher);
      const outside = join(f.root, "outside");
      await writeFile(outside, "preserve");
      await symlink(outside, f.appImage);
      expect((await f.run()).stderr).toContain("symbolic links");
      expect(await readFile(outside, "utf8")).toBe("preserve");
      await rm(f.appImage);
      await mkdir(join(f.root, "other-data"));
      await rm(f.data, { recursive: true });
      await symlink(join(f.root, "other-data"), f.data);
      expect((await f.run()).stderr).toContain("symbolic links");
      expect(await readdir(join(f.root, "other-data"))).toEqual([]);
    });

    it.each([
      { CAFE_FIXTURE_ARCH: "aarch64" },
      { CAFE_FIXTURE_OS: "Darwin" },
      { XDG_DATA_HOME: "relative" },
    ])("rejects unsupported hosts or paths before network access: %j", async (env) => {
      const f = await fixture();
      expect((await f.run([installer], env)).code).not.toBe(0);
      await expect(lstat(join(f.root, "requests"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  },
);
