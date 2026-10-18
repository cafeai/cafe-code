import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, onTestFinished } from "vitest";

// Explicit native compiler qualification, with no applications or input lease.
it.skipIf(process.platform !== "darwin")(
  "qualifies native action evidence, accepted no-ops and partial dispatch without replay",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "cafe-glide-action-policy-"));
    let disposal: Promise<void> | undefined;
    const cleanup = () => (disposal ??= rm(directory, { recursive: true, force: true }));
    onTestFinished(cleanup);
    try {
      const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
      const executable = join(directory, "action-policy");
      const compiled = spawnSync(
        "xcrun",
        [
          "swiftc",
          "-target",
          `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macosx14.0`,
          join(root, "apps/desktop/native/mac-glide-action-policy.swift"),
          fileURLToPath(new URL("./fixtures/glide-action-policy.fixture.swift", import.meta.url)),
          "-o",
          executable,
        ],
        { shell: false, timeout: 30_000, encoding: "utf8" },
      );
      expect(compiled.error).toBeUndefined();
      expect(compiled.status, compiled.stderr).toBe(0);
      const result = spawnSync(executable, [], { shell: false, timeout: 10_000, encoding: "utf8" });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe("action-policy-qualified");
    } finally {
      await cleanup();
    }
  },
  60_000,
);
