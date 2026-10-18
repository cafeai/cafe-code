import { AuthSessionId } from "@cafecode/contracts/auth";
import { expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { ServerSecretStore, SecretStoreError } from "../Services/ServerSecretStore.ts";
import { makeTwoFactorService } from "./TwoFactorService.ts";
import { totpAtStep } from "../totp.ts";

const owner = AuthSessionId.make("owner-test");
const fixture = Effect.gen(function* () {
  const secrets = new Map<string, Uint8Array>();
  let refuseWrites = false;
  const store = ServerSecretStore.of({
    get: (name) => Effect.sync(() => secrets.get(name) ?? null),
    set: (name, value) =>
      Effect.suspend(() =>
        refuseWrites
          ? Effect.fail(new SecretStoreError({ message: "fixture write failure" }))
          : Effect.sync(() => {
              secrets.set(name, value);
            }),
      ),
    remove: (name) =>
      Effect.sync(() => {
        secrets.delete(name);
      }),
    getOrCreateRandom: () => Effect.die("unused"),
  });
  const service = yield* makeTwoFactorService.pipe(Effect.provideService(ServerSecretStore, store));
  const enroll = Effect.gen(function* () {
    const setup = yield* service.begin(owner);
    const now = yield* Clock.currentTimeMillis;
    const result = yield* service.enable(owner, totpAtStep(setup.secret, Math.floor(now / 30_000)));
    return { ...setup, ...result };
  });
  return {
    service,
    secrets,
    store,
    enroll,
    refuseWrites: () => {
      refuseWrites = true;
    },
  };
});
const failureStatus = <A>(effect: Effect.Effect<A, { status?: number }>) =>
  effect.pipe(Effect.match({ onSuccess: () => 200, onFailure: (error) => error.status }));

it.effect("bounds pending storage operations and drains the exact held lane", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>();
      const refused = yield* Deferred.make<void>();
      yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
      const base = yield* fixture;
      const heldStore = { ...base.store, get: () => Deferred.await(release).pipe(Effect.as(null)) };
      const service = yield* makeTwoFactorService.pipe(
        Effect.provideService(ServerSecretStore, heldStore),
      );
      // Retire the held operation before the enclosing scope joins children,
      // including timeout/cancellation while any admission assertion is pending.
      yield* Effect.gen(function* () {
        const requests = yield* Effect.forkChild(
          Effect.all(
            Array.from({ length: 17 }, () =>
              service.status.pipe(
                Effect.matchEffect({
                  onSuccess: () => Effect.succeed(200),
                  onFailure: (error) =>
                    Deferred.succeed(refused, undefined).pipe(Effect.as(error.status)),
                }),
              ),
            ),
            { concurrency: "unbounded" },
          ),
        );
        yield* Deferred.await(refused);
        yield* Deferred.succeed(release, undefined);
        const results = yield* Fiber.join(requests);
        expect(results.filter((status) => status === 200)).toHaveLength(16);
        expect(results.filter((status) => status === 429)).toHaveLength(1);
      }).pipe(Effect.ensuring(Deferred.succeed(release, undefined)));
    }),
  ),
);

it.effect("requires a fresh owner-bound enrollment proof before enabling", () =>
  Effect.gen(function* () {
    const { service } = yield* fixture;
    expect(yield* service.status).toEqual({ enabled: false, recoveryCodesRemaining: 0 });
    const setup = yield* service.begin(owner);
    expect(setup.uri).toContain(`secret=${setup.secret}`);
    const now = yield* Clock.currentTimeMillis;
    const code = totpAtStep(setup.secret, Math.floor(now / 30_000));
    expect(yield* failureStatus(service.enable(AuthSessionId.make("other-owner"), code))).toBe(400);
    expect(yield* service.status).toEqual({ enabled: false, recoveryCodesRemaining: 0 });
    yield* TestClock.adjust("10 minutes");
    expect(yield* failureStatus(service.enable(owner, code))).toBe(400);
  }),
);

