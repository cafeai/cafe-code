import { compareSemverVersions, parseSemver } from "@cafecode/shared/semver";

/**
 * This floor qualifies non-destructive urgent delivery and its detached result
 * envelope together. The selected executable, not Cafe's imported SDK version,
 * owns these semantics. Unknown and prerelease runtimes remain unsupported.
 */
export function supportsClaudeTaskControls(version: string | null | undefined): boolean {
  if (!version || version.length > 64) return false;
  const parsed = parseSemver(version);
  return (
    parsed !== undefined &&
    parsed !== null &&
    parsed.prerelease.length === 0 &&
    compareSemverVersions(version, "2.1.287") >= 0
  );
}

/** Native IDs remain process-local and must never be reconstructed from labels. */
export function admittedClaudeControlIdentity(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= 8192 &&
    !/\p{Cc}/u.test(value)
    ? value
    : undefined;
}

export function isClaudeDetachedToolResult(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).detachedToolCall === true
  );
}
