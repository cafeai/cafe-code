import type { ReactNode } from "react";
import type { ServerProviderAccountRateLimits } from "@cafecode/contracts";

import { cn } from "~/lib/utils";
import { type ContextWindowSnapshot, formatContextWindowTokens } from "~/lib/contextWindow";
import { formatCodexRateLimitSummary, selectCodexRateLimitSnapshot } from "~/lib/codexRateLimits";

function formatPercentage(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  if (value < 10) {
    return `${value.toFixed(1).replace(/\.0$/, "")}%`;
  }
  return `${Math.round(value)}%`;
}

function remainingPercentage(usedPercent: number | null | undefined): number | null {
  if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) {
    return null;
  }
  return Math.max(0, Math.min(100, 100 - usedPercent));
}

function MeterBar(props: { readonly percent: number; readonly testId: string }) {
  const normalized = Math.max(0, Math.min(100, props.percent));
  return (
    <div
      aria-hidden="true"
      className="h-1.5 overflow-hidden rounded-full bg-muted/70"
      data-session-rail-usage-bar={props.testId}
    >
      <div
        className="h-full rounded-full bg-primary transition-[width] duration-500 ease-out motion-reduce:transition-none"
        style={{ width: `${normalized}%` }}
      />
    </div>
  );
}

export function ContextWindowDetails(props: {
  readonly usage: ContextWindowSnapshot | null | undefined;
  readonly rateLimits?: ServerProviderAccountRateLimits | null | undefined;
  readonly layout?: "popover" | "panel";
  readonly headerAction?: ReactNode;
}) {
  const usage = props.usage ?? null;
  const layout = props.layout ?? "popover";
  const rateLimitSummary = formatCodexRateLimitSummary(props.rateLimits);
  const rateLimitSnapshot = selectCodexRateLimitSnapshot(props.rateLimits);
  const usedPercentage = usage ? formatPercentage(usage.usedPercentage) : null;
  const normalizedPercentage = Math.max(0, Math.min(100, usage?.usedPercentage ?? 0));
  const primaryRemaining = remainingPercentage(rateLimitSnapshot?.primary?.usedPercent);
  const secondaryRemaining = remainingPercentage(rateLimitSnapshot?.secondary?.usedPercent);
  const hasUsage = usage !== null;
  const hasRateLimits = rateLimitSummary !== null;

  if (!hasUsage && !hasRateLimits) {
    return (
      <p className="text-[13px] text-muted-foreground/40">Waiting for usage from this thread.</p>
    );
  }

  return (
    <div className={cn("leading-tight", layout === "panel" ? "space-y-2.5" : "space-y-1.5")}>
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
        <MeterBar percent={normalizedPercentage} testId="context" />
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

      {rateLimitSummary ? (
        <div
          className={cn(
            "text-xs",
            layout === "panel" ? "space-y-2.5" : "space-y-1",
            hasUsage && "border-t border-border/60 pt-2",
            layout === "panel" && hasUsage && "mt-1",
          )}
        >
          {rateLimitSummary.primary ? (
            layout === "panel" && primaryRemaining !== null ? (
              <div className="space-y-1.5" data-session-rail-rate-limit="primary">
                <div className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/40">
                  {rateLimitSummary.primary.label}
                </div>
                <MeterBar percent={primaryRemaining} testId="primary-window" />
                <div className="text-[13px] font-medium text-foreground">
                  {rateLimitSummary.primary.value}
                </div>
                {rateLimitSummary.primaryReset ? (
                  <div className="whitespace-normal text-muted-foreground [overflow-wrap:anywhere]">
                    {rateLimitSummary.primaryReset}
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="grid grid-cols-[auto_auto] gap-x-3 whitespace-nowrap">
                <span className="text-muted-foreground">{rateLimitSummary.primary.label}</span>
                <span className="text-right font-medium text-foreground">
                  {rateLimitSummary.primary.value}
                </span>
              </div>
            )
          ) : null}
          {rateLimitSummary.secondary ? (
            layout === "panel" && secondaryRemaining !== null ? (
              <div className="space-y-1.5" data-session-rail-rate-limit="secondary">
                <div className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground/40">
                  {rateLimitSummary.secondary.label}
                </div>
                <MeterBar percent={secondaryRemaining} testId="secondary-window" />
                <div className="text-[13px] font-medium text-foreground">
                  {rateLimitSummary.secondary.value}
                </div>
                {rateLimitSummary.weeklyReset ? (
                  <div className="whitespace-normal text-muted-foreground [overflow-wrap:anywhere]">
                    {rateLimitSummary.weeklyReset}
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="grid grid-cols-[auto_auto] gap-x-3 whitespace-nowrap">
                <span className="text-muted-foreground">{rateLimitSummary.secondary.label}</span>
                <span className="text-right font-medium text-foreground">
                  {rateLimitSummary.secondary.value}
                </span>
              </div>
            )
          ) : null}
          {layout === "popover" && rateLimitSummary.primaryReset ? (
            <div className="whitespace-nowrap text-muted-foreground">
              {rateLimitSummary.primaryReset}
            </div>
          ) : null}
          {layout === "popover" && rateLimitSummary.weeklyReset ? (
            <div className="whitespace-nowrap text-muted-foreground">
              {rateLimitSummary.weeklyReset}
            </div>
          ) : null}
          {layout === "panel" && !rateLimitSummary.primary && rateLimitSummary.primaryReset ? (
            <div className="whitespace-normal text-muted-foreground [overflow-wrap:anywhere]">
              {rateLimitSummary.primaryReset}
            </div>
          ) : null}
          {layout === "panel" && !rateLimitSummary.secondary && rateLimitSummary.weeklyReset ? (
            <div className="whitespace-normal text-muted-foreground [overflow-wrap:anywhere]">
              {rateLimitSummary.weeklyReset}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
