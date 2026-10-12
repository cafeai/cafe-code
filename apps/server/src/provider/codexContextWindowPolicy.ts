import { validCodexContextWindowOverride, type ProviderSession } from "@cafecode/contracts";

/**
 * Resolve current intent only for its exact selected Codex account. A null chat
 * override is Reset and follows that account's live default rather than copying
 * a number into thread metadata. No setting implies a native numeric capacity.
 */
export function resolveCodexContextWindowPolicy(input: {
  readonly driver: string;
  readonly chatOverride?: number | null | undefined;
  readonly accountDefault?: unknown;
}): { readonly requested: number | undefined; readonly configured: number | null } {
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
  return { requested, configured: requested ?? null };
}

/** Unknown legacy configuration never causes an unsolicited inherited reset. */
export function hasCodexContextWindowChange(
  session: ProviderSession,
  policy: ReturnType<typeof resolveCodexContextWindowPolicy>,
): boolean {
  return (
    (session.codexContextWindowOverride !== undefined || policy.requested !== undefined) &&
    session.codexContextWindowOverride !== policy.configured
  );
}
