/**
 * Private, structured-clone-only protocol for one SQLite connection owner.
 *
 * A worker is not an independently addressable database service. Its exact
 * Worker/MessagePort is the authority; monotonically increasing request ids
 * reject late, duplicated and unsolicited replies on that held owner. SQL and
 * bound values belong only on this private channel, never in diagnostics.
 */
import type { SqliteStatementDiagnosticRecord } from "./sqliteError.ts";

export const SQLITE_WORKER_PROTOCOL_VERSION = 1;
// Native error text can contain unrestricted local data. It remains private,
// but an invalid statement must not manufacture an unbounded error envelope.
const NATIVE_ERROR_TEXT_MAX_CHARS = 64 * 1024;
const NATIVE_ERROR_LABEL_MAX_CHARS = 256;

export interface SqliteWorkerOptions {
  readonly filename: string;
  readonly readonly: boolean;
  readonly allowExtension: boolean;
  readonly busyTimeoutMs: number;
  readonly prepareCacheSize: number;
  readonly prepareCacheTTLMillis: number;
  readonly statementDiagnostics: boolean;
}

export type SqliteWorkerValue = null | string | number | bigint | Uint8Array;

/** Only own native error data is transported. No getter or coercion is run. */
export interface SqliteWorkerNativeError {
  readonly name?: string;
  readonly message?: string;
  readonly stack?: string;
  readonly code?: string | number;
  readonly errcode?: number;
  readonly errno?: number;
  readonly errstr?: string;
}

export type SqliteWorkerRequest =
  | {
      readonly version: 1;
      readonly type: "execute";
      readonly id: number;
      readonly sql: string;
      readonly params: ReadonlyArray<unknown>;
      readonly safeIntegers: boolean;
      readonly mode: "rows" | "raw" | "values";
      readonly unprepared: boolean;
    }
  | { readonly version: 1; readonly type: "close"; readonly id: number };

export type SqliteWorkerResult =
  | {
      readonly kind: "rows";
      readonly rows: ReadonlyArray<Readonly<Record<string, SqliteWorkerValue>>>;
      // Structured clone normalizes prototypes. Keep the native row contract,
      // including adversarial column names, through explicit own-data copies.
      readonly nullPrototypes: ReadonlyArray<boolean>;
    }
  | { readonly kind: "values"; readonly rows: ReadonlyArray<ReadonlyArray<SqliteWorkerValue>> }
  | {
      readonly kind: "write";
      readonly changes: number | bigint;
      readonly lastInsertRowid: number | bigint;
    };

export type SqliteWorkerReply =
  | { readonly version: 1; readonly type: "ready" }
  | {
      readonly version: 1;
      readonly type: "diagnostic";
      readonly id: number;
      readonly record: SqliteStatementDiagnosticRecord;
    }
  | {
      readonly version: 1;
      readonly type: "result";
      readonly id: number;
      readonly result: SqliteWorkerResult;
    }
  | { readonly version: 1; readonly type: "closed"; readonly id: number }
  | {
      readonly version: 1;
      readonly type: "failure";
      readonly id: number;
      readonly phase: "open" | "prepare" | "execute" | "close";
      readonly error: SqliteWorkerNativeError;
    };

/** Reject accessors/proxies before consuming a received record. */
function dataRecord(value: unknown): Record<string, unknown> | undefined {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== null && prototype !== Object.prototype) return undefined;
    const result: Record<string, unknown> = Object.create(null);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") return undefined;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) return undefined;
      Object.defineProperty(result, key, { value: descriptor.value, enumerable: true });
    }
    return result;
  } catch {
    return undefined;
  }
}

function keys(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  return (
    required.every((key) => Object.hasOwn(record, key)) &&
    Object.keys(record).every((key) => required.includes(key) || optional.includes(key))
  );
}

function requestId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function nativeNumber(value: unknown): value is number | bigint {
  return typeof value === "number" || typeof value === "bigint";
}

