/**
 * Normalize the provider-authored agent path used by Codex multi-agent events.
 *
 * Codex models its primary conversation as the reserved `/root` node and real
 * children below it (`/root/audit`, for example). A child interacting back with
 * its parent therefore produces an exact `/root` target. Keeping this tiny
 * protocol rule shared prevents event routing and UI lifecycle mapping from
 * drifting apart again.
 */
export function normalizeCodexAgentPath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/\/+$/u, "");
  return normalized.length > 0 ? normalized : undefined;
}

/** Exact-match only: `/root/name` is a genuine child and must remain visible. */
export function isCodexRootAgentPath(value: unknown): boolean {
  return normalizeCodexAgentPath(value) === "/root";
}
