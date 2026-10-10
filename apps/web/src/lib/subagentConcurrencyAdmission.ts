import type {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  SubagentLimits,
  ServerSettings,
} from "@cafecode/contracts";

import {
  effectiveSubagentLimit,
  inheritedInstanceSubagentPolicy,
  subagentLimitKey,
} from "../subagentConcurrency";

export const UNSUPPORTED_SUBAGENT_LIMIT_MESSAGE =
  "This provider runtime does not support the saved subagent limit. Reset it in More composer controls before sending.";

export const UNSUPPORTED_ACCOUNT_SUBAGENT_LIMIT_MESSAGE =
  "This provider runtime does not support the account subagent limit. Clear it in account settings or use a supported runtime before sending.";

export const UNRECORDED_STEER_SUBAGENT_OWNER_MESSAGE =
  "Wait for a safe idle turn before sending with this subagent limit. The active session’s account is not recorded.";

/** Only the selected account's owning server can attest native support. */
export function subagentConcurrencyAdmissionError(input: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly provider: ProviderDriverKind;
  readonly limits: SubagentLimits | undefined;
  /** Steer cannot borrow an unsent account's capability for a legacy session. */
  readonly hasRecordedSessionOwner?: boolean;
  readonly configuration:
    | {
        readonly environment: { readonly environmentId: EnvironmentId };
        readonly settings?: ServerSettings;
        readonly providers: ReadonlyArray<{
          readonly instanceId: ProviderInstanceId;
          readonly driver: ProviderDriverKind;
          readonly runtimeCapabilities?:
            | { readonly subagentConcurrency?: boolean | undefined }
            | undefined;
        }>;
      }
    | null
    | undefined;
}): string | null {
  const key = subagentLimitKey(input.provider);
  const configuration = input.configuration;
  // Resolve live settings only from the same owning environment. A reset
  // removes chat intent, not the account's still-numeric inherited policy.
  const settings =
    configuration?.environment.environmentId === input.environmentId
      ? configuration.settings
      : undefined;
  const inherited = settings
    ? inheritedInstanceSubagentPolicy(settings, input.instanceId, input.provider)
    : undefined;
  // Legacy runtime configuration keeps its already-established startup policy.
  // Only explicit chat intent or the new live account preference is an additive
  // turn request requiring capability admission on older servers.
  const override = key === null ? undefined : input.limits?.[key];
  const numericIntent = override !== undefined || inherited?.source === "Account default";
  const numeric =
    numericIntent && settings
      ? effectiveSubagentLimit({
          settings,
          instanceId: input.instanceId,
          provider: input.provider,
          limits: input.limits,
        })
      : override;
  if (numeric === undefined) return null;
  // Legacy snapshots can omit the running process's owning account. Numeric
  // policy must not turn a canonical/unsent picker fallback into proof of that
  // process's capability. This flag is used only by native steer; ordinary
  // turns bind their selected account directly, and nonnumeric legacy behavior
  // remains unchanged.
  if (input.hasRecordedSessionOwner === false) return UNRECORDED_STEER_SUBAGENT_OWNER_MESSAGE;
  const account =
    configuration?.environment.environmentId === input.environmentId
      ? configuration.providers.find(
          (provider) =>
            provider.instanceId === input.instanceId && provider.driver === input.provider,
        )
      : undefined;
  // Older servers can discard additive command fields. Refuse before uploads,
  // optimistic messages, queue claims, or RPC dispatch rather than silently
  // losing the user's numeric execution policy. Never strip remembered intent.
  return account?.runtimeCapabilities?.subagentConcurrency === true
    ? null
    : key !== null && input.limits?.[key] !== undefined
      ? UNSUPPORTED_SUBAGENT_LIMIT_MESSAGE
      : UNSUPPORTED_ACCOUNT_SUBAGENT_LIMIT_MESSAGE;
}
