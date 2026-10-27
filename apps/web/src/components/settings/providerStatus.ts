import { uiText } from "@cafecode/shared/i18n";
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
    return { headline: uiText("Checking…"), detail: null };
  }
  if (!provider.enabled) {
    // The card's switch already shows that it is off; no extra explanation.
    return { headline: uiText("Disabled"), detail: provider.message ?? null };
  }
  if (!provider.installed) {
    return {
      headline: uiText("Not found"),
      detail:
        provider.message ?? uiText("Install the CLI or set its binary path in Advanced settings."),
    };
  }
  // A protected startup failure says nothing about credentials or whether an
  // explicitly unsandboxed connection could work. Keep that distinction even
  // when a previous snapshot has already established authentication.
  if (provider.driver === "grok" && provider.sandbox?.status === "unavailable") {
    return {
      headline: uiText("Sandbox unavailable"),
      detail: provider.message ?? uiText("Grok could not start its protected connection check."),
    };
  }
  if (provider.auth.status === "authenticated") {
    const authLabel = provider.auth.label ?? provider.auth.type;
    return {
      headline: authLabel
        ? uiText("Authenticated · {authLabel}", { authLabel: authLabel })
        : uiText("Authenticated"),
      detail: provider.message ?? null,
    };
  }
  if (provider.auth.status === "unauthenticated") {
    return {
      headline: uiText("Not signed in"),
      detail: provider.message ?? null,
    };
  }
  if (provider.status === "warning") {
    return {
      headline: uiText("Needs attention"),
      detail: provider.message ?? uiText("Installed, but it couldn't be fully verified."),
    };
  }
  if (provider.status === "error") {
    return {
      headline: uiText("Unavailable"),
      detail: provider.message ?? uiText("It failed its startup checks."),
    };
  }
  // Installed and ready, but the provider did not report sign-in state.
  return { headline: uiText("Sign-in not verified"), detail: provider.message ?? null };
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
  options: {
    readonly oneClickAvailable?: boolean;
  } = {},
): {
  readonly detail: string;
  readonly updateCommand: string | null;
  readonly emphasis: "normal" | "strong";
  readonly canUpdate: boolean;
} | null {
  if (!advisory || advisory.status === "current" || advisory.status === "unknown") {
    return null;
  }

  const version = advisory.latestVersion;
  const versionLabel = getProviderVersionLabel(version);
  const canUpdate =
    advisory.canUpdate && advisory.updateCommand !== null && options.oneClickAvailable !== false;

  return {
    // The popover title already says "Update available"; don't repeat it.
    detail: !canUpdate
      ? uiText("Update this installation outside Cafe Code.")
      : (advisory.message ??
        (versionLabel
          ? uiText("Install {versionLabel}.", { versionLabel: versionLabel })
          : uiText("Install the latest version."))),
    updateCommand: advisory.updateCommand,
    emphasis: "normal" as const,
    canUpdate,
  };
}
