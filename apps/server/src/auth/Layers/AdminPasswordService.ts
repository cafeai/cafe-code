import * as Crypto from "node:crypto";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  AdminPasswordError,
  AdminPasswordService,
  type AdminPasswordServiceShape,
} from "../Services/AdminPasswordService.ts";
import { ServerSecretStore } from "../Services/ServerSecretStore.ts";

const ADMIN_PASSWORD_SECRET_NAME = "admin-password-verifier";
const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const MIN_ADMIN_PASSWORD_LENGTH = 8;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function encodeBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function decodeBase64Url(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

function validatePassword(password: string): AdminPasswordError | null {
  if (password.trim().length === 0) {
    return new AdminPasswordError({
      message: "Admin password is required.",
      status: 400,
    });
  }

  if (password.length < MIN_ADMIN_PASSWORD_LENGTH) {
    return new AdminPasswordError({
      message: `Admin password must be at least ${MIN_ADMIN_PASSWORD_LENGTH} characters.`,
      status: 400,
    });
  }

  return null;
}

function parseVerifier(raw: string): {
  readonly algorithm: "scrypt";
  readonly n: number;
  readonly r: number;
  readonly p: number;
  readonly keyLength: number;
  readonly salt: Buffer;
  readonly hash: Buffer;
} | null {
  const parts = raw.split("$");
  if (parts.length !== 7 || parts[0] !== "scrypt") {
    return null;
  }

  const n = Number.parseInt(parts[1] ?? "", 10);
  const r = Number.parseInt(parts[2] ?? "", 10);
  const p = Number.parseInt(parts[3] ?? "", 10);
  const keyLength = Number.parseInt(parts[4] ?? "", 10);
  if (
    !Number.isSafeInteger(n) ||
    !Number.isSafeInteger(r) ||
    !Number.isSafeInteger(p) ||
    !Number.isSafeInteger(keyLength) ||
    n <= 0 ||
    r <= 0 ||
    p <= 0 ||
    keyLength <= 0
  ) {
    return null;
  }

  try {
    const salt = decodeBase64Url(parts[5] ?? "");
    const hash = decodeBase64Url(parts[6] ?? "");
    if (salt.length < 16 || hash.length !== keyLength) {
      return null;
    }
    return {
      algorithm: "scrypt",
      n,
      r,
      p,
      keyLength,
      salt,
      hash,
    };
  } catch {
    return null;
  }
}

function scryptBuffer(
  password: string,
  salt: Uint8Array,
  keyLength: number,
  options: Crypto.ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    Crypto.scrypt(password, salt, keyLength, options, (error, derivedKey) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(Buffer.from(derivedKey));
    });
  });
}

function hashPassword(password: string, salt: Uint8Array) {
  return Effect.promise(() =>
    scryptBuffer(password, salt, SCRYPT_KEY_LENGTH, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      maxmem: SCRYPT_MAXMEM,
    }),
  );
}

function verifyHash(password: string, verifier: NonNullable<ReturnType<typeof parseVerifier>>) {
  return Effect.promise(async () => {
    const candidate = await scryptBuffer(password, verifier.salt, verifier.keyLength, {
      N: verifier.n,
      r: verifier.r,
      p: verifier.p,
      maxmem: SCRYPT_MAXMEM,
    });
    return (
      candidate.length === verifier.hash.length && Crypto.timingSafeEqual(candidate, verifier.hash)
    );
  });
}

export const makeAdminPasswordService = Effect.gen(function* () {
  const secretStore = yield* ServerSecretStore;

  const readVerifier = secretStore.get(ADMIN_PASSWORD_SECRET_NAME).pipe(
    Effect.map((stored) => (stored === null ? null : textDecoder.decode(stored))),
    Effect.mapError(
      (cause) =>
        new AdminPasswordError({
          message: "Failed to read admin password verifier.",
          status: 500,
          cause,
        }),
    ),
  );

  const isConfigured = readVerifier.pipe(Effect.map((stored) => stored !== null));

  const setPassword: AdminPasswordServiceShape["setPassword"] = (password) =>
    Effect.gen(function* () {
      const validationError = validatePassword(password);
      if (validationError) {
        return yield* validationError;
      }

      const salt = Crypto.randomBytes(32);
      const hash = yield* hashPassword(password, salt).pipe(
        Effect.mapError(
          (cause) =>
            new AdminPasswordError({
              message: "Failed to hash admin password.",
              status: 500,
              cause,
            }),
        ),
      );
      const verifier = [
        "scrypt",
        String(SCRYPT_N),
        String(SCRYPT_R),
        String(SCRYPT_P),
        String(SCRYPT_KEY_LENGTH),
        encodeBase64Url(salt),
        encodeBase64Url(hash),
      ].join("$");
      yield* secretStore.set(ADMIN_PASSWORD_SECRET_NAME, textEncoder.encode(verifier)).pipe(
        Effect.mapError(
          (cause) =>
            new AdminPasswordError({
              message: "Failed to persist admin password verifier.",
              status: 500,
              cause,
            }),
        ),
      );
    });

  const clearPassword = secretStore.remove(ADMIN_PASSWORD_SECRET_NAME).pipe(
    Effect.mapError(
      (cause) =>
        new AdminPasswordError({
          message: "Failed to clear admin password verifier.",
          status: 500,
          cause,
        }),
    ),
  );

  const verifyPassword: AdminPasswordServiceShape["verifyPassword"] = (password) =>
    Effect.gen(function* () {
      if (password.trim().length === 0) {
        return false;
      }

      const stored = yield* readVerifier;
      if (stored === null) {
        return false;
      }

      const verifier = parseVerifier(stored);
      if (verifier === null) {
        return yield* new AdminPasswordError({
          message: "Stored admin password verifier is malformed.",
          status: 500,
        });
      }

      return yield* verifyHash(password, verifier).pipe(
        Effect.mapError(
          (cause) =>
            new AdminPasswordError({
              message: "Failed to verify admin password.",
              status: 500,
              cause,
            }),
        ),
      );
    });

  return {
    isConfigured,
    setPassword,
    clearPassword,
    verifyPassword,
  } satisfies AdminPasswordServiceShape;
});

export const AdminPasswordServiceLive = Layer.effect(
  AdminPasswordService,
  makeAdminPasswordService,
);
