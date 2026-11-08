/**
 * Port of `@effect/sql-sqlite-node` that uses the native `node:sqlite`
 * bindings instead of `better-sqlite3`.
 *
 * @module SqliteClient
 */
import { DatabaseSync, type StatementSync } from "node:sqlite";

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
import { SqlError } from "effect/unstable/sql/SqlError";
import * as Statement from "effect/unstable/sql/Statement";

import { makeSqliteWorkerConnection } from "./SqliteWorkerConnection.ts";
import {
  classifyNodeSqliteError,
  makeSqliteStatementDiagnosticReporter,
  writeSqliteStatementDiagnostic,
} from "./sqliteError.ts";

// Preserve the existing diagnostic boundary API; both native execution paths
// share its content-free reporter and identical SQLite error classification.
export { makeSqliteStatementDiagnosticReporter } from "./sqliteError.ts";

const ATTR_DB_SYSTEM_NAME = "db.system.name";
const SQLITE_STATEMENT_DIAGNOSTICS_ENV = "CAFE_CODE_SQL_STATEMENT_DIAGNOSTICS";

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

/**
 * Explicitly adopted DatabaseSync handles cannot cross a worker boundary.
 * This path remains for owned in-memory clones and native handle fixtures;
 * production filename-based layers below always use the asynchronous worker.
 */
const makeNativeConnection = Effect.fn("makeNativeConnection")(function* (
  options: SqliteClientConfig,
  openDatabase: () => DatabaseSync,
): Effect.fn.Return<Connection, never, Scope.Scope> {
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
        // Non-returning statements include schema/index migrations and can
        // block in SQLite just as reads can. Publish the same redacted start
        // record before the native call, preserving its raw result and error.
        const result = runWithStatementDiagnostics(sql, params.length, () =>
          statement.run(...(params as any)),
        );
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
            // `.values` still executes writes through the native run path;
            // retain its empty-array contract while diagnosing that work.
            runWithStatementDiagnostics(sql, params.length, () =>
              statement.run(...(params as any)),
            );
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
      // remain typed `SqlError`s. The normal client wrapper below releases its
      // statement permit after materialization, before yielding rows. If a
      // future call site needs cursor-scale streaming, add a pull adapter
      // that translates iterator failures before changing this contract.
      const rows = rowTransform ? Effect.map(run(sql, params), rowTransform) : run(sql, params);
      return Stream.fromIterableEffect(rows);
    },
  });
});

/**
 * The SQL compiler, transforms and transaction service remain on the caller's
 * Effect runtime. Normal operations hold a permit through their asynchronous
 * native reply; an outer transaction or reserved connection holds it for its
 * whole scope. Materialized streams release normal statement ownership before
 * downstream consumers run, so a consumer can safely query this same client.
 */
