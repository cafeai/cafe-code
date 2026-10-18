import * as Crypto from "node:crypto";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { AuthError } from "../Services/ServerAuth.ts";
import { ServerSecretStore } from "../Services/ServerSecretStore.ts";
import { TwoFactorService, type TwoFactorServiceShape } from "../Services/TwoFactorService.ts";
import {
  createTotpSecret,
  equalSecret,
  recoveryHash,
  totpAtStep,
  TOTP_PERIOD_MS,
} from "../totp.ts";

const SECRET_NAME = "remote-two-factor";
const integer = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));
const seed = Schema.String.check(Schema.isPattern(/^[A-Z2-7]{32}$/));
const State = Schema.Struct({
  version: Schema.Literal(1),
  secret: Schema.NullOr(seed),
  pending: Schema.NullOr(Schema.Struct({ secret: seed, owner: Schema.String, expiresAt: integer })),
  recoveryHashes: Schema.Array(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))).check(
    Schema.isMaxLength(10),
  ),
  failures: integer.check(Schema.isLessThanOrEqualTo(100)),
  blockedUntil: integer,
  lastStep: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(-1)),
});
type State = typeof State.Type;
const decodeState = Schema.decodeUnknownSync(State);
const emptyState = (): State => ({
  version: 1,
  secret: null,
  pending: null,
  recoveryHashes: [],
  failures: 0,
  blockedUntil: 0,
  lastStep: -1,
});

// The backend is the sole auth-file owner. Share this lane even across layer
// reconstructions in that process; read fresh under it and commit before every
// result. No per-IP map, client-supplied key, or queued sleeper can grow memory.
const admission = Semaphore.makeUnsafe(1);
let admittedOperations = 0;

const invalid = () =>
  new AuthError({ message: "Invalid or already used authentication code.", status: 401 });
const withAdmission = <A>(effect: Effect.Effect<A, AuthError>) =>
  Effect.suspend(() => {
    // Bound the lane as well as the attempt rate. Overload refuses immediately
    // rather than retaining arbitrary numbers of waiting HTTP fibers.
    if (admittedOperations >= 16)
      return Effect.fail(
        new AuthError({
          message: "Authentication is busy. Try again shortly.",
          status: 429,
          retryAfterSeconds: 1,
        }),
      );
    admittedOperations++;
    return effect.pipe(
      Effect.uninterruptible,
      admission.withPermits(1),
      Effect.ensuring(
        Effect.sync(() => {
          admittedOperations--;
        }),
      ),
    );
  });

