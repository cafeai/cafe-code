import type { EnvironmentId } from "@cafecode/contracts";
import { ensureEnvironmentApi } from "../environmentApi";

/** The optional namespace preserves read compatibility with older backends and
 * fixtures. A missing capability must never fall back to ordinary sendMessage:
 * that would lose scheduling consent, deduplication, and idle-only admission. */
export function ensureScheduledFollowupsApi(environmentId: EnvironmentId) {
  const api = ensureEnvironmentApi(environmentId).scheduledFollowups;
  if (!api) throw new Error("Scheduled follow-ups are unavailable on this backend.");
  return api;
}
