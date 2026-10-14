import type {
  CodexContextWindowOverride,
  MaxConcurrentSubagents,
  ProviderInstanceId,
  ThreadId,
} from "@cafecode/contracts";

interface SessionLimitIdentity {
  readonly threadId: ThreadId;
  readonly providerName: string | null;
  readonly providerInstanceId?: ProviderInstanceId | null | undefined;
  readonly maxConcurrentSubagents?: MaxConcurrentSubagents | null | undefined;
  readonly codexContextWindowOverride?: CodexContextWindowOverride | null | undefined;
  readonly codexAutoCompactTokenLimit?: CodexContextWindowOverride | null | undefined;
  readonly subagentRuntimeId?: string | null | undefined;
}

/**
 * Old lifecycle producers omit this additive field. Preserve known configured
 * evidence only for the same authenticated chat/account binding; never borrow
 * a prior account's limit. An explicit null is authoritative no-override evidence.
 * This does not resolve defaults or grant permission to replace a live process.
 */
export function materializedSubagentLimitFields(
  incoming: SessionLimitIdentity,
  previous?: SessionLimitIdentity | null,
): {
  readonly maxConcurrentSubagents?: MaxConcurrentSubagents | null;
  readonly codexContextWindowOverride?: CodexContextWindowOverride | null;
  readonly codexAutoCompactTokenLimit?: CodexContextWindowOverride | null;
  readonly subagentRuntimeId?: string | null;
} {
  // Ordinary parent lifecycle updates must retain the exact native context.
  // Only an incoming provider-owned generation may replace it; never borrow
  // an old account's context during an account/provider switch.
  const sameBinding =
    previous != null &&
    incoming.threadId === previous.threadId &&
    incoming.providerName === previous.providerName &&
    incoming.providerInstanceId != null &&
    incoming.providerInstanceId === previous.providerInstanceId;
  const runtimeId =
    incoming.subagentRuntimeId !== undefined
      ? incoming.subagentRuntimeId
      : sameBinding
        ? previous.subagentRuntimeId
        : undefined;
  // Requested metadata is not process evidence. Carry the context override
  // only from an incoming exact observation or this same authenticated binding.
  // An explicit null clears a prior numeric fallback; absence remains unknown.
  // Null/absent are the same legacy unknown generation representation; their
  // normalization is not proof of retirement or native ownership. Preserve
  // recorded configuration only, never idle/adoption/continuation authority.
  // A known generation -> null or a different generation cannot borrow the
  // former runtime's configuration on an omitted lifecycle field. Omitted
  // incoming generations remain compatible with ordinary lifecycle producers.
  const sameContextBinding =
    sameBinding &&
    (incoming.subagentRuntimeId === undefined ||
      (incoming.subagentRuntimeId ?? null) === (previous.subagentRuntimeId ?? null));
  const contextOverride =
    incoming.codexContextWindowOverride !== undefined
      ? incoming.codexContextWindowOverride
      : sameContextBinding
        ? previous.codexContextWindowOverride
        : undefined;
  const runtimeFields = {
    ...(runtimeId === undefined ? {} : { subagentRuntimeId: runtimeId }),
    ...(contextOverride === undefined ? {} : { codexContextWindowOverride: contextOverride }),
    // Request proof is stricter than historical configured context: a real
    // native generation is mandatory. Complete generation observations omit
    // proof to explicitly retire an unknown legacy runtime's former evidence,
    // even when its generation spelling is unchanged. Ordinary partial
    // lifecycle producers can preserve it only by omitting generation; those
    // that explicitly carry a generation must also report its received proof.
    // Never synthesize this value from the neighboring context number.
    ...(incoming.providerName === "codex" &&
    typeof runtimeId === "string" &&
    runtimeId.length > 0 &&
    incoming.codexAutoCompactTokenLimit !== undefined
      ? { codexAutoCompactTokenLimit: incoming.codexAutoCompactTokenLimit }
      : sameBinding &&
          incoming.providerName === "codex" &&
          incoming.subagentRuntimeId === undefined &&
          typeof previous.subagentRuntimeId === "string" &&
          previous.subagentRuntimeId.length > 0 &&
          previous.codexAutoCompactTokenLimit !== undefined
        ? { codexAutoCompactTokenLimit: previous.codexAutoCompactTokenLimit }
        : {}),
  };
  if (incoming.maxConcurrentSubagents !== undefined) {
    return { ...runtimeFields, maxConcurrentSubagents: incoming.maxConcurrentSubagents };
  }
  if (previous != null && sameContextBinding && previous.maxConcurrentSubagents !== undefined) {
    // An exact replacement generation is a new opening observation. Omitted
    // policy there is unknown, not proof borrowed from the retired process.
    return { ...runtimeFields, maxConcurrentSubagents: previous.maxConcurrentSubagents };
  }
  return runtimeFields;
}
