import * as SqlError from "effect/unstable/sql/SqlError";

const SQLITE_BUSY_SNAPSHOT_EXTENDED_CODE = 517;

function readNumericProperty(value: unknown, property: string): number | undefined {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") {
    return undefined;
  }
  try {
    const candidate = Reflect.get(value, property);
    return typeof candidate === "number" ? candidate : undefined;
  } catch {
    // Error causes can cross extension or provider boundaries. Classification
    // must never replace the original database failure because a hostile proxy
    // exposed a throwing property getter.
    return undefined;
  }
}

/**
 * Return only SQLite's numeric result code for content-free diagnostics.
 *
 * Native node:sqlite uses `errcode`; other adapters can expose `errno`. Never
 * return the original cause, message, SQL, parameters, or path from this
 * boundary because hydration failures can occur while handling user content.
 */
export function readSqliteResultCode(error: unknown): number | undefined {
  if (!SqlError.isSqlError(error)) {
    return undefined;
  }
  return (
    readNumericProperty(error.reason.cause, "errcode") ??
    readNumericProperty(error.reason.cause, "errno")
  );
}

/**
 * Admit retries only for SQLite's typed transient lock classification.
 *
 * In WAL mode, a deferred transaction can read successfully and then receive
 * `SQLITE_BUSY_SNAPSHOT` when another process commits before its first write.
 * Effect normalizes both that extended result and ordinary bounded writer
 * contention to `LockTimeoutError`. Keeping this predicate structural avoids
 * brittle message matching and ensures syntax, constraint, connection, and
 * invariant failures remain fail-fast.
 */
export function isSqliteLockTimeoutError(error: unknown): error is SqlError.SqlError {
  return SqlError.isSqlError(error) && error.reason._tag === "LockTimeoutError";
}

/**
 * Detect the one lock result whose transaction can safely make progress by
 * immediately reopening its WAL snapshot.
 *
 * Ordinary `SQLITE_BUSY` reaches Cafe only after the connection's bounded
 * busy timeout has already elapsed. Retrying that broad classification could
 * hold the serialized orchestration command worker for minutes. In contrast,
 * `SQLITE_BUSY_SNAPSHOT` (extended result code 517) is returned immediately
 * when a deferred reader tries to upgrade after another process committed.
 * A fresh transaction is both necessary and sufficient for that case.
 */
export function isSqliteBusySnapshotError(error: unknown): error is SqlError.SqlError {
  return (
    isSqliteLockTimeoutError(error) &&
    readSqliteResultCode(error) === SQLITE_BUSY_SNAPSHOT_EXTENDED_CODE
  );
}
