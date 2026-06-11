/**
 * RuntimeReceiptBus layers.
 *
 * `RuntimeReceiptBusLive` is process-local and intentionally non-durable.
 * It retains only a bounded set of recent provider-ingestion receipts so
 * checkpoint lifecycle code can safely wait for a receipt that may have been
 * published just before the waiter started.
 *
 * @module RuntimeReceiptBus
 */
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import {
  RuntimeReceiptBus,
  type RuntimeReceiptBusShape,
  type OrchestrationRuntimeReceipt,
  type AwaitTurnIngestionQuiescedInput,
  type ProviderTurnIngestionQuiescedReceipt,
} from "../Services/RuntimeReceiptBus.ts";

const MAX_OBSERVED_PROVIDER_INGESTION_RECEIPTS = 2_048;

type IngestionWaiter = Deferred.Deferred<ProviderTurnIngestionQuiescedReceipt, never>;

interface RuntimeReceiptState {
  readonly observedIngestionReceipts: ReadonlyMap<string, ProviderTurnIngestionQuiescedReceipt>;
  readonly observedIngestionReceiptKeys: ReadonlyArray<string>;
  readonly ingestionWaiters: ReadonlyMap<string, ReadonlyArray<IngestionWaiter>>;
}

type AwaitIngestionReceiptRegistration =
  | {
      readonly type: "observed";
      readonly receipt: ProviderTurnIngestionQuiescedReceipt;
    }
  | {
      readonly type: "waiting";
    };

const providerTurnIngestionKey = (input: AwaitTurnIngestionQuiescedInput) =>
  [input.provider, input.providerInstanceId ?? "", input.threadId, input.turnId].join("\u001f");

const receiptKey = (receipt: ProviderTurnIngestionQuiescedReceipt) =>
  providerTurnIngestionKey({
    threadId: receipt.threadId,
    turnId: receipt.turnId,
    provider: receipt.provider,
    providerInstanceId: receipt.providerInstanceId,
  });

const emptyState: RuntimeReceiptState = {
  observedIngestionReceipts: new Map(),
  observedIngestionReceiptKeys: [],
  ingestionWaiters: new Map(),
};

const rememberIngestionReceipt = (
  state: RuntimeReceiptState,
  key: string,
  receipt: ProviderTurnIngestionQuiescedReceipt,
): RuntimeReceiptState => {
  const observed = new Map(state.observedIngestionReceipts);
  const keysWithoutCurrent = state.observedIngestionReceiptKeys.filter((entry) => entry !== key);
  observed.set(key, receipt);
  const keys = [...keysWithoutCurrent, key];

  while (keys.length > MAX_OBSERVED_PROVIDER_INGESTION_RECEIPTS) {
    const oldest = keys.shift();
    if (oldest !== undefined) {
      observed.delete(oldest);
    }
  }

  return {
    ...state,
    observedIngestionReceipts: observed,
    observedIngestionReceiptKeys: keys,
  };
};

const makeRuntimeReceiptBus = Effect.gen(function* () {
  const pubSub = yield* PubSub.unbounded<OrchestrationRuntimeReceipt>();
  const stateRef = yield* Ref.make<RuntimeReceiptState>(emptyState);
  const removeIngestionWaiter = (key: string, waiter: IngestionWaiter) =>
    Ref.update(stateRef, (state) => {
      const matchingWaiters = state.ingestionWaiters.get(key);
      if (!matchingWaiters) {
        return state;
      }

      const remainingWaiters = matchingWaiters.filter((entry) => entry !== waiter);
      const waiters = new Map(state.ingestionWaiters);
      if (remainingWaiters.length === 0) {
        waiters.delete(key);
      } else {
        waiters.set(key, remainingWaiters);
      }
      return {
        ...state,
        ingestionWaiters: waiters,
      };
    });

  return {
    publish: (receipt) =>
      Effect.gen(function* () {
        if (receipt.type === "provider.turn.ingestion-quiesced") {
          const key = receiptKey(receipt);
          const waiters = yield* Ref.modify(stateRef, (state) => {
            const nextWaiters = new Map(state.ingestionWaiters);
            const matchingWaiters = nextWaiters.get(key) ?? [];
            nextWaiters.delete(key);
            return [
              matchingWaiters,
              {
                ...rememberIngestionReceipt(state, key, receipt),
                ingestionWaiters: nextWaiters,
              },
            ];
          });
          yield* Effect.forEach(waiters, (waiter) => Deferred.succeed(waiter, receipt), {
            discard: true,
          });
        }
        yield* PubSub.publish(pubSub, receipt).pipe(Effect.asVoid);
      }),
    awaitTurnIngestionQuiesced: (input) =>
      Effect.gen(function* () {
        const key = providerTurnIngestionKey(input);
        const waiter = yield* Deferred.make<ProviderTurnIngestionQuiescedReceipt, never>();
        const result = yield* Ref.modify(
          stateRef,
          (state): readonly [AwaitIngestionReceiptRegistration, RuntimeReceiptState] => {
            const observed = state.observedIngestionReceipts.get(key);
            if (observed !== undefined) {
              return [{ type: "observed" as const, receipt: observed }, state];
            }

            const waiters = new Map(state.ingestionWaiters);
            waiters.set(key, [...(waiters.get(key) ?? []), waiter]);
            return [
              { type: "waiting" as const },
              {
                ...state,
                ingestionWaiters: waiters,
              },
            ];
          },
        );

        if (result.type === "observed") {
          return result.receipt;
        }
        return yield* Deferred.await(waiter).pipe(
          Effect.ensuring(removeIngestionWaiter(key, waiter)),
        );
      }),
    get streamEventsForTest() {
      return Stream.fromPubSub(pubSub);
    },
  } satisfies RuntimeReceiptBusShape;
});

const makeRuntimeReceiptBusTest = makeRuntimeReceiptBus;

export const RuntimeReceiptBusLive = Layer.effect(RuntimeReceiptBus, makeRuntimeReceiptBus);
export const RuntimeReceiptBusTest = Layer.effect(RuntimeReceiptBus, makeRuntimeReceiptBusTest);
