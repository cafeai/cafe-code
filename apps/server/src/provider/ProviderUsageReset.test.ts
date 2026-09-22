import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import * as TestClock from "effect/testing/TestClock";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderUsageResetError,
  type ServerProvider,
  type ServerProviderAccountRateLimits,
} from "@cafecode/contracts";
import { makeProviderUsageReset, type ProviderUsageResetOperation } from "./ProviderUsageReset.ts";
import type { ProviderInstance } from "./ProviderDriver.ts";
import { ProviderInstanceRegistry } from "./Services/ProviderInstanceRegistry.ts";

const instanceId = ProviderInstanceId.make("codex-personal");
const limits: ServerProviderAccountRateLimits = {
  checkedAt: "2026-09-09T00:00:00.000Z",
  rateLimits: { primary: { usedPercent: 96 } },
  rateLimitResetCredits: {
    availableCount: 2,
    credits: [
      {
        id: "private-credit",
        resetType: "codexRateLimits",
        status: "available",
        grantedAt: 1,
        expiresAt: null,
        title: null,
        description: null,
      },
    ],
  },
};
function fixture() {
  const calls: ProviderUsageResetOperation[] = [];
  let failNext = false;
  let failAfterAck = false;
  let rateLimits = limits;
  const snapshot: ServerProvider = {
    instanceId,
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: "0.153.4",
    status: "ready",
    auth: { status: "authenticated", type: "chatgpt" },
    checkedAt: limits.checkedAt,
    models: [],
    skills: [],
    slashCommands: [],
  };
  let instance = {
    instanceId,
    driverKind: ProviderDriverKind.make("codex"),
    enabled: true,
    snapshot: { getSnapshot: Effect.succeed(snapshot) },
    usageReset: {
      run: (operation: ProviderUsageResetOperation) =>
        Effect.suspend(() => {
          calls.push(operation);
          if (operation.action === "redeem") operation.onDispatch?.();
          if (operation.action === "redeem" && failAfterAck) {
            operation.onOutcome?.("reset");
            return Effect.fail(
              new ProviderUsageResetError({ message: "simulated refresh timeout after ACK" }),
            );
          }
          if (operation.action === "redeem" && failNext) {
            failNext = false;
            return Effect.fail(new ProviderUsageResetError({ message: "simulated lost ACK" }));
          }
          return Effect.succeed({
            identity: "private-account-comparison-key",
            rateLimits,
            outcome: operation.action === "redeem" ? ("reset" as const) : null,
          });
        }),
    },
  } as unknown as ProviderInstance;
  const registry = ProviderInstanceRegistry.of({
    getInstance: (id) => Effect.sync(() => (id === instanceId ? instance : undefined)),
  } as ProviderInstanceRegistry["Service"]);
  return {
    calls,
    registry,
    failNext: () => {
      failNext = true;
    },
    failAfterAck: () => {
      failAfterAck = true;
    },
    setLimits: (next: ServerProviderAccountRateLimits) => {
      rateLimits = next;
    },
    replace: () => {
      instance = { ...instance };
    },
    unauthenticate: () => {
      instance = {
        ...instance,
        snapshot: {
          ...instance.snapshot,
          getSnapshot: Effect.succeed({ ...snapshot, auth: { status: "unauthenticated" } }),
        },
      };
    },
  };
}

