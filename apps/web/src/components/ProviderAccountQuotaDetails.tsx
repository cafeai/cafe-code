import type { ReactNode } from "react";

import type { CodexRateLimitPresentation } from "../lib/codexRateLimits";
import { cn } from "../lib/utils";

export function UsageMeterBar(props: { readonly percent: number; readonly testId: string }) {
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

/** One read-only rendering path for settings, composer details and the docked
 * rail. Provider strings remain React text, never markup, links or commands.
 * Additional buckets scroll within every surface; the reset count stays at
 * the bottom outside that scroll region so account-wide availability is clear. */
export function ProviderAccountQuotaDetails(props: {
  readonly presentation: CodexRateLimitPresentation;
  readonly layout?: "compact" | "popover" | "panel" | "settings";
  readonly action?: ReactNode;
}) {
  const { presentation } = props;
  const layout = props.layout ?? "compact";
  return (
    <div
      className={cn(
        "flex min-h-0 min-w-0 flex-col gap-1.5 text-xs leading-snug text-muted-foreground [overflow-wrap:anywhere]",
        layout === "popover" && "max-w-[min(28rem,calc(100vw-2rem))]",
      )}
      data-account-quota
      data-account-quota-layout={layout}
    >
      {props.action ? (
        // An ineligible reset action renders no button. Display contents avoids
        // leaving an empty heading row (and flex gap) in that case.
        <div className="contents [&>button]:self-end">{props.action}</div>
      ) : null}
      {presentation.buckets.length ? (
        <div
          className="min-h-0 min-w-0 max-h-[40vh] space-y-2.5 overflow-y-auto"
          data-account-quota-scroll
        >
          {presentation.buckets.map((bucket) => (
            <section
              key={bucket.id}
              aria-label={`${bucket.label} quota`}
              data-account-quota-bucket={bucket.id}
              className="min-w-0 space-y-1.5"
            >
              {presentation.buckets.length > 1 ||
              bucket.id !== "codex" ||
              bucket.label !== "codex" ? (
                <div className="font-medium text-foreground">{bucket.label}</div>
              ) : null}
              {(["primary", "secondary"] as const).map((kind) => {
                const window = bucket[kind];
                const reset = kind === "primary" ? bucket.primaryReset : bucket.secondaryReset;
                if (!window && !reset) return null;
                return (
                  <div
                    key={kind}
                    className={cn(
                      "min-w-0",
                      // These are one window's related facts, not columns
                      // distributed across the whole card. Size them to their
                      // content and wrap when they no longer fit, so wider
                      // settings pages do not detach usage from its label.
                      layout === "settings"
                        ? "flex flex-wrap items-baseline gap-x-4 gap-y-1"
                        : "space-y-1",
                    )}
                    data-account-quota-window={kind}
                    data-session-rail-rate-limit={layout === "panel" ? kind : undefined}
                  >
                    {window ? (
                      layout === "panel" ? (
                        <>
                          {/* The rail already has its one overline ("Context
                              window"); window names are ordinary labels. */}
                          <div className="text-xs text-muted-foreground">{window.label}</div>
                          <UsageMeterBar
                            percent={window.remainingPercent}
                            testId={`${kind}-window`}
                          />
                          <div className="text-ui font-medium text-foreground tabular-nums">
                            {window.value}
                          </div>
                        </>
                      ) : (
                        <div
                          className={
                            layout === "settings"
                              ? "flex min-w-0 max-w-full flex-wrap items-baseline gap-x-3 gap-y-1"
                              : "grid grid-cols-[minmax(0,1fr)_auto] gap-x-3"
                          }
                        >
                          <span>{window.label}</span>
                          <span
                            className={cn(
                              "text-right font-medium text-foreground",
                              layout === "settings" && "shrink-0 whitespace-nowrap",
                            )}
                          >
                            {window.value}
                          </span>
                        </div>
                      )
                    ) : null}
                    {reset ? (
                      <p
                        className={
                          layout === "settings"
                            ? cn("min-w-0 max-w-full", !window && "w-full")
                            : undefined
                        }
                      >
                        {reset}
                      </p>
                    ) : null}
                  </div>
                );
              })}
              {layout === "settings" && bucket.details.length > 0 ? (
                // Keep provider details together, without making every credit or
                // spend-status field consume a full row on a wide desktop.
                <div className="flex min-w-0 flex-wrap gap-x-5 gap-y-1" data-account-quota-metadata>
                  {bucket.details.map((line) => (
                    <p key={line.label} className="min-w-0 max-w-full">
                      {line.text}
                    </p>
                  ))}
                </div>
              ) : (
                bucket.details.map((line) => <p key={line.label}>{line.text}</p>)
              )}
            </section>
          ))}
        </div>
      ) : null}
      {presentation.resetAvailability ? (
        <p className="shrink-0">{presentation.resetAvailability}</p>
      ) : null}
    </div>
  );
}
