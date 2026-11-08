import { describe, expect, it } from "vitest";

import {
  decodeSqliteWorkerOptions,
  decodeSqliteWorkerReply,
  decodeSqliteWorkerRequest,
  encodeSqliteWorkerNativeError,
  restoreSqliteWorkerNativeError,
  snapshotSqliteWorkerBindings,
} from "./sqliteWorkerProtocol.ts";

/**
 * These tests own the private transport's descriptor and value contracts.
 * Native contention, transaction ordering and close live in the file-client
 * tests; repeating those scenarios here would not exercise another boundary.
 */
describe("SQLite worker binding snapshots", () => {
  it("rejects unsupported bindings and indexed accessors before evaluating user code", () => {
    let invoked = 0;
    const indexedGetter: unknown[] = [];
    Object.defineProperty(indexedGetter, "0", {
      get: () => {
        invoked++;
        return "must not be observed";
      },
    });
    const objectGetter = Object.defineProperty({}, "private", {
      enumerable: true,
      get: () => {
        invoked++;
        return "must not be cloned";
      },
    });
    const coercible = {
      toString: () => {
        invoked++;
        return "must not be coerced";
      },
    };
    const sparse: unknown[] = [];
    sparse.length = 1;
    for (const bindings of [
      indexedGetter,
      [objectGetter],
      [coercible],
      [undefined],
      [true],
      [Symbol("unsupported")],
      [() => "unsupported"],
      [new ArrayBuffer(4)],
      sparse,
    ]) {
      expect(snapshotSqliteWorkerBindings(bindings)).toBeUndefined();
    }
    expect(invoked).toBe(0);
    expect(snapshotSqliteWorkerBindings([null, "bound", 2.5, 3n])).toEqual([
      null,
      "bound",
      2.5,
      3n,
    ]);
  });

  const views: ReadonlyArray<{
    readonly name: string;
    readonly make: (buffer: ArrayBuffer) => ArrayBufferView;
    readonly expected: readonly number[];
  }> = [
    { name: "Int8Array", make: (buffer) => new Int8Array(buffer, 3, 4), expected: [3, 4, 5, 6] },
    { name: "Uint8Array", make: (buffer) => new Uint8Array(buffer, 3, 4), expected: [3, 4, 5, 6] },
    {
      name: "Uint8ClampedArray",
      make: (buffer) => new Uint8ClampedArray(buffer, 3, 4),
      expected: [3, 4, 5, 6],
    },
    { name: "Int16Array", make: (buffer) => new Int16Array(buffer, 4, 2), expected: [4, 5, 6, 7] },
    {
      name: "Uint16Array",
      make: (buffer) => new Uint16Array(buffer, 4, 2),
      expected: [4, 5, 6, 7],
    },
    {
      name: "Int32Array",
      make: (buffer) => new Int32Array(buffer, 4, 2),
      expected: [4, 5, 6, 7, 8, 9, 10, 11],
    },
    {
      name: "Uint32Array",
      make: (buffer) => new Uint32Array(buffer, 4, 2),
      expected: [4, 5, 6, 7, 8, 9, 10, 11],
    },
    {
      name: "Float32Array",
      make: (buffer) => new Float32Array(buffer, 4, 2),
      expected: [4, 5, 6, 7, 8, 9, 10, 11],
    },
    {
      name: "Float64Array",
      make: (buffer) => new Float64Array(buffer, 8, 1),
      expected: [8, 9, 10, 11, 12, 13, 14, 15],
    },
    {
      name: "BigInt64Array",
      make: (buffer) => new BigInt64Array(buffer, 8, 1),
      expected: [8, 9, 10, 11, 12, 13, 14, 15],
    },
    {
      name: "BigUint64Array",
      make: (buffer) => new BigUint64Array(buffer, 8, 1),
      expected: [8, 9, 10, 11, 12, 13, 14, 15],
    },
    { name: "DataView", make: (buffer) => new DataView(buffer, 3, 5), expected: [3, 4, 5, 6, 7] },
    { name: "Buffer", make: (buffer) => Buffer.from(buffer, 3, 4), expected: [3, 4, 5, 6] },
  ];

  it.each(views)(
    "copies the exact $name byte window without detaching its owner",
    ({ make, expected }) => {
      const buffer = new ArrayBuffer(24);
      new Uint8Array(buffer).set(Array.from({ length: 24 }, (_, index) => index));
      const input = make(buffer);
      const snapshot = snapshotSqliteWorkerBindings([input]);
      expect(snapshot).toHaveLength(1);
      const bytes = snapshot?.[0];
      expect(bytes).toBeInstanceOf(Uint8Array);
      if (!(bytes instanceof Uint8Array)) throw new Error("SQLite byte snapshot was not admitted.");
      expect(Array.from(bytes)).toEqual(expected);
      expect(bytes.buffer).not.toBe(buffer);
      expect(buffer.byteLength).toBe(24);
      new Uint8Array(buffer).fill(255);
      expect(Array.from(bytes)).toEqual(expected);
    },
  );

  it("copies shared backing memory into independently owned non-shared bytes", () => {
    const buffer = new SharedArrayBuffer(12);
    const source = new Uint8Array(buffer);
    source.set([10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]);
    const snapshot = snapshotSqliteWorkerBindings([
      new Uint8Array(buffer, 3, 4),
      new DataView(buffer, 4, 2),
    ]);
    expect(snapshot).toHaveLength(2);
    const first = snapshot?.[0];
    const second = snapshot?.[1];
    if (!(first instanceof Uint8Array) || !(second instanceof Uint8Array))
      throw new Error("SQLite shared byte snapshots were not admitted.");
    expect(first.buffer).toBeInstanceOf(ArrayBuffer);
    expect(second.buffer).toBeInstanceOf(ArrayBuffer);
    expect(Array.from(first)).toEqual([13, 14, 15, 16]);
    expect(Array.from(second)).toEqual([14, 15]);
    source.fill(0);
    expect(Array.from(first)).toEqual([13, 14, 15, 16]);
    expect(Array.from(second)).toEqual([14, 15]);
    expect(buffer.byteLength).toBe(12);
  });

  it("copies native byte windows without evaluating shadowed view metadata", () => {
    let invoked = 0;
    const input = new Uint8Array([2, 4, 6]);
    for (const key of ["buffer", "byteOffset", "byteLength"]) {
      Object.defineProperty(input, key, {
        get: () => {
          invoked++;
          throw new Error("A binding metadata accessor must not run.");
        },
      });
    }
    const snapshot = snapshotSqliteWorkerBindings([input]);
    const bytes = snapshot?.[0];
    if (!(bytes instanceof Uint8Array)) throw new Error("SQLite byte snapshot was not admitted.");
    expect(Array.from(bytes)).toEqual([2, 4, 6]);
    expect(invoked).toBe(0);
  });
});

