import * as Schema from "effect/Schema";
import { ProjectId, ThreadId } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/** The server resolves cwd from saved authority; clients never submit paths. */
export const ProviderSkillsInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  context: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("thread"), threadId: ThreadId }),
    Schema.Struct({ kind: Schema.Literal("project"), projectId: ProjectId }),
  ]),
});
export type ProviderSkillsInput = typeof ProviderSkillsInput.Type;
const Label = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isPattern(/^[^\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]+$/u),
);
/** Deliberately separate from the legacy provider snapshot skill shape: native
 * filesystem references cannot accidentally be serialized by this endpoint. */
export const DiscoveredProviderSkill = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(/^[A-Za-z][A-Za-z0-9:_-]{0,127}$/)),
  enabled: Schema.Boolean,
  scope: Schema.optional(Label.check(Schema.isMaxLength(80))),
  displayName: Schema.optional(Label.check(Schema.isMaxLength(128))),
  shortDescription: Schema.optional(Label.check(Schema.isMaxLength(512))),
  pluginId: Schema.optional(Label.check(Schema.isMaxLength(128))),
});
export const ProviderSkillsResult = Schema.Struct({
  skills: Schema.Array(DiscoveredProviderSkill).check(Schema.isMaxLength(512)),
  status: Schema.Literals(["available", "empty", "disabled", "unavailable"]),
});
export type ProviderSkillsResult = typeof ProviderSkillsResult.Type;
