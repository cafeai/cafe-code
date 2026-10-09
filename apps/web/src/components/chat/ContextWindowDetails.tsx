import type { ReactNode } from "react";
import type { ServerProviderAccountRateLimits } from "@cafecode/contracts";

import { cn } from "~/lib/utils";
import { type ContextWindowSnapshot, formatContextWindowTokens } from "~/lib/contextWindow";
import { formatCodexRateLimitPresentation } from "~/lib/codexRateLimits";
import { ProviderAccountQuotaDetails, UsageMeterBar } from "../ProviderAccountQuotaDetails";
import type { ProviderQuotaState } from "./useProviderQuota";
import { SubagentConcurrencyDetails } from "./SubagentConcurrencyControl";
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

export function ContextWindowDetails(props: {
  readonly usage: ContextWindowSnapshot | null | undefined;
  readonly rateLimits?: ServerProviderAccountRateLimits | null | undefined;
  readonly sessionQuota?: ProviderQuotaState | undefined;
  readonly layout?: "popover" | "panel";
  readonly headerAction?: ReactNode;
  readonly usageResetAction?: ReactNode;
  readonly subagentConcurrency?: SubagentConcurrencyPresentation | null | undefined;
}) {
  const usage = props.usage ?? null;
  const layout = props.layout ?? "popover";
  const quota = formatCodexRateLimitPresentation(props.rateLimits);
  const usedPercentage = usage ? formatPercentage(usage.usedPercentage) : null;
  const normalizedPercentage = Math.max(0, Math.min(100, usage?.usedPercentage ?? 0));
  const hasUsage = usage !== null;
  const hasRateLimits = quota !== null;
  const hasSessionQuota = props.sessionQuota !== undefined;
  const hasSubagentLimit = formatSubagentConcurrencyLimit(props.subagentConcurrency) !== null;

  if (!hasUsage && !hasRateLimits && !hasSubagentLimit && !hasSessionQuota) {
    return <p className="text-ui text-subtle-foreground">Waiting for usage from this chat.</p>;
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
          <div className="label-overline">Context window</div>
          {props.headerAction}
        </div>
      ) : hasUsage || !hasSessionQuota ? (
        <div className="label-overline">Context window</div>
      ) : null}

      {hasUsage && layout === "panel" ? (
        <UsageMeterBar percent={normalizedPercentage} testId="context" />
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
          <span>{usedPercentage}</span>
          <span className="mx-1">⋅</span>
          <span>{formatContextWindowTokens(usage.usedTokens)}</span>
          <span>/</span>
          <span>{formatContextWindowTokens(usage.maxTokens ?? null)} context used</span>
        </div>
      ) : hasUsage ? (
        <div
          className={
            layout === "panel" ? "text-ui text-foreground tabular-nums" : "text-sm text-foreground"
          }
        >
          {formatContextWindowTokens(usage.usedTokens)} tokens used so far
        </div>
      ) : null}

      {hasUsage &&
      (usage.totalProcessedTokens ?? null) !== null &&
      (usage.totalProcessedTokens ?? 0) > usage.usedTokens ? (
        <div className="text-xs text-muted-foreground">
          Total processed: {formatContextWindowTokens(usage.totalProcessedTokens ?? null)} tokens
        </div>
      ) : null}

      {hasUsage && usage.compactsAutomatically ? (
        <div className="text-xs text-muted-foreground">
          {usage.autoCompactTokenLimit
            ? `Automatically compacts around ${formatContextWindowTokens(
                usage.autoCompactTokenLimit,
              )} tokens.`
            : "Automatically compacts its context when needed."}
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
      {hasSubagentLimit ? (
        <div className="border-t border-border-subtle pt-2">
          <SubagentConcurrencyDetails presentation={props.subagentConcurrency} />
        </div>
      ) : null}
    </div>
  );
}
