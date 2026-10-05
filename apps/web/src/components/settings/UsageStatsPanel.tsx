import { useEffect, useMemo, useRef, useState } from "react";
import type { UsageStatsGetResult, UsageStatsSnapshot } from "@cafecode/contracts";

import { getPrimaryEnvironmentConnection, readEnvironmentConnection } from "~/environments/runtime";
import { useWorkspaceEnvironmentId } from "~/environments/workspace";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { ActivityHeatmap } from "../stats/ActivityHeatmap";
import { useUsageStatsDetail } from "../stats/usageStatsDetailResource";
import { getUsageRangeBounds, selectUsageRange, type UsageRangeKey } from "../stats/usageRange";
import { UsageRangeSelector } from "../stats/UsageRangeSelector";
import { PROVIDER_ICON_BY_PROVIDER } from "../chat/providerIconUtils";
import { Skeleton } from "../ui/skeleton";
import { Switch } from "../ui/switch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { UsageCostSection } from "./UsageCostSection";
import {
  buildUsageTokenBreakdownView,
  formatGeneratingTime,
  formatUsageModelLabel,
  getUsageModelExplanation,
  formatUsagePercentage,
  formatUsageProviderLabel,
} from "./usageStatsPresentation";

const integerFormat = new Intl.NumberFormat("en-US");

/**
 * Between detailed server snapshots, project the generating-time counter forward
 * at `activeSessionCount` seconds per second (three concurrent sessions tick
 * 3x). Token/chat counters hold the same atomic detail as the cost panels.
 * Within a period time never runs backwards: a projection overshoot is absorbed
 * by holding the counter until the true total catches up.
 */
function useLiveTotals(
  snapshot: UsageStatsSnapshot | null,
  live: UsageStatsSnapshot | null,
  range: UsageRangeKey,
) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const displayedTimeFloor = useRef({ scope: "", value: 0 });
  const displayedTodayFloor = useRef({ day: "", value: 0 });

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 250);
    return () => clearInterval(id);
  }, []);

  if (snapshot === null) {
    return null;
  }
  // Counts and attribution must come from one detailed response. The fast
  // stream has no model/day ledger, so using its token counts would mix newer
  // aggregate totals with older costs. It supplies only current activity;
  // a fresher detailed response always wins over a stale live event.
  const activity = live !== null && live.asOfMs > snapshot.asOfMs ? live : snapshot;
  const scope = `${range}:${snapshot.today.day}`;
  if (displayedTimeFloor.current.scope !== scope) {
    // A previous period's monotonic floor must never prevent a shorter range
    // (or the new calendar day) from displaying its smaller true total.
    displayedTimeFloor.current = { scope, value: 0 };
  }
  // Activity is lifetime history, not part of the reporting-period selector.
  // Its current-day projection must therefore keep an independent floor when
  // the user switches ranges, while still resetting at the server's midnight.
  if (displayedTodayFloor.current.day !== snapshot.today.day) {
    displayedTodayFloor.current = { day: snapshot.today.day, value: 0 };
  }
  // Apply observed same-day generation before projecting from the live event's
  // own timestamp. Projecting a newly increased session count all the way from
  // an older detail read would retroactively charge those sessions for time
  // when they were not running. Across server midnight, wait for the next
  // detailed calendar anchor rather than charging the new day to the old cell.
  const sameDay = activity.today.day === snapshot.today.day;
  const observedMs = sameDay
    ? Math.max(0, activity.today.generatingMs - snapshot.today.generatingMs)
    : 0;
  const extrapolatedMs =
    sameDay && activity.collectionEnabled && activity.activeSessionCount > 0
      ? Math.max(0, nowMs - activity.asOfMs) * activity.activeSessionCount
      : 0;
  const todayGeneratingMs = Math.max(
    displayedTodayFloor.current.value,
    snapshot.today.generatingMs + observedMs + extrapolatedMs,
  );
  displayedTodayFloor.current.value = todayGeneratingMs;
  const generatingMs = Math.max(
    displayedTimeFloor.current.value,
    snapshot.totals.generatingMs + observedMs + extrapolatedMs,
  );
  displayedTimeFloor.current.value = generatingMs;
  return {
    outputTokens: snapshot.totals.outputTokens,
    userMessages: snapshot.totals.userMessages,
    generatingMs,
    todayGeneratingMs,
    activeSessionCount: activity.activeSessionCount,
    collectionEnabled: activity.collectionEnabled,
  };
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col items-center gap-1.5 px-2 py-5 text-center @min-[40rem]/usage-page:px-3 @min-[40rem]/usage-page:py-6">
      <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/70 sm:text-[11px]">
        {label}
      </span>
      <span className="max-w-full break-words text-xl font-semibold leading-tight tracking-tight text-foreground tabular-nums [overflow-wrap:anywhere] @min-[40rem]/usage-page:text-2xl @min-[64rem]/usage-page:text-[1.75rem]">
        {value}
      </span>
    </div>
  );
}

