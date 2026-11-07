import { assert, it as effectIt } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { DatabaseSync } from "node:sqlite";
// SQLite fixture retains actual native descriptors, file identity and namespace cleanup.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
// SQLite fixture paths retain actual host drive and namespace semantics.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { join } from "node:path";
// The responsiveness regression uses an actual loopback HTTP request while SQLite owns a write lock.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import { createServer, type Server } from "node:http";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { it as nativeIt, vi, type TestContext } from "vitest";

import * as SqliteClient from "./NodeSqliteClient.ts";

// Preserve deliberately malformed/historical fixture values and exact native JSON bytes;
// this codec does not replace production admission or grant received-data authority.
const encodeFixtureJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeFixtureJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

/**
 * Own the real production file-client boundary rather than injecting a database
 * or worker. Native contention belongs to this fixture's separate connection;
 * its HTTP handler is the only normal path which releases the held writer.
 * Register retirement before any acquisition so a hard timeout cannot leave a
 * worker, socket, native database or stderr/environment override behind.
 */
async function createResponsiveSqliteFixture(context: TestContext, diagnostics: boolean) {
  const diagnosticEnvironment = "CAFE_CODE_SQL_STATEMENT_DIAGNOSTICS";
  const previousEnvironment = process.env[diagnosticEnvironment];
  const pending = new Set<Promise<unknown>>();
  const starts = new Set<{ resolve: () => void; reject: (error: Error) => void }>();
  let directory: string | undefined;
  let lockOwner: DatabaseSync | undefined;
  let runtime: ManagedRuntime.ManagedRuntime<SqlClient.SqlClient, never> | undefined;
  let server: Server | undefined;
  let listening: Promise<void> | undefined;
  let restoreStderr: (() => void) | undefined;
  let retired = false;
  let closing: Promise<void> | undefined;
  let diagnosticRemainder = "";

  const track = <T>(work: Promise<T>): Promise<T> => {
    pending.add(work);
    // Retain the original rejecting promise for the caller while also owning
    // its rejection if a preceding assertion prevents the ordinary await.
    void work.finally(() => pending.delete(work)).catch(() => undefined);
    return work;
  };
  const releaseWriter = () => {
    if (lockOwner?.isTransaction) lockOwner.exec("ROLLBACK");
  };
  const assertLive = () => {
    if (retired || context.signal.aborted) throw new Error("SQLite fixture retired.");
  };
  const close = (): Promise<void> => {
    retired = true;
    closing ??= (async () => {
      let cleanupFailed = false;
      for (const start of starts) start.reject(new Error("SQLite fixture retired."));
      starts.clear();
      // Release contention before joining the exact pending SQL/native close;
      // cleanup must not wait for a writer which only this owner can release.
      try {
        releaseWriter();
      } catch {
        cleanupFailed = true;
      }
      await listening?.catch(() => undefined);
      if (server) {
        server.closeAllConnections();
        const ownedServer = server;
        await new Promise<void>((resolve) => {
          ownedServer.close((error) => {
            if (error && !("code" in error && error.code === "ERR_SERVER_NOT_RUNNING")) {
              cleanupFailed = true;
            }
            resolve();
          });
        }).catch(() => {
          cleanupFailed = true;
        });
      }
      await runtime?.dispose().catch(() => {
        cleanupFailed = true;
      });
      await Promise.allSettled([...pending]);
      try {
        lockOwner?.close();
      } catch {
        cleanupFailed = true;
      }
      lockOwner = undefined;
      // Restore globals only after every operation capable of emitting a late
      // native statement observation has been joined and its worker has closed.
      restoreStderr?.();
      diagnosticRemainder = "";
      if (diagnostics) {
        if (previousEnvironment === undefined) delete process.env[diagnosticEnvironment];
        else process.env[diagnosticEnvironment] = previousEnvironment;
      }
      context.signal.removeEventListener("abort", onAbort);
      if (directory) rmSync(directory, { recursive: true, force: true });
      if (cleanupFailed) throw new Error("SQLite fixture cleanup failed.");
    })();
    return closing;
  };
  const onAbort = () => {
    void close().catch(() => undefined);
  };
  context.signal.addEventListener("abort", onAbort, { once: true });
  context.onTestFinished(close);

  assertLive();
  if (diagnostics) {
    process.env[diagnosticEnvironment] = "1";
    const originalWrite = process.stderr.write.bind(process.stderr);
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      // Only the existing bounded, content-free production reporter supplies
      // admission evidence. Ordinary stderr is still forwarded unchanged.
      originalWrite(chunk);
      diagnosticRemainder += text;
      if (diagnosticRemainder.length > 65_536) diagnosticRemainder = "";
      let newline: number;
      while ((newline = diagnosticRemainder.indexOf("\n")) >= 0) {
        const line = diagnosticRemainder.slice(0, newline);
        diagnosticRemainder = diagnosticRemainder.slice(newline + 1);
        const prefix = "[Cafe Code SQLite] ";
        if (!line.startsWith(prefix)) continue;
        let record: Record<string, unknown>;
        try {
          record = decodeFixtureJson(line.slice(prefix.length));
        } catch {
          continue;
        }
        if (
          record.phase === "start" &&
          record.operation === "insert" &&
          record.parameterCount === 1 &&
          Number.isSafeInteger(record.queryId) &&
          typeof record.fingerprint === "string" &&
          /^[a-f0-9]{16}$/.test(record.fingerprint)
        ) {
          const start = starts.values().next().value;
          if (start) {
            starts.delete(start);
            start.resolve();
          }
        }
      }
      return true;
    });
    restoreStderr = () => stderrWrite.mockRestore();
  }
  directory = mkdtempSync(join(tmpdir(), "cafecode-responsive-sqlite-"));
  const filename = join(directory, "state.sqlite");
  lockOwner = new DatabaseSync(filename);
  lockOwner.exec("CREATE TABLE retained(value TEXT NOT NULL); PRAGMA journal_mode = WAL;");
  runtime = ManagedRuntime.make(SqliteClient.layer({ filename, busyTimeoutMs: 5_000 }));
  const ownedRuntime = runtime;
  const sql = await track(
    ownedRuntime.runPromise(Effect.service(SqlClient.SqlClient), { signal: context.signal }),
  );
  assertLive();

  return {
    filename,
    sql,
    runtime: ownedRuntime,
    track,
    releaseWriter,
    holdWriter: () => {
      assertLive();
      lockOwner!.exec("BEGIN IMMEDIATE");
    },
    nextInsertStart: () => {
      assertLive();
      return track(
        new Promise<void>((resolve, reject) => {
          starts.add({ resolve, reject });
        }),
      );
    },
    heartbeatUrl: async () => {
      assertLive();
      server = createServer((_request, response) => {
        if (retired) {
          response.destroy();
          return;
        }
        releaseWriter();
        response.writeHead(200, { "Content-Type": "text/plain" });
        response.end("responsive");
      });
      const ownedServer = server;
      listening = track(
        new Promise<void>((resolve, reject) => {
          ownedServer.once("error", reject);
          ownedServer.listen(0, "127.0.0.1", () => {
            ownedServer.off("error", reject);
            resolve();
          });
        }),
      );
      await listening;
      assertLive();
      const address = ownedServer.address();
      if (!address || typeof address === "string")
        throw new Error("SQLite fixture did not listen.");
      return `http://127.0.0.1:${address.port}/heartbeat`;
    },
    close,
  };
}