export const makeTwoFactorService = Effect.gen(function* () {
  const store = yield* ServerSecretStore;
  const read = Effect.gen(function* () {
    const bytes = yield* store.get(SECRET_NAME);
    if (bytes === null) return emptyState();
    // Malformed/unreadable state fails closed, never silently disables 2FA.
    return yield* Effect.try({
      try: () => {
        if (bytes.byteLength > 8192) throw new Error("oversized");
        return decodeState(JSON.parse(new TextDecoder().decode(bytes)));
      },
      catch: () =>
        new AuthError({
          message: "Two-factor authentication storage is unavailable.",
          status: 500,
        }),
    });
  }).pipe(
    Effect.mapError(
      () =>
        new AuthError({
          message: "Two-factor authentication storage is unavailable.",
          status: 500,
        }),
    ),
  );
  const write = (state: State) =>
    store.set(SECRET_NAME, new TextEncoder().encode(JSON.stringify(state))).pipe(
      Effect.mapError(
        () =>
          new AuthError({
            message: "Two-factor authentication storage is unavailable.",
            status: 500,
          }),
      ),
    );
  const status = withAdmission(
    read.pipe(
      Effect.map((state) => ({
        enabled: state.secret !== null,
        recoveryCodesRemaining: state.recoveryHashes.length,
      })),
    ),
  );
  const begin: TwoFactorServiceShape["begin"] = (owner) =>
    withAdmission(
      Effect.gen(function* () {
        const state = yield* read;
        if (state.secret !== null)
          return yield* new AuthError({
            message: "Two-factor authentication is already enabled.",
            status: 400,
          });
        const now = yield* Clock.currentTimeMillis;
        const secret = createTotpSecret();
        // Replacing enrollment cannot refund failures or the cooldown.
        yield* write({ ...state, pending: { secret, owner, expiresAt: now + 10 * 60_000 } });
        return {
          secret,
          uri: `otpauth://totp/Cafe%20Code:Remote%20access?secret=${secret}&issuer=Cafe%20Code&algorithm=SHA1&digits=6&period=30`,
        };
      }),
    );

  const check = (
    state: State,
    secret: string,
    code: string | undefined,
    now: number,
    allowRecovery: boolean,
  ) =>
    Effect.gen(function* () {
      if (!code?.trim())
        return yield* new AuthError({
          message: "Enter an authenticator code or recovery code.",
          status: 401,
        });
      const candidate = code.trim();
      if (state.blockedUntil > now)
        return yield* new AuthError({
          message: "Too many authentication attempts. Try again later.",
          status: 429,
          retryAfterSeconds: Math.ceil((state.blockedUntil - now) / 1000),
        });
      if (allowRecovery && state.failures >= 100 && /^\d{6}$/.test(candidate))
        return yield* new AuthError({
          message: "Authenticator codes are locked. Use a recovery code.",
          status: 429,
          reason: "two-factor-locked",
        });

      // Reserve and persist the failure before examining a guess. Cancellation,
      // concurrent requests and backend restart cannot refund the attempt.
      const failures = Math.min(100, state.failures + 1);
      const cooldown =
        failures < 5 ? 0 : Math.min(3_600_000, 30_000 * 2 ** Math.min(7, failures - 5));
      yield* write({ ...state, failures, blockedUntil: now + cooldown });
      let acceptedStep = -1;
      if ((!allowRecovery || state.failures < 100) && /^\d{6}$/.test(candidate)) {
        const currentStep = Math.floor(now / TOTP_PERIOD_MS);
        // Only one adjacent step in each direction; every accepted step is
        // persisted, including the enrollment proof, to reject replay.
        for (const step of [currentStep - 1, currentStep, currentStep + 1]) {
          if (
            step >= 0 &&
            step > state.lastStep &&
            equalSecret(totpAtStep(secret, step), candidate)
          )
            acceptedStep = step;
        }
      }
      const hash =
        allowRecovery && /^[a-f\d-]{32,39}$/i.test(candidate) ? recoveryHash(candidate) : null;
      const recoveryIndex =
        hash === null ? -1 : state.recoveryHashes.findIndex((stored) => equalSecret(stored, hash));
      if (acceptedStep === -1 && recoveryIndex === -1) return yield* invalid();
      return {
        ...state,
        failures: 0,
        blockedUntil: 0,
        lastStep: Math.max(state.lastStep, acceptedStep),
        recoveryHashes: state.recoveryHashes.filter((_, index) => index !== recoveryIndex),
      } satisfies State;
    });

  const enable: TwoFactorServiceShape["enable"] = (owner, code) =>
    withAdmission(
      Effect.gen(function* () {
        const state = yield* read;
        const now = yield* Clock.currentTimeMillis;
        if (
          state.secret !== null ||
          state.pending === null ||
          state.pending.owner !== owner ||
          state.pending.expiresAt <= now
        )
          return yield* new AuthError({
            message: "Start a new two-factor enrollment from this session.",
            status: 400,
          });
        const checked = yield* check(state, state.pending.secret, code, now, false);
        const recoveryCodes = Array.from({ length: 10 }, () =>
          Crypto.randomBytes(16).toString("hex").match(/.{8}/g)!.join("-"),
        );
        yield* write({
          ...checked,
          secret: state.pending.secret,
          pending: null,
          recoveryHashes: recoveryCodes.map(recoveryHash),
        });
        return { recoveryCodes };
      }),
    );

  const verify: TwoFactorServiceShape["verify"] = (code) =>
    withAdmission(
      Effect.gen(function* () {
        const state = yield* read;
        if (state.secret === null) return;
        const checked = yield* check(
          state,
          state.secret,
          code,
          yield* Clock.currentTimeMillis,
          true,
        );
        yield* write(checked);
      }),
    );
  const disable: TwoFactorServiceShape["disable"] = (code) =>
    withAdmission(
      Effect.gen(function* () {
        const state = yield* read;
        if (state.secret === null) return;
        yield* check(state, state.secret, code, yield* Clock.currentTimeMillis, true);
        yield* write(emptyState());
      }),
    );
  return { status, begin, enable, verify, disable } satisfies TwoFactorServiceShape;
});

export const TwoFactorServiceLive = Layer.effect(TwoFactorService, makeTwoFactorService);
