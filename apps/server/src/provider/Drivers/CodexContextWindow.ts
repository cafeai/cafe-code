import { compareSemverVersions, parseSemver } from "@cafecode/shared/semver";

/**
 * This is a reviewed native configuration contract, not model entitlement.
 * Codex 0.162.1 (092d3acd6bec3e3a14bdc7e7a2810ab628ab759d) reloads baseline
 * configuration plus thread/start/resume overrides; omitting the key on a cold
 * resume restores inheritance. Older and prerelease binaries are unqualified.
 * Read only the already observed owning CLI version, never probe on Save.
 */
export function supportsCodexContextWindow(version: string | null | undefined): boolean {
  if (!version || version.length > 64) return false;
  const parsed = parseSemver(version);
  return (
    parsed !== null &&
    parsed !== undefined &&
    parsed.prerelease.length === 0 &&
    compareSemverVersions(version, "0.162.1") >= 0
  );
}
