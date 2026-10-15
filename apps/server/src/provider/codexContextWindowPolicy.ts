import { validCodexContextWindowOverride, type ProviderSession } from "@cafecode/contracts";

/**
 * Admit only an own scalar configuration field. Provider configuration crosses
 * an opaque record boundary; inherited values and accessors must not silently
 * supply policy or execute while resolving a turn's saved intent. Native
 * opening evidence remains a separate provider-owned observation.
 */
export function readCodexAutoCompactTokenLimit(config: unknown): number | undefined {
  if (config === null || typeof config !== "object" || Array.isArray(config)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(config, "autoCompactTokenLimit");
  return descriptor !== undefined &&
    Object.hasOwn(descriptor, "value") &&
    typeof descriptor.value === "number" &&
    validCodexContextWindowOverride(descriptor.value)
    ? descriptor.value
    : undefined;
}

/**
 * Resolve current intent only for its exact selected Codex account. A null chat
 * override is Reset and follows that account's live default rather than copying
 * a number into thread metadata. No setting implies a native numeric capacity.
 */
export function resolveCodexContextWindowPolicy(input: {
  readonly driver: string;
  readonly chatOverride?: number | null | undefined;
  readonly accountDefault?: unknown;
  readonly accountAutoCompactTokenLimit?: unknown;
}): {
  readonly requested: number | undefined;
  readonly configured: number | null;
  readonly configuredAutoCompactTokenLimit: number | null;
} {
  const requested =
    input.driver !== "codex"
      ? undefined
      : typeof input.chatOverride === "number" &&
          validCodexContextWindowOverride(input.chatOverride)
        ? input.chatOverride
        : typeof input.accountDefault === "number" &&
            validCodexContextWindowOverride(input.accountDefault)
          ? input.accountDefault
          : undefined;
  // A saved context number alone cannot establish that the current native
  // thread received its companion compaction request. Resolve the selected
  // account's explicit compaction choice separately; it wins over pairing.
  // This is nominal request provenance, never the provider's resolved trigger.
  const explicitAutoCompactTokenLimit =
    input.driver === "codex" &&
    typeof input.accountAutoCompactTokenLimit === "number" &&
    validCodexContextWindowOverride(input.accountAutoCompactTokenLimit)
      ? input.accountAutoCompactTokenLimit
      : undefined;
  return {
    requested,
    configured: requested ?? null,
    configuredAutoCompactTokenLimit: explicitAutoCompactTokenLimit ?? requested ?? null,
  };
}

/** Unknown legacy configuration never causes an unsolicited inherited reset. */
export function hasCodexContextWindowChange(
  session: ProviderSession,
  policy: ReturnType<typeof resolveCodexContextWindowPolicy>,
): boolean {
  const contextChanged =
    (session.codexContextWindowOverride !== undefined || policy.requested !== undefined) &&
    session.codexContextWindowOverride !== policy.configured;
  // Older sessions may already record the identical context number while
  // retaining the former smaller native compaction setting. Missing evidence
  // plus explicit numeric context intent must therefore reconcile at the same
  // guarded idle boundary as an ordinary context change. Explicit account
  // compaction alone predates context pairing: without current/former numeric
  // context intent, preserve that policy's existing startup/configuration path
  // rather than silently migrating a legacy process or requiring a new owner.
  const hasPairedContextIntent =
    policy.requested !== undefined || typeof session.codexContextWindowOverride === "number";
  const compactionChanged =
    hasPairedContextIntent &&
    (session.codexAutoCompactTokenLimit !== undefined ||
      policy.configuredAutoCompactTokenLimit !== null) &&
    session.codexAutoCompactTokenLimit !== policy.configuredAutoCompactTokenLimit;
  return contextChanged || compactionChanged;
}