/** Copy a plain dense array through own data descriptors, without iteration. */
function arrayValues(value: unknown): readonly unknown[] | undefined {
  try {
    if (!Array.isArray(value)) return undefined;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Array.prototype && prototype !== null) return undefined;
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (
      !lengthDescriptor ||
      !("value" in lengthDescriptor) ||
      typeof lengthDescriptor.value !== "number" ||
      !Number.isSafeInteger(lengthDescriptor.value) ||
      lengthDescriptor.value < 0
    )
      return undefined;
    const length = lengthDescriptor.value;
    // Reject extra properties/accessors as well as holes before reading any
    // item. Structured clone could otherwise invoke unrelated array getters.
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length !== length + 1 ||
      ownKeys.some(
        (key) => typeof key !== "string" || (key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key)),
      )
    )
      return undefined;
    const copy: unknown[] = [];
    for (let index = 0; index < length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor)) return undefined;
      copy.push(descriptor.value);
    }
    return copy;
  } catch {
    // Revoked proxies and hostile descriptor/prototype traps are refusals,
    // never exceptions escaping a private decoder or opportunities to coerce.
    return undefined;
  }
}

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")!.get!;
const typedArrayByteOffset = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  "byteOffset",
)!.get!;
const typedArrayByteLength = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  "byteLength",
)!.get!;
const typedArrayTag = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  Symbol.toStringTag,
)!.get!;
const dataViewBuffer = Object.getOwnPropertyDescriptor(DataView.prototype, "buffer")!.get!;
const dataViewByteOffset = Object.getOwnPropertyDescriptor(DataView.prototype, "byteOffset")!.get!;
const dataViewByteLength = Object.getOwnPropertyDescriptor(DataView.prototype, "byteLength")!.get!;

/** Native brand getters cannot invoke a view's overridden public properties. */
function copyNativeBlob(value: unknown): Uint8Array | undefined {
  try {
    if (!ArrayBuffer.isView(value)) return undefined;
    let buffer: ArrayBufferLike;
    let byteOffset: number;
    let byteLength: number;
    try {
      buffer = Reflect.apply(typedArrayBuffer, value, []) as ArrayBufferLike;
      byteOffset = Reflect.apply(typedArrayByteOffset, value, []) as number;
      byteLength = Reflect.apply(typedArrayByteLength, value, []) as number;
    } catch {
      buffer = Reflect.apply(dataViewBuffer, value, []) as ArrayBufferLike;
      byteOffset = Reflect.apply(dataViewByteOffset, value, []) as number;
      byteLength = Reflect.apply(dataViewByteLength, value, []) as number;
    }
    // In particular, SharedArrayBuffer-backed input becomes a fresh ordinary
    // ArrayBuffer. Neither the caller nor a different thread can mutate the
    // admitted binding after this synchronous snapshot and before native bind.
    const copy = new Uint8Array(byteLength);
    copy.set(new Uint8Array(buffer, byteOffset, byteLength));
    return copy;
  } catch {
    return undefined;
  }
}

/**
 * Freeze SQLite's positional input boundary before private worker dispatch.
 * Invalid objects are refused without getters, custom iteration or coercion;
 * all native ArrayBufferViews (including offset DataViews) bind as byte blobs.
 */
export function snapshotSqliteWorkerBindings(
  params: ReadonlyArray<unknown>,
): ReadonlyArray<SqliteWorkerValue> | undefined {
  const values = arrayValues(params);
  if (!values) return undefined;
  const result: SqliteWorkerValue[] = [];
  for (const value of values) {
    if (value === null || typeof value === "string" || nativeNumber(value)) result.push(value);
    else {
      const blob = copyNativeBlob(value);
      if (blob === undefined) return undefined;
      result.push(blob);
    }
  }
  return result;
}

function decodeResultValue(value: unknown): { readonly value: SqliteWorkerValue } | undefined {
  if (value === null || typeof value === "string" || nativeNumber(value)) return { value };
  try {
    // Native SQLite output blobs are Uint8Array, not arbitrary received
    // classes or views. The own copy also removes shared-memory aliases.
    if (
      !ArrayBuffer.isView(value) ||
      Reflect.apply(typedArrayTag, value, []) !== "Uint8Array" ||
      Object.getPrototypeOf(value) !== Uint8Array.prototype
    )
      return undefined;
    const blob = copyNativeBlob(value);
    return blob === undefined ? undefined : { value: blob };
  } catch {
    return undefined;
  }
}

