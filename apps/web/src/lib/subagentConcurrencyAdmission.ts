import { uiText } from "@cafecode/shared/i18n";
import type {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  SubagentLimits,
  ServerSettings,
  ModelSelection,
  RuntimeMode,
  ThreadId,
} from "@cafecode/contracts";
import type { Thread } from "../types";

import {
  effectiveSubagentLimit,
  inheritedInstanceSubagentPolicy,
  subagentLimitKey,
} from "../subagentConcurrency";

export const UNSUPPORTED_SUBAGENT_LIMIT_MESSAGE =
  "This provider runtime does not support the saved subagent limit. Reset it in More composer controls before sending.";
export function getUNSUPPORTED_SUBAGENT_LIMIT_MESSAGE() {
  return uiText(
    "This provider runtime does not support the saved subagent limit. Reset it in More composer controls before sending.",
  );
}

export const UNSUPPORTED_ACCOUNT_SUBAGENT_LIMIT_MESSAGE =
  "This provider runtime does not support the account subagent limit. Clear it in account settings or use a supported runtime before sending.";
export function getUNSUPPORTED_ACCOUNT_SUBAGENT_LIMIT_MESSAGE() {
  return uiText(
    "This provider runtime does not support the account subagent limit. Clear it in account settings or use a supported runtime before sending.",
  );
}

export const UNRECORDED_STEER_SUBAGENT_OWNER_MESSAGE =
  "Wait for a safe idle turn before sending with this subagent limit. The active session’s account is not recorded.";
export function getUNRECORDED_STEER_SUBAGENT_OWNER_MESSAGE() {
  return uiText(
    "Wait for a safe idle turn before sending with this subagent limit. The active session’s account is not recorded.",
  );
}

/** Only the selected account's owning server can attest native support.
 * The fleet's continuation flag advertises Cafe implementation availability,
 * not a direct observation of an adopted daemon's capabilities. This advisory
 * check never turns a stored numeric limit into support for a fresh launch;
 * the server separately qualifies the authenticated owner and exact runtime.
 */
export function subagentConcurrencyAdmissionError(input: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly provider: ProviderDriverKind;
  readonly limits: SubagentLimits | undefined;
  /** Steer cannot borrow an unsent account's capability for a legacy session. */
  readonly hasRecordedSessionOwner?: boolean;
  readonly continuation?: {
    readonly threadId: ThreadId;
    readonly modelSelection: ModelSelection;
    readonly runtimeMode: RuntimeMode;
    readonly thread:
      | Pick<
          Thread,
          "id" | "environmentId" | "session" | "modelSelection" | "runtimeMode" | "archivedAt"
        >
      | undefined;
  };
  readonly configuration:
    | {
        readonly environment: { readonly environmentId: EnvironmentId };
        readonly settings?: ServerSettings;
        readonly providers: ReadonlyArray<{
          readonly instanceId: ProviderInstanceId;
          readonly driver: ProviderDriverKind;
          readonly runtimeCapabilities?:
            | {
                readonly subagentConcurrency?: boolean | undefined;
                readonly subagentPolicyContinuation?: boolean | undefined;
              }
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
  if (input.hasRecordedSessionOwner === false) return getUNRECORDED_STEER_SUBAGENT_OWNER_MESSAGE();
  const account =
    configuration?.environment.environmentId === input.environmentId
      ? configuration.providers.find(
          (provider) =>
            provider.instanceId === input.instanceId && provider.driver === input.provider,
        )
      : undefined;
  const continuation = input.continuation;
  const thread = continuation?.thread;
  const session = thread?.session;
  const savedOptions = thread?.modelSelection.options ?? [];
  const requestedOptions = continuation?.modelSelection.options ?? [];
  // Require current exact thread/account/runtime evidence and unchanged local
  // startup intent. Missing advisory capability on an older backend remains
  // closed. An adopted older daemon is checked separately by the backend at
  // delivery: this fleet snapshot advertises backend availability, not proof
  // of the actual daemon's no-recovery/native-lifecycle guarantee. The
  // observed thread is re-read after asynchronous preparation, not captured
  // from a picker or another tab. Projection evidence is not native authority;
  // backend admission separately rejects every replacement/recovery race.
  const sameMaterializedContinuation =
    input.provider === "codex" &&
    account?.runtimeCapabilities?.subagentPolicyContinuation === true &&
    continuation !== undefined &&
    thread?.id === continuation.threadId &&
    thread.environmentId === input.environmentId &&
    thread.archivedAt === null &&
    thread.runtimeMode === continuation.runtimeMode &&
    continuation.modelSelection.instanceId === input.instanceId &&
    thread.modelSelection.instanceId === input.instanceId &&
    thread.modelSelection.model === continuation.modelSelection.model &&
    savedOptions.length === requestedOptions.length &&
    savedOptions.every(
      (option, index) =>
        option.id === requestedOptions[index]?.id &&
        option.value === requestedOptions[index]?.value,
    ) &&
    session?.provider === input.provider &&
    session.providerInstanceId === input.instanceId &&
    typeof session.subagentRuntimeId === "string" &&
    session.subagentRuntimeId.length > 0 &&
    (session.status === "ready" || session.status === "running") &&
    (session.orchestrationStatus === "ready" || session.orchestrationStatus === "running") &&
    Number.isInteger(numeric) &&
    numeric >= 1 &&
    numeric <= 64 &&
    session.maxConcurrentSubagents === numeric;
  // Older servers can discard additive command fields. Refuse before uploads,
  // optimistic messages, queue claims, or RPC dispatch rather than silently
  // losing the user's numeric execution policy. Never strip remembered intent.
  return account?.runtimeCapabilities?.subagentConcurrency === true || sameMaterializedContinuation
    ? null
    : key !== null && input.limits?.[key] !== undefined
      ? getUNSUPPORTED_SUBAGENT_LIMIT_MESSAGE()
      : getUNSUPPORTED_ACCOUNT_SUBAGENT_LIMIT_MESSAGE();
}