nativeIt("keeps HTTP responsive during a native SQLite writer wait", async (context) => {
  const fixture = await createResponsiveSqliteFixture(context, true);
  try {
    const url = await fixture.heartbeatUrl();
    fixture.holdWriter();
    const nativeStart = fixture.nextInsertStart();
    let settled = false;
    const insert = fixture.track(
      fixture.runtime.runPromise(fixture.sql`INSERT INTO retained(value) VALUES (${"committed"})`),
    );
    void insert.finally(() => (settled = true)).catch(() => undefined);
    await nativeStart;
    // A synchronous main-thread SQLite implementation cannot reach this HTTP
    // request until the held write has already exhausted its native timeout.
    assert.equal(settled, false);
    const heartbeat = await fixture.track(
      (async () => {
        const response = await fetch(url, { signal: context.signal });
        return { status: response.status, body: await response.text() };
      })(),
    );
    assert.deepStrictEqual(heartbeat, { status: 200, body: "responsive" });
    await insert;
    const rows = await fixture.track(
      fixture.runtime.runPromise(fixture.sql`SELECT value FROM retained`),
    );
    assert.deepStrictEqual(rows, [{ value: "committed" }]);
  } finally {
    await fixture.close();
  }
});

nativeIt(
  "joins an interrupted native write and rollback before admitting the next transaction",
  async (context) => {
    const fixture = await createResponsiveSqliteFixture(context, true);
    try {
      fixture.holdWriter();
      const nativeStart = fixture.nextInsertStart();
      const canceled = fixture.runtime.runFork(
        fixture.sql.withTransaction(
          fixture.sql`INSERT INTO retained(value) VALUES (${"canceled"})`,
        ),
      );
      await nativeStart;
      let interruptionFinished = false;
      const interrupted = fixture.track(
        fixture.runtime.runPromise(
          Fiber.interrupt(canceled).pipe(Effect.andThen(Fiber.await(canceled))),
        ),
      );
      void interrupted.then(() => (interruptionFinished = true)).catch(() => undefined);
      let nextFinished = false;
      const next = fixture.track(
        fixture.runtime.runPromise(
          fixture.sql.withTransaction(fixture.sql`INSERT INTO retained(value) VALUES (${"next"})`),
        ),
      );
      void next.finally(() => (nextFinished = true)).catch(() => undefined);
      // Yield through the real event loop, without sleeping or granting either
      // query a different deadline. Both operations remain owned and pending.
      // The native event-loop boundary is the behavior this regression protects.
      await fixture.track(new Promise<void>((resolve) => setImmediate(resolve)));
      assert.equal(interruptionFinished, false);
      assert.equal(nextFinished, false);
      fixture.releaseWriter();
      const exit = await interrupted;
      assert.equal(exit._tag, "Failure");
      if (exit._tag === "Failure") assert.equal(Cause.hasInterrupts(exit.cause), true);
      await next;
      const rows = await fixture.track(
        fixture.runtime.runPromise(fixture.sql`SELECT value FROM retained`),
      );
      assert.deepStrictEqual(rows, [{ value: "next" }]);
      await fixture.runtime.dispose();
      // A completed runtime disposal must leave durable, rolled-back SQLite
      // state which a new independent native owner can open immediately.
      const reopened = new DatabaseSync(fixture.filename);
      try {
        assert.deepStrictEqual(reopened.prepare("SELECT value FROM retained").all(), [
          { value: "next" },
        ]);
      } finally {
        reopened.close();
      }
    } finally {
      await fixture.close();
    }
  },
);

