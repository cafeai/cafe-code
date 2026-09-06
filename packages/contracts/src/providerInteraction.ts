import * as Schema from "effect/Schema";
import { ApprovalRequestId, ThreadId } from "./baseSchemas.ts";

// Provider forms are untrusted input, not executable JSON Schema. Transport a
// finite, non-recursive display vocabulary and validate answers against the
// original pending request before releasing a provider callback.
const Text = Schema.String.check(Schema.isMaxLength(8192));
const Label = Schema.String.check(Schema.isMaxLength(1024));
const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));
export const ProviderInteractionField = Schema.Struct({
  id: Id,
  title: Label,
  description: Schema.optional(Label),
  type: Schema.Literals(["string", "number", "integer", "boolean", "array"]),
  required: Schema.Boolean,
  options: Schema.optional(
    Schema.Array(Schema.Struct({ value: Label, label: Label })).check(Schema.isMaxLength(64)),
  ),
  minimum: Schema.optional(Schema.Number),
  maximum: Schema.optional(Schema.Number),
  minLength: Schema.optional(Schema.Int),
  maxLength: Schema.optional(Schema.Int),
  minItems: Schema.optional(Schema.Int),
  maxItems: Schema.optional(Schema.Int),
  format: Schema.optional(Schema.Literals(["email", "uri", "date", "date-time"])),
});
export type ProviderInteractionField = typeof ProviderInteractionField.Type;
export const ProviderElicitation = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("elicitation"),
    mode: Schema.Literal("form"),
    serverName: Label,
    message: Text,
    fields: Schema.Array(ProviderInteractionField).check(Schema.isMaxLength(32)),
  }),
  Schema.Struct({
    kind: Schema.Literal("elicitation"),
    mode: Schema.Literal("url"),
    serverName: Label,
    message: Text,
    // Authorization query/path tokens never enter canonical events. The full
    // URL is fetched from the live pending callback only on an explicit click.
    urlOrigin: Label,
  }),
]);
export type ProviderElicitation = typeof ProviderElicitation.Type;
export const ProviderPermissionInteraction = Schema.Struct({
  kind: Schema.Literal("permissions"),
  message: Text,
  cwd: Text,
  environment: Schema.optional(Label),
  grants: Schema.Array(Schema.Struct({ id: Id, label: Text })).check(Schema.isMaxLength(64)),
});
export type ProviderPermissionInteraction = typeof ProviderPermissionInteraction.Type;
export const ProviderInteraction = Schema.Union([
  ProviderElicitation,
  ProviderPermissionInteraction,
]);
export type ProviderInteraction = typeof ProviderInteraction.Type;

export const ProviderInteractionResponse = Schema.Struct({
  action: Schema.Literals(["accept", "decline", "cancel"]),
  content: Schema.optional(
    Schema.NullOr(
      Schema.Record(
        Id,
        Schema.Union([
          Text,
          Schema.Number,
          Schema.Boolean,
          Schema.Array(Label).check(Schema.isMaxLength(64)),
        ]),
      ),
    ),
  ),
  grantIds: Schema.optional(Schema.Array(Id).check(Schema.isMaxLength(64))),
  scope: Schema.optional(Schema.Literals(["turn", "session"])),
});
export type ProviderInteractionResponse = typeof ProviderInteractionResponse.Type;

export const ProviderNetworkApproval = Schema.Struct({
  host: Label,
  protocol: Label,
});
export type ProviderNetworkApproval = typeof ProviderNetworkApproval.Type;

/** Private callback operations never become orchestration commands or ledger rows. */
export const ProviderResolveInteractionUrlInput = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
});
export type ProviderResolveInteractionUrlInput = typeof ProviderResolveInteractionUrlInput.Type;
export const ProviderRespondToInteractionInput = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  response: ProviderInteractionResponse,
});
export type ProviderRespondToInteractionInput = typeof ProviderRespondToInteractionInput.Type;
export class ProviderInteractionError extends Schema.TaggedErrorClass<ProviderInteractionError>()(
  "ProviderInteractionError",
  {
    message: Label,
  },
) {}
