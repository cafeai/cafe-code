// Loaded only after the worker bootstrap qualifies this thread's dependencies.
// SQLite is synchronous by design; this sole native connection owner keeps
// its busy waits and statement execution off the backend's HTTP/event loop.
// Native SQLite runs only inside the held worker; no asynchronous wrapper can
// make a DatabaseSync statement safe to execute on the backend event loop.
import { DatabaseSync, type StatementSync } from "node:sqlite";
// The exact private parent port owns native close and prevents detached writers.
import { parentPort, workerData } from "node:worker_threads";
import {
  decodeSqliteWorkerOptions,
  decodeSqliteWorkerRequest,
  encodeSqliteWorkerNativeError,
  type SqliteWorkerReply,
  type SqliteWorkerResult,
  type SqliteWorkerValue,
} from "./sqliteWorkerProtocol.ts";
import { makeSqliteStatementDiagnosticReporter } from "./sqliteError.ts";

/**
 * No public listener, detached process, environment mutation or connection
 * recovery lives here. The exact parent port owns the complete DB lifetime.
 * A failed operation is answered once and is never automatically replayed.
 */
const port = parentPort;
if (port === null) throw new Error("SQLite worker requires its owning parent port.");
const options = decodeSqliteWorkerOptions(workerData);
if (options === undefined) throw new Error("SQLite worker configuration is invalid.");

let database: DatabaseSync | undefined;
let closed = false;
let lastRequestId = 0;
let activeRequestId = 0;
const prepared = new Map<
  string,
  { readonly statement: StatementSync; readonly expiresAt: number }
>();
const send = (reply: SqliteWorkerReply): void => port.postMessage(reply);
const report = makeSqliteStatementDiagnosticReporter({
  enabled: options.statementDiagnostics,
  write: (record) => {
    // Only finite, content-free records enter the parent diagnostic sink. A
    // request id binds each observation to the single admitted native call.
    send({ version: 1, type: "diagnostic", id: activeRequestId, record });
  },
});

try {
  database = new DatabaseSync(options.filename, {
    readOnly: options.readonly,
    allowExtension: options.allowExtension,
  });
  if (options.busyTimeoutMs > 0) database.exec(`PRAGMA busy_timeout = ${options.busyTimeoutMs};`);
  send({ version: 1, type: "ready" });
} catch (cause) {
  // A failed open may still have acquired a native connection. Close it here
  // before exiting, rather than letting the parent believe ownership vanished.
  try {
    database?.close();
  } catch {
    /* Preserve the original open failure. */
  }
  database = undefined;
  closed = true;
  send({
    version: 1,
    type: "failure",
    id: 0,
    phase: "open",
    error: encodeSqliteWorkerNativeError(cause),
  });
  process.exitCode = 1;
  port.close();
}

function prepare(sql: string, unprepared: boolean): StatementSync {
  if (database === undefined) throw new Error("SQLite worker connection is unavailable.");
  const now = performance.now();
  if (!unprepared && options !== undefined && options.prepareCacheSize > 0) {
    const cached = prepared.get(sql);
    if (cached && cached.expiresAt > now) {
      // Refresh LRU order, retaining the original absolute TTL as Cache does.
      prepared.delete(sql);
      prepared.set(sql, cached);
      return cached.statement;
    }
    prepared.delete(sql);
  }
  const statement = database.prepare(sql);
  if (!unprepared && options !== undefined && options.prepareCacheSize > 0) {
    prepared.set(sql, { statement, expiresAt: now + options.prepareCacheTTLMillis });
    while (prepared.size > options.prepareCacheSize) {
      const oldest = prepared.keys().next();
      if (oldest.done) break;
      prepared.delete(oldest.value);
    }
  }
  return statement;
}

port.on("message", (value: unknown) => {
  const request = decodeSqliteWorkerRequest(value);
  if (closed || request === undefined || request.id <= lastRequestId || activeRequestId !== 0) {
    // An invalid envelope is a fatal private protocol failure. It is never
    // interpreted as SQL, a close request, or authority to recover/replay.
    process.exitCode = 1;
    try {
      database?.close();
    } catch {
      /* Exit still retires the exact owner. */
    }
    database = undefined;
    closed = true;
    port.close();
    return;
  }
  lastRequestId = request.id;
  activeRequestId = request.id;
  if (request.type === "close") {
    try {
      // Parent admission has already fenced new work and joined the previous
      // response. A close ACK attests native close, not merely message receipt.
      database?.close();
      database = undefined;
      prepared.clear();
      closed = true;
      send({ version: 1, type: "closed", id: request.id });
    } catch (cause) {
      closed = true;
      process.exitCode = 1;
      send({
        version: 1,
        type: "failure",
        id: request.id,
        phase: "close",
        error: encodeSqliteWorkerNativeError(cause),
      });
    } finally {
      activeRequestId = 0;
      port.close();
    }
    return;
  }

  let phase: "prepare" | "execute" = "prepare";
  try {
    const statement = prepare(request.sql, request.unprepared);
    phase = "execute";
    // These mutable StatementSync modes belong to one indivisible request.
    // Separate mode-control messages could corrupt a concurrent transaction's
    // result shape or integer precision, even with ordered statement execution.
    statement.setReadBigInts(request.safeIntegers);
    const hasRows = statement.columns().length > 0;
    let result: SqliteWorkerResult;
    if (hasRows) {
      statement.setReturnArrays(request.mode === "values");
      try {
        const rows = report(request.sql, request.params.length, () =>
          statement.all(...(request.params as unknown as never[])),
        );
        result =
          request.mode === "values"
            ? { kind: "values", rows: rows as ReadonlyArray<ReadonlyArray<SqliteWorkerValue>> }
            : {
                kind: "rows",
                rows: rows as ReadonlyArray<Readonly<Record<string, SqliteWorkerValue>>>,
                nullPrototypes: (rows as ReadonlyArray<object>).map(
                  (row) => Object.getPrototypeOf(row) === null,
                ),
              };
      } finally {
        statement.setReturnArrays(false);
      }
    } else {
      const write = report(request.sql, request.params.length, () =>
        statement.run(...(request.params as unknown as never[])),
      ) as { readonly changes: number | bigint; readonly lastInsertRowid: number | bigint };
      result = { kind: "write", changes: write.changes, lastInsertRowid: write.lastInsertRowid };
    }
    send({ version: 1, type: "result", id: request.id, result });
  } catch (cause) {
    send({
      version: 1,
      type: "failure",
      id: request.id,
      phase,
      error: encodeSqliteWorkerNativeError(cause),
    });
  } finally {
    activeRequestId = 0;
  }
});

port.on("close", () => {
  // If the parent vanishes, this callback can run only after the current
  // synchronous operation returns. Never leave a detached database writer.
  if (closed) return;
  closed = true;
  prepared.clear();
  try {
    database?.close();
  } catch {
    process.exitCode = 1;
  }
  database = undefined;
});
