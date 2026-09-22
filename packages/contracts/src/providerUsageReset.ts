import * as Schema from "effect/Schema";
import { ProviderInstanceId } from "./providerInstance.ts";
import { ServerProviderAccountRateLimits } from "./server.ts";

export const ProviderUsageResetInput = Schema.Union([
  Schema.Struct({ action: Schema.Literal("preview"), instanceId: ProviderInstanceId }),
  Schema.Struct({
    action: Schema.Literal("redeem"),
    instanceId: ProviderInstanceId,
    confirmationId: Schema.String.check(Schema.isUUID()),
  }),
]);
export type ProviderUsageResetInput = typeof ProviderUsageResetInput.Type;

export const ProviderUsageResetOutcome = Schema.Literals([
  "reset",
  "alreadyRedeemed",
  "nothingToReset",
  "noCredit",
]);
export type ProviderUsageResetOutcome = typeof ProviderUsageResetOutcome.Type;

export const ProviderUsageResetResult = Schema.Struct({
  rateLimits: Schema.NullOr(ServerProviderAccountRateLimits),
  confirmationId: Schema.NullOr(Schema.String),
  outcome: Schema.NullOr(ProviderUsageResetOutcome),
  // An interrupted response must retry the existing redemption, not start another.
  retrying: Schema.Boolean,
});
export type ProviderUsageResetResult = typeof ProviderUsageResetResult.Type;

export class ProviderUsageResetError extends Schema.TaggedErrorClass<ProviderUsageResetError>()(
  "ProviderUsageResetError",
  { message: Schema.String },
) {}
