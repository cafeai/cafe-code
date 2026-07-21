import { useEffect, useMemo, useRef, useState } from "react";
import type { UsageStatsGetResult, UsageStatsSnapshot } from "@cafecode/contracts";

import { getPrimaryEnvironmentConnection } from "~/environments/runtime";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { ActivityHeatmap } from "../stats/ActivityHeatmap";
import { useCountUp } from "../stats/useCountUp";
import { PROVIDER_ICON_BY_PROVIDER } from "../chat/providerIconUtils";
import { Skeleton } from "../ui/skeleton";
import { Switch } from "../ui/switch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import {
  buildUsageTokenBreakdownView,
  formatUsageModelLabel,
  formatUsagePercentage,
  formatUsageProviderLabel,
} from "./usageStatsPresentation";

const integerFormat = new Intl.NumberFormat("en-US");
const DETAIL_REFRESH_INTERVAL_MS = 5_000;

const pad = (value: number) => String(value).padStart(2, "0");

/** `Xd Xh Xm Xs`, always down to the second, no unit above days. */
function formatGeneratingTime(generatingMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(generatingMs / 1000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) {
    return `${integerFormat.format(days)}d ${pad(hours)}h ${pad(minutes)}m ${pad(seconds)}s`;
  }
  if (hours > 0) {
    return `${hours}h ${pad(minutes)}m ${pad(seconds)}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${pad(seconds)}s`;
  }
  return `${seconds}s`;
}

/**
 * Between 1 Hz server snapshots, project the generating-time counter forward
 * at `activeSessionCount` seconds per second (three concurrent sessions tick
 * 3x). Token/chat counters hold the last snapshot; the odometer animates the
 * jumps. Time never runs backwards: a projection overshoot is absorbed by
 * holding the counter until the true total catches up.
 */
function useLiveTotals(snapshot: UsageStatsSnapshot | null) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const displayedTimeFloor = useRef(0);

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 250);
    return () => clearInterval(id);
  }, []);

  if (snapshot === null) {
    return null;
  }
  const extrapolatedMs =
    snapshot.collectionEnabled && snapshot.activeSessionCount > 0
      ? Math.max(0, nowMs - snapshot.asOfMs) * snapshot.activeSessionCount
      : 0;
  const generatingMs = Math.max(
    displayedTimeFloor.current,
    snapshot.totals.generatingMs + extrapolatedMs,
  );
  displayedTimeFloor.current = generatingMs;
  return {
    outputTokens: snapshot.totals.outputTokens,
    userMessages: snapshot.totals.userMessages,
    generatingMs,
    todayGeneratingMs:
      snapshot.today.generatingMs + (snapshot.collectionEnabled ? extrapolatedMs : 0),
    activeSessionCount: snapshot.activeSessionCount,
    collectionEnabled: snapshot.collectionEnabled,
  };
}

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col items-center gap-1.5 px-2 py-5 text-center sm:px-3 sm:py-6">
      <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/70 sm:text-[11px]">
        {label}
      </span>
      <span className="text-xl font-semibold leading-none tracking-tight text-foreground tabular-nums sm:text-2xl md:text-[1.75rem]">
        {value}
      </span>
    </div>
  );
}

function TokenBreakdownSection({
  usage,
  lifetimeOutputTokens,
}: {
  usage: UsageStatsGetResult["tokenBreakdown"];
  lifetimeOutputTokens: number;
}) {
  const breakdown = useMemo(
    () => buildUsageTokenBreakdownView(usage, lifetimeOutputTokens),
    [lifetimeOutputTokens, usage],
  );
  const percentageTotal = Math.max(lifetimeOutputTokens, breakdown.attributedOutputTokens);
  const hasRows = breakdown.providers.length > 0 || breakdown.unattributedOutputTokens > 0;

  return (
    <SettingsSection
      title="Tokens by provider and model"
      headerAction={
        breakdown.attributedOutputTokens > 0 ? (
          <span className="text-[11px] tabular-nums text-muted-foreground">
            {integerFormat.format(breakdown.attributedOutputTokens)} attributed
          </span>
        ) : null
      }
    >
      {hasRows ? (
        <div aria-label="Token usage by provider and model" className="divide-y divide-border/60">
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
              <div key={providerUsage.provider} className="px-4 py-4 sm:px-5">
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
                        className="min-w-0 truncate font-mono text-[11px] text-muted-foreground"
                        title={formatUsageModelLabel(modelUsage.model)}
                      >
                        {formatUsageModelLabel(modelUsage.model)}
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
                <div className="text-[12px] font-medium text-foreground/85">Earlier usage</div>
                <div className="text-[11px] text-muted-foreground">
                  Recorded before provider and model attribution
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
          Provider and model attribution will appear after output tokens are recorded.
        </p>
      )}
    </SettingsSection>
  );
}

