import * as Schema from "effect/Schema";
import { SubagentRuntimeId, ThreadId, TurnId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/** Native queue ordering; omission retains the provider's existing default. */
export const ProviderDeliveryPriority = Schema.Literals(["now", "next", "later"]);
export type ProviderDeliveryPriority = typeof ProviderDeliveryPriority.Type;

/** Exact recipient observed for an explicit-priority steer. A null runtime is
 * legacy unknown evidence, never a wildcard; account and active turn remain
 * mandatory, and every known runtime incarnation must match exactly. */
export const ProviderPrioritySessionBinding = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  subagentRuntimeId: Schema.NullOr(SubagentRuntimeId),
  activeTurnId: TurnId,
});
export type ProviderPrioritySessionBinding = typeof ProviderPrioritySessionBinding.Type;

export const ProviderTaskControlCapability = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  taskGeneration: Schema.String.check(Schema.isUUID()),
  canStop: Schema.Boolean,
  canBackground: Schema.Boolean,
});
export type ProviderTaskControlCapability = typeof ProviderTaskControlCapability.Type;

/** Public reference to a process-local binding, not a native tool identifier. */
export const ProviderIndividualTaskControl = Schema.Struct({
  taskId: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  runtimeId: SubagentRuntimeId,
  capability: ProviderTaskControlCapability,
});
export type ProviderIndividualTaskControl = typeof ProviderIndividualTaskControl.Type;

/** Exact runtime observation, never a renderer-supplied native task identifier. */
export const ProviderTaskControlInput = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  providerInstanceId: ProviderInstanceId,
  runtimeId: SubagentRuntimeId,
  taskId: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  taskGeneration: Schema.String.check(Schema.isUUID()),
  action: Schema.Literals(["stop", "background"]),
});
export type ProviderTaskControlInput = typeof ProviderTaskControlInput.Type;

/** Acknowledgement is deliberately distinct from native terminal evidence. */
export const ProviderTaskControlResult = Schema.Struct({
  status: Schema.Literals(["accepted", "already-terminal", "not-foreground", "unknown"]),
});
export type ProviderTaskControlResult = typeof ProviderTaskControlResult.Type;
