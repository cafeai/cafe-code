import { fromString } from "uint8arrays/from-string";
import { toString } from "uint8arrays/to-string";
import { RelayError, requireRelay } from "./errors.ts";

export const utf8 = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function decodeUtf8(bytes: Uint8Array): string {
  try {
    return decoder.decode(bytes);
  } catch {
    throw new RelayError("PROTOCOL_ERROR");
  }
}

export function opaque(bytes: Uint8Array): string {
  return toString(bytes, "base64url");
}

export function unopaque(value: string, length: number): Uint8Array {
  requireRelay(value.length === Math.ceil((length * 4) / 3) && /^[A-Za-z0-9_-]+$/.test(value));
  try {
    const bytes = fromString(value, "base64url");
    requireRelay(bytes.length === length && opaque(bytes) === value);
    return bytes;
  } catch {
    throw new RelayError("PROTOCOL_ERROR");
  }
}

export function randomOpaque(length: 16 | 32 = 32): string {
  return opaque(globalThis.crypto.getRandomValues(new Uint8Array(length)));
}

export function unopaqueBounded(value: string, maximum: number): Uint8Array {
  requireRelay(
    value.length > 0 &&
      value.length <= Math.ceil((maximum * 4) / 3) &&
      /^[A-Za-z0-9_-]+$/.test(value),
  );
  try {
    const bytes = fromString(value, "base64url");
    requireRelay(bytes.length <= maximum && opaque(bytes) === value);
    return bytes;
  } catch {
    throw new RelayError("PROTOCOL_ERROR");
  }
}

export function concatenate(...arrays: readonly Uint8Array[]): Uint8Array {
  const length = arrays.reduce((sum, part) => sum + part.byteLength, 0);
  requireRelay(Number.isSafeInteger(length) && length <= 1_048_576);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const array of arrays) {
    output.set(array, offset);
    offset += array.byteLength;
  }
  return output;
}

/** Constant work for equally sized secret values; mismatched public lengths fail early. */
export function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let i = 0; i < left.byteLength; i++) difference |= left[i]! ^ right[i]!;
  return difference === 0;
}