export function decodeSqliteWorkerOptions(value: unknown): SqliteWorkerOptions | undefined {
  const record = dataRecord(value);
  if (
    !record ||
    !keys(record, [
      "filename",
      "readonly",
      "allowExtension",
      "busyTimeoutMs",
      "prepareCacheSize",
      "prepareCacheTTLMillis",
      "statementDiagnostics",
    ])
  )
    return undefined;
  if (
    typeof record.filename !== "string" ||
    typeof record.readonly !== "boolean" ||
    typeof record.allowExtension !== "boolean" ||
    typeof record.statementDiagnostics !== "boolean" ||
    typeof record.busyTimeoutMs !== "number" ||
    !Number.isSafeInteger(record.busyTimeoutMs) ||
    record.busyTimeoutMs < 0 ||
    record.busyTimeoutMs > 60_000 ||
    typeof record.prepareCacheSize !== "number" ||
    !Number.isSafeInteger(record.prepareCacheSize) ||
    record.prepareCacheSize < 0 ||
    typeof record.prepareCacheTTLMillis !== "number" ||
    Number.isNaN(record.prepareCacheTTLMillis) ||
    record.prepareCacheTTLMillis < 0
  )
    return undefined;
  return record as unknown as SqliteWorkerOptions;
}

export function decodeSqliteWorkerRequest(value: unknown): SqliteWorkerRequest | undefined {
  const record = dataRecord(value);
  if (!record || record.version !== SQLITE_WORKER_PROTOCOL_VERSION || !requestId(record.id))
    return undefined;
  if (record.type === "close" && keys(record, ["version", "type", "id"]))
    return record as unknown as SqliteWorkerRequest;
  if (
    record.type !== "execute" ||
    !keys(record, [
      "version",
      "type",
      "id",
      "sql",
      "params",
      "safeIntegers",
      "mode",
      "unprepared",
    ]) ||
    typeof record.sql !== "string" ||
    typeof record.safeIntegers !== "boolean" ||
    typeof record.unprepared !== "boolean" ||
    !["rows", "raw", "values"].includes(record.mode as string)
  )
    return undefined;
  const params = snapshotSqliteWorkerBindings(record.params as ReadonlyArray<unknown>);
  return params === undefined
    ? undefined
    : ({ ...record, params } as unknown as SqliteWorkerRequest);
}

function decodeNativeError(value: unknown): SqliteWorkerNativeError | undefined {
  const record = dataRecord(value);
  if (
    !record ||
    !keys(record, [], ["name", "message", "stack", "code", "errcode", "errno", "errstr"])
  )
    return undefined;
  for (const key of ["name", "message", "stack", "errstr"]) {
    if (
      Object.hasOwn(record, key) &&
      (typeof record[key] !== "string" ||
        record[key].length >
          (key === "name" ? NATIVE_ERROR_LABEL_MAX_CHARS : NATIVE_ERROR_TEXT_MAX_CHARS))
    )
      return undefined;
  }
  if (
    Object.hasOwn(record, "code") &&
    typeof record.code !== "string" &&
    typeof record.code !== "number"
  )
    return undefined;
  if (typeof record.code === "number" && !Number.isFinite(record.code)) return undefined;
  if (typeof record.code === "string" && record.code.length > NATIVE_ERROR_LABEL_MAX_CHARS)
    return undefined;
  for (const key of ["errcode", "errno"]) {
    if (
      Object.hasOwn(record, key) &&
      (typeof record[key] !== "number" || !Number.isSafeInteger(record[key]))
    )
      return undefined;
  }
  return record as SqliteWorkerNativeError;
}

