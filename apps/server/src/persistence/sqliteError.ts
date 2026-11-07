// Native crypto binds a content-free statement identity without retaining SQL.
import { createHash } from "node:crypto";
import { LockTimeoutError, classifySqliteError } from "effect/unstable/sql/SqlError";

export const SQLITE_STATEMENT_DIAGNOSTICS_ENV = "CAFE_CODE_SQL_STATEMENT_DIAGNOSTICS";
const SQLITE_SLOW_STATEMENT_MS = 25;

export type SqliteStatementDiagnosticRecord =
  | {
      readonly phase: "start";
      readonly queryId: number;
      readonly fingerprint: string;
      readonly operation: string;
      readonly parameterCount: number;
    }
  | {
      readonly phase: "slow-complete";
      readonly queryId: number;
      readonly fingerprint: string;
      readonly operation: string;
      readonly parameterCount: number;
      readonly durationMs: number;
      readonly outcome: "success" | "failure";
    };

interface SqliteStatementDiagnosticReporterOptions {
  readonly enabled: boolean;
  readonly write: (record: SqliteStatementDiagnosticRecord) => void;
  readonly now?: () => number;
  readonly slowStatementMs?: number;
}

const SQL_OPERATION_ALLOWLIST = new Set([
  "alter",
  "create",
  "delete",
  "drop",
  "insert",
  "pragma",
  "replace",
  "select",
  "update",
  "vacuum",
  "with",
]);

/** SQL and bound values remain private; only a domain-separated identity is retained. */
function sqliteStatementFingerprint(sql: string): string {
  return createHash("sha256")
    .update("cafe-code/sqlite-statement/v1\0", "utf8")
    .update(sql, "utf8")
    .digest("hex")
    .slice(0, 16);
}

function sqliteStatementOperation(sql: string): string {
  const firstToken = /^[\s;]*([A-Za-z]+)/u.exec(sql)?.[1]?.toLowerCase();
  return firstToken !== undefined && SQL_OPERATION_ALLOWLIST.has(firstToken) ? firstToken : "other";
}

/**
 * Shared by the native worker and the explicitly injected fixture connection.
 * The start receipt is emitted immediately before the synchronous native call,
 * so a blocked operation can be identified without logging SQL or parameters.
 */
export function makeSqliteStatementDiagnosticReporter(
  options: SqliteStatementDiagnosticReporterOptions,
): (sql: string, parameterCount: number, execute: () => unknown) => unknown {
  if (!options.enabled) return (_sql, _parameterCount, execute) => execute();
  const now = options.now ?? performance.now.bind(performance);
  const slowStatementMs = Math.max(0, options.slowStatementMs ?? SQLITE_SLOW_STATEMENT_MS);
  let nextQueryId = 0;
  return (sql, parameterCount, execute) => {
    const queryId = (nextQueryId += 1);
    const fingerprint = sqliteStatementFingerprint(sql);
    const operation = sqliteStatementOperation(sql);
    const startedAt = now();
    options.write({ phase: "start", queryId, fingerprint, operation, parameterCount });
    let outcome: "success" | "failure" = "success";
    try {
      return execute();
    } catch (cause) {
      outcome = "failure";
      throw cause;
    } finally {
      const durationMs = now() - startedAt;
      if (durationMs >= slowStatementMs) {
        options.write({
          phase: "slow-complete",
          queryId,
          fingerprint,
          operation,
          parameterCount,
          durationMs: Math.round(durationMs * 10) / 10,
          outcome,
        });
      }
    }
  };
}

export function writeSqliteStatementDiagnostic(record: SqliteStatementDiagnosticRecord): void {
  try {
    process.stderr.write(`[Cafe Code SQLite] ${JSON.stringify(record)}\n`);
  } catch {
    // The native error, SQL, values and file paths must not become fallback
    // diagnostics when the diagnostic destination itself is unavailable.
  }
}

interface SqliteClassificationContext {
  readonly message: string;
  readonly operation: string;
}

function readNumericErrorProperty(cause: unknown, property: string): number | undefined {
  if ((typeof cause !== "object" || cause === null) && typeof cause !== "function")
    return undefined;
  try {
    const value = Reflect.get(cause, property);
    return typeof value === "number" ? value : undefined;
  } catch {
    return undefined;
  }
}

function readSqliteErrorCode(cause: unknown): string | number | undefined {
  if ((typeof cause !== "object" || cause === null) && typeof cause !== "function")
    return undefined;
  try {
    const value = Reflect.get(cause, "code");
    return typeof value === "string" || typeof value === "number" ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Keep the existing native errcode compatibility narrow. Transport failures do
 * not carry invented SQLite numbers and therefore cannot mint retry authority.
 * The sync fixture retains its original exception; the worker path reconstructs
 * only that native exception's explicit own data before reaching this helper.
 */
export function classifyNodeSqliteError(
  cause: unknown,
  context: SqliteClassificationContext,
): ReturnType<typeof classifySqliteError> {
  if (readNumericErrorProperty(cause, "errno") !== undefined) {
    return classifySqliteError(cause, context);
  }
  const errcode = readNumericErrorProperty(cause, "errcode");
  if (errcode === undefined) return classifySqliteError(cause, context);
  const code = readSqliteErrorCode(cause);
  const classified = classifySqliteError(
    { ...(code !== undefined ? { code } : {}), errno: errcode },
    context,
  );
  if (classified._tag !== "LockTimeoutError") return classifySqliteError(cause, context);
  return new LockTimeoutError({ cause, message: context.message, operation: context.operation });
}
