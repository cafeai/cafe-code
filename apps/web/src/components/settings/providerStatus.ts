import type { ServerProvider, ServerProviderVersionAdvisory } from "@cafecode/contracts";
import { compareSemverVersions } from "@cafecode/shared/semver";

/**
 * Visual treatment for each server-reported provider status. Centralized so
 * the default-driver card and per-instance cards share the same language.
 */
export const PROVIDER_STATUS_STYLES = {
  disabled: {
    dot: "bg-amber-400",
  },
  error: {
    dot: "bg-destructive",
  },
  ready: {
    dot: "bg-success",
  },
  warning: {
    dot: "bg-warning",
  },
} as const;

export type ProviderStatusKey = keyof typeof PROVIDER_STATUS_STYLES;

/**
 * Derive the headline + detail copy shown under a provider's name in the
 * settings page. Prefers `provider.message` for server-supplied detail and
 * falls back to generic phrasing when the server has not yet reported any
 * state — which happens before the first probe or when an instance names a
 * driver this build does not ship.
 */
export function getProviderSummary(provider: ServerProvider | undefined) {
  if (!provider) {
    return {
      headline: "Checking provider status",
      detail: "Waiting for the server to report installation and authentication details.",
    };
  }
  if (!provider.enabled) {
    return {
      headline: "Disabled",
      detail:
        provider.message ??
        "This provider is installed but disabled for new sessions in Cafe Code.",
    };
  }
  if (!provider.installed) {
    return {
      headline: "Not found",
      detail: provider.message ?? "CLI not detected on PATH.",
    };
  }
  if (provider.auth.status === "authenticated") {
    const authLabel = provider.auth.label ?? provider.auth.type;
    return {
      headline: authLabel ? `Authenticated · ${authLabel}` : "Authenticated",
      detail: provider.message ?? null,
    };
  }
  if (provider.auth.status === "unauthenticated") {
    return {
      headline: "Not authenticated",
      detail: provider.message ?? null,
    };
  }
  if (provider.status === "warning") {
    return {
      headline: "Needs attention",
      detail:
        provider.message ?? "The provider is installed, but the server could not fully verify it.",
    };
  }
  if (provider.status === "error") {
    return {
      headline: "Unavailable",
      detail: provider.message ?? "The provider failed its startup checks.",
    };
  }
  return {
    headline: "Available",
    detail: provider.message ?? "Installed and ready, but authentication could not be verified.",
  };
}

/**
 * Normalize a version string for display. Adds the `v` prefix when the
 * driver reported a bare version (e.g. `1.2.3`) so cards render
 * consistently regardless of driver.
 */
export function getProviderVersionLabel(version: string | null | undefined) {
  if (!version) return null;
  return version.startsWith("v") ? version : `v${version}`;
}

export function getProviderVersionAdvisoryPresentation(
  advisory: ServerProviderVersionAdvisory | undefined,
): {
  readonly title: string;
  readonly detail: string;
  readonly updateCommand: string | null;
  readonly actionable: boolean;
  readonly emphasis: "normal" | "strong";
} | null {
  if (!advisory || advisory.status === "current" || advisory.status === "unknown") {
    return null;
  }

  const current = advisory.currentVersion?.split("+", 1)[0] ?? null;
  const approved = advisory.approvedVersion?.split("+", 1)[0] ?? null;
  const isOffApprovedPin =
    current !== null && approved !== null && compareSemverVersions(current, approved) !== 0;
  const isAwaitingConformity =
    !isOffApprovedPin &&
    approved !== null &&
    advisory.latestVersion !== null &&
    compareSemverVersions(advisory.latestVersion.split("+", 1)[0] ?? "", approved) > 0;
  const label = isOffApprovedPin
    ? "Conformity required"
    : isAwaitingConformity
      ? "Awaiting conformity"
      : "Update available";
  const version = isOffApprovedPin ? advisory.approvedVersion : advisory.latestVersion;
  const versionLabel = getProviderVersionLabel(version);

  return {
    title: label,
    detail:
      advisory.message ??
      (isAwaitingConformity
        ? versionLabel
          ? `${label}: ${versionLabel}.`
          : `${label}.`
        : versionLabel
          ? `${label}: install ${versionLabel}.`
          : `${label}: install the latest provider version.`),
    updateCommand: advisory.updateCommand,
    actionable: advisory.canUpdate && advisory.updateCommand !== null,
    emphasis: "normal" as const,
  };
}