describe("SQLite worker envelope admission", () => {
  it.each([
    null,
    [],
    { version: 2, type: "ready" },
    { version: 1, type: "ready", extra: "unknown" },
    { version: 1, type: "closed", id: 0 },
    { version: 1, type: "closed", id: Number.MAX_SAFE_INTEGER + 1 },
    {
      version: 1,
      type: "result",
      id: 1,
      result: { kind: "write", changes: "1", lastInsertRowid: 1 },
    },
    {
      version: 1,
      type: "result",
      id: 1,
      result: { kind: "rows", rows: [{ value: 1 }], nullPrototypes: [] },
    },
    {
      version: 1,
      type: "result",
      id: 1,
      result: { kind: "values", rows: [[{ unsupported: true }]] },
    },
    { version: 1, type: "failure", id: 1, phase: "execute", error: { errcode: Number.NaN } },
    {
      version: 1,
      type: "failure",
      id: 1,
      phase: "execute",
      error: { message: "x".repeat(65_537) },
    },
    {
      version: 1,
      type: "diagnostic",
      id: 1,
      record: {
        phase: "start",
        queryId: 1,
        fingerprint: "0".repeat(16),
        operation: "unexpected",
        parameterCount: 0,
      },
    },
  ])("refuses malformed reply %# without interpreting its payload", (value) => {
    expect(decodeSqliteWorkerReply(value)).toBeUndefined();
  });

  it("rejects accessors and remains total for revoked or trapping array proxies", () => {
    let invoked = 0;
    const accessor = Object.defineProperty({}, "version", {
      enumerable: true,
      get: () => {
        invoked++;
        throw new Error("A received accessor must not run.");
      },
    });
    const indexedGetter = Object.defineProperty([], "0", {
      enumerable: true,
      get: () => {
        invoked++;
        throw new Error("A received array accessor must not run.");
      },
    });
    const revoked = Proxy.revocable([], {});
    revoked.revoke();
    const trapping = new Proxy([], {
      getOwnPropertyDescriptor: () => {
        throw new Error("An array proxy cannot supply descriptors.");
      },
    });
    for (const value of [accessor, revoked.proxy, trapping]) {
      expect(decodeSqliteWorkerOptions(value)).toBeUndefined();
      expect(decodeSqliteWorkerRequest(value)).toBeUndefined();
      expect(decodeSqliteWorkerReply(value)).toBeUndefined();
    }
    for (const params of [indexedGetter, revoked.proxy, trapping]) {
      expect(
        decodeSqliteWorkerRequest({
          version: 1,
          type: "execute",
          id: 1,
          sql: "SELECT ?",
          params,
          safeIntegers: false,
          mode: "rows",
          unprepared: false,
        }),
      ).toBeUndefined();
      expect(
        decodeSqliteWorkerReply({
          version: 1,
          type: "result",
          id: 1,
          result: { kind: "values", rows: [params] },
        }),
      ).toBeUndefined();
    }
    expect(invoked).toBe(0);
  });

  it("retains binary, bigint, null and prototype-named column data in admitted replies", () => {
    const row = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(row, "__proto__", { value: "column data", enumerable: true });
    Object.defineProperty(row, "large", { value: 9_223_372_036_854_775_807n, enumerable: true });
    Object.defineProperty(row, "bytes", { value: new Uint8Array([0, 255]), enumerable: true });
    Object.defineProperty(row, "missing", { value: null, enumerable: true });
    const reply = decodeSqliteWorkerReply({
      version: 1,
      type: "result",
      id: 7,
      result: { kind: "rows", rows: [row], nullPrototypes: [true] },
    });
    expect(reply?.type).toBe("result");
    if (reply?.type !== "result" || reply.result.kind !== "rows")
      throw new Error("SQLite row reply was not admitted.");
    const received = reply.result.rows[0];
    expect(Object.hasOwn(received!, "__proto__")).toBe(true);
    expect(received?.["__proto__"]).toBe("column data");
    expect(received?.large).toBe(9_223_372_036_854_775_807n);
    expect(received?.bytes).toEqual(new Uint8Array([0, 255]));
    expect(received?.missing).toBeNull();
    expect(reply.result.nullPrototypes).toEqual([true]);
  });
});

