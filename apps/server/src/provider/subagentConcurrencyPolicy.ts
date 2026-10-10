import {
  MaxConcurrentSubagents,
  type ProviderSession,
  type SubagentLimits,
} from "@cafecode/contracts";
import * as Schema from "effect/Schema";

/**
 * Limits are execution policy, not a model trait. Only these qualified native
 * drivers consume the setting, and the Claude UI family intentionally differs
 * from its historical `claudeAgent` runtime slug.
 */
export function resolveSubagentConcurrencyPolicy(input: {
  readonly driver: string;
  readonly limits?: SubagentLimits;
  readonly instanceDefaultMaxConcurrentSubagents?: unknown;
  readonly instanceConfig?: unknown;
}): { readonly requested: number | undefined; readonly configured: number | null } {
  const override =
    input.driver === "codex"
      ? input.limits?.codex
      : input.driver === "claudeAgent"
        ? input.limits?.claude
        : undefined;
  const config = input.instanceConfig;
  const supportedDriver = input.driver === "codex" || input.driver === "claudeAgent";
  // The account preference is live inherited intent, not a value to copy into
  // this chat's durable override map. Keep it distinct from legacy native
  // configuration: an explicit account preference must trigger qualified
  // capability admission and safe materialization even for an old session
  // whose process policy was never recorded. Malformed values cannot become
  // native argv/environment values if this helper receives untrusted input.
  const accountDefault =
    supportedDriver &&
    Schema.is(MaxConcurrentSubagents)(input.instanceDefaultMaxConcurrentSubagents)
      ? input.instanceDefaultMaxConcurrentSubagents
      : undefined;
  const requested = override ?? accountDefault;
  const legacy =
    supportedDriver &&
    config !== null &&
    typeof config === "object" &&
    !Array.isArray(config) &&
    "maxConcurrentSubagents" in config &&
    Schema.is(MaxConcurrentSubagents)(config.maxConcurrentSubagents)
      ? config.maxConcurrentSubagents
      : undefined;
  return { requested, configured: requested ?? legacy ?? null };
}

/** Unknown legacy evidence must not cause an unsolicited session replacement. */
export function hasSubagentConcurrencyChange(
  session: ProviderSession,
  policy: ReturnType<typeof resolveSubagentConcurrencyPolicy>,
): boolean {
  return (
    (session.maxConcurrentSubagents !== undefined || policy.requested !== undefined) &&
    session.maxConcurrentSubagents !== policy.configured
  );
}

/**
 * This is an early non-destructive filter only. Native final admission still
 * checks the whole tree under its lifecycle lock before retiring a process.
 */
export function hasActiveSubagentSessionWork(session: ProviderSession): boolean {
  return (
    session.status === "running" ||
    session.status === "connecting" ||
    session.activeTurnId !== undefined
  );
}
