import { randomUUID } from "node:crypto";
import {
  ProviderUsageResetError,
  type ProviderUsageResetInput,
  type ProviderUsageResetResult,
  type ProviderUsageResetOutcome,
  type ServerProviderAccountRateLimits,
} from "@cafecode/contracts";
import { hasLowCodexUsage } from "@cafecode/shared/providerUsageReset";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Semaphore from "effect/Semaphore";
import type { ProviderInstance } from "./ProviderDriver.ts";
import { ProviderInstanceRegistry } from "./Services/ProviderInstanceRegistry.ts";

export type ProviderUsageResetOperation =
  | { readonly action: "preview" }
  | {
      readonly action: "redeem";
      readonly idempotencyKey: string;
      readonly identity: string;
      readonly creditId?: string;
      readonly onDispatch?: () => void;
      readonly onOutcome?: (outcome: ProviderUsageResetOutcome) => void;
      readonly beforeDispatch?: Effect.Effect<void, ProviderUsageResetError>;
    };

export interface ProviderUsageResetCapability {
  readonly run: (operation: ProviderUsageResetOperation) => Effect.Effect<
    {
      readonly identity: string;
      readonly rateLimits: ServerProviderAccountRateLimits | null;
      readonly outcome: ProviderUsageResetOutcome | null;
    },
    ProviderUsageResetError
  >;
}

interface Confirmation {
  readonly id: string;
  readonly instance: ProviderInstance;
  readonly identity: string;
  readonly expiresAt: number;
  readonly creditId?: string;
  attempted: boolean;
  result: ProviderUsageResetResult;
}

// Previews expire quickly; completed receipts remain longer to answer lost ACKs.
// Uncertain attempts are never evicted or replaced with a fresh spend identity.
const PREVIEW_LIFETIME_MS = 5 * 60_000;
const RECEIPT_LIFETIME_MS = 60 * 60_000;
const MAX_CONFIRMATIONS = 128;
const fail = (message: string) => Effect.fail(new ProviderUsageResetError({ message }));

