import * as Canonicalize from "canonicalize";
import * as Schema from "effect/Schema";
import { decodeUtf8, opaque, unopaque, utf8 } from "./bytes.ts";
import { RelayError, requireRelay } from "./errors.ts";
import { PADDING_BUCKETS, RELAY_LIMITS } from "./limits.ts";

export const OUTER = Object.freeze({
  HELLO: 1,
  REGISTER: 2,
  REGISTERED: 3,
  LEASE: 4,
  ATTACH: 5,
  OFFER: 6,
  ACCEPT: 7,
  DATA: 8,
  WINDOW: 9,
  AUTHORIZE: 10,
  MINT_TICKETS: 11,
  TICKETS: 12,
  CLOSE: 13,
  ERROR: 14,
} as const);
export type OuterOpcode = (typeof OUTER)[keyof typeof OUTER];
export const INNER = Object.freeze({
  BIND: 1,
  BIND_ACK: 2,
  AUTH: 3,
  AUTH_OK: 4,
  AUTH_DENIED: 5,
  OPEN: 6,
  OPEN_OK: 7,
  DATA: 8,
  CREDIT: 9,
  FIN: 10,
  RESET: 11,
  PING: 12,
  PONG: 13,
  GOAWAY: 14,
} as const);
export type InnerKind = (typeof INNER)[keyof typeof INNER];
export const ZERO_CIRCUIT = opaque(new Uint8Array(16));
const outerCodes = new Set<number>(Object.values(OUTER));
const innerCodes = new Set<number>(Object.values(INNER));
const circuitCodes = new Set<number>([
  OUTER.OFFER,
  OUTER.ACCEPT,
  OUTER.DATA,
  OUTER.WINDOW,
  OUTER.AUTHORIZE,
]);
const decodeJson = Schema.decodeUnknownSync(Schema.UnknownFromJsonString);
// canonicalize 2.1.0 publishes CommonJS with an ESM-shaped declaration. Validate
// its actual callable export/result at this boundary instead of a type assertion
// that would conceal a broken NodeNext/browser interop mapping.
const canonicalExport: unknown = Canonicalize.default;
function canonicalString(value: unknown): string {
  requireRelay(typeof canonicalExport === "function");
  const text: unknown = canonicalExport(value);
  requireRelay(typeof text === "string");
  return text;
}

export const Id16 = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{22}$/));
export const Id32 = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/));
export const SafeCounter = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
export const HttpMethod = Schema.Literals(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);

/**
 * Canonical bytes plus exact Schema decoding reject duplicate properties and
 * unknown fields. Body-size admission precedes UTF-8/JSON allocation.
 */
export function canonicalBytes(
  value: unknown,
  maximum: number = RELAY_LIMITS.metadataBytes,
): Uint8Array {
  try {
    const text = canonicalString(value);
    requireRelay(typeof text === "string");
    const bytes = utf8.encode(text);
    requireRelay(bytes.byteLength <= maximum);
    return bytes;
  } catch {
    throw new RelayError("PROTOCOL_ERROR");
  }
}

export function readCanonical<A>(
  schema: Schema.Decoder<A>,
  bytes: Uint8Array,
  maximum: number = RELAY_LIMITS.metadataBytes,
): A {
  requireRelay(bytes.byteLength <= maximum);
  try {
    const text = decodeUtf8(bytes);
    const value = decodeJson(text);
    requireRelay(canonicalString(value) === text);
    return Schema.decodeUnknownSync(schema)(value, { onExcessProperty: "error" });
  } catch {
    throw new RelayError("PROTOCOL_ERROR");
  }
}

export interface OuterFrame {
  readonly opcode: OuterOpcode;
  readonly circuitId: string;
  readonly payload: Uint8Array;
}

export function encodeOuter(
  opcode: OuterOpcode,
  circuitId: string,
  payload: Uint8Array,
): Uint8Array {
  const id = unopaque(circuitId, 16);
  requireRelay(outerCodes.has(opcode));
  requireRelay(payload.byteLength <= RELAY_LIMITS.outerBytes - RELAY_LIMITS.outerHeaderBytes);
  requireRelay(opcode === OUTER.DATA || payload.byteLength <= RELAY_LIMITS.controlBytes);
  requireRelay(!circuitCodes.has(opcode) || circuitId !== ZERO_CIRCUIT);
  const output = new Uint8Array(RELAY_LIMITS.outerHeaderBytes + payload.byteLength);
  const view = new DataView(output.buffer);
  output[0] = 1;
  output[1] = opcode;
  view.setUint32(4, payload.byteLength);
  output.set(id, 8);
  output.set(payload, RELAY_LIMITS.outerHeaderBytes);
  return output;
}