describe("SQLite worker native errors", () => {
  it.each([
    { create: () => new Error("private native failure"), constructor: Error, name: "Error" },
    {
      create: () => new EvalError("private native failure"),
      constructor: EvalError,
      name: "EvalError",
    },
    {
      create: () => new RangeError("private native failure"),
      constructor: RangeError,
      name: "RangeError",
    },
    {
      create: () => new ReferenceError("private native failure"),
      constructor: ReferenceError,
      name: "ReferenceError",
    },
    {
      create: () => new SyntaxError("private native failure"),
      constructor: SyntaxError,
      name: "SyntaxError",
    },
    {
      create: () => new TypeError("private native failure"),
      constructor: TypeError,
      name: "TypeError",
    },
    {
      create: () => new URIError("private native failure"),
      constructor: URIError,
      name: "URIError",
    },
    {
      create: () => new AggregateError([], "private native failure"),
      constructor: AggregateError,
      name: "AggregateError",
    },
  ])(
    "retains native $name class and SQLite codes without inventing errno",
    ({ create, constructor, name }) => {
      const original = create();
      Object.defineProperties(original, {
        code: { value: "ERR_SQLITE_ERROR", configurable: true },
        errcode: { value: 5, configurable: true },
        errstr: { value: "database is locked", configurable: true },
      });
      const encoded = encodeSqliteWorkerNativeError(original);
      const reply = decodeSqliteWorkerReply({
        version: 1,
        type: "failure",
        id: 3,
        phase: "execute",
        error: encoded,
      });
      if (reply?.type !== "failure") throw new Error("SQLite native error was not admitted.");
      const restored = restoreSqliteWorkerNativeError(reply.error);
      expect(restored).toBeInstanceOf(constructor);
      expect(restored.name).toBe(name);
      expect(restored.message).toBe("private native failure");
      expect(Reflect.get(restored, "code")).toBe("ERR_SQLITE_ERROR");
      expect(Reflect.get(restored, "errcode")).toBe(5);
      expect(Reflect.get(restored, "errstr")).toBe("database is locked");
      expect(Object.hasOwn(restored, "errno")).toBe(false);
      expect(Object.hasOwn(original, "errno")).toBe(false);
    },
  );

  it("never evaluates error metadata getters or received constructor names", () => {
    let invoked = 0;
    const errorLike = Object.create({
      get name() {
        invoked++;
        return "RangeError";
      },
    });
    Object.defineProperty(errorLike, "message", {
      get: () => {
        invoked++;
        throw new Error("A native error accessor must not run.");
      },
    });
    const encoded = encodeSqliteWorkerNativeError(errorLike);
    expect(Object.hasOwn(encoded, "name")).toBe(false);
    expect(Object.hasOwn(encoded, "message")).toBe(false);
    const receivedAccessor = Object.defineProperty({}, "message", {
      get: () => {
        invoked++;
        throw new Error("Received native error metadata must not execute.");
      },
    });
    expect(restoreSqliteWorkerNativeError(receivedAccessor)).toBeInstanceOf(Error);
    const restored = restoreSqliteWorkerNativeError({ name: "constructor", message: "private" });
    expect(restored).toBeInstanceOf(Error);
    expect(Object.getPrototypeOf(restored)).toBe(Error.prototype);
    expect(restored.name).toBe("constructor");
    expect(invoked).toBe(0);
  });
});
