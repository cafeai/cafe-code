import { describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { fstatSync, writeSync } from "node:fs";

import {
  makeBackendMigrationProgressReporter,
  observeBackendMigrationRun,
} from "./backendStartupProgress.ts";
import type { BackendMigrationProgress } from "@cafecode/shared/backendStartupProgress";

describe("backend startup progress publication", () => {
  it("publishes completion after the whole migration transaction settles and skips empty runs", async () => {
    const records: BackendMigrationProgress[] = [];
    const result = await Effect.runPromise(
      observeBackendMigrationRun(
        (report) =>
          Effect.sync(() => {
            report({ phase: "start", migrationId: 92 });
            report({ phase: "start", migrationId: 93 });
            expect(records.map((record) => record.phase)).toEqual(["start", "start"]);
            return "committed";
          }),
        (record) => records.push(record),
      ),
    );
    expect(result).toBe("committed");
    expect(records).toEqual([
      { phase: "start", migrationId: 92 },
      { phase: "start", migrationId: 93 },
      { phase: "complete", migrationId: 93 },
    ]);
    const empty: BackendMigrationProgress[] = [];
    await Effect.runPromise(
      observeBackendMigrationRun(
        () => Effect.void,
        (record) => empty.push(record),
      ),
    );
    expect(empty).toEqual([]);
  });

  it("publishes sanitized failure after rollback while preserving the original failure", async () => {
    const records: BackendMigrationProgress[] = [];
    const failure = new Error("PRIVATE_SQL_OR_CREDENTIAL");
    const result = await Effect.runPromise(
      observeBackendMigrationRun(
        (report) =>
          Effect.sync(() => report({ phase: "start", migrationId: 92 })).pipe(
            Effect.andThen(Effect.fail(failure)),
          ),
        (record) => records.push(record),
      ).pipe(Effect.result),
    );
    expect(result).toMatchObject({ _tag: "Failure", failure });
    expect(records).toEqual([
      { phase: "start", migrationId: 92 },
      { phase: "failed", migrationId: 92 },
    ]);
    expect(JSON.stringify(records)).not.toContain(failure.message);
  });

  it("never probes an unadmitted descriptor or writes a regular file", () => {
    const stat = vi.fn(() => ({ isFIFO: () => false, isSocket: () => false }));
    const write = vi.fn(() => 0);
    const operations = {
      stat: stat as unknown as typeof fstatSync,
      write: write as unknown as typeof writeSync,
    };
    makeBackendMigrationProgressReporter(
      undefined,
      operations,
    )({ phase: "start", migrationId: 92 });
    expect(stat).not.toHaveBeenCalled();
    makeBackendMigrationProgressReporter(4, operations)({ phase: "start", migrationId: 92 });
    expect(stat).toHaveBeenCalledExactlyOnceWith(4);
    expect(write).not.toHaveBeenCalled();
  });

  it.each(["darwin", "linux", "win32"] as const)(
    "retires broken/partial writes without changing the migration outcome on %s",
    (platform) => {
      const stat = vi.fn(() => ({
        mode: 0o010000,
        rdev: 0x11 << 16,
        isFIFO: () => true,
        isSocket: () => false,
      }));
      const write = vi.fn(() => 1);
      const report = makeBackendMigrationProgressReporter(
        4,
        {
          stat: stat as unknown as typeof fstatSync,
          write: write as typeof writeSync,
        },
        platform,
      );
      report({ phase: "start", migrationId: 92 });
      report({ phase: "complete", migrationId: 92 });
      expect(write).toHaveBeenCalledTimes(1);
      expect(write).toHaveBeenCalledWith(4, "cafe-migration:v1:start:92\n");
      write.mockImplementation(() => {
        throw new Error("PRIVATE_FILE_OR_CREDENTIAL");
      });
      const broken = makeBackendMigrationProgressReporter(
        4,
        {
          stat: stat as unknown as typeof fstatSync,
          write: write as typeof writeSync,
        },
        platform,
      );
      expect(() => broken({ phase: "start", migrationId: 92 })).not.toThrow();
      broken({ phase: "failed", migrationId: 92 });
      expect(write).toHaveBeenCalledTimes(2);
    },
  );

  it("admits only the native Windows named-pipe tuple when Node's type predicates are false", () => {
    const write = vi.fn((_: number, frame: string) => frame.length);
    const stat = vi.fn(() => ({
      mode: 0o010000,
      rdev: 0x11 << 16,
      isFIFO: () => false,
      isSocket: () => false,
    }));
    const operations = {
      stat: stat as unknown as typeof fstatSync,
      write: write as unknown as typeof writeSync,
    };
    makeBackendMigrationProgressReporter(
      undefined,
      operations,
      "win32",
    )({
      phase: "start",
      migrationId: 92,
    });
    expect(stat).not.toHaveBeenCalled();
    makeBackendMigrationProgressReporter(
      4,
      operations,
      "win32",
    )({
      phase: "start",
      migrationId: 92,
    });
    expect(write).toHaveBeenCalledExactlyOnceWith(4, "cafe-migration:v1:start:92\n");
    write.mockClear();
    // A regular file, console, mismatched device or unidentified handle does
    // not receive progress even with the correct opt-in descriptor number.
    for (const rejected of [
      { mode: 0o100000, rdev: 0 },
      { mode: 0o020000, rdev: 0x50 << 16 },
      { mode: 0o010000, rdev: 0 },
      { mode: 0, rdev: 0x11 << 16 },
    ]) {
      stat.mockReturnValue({ ...rejected, isFIFO: () => false, isSocket: () => false });
      makeBackendMigrationProgressReporter(
        4,
        operations,
        "win32",
      )({
        phase: "start",
        migrationId: 92,
      });
    }
    expect(write).not.toHaveBeenCalled();
    stat.mockImplementation(() => {
      throw new Error("PRIVATE_DESCRIPTOR_ERROR");
    });
    expect(() =>
      makeBackendMigrationProgressReporter(
        4,
        operations,
        "win32",
      )({
        phase: "start",
        migrationId: 92,
      }),
    ).not.toThrow();
    expect(write).not.toHaveBeenCalled();
  });

  it("delivers the actual reporter through Effect's native fd4 output pipe", async () => {
    // A short synthetic Node child, never a Cafe/provider profile, qualifies
    // the public spawner's fd direction and the host-native pipe admission.
    // Only the system directory needed by Windows is inherited; Node hooks and
    // provider credentials are excluded from this fixture's environment.
    const helperUrl = new URL("./backendStartupProgress.ts", import.meta.url).href;
    const script = `import { makeBackendMigrationProgressReporter } from ${JSON.stringify(helperUrl)};
      const report = makeBackendMigrationProgressReporter(4);
      report({ phase: "start", migrationId: 92 });
      report({ phase: "complete", migrationId: 92 });`;
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const child = yield* spawner.spawn(
            ChildProcess.make(process.execPath, ["--input-type=module", "--eval", script], {
              extendEnv: false,
              env:
                process.platform === "win32" && process.env.SystemRoot
                  ? { SystemRoot: process.env.SystemRoot }
                  : {},
              additionalFds: { fd4: { type: "output" } },
            }),
          );
          const frames = yield* child.getOutputFd(4).pipe(Stream.decodeText(), Stream.mkString);
          const exitCode = yield* child.exitCode;
          return { frames, exitCode };
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );
    expect(result).toEqual({
      frames: "cafe-migration:v1:start:92\ncafe-migration:v1:complete:92\n",
      exitCode: 0,
    });
  });
});
