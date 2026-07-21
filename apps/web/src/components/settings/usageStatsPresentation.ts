import type { ProviderDriverKind, UsageStatsTokenBreakdownEntry } from "@cafecode/contracts";

export interface UsageModelBreakdownView {
  readonly model: string;
  readonly outputTokens: number;
}

export interface UsageProviderBreakdownView {
  readonly provider: ProviderDriverKind;
  readonly outputTokens: number;
  readonly models: ReadonlyArray<UsageModelBreakdownView>;
}

export interface UsageTokenBreakdownView {
  readonly providers: ReadonlyArray<UsageProviderBreakdownView>;
  readonly attributedOutputTokens: number;
  readonly unattributedOutputTokens: number;
}

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

/**
 * Collapse defensive duplicate rows and prepare a deterministic dense view.
 * The server normally returns one row per provider/model, but merging here
 * keeps stale or mixed-version servers from rendering duplicated model lines.
 */
export function buildUsageTokenBreakdownView(
  rows: ReadonlyArray<UsageStatsTokenBreakdownEntry>,
  lifetimeOutputTokens: number,
): UsageTokenBreakdownView {
  const byProvider = new Map<ProviderDriverKind, Map<string, number>>();

  for (const row of rows) {
    if (row.outputTokens <= 0) {
      continue;
    }
    let models = byProvider.get(row.provider);
    if (models === undefined) {
      models = new Map();
      byProvider.set(row.provider, models);
    }
    models.set(row.model, (models.get(row.model) ?? 0) + row.outputTokens);
  }

  const providers = Array.from(byProvider.entries(), ([provider, models]) => {
    const modelRows = Array.from(models.entries(), ([model, outputTokens]) => ({
      model,
      outputTokens,
    })).toSorted(
      (left, right) =>
        right.outputTokens - left.outputTokens || compareText(left.model, right.model),
    );
    return {
      provider,
      outputTokens: modelRows.reduce((sum, row) => sum + row.outputTokens, 0),
      models: modelRows,
    };
  }).toSorted(
    (left, right) =>
      right.outputTokens - left.outputTokens || compareText(left.provider, right.provider),
  );

  const attributedOutputTokens = providers.reduce(
    (sum, provider) => sum + provider.outputTokens,
    0,
  );

  return {
    providers,
    attributedOutputTokens,
    // Migration 61 intentionally did not guess provider/model attribution for
    // older aggregate rows. Surface that honest remainder instead of silently
    // making the visible provider totals appear to equal lifetime usage.
    unattributedOutputTokens: Math.max(0, lifetimeOutputTokens - attributedOutputTokens),
  };
}

export function formatUsageProviderLabel(provider: ProviderDriverKind): string {
  switch (provider) {
    case "codex":
      return "Codex";
    case "claudeAgent":
      return "Claude";
    case "opencode":
      return "OpenCode";
    default:
      return provider
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/[_-]+/g, " ")
        .trim()
        .replace(/\b\w/g, (character) => character.toUpperCase());
  }
}

export function formatUsageModelLabel(model: string): string {
  return model === "unknown" ? "Unknown model" : model;
}

export function formatUsagePercentage(part: number, whole: number): string {
  if (part <= 0 || whole <= 0) {
    return "0%";
  }
  const percentage = Math.min(100, (part / whole) * 100);
  if (percentage < 0.1) {
    return "<0.1%";
  }
  return percentage < 10 ? `${percentage.toFixed(1)}%` : `${Math.round(percentage)}%`;
}
