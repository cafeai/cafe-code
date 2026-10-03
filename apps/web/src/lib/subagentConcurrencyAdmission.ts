import type {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  SubagentLimits,
} from "@cafecode/contracts";

import { subagentLimitKey } from "../subagentConcurrency";

export const UNSUPPORTED_SUBAGENT_LIMIT_MESSAGE =
  "This provider runtime does not support the saved subagent limit. Reset it in More composer controls before sending.";

/** Only the selected account's owning server can attest native support. */
export function subagentConcurrencyAdmissionError(input: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly provider: ProviderDriverKind;
  readonly limits: SubagentLimits | undefined;
  readonly configuration:
    | {
        readonly environment: { readonly environmentId: EnvironmentId };
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
  // Reset/omission and another driver's remembered preference do not request
  // numeric native enforcement. They must remain usable on older runtimes.
  if (key === null || input.limits?.[key] === undefined) return null;
  const configuration = input.configuration;
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
    : UNSUPPORTED_SUBAGENT_LIMIT_MESSAGE;
}
