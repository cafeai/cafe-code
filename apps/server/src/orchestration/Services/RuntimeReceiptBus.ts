/**
 * RuntimeReceiptBus - Internal checkpoint-reactor synchronization receipts.
 *
 * This service exposes short-lived orchestration milestones that are not part
 * of the durable domain event model. Production lifecycle code uses provider
 * ingestion receipts to synchronize independent provider-event consumers, while
 * tests can subscribe to the same receipt stream instead of inferring milestones
 * indirectly from persisted state.
 *
 * Receipts are process-local coordination facts. They must not contain prompts,
 * model output, secrets, or unrestricted filesystem paths.
 *
 * @module RuntimeReceiptBus
 */
import {
  CheckpointRef,
  EventId,
  IsoDateTime,
  NonNegativeInt,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@cafecode/contracts";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

export const CheckpointBaselineCapturedReceipt = Schema.Struct({
  type: Schema.Literal("checkpoint.baseline.captured"),
  threadId: ThreadId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
  createdAt: IsoDateTime,
});
export type CheckpointBaselineCapturedReceipt = typeof CheckpointBaselineCapturedReceipt.Type;

export const CheckpointDiffFinalizedReceipt = Schema.Struct({
  type: Schema.Literal("checkpoint.diff.finalized"),
  threadId: ThreadId,
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
  checkpointRef: CheckpointRef,
  status: Schema.Literals(["ready", "missing", "error"]),
  createdAt: IsoDateTime,
});
export type CheckpointDiffFinalizedReceipt = typeof CheckpointDiffFinalizedReceipt.Type;

export const TurnProcessingQuiescedReceipt = Schema.Struct({
  type: Schema.Literal("turn.processing.quiesced"),
  threadId: ThreadId,
  turnId: TurnId,
  checkpointTurnCount: NonNegativeInt,
  createdAt: IsoDateTime,
});
export type TurnProcessingQuiescedReceipt = typeof TurnProcessingQuiescedReceipt.Type;

export const ProviderTurnIngestionQuiescedReceipt = Schema.Struct({
  type: Schema.Literal("provider.turn.ingestion-quiesced"),
  threadId: ThreadId,
  turnId: TurnId,
  provider: ProviderDriverKind,
  providerInstanceId: Schema.optional(ProviderInstanceId),
  sourceEventId: EventId,
  createdAt: IsoDateTime,
});
export type ProviderTurnIngestionQuiescedReceipt = typeof ProviderTurnIngestionQuiescedReceipt.Type;

export const OrchestrationRuntimeReceipt = Schema.Union([
  CheckpointBaselineCapturedReceipt,
  CheckpointDiffFinalizedReceipt,
  TurnProcessingQuiescedReceipt,
  ProviderTurnIngestionQuiescedReceipt,
]);
export type OrchestrationRuntimeReceipt = typeof OrchestrationRuntimeReceipt.Type;

export interface AwaitTurnIngestionQuiescedInput {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly provider: ProviderDriverKind;
  readonly providerInstanceId?: ProviderInstanceId | undefined;
}

export interface RuntimeReceiptBusShape {
  readonly publish: (receipt: OrchestrationRuntimeReceipt) => Effect.Effect<void>;
  readonly awaitTurnIngestionQuiesced: (
    input: AwaitTurnIngestionQuiescedInput,
  ) => Effect.Effect<ProviderTurnIngestionQuiescedReceipt>;
  readonly streamEventsForTest: Stream.Stream<OrchestrationRuntimeReceipt>;
}

export class RuntimeReceiptBus extends Context.Service<RuntimeReceiptBus, RuntimeReceiptBusShape>()(
  "cafecode/orchestration/Services/RuntimeReceiptBus",
) {}
