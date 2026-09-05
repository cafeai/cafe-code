/**
 * Port of `@effect/sql-sqlite-node` that uses the native `node:sqlite`
 * bindings instead of `better-sqlite3`.
 *
 * @module SqliteClient
 */
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { createHash } from "node:crypto";

import * as Cache from "effect/Cache";
import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { identity } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Context from "effect/Context";
import * as Stream from "effect/Stream";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";
import * as Client from "effect/unstable/sql/SqlClient";
import type { Connection } from "effect/unstable/sql/SqlConnection";
import { LockTimeoutError, SqlError, classifySqliteError } from "effect/unstable/sql/SqlError";
import * as Statement from "effect/unstable/sql/Statement";

const ATTR_DB_SYSTEM_NAME = "db.system.name";
const SQLITE_STATEMENT_DIAGNOSTICS_ENV = "CAFE_CODE_SQL_STATEMENT_DIAGNOSTICS";
const SQLITE_SLOW_STATEMENT_MS = 25;

type SqliteStatementDiagnosticRecord =
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

/**
 * Build a stable, content-free identity for one prepared SQL statement.
 *
 * Debugging a synchronous `StatementSync.all()` stall requires recording the
 * statement *before* Node enters SQLite. Logging SQL text is unacceptable: a
 * future call site could accidentally interpolate a prompt, path, or secret
 * into an unprepared statement. The domain-separated digest lets maintainers
 * correlate starts with completed trace spans without retaining that text.
 */
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
 * This deliberately tiny reporter is exported only for security regression
 * coverage. Its records contain an allowlisted operation class, a digest, and
 * counts/timing; SQL text, parameter values, errors, and database paths never
 * cross the diagnostic boundary.
 */