function decodeResult(value: unknown): SqliteWorkerResult | undefined {
  const record = dataRecord(value);
  if (!record) return undefined;
  if (
    record.kind === "write" &&
    keys(record, ["kind", "changes", "lastInsertRowid"]) &&
    nativeNumber(record.changes) &&
    nativeNumber(record.lastInsertRowid)
  )
    return record as unknown as SqliteWorkerResult;
  const rows = arrayValues(record.rows);
  if (record.kind === "values" && keys(record, ["kind", "rows"]) && rows) {
    const decoded: SqliteWorkerValue[][] = [];
    for (const value of rows) {
      const cells = arrayValues(value);
      if (!cells) return undefined;
      const row: SqliteWorkerValue[] = [];
      for (const cell of cells) {
        const item = decodeResultValue(cell);
        if (!item) return undefined;
        row.push(item.value);
      }
      decoded.push(row);
    }
    return { kind: "values", rows: decoded };
  }
  const nullPrototypes = arrayValues(record.nullPrototypes);
  if (
    record.kind !== "rows" ||
    !keys(record, ["kind", "rows", "nullPrototypes"]) ||
    !rows ||
    !nullPrototypes ||
    rows.length !== nullPrototypes.length ||
    !nullPrototypes.every((value) => typeof value === "boolean")
  )
    return undefined;
  const decoded: Record<string, SqliteWorkerValue>[] = [];
  for (const value of rows) {
    const row = dataRecord(value);
    if (!row) return undefined;
    const copy: Record<string, SqliteWorkerValue> = Object.create(null);
    for (const key of Object.keys(row)) {
      const item = decodeResultValue(row[key]);
      if (!item) return undefined;
      Object.defineProperty(copy, key, { value: item.value, enumerable: true });
    }
    decoded.push(copy);
  }
  return { kind: "rows", rows: decoded, nullPrototypes: nullPrototypes as boolean[] };
}

export function decodeSqliteWorkerReply(value: unknown): SqliteWorkerReply | undefined {
  const record = dataRecord(value);
  if (!record || record.version !== SQLITE_WORKER_PROTOCOL_VERSION) return undefined;
  if (record.type === "ready" && keys(record, ["version", "type"]))
    return record as unknown as SqliteWorkerReply;
  if (
    record.type === "diagnostic" &&
    requestId(record.id) &&
    keys(record, ["version", "type", "id", "record"])
  ) {
    const diagnostic = dataRecord(record.record);
    const common = ["phase", "queryId", "fingerprint", "operation", "parameterCount"];
    if (
      !diagnostic ||
      typeof diagnostic.queryId !== "number" ||
      !Number.isSafeInteger(diagnostic.queryId) ||
      diagnostic.queryId <= 0 ||
      typeof diagnostic.fingerprint !== "string" ||
      !/^[a-f0-9]{16}$/.test(diagnostic.fingerprint) ||
      ![
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
        "other",
      ].includes(diagnostic.operation as string) ||
      typeof diagnostic.parameterCount !== "number" ||
      !Number.isSafeInteger(diagnostic.parameterCount) ||
      diagnostic.parameterCount < 0
    )
      return undefined;
    if (diagnostic.phase === "start" && keys(diagnostic, common))
      return {
        version: 1,
        type: "diagnostic",
        id: record.id,
        record: diagnostic as unknown as SqliteStatementDiagnosticRecord,
      };
    if (
      diagnostic.phase === "slow-complete" &&
      keys(diagnostic, [...common, "durationMs", "outcome"]) &&
      typeof diagnostic.durationMs === "number" &&
      Number.isFinite(diagnostic.durationMs) &&
      diagnostic.durationMs >= 0 &&
      ["success", "failure"].includes(diagnostic.outcome as string)
    )
      return {
        version: 1,
        type: "diagnostic",
        id: record.id,
        record: diagnostic as unknown as SqliteStatementDiagnosticRecord,
      };
    return undefined;
  }
  if (record.type === "closed" && requestId(record.id) && keys(record, ["version", "type", "id"]))
    return record as unknown as SqliteWorkerReply;
  if (
    record.type === "result" &&
    requestId(record.id) &&
    keys(record, ["version", "type", "id", "result"])
  ) {
    const result = decodeResult(record.result);
    return result ? { version: 1, type: "result", id: record.id, result } : undefined;
  }
  if (
    record.type === "failure" &&
    typeof record.id === "number" &&
    Number.isSafeInteger(record.id) &&
    record.id >= 0 &&
    keys(record, ["version", "type", "id", "phase", "error"]) &&
    ["open", "prepare", "execute", "close"].includes(record.phase as string)
  ) {
    const error = decodeNativeError(record.error);
    return error
      ? {
          version: 1,
          type: "failure",
          id: record.id,
          phase: record.phase as "open" | "prepare" | "execute" | "close",
          error,
        }
      : undefined;
  }
  return undefined;
}

