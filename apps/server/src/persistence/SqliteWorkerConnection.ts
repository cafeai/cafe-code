// The exact Worker and its private MessagePort are the native DB owner. Do not
// replace this boundary with a pool, detached child, ambient socket or PID scan.
// Native thread identity and actual exit are the database ownership boundary.
import { Worker } from "node:worker_threads";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Client from "effect/unstable/sql/SqlClient";
import type { Connection } from "effect/unstable/sql/SqlConnection";
import { SqlError } from "effect/unstable/sql/SqlError";
import { registerSqliteWorkerDiagnostics } from "@cafecode/shared/providerPipelineDiagnostics";
import {
  classifyNodeSqliteError,
  SQLITE_STATEMENT_DIAGNOSTICS_ENV,
  writeSqliteStatementDiagnostic,
} from "./sqliteError.ts";
import {
  decodeSqliteWorkerReply,
  restoreSqliteWorkerNativeError,
  snapshotSqliteWorkerBindings,
  type SqliteWorkerOptions,
  type SqliteWorkerRequest,
  type SqliteWorkerResult,
} from "./sqliteWorkerProtocol.ts";

export interface SqliteWorkerConnectionOptions {
  readonly filename: string;
  readonly readonly?: boolean | undefined;
  readonly allowExtension?: boolean | undefined;
  readonly busyTimeoutMs?: number | undefined;
  readonly prepareCacheSize?: number | undefined;
  readonly prepareCacheTTLMillis?: number | undefined;
}

/** A transport failure is deliberately not a native retryable SQLite error. */
const unavailable = () => new Error("The owned SQLite worker connection is unavailable.");
const isSqlError = Schema.is(SqlError);

interface PendingOperation {
  readonly id: number;
  readonly mode: "rows" | "raw" | "values";
  readonly resolve: (result: SqliteWorkerResult) => void;
  readonly reject: (cause: unknown) => void;
  readonly finishDiagnostic: (outcome: "success" | "failure") => void;
  diagnosticCount: number;
}

/**
 * A single-operation private transport. Its caller also holds an Effect
 * semaphore until the exact reply: cancellation cannot release native work
 * into a different transaction or make an unacknowledged write replayable.
 */
class OwnedSqliteWorker {
  private readonly worker: Worker;
  private readonly diagnostics = registerSqliteWorkerDiagnostics();
  private readonly ready: Promise<void>;
  private readyResolve!: () => void;
  private readyReject!: (cause: unknown) => void;
  private readonly exited: Promise<number>;
  private exitResolve!: (code: number) => void;
  private pending: PendingOperation | undefined;
  private nextId = 0;
  private initialized = false;
  private retired = false;
  private exitCode: number | undefined;
  private failure: Error | undefined;
  private openingFailure: Error | undefined;
  private closeId: number | undefined;
  private closeAcknowledged = false;
  private closePromise: Promise<void> | undefined;
  private failureRecorded = false;
  private readonly statementDiagnostics: boolean;

  constructor(options: SqliteWorkerOptions) {
    this.statementDiagnostics = options.statementDiagnostics;
    this.ready = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    // Startup failure may precede the Effect waiter by one event-loop turn.
    // Observe it here as well, without converting it into successful startup.
    void this.ready.catch(() => undefined);
    this.exited = new Promise((resolve) => {
      this.exitResolve = resolve;
    });
    try {
      this.worker = new Worker(
        new URL(
          import.meta.url.endsWith(".ts") ? "./sqliteWorkerEntry.ts" : "./sqlite-worker.mjs",
          import.meta.url,
        ),
        { workerData: options },
      );
    } catch {
      // Construction acquired no Worker owner. Do not leave a live diagnostic
      // registration behind when no native exit event can ever arrive.
      this.diagnostics.recordWorkerFailure();
      this.diagnostics.close();
      throw unavailable();
    }

    this.worker.on("message", (value: unknown) => this.onMessage(value));
    this.worker.on("messageerror", () => this.failProtocol());
    this.worker.on("error", () => {
      // Node follows an uncaught worker error with its actual exit event. Hold
      // the active request until then; an error notification alone does not
      // establish that native database ownership has ended.
      this.failure ??= unavailable();
      this.retired = true;
    });
    this.worker.once("exit", (code) => {
      this.exitCode = code;
      const expected = this.closeAcknowledged && code === 0 && this.failure === undefined;
      if (!expected) {
        this.failure ??= this.openingFailure ?? unavailable();
        this.recordWorkerFailure();
      }
      this.retired = true;
      if (!this.initialized) this.readyReject(this.openingFailure ?? this.failure ?? unavailable());
      const pending = this.pending;
      this.pending = undefined;
      if (pending) {
        pending.finishDiagnostic("failure");
        pending.reject(this.failure ?? unavailable());
      }
      this.diagnostics.close();
      this.exitResolve(code);
    });
  }

  private recordWorkerFailure(): void {
    if (this.failureRecorded) return;
    this.failureRecorded = true;
    this.diagnostics.recordWorkerFailure();
  }