export function decodeOuter(bytes: Uint8Array): OuterFrame {
  requireRelay(
    bytes.byteLength >= RELAY_LIMITS.outerHeaderBytes &&
      bytes.byteLength <= RELAY_LIMITS.outerBytes,
  );
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const opcode = bytes[1]!;
  requireRelay(bytes[0] === 1 && view.getUint16(2) === 0 && outerCodes.has(opcode));
  const length = view.getUint32(4);
  requireRelay(length === bytes.byteLength - RELAY_LIMITS.outerHeaderBytes);
  requireRelay(opcode === OUTER.DATA || length <= RELAY_LIMITS.controlBytes);
  const circuitId = opaque(bytes.subarray(8, 24));
  requireRelay(!circuitCodes.has(opcode) || circuitId !== ZERO_CIRCUIT);
  // This assertion narrows a value checked against the finite opcode set above.
  return { opcode: opcode as OuterOpcode, circuitId, payload: bytes.subarray(24) };
}

export interface InnerFrame {
  readonly kind: InnerKind;
  readonly streamId: number;
  readonly payload: Uint8Array;
  readonly encodedBytes: number;
}

export function encodeInner(kind: InnerKind, streamId: number, payload: Uint8Array): Uint8Array {
  requireRelay(
    innerCodes.has(kind) &&
      Number.isSafeInteger(streamId) &&
      streamId >= 0 &&
      streamId <= 0xffff_ffff,
  );
  requireRelay(
    payload.byteLength <=
      (kind === INNER.DATA ? RELAY_LIMITS.dataBytes : RELAY_LIMITS.metadataBytes),
  );
  const padded = PADDING_BUCKETS.find(
    (size) => size >= RELAY_LIMITS.innerHeaderBytes + payload.byteLength,
  );
  requireRelay(padded !== undefined);
  const output = new Uint8Array(padded);
  const view = new DataView(output.buffer);
  view.setUint32(0, padded);
  output[4] = 1;
  output[5] = kind;
  view.setUint32(8, streamId);
  view.setUint32(12, payload.byteLength);
  output.set(payload, RELAY_LIMITS.innerHeaderBytes);
  return output;
}

/** Incremental parser: no declared allocation before a finite bucket is admitted. */
export class InnerDecoder {
  private pending = new Uint8Array(0);
  private retired = false;

  push(chunk: Uint8Array): readonly InnerFrame[] {
    requireRelay(!this.retired);
    requireRelay(
      chunk.byteLength + this.pending.byteLength <= RELAY_LIMITS.ownerPendingBytes,
      "BUSY",
    );
    const bytes = new Uint8Array(this.pending.byteLength + chunk.byteLength);
    bytes.set(this.pending);
    bytes.set(chunk, this.pending.byteLength);
    const frames: InnerFrame[] = [];
    let offset = 0;
    while (bytes.byteLength - offset >= 4) {
      const view = new DataView(bytes.buffer, bytes.byteOffset + offset, bytes.byteLength - offset);
      const padded = view.getUint32(0);
      requireRelay(PADDING_BUCKETS.includes(padded));
      if (bytes.byteLength - offset < padded) break;
      const kind = view.getUint8(5);
      const length = view.getUint32(12);
      requireRelay(view.getUint8(4) === 1 && view.getUint16(6) === 0 && innerCodes.has(kind));
      requireRelay(length <= padded - RELAY_LIMITS.innerHeaderBytes);
      requireRelay(
        length <= (kind === INNER.DATA ? RELAY_LIMITS.dataBytes : RELAY_LIMITS.metadataBytes),
      );
      requireRelay(
        PADDING_BUCKETS.find((size) => size >= RELAY_LIMITS.innerHeaderBytes + length) === padded,
      );
      const payloadEnd = offset + RELAY_LIMITS.innerHeaderBytes + length;
      for (let index = payloadEnd; index < offset + padded; index++)
        requireRelay(bytes[index] === 0);
      frames.push({
        kind: kind as InnerKind,
        streamId: view.getUint32(8),
        payload: bytes.slice(offset + RELAY_LIMITS.innerHeaderBytes, payloadEnd),
        encodedBytes: padded,
      });
      offset += padded;
    }
    this.pending = bytes.slice(offset);
    return frames;
  }

  finish(): void {
    requireRelay(this.pending.byteLength === 0, "INCOMPLETE");
    this.retire();
  }

  retire(): void {
    this.retired = true;
    this.pending.fill(0);
    this.pending = new Uint8Array(0);
  }

  get pendingBytes(): number {
    return this.pending.byteLength;
  }
}
