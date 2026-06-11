import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import { afterEach, describe, expect, it } from "vitest";

import { RuntimeReceiptBusLive } from "./RuntimeReceiptBus.ts";
import { RuntimeReceiptBus } from "../Services/RuntimeReceiptBus.ts";

describe("RuntimeReceiptBus", () => {
  let runtime: ManagedRuntime.ManagedRuntime<RuntimeReceiptBus, unknown> | null = null;

  afterEach(async () => {
    if (runtime) {
      await runtime.dispose();
      runtime = null;
    }
  });

  async function createBus() {
    runtime = ManagedRuntime.make(RuntimeReceiptBusLive);
    return runtime.runPromise(Effect.service(RuntimeReceiptBus));
  }

  const makeReceipt = (turnId: string) => ({
    type: "provider.turn.ingestion-quiesced" as const,
    threadId: ThreadId.make("thread-1"),
    turnId: TurnId.make(turnId),
    provider: ProviderDriverKind.make("codex"),
    providerInstanceId: ProviderInstanceId.make("codex"),
    sourceEventId: EventId.make(`evt-${turnId}`),
    createdAt: "2026-01-01T00:00:00.000Z",
  });

  it("resolves waiters that start after an ingestion receipt was published", async () => {
    const bus = await createBus();
    const receipt = makeReceipt("turn-publish-before-wait");

    await runtime!.runPromise(bus.publish(receipt));

    const observed = await runtime!.runPromise(
      bus.awaitTurnIngestionQuiesced({
        threadId: receipt.threadId,
        turnId: receipt.turnId,
        provider: receipt.provider,
        providerInstanceId: receipt.providerInstanceId,
      }),
    );

    expect(observed.sourceEventId).toBe(receipt.sourceEventId);
  });

  it("resolves waiters that start before an ingestion receipt is published", async () => {
    const bus = await createBus();
    const receipt = makeReceipt("turn-wait-before-publish");
    const waiting = runtime!.runPromise(
      bus.awaitTurnIngestionQuiesced({
        threadId: receipt.threadId,
        turnId: receipt.turnId,
        provider: receipt.provider,
        providerInstanceId: receipt.providerInstanceId,
      }),
    );

    await runtime!.runPromise(bus.publish(receipt));

    await expect(waiting).resolves.toMatchObject({ sourceEventId: receipt.sourceEventId });
  });

  it("does not retain provider ingestion receipts without a bound", async () => {
    const bus = await createBus();
    const evictedReceipt = makeReceipt("turn-evicted");
    await runtime!.runPromise(bus.publish(evictedReceipt));

    for (let index = 0; index < 2_048; index += 1) {
      await runtime!.runPromise(bus.publish(makeReceipt(`turn-retained-${index}`)));
    }

    const evicted = await runtime!.runPromise(
      bus
        .awaitTurnIngestionQuiesced({
          threadId: evictedReceipt.threadId,
          turnId: evictedReceipt.turnId,
          provider: evictedReceipt.provider,
          providerInstanceId: evictedReceipt.providerInstanceId,
        })
        .pipe(Effect.timeoutOption("10 millis")),
    );
    const newest = await runtime!.runPromise(
      bus
        .awaitTurnIngestionQuiesced({
          threadId: ThreadId.make("thread-1"),
          turnId: TurnId.make("turn-retained-2047"),
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: ProviderInstanceId.make("codex"),
        })
        .pipe(Effect.timeoutOption("10 millis")),
    );

    expect(Option.isNone(evicted)).toBe(true);
    expect(Option.isSome(newest)).toBe(true);
  });
});