  private sendClose(): void {
    if (this.closeId !== undefined || this.exitCode !== undefined) return;
    // Execution always reserves the last safe id for ordered close. A protocol
    // event handler must never throw while it still owns an open connection.
    if (this.nextId >= Number.MAX_SAFE_INTEGER) {
      this.failure ??= unavailable();
      return;
    }
    this.closeId = ++this.nextId;
    try {
      this.worker.postMessage({
        version: 1,
        type: "close",
        id: this.closeId,
      } satisfies SqliteWorkerRequest);
    } catch {
      // There is no safe fallback to terminate a possibly busy native writer.
      // Keep the owner held and await its real exit; never report a false close.
      this.failure ??= unavailable();
    }
  }

  private failProtocol(): void {
    this.failure ??= unavailable();
    this.retired = true;
    // The exact worker is still ours. An ordered close request runs only after
    // any in-flight synchronous statement; it is not termination or recovery.
    // Pending callers remain held until that native owner actually exits.
    this.sendClose();
  }

  private onMessage(value: unknown): void {
    const reply = decodeSqliteWorkerReply(value);
    if (!reply) {
      this.failProtocol();
      return;
    }
    if (reply.type === "ready") {
      if (this.initialized || this.openingFailure !== undefined || this.exitCode !== undefined) {
        this.failProtocol();
        return;
      }
      // A ready frame queued before a protocol failure cannot resurrect an
      // owner already fenced for ordered retirement.
      if (this.failure !== undefined) return;
      this.initialized = true;
      this.readyResolve();
      return;
    }
    if (reply.type === "failure" && reply.id === 0 && reply.phase === "open") {
      if (this.initialized || this.openingFailure !== undefined) {
        this.failProtocol();
        return;
      }
      this.openingFailure = restoreSqliteWorkerNativeError(reply.error);
      this.retired = true;
      // A failed open must join worker exit before acquisition can fail and
      // release the scope that owns its potentially opened native connection.
      return;
    }
    if (reply.type === "closed") {
      if (reply.id !== this.closeId || this.closeAcknowledged || !this.initialized) {
        this.failProtocol();
        return;
      }
      this.closeAcknowledged = true;
      return;
    }
    if (reply.type === "failure" && reply.phase === "close") {
      if (reply.id !== this.closeId) {
        this.failProtocol();
        return;
      }
      this.failure ??= restoreSqliteWorkerNativeError(reply.error);
      return;
    }
    const pending = this.pending;
    if (!this.initialized || !pending || reply.id !== pending.id) {
      this.failProtocol();
      return;
    }
    if (reply.type === "diagnostic") {
      if (!this.statementDiagnostics || ++pending.diagnosticCount > 2) {
        this.failProtocol();
        return;
      }
      writeSqliteStatementDiagnostic(reply.record);
      return;
    }
    if (this.failure !== undefined) return;
    if (reply.type === "failure") {
      if (reply.phase !== "prepare" && reply.phase !== "execute") {
        this.failProtocol();
        return;
      }
      this.pending = undefined;
      pending.finishDiagnostic("failure");
      pending.reject(
        new SqlError({
          reason: classifyNodeSqliteError(restoreSqliteWorkerNativeError(reply.error), {
            message:
              reply.phase === "prepare"
                ? "Failed to prepare statement"
                : "Failed to execute statement",
            operation: reply.phase,
          }),
        }),
      );
      return;
    }
    if (
      reply.type !== "result" ||
      (pending.mode === "values" && reply.result.kind === "rows") ||
      (pending.mode !== "values" && reply.result.kind === "values")
    ) {
      this.failProtocol();
      return;
    }
    this.pending = undefined;
    pending.finishDiagnostic("success");
    pending.resolve(reply.result);
  }

  waitUntilReady(): Promise<void> {
    return this.ready;
  }

  /** Fence new admissions synchronously, before the finalizer's first await. */
  retire(): void {
    this.retired = true;
  }

  execute(
    request: Omit<Extract<SqliteWorkerRequest, { readonly type: "execute" }>, "id">,
  ): Promise<SqliteWorkerResult> {
    if (
      !this.initialized ||
      this.retired ||
      this.failure !== undefined ||
      this.pending ||
      this.exitCode !== undefined
    )
      return Promise.reject(unavailable());
    // Structured clone alone retains SharedArrayBuffer aliases. Take an own
    // descriptor-only snapshot after admission, before any native dispatch, so
    // later caller mutations cannot alter this operation's blob bindings.
    const params = snapshotSqliteWorkerBindings(request.params);
    if (params === undefined) {
      return Promise.reject(
        new SqlError({
          reason: classifyNodeSqliteError(new TypeError("Unsupported SQLite bind parameter."), {
            message: "Failed to execute statement",
            operation: "execute",
          }),
        }),
      );
    }
    if (this.nextId >= Number.MAX_SAFE_INTEGER - 1) {
      this.retired = true;
      return Promise.reject(unavailable());
    }
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const finishDiagnostic = this.diagnostics.beginOperation();
      this.pending = {
        id,
        mode: request.mode,
        resolve,
        reject,
        finishDiagnostic,
        diagnosticCount: 0,
      };
      try {
        // No transfer list: bound blobs remain owned by their callers instead
        // of detaching application buffers as a transport optimization.
        this.worker.postMessage({ ...request, params, id });
      } catch {
        // Structured-clone refusal dispatches no native statement. Preserve a
        // normal non-retryable SQL failure without poisoning a usable owner.
        this.pending = undefined;
        finishDiagnostic("failure");
        reject(
          new SqlError({
            reason: classifyNodeSqliteError(unavailable(), {
              message: "Failed to execute statement",
              operation: "execute",
            }),
          }),
        );
      }
    });
  }

  close(): Promise<void> {
    this.retire();
    this.closePromise ??= (async () => {
      try {
        await this.ready;
      } catch {
        /* Native exit already owns startup failure. */
      }
      this.sendClose();
      const code = await this.exited;
      if (code !== 0 || !this.closeAcknowledged || this.failure !== undefined)
        throw this.failure ?? this.openingFailure ?? unavailable();
    })();
    return this.closePromise;
  }
}

