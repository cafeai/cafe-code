import * as Schema from "effect/Schema";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { ProviderInteractionMode, RuntimeMode } from "./orchestration.ts";

// These are inert, authenticated transcript labels, not provider configuration.
// Reject control/bidi characters rather than letting a label impersonate a
// second work-log line. The finite bounds also protect persisted activity rows.
const SingleLineLabel = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(200),
  Schema.isPattern(/^[^\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]+$/u),
  // Validate raw bytes before any trimming: an edge newline or a huge padded
  // input must not evade the line/size boundary through normalization.
  Schema.isPattern(/^\S(?:[\s\S]*\S)?$/u),
);
const EffortLabel = SingleLineLabel.check(Schema.isMaxLength(80));

/**
 * Frozen submission/session settings for one accepted provider turn.
 *
 * `submitted` describes what Cafe sent, not an entitlement or billing receipt.
 * `session` describes admitted same-account session model settings inherited
 * when no new selection/mode is submitted. An explicit mode change remains
 * `submitted` even if its model options are inherited from that session.
 * Steering retains the original start snapshot rather than publishing anew.
 * Missing effort/Fast delegates to the provider. resolvedServiceTier records
 * native Codex routing at start when known, independently of submitted options.
 * No credentials, auth identifiers, paths or arbitrary model
 * option maps belong in this deliberately narrow public envelope.
 */
export const ProviderTurnConfiguration = Schema.Struct({
  version: Schema.Literal(1),
  provider: ProviderDriverKind,
  providerInstanceId: ProviderInstanceId,
  providerDisplayName: SingleLineLabel,
  model: Schema.optional(SingleLineLabel),
  modelDisplayName: Schema.optional(SingleLineLabel),
  effort: Schema.optional(EffortLabel),
  fastMode: Schema.optional(Schema.Boolean),
  serviceTier: Schema.optional(EffortLabel),
  resolvedServiceTier: Schema.optional(
    Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_-]{0,63}$/)),
  ),
  runtimeMode: RuntimeMode,
  interactionMode: Schema.optional(ProviderInteractionMode),
  settingsSource: Schema.Literals(["submitted", "session"]),
});
export type ProviderTurnConfiguration = typeof ProviderTurnConfiguration.Type;
