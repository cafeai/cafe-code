import type { ServerProvider, ServerProviderVersionAdvisory } from "@cafecode/contracts";

/**
 * Visual treatment for each server-reported provider status. Centralized so
 * the default-driver card and per-instance cards share the same language.
 */
export const PROVIDER_STATUS_STYLES = {
  // Not yet reported by the server: a neutral pulse, never a warning colour.
  checking: {
    dot: "bg-status-idle animate-pulse",
  },
  disabled: {
    dot: "bg-status-idle",
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
    return { headline: "Checking…", detail: null };
  }
  if (!provider.enabled) {
    // The card's switch already shows that it is off; no extra explanation.
    return { headline: "Disabled", detail: provider.message ?? null };
  }
  if (!provider.installed) {
    return {
      headline: "Not found",
      detail: provider.message ?? "Install the CLI or set its binary path in Advanced settings.",
    };
  }
  // A protected startup failure says nothing about credentials or whether an
  // explicitly unsandboxed connection could work. Keep that distinction even
  // when a previous snapshot has already established authentication.
  if (provider.driver === "grok" && provider.sandbox?.status === "unavailable") {
    return {
      headline: "Sandbox unavailable",
      detail: provider.message ?? "Grok could not start its protected connection check.",
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
      headline: "Not signed in",
      detail: provider.message ?? null,
    };
  }
  if (provider.status === "warning") {
    return {
      headline: "Needs attention",
      detail: provider.message ?? "Installed, but it couldn't be fully verified.",
    };
  }
  if (provider.status === "error") {
    return {
      headline: "Unavailable",
      detail: provider.message ?? "It failed its startup checks.",
    };
  }
  // Installed and ready, but the provider did not report sign-in state.
  return { headline: "Sign-in not verified", detail: provider.message ?? null };
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
  readonly detail: string;
  readonly updateCommand: string | null;
  readonly emphasis: "normal" | "strong";
} | null {
  if (!advisory || advisory.status === "current" || advisory.status === "unknown") {
    return null;
  }

  const version = advisory.latestVersion;
  const versionLabel = getProviderVersionLabel(version);

  return {
    // The popover title already says "Update available"; don't repeat it.
    detail:
      advisory.message ??
      (versionLabel ? `Install ${versionLabel}.` : "Install the latest version."),
    updateCommand: advisory.updateCommand,
    emphasis: "normal" as const,
  };
}
