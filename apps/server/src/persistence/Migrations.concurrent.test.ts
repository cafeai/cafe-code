import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as Effect from "effect/Effect";
import * as SqlError from "effect/unstable/sql/SqlError";
import { assert, it } from "vitest";

import { isMigrationLockTimeoutError, runMigrations } from "./Migrations.ts";
import * as NodeSqliteClient from "./NodeSqliteClient.ts";
import { isSqliteBusySnapshotError, readSqliteResultCode } from "./sqliteLockRetry.ts";

it("runMigrations retries transient cross-process writer contention", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const directory = mkdtempSync(join(tmpdir(), "cafecode-migration-lock-"));
      const filename = join(directory, "state.sqlite");

      try {
        yield* runMigrations({ toMigrationInclusive: 67 }).pipe(
          Effect.provide(NodeSqliteClient.layer({ filename, busyTimeoutMs: 25 })),
        );

        const lockOwner = new DatabaseSync(filename);
        lockOwner.exec("PRAGMA journal_mode = WAL; BEGIN IMMEDIATE;");
        try {
          const releaseLock = setTimeout(() => {
            lockOwner.exec("COMMIT");
          }, 175);
          try {
            const executed = yield* runMigrations({ toMigrationInclusive: 68 }).pipe(
              Effect.provide(NodeSqliteClient.layer({ filename, busyTimeoutMs: 25 })),
            );
            assert.deepStrictEqual(executed, [[68, "OrchestrationMessageIdentityLedger"]]);
          } finally {
            clearTimeout(releaseLock);
          }
        } finally {
          if (lockOwner.isTransaction) {
            lockOwner.exec("ROLLBACK");
          }
          lockOwner.close();
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }),
  );
});

it("migration retry admission is limited to SQLite lock timeouts", () => {
  const lockTimeout = new SqlError.SqlError({
    reason: new SqlError.LockTimeoutError({
      cause: new Error("locked"),
      operation: "execute",
    }),
  });
  const connectionFailure = new SqlError.SqlError({
    reason: new SqlError.ConnectionError({
      cause: new Error("disconnected"),
      operation: "execute",
    }),
  });
  const statementTimeout = new SqlError.SqlError({
    reason: new SqlError.StatementTimeoutError({
      cause: new Error("slow statement"),
      operation: "execute",
    }),
  });

  assert.isTrue(isMigrationLockTimeoutError(lockTimeout));
  assert.isFalse(isMigrationLockTimeoutError(connectionFailure));
  assert.isFalse(isMigrationLockTimeoutError(statementTimeout));
  assert.isFalse(isMigrationLockTimeoutError(new Error("not sql")));
});

it("classifies immediate WAL snapshot invalidation without exposing its cause", () => {
  const busySnapshot = new SqlError.SqlError({
    reason: new SqlError.LockTimeoutError({
      cause: { code: "ERR_SQLITE_BUSY", errcode: 517 },
      operation: "execute",
    }),
  });
  const exhaustedWriterTimeout = new SqlError.SqlError({
    reason: new SqlError.LockTimeoutError({
      cause: { code: "ERR_SQLITE_BUSY", errcode: 5 },
      operation: "execute",
    }),
  });

  assert.isTrue(isSqliteBusySnapshotError(busySnapshot));
  assert.isFalse(isSqliteBusySnapshotError(exhaustedWriterTimeout));
  assert.isFalse(isSqliteBusySnapshotError(new Error("not sql")));
  assert.equal(readSqliteResultCode(busySnapshot), 517);
  assert.equal(readSqliteResultCode(exhaustedWriterTimeout), 5);
  assert.isUndefined(readSqliteResultCode(new Error("not sql")));
});
