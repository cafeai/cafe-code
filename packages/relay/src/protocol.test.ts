import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";
import { opaque, randomOpaque, unopaque, utf8 } from "./bytes.ts";
import { Budget, CreditWindow, AdmissionLimiter, TokenBucket } from "./budget.ts";
import { RELAY_LIMITS } from "./limits.ts";
import {
  INNER,
  OUTER,
  ZERO_CIRCUIT,
  InnerDecoder,
  canonicalBytes,
  decodeOuter,
  encodeInner,
  encodeOuter,
  readCanonical,
} from "./protocol.ts";

describe("canonical control boundary", () => {
  const schema = Schema.Struct({ answer: Schema.Number, name: Schema.String });
  it("accepts exact canonical input and rejects duplicate, excess and malformed properties", () => {
    expect(readCanonical(schema, canonicalBytes({ name: "fixture", answer: 42 }))).toEqual({
      answer: 42,
      name: "fixture",
    });
    for (const text of [
      '{"answer":1,"answer":42,"name":"fixture"}',
      '{"name":"fixture","answer":42}',
      '{"answer":42,"extra":true,"name":"fixture"}',
      '{"answer":1e999,"name":"fixture"}',
    ])
      expect(() => readCanonical(schema, utf8.encode(text))).toThrow();
    expect(() => readCanonical(schema, new Uint8Array([0xff]))).toThrow();
    expect(() => canonicalBytes({ value: Number.NaN })).toThrow();
  });

  it("refuses body overflow before parsing", () => {
    expect(() => readCanonical(schema, new Uint8Array(RELAY_LIMITS.metadataBytes + 1))).toThrow();
  });
});

describe("outer framing", () => {
  it("round trips a circuit payload without leaking interpretation into the relay", () => {
    const id = randomOpaque(16),
      payload = new Uint8Array([9, 8, 7]);
    const frame = decodeOuter(encodeOuter(OUTER.DATA, id, payload));
    expect(frame.opcode).toBe(OUTER.DATA);
    expect(frame.circuitId).toBe(id);
    expect(frame.payload).toEqual(payload);
  });

  it("refuses invalid lengths, flags, versions, opcodes and zero data circuit IDs", () => {
    const valid = encodeOuter(OUTER.DATA, randomOpaque(16), new Uint8Array([1]));
    for (const [offset, value] of [
      [0, 2],
      [1, 255],
      [2, 1],
      [7, 0],
    ] as const) {
      const malformed = valid.slice();
      malformed[offset] = value;
      expect(() => decodeOuter(malformed)).toThrow();
    }
    expect(() => decodeOuter(valid.subarray(1))).toThrow();
    expect(() => encodeOuter(OUTER.DATA, ZERO_CIRCUIT, new Uint8Array())).toThrow();
    expect(() => encodeOuter(OUTER.HELLO, ZERO_CIRCUIT, new Uint8Array(4_097))).toThrow();
    expect(() => encodeOuter(OUTER.DATA, randomOpaque(16), new Uint8Array(65_513))).toThrow();
  });

  it("requires canonical fixed-width opaque IDs", () => {
    const id = randomOpaque(16);
    expect(opaque(unopaque(id, 16))).toBe(id);
    expect(() => unopaque(id + "=", 16)).toThrow();
    expect(() => unopaque(randomOpaque(), 16)).toThrow();
    // The final character's unused base64 bits cannot create aliases.
    const zero = opaque(new Uint8Array(16));
    expect(() => unopaque(zero.slice(0, -1) + "B", 16)).toThrow();
  });
});

describe("encrypted inner framing", () => {
  it("handles bytewise fragmentation and coalesced frames", () => {
    const first = encodeInner(INNER.DATA, 1, utf8.encode("private fixture"));
    const second = encodeInner(INNER.FIN, 1, canonicalBytes({ bytes: 15 }));
    const joined = new Uint8Array(first.length + second.length);
    joined.set(first);
    joined.set(second, first.length);
    const decoder = new InnerDecoder(),
      output = [];
    for (const byte of joined) output.push(...decoder.push(new Uint8Array([byte])));
    expect(output.map((f) => f.kind)).toEqual([INNER.DATA, INNER.FIN]);
    expect(output[0]?.payload).toEqual(utf8.encode("private fixture"));
    expect(decoder.pendingBytes).toBe(0);
    decoder.finish();
    expect(() => decoder.push(first)).toThrow();
  });

  it("rejects nonminimal padding, nonzero padding, oversized declarations and incomplete EOF", () => {
    const frame = encodeInner(INNER.DATA, 1, new Uint8Array([1]));
    const padding = frame.slice();
    padding[padding.length - 1] = 1;
    expect(() => new InnerDecoder().push(padding)).toThrow();
    const length = frame.slice();
    new DataView(length.buffer).setUint32(12, 9_999);
    expect(() => new InnerDecoder().push(length)).toThrow();
    expect(() => new InnerDecoder().push(new Uint8Array([0xff, 0xff, 0xff, 0xff]))).toThrow();
    const pending = new InnerDecoder();
    pending.push(frame.subarray(0, 12));
    expect(() => pending.finish()).toThrow();
    pending.retire();
    expect(pending.pendingBytes).toBe(0);
  });
});

describe("resource ownership", () => {
  it("admits before work and releases only the exact reservation once", () => {
    const budget = new Budget(4),
      first = budget.reserve(3)!;
    expect(budget.reserve(2)).toBeUndefined();
    const second = budget.reserve(1)!;
    first();
    first();
    expect(budget.current).toBe(1);
    const replacement = budget.reserve(3)!;
    first();
    expect(budget.current).toBe(4);
    second();
    replacement();
    expect(budget.current).toBe(0);
  });

  it("rejects credit inflation, backward values and overflow", () => {
    const credit = new CreditWindow(100);
    credit.update(100);
    expect(credit.take(60)).toBe(true);
    credit.update(100);
    expect(credit.available).toBe(40);
    expect(() => credit.update(99)).toThrow();
    expect(() => credit.update(161)).toThrow();
    expect(credit.take(41)).toBe(false);
    credit.update(160);
    expect(credit.available).toBe(100);
    expect(() => credit.update(Number.MAX_SAFE_INTEGER + 1)).toThrow();
  });

  it("bounds churn before admitting IP tracking and does not refill on a backward clock", () => {
    const bucket = new TokenBucket(1, 1, 1_000);
    expect(bucket.take(1_000)).toBe(true);
    expect(bucket.take(0)).toBe(false);
    expect(bucket.take(1_999)).toBe(false);
    expect(bucket.take(2_000)).toBe(true);
    const limiter = new AdmissionLimiter(0);
    for (let i = 0; i < 4; i++) expect(limiter.admit("one-nat", 0)).toBe(true);
    expect(limiter.admit("one-nat", 0)).toBe(false);
    for (let i = 0; i < 100_000; i++) limiter.admit("new-prefix-" + i, 0);
    expect(limiter.trackedPrefixes).toBeLessThanOrEqual(32);
  });
});