const makeClient = Effect.fn("makeClient")(function* (
  options: SqliteClientConfig,
  makeConnection: Effect.Effect<Connection, never, Scope.Scope>,
): Effect.fn.Return<Client.SqlClient, never, Scope.Scope | Reactivity.Reactivity> {
  yield* checkNodeSqliteCompat();
  const compiler = Statement.makeCompilerSqlite(options.transformQueryNames);
  const transformRows = options.transformResultNames
    ? Statement.defaultTransforms(options.transformResultNames).array
    : undefined;

  const semaphore = yield* Semaphore.make(1);
  const connection = yield* makeConnection;
  let retiring = false;
  const unavailable = () =>
    new SqlError({
      reason: classifyNodeSqliteError(new Error("SQLite connection is closing."), {
        message: "SQLite connection is closing.",
        operation: "acquire",
      }),
    });

  // This finalizer is installed after the connection's own finalizer, so scope
  // teardown fences new borrowers and drains the entire outer transaction
  // before the worker closes its database. Draining just the currently posted
  // statement would allow native close to race that transaction's rollback.
  const clientScope = yield* Effect.scope;
  yield* Scope.addFinalizer(
    clientScope,
    Effect.gen(function* () {
      retiring = true;
      yield* semaphore.withPermits(1)(Effect.void);
    }),
  );

  // Take a thunk, rather than an already constructed Effect: explicitly adopted
  // native handles can prepare unprepared statements when the method is called.
  // Even that preparation must happen only after admission and its second
  // retirement check. Cancellation of queued work never acquires a permit;
  // admitted worker calls retain their own exact native-reply join.
  const withPermit = <A>(work: () => Effect.Effect<A, SqlError>): Effect.Effect<A, SqlError> =>
    Effect.suspend(() =>
      retiring
        ? Effect.fail(unavailable())
        : semaphore.withPermits(1)(
            Effect.suspend(() => (retiring ? Effect.fail(unavailable()) : work())),
          ),
    );

  const ordinaryConnection: Connection = {
    execute: (sql, params, rowTransform) =>
      withPermit(() => connection.execute(sql, params, rowTransform)),
    executeRaw: (sql, params) => withPermit(() => connection.executeRaw(sql, params)),
    executeValues: (sql, params) => withPermit(() => connection.executeValues(sql, params)),
    executeUnprepared: (sql, params, rowTransform) =>
      withPermit(() => connection.executeUnprepared(sql, params, rowTransform)),
    // Effect keeps a stream's acquisition scope throughout consumption. The
    // native driver materializes rows, so release the ordinary permit before
    // emitting them: a row consumer may itself issue a query or transaction.
    executeStream: (sql, params, rowTransform) =>
      Stream.fromIterableEffect(withPermit(() => connection.execute(sql, params, rowTransform))),
  };
  const acquirer = Effect.suspend(() =>
    retiring ? Effect.fail(unavailable()) : Effect.succeed(ordinaryConnection),
  );
  const transactionAcquirer = Effect.uninterruptibleMask((restore) => {
    const fiber = Fiber.getCurrent()!;
    const scope = Context.getUnsafe(fiber.context, Scope.Scope);
    return Effect.gen(function* () {
      if (retiring) return yield* Effect.fail(unavailable());
      yield* restore(semaphore.take(1));
      // Retirement may start while this exact borrower waits. Release its own
      // permit synchronously before refusing it; never enter a closing native
      // connection or strand a later shutdown waiter behind a lost permit.
      if (retiring) {
        yield* semaphore.release(1);
        return yield* Effect.fail(unavailable());
      }
      yield* Scope.addFinalizer(scope, semaphore.release(1));
      return connection;
    });
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
  makeClient(
    options,
    makeSqliteWorkerConnection({
      filename: options.filename,
      readonly: options.readonly,
      allowExtension: options.allowExtension,
      busyTimeoutMs: options.busyTimeoutMs,
      prepareCacheSize: options.prepareCacheSize,
      prepareCacheTTLMillis: Duration.toMillis(
        Duration.fromInputUnsafe(options.prepareCacheTTL ?? Duration.minutes(10)),
      ),
    }),
  );

const makeMemory = (
  config: SqliteMemoryClientConfig = {},
): Effect.Effect<Client.SqlClient, never, Scope.Scope | Reactivity.Reactivity> => {
  const options = { ...config, filename: ":memory:", readonly: false };
  return makeClient(
    options,
    makeNativeConnection(
      options,
      () => new DatabaseSync(":memory:", { allowExtension: config.allowExtension ?? false }),
    ),
  );
};

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

/** Filename-based runtime clients always isolate native SQLite execution. */
export const layer = (config: SqliteClientConfig): Layer.Layer<Client.SqlClient> =>
  Layer.effectContext(
    Effect.map(make(config), (client) =>
      Context.make(SqliteClient, client).pipe(Context.add(Client.SqlClient, client)),
    ),
  ).pipe(Layer.provide(Reactivity.layer));

/** The layer owns and closes each database returned by the factory. */
export const layerWithDatabase = (
  config: SqliteClientConfig,
  openDatabase: () => DatabaseSync,
): Layer.Layer<Client.SqlClient> =>
  Layer.effectContext(
    Effect.map(makeClient(config, makeNativeConnection(config, openDatabase)), (client) =>
      Context.make(SqliteClient, client).pipe(Context.add(Client.SqlClient, client)),
    ),
  ).pipe(Layer.provide(Reactivity.layer));

export const layerMemory = (config: SqliteMemoryClientConfig = {}): Layer.Layer<Client.SqlClient> =>
  Layer.effectContext(
    Effect.map(makeMemory(config), (client) =>
      Context.make(SqliteClient, client).pipe(Context.add(Client.SqlClient, client)),
    ),
  ).pipe(Layer.provide(Reactivity.layer));