nativeIt(
  "drains an active transaction before closing its native database owner",
  async (context) => {
    const fixture = await createResponsiveSqliteFixture(context, true);
    try {
      fixture.holdWriter();
      const nativeStart = fixture.nextInsertStart();
      const writer = fixture.runtime.runFork(
        fixture.sql.withTransaction(
          fixture.sql`INSERT INTO retained(value) VALUES (${"shutdown-pending"})`,
        ),
      );
      await nativeStart;
      let closed = false;
      const disposal = fixture.track(fixture.runtime.dispose());
      void disposal.then(() => (closed = true)).catch(() => undefined);
      // Observe a genuine main-thread turn while the worker's write is held.
      // Native closure must wait for that statement and its owner's rollback.
      await fixture.track(new Promise<void>((resolve) => setImmediate(resolve)));
      assert.equal(closed, false);
      fixture.releaseWriter();
      await disposal;
      // The runtime is deliberately closed; observing the already-owned fiber
      // needs no database service and must not reacquire the retired runtime.
      const terminal = await Effect.runPromise(Fiber.await(writer));
      assert.equal(terminal._tag, "Failure");
      if (terminal._tag === "Failure") assert.equal(Cause.hasInterrupts(terminal.cause), true);
      const reopened = new DatabaseSync(fixture.filename);
      try {
        assert.deepStrictEqual(reopened.prepare("SELECT value FROM retained").all(), []);
      } finally {
        reopened.close();
      }
    } finally {
      await fixture.close();
    }
  },
);