export function makeSqliteStatementDiagnosticReporter(
  options: SqliteStatementDiagnosticReporterOptions,
): (sql: string, parameterCount: number, execute: () => unknown) => unknown {
  if (!options.enabled) {
    return (_sql, _parameterCount, execute) => execute();
  }

  const now = options.now ?? performance.now.bind(performance);
  const slowStatementMs = Math.max(0, options.slowStatementMs ?? SQLITE_SLOW_STATEMENT_MS);
  let nextQueryId = 0;

  return (sql, parameterCount, execute) => {
    const queryId = (nextQueryId += 1);
    const fingerprint = sqliteStatementFingerprint(sql);
    const operation = sqliteStatementOperation(sql);
    const startedAt = now();
    options.write({
      phase: "start",
      queryId,
      fingerprint,
      operation,
      parameterCount,
    });

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

function writeSqliteStatementDiagnostic(record: SqliteStatementDiagnosticRecord): void {
  try {
    // stderr is already captured by the desktop backend manager. Keep this a
    // synchronous call immediately before StatementSync.all(); an Effect log
    // span cannot finish while the main thread is blocked inside native SQLite.
    process.stderr.write(`[Cafe Code SQLite] ${JSON.stringify(record)}\n`);
  } catch {
    // Diagnostics must never make a database operation fail or expose the
    // original write error, which can contain unrestricted local paths.
  }
}

export const TypeId: TypeId = "~local/sqlite-node/SqliteClient";

export type TypeId = "~local/sqlite-node/SqliteClient";

/**
 * SqliteClient - Effect service tag for the sqlite SQL client.
 */
export const SqliteClient = Context.Service<Client.SqlClient>(
  "cafecode/persistence/NodeSqliteClient",
);

export interface SqliteClientConfig {
  readonly filename: string;
  readonly readonly?: boolean | undefined;
  readonly allowExtension?: boolean | undefined;
  readonly busyTimeoutMs?: number | undefined;
  readonly prepareCacheSize?: number | undefined;
  readonly prepareCacheTTL?: Duration.Input | undefined;
  readonly spanAttributes?: Record<string, unknown> | undefined;
  readonly transformResultNames?: ((str: string) => string) | undefined;
  readonly transformQueryNames?: ((str: string) => string) | undefined;
}

export interface SqliteMemoryClientConfig extends Omit<
  SqliteClientConfig,
  "filename" | "readonly"
> {}

/**
 * Verify that the current Node.js version includes the `node:sqlite` APIs
 * used by `NodeSqliteClient` — specifically `StatementSync.columns()` (added
 * in Node 22.16.0 / 23.11.0).
 *
 * @see https://github.com/nodejs/node/pull/57490
 */
const checkNodeSqliteCompat = () => {
  const parts = process.versions.node.split(".").map(Number);
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const supported = (major === 22 && minor >= 16) || (major === 23 && minor >= 11) || major >= 24;

  if (!supported) {
    return Effect.die(
      `Node.js ${process.versions.node} is missing required node:sqlite APIs ` +
        `(StatementSync.columns). Upgrade to Node.js >=22.16, >=23.11, or >=24.`,
    );
  }
  return Effect.void;
};

function normalizeBusyTimeoutMs(value: number | undefined): number {
  if (value === undefined) {
    return 0;
  }
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.min(60_000, Math.trunc(value));
}

interface SqliteClassificationContext {
  readonly message: string;
  readonly operation: string;
}

function readNumericErrorProperty(cause: unknown, property: string): number | undefined {
  if ((typeof cause !== "object" || cause === null) && typeof cause !== "function") {
    return undefined;
  }
  try {
    const value = Reflect.get(cause, property);
    return typeof value === "number" ? value : undefined;
  } catch {
    // Error-like inputs can be hostile proxies. Classification diagnostics
    // must never let a throwing property trap replace the original SQL error.
    return undefined;
  }
}

function readSqliteErrorCode(cause: unknown): string | number | undefined {
  if ((typeof cause !== "object" || cause === null) && typeof cause !== "function") {
    return undefined;
  }
  try {
    const value = Reflect.get(cause, "code");
    return typeof value === "string" || typeof value === "number" ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Adapt Node's native SQLite error shape to Effect's classifier.
 *
 * `node:sqlite` currently reports SQLite's numeric result code as `errcode`,
 * while Effect's SQLite classifier reads `errno`. Classify a small, local
 * facade so extended SQLITE_BUSY/SQLITE_LOCKED codes retain Effect's normal
 * low-byte handling, then rebuild the retryable reason with the untouched
 * native Error as its cause. We intentionally do not mutate the native error
 * or retain the facade: diagnostics and callers must see the exact exception
 * thrown by `node:sqlite`.
 */
function classifyNodeSqliteError(
  cause: unknown,
  context: SqliteClassificationContext,
): ReturnType<typeof classifySqliteError> {
  if (readNumericErrorProperty(cause, "errno") !== undefined) {
    return classifySqliteError(cause, context);
  }

  const errcode = readNumericErrorProperty(cause, "errcode");
  if (errcode === undefined) {
    return classifySqliteError(cause, context);
  }

  const code = readSqliteErrorCode(cause);
  const classified = classifySqliteError(
    {
      ...(code !== undefined ? { code } : {}),
      errno: errcode,
    },
    context,
  );
  if (classified._tag !== "LockTimeoutError") {
    // Keep this compatibility shim deliberately narrow. Other numeric result
    // codes continue through Effect's standard classifier until its upstream
    // implementation gains native `errcode` support.
    return classifySqliteError(cause, context);
  }

  return new LockTimeoutError({
    cause,
    message: context.message,
    operation: context.operation,
  });
}

const makeWithDatabase = Effect.fn("makeWithDatabase")(function* (
  options: SqliteClientConfig,
  openDatabase: () => DatabaseSync,
): Effect.fn.Return<Client.SqlClient, never, Scope.Scope | Reactivity.Reactivity> {
  yield* checkNodeSqliteCompat();

  const compiler = Statement.makeCompilerSqlite(options.transformQueryNames);
  const transformRows = options.transformResultNames
    ? Statement.defaultTransforms(options.transformResultNames).array
    : undefined;

  const makeConnection = Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const db = openDatabase();
    const runWithStatementDiagnostics = makeSqliteStatementDiagnosticReporter({
      enabled: process.env[SQLITE_STATEMENT_DIAGNOSTICS_ENV] === "1",
      write: writeSqliteStatementDiagnostic,
    });
    yield* Scope.addFinalizer(
      scope,
      Effect.sync(() => db.close()),
    );
    const busyTimeoutMs = normalizeBusyTimeoutMs(options.busyTimeoutMs);
    if (busyTimeoutMs > 0) {
      db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs};`);
    }

    const statementReaderCache = new WeakMap<StatementSync, boolean>();
    const hasRows = (statement: StatementSync): boolean => {
      const cached = statementReaderCache.get(statement);
      if (cached !== undefined) {
        return cached;
      }
      const value = statement.columns().length > 0;
      statementReaderCache.set(statement, value);
      return value;
    };

    const prepareCache = yield* Cache.make({
      capacity: options.prepareCacheSize ?? 200,
      timeToLive: options.prepareCacheTTL ?? Duration.minutes(10),
      lookup: (sql: string) =>
        Effect.try({
          try: () => db.prepare(sql),
          catch: (cause) =>
            new SqlError({
              reason: classifyNodeSqliteError(cause, {
                message: "Failed to prepare statement",
                operation: "prepare",
              }),
            }),
        }),
    });

    const runStatement = (
      sql: string,
      statement: StatementSync,
      params: ReadonlyArray<unknown>,
      raw: boolean,
    ) =>
      Effect.withFiber<ReadonlyArray<any>, SqlError>((fiber) => {
        statement.setReadBigInts(Boolean(Context.get(fiber.context, Client.SafeIntegers)));
        try {
          if (hasRows(statement)) {
            return Effect.succeed(
              runWithStatementDiagnostics(sql, params.length, () =>
                statement.all(...(params as any)),
              ) as ReadonlyArray<any>,
            );
          }
          const result = statement.run(...(params as any));
          return Effect.succeed(raw ? (result as unknown as ReadonlyArray<any>) : []);
        } catch (cause) {
          return Effect.fail(
            new SqlError({
              reason: classifyNodeSqliteError(cause, {
                message: "Failed to execute statement",
                operation: "execute",
              }),
            }),
          );
        }
      });

    const run = (sql: string, params: ReadonlyArray<unknown>, raw = false) =>
      Effect.flatMap(Cache.get(prepareCache, sql), (s) => runStatement(sql, s, params, raw));

    const runValues = (sql: string, params: ReadonlyArray<unknown>) =>
      Effect.acquireUseRelease(
        Cache.get(prepareCache, sql),
        (statement) =>
          Effect.try({
            try: () => {
              if (hasRows(statement)) {
                statement.setReturnArrays(true);
                // Safe to cast to array after we've setReturnArrays(true)
                return runWithStatementDiagnostics(sql, params.length, () =>
                  statement.all(...(params as any)),
                ) as ReadonlyArray<ReadonlyArray<unknown>>;
              }
              statement.run(...(params as any));
              return [];
            },
            catch: (cause) =>
              new SqlError({
                reason: classifyNodeSqliteError(cause, {
                  message: "Failed to execute statement",
                  operation: "execute",
                }),
              }),
          }),
        (statement) =>
          Effect.sync(() => {
            if (hasRows(statement)) {
              statement.setReturnArrays(false);
            }
          }),
      );

    return identity<Connection>({
      execute(sql, params, rowTransform) {
        return rowTransform ? Effect.map(run(sql, params), rowTransform) : run(sql, params);
      },
      executeRaw(sql, params) {
        return run(sql, params, true);
      },
      executeValues(sql, params) {
        return runValues(sql, params);
      },
      executeUnprepared(sql, params, rowTransform) {
        const effect = runStatement(sql, db.prepare(sql), params ?? [], false);
        return rowTransform ? Effect.map(effect, rowTransform) : effect;
      },
      executeStream(sql, params, rowTransform) {
        // `node:sqlite` iterators can throw while the Stream is pulling rows,
        // outside the Effect error channel. Materialize through the same
        // classified execution path as normal statements so SQLite failures
        // remain typed `SqlError`s and the connection permit stays scoped to
        // the stream. Cafe's current persistence queries are bounded; if a
        // future call site needs cursor-scale streaming, add a pull adapter
        // that translates iterator failures before changing this contract.
        const rows = rowTransform ? Effect.map(run(sql, params), rowTransform) : run(sql, params);
        return Stream.fromIterableEffect(rows);
      },
    });
  });

  const semaphore = yield* Semaphore.make(1);
  const connection = yield* makeConnection;

  const acquirer = semaphore.withPermits(1)(Effect.succeed(connection));
  const transactionAcquirer = Effect.uninterruptibleMask((restore) => {
    const fiber = Fiber.getCurrent()!;
    const scope = Context.getUnsafe(fiber.context, Scope.Scope);
    return Effect.as(
      Effect.tap(restore(semaphore.take(1)), () => Scope.addFinalizer(scope, semaphore.release(1))),
      connection,
    );
  });

  return yield* Client.make({
    acquirer,
    compiler,
    transactionAcquirer,
    spanAttributes: [
      ...(options.spanAttributes ? Object.entries(options.spanAttributes) : []),
      [ATTR_DB_SYSTEM_NAME, "sqlite"],
    ],
    transformRows,
  });
});

const make = (
  options: SqliteClientConfig,
): Effect.Effect<Client.SqlClient, never, Scope.Scope | Reactivity.Reactivity> =>
  makeWithDatabase(
    options,
    () =>
      new DatabaseSync(options.filename, {
        readOnly: options.readonly ?? false,
        allowExtension: options.allowExtension ?? false,
      }),
  );

const makeMemory = (
  config: SqliteMemoryClientConfig = {},
): Effect.Effect<Client.SqlClient, never, Scope.Scope | Reactivity.Reactivity> =>
  makeWithDatabase(
    {
      ...config,
      filename: ":memory:",
      readonly: false,
    },
    () => {
      const database = new DatabaseSync(":memory:", {
        allowExtension: config.allowExtension ?? false,
      });
      return database;
    },
  );

export const layerConfig = (
  config: Config.Wrap<SqliteClientConfig>,
): Layer.Layer<Client.SqlClient, Config.ConfigError> =>
  Layer.effectContext(
    Config.unwrap(config)
      .asEffect()
      .pipe(
        Effect.flatMap(make),
        Effect.map((client) =>
          Context.make(SqliteClient, client).pipe(Context.add(Client.SqlClient, client)),
        ),
      ),
  ).pipe(Layer.provide(Reactivity.layer));

export const layer = (config: SqliteClientConfig): Layer.Layer<Client.SqlClient> =>
  Layer.effectContext(
    Effect.map(make(config), (client) =>
      Context.make(SqliteClient, client).pipe(Context.add(Client.SqlClient, client)),
    ),
  ).pipe(Layer.provide(Reactivity.layer));

export const layerMemory = (config: SqliteMemoryClientConfig = {}): Layer.Layer<Client.SqlClient> =>
  Layer.effectContext(
    Effect.map(makeMemory(config), (client) =>
      Context.make(SqliteClient, client).pipe(Context.add(Client.SqlClient, client)),
    ),
  ).pipe(Layer.provide(Reactivity.layer));
