import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it(
  "drains Effect finalizers after an actual Vitest timeout before starting the next case",
  () => {
    const fixtureTemp = mkdtempSync(join(tmpdir(), "cafe-effect-vitest-"));
    const vitestCli = join(
      dirname(fileURLToPath(import.meta.resolve("vitest/package.json"))),
      "vitest.mjs",
    );
    const fixtureConfig = fileURLToPath(
      new URL("./fixtures/effect-vitest-cancellation.config.ts", import.meta.url),
    );

    // This is an explicit opt-in child-runner qualification. Bound the child and
    // provide only OS/runtime essentials: no Node hooks, auth homes, credentials,
    // provider configuration or user-selected environment can reach the fixture.
    const fixtureEnvironment: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      TMPDIR: fixtureTemp,
      TEMP: fixtureTemp,
      TMP: fixtureTemp,
      NO_COLOR: "1",
      FORCE_COLOR: "0",
    };
    if (process.platform === "win32") {
      for (const name of ["SystemRoot", "WINDIR", "COMSPEC"]) {
        const value = process.env[name];
        if (value !== undefined) fixtureEnvironment[name] = value;
      }
    }

    try {
      const child = spawnSync(process.execPath, [vitestCli, "run", "--config", fixtureConfig], {
        cwd: dirname(fixtureConfig),
        env: fixtureEnvironment,
        encoding: "utf8",
        shell: false,
        timeout: process.platform === "win32" ? 45_000 : 30_000,
        maxBuffer: 1024 * 1024,
      });
      expect(child.error).toBeUndefined();
      // The first test intentionally times out; swallowing that failure would
      // incorrectly pass this qualification. Only its following case must pass.
      expect(child.status).toBe(1);
      const output = child.stdout + child.stderr;
      expect(output).toContain("Test timed out in 20ms");
      expect(output).toContain("FINALIZER_RETIRED");
      expect(output).toContain("NEXT_CASE_AFTER_RETIREMENT");
      expect(output).not.toContain("NEXT_CASE_BEFORE_RETIREMENT");
      expect(output).toMatch(/Tests\s+1 failed\s*\|\s*1 passed\s*\(2\)/u);
    } finally {
      // spawnSync has already observed the bounded child exit before cleanup.
      rmSync(fixtureTemp, { recursive: true, force: true });
    }
  },
  process.platform === "win32" ? 50_000 : 35_000,
);
