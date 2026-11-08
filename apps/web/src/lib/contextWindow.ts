import type { OrchestrationThreadActivity } from "@cafecode/contracts";
import { uiText } from "@cafecode/shared/i18n";
import {
  deriveLatestContextWindowUsage,
  type ThreadContextWindowObservation,
} from "@cafecode/shared/threadResourceUsage";

import { deriveGenerationRate, type GenerationRate } from "./generationRate";

type OptionalContextMetadata =
  | "maxTokens"
  | "totalProcessedTokens"
  | "compactsAutomatically"
  | "autoCompactTokenLimit";

/** Keep the renderer's existing sparse snapshot input contract. The shared
 * derivation returns explicit nulls for absent metadata, but callers and
 * historical fixtures may still omit these optional native observations. */
export type ContextWindowSnapshot = Omit<ThreadContextWindowObservation, OptionalContextMetadata> &
  Partial<Pick<ThreadContextWindowObservation, OptionalContextMetadata>> & {
    /** Chat-wide average of the most recent measured decoding, when reported. */
    readonly generationRate?: GenerationRate | null;
  };

export function deriveLatestContextWindowSnapshot(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ContextWindowSnapshot | null {
  const usage = deriveLatestContextWindowUsage(activities);
  if (!usage) return null;
  return {
    ...usage,
    // Keep the renderer's existing presentation default. Shared/MCP data keeps
    // absent native compaction policy explicitly unknown instead of minting it.
    compactsAutomatically: usage.compactsAutomatically ?? false,
    generationRate: deriveGenerationRate(activities),
  };
}

export function formatContextWindowTokens(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "0";
  }
  if (value < 1_000) {
    return `${Math.round(value)}`;
  }
  if (value < 10_000) {
    return uiText("{value}k", { value: (value / 1_000).toFixed(1).replace(/\.0$/, "") });
  }
  if (value < 1_000_000) {
    return uiText("{value}k", { value: Math.round(value / 1_000) });
  }
  return uiText(
    "{value}m",
    { value: (value / 1_000_000).toFixed(1).replace(/\.0$/, "") },
    "compact-token-count",
  );
}
