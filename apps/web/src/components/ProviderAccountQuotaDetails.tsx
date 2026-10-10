import { useEffect, useState, type ReactNode } from "react";

import type { CodexRateLimitPresentation } from "../lib/codexRateLimits";
import { cn } from "../lib/utils";
import { CLAUDE_QUOTA_STALE_AFTER_MS, formatClaudeSessionQuota } from "../lib/claudeSessionQuota";
import type { ProviderQuotaState } from "./chat/useProviderQuota";

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
  readonly presentation?: CodexRateLimitPresentation | null;
  readonly sessionQuota?: ProviderQuotaState | undefined;
  readonly layout?: "compact" | "popover" | "panel" | "settings";
  readonly action?: ReactNode;
}) {
  const presentation = props.presentation;
  const layout = props.layout ?? "compact";
  const report = props.sessionQuota?.report;
  const [clock, setClock] = useState(0);
  useEffect(() => {
    if (!report) return;
    const now = Date.now();
    const deadlines = [
      Date.parse(report.observedAt) + CLAUDE_QUOTA_STALE_AFTER_MS,
      ...(report.meters ?? []).flatMap((meter) =>
        meter.resetsAt ? [Date.parse(meter.resetsAt)] : [],
      ),
    ].filter((deadline) => Number.isFinite(deadline) && deadline > now);
    if (!deadlines.length) return;
    // A display-only deadline, never provider polling. Each reset/receipt age
    // boundary updates all rows together without guessing replenished usage.
    const timer = setTimeout(
      () => setClock((value) => value + 1),
      Math.min(2_147_483_647, Math.min(...deadlines) - now + 1),
    );
    return () => clearTimeout(timer);
  }, [report, clock]);
  const session = report ? formatClaudeSessionQuota(report) : null;
  // Anonymous historical event windows have no current query/config binding.
  // They must not reappear beneath a newly scoped unavailable/offline report.
  // Existing unscoped consumers and other provider drivers remain unchanged.
  const legacy = props.sessionQuota ? null : presentation;
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
      {props.sessionQuota ? (
        <section
          className="flex min-h-0 min-w-0 flex-col gap-1.5"
          aria-label="Account usage"
          data-claude-session-quota
        >
          <div className="label-overline">Account usage</div>
          <p>Session-reported · not account-verified</p>
          {session ? (
            <>
              <p>
                {session.observed} · local time{session.stale ? " · Stale reading" : ""}
              </p>
              <div
                className="focus-ring min-h-0 min-w-0 max-h-[40vh] space-y-2.5 overflow-y-auto rounded-sm"
                data-account-quota-scroll
                tabIndex={0}
                role="region"
                aria-label="Claude reported quota meters and extra usage"
              >
                {session.meters === null ? (
                  <p>Quota meters unavailable in this report.</p>
                ) : session.meters.length === 0 ? (
                  <p>Claude reported no quota meters.</p>
                ) : (
                  session.meters.map((meter, index) => (
                    <section
                      key={meter.id}
                      aria-label={`${meter.label} quota`}
                      className="min-w-0 space-y-1.5"
                      data-claude-quota-meter={meter.id}
                    >
                      {index === 0 || session.meters?.[index - 1]?.group !== meter.group ? (
                        <div className="font-medium text-foreground">{meter.group}</div>
                      ) : null}
                      <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                        <span>{meter.label}</span>
                        <span className="font-medium text-foreground tabular-nums">
                          {meter.value}
                        </span>
                      </div>
                      <UsageMeterBar
                        percent={meter.remainingPercent}
                        testId={`claude-${meter.id}`}
                      />
                      {meter.reset ? <p>{meter.reset}</p> : null}
                      <p>
                        {meter.severity}
                        {meter.isActive ? " · Provider headline" : ""}
                        {meter.stale ? " · Stale; request a new report" : ""}
                      </p>
                    </section>
                  ))
                )}
                {session.extraUsage ? (
                  <section
                    aria-label="Extra usage"
                    className="min-w-0 space-y-1.5 border-t border-border-subtle pt-2"
                  >
                    <div className="font-medium text-foreground">
                      Extra usage (separate from plan quota)
                    </div>
                    {session.extraUsage.map((line) => (
                      <p key={line}>{line}</p>
                    ))}
                  </section>
                ) : null}
              </div>
            </>
          ) : (
            <p>
              {props.sessionQuota.status === "loading"
                ? "Loading session report…"
                : props.sessionQuota.status === "offline"
                  ? "Session report unavailable while disconnected."
                  : "No session quota report available."}
            </p>
          )}
          <p>Request /usage in Claude to update. Opening this view does not refresh it.</p>
        </section>
      ) : null}
      {legacy?.buckets.length ? (
        <div
          className="min-h-0 min-w-0 max-h-[40vh] space-y-2.5 overflow-y-auto"
          data-account-quota-scroll
        >
          {legacy.buckets.map((bucket) => (
            <section
              key={bucket.id}
              aria-label={`${bucket.label} quota`}
              data-account-quota-bucket={bucket.id}
              className="min-w-0 space-y-1.5"
            >
              {legacy.buckets.length > 1 || bucket.id !== "codex" || bucket.label !== "codex" ? (
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
      {legacy?.resetAvailability ? <p className="shrink-0">{legacy.resetAvailability}</p> : null}
    </div>
  );
}
