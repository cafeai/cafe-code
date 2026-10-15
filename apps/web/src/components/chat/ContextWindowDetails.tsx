import { useUiLocale, useUiPresentation } from "~/i18n";
import { uiText } from "@cafecode/shared/i18n";
import { UiMessage } from "~/i18n";
import type { ReactNode } from "react";
import type { ServerProviderAccountRateLimits } from "@cafecode/contracts";

import { cn } from "~/lib/utils";
import { type ContextWindowSnapshot, formatContextWindowTokens } from "~/lib/contextWindow";
import { formatTokensPerSecond } from "~/lib/generationRate";
import { formatCodexRateLimitPresentation } from "~/lib/codexRateLimits";
import { ProviderAccountQuotaDetails, UsageMeterBar } from "../ProviderAccountQuotaDetails";
import type { ProviderQuotaState } from "./useProviderQuota";
import { SubagentConcurrencyDetails } from "./SubagentConcurrencyControl";
import { CodexContextWindowDetails } from "./CodexContextWindowControl";
import {
  formatCodexContextWindowOverride,
  type CodexContextWindowPresentation,
} from "../../codexContextWindow";
import {
  formatSubagentConcurrencyLimit,
  type SubagentConcurrencyPresentation,
} from "../../subagentConcurrency";

function formatPercentage(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  if (value < 10) {
    return `${value.toFixed(1).replace(/\.0$/, "")}%`;
  }
  return `${Math.round(value)}%`;
}

/** Keep the capacity phrase's existing span while the complete context summary
 * remains reorderable. This pure, code-owned wrapper has no action authority. */
function renderContextCapacity(parts: (string | ReactNode)[]): ReactNode {
  return <span>{parts}</span>;
}

export function ContextWindowDetails(props: {
  readonly usage: ContextWindowSnapshot | null | undefined;
  readonly rateLimits?: ServerProviderAccountRateLimits | null | undefined;
  readonly sessionQuota?: ProviderQuotaState | undefined;
  readonly layout?: "popover" | "panel";
  readonly headerAction?: ReactNode;
  readonly usageResetAction?: ReactNode;
  readonly subagentConcurrency?: SubagentConcurrencyPresentation | null | undefined;
  readonly codexContextWindow?: CodexContextWindowPresentation | null | undefined;
}) {
  const uiLocale = useUiLocale();
  const uiPresentation = useUiPresentation(UI_PRESENTATION_SOURCES);

  const usage = props.usage ?? null;
  const layout = props.layout ?? "popover";
  const quota = uiPresentation.formatCodexRateLimitPresentation(props.rateLimits, {
    compactDetails: true,
  });
  const usedPercentage = usage ? formatPercentage(usage.usedPercentage) : null;
  const hasUsage = usage !== null;
  const hasRateLimits = quota !== null;
  const hasSessionQuota = props.sessionQuota !== undefined;
  const hasSubagentLimit = formatSubagentConcurrencyLimit(props.subagentConcurrency) !== null;
  const hasContextOverride =
    formatCodexContextWindowOverride(props.codexContextWindow, uiLocale) !== null;
  const hasProcessed = usage !== null && (usage.totalProcessedTokens ?? 0) > usage.usedTokens;
  const generationRate = usage?.generationRate;

  if (!hasUsage && !hasRateLimits && !hasSubagentLimit && !hasContextOverride && !hasSessionQuota) {
    return (
      <p className="text-ui text-subtle-foreground">
        {uiText("Waiting for usage from this chat.", undefined, undefined, uiLocale)}
      </p>
    );
  }

  return (
    <div
      className={cn(
        "leading-tight",
        layout === "panel" ? "flex min-h-0 flex-col gap-2.5" : "space-y-1.5",
      )}
    >
      {layout === "popover" && (hasUsage || !hasSessionQuota) ? (
        <div className="flex items-center justify-between gap-2">
          <div className="label-overline">
            {uiText("Context window", undefined, undefined, uiLocale)}
          </div>
          {props.headerAction}
        </div>
      ) : hasUsage || !hasSessionQuota ? (
        <div className="label-overline">
          {uiText("Context window", undefined, undefined, uiLocale)}
        </div>
      ) : null}

      {hasUsage && layout === "panel" ? (
        <UsageMeterBar percent={usage.usedPercentage ?? 0} testId="context" />
      ) : null}

      {hasUsage && usage.maxTokens !== null && usedPercentage ? (
        <div
          className={cn(
            "text-foreground",
            layout === "panel"
              ? "text-ui font-medium tabular-nums"
              : "whitespace-nowrap text-xs font-medium tabular-nums",
          )}
        >
          <UiMessage
            message={
              "<percentage></percentage><separator></separator><used></used><divider></divider><capacity>{maximum} context used</capacity>"
            }
            values={{
              maximum: formatContextWindowTokens(usage.maxTokens ?? null),
              capacity: renderContextCapacity,
            }}
            slots={{
              percentage: <span>{usedPercentage}</span>,
              separator: <span className="mx-1">⋅</span>,
              used: <span>{formatContextWindowTokens(usage.usedTokens)}</span>,
              divider: <span>/</span>,
            }}
          />
        </div>
      ) : hasUsage ? (
        <div
          className={
            layout === "panel" ? "text-ui text-foreground tabular-nums" : "text-sm text-foreground"
          }
        >
          {uiText(
            "{tokens} tokens used so far",
            {
              tokens: formatContextWindowTokens(usage.usedTokens),
            },
            undefined,
            uiLocale,
          )}
        </div>
      ) : null}

      {hasProcessed || generationRate ? (
        <div
          className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-muted-foreground tabular-nums"
          data-context-window-statistics
        >
          {hasProcessed ? (
            <span
              className="min-w-0 max-w-full"
              title={uiText(
                "Total processed: {tokens} tokens",
                { tokens: formatContextWindowTokens(usage?.totalProcessedTokens ?? null) },
                undefined,
                uiLocale,
              )}
            >
              {uiText(
                "Processed: {tokens}",
                { tokens: formatContextWindowTokens(usage?.totalProcessedTokens ?? null) },
                undefined,
                uiLocale,
              )}
            </span>
          ) : null}
          {generationRate ? (
            <span className="min-w-0 max-w-full">
              {uiText(
                "Speed: {rate} tok/s",
                { rate: formatTokensPerSecond(generationRate) },
                undefined,
                uiLocale,
              )}
            </span>
          ) : null}
        </div>
      ) : null}

      {quota || hasSessionQuota ? (
        <div
          className={cn(
            "text-xs",
            layout === "panel" ? "flex min-h-0 flex-col" : "space-y-1",
            hasUsage && "border-t border-border-subtle pt-2",
            layout === "panel" && hasUsage && "mt-1",
          )}
        >
          <ProviderAccountQuotaDetails
            presentation={quota}
            sessionQuota={props.sessionQuota}
            layout={layout}
            action={props.usageResetAction}
          />
        </div>
      ) : null}
      {hasSubagentLimit || hasContextOverride ? (
        // These are adjacent policy summaries, not separate usage sections.
        // One shared divider preserves the single-row boundary while keeping
        // the outer usage/quota section gap out of the space between policies.
        <div className="flex flex-col gap-1 border-t border-border-subtle pt-2">
          {hasSubagentLimit ? (
            <SubagentConcurrencyDetails presentation={props.subagentConcurrency} />
          ) : null}
          {hasContextOverride ? (
            <CodexContextWindowDetails presentation={props.codexContextWindow} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// Finite source-owned labels/helpers only; no received or user data.
const UI_PRESENTATION_SOURCES = { formatCodexRateLimitPresentation };
