import { MAX_CONCURRENT_SUBAGENTS } from "@cafecode/contracts";
import { compareSemverVersions, parseSemver } from "@cafecode/shared/semver";

/**
 * This capability describes the configured CLI, not a model family or the SDK
 * package bundled with Cafe. Unknown/pre-release versions fail closed. The
 * Codex floor is the qualified public-key/V2-precedence audit, deliberately not
 * a claim that every older version implements the same launch contract.
 */
export function supportsSubagentConcurrency(
  driver: "codex" | "claudeAgent",
  version: string | null | undefined,
): boolean {
  if (!version || version.length > 64) return false;
  const parsed = parseSemver(version);
  if (!parsed || parsed.prerelease.length > 0) return false;
  return compareSemverVersions(version, driver === "codex" ? "0.159.0" : "2.1.217") >= 0;
}

/** Resolve only Cafe's process override; native config/env is intentionally opaque. */
export function resolveConfiguredSubagentLimit(
  requested: number | null | undefined,
  instance: number | undefined,
): number | null {
  const limit = requested ?? instance ?? null;
  if (
    limit !== null &&
    (!Number.isInteger(limit) || limit < 1 || limit > MAX_CONCURRENT_SUBAGENTS)
  ) {
    throw new RangeError("Subagent concurrency must be an integer between 1 and 64.");
  }
  return limit;
}