/** Rebuild only own row data, preserving null prototypes across clone. */
function materializeResult(result: SqliteWorkerResult, raw: boolean): ReadonlyArray<any> {
  if (result.kind === "values") return result.rows;
  if (result.kind === "write")
    return raw
      ? ({
          changes: result.changes,
          lastInsertRowid: result.lastInsertRowid,
        } as unknown as ReadonlyArray<any>)
      : [];
  return result.rows.map((row, index) => {
    const copy = Object.create(result.nullPrototypes[index] ? null : Object.prototype) as Record<
      string,
      unknown
    >;
    for (const key of Object.keys(row)) {
      Object.defineProperty(copy, key, {
        value: row[key],
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return copy;
  });
}

/**
 * Build a single scoped database worker. Every admitted operation is joined
 * before cancellation, transaction rollback, connection release or native close.
 * The injected DatabaseSync fixture path remains separate in NodeSqliteClient.
 */
export const makeSqliteWorkerConnection = (
  options: SqliteWorkerConnectionOptions,
): Effect.Effect<Connection, never, Scope.Scope> =>
  Effect.gen(function* () {
    const busyTimeoutMs =
      options.busyTimeoutMs === undefined ||
      !Number.isFinite(options.busyTimeoutMs) ||
      options.busyTimeoutMs <= 0
        ? 0
        : Math.min(60_000, Math.trunc(options.busyTimeoutMs));
    const semaphore = yield* Semaphore.make(1);
    const owner = yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new OwnedSqliteWorker({
            filename: options.filename,
            readonly: options.readonly ?? false,
            allowExtension: options.allowExtension ?? false,
            busyTimeoutMs,
            prepareCacheSize: options.prepareCacheSize ?? 200,
            prepareCacheTTLMillis: options.prepareCacheTTLMillis ?? 600_000,
            statementDiagnostics: process.env[SQLITE_STATEMENT_DIAGNOSTICS_ENV] === "1",
          }),
      ),
      (worker) =>
        Effect.sync(() => worker.retire()).pipe(
          Effect.andThen(semaphore.withPermits(1)(Effect.promise(() => worker.close()))),
        ),
    );
    yield* Effect.promise(() => owner.waitUntilReady());

    const execute = (
      sql: string,
      params: ReadonlyArray<unknown>,
      mode: "rows" | "raw" | "values",
      unprepared = false,
    ) =>
      Effect.withFiber<ReadonlyArray<any>, SqlError>((fiber) => {
        // Context must be captured from the requesting fiber, never from the
        // worker's initialization environment or a previous prepared statement.
        const safeIntegers = Boolean(Context.get(fiber.context, Client.SafeIntegers));
        return Effect.uninterruptibleMask((restore) =>
          Effect.flatMap(restore(semaphore.take(1)), () =>
            Effect.tryPromise({
              try: () =>
                owner.execute({
                  version: 1,
                  type: "execute",
                  sql,
                  params,
                  safeIntegers,
                  mode,
                  unprepared,
                }),
              catch: (cause) =>
                isSqlError(cause)
                  ? cause
                  : new SqlError({
                      reason: classifyNodeSqliteError(cause, {
                        message: "Failed to execute statement",
                        operation: "execute",
                      }),
                    }),
            }).pipe(
              Effect.map((result) => materializeResult(result, mode === "raw")),
              Effect.ensuring(semaphore.release(1)),
            ),
          ),
        );
      });

    return {
      execute: (sql, params, transformRows) =>
        transformRows
          ? Effect.map(execute(sql, params, "rows"), transformRows)
          : execute(sql, params, "rows"),
      executeRaw: (sql, params) => execute(sql, params, "raw"),
      executeValues: (sql, params) => execute(sql, params, "values"),
      executeUnprepared: (sql, params, transformRows) =>
        transformRows
          ? Effect.map(execute(sql, params, "rows", true), transformRows)
          : execute(sql, params, "rows", true),
      executeStream: (sql, params, transformRows) =>
        Stream.fromIterableEffect(
          transformRows
            ? Effect.map(execute(sql, params, "rows"), transformRows)
            : execute(sql, params, "rows"),
        ),
    } satisfies Connection;
  });