export const makeProviderUsageReset = Effect.gen(function* () {
  const instances = yield* ProviderInstanceRegistry;
  const scope = yield* Effect.scope;
  const lock = yield* Semaphore.make(1);
  const confirmations = new Map<string, Confirmation>();

  const run = Effect.fn("providerUsageReset")(function* (input: ProviderUsageResetInput) {
    const instance = yield* instances.getInstance(input.instanceId);
    if (!instance?.enabled || instance.driverKind !== "codex" || !instance.usageReset) {
      return yield* fail("Usage resets are unavailable for this provider.");
    }
    const snapshot = yield* instance.snapshot.getSnapshot;
    if (snapshot.auth.status !== "authenticated" || snapshot.auth.type !== "chatgpt") {
      return yield* fail("Usage resets require an authenticated ChatGPT Codex account.");
    }
    const now = yield* Clock.currentTimeMillis;
    for (const [id, entry] of confirmations) {
      if (
        (!entry.attempted || entry.result.outcome !== null) &&
        now > entry.expiresAt + RECEIPT_LIFETIME_MS
      ) {
        confirmations.delete(id);
      }
    }

    if (input.action === "preview") {
      const pending = [...confirmations.values()].find(
        (entry) =>
          entry.instance.instanceId === input.instanceId &&
          entry.attempted &&
          entry.result.outcome === null,
      );
      if (pending) {
        if (pending.instance !== instance) {
          return yield* fail(
            "An earlier reset has an unknown result. Check Codex usage before trying again.",
          );
        }
        // Reopening after a dropped connection offers the SAME redemption only.
        const fresh = yield* instance.usageReset
          .run({ action: "preview" })
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (fresh && fresh.identity !== pending.identity) {
          return yield* fail(
            "An earlier reset belongs to a different Codex account. Restore that account to check its result.",
          );
        }
        pending.result = {
          ...pending.result,
          rateLimits: fresh?.rateLimits ?? null,
          retrying: true,
        };
        return pending.result;
      }
      const fresh = yield* instance.usageReset.run({ action: "preview" });
      if ((yield* instances.getInstance(input.instanceId)) !== instance) {
        return yield* fail("The provider changed. Reopen the reset dialog.");
      }
      const result: ProviderUsageResetResult = {
        rateLimits: fresh.rateLimits,
        confirmationId: null,
        outcome: null,
        retrying: false,
      };
      const availableCount = fresh.rateLimits?.rateLimitResetCredits?.availableCount;
      if (
        !hasLowCodexUsage(fresh.rateLimits) ||
        availableCount === undefined ||
        availableCount <= 0
      ) {
        return result;
      }
      // One unspent preview per instance also bounds repeated dialog opens.
      for (const [id, entry] of confirmations) {
        if (entry.instance === instance && !entry.attempted) confirmations.delete(id);
      }
      if (confirmations.size >= MAX_CONFIRMATIONS) {
        return yield* fail("Too many pending reset confirmations. Try again later.");
      }
      const id = randomUUID();
      const credit = fresh.rateLimits?.rateLimitResetCredits?.credits?.find(
        (entry) =>
          entry.status === "available" &&
          entry.resetType === "codexRateLimits" &&
          (entry.expiresAt == null || entry.expiresAt * 1_000 > now),
      );
      const confirmation: Confirmation = {
        id,
        instance,
        identity: fresh.identity,
        expiresAt: now + PREVIEW_LIFETIME_MS,
        ...(credit ? { creditId: credit.id } : {}),
        attempted: false,
        result: { ...result, confirmationId: id },
      };
      confirmations.set(id, confirmation);
      return confirmation.result;
    }

    const entry = confirmations.get(input.confirmationId);
    if (!entry || entry.instance !== instance) {
      return yield* fail("This reset confirmation is no longer valid. Reopen the dialog.");
    }
    if (entry.result.outcome !== null) return entry.result;
    if (!entry.attempted && now > entry.expiresAt) {
      return yield* fail("This reset confirmation expired. Reopen the dialog.");
    }
    // Mark the attempt immediately before native consume dispatch. Preparation
    // or account-validation failures can still reopen a fresh preview without
    // an ambiguous spend. Once sent, every retry keeps this UUID and credit id.
    const redeemed = yield* instance.usageReset
      .run({
        action: "redeem",
        idempotencyKey: entry.id,
        identity: entry.identity,
        ...(entry.creditId ? { creditId: entry.creditId } : {}),
        beforeDispatch: instances
          .getInstance(input.instanceId)
          .pipe(
            Effect.flatMap((current) =>
              current === instance
                ? Effect.void
                : fail("The provider changed before redemption. Reopen the reset dialog."),
            ),
          ),
        onDispatch: () => {
          entry.attempted = true;
        },
        onOutcome: (outcome) => {
          // Record the native ACK before usage refresh or child cleanup. A timeout
          // in either must not erase our knowledge that this credit was consumed.
          entry.result = { rateLimits: null, confirmationId: entry.id, outcome, retrying: false };
        },
      })
      .pipe(
        Effect.catch((error) =>
          entry.result.outcome !== null
            ? Effect.succeed({ rateLimits: entry.result.rateLimits, outcome: entry.result.outcome })
            : Effect.fail(error),
        ),
      );
    entry.result = {
      rateLimits: redeemed.rateLimits,
      confirmationId: entry.id,
      outcome: redeemed.outcome,
      retrying: false,
    };
    return entry.result;
  });

  return (input: ProviderUsageResetInput) =>
    Effect.gen(function* () {
      // Server-owned work survives the requesting WebSocket closing. The lock
      // serializes simultaneous confirms across connections; completed calls read
      // the receipt rather than dispatching a second provider mutation.
      const worker = yield* run(input).pipe(lock.withPermits(1), Effect.forkIn(scope));
      return yield* Fiber.join(worker);
    });
});
