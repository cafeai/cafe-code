// Native fixture owns exact child argv, stdio handles and retirement; keep that process boundary.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { spawnSync } from "node:child_process";
// Native fixture exercises actual file identity, namespace and cleanup behavior.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
// Native fixture paths retain host drive, separator and namespace semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, onTestFinished } from "vitest";

// The native resolver is linked but never called. This executable exercises
// immutable preproof and notification policies without AX, GUI, or event taps.
it.skipIf(process.platform !== "darwin")(
  "qualifies exact auxiliary preproof and successful-release focus lifecycle",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "cafe-glide-incoming-focus-policy-"));
    let cleanupPromise: Promise<void> | undefined;
    const cleanup = () => (cleanupPromise ??= rm(directory, { recursive: true, force: true }));
    onTestFinished(cleanup);
    try {
      const executable = join(directory, "incoming-focus-policy");
      const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
      const compiler = spawnSync(
        "xcrun",
        [
          "swiftc",
          "-target",
          `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macosx14.0`,
          join(root, "apps/desktop/native/mac-glide-focus-policy.swift"),
          join(root, "apps/desktop/native/mac-glide-incoming-focus.swift"),
          fileURLToPath(
            new URL("./fixtures/glide-incoming-focus-policy.fixture.swift", import.meta.url),
          ),
          "-o",
          executable,
        ],
        { shell: false, timeout: 30_000, encoding: "utf8" },
      );
      expect(compiler.error).toBeUndefined();
      expect(compiler.status, compiler.stderr).toBe(0);
      const result = spawnSync(executable, [], { shell: false, timeout: 10_000, encoding: "utf8" });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe("glide-incoming-focus-policy-qualified");
    } finally {
      await cleanup();
    }
  },
  60_000,
);
