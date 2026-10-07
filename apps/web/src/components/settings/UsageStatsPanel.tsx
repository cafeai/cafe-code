import { useEffect, useMemo, useRef, useState } from "react";
import type { UsageStatsSnapshot } from "@cafecode/contracts";

import { getPrimaryEnvironmentConnection, readEnvironmentConnection } from "~/environments/runtime";
import { useWorkspaceEnvironmentId } from "~/environments/workspace";
import { useDelayedFlag } from "../../hooks/useDelayedFlag";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { ActivityHeatmap } from "../stats/ActivityHeatmap";
import { useUsageStatsDetail } from "../stats/usageStatsDetailResource";
import { getUsageRangeBounds, selectUsageRange, type UsageRangeKey } from "../stats/usageRange";
import { UsageRangeSelector } from "../stats/UsageRangeSelector";
import { InfoTip } from "../ui/info-tip";
import { Skeleton } from "../ui/skeleton";
import { Switch } from "../ui/switch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { UsageCostSection } from "./UsageCostSection";
import { formatGeneratingTime } from "./usageStatsPresentation";

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

const STAT_TILE_CLASS =
  "flex min-w-0 flex-col items-center gap-1.5 px-2 py-5 text-center @min-[40rem]/usage-page:px-3 @min-[40rem]/usage-page:py-6";
const STAT_GRID_CLASS =
  "grid grid-cols-1 divide-x divide-y divide-border-subtle @min-[40rem]/usage-page:grid-cols-3 @min-[40rem]/usage-page:divide-y-0";

function StatTile({ label, value }: { label: string; value: string }) {
  return (
    <div className={STAT_TILE_CLASS}>
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="max-w-full break-words text-xl font-semibold leading-tight tracking-tight text-foreground tabular-nums [overflow-wrap:anywhere] @min-[40rem]/usage-page:text-2xl @min-[64rem]/usage-page:text-3xl">
        {value}
      </span>
    </div>
  );
}

/**
 * First-load placeholder for the headline tiles. It reserves the loaded
 * layout but stays invisible until the wait is noticeable (docs/style-guide.md
 * §9), so fast loads never flash a skeleton.
 */
function StatTilesSkeleton({ visible }: { visible: boolean }) {
  return (
    <div aria-hidden="true" className={cn(STAT_GRID_CLASS, !visible && "invisible")}>
      {[0, 1, 2].map((column) => (
        <div key={column} className={STAT_TILE_CLASS}>
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-7 w-28 @min-[40rem]/usage-page:h-8" />
        </div>
      ))}
    </div>
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
  // One delayed flag for the whole first load: nothing appears for fast loads,
  // and once shown the skeleton stays briefly so it never flashes.
  const showSkeleton = useDelayedFlag(initial === null && !loadError);

  return (
    // Usage is a dashboard, so it uses the wide page width. Its own container
    // tracks the space left by the sidebar and the user's interface scale.
    <SettingsPageContainer width="wide" title="Usage" className="@container/usage-page min-w-0">
      <SettingsSection
        className="[&>div:first-child]:flex-wrap [&>div:first-child]:gap-2 [&>div:first-child>div]:h-auto"
        headerAction={
          <div className="flex flex-wrap items-center justify-end gap-3">
            {generating ? (
              <span className="flex items-center gap-1.5 text-2xs font-medium text-muted-foreground">
                <span className="relative flex size-2">
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-status-running/60 motion-reduce:hidden" />
                  <span className="relative inline-flex size-2 rounded-full bg-status-running" />
                </span>
                {totals && totals.activeSessionCount > 1
                  ? `${totals.activeSessionCount} chats generating`
                  : "Generating"}
              </span>
            ) : null}
            {/* Nothing to filter until a response arrives. */}
            {loadError ? null : <UsageRangeSelector value={range} onChange={setRange} />}
          </div>
        }
      >
        {loadError ? (
          <p className="px-4 py-8 text-center text-xs text-muted-foreground">
            Usage is unavailable right now. Reconnect to the server and try again.
          </p>
        ) : totals && !showSkeleton ? (
          <div className={STAT_GRID_CLASS}>
            <StatTile label="Tokens generated" value={integerFormat.format(totals.outputTokens)} />
            <StatTile label="Chats sent" value={integerFormat.format(totals.userMessages)} />
            <StatTile
              label="Time spent generating"
              value={formatGeneratingTime(totals.generatingMs)}
            />
          </div>
        ) : (
          <StatTilesSkeleton visible={showSkeleton} />
        )}
      </SettingsSection>

      {/* Without a first response there is nothing to chart; the error above
          is the one place that says so. */}
      {loadError ? null : <UsageCostSection usage={initial} range={range} />}

      {loadError ? null : (
        <SettingsSection title="Activity">
          <div className="px-4 py-4 sm:px-5">
            {initial && !showSkeleton ? (
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
              <Skeleton
                aria-hidden="true"
                className={cn("h-36 w-full", !showSkeleton && "invisible")}
              />
            )}
          </div>
        </SettingsSection>
      )}

      <SettingsSection title="Data collection">
        <SettingsRow
          title={
            <span className="inline-flex items-center gap-1.5">
              Collect usage statistics
              <InfoTip label="About usage statistics">
                Tracks tokens, chats and generating time across Cafe Code. Turning it off pauses the
                counters without clearing them.
              </InfoTip>
            </span>
          }
          description="Data stays on this machine."
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
