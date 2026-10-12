// @effect-diagnostics nodeBuiltinImport:off
import { fstatSync, writeSync } from "node:fs";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import {
  BACKEND_STARTUP_PROGRESS_FD,
  encodeBackendMigrationProgress,
  type BackendMigrationProgress,
} from "@cafecode/shared/backendStartupProgress";

/**
 * The private fd3 bootstrap must explicitly admit fd4. In other runtime roles,
 * descriptor four may be an unrelated database/file; never probe or write it.
 * Reject file-like descriptors even after admission, preserving that boundary
 * if a malformed local launch supplied the wrong kind of inherited handle.
 */
export function makeBackendMigrationProgressReporter(
  fd: 4 | undefined,
  operations = { stat: fstatSync, write: writeSync },
  platform: NodeJS.Platform = process.platform,
): (record: BackendMigrationProgress) => void {
  if (fd !== BACKEND_STARTUP_PROGRESS_FD) return () => undefined;
  let enabled = false;
  try {
    const stat = operations.stat(fd);
    // Node intentionally makes these convenience predicates false on Windows,
    // although libuv still reports an inherited named pipe's native stat tuple.
    // Admit that exact tuple only: accepting any non-file or character device
    // would also write to an unrelated console or other inherited handle. The
    // tuple comes from libuv's fs__fstat_handle (UV_NAMED_PIPE), not a path guess.
    // POSIX keeps its original public FIFO/socket predicates unchanged.
    enabled =
      platform === "win32"
        ? (stat.mode & 0o170000) === 0o010000 && stat.rdev === 0x11 << 16
        : stat.isFIFO() || stat.isSocket();
  } catch {
    // Missing/closed progress pipes cannot affect durable database work.
  }
  return (record) => {
    if (!enabled) return;
    try {
      // A synchronous, finite write precedes the synchronous SQLite call. An
      // Effect log or timer would be trapped behind the very stall we observe.
      const frame = encodeBackendMigrationProgress(record);
      if (operations.write(fd, frame) !== frame.length) enabled = false;
    } catch {
      // Desktop exit closes its pipe. Never fail a migration or expose the
      // underlying write error, and never replay a partial progress record.
      enabled = false;
    }
  };
}

/** Keep phase evidence alive until the migrator's outer commit/rollback settles. */
export function observeBackendMigrationRun<A, E, R>(
  run: (report: (record: BackendMigrationProgress) => void) => Effect.Effect<A, E, R>,
  report: (record: BackendMigrationProgress) => void,
): Effect.Effect<A, E, R> {
  return Effect.suspend(() => {
    let lastMigrationId: number | undefined;
    return run((record) => {
      lastMigrationId = record.migrationId;
      report(record);
    }).pipe(
      Effect.onExit((exit) =>
        Effect.sync(() => {
          if (lastMigrationId !== undefined) {
            report({
              phase: Exit.isSuccess(exit) ? "complete" : "failed",
              migrationId: lastMigrationId,
            });
          }
        }),
      ),
    );
  });
}
