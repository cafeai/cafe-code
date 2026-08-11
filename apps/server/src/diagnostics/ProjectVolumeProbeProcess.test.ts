// @effect-diagnostics nodeBuiltinImport:off globalTimers:off

import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildProjectVolumeProbeEnvironment,
  makeProjectVolumeProbeProcess,
  makeProjectVolumeProbeProcessForTest,
} from "./ProjectVolumeProbeProcess.ts";

describe("ProjectVolumeProbeProcess", () => {
  it("reads the current project volume through the isolated helper", async () => {
    const probe = makeProjectVolumeProbeProcess();
    try {
      const counters = await probe.read(process.cwd(), 2_000);

      expect(counters.blockSize).toBeGreaterThan(0n);
      expect(counters.blocks).toBeGreaterThan(0n);
      expect(counters.freeBlocks).toBeGreaterThanOrEqual(counters.availableBlocks);
      expect(counters.blocks).toBeGreaterThanOrEqual(counters.freeBlocks);
    } finally {
      await probe.close();
    }
  });

  it("returns a bounded sanitized failure for a missing private path", async () => {
    const probe = makeProjectVolumeProbeProcess();
    const privatePath = join(process.cwd(), "private-telemetry-path-that-does-not-exist");
    try {
      const error = await probe.read(privatePath, 2_000).catch((cause: unknown) => cause);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("Project-volume probe failed.");
      expect((error as Error).message).not.toContain(privatePath);
      expect((error as Error).stack ?? "").not.toContain(privatePath);
    } finally {
      await probe.close();
    }
  });

  it("passes only the runtime environment needed by a packaged helper", () => {
    const environment = buildProjectVolumeProbeEnvironment({
      PATH: "test-path",
      SystemRoot: "test-system-root",
      TEMP: "test-temp",
      NODE_OPTIONS: "--require private-hook.cjs",
      ANTHROPIC_API_KEY: "private-claude-key",
      OPENAI_API_KEY: "private-openai-key",
    });

    expect(environment).toEqual({
      PATH: "test-path",
      SystemRoot: "test-system-root",
      TEMP: "test-temp",
      ELECTRON_RUN_AS_NODE: "1",
    });
    expect(JSON.stringify(environment)).not.toContain("private");
  });

  it("kills a helper that ignores the child-owned deadline and settles only after close", async () => {
    const probe = makeProjectVolumeProbeProcessForTest({
      probeScript: "process.stdin.resume(); setInterval(() => undefined, 1000);",
      parentKillGraceMs: 20,
    });
    const startedAt = performance.now();

    const error = await probe.read(process.cwd(), 20).catch((cause: unknown) => cause);
    const elapsedMs = performance.now() - startedAt;

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Project-volume probe failed.");
    expect(elapsedMs).toBeGreaterThanOrEqual(25);
    await probe.close();
  });

  it("kills and awaits every live helper during owner shutdown", async () => {
    const probe = makeProjectVolumeProbeProcessForTest({
      probeScript: "process.stdin.resume(); setInterval(() => undefined, 1000);",
    });
    const pending = probe.read(process.cwd(), 10_000).catch((cause: unknown) => cause);
    await new Promise((resolve) => setTimeout(resolve, 25));

    await probe.close();
    const error = await pending;

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Project-volume probe failed.");
    await expect(probe.read(process.cwd(), 20)).rejects.toThrow("Project-volume probe failed.");
  });

  it("bounds owner shutdown when a helper does not acknowledge termination", async () => {
    let killCount = 0;
    const probe = makeProjectVolumeProbeProcessForTest({
      probeScript: `
        process.stdin.resume();
        setTimeout(() => process.exit(1), 100);
        setInterval(() => undefined, 1000);
      `,
      shutdownCloseGraceMs: 10,
      killProcess: () => {
        killCount += 1;
        return false;
      },
    });
    const pending = probe.read(process.cwd(), 1_000).catch((cause: unknown) => cause);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const startedAt = performance.now();

    await probe.close();
    const closeElapsedMs = performance.now() - startedAt;

    expect(closeElapsedMs).toBeLessThan(75);
    await probe.close();
    expect(killCount).toBe(1);
    const error = await pending;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Project-volume probe failed.");
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 60_001])(
    "rejects an invalid timeout before launching a helper: %s",
    async (timeoutMs) => {
      let killCount = 0;
      const probe = makeProjectVolumeProbeProcessForTest({
        probeScript: "process.stdin.resume(); setInterval(() => undefined, 1000);",
        killProcess: () => {
          killCount += 1;
          return true;
        },
      });
      try {
        await expect(probe.read(process.cwd(), timeoutMs)).rejects.toThrow(
          "Project-volume probe failed.",
        );
        expect(killCount).toBe(0);
      } finally {
        await probe.close();
      }
    },
  );

  it("contains a throwing test kill implementation and still settles on child close", async () => {
    const probe = makeProjectVolumeProbeProcessForTest({
      probeScript: `
        process.stdin.resume();
        setTimeout(() => process.exit(1), 100);
        setInterval(() => undefined, 1000);
      `,
      killProcess: () => {
        throw new Error("private kill detail");
      },
      parentKillGraceMs: 20,
    });

    const error = await probe.read(process.cwd(), 20).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Project-volume probe failed.");
    await probe.close();
  });

  it.each([
    {
      name: "non-JSON output",
      probeScript: 'process.stdin.resume(); process.stdout.write("not-json");',
    },
    {
      name: "wrong-arity output",
      probeScript: 'process.stdin.resume(); process.stdout.write(JSON.stringify(["1","2"]));',
    },
    {
      name: "non-decimal output",
      probeScript:
        'process.stdin.resume(); process.stdout.write(JSON.stringify(["1","2","3","4x"]));',
    },
    {
      name: "oversized output",
      probeScript: 'process.stdin.resume(); process.stdout.write("x".repeat(4097));',
    },
  ])("sanitizes $name", async ({ probeScript }) => {
    const probe = makeProjectVolumeProbeProcessForTest({ probeScript });
    try {
      const error = await probe.read(process.cwd(), 2_000).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("Project-volume probe failed.");
      expect((error as Error).message).not.toContain(probeScript);
    } finally {
      await probe.close();
    }
  });

  it("isolates two concurrent reads in separate helpers", async () => {
    const probe = makeProjectVolumeProbeProcessForTest({
      probeScript: `
        process.stdin.resume();
        setTimeout(() => {
          process.stdout.write(JSON.stringify(["1", "100", "25", "25"]));
        }, 25);
      `,
    });
    try {
      const [left, right] = await Promise.all([
        probe.read("first-project-root", 2_000),
        probe.read("second-project-root", 2_000),
      ]);
      expect(left).toEqual(right);
      expect(left).toEqual({
        blockSize: 1n,
        blocks: 100n,
        freeBlocks: 25n,
        availableBlocks: 25n,
      });
    } finally {
      await probe.close();
    }
  });
});
