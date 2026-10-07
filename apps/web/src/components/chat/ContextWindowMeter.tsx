import type { ServerProviderAccountRateLimits } from "@cafecode/contracts";

import { cn } from "~/lib/utils";
import { type ContextWindowSnapshot, formatContextWindowTokens } from "~/lib/contextWindow";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ContextWindowDetails } from "./ContextWindowDetails";
import { SessionPlacementButton } from "./SessionRail";
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

export function ContextWindowMeter(props: {
  usage: ContextWindowSnapshot;
  codexRateLimits?: ServerProviderAccountRateLimits | null | undefined;
  onShowOnSide?: () => void;
  subagentConcurrency?: SubagentConcurrencyPresentation | null | undefined;
}) {
  const { usage } = props;
  const usedPercentage = formatPercentage(usage.usedPercentage);
  const normalizedPercentage = Math.max(0, Math.min(100, usage.usedPercentage ?? 0));
  const radius = 9.75;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference - (normalizedPercentage / 100) * circumference;

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={0}
        render={
          <button
            type="button"
            className="focus-ring group inline-flex items-center justify-center rounded-full transition-opacity duration-(--duration-fast) hover:opacity-85"
            aria-label={
              usage.maxTokens !== null && usedPercentage
                ? `Context window ${usedPercentage} used`
                : `Context window ${formatContextWindowTokens(usage.usedTokens)} tokens used`
            }
          >
            <span className="relative flex h-6 w-6 items-center justify-center">
              <svg
                viewBox="0 0 24 24"
                className="-rotate-90 absolute inset-0 h-full w-full transform-gpu"
                aria-hidden="true"
              >
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  fill="none"
                  stroke="color-mix(in oklab, var(--color-muted) 70%, transparent)"
                  strokeWidth="3"
                />
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  fill="none"
                  stroke="var(--color-muted-foreground)"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeDasharray={circumference}
                  strokeDashoffset={dashOffset}
                  className="transition-[stroke-dashoffset] duration-500 ease-out motion-reduce:transition-none"
                />
              </svg>
              <span
                className={cn(
                  // The gauge numeral is a glyph inside a 24px ring, a deliberate
                  // exception to the 11px text floor. Rem units keep it scaling
                  // with the ring at every interface size.
                  "relative flex size-[0.9375rem] items-center justify-center rounded-full bg-background text-[0.5rem] font-medium tabular-nums",
                  "text-muted-foreground",
                )}
              >
                {usage.usedPercentage !== null
                  ? Math.round(usage.usedPercentage)
                  : formatContextWindowTokens(usage.usedTokens)}
              </span>
            </span>
          </button>
        }
      />
      <PopoverPopup tooltipStyle side="top" align="end" className="w-max max-w-none px-3 py-2">
        <ContextWindowDetails
          usage={usage}
          rateLimits={props.codexRateLimits}
          layout="popover"
          subagentConcurrency={props.subagentConcurrency}
          {...(props.onShowOnSide
            ? {
                headerAction: (
                  <SessionPlacementButton placement="side" onClick={props.onShowOnSide} />
                ),
              }
            : {})}
        />
      </PopoverPopup>
    </Popover>
  );
}
