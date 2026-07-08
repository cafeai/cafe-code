import { useEffect, useRef, useState } from "react";
import type { UsageStatsGetResult, UsageStatsSnapshot } from "@cafecode/contracts";

import { getPrimaryEnvironmentConnection } from "~/environments/runtime";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { ActivityHeatmap } from "../stats/ActivityHeatmap";
import { useCountUp } from "../stats/useCountUp";
import { Skeleton } from "../ui/skeleton";
import { Switch } from "../ui/switch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

const integerFormat = new Intl.NumberFormat("en-US");

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

export function UsageStatsPanel() {
  const settings = useSettings();
  const { updateSettings } = useUpdateSettings();
  const [initial, setInitial] = useState<UsageStatsGetResult | null>(null);
  const [snapshot, setSnapshot] = useState<UsageStatsSnapshot | null>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const connection = getPrimaryEnvironmentConnection();
    connection.client.server
      .getUsageStats()
      .then((result) => {
        if (!cancelled) {
          setInitial(result);
          setSnapshot(result);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLoadError(true);
        }
      });
    const unsubscribe = connection.client.server.subscribeUsageStats((event) => {
      if (!cancelled) {
        setSnapshot(event);
      }
    });
    return () => {
      cancelled = true;
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
