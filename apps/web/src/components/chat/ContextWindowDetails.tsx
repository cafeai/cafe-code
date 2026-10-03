import type { ReactNode } from "react";
import type { ServerProviderAccountRateLimits } from "@cafecode/contracts";

import { cn } from "~/lib/utils";
import { type ContextWindowSnapshot, formatContextWindowTokens } from "~/lib/contextWindow";
import { formatCodexRateLimitPresentation } from "~/lib/codexRateLimits";
import { ProviderAccountQuotaDetails, UsageMeterBar } from "../ProviderAccountQuotaDetails";
import { SubagentConcurrencyDetails } from "./SubagentConcurrencyControl";
import type { SubagentConcurrencyPresentation } from "../../subagentConcurrency";

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

  if (!hasUsage && !hasRateLimits && !props.subagentConcurrency) {
    return (
      <p className="text-[13px] text-muted-foreground/40">Waiting for usage from this thread.</p>
    );
  }

  return (
    <div
      className={cn(
        "leading-tight",
        layout === "panel" ? "flex min-h-0 flex-col gap-2.5" : "space-y-1.5",
      )}
    >
      {layout === "popover" ? (
        <div className="flex items-center justify-between gap-2">
          <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
            Context window
          </div>
          {props.headerAction}
        </div>
      ) : (
        <div className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/40">
          Context window
        </div>
      )}

      {hasUsage && layout === "panel" ? (
        <UsageMeterBar percent={normalizedPercentage} testId="context" />
      ) : null}

      {hasUsage && usage.maxTokens !== null && usedPercentage ? (
        <div
          className={cn(
            "text-foreground",
            layout === "panel"
              ? "text-[13px] font-medium"
              : "whitespace-nowrap text-xs font-medium",
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
          className={layout === "panel" ? "text-[13px] text-foreground" : "text-sm text-foreground"}
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

      {quota ? (
        <div
          className={cn(
            "text-xs",
            layout === "panel" ? "flex min-h-0 flex-col" : "space-y-1",
            hasUsage && "border-t border-border/60 pt-2",
            layout === "panel" && hasUsage && "mt-1",
          )}
        >
          <ProviderAccountQuotaDetails
            presentation={quota}
            layout={layout}
            action={props.usageResetAction}
          />
        </div>
      ) : null}
      {props.subagentConcurrency ? (
        <div className="border-t border-border/60 pt-2">
          <SubagentConcurrencyDetails presentation={props.subagentConcurrency} />
        </div>
      ) : null}
    </div>
  );
}
