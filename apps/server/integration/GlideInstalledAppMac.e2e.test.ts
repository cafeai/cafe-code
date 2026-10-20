// Native fixture owns exact child argv, stdio handles and retirement; keep that process boundary.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { execFile } from "node:child_process";
// Native fixture exercises actual file identity, namespace and cleanup behavior.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
// Native fixture paths retain host drive, separator and namespace semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it, onTestFinished } from "vitest";
import { createGlideNativePeer, type GlideNativePeer } from "../src/glide/nativeHost.ts";
import { actionReceiptSchema, installedAppSchema } from "../src/glide/protocol.ts";
import { GlideChild, glideChildEnvironment } from "../src/glide/runtime.ts";

// Real native helper metadata only. No GUI application, capture, accessibility
// input, global Launch Services registration or desktop input lease is used.
it.skipIf(process.platform !== "darwin")(
  "resolves a stopped private installation and refuses substitution/native launch arguments",
  async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "glide-installed-")));
    let peer: GlideNativePeer | undefined;
    let legacy: GlideChild | undefined;
    let disposal: Promise<void> | undefined;
    const cleanup = () =>
      (disposal ??= (async () => {
        await legacy?.stop();
        await peer?.close();
        await rm(directory, { recursive: true, force: true });
      })());
    onTestFinished(cleanup);
    try {
      const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
      const helper = join(root, "apps/desktop/native/build", process.arch, "mac-glide");
      const id = "com.cafecode.glide-stopped-fixture";
      const bundles = [
        join(directory, "Stopped App.app"),
        join(directory, "Other Installation.app"),
      ];
      for (const bundle of bundles) {
        await mkdir(join(bundle, "Contents", "MacOS"), { recursive: true });
        await writeFile(
          join(bundle, "Contents", "Info.plist"),
          `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${id}</string><key>CFBundleExecutable</key><string>Fixture</string><key>CFBundleName</key><string>Stopped Fixture</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`,
        );
        // A native executable exists solely for Bundle metadata validation; none
        // of these test paths ever invokes it or an application launch operation.
        await copyFile(process.execPath, join(bundle, "Contents", "MacOS", "Fixture"));
      }
      const result = await promisify(execFile)(helper, ["--resolve-app", bundles[0]!], {
        timeout: 5000,
        maxBuffer: 4096,
        shell: false,
        env: glideChildEnvironment(process.env),
      });
      const expected = installedAppSchema.parse(JSON.parse(result.stdout));
      expect(expected).toMatchObject({ name: "Stopped Fixture", bundleId: id });
      // Foundation may represent Darwin's /private/var alias as /var. Prove the
      // exact owned directory, then retain the native representation verbatim.
      expect(await realpath(expected.path)).toBe(bundles[0]);
      peer = createGlideNativePeer(helper, [id], [{ bundleId: id, path: expected.path }]);
      const request = (method: string, input: unknown) =>
        peer!.request({ method, input, timeout_ms: 1000 });
      expect(await request("resolve_app", { app: expected.path })).toEqual(expected);
      const legacyReply = Promise.withResolvers<{ error?: string; result?: unknown }>();
      legacy = new GlideChild(
        helper,
        ["--input-mode", "background", "--allow-app", id, "--allow-app-path", expected.path],
        (value) => legacyReply.resolve(value as { error?: string; result?: unknown }),
        () => legacyReply.reject(new Error("Legacy native peer stopped before its refusal.")),
      );
      await legacy.send({
        id: 1,
        method: "launch_app",
        input: { app: expected.path, arguments: ["forbidden"] },
        timeout_ms: 1000,
      });
      const refused = await legacyReply.promise;
      expect(refused.error).toBe("Invalid Glide method or arguments.");
      expect(refused.result).toBeUndefined();
      await expect(request("resolve_app", { app: bundles[1] })).rejects.toThrow("exact app grant");
      const invalid = actionReceiptSchema.parse(
        await request("launch_app", {
          app: bundles[0],
          arguments: ["must-not-run"],
          environment: { SECRET: "must-not-forward" },
        }),
      );
      expect(invalid).toMatchObject({
        status: "refused",
        dispatch: "not-dispatched",
        progress: { axAttempted: 0, eventsPosted: 0 },
      });
      expect(JSON.stringify(invalid)).not.toContain("must-not");
      expect(await request("resolve_app", { app: expected.path })).toEqual(expected);
    } finally {
      await cleanup();
    }
  },
  30_000,
);