export function encodeSqliteWorkerNativeError(cause: unknown): SqliteWorkerNativeError {
  const result: Record<string, unknown> = Object.create(null);
  if ((typeof cause !== "object" || cause === null) && typeof cause !== "function") return result;
  for (const key of ["name", "message", "stack", "code", "errcode", "errno", "errstr"]) {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(cause, key);
      if (!descriptor || !("value" in descriptor)) continue;
      const value = descriptor.value;
      if (
        (["errcode", "errno"].includes(key) &&
          typeof value === "number" &&
          Number.isSafeInteger(value)) ||
        (key === "code" &&
          (typeof value === "string" || (typeof value === "number" && Number.isFinite(value)))) ||
        (!["errcode", "errno", "code"].includes(key) && typeof value === "string")
      ) {
        Object.defineProperty(result, key, {
          value:
            typeof value === "string"
              ? value.slice(
                  0,
                  key === "name" || key === "code"
                    ? NATIVE_ERROR_LABEL_MAX_CHARS
                    : NATIVE_ERROR_TEXT_MAX_CHARS,
                )
              : value,
          enumerable: true,
        });
      }
    } catch {
      // A hostile error-like object cannot run accessors or replace the
      // connection's original failure with a transport/coercion exception.
    }
  }
  try {
    // Built-in Errors normally inherit their name. Preserve that native class
    // without traversing an arbitrary prototype chain or invoking `name` (or a
    // constructor) supplied by an error-like object. An own accessor remains
    // absent evidence; it does not authorize an inherited fallback.
    if (Object.getOwnPropertyDescriptor(cause, "name") === undefined) {
      const prototype = Object.getPrototypeOf(cause);
      const builtins: ReadonlyArray<readonly [object, string]> = [
        [Error.prototype, "Error"],
        [EvalError.prototype, "EvalError"],
        [RangeError.prototype, "RangeError"],
        [ReferenceError.prototype, "ReferenceError"],
        [SyntaxError.prototype, "SyntaxError"],
        [TypeError.prototype, "TypeError"],
        [URIError.prototype, "URIError"],
        [AggregateError.prototype, "AggregateError"],
      ];
      const name = builtins.find(([candidate]) => candidate === prototype)?.[1];
      if (name !== undefined)
        Object.defineProperty(result, "name", { value: name, enumerable: true });
    }
  } catch {
    // Hostile prototype/descriptor traps cannot mint a native error class.
  }
  return result as SqliteWorkerNativeError;
}

export function restoreSqliteWorkerNativeError(value: SqliteWorkerNativeError): Error {
  const native = decodeNativeError(value);
  if (native === undefined) return new Error("SQLite operation failed.");
  const message = native.message ?? "SQLite operation failed.";
  // Never select a constructor by dynamic property lookup on globals or on the
  // received record. Only these built-in, inert native error classes survive.
  let error: Error;
  switch (native.name) {
    case "EvalError":
      error = new EvalError(message);
      break;
    case "RangeError":
      error = new RangeError(message);
      break;
    case "ReferenceError":
      error = new ReferenceError(message);
      break;
    case "SyntaxError":
      error = new SyntaxError(message);
      break;
    case "TypeError":
      error = new TypeError(message);
      break;
    case "URIError":
      error = new URIError(message);
      break;
    case "AggregateError":
      error = new AggregateError([], message);
      break;
    default:
      error = new Error(message);
  }
  for (const key of ["name", "message", "stack", "code", "errcode", "errno", "errstr"] as const) {
    if (!Object.hasOwn(native, key)) continue;
    Object.defineProperty(error, key, { value: native[key], configurable: true, writable: true });
  }
  return error;
}