export function UsageStatsPanel() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const [initial, setInitial] = useState<UsageStatsGetResult | null>(null);
  const [snapshot, setSnapshot] = useState<UsageStatsSnapshot | null>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let detailRequestInFlight = false;
    let detailLoaded = false;
    const connection = getPrimaryEnvironmentConnection();
    const loadDetail = async () => {
      if (detailRequestInFlight) {
        return;
      }
      detailRequestInFlight = true;
      try {
        const result = await connection.client.server.getUsageStats();
        if (!cancelled) {
          detailLoaded = true;
          setLoadError(false);
          setInitial(result);
          // The subscription owns the live clock once it arrives. A detail
          // refresh should initialize, but never rewind, that high-rate state.
          setSnapshot((current) => current ?? result);
        }
      } catch {
        if (!cancelled && !detailLoaded) {
          setLoadError(true);
        }
      } finally {
        detailRequestInFlight = false;
      }
    };

    void loadDetail();
    // Detail responses are in-memory and model-cardinality bounded, but they
    // stay off the 10 Hz snapshot stream. Refresh only while this page exists.
    const detailRefreshId = window.setInterval(() => {
      void loadDetail();
    }, DETAIL_REFRESH_INTERVAL_MS);
    const unsubscribe = connection.client.server.subscribeUsageStats((event) => {
      if (!cancelled) {
        setSnapshot(event);
      }
    });
    return () => {
      cancelled = true;
      window.clearInterval(detailRefreshId);
      unsubscribe();
    };
  }, []);

  const totals = useLiveTotals(snapshot);
  const generating = (totals?.activeSessionCount ?? 0) > 0 && (totals?.collectionEnabled ?? false);
  // Tween the numeric counters so a coarse provider report (or the initial
  // load) races up through the intermediate values instead of snapping.
  const tokensDisplay = useCountUp(totals?.outputTokens ?? 0);
  const chatsDisplay = useCountUp(totals?.userMessages ?? 0);

  return (
    <SettingsPageContainer>
      <SettingsSection
        title="Usage"
        headerAction={
          generating ? (
            <span className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
              <span className="relative flex size-2">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary/60 motion-reduce:hidden" />
                <span className="relative inline-flex size-2 rounded-full bg-primary" />
              </span>
              {totals && totals.activeSessionCount > 1
                ? `${totals.activeSessionCount} sessions generating`
                : "Generating"}
            </span>
          ) : null
        }
      >
        {totals ? (
          <div className="grid grid-cols-3 divide-x divide-border/60">
            <StatTile label="Tokens generated" value={integerFormat.format(tokensDisplay)} />
            <StatTile label="Chats sent" value={integerFormat.format(chatsDisplay)} />
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
              <div className="grid grid-cols-3 gap-4">
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

      <TokenBreakdownSection
        usage={initial?.tokenBreakdown ?? []}
        lifetimeOutputTokens={initial?.totals.outputTokens ?? 0}
      />

      <SettingsSection title="Activity">
        <div className="px-4 py-4 sm:px-5">
          {initial ? (
            <ActivityHeatmap
              days={initial.days}
              today={
                snapshot && totals
                  ? { ...snapshot.today, generatingMs: Math.round(totals.todayGeneratingMs) }
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