function TokenBreakdownSection({
  usage,
  outputTokens,
}: {
  usage: UsageStatsGetResult["tokenBreakdown"];
  outputTokens: number;
}) {
  const breakdown = useMemo(
    () => buildUsageTokenBreakdownView(usage, outputTokens),
    [outputTokens, usage],
  );
  const percentageTotal = Math.max(outputTokens, breakdown.attributedOutputTokens);
  const hasRows = breakdown.providers.length > 0 || breakdown.unattributedOutputTokens > 0;

  return (
    <SettingsSection
      title="Output tokens by provider and model"
      headerAction={
        breakdown.attributedOutputTokens > 0 ? (
          <span className="text-[11px] tabular-nums text-muted-foreground">
            {integerFormat.format(breakdown.attributedOutputTokens)} attributed
          </span>
        ) : null
      }
    >
      <p className="border-b border-border/45 px-4 py-2.5 text-[11px] text-muted-foreground sm:px-5">
        Generated output only; processed-token totals above also include input.
      </p>
      {hasRows ? (
        <div
          aria-label="Output token usage by provider and model"
          className="divide-y divide-border/60"
        >
          {breakdown.providers.map((providerUsage) => {
            const ProviderIcon = PROVIDER_ICON_BY_PROVIDER[providerUsage.provider];
            const providerPercentage = formatUsagePercentage(
              providerUsage.outputTokens,
              percentageTotal,
            );
            const providerBarWidth =
              percentageTotal > 0
                ? Math.min(100, (providerUsage.outputTokens / percentageTotal) * 100)
                : 0;

            return (
              <div
                key={providerUsage.provider}
                data-usage-output-provider={providerUsage.provider}
                className="px-4 py-4 sm:px-5"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border/70 bg-muted/35 text-foreground/80">
                    {ProviderIcon ? <ProviderIcon aria-hidden className="size-4" /> : null}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-baseline justify-between gap-3">
                      <div className="min-w-0">
                        <span className="text-[13px] font-semibold text-foreground">
                          {formatUsageProviderLabel(providerUsage.provider)}
                        </span>
                        <span className="ml-2 text-[11px] tabular-nums text-muted-foreground">
                          {providerPercentage}
                        </span>
                      </div>
                      <span className="shrink-0 text-[13px] font-semibold tabular-nums text-foreground">
                        {integerFormat.format(providerUsage.outputTokens)}
                      </span>
                    </div>
                    {providerUsage.outputTokens === 0 ? (
                      <p className="mt-1 text-[11px] text-muted-foreground">No output recorded</p>
                    ) : null}
                    <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted">
                      <div
                        aria-hidden
                        className="h-full rounded-full bg-primary/65"
                        style={{ width: `${providerBarWidth}%` }}
                      />
                    </div>
                  </div>
                </div>

                <div className="mt-3 ml-11 divide-y divide-border/45 border-l border-border/60 pl-3">
                  {providerUsage.models.map((modelUsage) => (
                    <div
                      key={modelUsage.model}
                      className="flex min-w-0 items-center justify-between gap-3 py-2 first:pt-0 last:pb-0"
                    >
                      <span
                        className="min-w-0"
                        title={
                          getUsageModelExplanation(modelUsage.model) ??
                          formatUsageModelLabel(modelUsage.model)
                        }
                      >
                        <span className="block truncate font-mono text-[11px] text-muted-foreground">
                          {formatUsageModelLabel(modelUsage.model)}
                        </span>
                        {modelUsage.outputTokens === 0 ? (
                          <span className="mt-0.5 block text-[10px] text-muted-foreground/70">
                            {integerFormat.format(modelUsage.processedTokens)} processed tokens
                          </span>
                        ) : null}
                      </span>
                      <div className="flex shrink-0 items-center gap-2 text-[11px] tabular-nums">
                        <span className="text-muted-foreground/70">
                          {formatUsagePercentage(
                            modelUsage.outputTokens,
                            providerUsage.outputTokens,
                          )}
                        </span>
                        <span className="min-w-16 text-right font-medium text-foreground/85">
                          {integerFormat.format(modelUsage.outputTokens)}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}

          {breakdown.unattributedOutputTokens > 0 ? (
            <div className="flex items-center justify-between gap-4 px-4 py-3.5 sm:px-5">
              <div className="min-w-0">
                <div className="text-[12px] font-medium text-foreground/85">Unattributed usage</div>
                <div className="text-[11px] text-muted-foreground">
                  Recorded usage without provider and model attribution
                </div>
              </div>
              <div className="shrink-0 text-right tabular-nums">
                <div className="text-[12px] font-medium text-foreground/85">
                  {integerFormat.format(breakdown.unattributedOutputTokens)}
                </div>
                <div className="text-[10px] text-muted-foreground">
                  {formatUsagePercentage(breakdown.unattributedOutputTokens, percentageTotal)}
                </div>
              </div>
            </div>
          ) : null}
        </div>
      ) : (
        <p className="px-4 py-6 text-center text-xs text-muted-foreground sm:px-5">
          Provider and model attribution will appear after token usage is recorded.
        </p>
      )}
    </SettingsSection>
  );
}

export function UsageStatsPanel() {
  const environmentId = useWorkspaceEnvironmentId();
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const detail = useUsageStatsDetail(true);
  const initial = detail.data;
  const [range, setRange] = useState<UsageRangeKey>("30");
  const selected = useMemo(
    () => (initial === null ? null : selectUsageRange(initial, range)),
    [initial, range],
  );
  const activityBounds = useMemo(
    () => (initial === null ? undefined : getUsageRangeBounds(initial, "all")),
    [initial],
  );
  const [snapshot, setSnapshot] = useState<UsageStatsSnapshot | null>(null);
  const loadError = detail.phase === "error" && initial === null;

  useEffect(() => {
    let cancelled = false;
    setSnapshot(null);
    const connection = environmentId
      ? readEnvironmentConnection(environmentId)
      : getPrimaryEnvironmentConnection();
    if (!connection) return;
    const unsubscribe = connection.client.server.subscribeUsageStats((event) => {
      if (!cancelled) {
        setSnapshot((current) =>
          current === null || event.asOfMs >= current.asOfMs ? event : current,
        );
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [environmentId]);

  const totals = useLiveTotals(selected, snapshot, range);
  const generating = (totals?.activeSessionCount ?? 0) > 0 && (totals?.collectionEnabled ?? false);

  return (
    // Usage is a dashboard, not a narrow settings form. Its own container
    // tracks the space left by the sidebar and the user's interface scale.
    <SettingsPageContainer className="@container/usage-page min-w-0 max-w-none">
      <SettingsSection
        title="Usage"
        className="[&>div:first-child]:flex-wrap [&>div:first-child]:gap-2 [&>div:first-child>div]:h-auto"
        headerAction={
          <div className="flex flex-wrap items-center justify-end gap-3">
            {generating ? (
              <span className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                <span className="relative flex size-2">
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary/60 motion-reduce:hidden" />
                  <span className="relative inline-flex size-2 rounded-full bg-primary" />
                </span>
                {totals && totals.activeSessionCount > 1
                  ? `${totals.activeSessionCount} sessions generating`
                  : "Generating"}
              </span>
            ) : null}
            <UsageRangeSelector value={range} onChange={setRange} />
          </div>
        }
      >
        {totals ? (
          <div className="grid grid-cols-1 divide-x divide-y divide-border/60 @min-[40rem]/usage-page:grid-cols-3 @min-[40rem]/usage-page:divide-y-0">
            <StatTile label="Tokens generated" value={integerFormat.format(totals.outputTokens)} />
            <StatTile label="Chats sent" value={integerFormat.format(totals.userMessages)} />
            <StatTile
              label="Time spent generating"
              value={formatGeneratingTime(totals.generatingMs)}
            />
          </div>
        ) : (
          <div className="px-4 py-8">
            {loadError ? (
              <p className="text-center text-xs text-muted-foreground">
                Usage stats are unavailable right now. Reconnect to the server and try again.
              </p>
            ) : (
              <div className="grid grid-cols-1 gap-4 @min-[40rem]/usage-page:grid-cols-3">
                {[0, 1, 2].map((column) => (
                  <div key={column} className="flex flex-col items-center gap-2">
                    <Skeleton className="h-3 w-20" />
                    <Skeleton className="h-7 w-24" />
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </SettingsSection>

      <UsageCostSection usage={initial} range={range} />

      <TokenBreakdownSection
        usage={selected?.tokenBreakdown ?? []}
        outputTokens={selected?.totals.outputTokens ?? 0}
      />

      <SettingsSection title="Activity">
        <div className="px-4 py-4 sm:px-5">
          {initial ? (
            <ActivityHeatmap
              days={initial.days}
              bounds={activityBounds}
              layout="responsive"
              today={
                totals
                  ? { ...initial.today, generatingMs: Math.round(totals.todayGeneratingMs) }
                  : undefined
              }
            />
          ) : (
            <Skeleton className="h-28 w-full" />
          )}
        </div>
      </SettingsSection>

      <SettingsSection title="Data collection">
        <SettingsRow
          title="Collect usage statistics"
          description="Track tokens, chats, and generating time across all your Cafe Code use. Data never leaves this machine; turning collection off pauses the counters without clearing them."
          control={
            <Switch
              checked={settings.usageStatsEnabled}
              onCheckedChange={(checked) => {
                updateSettings({ usageStatsEnabled: Boolean(checked) });
              }}
              aria-label="Collect usage statistics"
            />
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
