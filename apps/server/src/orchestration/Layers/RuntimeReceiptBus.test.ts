import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@cafecode/contracts";
import * as Effect from "effect/Effect";
import * as ManagedRuntime from "effect/ManagedRuntime";
import { afterEach, describe, expect, it } from "vitest";

import { makeRuntimeReceiptBusTest, retainRecentIngestionReceipt } from "./RuntimeReceiptBus.ts";
import { RuntimeReceiptBus } from "../Services/RuntimeReceiptBus.ts";

describe("RuntimeReceiptBus", () => {
  let runtime: ManagedRuntime.ManagedRuntime<RuntimeReceiptBus, unknown> | null = null;

  afterEach(async () => {
    if (runtime) {
      await runtime.dispose();
      runtime = null;
    }
  });

  async function createBus(maxObservedReceipts = 16) {
    runtime = ManagedRuntime.make(makeRuntimeReceiptBusTest(maxObservedReceipts));
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

  it("retains only the newest provider ingestion receipts", () => {
    const evictedReceipt = makeReceipt("turn-evicted");
    const retainedReceipt = makeReceipt("turn-retained");
    const newestReceipt = makeReceipt("turn-newest");
    const first = retainRecentIngestionReceipt(new Map(), [], "evicted", evictedReceipt, 2);
    const second = retainRecentIngestionReceipt(
      first.observedIngestionReceipts,
      first.observedIngestionReceiptKeys,
      "retained",
      retainedReceipt,
      2,
    );
    const third = retainRecentIngestionReceipt(
      second.observedIngestionReceipts,
      second.observedIngestionReceiptKeys,
      "newest",
      newestReceipt,
      2,
    );

    expect(third.observedIngestionReceiptKeys).toEqual(["retained", "newest"]);
    expect(third.observedIngestionReceipts.has("evicted")).toBe(false);
    expect(third.observedIngestionReceipts.get("retained")).toBe(retainedReceipt);
    expect(third.observedIngestionReceipts.get("newest")).toBe(newestReceipt);
  });
});
