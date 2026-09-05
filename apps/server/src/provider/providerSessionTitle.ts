import { PROVIDER_SESSION_TITLE_MAX_CHARS } from "@cafecode/contracts";

/**
 * Reuse Cafe's existing label without sending a prompt to name the same task
 * again. Bound work before normalization because historical/user-entered Cafe
 * titles are not length-limited. A fixed fallback also covers recovery paths
 * that have only a provider cursor and no projected Cafe title available.
 *
 * Native labels can appear in terminal pickers, so strip control/formatting
 * characters and collapse whitespace. Keep this display metadata separate
 * from the original user prompt and from diagnostic logging.
 */
export function makeProviderSessionTitle(title: string | undefined): string {
  return (
    title
      ?.slice(0, PROVIDER_SESSION_TITLE_MAX_CHARS)
      .replace(/[\p{Cc}\p{Cf}\s]+/gu, " ")
      .toWellFormed()
      .trim() || "Cafe Code task"
  );
}