it.effect(
  "persists enrollment, rejects enrollment-code replay, and consumes hashed recovery codes once",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const setup = yield* f.enroll;
      const now = yield* Clock.currentTimeMillis;
      expect(
        yield* failureStatus(f.service.verify(totpAtStep(setup.secret, Math.floor(now / 30_000)))),
      ).toBe(401);
      const restarted = yield* makeTwoFactorService.pipe(
        Effect.provideService(ServerSecretStore, f.store),
      );
      expect(yield* restarted.status).toEqual({ enabled: true, recoveryCodesRemaining: 10 });
      expect(new TextDecoder().decode(f.secrets.get("remote-two-factor"))).not.toContain(
        setup.recoveryCodes[0],
      );
      yield* restarted.verify(setup.recoveryCodes[0]);
      expect(yield* failureStatus(f.service.verify(setup.recoveryCodes[0]))).toBe(401);
      expect(yield* f.service.status).toEqual({ enabled: true, recoveryCodesRemaining: 9 });
      const simultaneous = yield* Effect.all(
        [f.service.verify(setup.recoveryCodes[1]), restarted.verify(setup.recoveryCodes[1])].map(
          failureStatus,
        ),
        { concurrency: "unbounded" },
      );
      expect(simultaneous.toSorted()).toEqual([200, 401]);
      expect((yield* restarted.status).recoveryCodesRemaining).toBe(8);
      yield* TestClock.adjust("30 seconds");
      const next = totpAtStep(setup.secret, Math.floor((yield* Clock.currentTimeMillis) / 30_000));
      yield* f.service.verify(next);
      expect(yield* failureStatus(restarted.verify(next))).toBe(401);
    }),
);

it.effect(
  "atomically limits concurrent guesses, persists cooldown, and does not extend it for refused requests",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const setup = yield* f.enroll;
      const outcomes = yield* Effect.all(
        Array.from({ length: 20 }, () => failureStatus(f.service.verify("wrong-code"))),
        { concurrency: "unbounded" },
      );
      expect(outcomes.filter((status) => status === 401)).toHaveLength(5);
      expect(outcomes.filter((status) => status === 429)).toHaveLength(15);
      const restarted = yield* makeTwoFactorService.pipe(
        Effect.provideService(ServerSecretStore, f.store),
      );
      const limited = yield* restarted.verify(setup.recoveryCodes[0]).pipe(Effect.flip);
      expect(limited.status).toBe(429);
      expect(limited.retryAfterSeconds).toBe(30);
      yield* TestClock.adjust("30 seconds");
      expect(yield* failureStatus(restarted.verify("wrong-code"))).toBe(401);
      expect((yield* restarted.verify("wrong-code").pipe(Effect.flip)).retryAfterSeconds).toBe(60);
      yield* TestClock.adjust("60 seconds");
      yield* restarted.verify(setup.recoveryCodes[0]);
      expect(yield* failureStatus(restarted.verify("wrong-code"))).toBe(401);
    }),
);

it.effect("caps cooldown at one hour and locks short codes after 100 failures until recovery", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const setup = yield* f.enroll;
    for (let index = 0; index < 100; index++) {
      expect(yield* failureStatus(f.service.verify("wrong-code"))).toBe(401);
      const snapshot = JSON.parse(new TextDecoder().decode(f.secrets.get("remote-two-factor"))) as {
        blockedUntil: number;
      };
      const remaining = snapshot.blockedUntil - (yield* Clock.currentTimeMillis);
      expect(remaining).toBeLessThanOrEqual(3_600_000);
      yield* TestClock.adjust("1 hour");
    }
    const code = totpAtStep(setup.secret, Math.floor((yield* Clock.currentTimeMillis) / 30_000));
    expect(yield* failureStatus(f.service.verify(code))).toBe(429);
    yield* f.service.verify(setup.recoveryCodes[0]);
    yield* f.service.verify(code);
  }),
);

it.effect("shares enrollment and disable throttles, and requires proof to disable", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.service.begin(owner);
    for (let index = 0; index < 5; index++)
      expect(yield* failureStatus(f.service.enable(owner, "wrong-code"))).toBe(401);
    const replaced = yield* f.service.begin(owner);
    expect(yield* failureStatus(f.service.enable(owner, totpAtStep(replaced.secret, 0)))).toBe(429);
    yield* TestClock.adjust("30 seconds");
    const enabled = yield* f.service.enable(owner, totpAtStep(replaced.secret, 1));
    expect(yield* failureStatus(f.service.disable("wrong-code"))).toBe(401);
    expect((yield* f.service.status).enabled).toBe(true);
    yield* f.service.disable(enabled.recoveryCodes[0]!);
    expect(yield* f.service.status).toEqual({ enabled: false, recoveryCodesRemaining: 0 });
  }),
);

it.effect("fails closed on corrupt storage and on a failed attempt reservation", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const setup = yield* f.enroll;
    f.refuseWrites();
    expect(yield* failureStatus(f.service.verify(setup.recoveryCodes[0]))).toBe(500);
    f.secrets.set("remote-two-factor", new TextEncoder().encode("broken"));
    expect(yield* failureStatus(f.service.verify(undefined))).toBe(500);
    expect(yield* failureStatus(f.service.status)).toBe(500);
  }),
);