nativeIt(
  "allows materialized-row consumers to update and query the same client",
  async (context) => {
    const fixture = await createResponsiveSqliteFixture(context, false);
    try {
      await fixture.track(
        fixture.runtime.runPromise(
          Effect.gen(function* () {
            const sql = fixture.sql;
            yield* sql`INSERT INTO retained(value) VALUES (${"first"}), (${"second"})`;
            const consumed = yield* sql<{ readonly value: string }>`
              SELECT value FROM retained ORDER BY rowid
            `.stream.pipe(
              Stream.mapEffect((row) =>
                Effect.gen(function* () {
                  // Rows have already been materialized. Their consumer must
                  // not retain a connection permit needed by its own queries.
                  yield* sql`UPDATE retained SET value = (${row.value + "-updated"})
                    WHERE value = (${row.value})`;
                  const totals = yield* sql.withTransaction(
                    sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM retained`,
                  );
                  return { value: row.value, count: totals[0]?.count };
                }),
              ),
              Stream.runCollect,
            );
            assert.deepStrictEqual(consumed, [
              { value: "first", count: 2 },
              { value: "second", count: 2 },
            ]);
            const stored = yield* sql`SELECT value FROM retained ORDER BY rowid`;
            assert.deepStrictEqual(stored, [
              { value: "first-updated" },
              { value: "second-updated" },
            ]);
          }),
          { signal: context.signal },
        ),
      );
    } finally {
      await fixture.close();
    }
  },
);

nativeIt(
  "retains SQLite result modes, safe integers and binary values across the file-client boundary",
  async (context) => {
    const fixture = await createResponsiveSqliteFixture(context, false);
    try {
      await fixture.track(
        fixture.runtime.runPromise(
          Effect.gen(function* () {
            const sql = fixture.sql;
            yield* sql`CREATE TABLE values_probe(id INTEGER PRIMARY KEY, large INTEGER, bytes BLOB, missing TEXT)`;
            const inputBytes = new Uint8Array([0, 1, 255]);
            const result = yield* sql`INSERT INTO values_probe(large, bytes, missing)
            VALUES (${9_223_372_036_854_775_807n}, ${inputBytes}, ${null})`.raw;
            assert.deepStrictEqual(result, { changes: 1, lastInsertRowid: 1 });
            assert.equal(inputBytes.byteLength, 3);
            assert.deepStrictEqual(inputBytes, new Uint8Array([0, 1, 255]));
            const expected = [
              {
                id: 1n,
                large: 9_223_372_036_854_775_807n,
                bytes: new Uint8Array([0, 1, 255]),
                missing: null,
              },
            ];
            const query = sql`SELECT id, large, bytes, missing FROM values_probe`;
            const safe = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
              Effect.provideService(effect, SqlClient.SafeIntegers, true);
            const prepared = yield* safe(query);
            assert.deepStrictEqual(prepared, expected);
            assert.equal(Object.getPrototypeOf(prepared[0]), null);
            assert.deepStrictEqual(yield* safe(query.unprepared), expected);
            assert.deepStrictEqual(yield* safe(Stream.runCollect(query.stream)), expected);
            assert.deepStrictEqual(yield* safe(query.values), [
              [1n, 9_223_372_036_854_775_807n, new Uint8Array([0, 1, 255]), null],
            ]);
            const idQuery = sql`SELECT id FROM values_probe`;
            assert.deepStrictEqual(yield* safe(idQuery), [{ id: 1n }]);
            assert.deepStrictEqual(yield* idQuery, [{ id: 1 }]);
          }),
        ),
      );
    } finally {
      await fixture.close();
    }
  },
);

effectIt("NodeSqliteClient statement diagnostics stay redacted and opt-in", () =>
  Effect.sync(() => {
    const records: unknown[] = [];
    const clock = [100, 131];
    const enabled = SqliteClient.makeSqliteStatementDiagnosticReporter({
      enabled: true,
      write: (record) => records.push(record),
      now: () => clock.shift() ?? 131,
      slowStatementMs: 25,
    });
    const sqlText = "SELECT value FROM private_entries WHERE token = ?";
    const secretParameter = "sk-never-log-this-value";

    const result = enabled(sqlText, 1, () => secretParameter.length);
    assert.equal(result, secretParameter.length);
    assert.equal(records.length, 2);
    const serialized = encodeFixtureJson(records);
    assert.equal(serialized.includes(sqlText), false);
    assert.equal(serialized.includes("private_entries"), false);
    assert.equal(serialized.includes(secretParameter), false);
    assert.deepInclude(records[0] as object, {
      phase: "start",
      operation: "select",
      parameterCount: 1,
    });
    assert.deepInclude(records[1] as object, {
      phase: "slow-complete",
      operation: "select",
      parameterCount: 1,
      durationMs: 31,
      outcome: "success",
    });

    const disabledRecords: unknown[] = [];
    const disabled = SqliteClient.makeSqliteStatementDiagnosticReporter({
      enabled: false,
      write: (record) => disabledRecords.push(record),
    });
    assert.equal(
      disabled(sqlText, 1, () => 42),
      42,
    );
    assert.deepStrictEqual(disabledRecords, []);
  }),
);

effectIt(
  "NodeSqliteClient statement diagnostics preserve native failures without retaining them",
  () =>
    Effect.sync(() => {
      const records: unknown[] = [];
      const clock = [10, 40];
      const report = SqliteClient.makeSqliteStatementDiagnosticReporter({
        enabled: true,
        write: (record) => records.push(record),
        now: () => clock.shift() ?? 40,
        slowStatementMs: 25,
      });
      const sqlText = "INSERT INTO private_entries(value) VALUES (?)";
      const nativeFailure = new Error("private failure with sk-never-log-this-value");

      let observedFailure: unknown;
      try {
        report(sqlText, 1, () => {
          throw nativeFailure;
        });
      } catch (cause) {
        observedFailure = cause;
      }
      assert.strictEqual(observedFailure, nativeFailure);
      assert.equal(records.length, 2);
      assert.deepInclude(records[1] as object, {
        phase: "slow-complete",
        operation: "insert",
        parameterCount: 1,
        durationMs: 30,
        outcome: "failure",
      });
      const serialized = encodeFixtureJson(records);
      assert.equal(serialized.includes(sqlText), false);
      assert.equal(serialized.includes("private_entries"), false);
      assert.equal(serialized.includes(nativeFailure.message), false);
      assert.equal(serialized.includes("sk-never-log-this-value"), false);
    }),
);

effectIt.effect("NodeSqliteClient diagnoses native writes in every execution mode", () =>
  Effect.gen(function* () {
    // Use only an isolated in-memory database. Capture the real production
    // reporter boundary so this fails when any `.run()` route bypasses it.
    const envName = "CAFE_CODE_SQL_STATEMENT_DIAGNOSTICS";
    const previousEnvironment = process.env[envName];
    process.env[envName] = "1";
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const created =
            yield* sql`CREATE TABLE private_writes(id INTEGER PRIMARY KEY, value TEXT NOT NULL)`;
          assert.deepStrictEqual(created, []);

          const secretParameter = "sk-never-log-this-write";
          const raw = yield* sql`INSERT INTO private_writes(value) VALUES (${secretParameter})`.raw;
          assert.deepStrictEqual(raw, { changes: 1, lastInsertRowid: 1 });

          const values =
            yield* sql`UPDATE private_writes SET value = (${"changed-private-value"}) WHERE id = (${1})`
              .values;
          assert.deepStrictEqual(values, []);
          const unprepared = yield* sql`DELETE FROM private_writes WHERE id = (${1})`.unprepared;
          assert.deepStrictEqual(unprepared, []);
          const rows = yield* sql`SELECT value FROM private_writes`;
          assert.deepStrictEqual(rows, []);
        }).pipe(Effect.provide(SqliteClient.layerMemory())),
      );

      const diagnosticPrefix = "[Cafe Code SQLite] ";
      const lines = stderrWrite.mock.calls.flatMap(([chunk]) =>
        typeof chunk === "string" && chunk.startsWith(diagnosticPrefix) ? [chunk] : [],
      );
      const records = lines.map((line) => decodeFixtureJson(line.slice(diagnosticPrefix.length)));
      const starts = records.filter((record) => record.phase === "start");
      assert.deepStrictEqual(
        starts.map(({ operation, parameterCount }) => ({ operation, parameterCount })),
        [
          { operation: "create", parameterCount: 0 },
          { operation: "insert", parameterCount: 1 },
          { operation: "update", parameterCount: 2 },
          { operation: "delete", parameterCount: 1 },
          { operation: "select", parameterCount: 0 },
        ],
      );
      const serialized = encodeFixtureJson(records);
      assert.equal(serialized.includes("private_writes"), false);
      assert.equal(serialized.includes("sk-never-log-this-write"), false);
      assert.equal(serialized.includes("changed-private-value"), false);
    } finally {
      stderrWrite.mockRestore();
      if (previousEnvironment === undefined) {
        delete process.env[envName];
      } else {
        process.env[envName] = previousEnvironment;
      }
    }
  }),
);

const layer = effectIt.layer(SqliteClient.layerMemory());

layer("NodeSqliteClient", (it) => {
  it.effect("runs prepared queries and returns positional values", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* sql`CREATE TABLE entries(id INTEGER PRIMARY KEY, name TEXT NOT NULL)`;
      yield* sql`INSERT INTO entries(name) VALUES (${"alpha"}), (${"beta"})`;

      const rows = yield* sql<{ readonly id: number; readonly name: string }>`
        SELECT id, name FROM entries ORDER BY id
      `;
      assert.equal(rows.length, 2);
      assert.equal(rows[0]?.name, "alpha");
      assert.equal(rows[1]?.name, "beta");

      const values = yield* sql`SELECT id, name FROM entries ORDER BY id`.values;
      assert.equal(values.length, 2);
      assert.equal(values[0]?.[1], "alpha");
      assert.equal(values[1]?.[1], "beta");

      const streamed = yield* Stream.runCollect(
        sql<{ readonly name: string }>`SELECT name FROM entries ORDER BY id`.stream,
      );
      assert.deepStrictEqual([...streamed], [{ name: "alpha" }, { name: "beta" }]);
    }),
  );

  it.effect("commits successful transactions and rolls back failures", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE transactions(value TEXT NOT NULL)`;

      yield* sql.withTransaction(sql`INSERT INTO transactions(value) VALUES (${"committed"})`);
      yield* Effect.flip(
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO transactions(value) VALUES (${"rolled-back"})`;
            return yield* Effect.fail("force rollback");
          }),
        ),
      );

      const rows = yield* sql<{ readonly value: string }>`SELECT value FROM transactions`;
      assert.deepStrictEqual(rows, [{ value: "committed" }]);
    }),
  );

  it.effect("supports raw and unprepared statement execution", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE execution_modes(value INTEGER NOT NULL)`;

      const raw = yield* sql`INSERT INTO execution_modes(value) VALUES (${42})`.raw;
      assert.isObject(raw);
      const rows = yield* sql<{ readonly value: number }>`SELECT value FROM execution_modes`
        .unprepared;
      assert.deepStrictEqual(rows, [{ value: 42 }]);
    }),
  );
});

const busyTimeoutLayer = effectIt.layer(SqliteClient.layerMemory({ busyTimeoutMs: 1234 }));

busyTimeoutLayer("NodeSqliteClient busy timeout", (it) => {
  it.effect("configures sqlite to wait for transient writer locks", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly timeout: number }>`PRAGMA busy_timeout`;

      assert.equal(rows[0]?.timeout, 1234);
    }),
  );
});

effectIt.effect("NodeSqliteClient closes file databases and reopens their data", () =>
  Effect.gen(function* () {
    const directory = mkdtempSync(join(tmpdir(), "cafecode-node-sqlite-reopen-"));
    const filename = join(directory, "state.sqlite");
    try {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`CREATE TABLE durable(value TEXT NOT NULL)`;
          yield* sql`INSERT INTO durable(value) VALUES (${"persisted"})`;
        }).pipe(Effect.provide(SqliteClient.layer({ filename }))),
      );

      const rows = yield* Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql<{ readonly value: string }>`SELECT value FROM durable`;
        }).pipe(Effect.provide(SqliteClient.layer({ filename }))),
      );
      assert.deepStrictEqual(rows, [{ value: "persisted" }]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }),
);

effectIt.effect("NodeSqliteClient classifies a second writer lock as retryable SqlError", () =>
  Effect.gen(function* () {
    const directory = mkdtempSync(join(tmpdir(), "cafecode-node-sqlite-lock-"));
    const filename = join(directory, "state.sqlite");
    const lockOwner = new DatabaseSync(filename);
    try {
      lockOwner.exec("CREATE TABLE locked(value TEXT NOT NULL); BEGIN IMMEDIATE;");
      const exit = yield* Effect.scoped(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO locked(value) VALUES (${"blocked"})`;
        }).pipe(Effect.provide(SqliteClient.layer({ filename, busyTimeoutMs: 25 })), Effect.exit),
      );
      assert.equal(exit._tag, "Failure");
      if (exit._tag !== "Failure") {
        return;
      }

      const failure = Cause.findErrorOption(exit.cause);
      assert.equal(Option.isSome(failure), true);
      if (Option.isNone(failure)) {
        return;
      }

      const error = failure.value;
      assert.equal(error._tag, "SqlError");
      assert.equal(error.reason._tag, "LockTimeoutError");
      assert.equal(error.isRetryable, true);

      // Preserve the real node:sqlite exception rather than a facade carrying
      // a synthesized `errno`. This keeps native stack/message/metadata intact
      // for local diagnostics while classification remains retryable.
      const nativeCause = error.reason.cause;
      assert.instanceOf(nativeCause, Error);
      assert.equal(Reflect.get(nativeCause as object, "code"), "ERR_SQLITE_ERROR");
      assert.equal(Reflect.get(nativeCause as object, "errcode"), 5);
      assert.equal(Reflect.has(nativeCause as object, "errno"), false);
    } finally {
      lockOwner.exec("ROLLBACK");
      lockOwner.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }),
);