describe("usage reset confirmations (no live provider)", () => {
  it.effect(
    "preview never redeems; simultaneous confirmations spend once and replay the receipt",
    () => {
      const f = fixture();
      return Effect.gen(function* () {
        const run = yield* makeProviderUsageReset;
        const preview = yield* run({ action: "preview", instanceId });
        expect(preview.confirmationId).not.toBeNull();
        expect(f.calls).toEqual([{ action: "preview" }]);
        const input = {
          action: "redeem" as const,
          instanceId,
          confirmationId: preview.confirmationId!,
        };
        const responses = yield* Effect.all([run(input), run(input)], { concurrency: 2 });
        expect(responses[0]).toEqual(responses[1]);
        expect(f.calls).toEqual([
          { action: "preview" },
          expect.objectContaining({
            action: "redeem",
            idempotencyKey: preview.confirmationId,
            creditId: "private-credit",
            identity: "private-account-comparison-key",
          }),
        ]);
        expect(JSON.stringify(responses)).not.toContain("private-account-comparison-key");
      }).pipe(Effect.provideService(ProviderInstanceRegistry, f.registry), Effect.scoped);
    },
  );

  it.effect(
    "rejects forged confirmations, another instance and rebuilt providers before spending",
    () => {
      const f = fixture();
      return Effect.gen(function* () {
        const run = yield* makeProviderUsageReset;
        yield* run({ action: "redeem", instanceId, confirmationId: "forged" }).pipe(Effect.flip);
        const preview = yield* run({ action: "preview", instanceId });
        yield* run({
          action: "redeem",
          instanceId: ProviderInstanceId.make("codex-work"),
          confirmationId: preview.confirmationId!,
        }).pipe(Effect.flip);
        f.replace();
        yield* run({ action: "redeem", instanceId, confirmationId: preview.confirmationId! }).pipe(
          Effect.flip,
        );
        expect(f.calls.every((call) => call.action === "preview")).toBe(true);
      }).pipe(Effect.provideService(ProviderInstanceRegistry, f.registry), Effect.scoped);
    },
  );

  it.effect("retains the original attempt after an unknown result, including on reopen", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const run = yield* makeProviderUsageReset;
      const preview = yield* run({ action: "preview", instanceId });
      const input = {
        action: "redeem" as const,
        instanceId,
        confirmationId: preview.confirmationId!,
      };
      f.failNext();
      yield* run(input).pipe(Effect.flip);
      const reopened = yield* run({ action: "preview", instanceId });
      expect(reopened.confirmationId).toBe(preview.confirmationId);
      expect(reopened.retrying).toBe(true);
      yield* TestClock.adjust("2 hours");
      yield* run(input);
      const redemptions = f.calls.filter((call) => call.action === "redeem");
      expect(
        redemptions.map(
          ({ beforeDispatch: _guard, onDispatch: _dispatch, onOutcome: _outcome, ...request }) =>
            request,
        ),
      ).toEqual([
        {
          action: "redeem",
          idempotencyKey: preview.confirmationId,
          creditId: "private-credit",
          identity: "private-account-comparison-key",
        },
        {
          action: "redeem",
          idempotencyKey: preview.confirmationId,
          creditId: "private-credit",
          identity: "private-account-comparison-key",
        },
      ]);
    }).pipe(Effect.provideService(ProviderInstanceRegistry, f.registry), Effect.scoped);
  });

  it.effect(
    "keeps a native consume ACK conclusive when subsequent refresh or cleanup fails",
    () => {
      const f = fixture();
      return Effect.gen(function* () {
        const run = yield* makeProviderUsageReset;
        const preview = yield* run({ action: "preview", instanceId });
        f.failAfterAck();
        const input = {
          action: "redeem" as const,
          instanceId,
          confirmationId: preview.confirmationId!,
        };
        const response = yield* run(input);
        expect(response.outcome).toBe("reset");
        expect(response.rateLimits).toBeNull();
        expect(yield* run(input)).toEqual(response);
        expect(f.calls.filter((call) => call.action === "redeem")).toHaveLength(1);
      }).pipe(Effect.provideService(ProviderInstanceRegistry, f.registry), Effect.scoped);
    },
  );

  it.effect("expires unspent confirmations and rejects logout", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const run = yield* makeProviderUsageReset;
      const preview = yield* run({ action: "preview", instanceId });
      yield* TestClock.adjust("6 minutes");
      yield* run({ action: "redeem", instanceId, confirmationId: preview.confirmationId! }).pipe(
        Effect.flip,
      );
      f.unauthenticate();
      yield* run({ action: "preview", instanceId }).pipe(Effect.flip);
      expect(f.calls).toEqual([{ action: "preview" }]);
    }).pipe(Effect.provideService(ProviderInstanceRegistry, f.registry), Effect.scoped);
  });

  it.effect(
    "requires fresh low usage and positive aggregate credits, with optional detail rows",
    () => {
      const f = fixture();
      return Effect.gen(function* () {
        const run = yield* makeProviderUsageReset;
        for (const fresh of [
          { ...limits, rateLimits: { primary: { usedPercent: 95 } } },
          {
            ...limits,
            rateLimitResetCredits: {
              availableCount: 0,
              credits: limits.rateLimitResetCredits!.credits!,
            },
          },
          { ...limits, rateLimitResetCredits: null },
        ]) {
          f.setLimits(fresh);
          expect((yield* run({ action: "preview", instanceId })).confirmationId).toBeNull();
        }
        f.setLimits({ ...limits, rateLimitResetCredits: { availableCount: 2, credits: null } });
        const preview = yield* run({ action: "preview", instanceId });
        yield* run({ action: "redeem", instanceId, confirmationId: preview.confirmationId! });
        expect(f.calls.at(-1)).not.toHaveProperty("creditId");
      }).pipe(Effect.provideService(ProviderInstanceRegistry, f.registry), Effect.scoped);
    },
  );

  it.effect("admitted work survives the waiting connection being interrupted", () => {
    const f = fixture();
    return Effect.gen(function* () {
      const original = yield* f.registry.getInstance(instanceId);
      const started = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      const instance: ProviderInstance = {
        ...original!,
        usageReset: {
          run: (op) =>
            op.action === "preview"
              ? original!.usageReset!.run(op)
              : Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Deferred.await(finish)),
                  Effect.andThen(original!.usageReset!.run(op)),
                ),
        },
      };
      const run = yield* makeProviderUsageReset.pipe(
        Effect.provideService(ProviderInstanceRegistry, {
          ...f.registry,
          getInstance: () => Effect.succeed(instance),
        }),
      );
      const preview = yield* run({ action: "preview", instanceId });
      const input = {
        action: "redeem" as const,
        instanceId,
        confirmationId: preview.confirmationId!,
      };
      const waiter = yield* run(input).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* Fiber.interrupt(waiter);
      yield* Deferred.succeed(finish, undefined);
      expect((yield* run(input)).outcome).toBe("reset");
      expect(f.calls.filter((call) => call.action === "redeem")).toHaveLength(1);
    }).pipe(Effect.scoped);
  });
});
