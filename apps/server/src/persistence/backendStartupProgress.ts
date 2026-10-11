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
): (record: BackendMigrationProgress) => void {
  if (fd !== BACKEND_STARTUP_PROGRESS_FD) return () => undefined;
  let enabled = false;
  try {
    const stat = operations.stat(fd);
    enabled = stat.isFIFO() || stat.isSocket();
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
