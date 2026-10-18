import * as Crypto from "node:crypto";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const TOTP_PERIOD_MS = 30_000;

export function createTotpSecret(): string {
  const bytes = Crypto.randomBytes(20);
  let bits = 0;
  let value = 0;
  let result = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += BASE32[(value >>> bits) & 31];
    }
  }
  return result;
}

/** RFC 6238 / RFC 4226: SHA-1, six digits and a 30-second period, as supported
 * by ordinary authenticator apps. The secret never leaves the private store
 * except in the owner-bound enrollment response. */
export function totpAtStep(secret: string, step: number): string {
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of secret) {
    value = (value << 5) | BASE32.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 255);
    }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = Crypto.createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
  const offset = digest[digest.length - 1]! & 15;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 1_000_000).padStart(6, "0");
}

export function equalSecret(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && Crypto.timingSafeEqual(a, b);
}

export function recoveryHash(code: string): string {
  return Crypto.createHash("sha256").update(code.replaceAll("-", "").toLowerCase()).digest("hex");
}
