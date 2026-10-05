import * as Schema from "effect/Schema";
import { SubagentRuntimeId, ThreadId } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/** Metadata is inert text. Command identity is never trimmed, normalized or
 * rewritten: a command outside this token grammar is omitted, not repaired. */
const Label = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isPattern(/^[^\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]+$/u),
);
export const SessionSlashCommand = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/)),
  description: Schema.optional(Label.check(Schema.isMaxLength(512))),
  input: Schema.optional(Schema.Struct({ hint: Label.check(Schema.isMaxLength(256)) })),
});
export const ProviderCommandCatalog = Schema.Struct({
  status: Schema.Literals(["loading", "available", "empty", "unavailable"]),
  commands: Schema.Array(SessionSlashCommand).check(Schema.isMaxLength(512)),
});
export type ProviderCommandCatalog = typeof ProviderCommandCatalog.Type;

/** No client-supplied cwd or native session id is accepted. The server resolves
 * the saved workspace and compares the current Cafe-minted query generation. */
export const ProviderCommandsInput = Schema.Struct({
  threadId: ThreadId,
  instanceId: ProviderInstanceId,
  runtimeId: SubagentRuntimeId,
});
export type ProviderCommandsInput = typeof ProviderCommandsInput.Type;
