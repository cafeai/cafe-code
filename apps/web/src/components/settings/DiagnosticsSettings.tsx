import {
  AlertTriangleIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CopyIcon,
  FolderOpenIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import type {
  ServerProcessDiagnosticsEntry,
  ServerProcessResourceHistorySummary,
  ServerProcessSignal,
  ServerRuntimeLayerDiagnosticsError,
  ServerRuntimeLayerDiagnosticsResult,
  ServerRuntimeLayerProcess,
  ServerRuntimeLayerStatus,
} from "@cafecode/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import { ensureWorkspaceApi } from "../../environments/workspaceApi";
import { useWorkspaceEnvironmentId } from "../../environments/workspace";
import { getLocalShellCapabilities } from "../../localCapabilities";
import { cn } from "../../lib/utils";
import { copyTextToClipboard } from "../../lib/copyToClipboard";
import { resolveAndPersistPreferredEditor } from "../../editorPreferences";
import { formatRelativeTime } from "../../timestampFormat";
import { useServerAvailableEditors, useServerObservability } from "../../rpc/serverState";
import {
  useProcessDiagnostics,
  useProcessResourceHistory,
} from "../../lib/processDiagnosticsState";
import { useRuntimeLayerDiagnostics } from "../../lib/runtimeLayerDiagnosticsState";
import { useTraceDiagnostics } from "../../lib/traceDiagnosticsState";
import { useDelayedFlag } from "../../hooks/useDelayedFlag";
import { Button } from "../ui/button";
import { InfoTip } from "../ui/info-tip";
import { ScrollArea } from "../ui/scroll-area";
import { SegmentedControl } from "../ui/segmented-control";
import { Skeleton } from "../ui/skeleton";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsSection, useRelativeTimeTick } from "./settingsLayout";
import {
  formatRuntimeLayerRole,
  formatRuntimeLayerStatus,
  runtimeLayerStatusClasses,
  runtimeLayerStatusTone,
  sortRuntimeLayers,
  summarizeRuntimeCpu,
  summarizeRuntimeMemory,
  visibleRuntimeErrors,
} from "./diagnosticsRuntimeViewModel";

const NUMBER_FORMAT = new Intl.NumberFormat();

function formatCount(value: number): string {
  return NUMBER_FORMAT.format(value);
}

function formatDuration(value: number): string {
  if (value < 1_000) return `${Math.round(value)} ms`;
  return `${(value / 1_000).toFixed(value >= 10_000 ? 1 : 2)} s`;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB"] as const;
  let unitIndex = -1;
  let next = value;
  do {
    next /= 1024;
    unitIndex += 1;
  } while (next >= 1024 && unitIndex < units.length - 1);
  return `${next.toFixed(next >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

function formatRelative(value: DateTime.Utc | null): string {
  if (!value) return "—";
  const relative = formatRelativeTime(DateTime.formatIso(value));
  return relative.suffix ? `${relative.value} ${relative.suffix}` : relative.value;
}

function formatRelativeNoWrap(value: DateTime.Utc | null): string {
  return formatRelative(value).replaceAll(" ", "\u00a0");
}

function formatRelativeIso(value: string | null): string {
  if (!value) return "—";
  const relative = formatRelativeTime(value);
  return relative.suffix ? `${relative.value} ${relative.suffix}` : relative.value;
}

function formatRelativeIsoNoWrap(value: string | null): string {
  return formatRelativeIso(value).replaceAll(" ", "\u00a0");
}

function shortenTraceId(traceId: string): string {
  if (traceId.length <= 32) return traceId;
  return `${traceId.slice(0, 18)}...${traceId.slice(-10)}`;
}

function isStaleProcessSignalMessage(message: string | undefined): boolean {
  return message?.includes("not a live descendant") ?? false;
}

/**
 * Placeholder for a stat whose data source has not answered yet. While the
 * first read is pending the slot keeps its final height but stays empty; a
 * skeleton appears only once the wait is noticeable (docs/style-guide.md §9).
 * A settled read without data shows a quiet dash instead of a skeleton that
 * would never resolve.
 */
function useStatPlaceholder(isInitialLoading: boolean): ReactNode {
  const showSkeleton = useDelayedFlag(isInitialLoading);
  if (showSkeleton) return <Skeleton className="my-1 h-5 w-16" />;
  if (isInitialLoading)
    return (
      <span aria-hidden className="invisible">
        0
      </span>
    );
  return <span className="text-subtle-foreground">—</span>;
}

/** Layout-matching skeleton lines for a table or list whose first read is still pending. */
function PendingRows({ rows = 3 }: { rows?: number }) {
  return (
    <div aria-hidden className="space-y-3 px-4 py-4 sm:px-5">
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className={cn("h-3.5", index === rows - 1 ? "w-2/3" : "w-full")} />
      ))}
    </div>
  );
}

function StatBlock({
  label,
  value,
  tooltip,
  tone = "default",
}: {
  label: string;
  value: ReactNode;
  tooltip?: ReactNode;
  tone?: "default" | "warning" | "danger";
}) {
  return (
    <div className="min-w-0 px-4 py-3 sm:px-5">
      <div className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
        <span className="min-w-0 truncate max-md:whitespace-normal max-md:break-words">
          {label}
        </span>
        {tooltip ? (
          <InfoTip label={`${label} details`} popupClassName="text-left">
            {tooltip}
          </InfoTip>
        ) : null}
      </div>
      <div
        className={cn(
          // Desktop keeps single-line truncation for density; on mobile (max-md)
          // let stat values wrap so text like "Not configured" is fully visible.
          "mt-1 truncate font-mono text-lg font-semibold tabular-nums text-foreground max-md:overflow-visible max-md:whitespace-normal max-md:break-words",
          tone === "warning" && "text-warning-foreground",
          tone === "danger" && "text-destructive-foreground",
        )}
      >
        {value}
      </div>
    </div>
  );
}

function StatsGrid({ children }: { children: ReactNode }) {
  return (
    <div className="relative grid grid-cols-2 sm:grid-cols-4">
      <span
        className="pointer-events-none absolute inset-y-0 left-1/2 w-px bg-border-subtle"
        aria-hidden
      />
      <span
        className="pointer-events-none absolute inset-x-0 top-1/2 h-px bg-border-subtle sm:hidden"
        aria-hidden
      />
      <span
        className="pointer-events-none absolute inset-y-0 left-1/4 hidden w-px bg-border-subtle sm:block"
        aria-hidden
      />
      <span
        className="pointer-events-none absolute inset-y-0 left-3/4 hidden w-px bg-border-subtle sm:block"
        aria-hidden
      />
      {children}
    </div>
  );
}

/**
 * Body for an empty table or list: layout-matching skeleton lines while the
 * first read is pending (after the noticeable-wait delay), otherwise the empty
 * message. Empty messages never appear before loading finishes.
 */
function EmptyRows({ label, loading = false }: { label: string; loading?: boolean }) {
  const showSkeleton = useDelayedFlag(loading);
  if (loading) {
    return showSkeleton ? <PendingRows /> : <div aria-hidden className="h-12" />;
  }
  return <div className="px-4 py-4 text-xs text-muted-foreground sm:px-5">{label}</div>;
}

const TABLE_HEAD_CLASSNAME = "border-b border-border-subtle text-2xs text-muted-foreground";

function ExpandableText({
  text,
  className,
  collapsedClassName = "line-clamp-3",
  expandLabel = "Show full error",
}: {
  text: string;
  className?: string;
  collapsedClassName?: string;
  expandLabel?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const canExpand = text.length > 180 || text.includes("\n");

  return (
    <div className={cn("min-w-0", className)}>
      <div
        className={cn(
          "whitespace-pre-wrap break-words",
          !expanded && canExpand ? collapsedClassName : null,
        )}
      >
        {text}
      </div>
      {canExpand ? (
        <button
          type="button"
          className="focus-ring mt-1 rounded-sm text-2xs font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Show less" : expandLabel}
        </button>
      ) : null}
    </div>
  );
}

function DiagnosticsTable({
  headers,
  children,
  minTableWidth = "min-w-[640px]",
  columnWidths,
}: {
  headers: ReadonlyArray<string>;
  children: ReactNode;
  minTableWidth?: string;
  columnWidths?: ReadonlyArray<string>;
}) {
  return (
    <ScrollArea
      chainVerticalScroll
      scrollFade
      hideScrollbars
      className="w-full max-w-full rounded-none"
    >
      <table
        className={cn("w-full text-left text-xs", minTableWidth, columnWidths && "table-fixed")}
      >
        {columnWidths ? (
          <colgroup>
            {headers.map((header, index) => (
              <col key={header} className={columnWidths[index]} />
            ))}
          </colgroup>
        ) : null}
        <thead className={TABLE_HEAD_CLASSNAME}>
          <tr>
            {headers.map((header, index) => (
              <th
                key={header}
                className={cn(
                  "whitespace-nowrap px-4 py-2.5 font-medium first:sm:pl-5 last:sm:pr-5",
                  !columnWidths && index === headers.length - 1 && "w-px",
                )}
              >
                {header.replaceAll(" ", "\u00a0")}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border-subtle">{children}</tbody>
      </table>
    </ScrollArea>
  );
}

function TraceIdCell({ traceId }: { traceId: string }) {
  const [copied, setCopied] = useState(false);
  const copyTraceId = useCallback(() => {
    void copyTextToClipboard(traceId)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1_200);
      })
      .catch(() => undefined);
  }, [traceId]);

  return (
    <div className="flex w-full min-w-0 max-w-full items-center gap-2">
      <Tooltip>
        <TooltipTrigger
          render={
            <span className="min-w-0 flex-1 truncate font-mono text-2xs">
              {shortenTraceId(traceId)}
            </span>
          }
        />
        <TooltipPopup
          side="top"
          className="max-w-[min(520px,calc(100vw-2rem))] break-all font-mono text-2xs"
        >
          {traceId}
        </TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className="focus-ring inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label={copied ? "Copied trace ID" : "Copy trace ID"}
              onClick={copyTraceId}
            >
              <CopyIcon className="size-3" />
            </button>
          }
        />
        <TooltipPopup side="top">{copied ? "Copied" : "Copy full trace ID"}</TooltipPopup>
      </Tooltip>
    </div>
  );
}

function formatProcessName(command: string): string {
  const firstToken = command.trim().split(/\s+/)[0];
  if (!firstToken) return command;
  const normalized = firstToken.replace(/^['"]|['"]$/g, "");
  const segments = normalized.split(/[\\/]/).filter(Boolean);
  return segments.at(-1) ?? normalized;
}

function formatProcessType(process: ServerProcessDiagnosticsEntry): string {
  if (process.depth > 0) return "Subprocess";
  if (/\b(codex|claude)\b/i.test(process.command)) return "Agent";
  return "Process";
}

function ProcessNameCell({
  process,
  isExpanded,
  onToggle,
}: {
  process: ServerProcessDiagnosticsEntry;
  isExpanded: boolean;
  onToggle: (pid: number) => void;
}) {
  const name = formatProcessName(process.command);
  const hasChildren = process.childPids.length > 0;
  const ChevronIcon = isExpanded ? ChevronDownIcon : ChevronRightIcon;

  return (
    <div
      className="grid min-w-0 grid-cols-[1.25rem_0.375rem_minmax(0,1fr)] items-center gap-2"
      style={{ paddingLeft: `${Math.min(process.depth, 6) * 10}px` }}
    >
      {hasChildren ? (
        <button
          type="button"
          className="focus-ring inline-flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label={isExpanded ? `Collapse ${name}` : `Expand ${name}`}
          onClick={() => onToggle(process.pid)}
        >
          <ChevronIcon className="size-3.5" />
        </button>
      ) : (
        <span className="size-5 shrink-0" aria-hidden="true" />
      )}
      <span className="size-1.5 shrink-0 rounded-full bg-success" />
      <Tooltip>
        <TooltipTrigger
          render={<span className="min-w-0 truncate font-medium text-foreground">{name}</span>}
        />
        <TooltipPopup
          side="top"
          className="max-w-[min(440px,calc(100vw-2rem))] whitespace-normal break-words text-left font-mono text-2xs leading-relaxed text-wrap"
        >
          {process.command}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}

function ProcessSignalActions({
  process,
  isSignaling,
  onSignal,
}: {
  process: ServerProcessDiagnosticsEntry;
  isSignaling: boolean;
  onSignal: (pid: number, signal: ServerProcessSignal) => void;
}) {
  return (
    <div className="flex items-center justify-end gap-1.5">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              disabled={isSignaling}
              className="focus-ring rounded-sm text-2xs font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:pointer-events-none disabled:opacity-50"
              onClick={() => onSignal(process.pid, "SIGINT")}
            >
              INT
            </button>
          }
        />
        <TooltipPopup side="top">Send SIGINT</TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              disabled={isSignaling}
              className="focus-ring rounded-sm text-2xs font-medium text-destructive-foreground underline-offset-2 hover:underline disabled:pointer-events-none disabled:opacity-50"
              onClick={() => onSignal(process.pid, "SIGKILL")}
            >
              KILL
            </button>
          }
        />
        <TooltipPopup side="top">Send SIGKILL</TooltipPopup>
      </Tooltip>
    </div>
  );
}

function ProcessDiagnosticsTable({
  processes,
  signalingPid,
  onSignal,
  loading,
}: {
  processes: ReadonlyArray<ServerProcessDiagnosticsEntry>;
  signalingPid: number | null;
  onSignal: (pid: number, signal: ServerProcessSignal) => void;
  loading: boolean;
}) {
  const [collapsedPids, setCollapsedPids] = useState<ReadonlySet<number>>(() => new Set());
  const visibleProcesses = useMemo(() => {
    const visible: ServerProcessDiagnosticsEntry[] = [];
    let hiddenChildDepth: number | null = null;

    for (const process of processes) {
      if (hiddenChildDepth !== null) {
        if (process.depth > hiddenChildDepth) continue;
        hiddenChildDepth = null;
      }

      visible.push(process);
      if (collapsedPids.has(process.pid)) {
        hiddenChildDepth = process.depth;
      }
    }

    return visible;
  }, [collapsedPids, processes]);

  const toggleProcess = useCallback((pid: number) => {
    setCollapsedPids((previous) => {
      const next = new Set(previous);
      if (next.has(pid)) {
        next.delete(pid);
      } else {
        next.add(pid);
      }
      return next;
    });
  }, []);

  return (
    <ScrollArea
      chainVerticalScroll
      scrollFade
      hideScrollbars
      className="max-h-[min(64vh,44rem)] w-full max-w-full rounded-none border-t border-border-subtle"
    >
      <table className="w-full min-w-[1040px] table-fixed text-left text-xs">
        <colgroup>
          <col className="w-[24%]" />
          <col className="w-[8%]" />
          <col className="w-[10%]" />
          <col className="w-[33%]" />
          <col className="w-[8%]" />
          <col className="w-[11%]" />
          <col className="w-[6%]" />
        </colgroup>
        <thead className={cn("sticky top-0 z-10 bg-card", TABLE_HEAD_CLASSNAME)}>
          <tr>
            <th className="px-4 py-2 font-medium sm:pl-5">Name</th>
            <th className="px-3 py-2 text-right font-medium">CPU</th>
            <th className="px-3 py-2 text-right font-medium">Memory</th>
            <th className="px-3 py-2 font-medium">Command</th>
            <th className="px-3 py-2 text-right font-medium">PID</th>
            <th className="px-3 py-2 font-medium">Type</th>
            <th className="p-2 text-right font-medium sm:pr-4">Signal</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border-subtle">
          {visibleProcesses.length === 0 ? (
            <tr>
              <td colSpan={7} className="p-0">
                <EmptyRows loading={loading} label="No child processes running." />
              </td>
            </tr>
          ) : null}
          {visibleProcesses.map((process) => (
            <tr key={process.pid} className="hover:bg-muted/20">
              <td className="px-4 py-2 align-middle sm:pl-5">
                <ProcessNameCell
                  process={process}
                  isExpanded={!collapsedPids.has(process.pid)}
                  onToggle={toggleProcess}
                />
              </td>
              <td className="px-3 py-2 text-right align-middle font-mono tabular-nums">
                {process.cpuPercent.toFixed(1)}%
              </td>
              <td className="px-3 py-2 text-right align-middle font-mono tabular-nums">
                {formatBytes(process.rssBytes)}
              </td>
              <td className="px-3 py-2 align-middle text-muted-foreground">
                <Tooltip>
                  <TooltipTrigger
                    render={<span className="block truncate">{process.command}</span>}
                  />
                  <TooltipPopup
                    side="top"
                    className="max-w-[min(440px,calc(100vw-2rem))] whitespace-normal break-words text-left font-mono text-2xs leading-relaxed text-wrap"
                  >
                    {process.command}
                  </TooltipPopup>
                </Tooltip>
              </td>
              <td className="px-3 py-2 text-right align-middle font-mono tabular-nums text-muted-foreground">
                {process.pid}
              </td>
              <td className="truncate px-3 py-2 align-middle text-muted-foreground">
                {formatProcessType(process)}
              </td>
              <td className="p-2 align-middle sm:pr-4">
                <ProcessSignalActions
                  process={process}
                  isSignaling={signalingPid === process.pid}
                  onSignal={onSignal}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollArea>
  );
}

const RESOURCE_HISTORY_WINDOWS = [
  { label: "5m", windowMs: 5 * 60_000, bucketMs: 30_000 },
  { label: "15m", windowMs: 15 * 60_000, bucketMs: 60_000 },
  { label: "30m", windowMs: 30 * 60_000, bucketMs: 2 * 60_000 },
  { label: "1h", windowMs: 60 * 60_000, bucketMs: 5 * 60_000 },
] as const;

function formatCpuTime(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(seconds >= 10 ? 1 : 2)}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${minutes.toFixed(minutes >= 10 ? 1 : 2)}m`;
  return `${(minutes / 60).toFixed(2)}h`;
}

function formatShortProcessName(command: string): string {
  const name = formatProcessName(command);
  return name.length > 42 ? `${name.slice(0, 39)}...` : name;
}

function ResourceHistoryProcessNameCell({
  process,
  visualDepth,
}: {
  process: ServerProcessResourceHistorySummary;
  visualDepth: number;
}) {
  const name = formatShortProcessName(process.command);

  return (
    <div
      className="grid min-w-0 grid-cols-[1.25rem_0.375rem_minmax(0,1fr)] items-center gap-2"
      style={{ paddingLeft: `${Math.min(visualDepth, 6) * 10}px` }}
      aria-label={`${process.isServerRoot ? "Root" : "Child"} process ${name}`}
    >
      <span className="size-5 shrink-0" aria-hidden="true" />
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          process.isServerRoot ? "bg-warning" : "bg-success",
        )}
      />
      <Tooltip>
        <TooltipTrigger
          render={<span className="min-w-0 truncate font-medium text-foreground">{name}</span>}
        />
        <TooltipPopup
          side="top"
          className="max-w-[min(440px,calc(100vw-2rem))] whitespace-normal break-words text-left font-mono text-2xs leading-relaxed text-wrap"
        >
          {process.command}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}

function ProcessResourceHistoryChart({
  buckets,
}: {
  buckets: ReadonlyArray<{
    readonly startedAt: DateTime.Utc;
    readonly avgCpuPercent: number;
    readonly maxCpuPercent: number;
  }>;
}) {
  const maxCpuPercent = Math.max(1, ...buckets.map((bucket) => bucket.maxCpuPercent));

  return (
    <div className="border-t border-border-subtle px-4 py-3 sm:px-5">
      <div className="flex h-28 items-end gap-1 overflow-hidden rounded-sm bg-muted/10 p-2">
        {buckets.map((bucket) => {
          const peakHeight = Math.max(2, (bucket.maxCpuPercent / maxCpuPercent) * 100);
          const averageHeight = Math.max(2, (bucket.avgCpuPercent / maxCpuPercent) * 100);
          return (
            <Tooltip key={DateTime.formatIso(bucket.startedAt)}>
              <TooltipTrigger
                render={
                  <div className="flex h-full min-w-1 flex-1 items-end">
                    <div
                      className="relative h-full w-full"
                      aria-label={`Average CPU ${bucket.avgCpuPercent.toFixed(1)}%, peak CPU ${bucket.maxCpuPercent.toFixed(1)}%`}
                    >
                      <div
                        className="absolute inset-x-0 bottom-0 rounded-t-sm bg-foreground/15 transition-colors"
                        style={{ height: `${peakHeight}%` }}
                      />
                      <div
                        className="absolute inset-x-0 bottom-0 rounded-t-sm bg-foreground/60 transition-colors"
                        style={{ height: `${averageHeight}%` }}
                      />
                    </div>
                  </div>
                }
              />
              <TooltipPopup side="top">
                Avg {bucket.avgCpuPercent.toFixed(1)}%, peak {bucket.maxCpuPercent.toFixed(1)}%
              </TooltipPopup>
            </Tooltip>
          );
        })}
      </div>
    </div>
  );
}

function ResourceHistoryWindowSelector({
  selectedWindowMs,
  onSelect,
}: {
  selectedWindowMs: number;
  onSelect: (windowMs: number) => void;
}) {
  const selectedLabel =
    RESOURCE_HISTORY_WINDOWS.find((option) => option.windowMs === selectedWindowMs)?.label ??
    RESOURCE_HISTORY_WINDOWS[1].label;
  return (
    <SegmentedControl
      size="xs"
      aria-label="Resource history window"
      value={selectedLabel}
      onValueChange={(label) => {
        const option = RESOURCE_HISTORY_WINDOWS.find((entry) => entry.label === label);
        if (option) onSelect(option.windowMs);
      }}
      options={RESOURCE_HISTORY_WINDOWS.map((option) => ({
        value: option.label,
        label: option.label,
      }))}
    />
  );
}

function ProcessResourceHistoryTable({
  processes,
  loading,
}: {
  processes: ReadonlyArray<ServerProcessResourceHistorySummary>;
  loading: boolean;
}) {
  const shallowestChildDepth = processes.reduce<number | null>((minDepth, process) => {
    if (process.isServerRoot) return minDepth;
    return minDepth === null ? process.depth : Math.min(minDepth, process.depth);
  }, null);

  return (
    <ScrollArea
      chainVerticalScroll
      scrollFade
      hideScrollbars
      className="max-h-[min(64vh,44rem)] w-full max-w-full border-t border-border-subtle"
    >
      <table className="w-full min-w-[980px] table-fixed text-left text-xs">
        <colgroup>
          <col className="w-[24%]" />
          <col className="w-[10%]" />
          <col className="w-[10%]" />
          <col className="w-[10%]" />
          <col className="w-[10%]" />
          <col className="w-[10%]" />
          <col className="w-[16%]" />
          <col className="w-[10%]" />
        </colgroup>
        <thead className={cn("sticky top-0 z-10 bg-card", TABLE_HEAD_CLASSNAME)}>
          <tr>
            <th className="px-4 py-2 font-medium sm:pl-5">Process</th>
            <th className="px-3 py-2 text-right font-medium">CPU time</th>
            <th className="px-3 py-2 text-right font-medium">Current</th>
            <th className="px-3 py-2 text-right font-medium">Average</th>
            <th className="px-3 py-2 text-right font-medium">Peak</th>
            <th className="px-3 py-2 text-right font-medium">Max memory</th>
            <th className="px-3 py-2 font-medium">Command</th>
            <th className="px-3 py-2 text-right font-medium sm:pr-5">PID</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border-subtle">
          {processes.length === 0 ? (
            <tr>
              <td colSpan={8} className="p-0">
                <EmptyRows loading={loading} label="No samples in this window yet." />
              </td>
            </tr>
          ) : null}
          {processes.map((process) => (
            <tr key={process.processKey} className="hover:bg-muted/20">
              <td className="px-4 py-2 align-middle sm:pl-5">
                <ResourceHistoryProcessNameCell
                  process={process}
                  visualDepth={
                    process.isServerRoot || shallowestChildDepth === null
                      ? 0
                      : Math.max(1, process.depth - shallowestChildDepth + 1)
                  }
                />
              </td>
              <td className="px-3 py-2 text-right align-middle font-mono tabular-nums">
                {formatCpuTime(process.cpuSecondsApprox)}
              </td>
              <td className="px-3 py-2 text-right align-middle font-mono tabular-nums">
                {process.currentCpuPercent.toFixed(1)}%
              </td>
              <td className="px-3 py-2 text-right align-middle font-mono tabular-nums">
                {process.avgCpuPercent.toFixed(1)}%
              </td>
              <td className="px-3 py-2 text-right align-middle font-mono tabular-nums">
                {process.maxCpuPercent.toFixed(1)}%
              </td>
              <td className="px-3 py-2 text-right align-middle font-mono tabular-nums">
                {formatBytes(process.maxRssBytes)}
              </td>
              <td className="px-3 py-2 align-middle text-muted-foreground">
                <Tooltip>
                  <TooltipTrigger
                    render={<span className="block truncate">{process.command}</span>}
                  />
                  <TooltipPopup
                    side="top"
                    className="max-w-[min(440px,calc(100vw-2rem))] whitespace-normal break-words text-left font-mono text-2xs leading-relaxed text-wrap"
                  >
                    {process.command}
                  </TooltipPopup>
                </Tooltip>
              </td>
              <td className="px-3 py-2 text-right align-middle font-mono tabular-nums text-muted-foreground sm:pr-5">
                {process.pid}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollArea>
  );
}

/**
 * "Checked 5s ago" is metadata, so it lives in the refresh tooltip rather than
 * as ticking header text (docs/style-guide.md §10). The tooltip content only
 * mounts while open, so the relative-time tick costs nothing otherwise.
 */
function DiagnosticsLastChecked({ checkedAt }: { checkedAt: string | null }) {
  useRelativeTimeTick();
  const relative = checkedAt ? formatRelativeTime(checkedAt) : null;
  if (!relative) return <>Not checked yet</>;
  return (
    <>
      Checked <span className="tabular-nums">{relative.value}</span>
      {relative.suffix ? ` ${relative.suffix}` : null}
    </>
  );
}

function DiagnosticsRefreshButton({
  isPending,
  label,
  checkedAt,
  onClick,
}: {
  isPending: boolean;
  label: string;
  checkedAt: string | null;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
            disabled={isPending}
            onClick={onClick}
            aria-label={label}
          >
            <RefreshCwIcon className={cn("size-3", isPending && "animate-spin")} />
          </Button>
        }
      />
      <TooltipPopup side="top">
        <div>{label}</div>
        <div className="text-2xs text-muted-foreground">
          <DiagnosticsLastChecked checkedAt={checkedAt} />
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}

function RuntimeStatusBadge({ status }: { status: ServerRuntimeLayerStatus }) {
  return (
    <span
      className={cn(
        "inline-flex whitespace-nowrap rounded-sm px-1.5 py-0.5 text-2xs font-medium",
        runtimeLayerStatusClasses(status),
      )}
    >
      {formatRuntimeLayerStatus(status)}
    </span>
  );
}

function RuntimeDiagnosticsErrors({
  errors,
}: {
  errors: ReadonlyArray<ServerRuntimeLayerDiagnosticsError>;
}) {
  if (errors.length === 0) return null;

  return (
    <div className="space-y-2 border-t border-border-subtle px-4 py-3 text-xs sm:px-5">
      {errors.map((error) => (
        <div
          key={`${error.source}:${error.message}`}
          className="flex items-start gap-2 text-warning-foreground"
        >
          <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
          <div className="min-w-0">
            <span className="font-medium">{formatRuntimeLayerRole(error.source)}</span>
            <ExpandableText
              text={error.message}
              collapsedClassName="line-clamp-2"
              expandLabel="Show full message"
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function RuntimeLayersTable({
  data,
  loading,
}: {
  data: ServerRuntimeLayerDiagnosticsResult | null;
  loading: boolean;
}) {
  const layers = data ? sortRuntimeLayers(data.runtimeLayers) : [];
  if (layers.length === 0) {
    return <EmptyRows loading={loading} label="No runtime layers found." />;
  }

  return (
    <DiagnosticsTable
      headers={["Layer", "Status", "PID", "Memory", "CPU", "Uptime", "Last event", "Notes"]}
      minTableWidth="min-w-[980px]"
      columnWidths={[
        "w-[16%]",
        "w-[10%]",
        "w-[8%]",
        "w-[10%]",
        "w-[8%]",
        "w-[10%]",
        "w-[12%]",
        "w-[26%]",
      ]}
    >
      {layers.map((layer) => (
        <tr key={layer.role} className="hover:bg-muted/15">
          <td className="px-4 py-3 align-top font-medium text-foreground first:sm:pl-5">
            {formatRuntimeLayerRole(layer.role)}
          </td>
          <td className="px-4 py-3 align-top">
            <RuntimeStatusBadge status={layer.status} />
          </td>
          <td className="px-4 py-3 align-top text-right font-mono tabular-nums">
            {layer.pid ?? "—"}
          </td>
          <td className="px-4 py-3 align-top text-right font-mono tabular-nums">
            {formatBytes(layer.rssBytes)}
          </td>
          <td className="px-4 py-3 align-top text-right font-mono tabular-nums">
            {layer.cpuPercent.toFixed(1)}%
          </td>
          <td className="px-4 py-3 align-top font-mono tabular-nums text-muted-foreground">
            {layer.uptimeLabel ?? "—"}
          </td>
          <td className="px-4 py-3 align-top font-mono tabular-nums text-muted-foreground">
            {formatRelativeIsoNoWrap(layer.lastEventAt)}
          </td>
          <td className="px-4 py-3 align-top text-muted-foreground last:sm:pr-5">
            <ExpandableText
              text={layer.notes.length > 0 ? layer.notes.join("\n") : "—"}
              collapsedClassName="line-clamp-2"
              expandLabel="Show notes"
            />
          </td>
        </tr>
      ))}
    </DiagnosticsTable>
  );
}

function RuntimeProcessNameCell({
  process,
  isExpanded,
  onToggle,
}: {
  process: ServerRuntimeLayerProcess;
  isExpanded: boolean;
  onToggle: (pid: number) => void;
}) {
  const hasChildren = process.childPids.length > 0 && process.pid !== null;
  const ChevronIcon = isExpanded ? ChevronDownIcon : ChevronRightIcon;

  return (
    <div
      className="grid min-w-0 grid-cols-[1.25rem_0.375rem_minmax(0,1fr)] items-center gap-2"
      style={{ paddingLeft: `${Math.min(process.depth, 6) * 10}px` }}
    >
      {hasChildren && process.pid !== null ? (
        <button
          type="button"
          className="focus-ring inline-flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label={
            isExpanded ? `Collapse ${process.commandLabel}` : `Expand ${process.commandLabel}`
          }
          onClick={() => onToggle(process.pid!)}
        >
          <ChevronIcon className="size-3.5" />
        </button>
      ) : (
        <span className="size-5 shrink-0" aria-hidden="true" />
      )}
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          process.status === "missing" ? "bg-destructive" : "bg-info",
        )}
      />
      <Tooltip>
        <TooltipTrigger
          render={
            <span className="min-w-0 truncate font-medium text-foreground">
              {process.commandLabel}
            </span>
          }
        />
        <TooltipPopup
          side="top"
          className="max-w-[min(440px,calc(100vw-2rem))] whitespace-normal break-words text-left font-mono text-2xs leading-relaxed text-wrap"
        >
          {process.sanitizedCommand}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}

function RuntimeProcessTable({
  processes,
  loading,
}: {
  processes: ReadonlyArray<ServerRuntimeLayerProcess>;
  loading: boolean;
}) {
  const [collapsedPids, setCollapsedPids] = useState<ReadonlySet<number>>(() => new Set());
  const visibleProcesses = useMemo(() => {
    const visible: ServerRuntimeLayerProcess[] = [];
    let hiddenChildDepth: number | null = null;

    for (const process of processes) {
      if (hiddenChildDepth !== null) {
        if (process.depth > hiddenChildDepth) continue;
        hiddenChildDepth = null;
      }

      visible.push(process);
      if (process.pid !== null && collapsedPids.has(process.pid)) {
        hiddenChildDepth = process.depth;
      }
    }

    return visible;
  }, [collapsedPids, processes]);

  const toggleProcess = useCallback((pid: number) => {
    setCollapsedPids((previous) => {
      const next = new Set(previous);
      if (next.has(pid)) {
        next.delete(pid);
      } else {
        next.add(pid);
      }
      return next;
    });
  }, []);

  return (
    <ScrollArea
      chainVerticalScroll
      scrollFade
      hideScrollbars
      className="max-h-[min(64vh,44rem)] w-full max-w-full rounded-none border-t border-border-subtle"
    >
      <table className="w-full min-w-[1040px] table-fixed text-left text-xs">
        <colgroup>
          <col className="w-[22%]" />
          <col className="w-[14%]" />
          <col className="w-[10%]" />
          <col className="w-[8%]" />
          <col className="w-[10%]" />
          <col className="w-[8%]" />
          <col className="w-[10%]" />
          <col className="w-[18%]" />
        </colgroup>
        <thead className={cn("sticky top-0 z-10 bg-card", TABLE_HEAD_CLASSNAME)}>
          <tr>
            <th className="px-4 py-2 font-medium sm:pl-5">Process</th>
            <th className="px-3 py-2 font-medium">Role</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 text-right font-medium">PID</th>
            <th className="px-3 py-2 text-right font-medium">Memory</th>
            <th className="px-3 py-2 text-right font-medium">CPU</th>
            <th className="px-3 py-2 font-medium">Owner</th>
            <th className="px-3 py-2 font-medium sm:pr-5">Command</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border-subtle">
          {visibleProcesses.length === 0 ? (
            <tr>
              <td colSpan={8} className="p-0">
                <EmptyRows loading={loading} label="No runtime processes found." />
              </td>
            </tr>
          ) : null}
          {visibleProcesses.map((process) => (
            <tr
              key={`${process.role}:${process.pid ?? "missing"}:${process.commandLabel}`}
              className="hover:bg-muted/20"
            >
              <td className="px-4 py-2 align-middle sm:pl-5">
                <RuntimeProcessNameCell
                  process={process}
                  isExpanded={process.pid === null ? true : !collapsedPids.has(process.pid)}
                  onToggle={toggleProcess}
                />
              </td>
              <td className="px-3 py-2 align-middle text-muted-foreground">
                {formatRuntimeLayerRole(process.role)}
              </td>
              <td className="px-3 py-2 align-middle font-mono text-muted-foreground">
                {process.status}
              </td>
              <td className="px-3 py-2 text-right align-middle font-mono tabular-nums">
                {process.pid ?? "—"}
              </td>
              <td className="px-3 py-2 text-right align-middle font-mono tabular-nums">
                {formatBytes(process.rssBytes)}
              </td>
              <td className="px-3 py-2 text-right align-middle font-mono tabular-nums">
                {process.cpuPercent.toFixed(1)}%
              </td>
              <td className="truncate px-3 py-2 align-middle text-muted-foreground">
                {process.attribution}
              </td>
              <td className="px-3 py-2 align-middle text-muted-foreground sm:pr-5">
                <Tooltip>
                  <TooltipTrigger
                    render={<span className="block truncate">{process.sanitizedCommand}</span>}
                  />
                  <TooltipPopup
                    side="top"
                    className="max-w-[min(520px,calc(100vw-2rem))] whitespace-normal break-words text-left font-mono text-2xs leading-relaxed text-wrap"
                  >
                    {process.sanitizedCommand}
                  </TooltipPopup>
                </Tooltip>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollArea>
  );
}

function OrchestratorHealthTables({
  data,
  loading,
}: {
  data: ServerRuntimeLayerDiagnosticsResult | null;
  loading: boolean;
}) {
  if (!data) {
    return <EmptyRows loading={loading} label="No orchestrator data." />;
  }

  return (
    <div className="grid gap-0 border-t border-border-subtle lg:grid-cols-2 lg:divide-x lg:divide-border-subtle">
      <div className="min-w-0">
        <DiagnosticsTable
          headers={["Event type", "Count", "Actor", "Last seen"]}
          minTableWidth="min-w-[620px]"
        >
          {data.orchestrator.recentEventTypeCounts.length === 0 ? (
            <tr>
              <td colSpan={4} className="px-4 py-4 text-muted-foreground sm:px-5">
                No recent orchestration events.
              </td>
            </tr>
          ) : (
            data.orchestrator.recentEventTypeCounts.map((event) => (
              <tr key={`${event.eventType}:${event.actorKind ?? "none"}`}>
                <td className="px-4 py-3 align-top font-mono text-2xs first:sm:pl-5">
                  {event.eventType}
                </td>
                <td className="px-4 py-3 text-right align-top font-mono tabular-nums">
                  {formatCount(event.count)}
                </td>
                <td className="px-4 py-3 align-top text-muted-foreground">
                  {event.actorKind ?? "—"}
                </td>
                <td className="px-4 py-3 align-top font-mono tabular-nums text-muted-foreground last:sm:pr-5">
                  {formatRelativeIsoNoWrap(event.lastSeenAt)}
                </td>
              </tr>
            ))
          )}
        </DiagnosticsTable>
      </div>
      <div className="min-w-0 border-t border-border-subtle lg:border-t-0">
        <DiagnosticsTable
          headers={["Projector", "Cursor", "Lag", "Status"]}
          minTableWidth="min-w-[520px]"
        >
          {data.orchestrator.projectorCursors.length === 0 ? (
            <tr>
              <td colSpan={4} className="px-4 py-4 text-muted-foreground sm:px-5">
                No projector cursors found.
              </td>
            </tr>
          ) : (
            data.orchestrator.projectorCursors.map((projector) => (
              <tr key={projector.projector}>
                <td className="px-4 py-3 align-top font-medium first:sm:pl-5">
                  {projector.projector}
                </td>
                <td className="px-4 py-3 text-right align-top font-mono tabular-nums">
                  {formatCount(projector.cursor)}
                </td>
                <td className="px-4 py-3 text-right align-top font-mono tabular-nums">
                  {formatCount(projector.lag)}
                </td>
                <td className="px-4 py-3 align-top last:sm:pr-5">
                  <RuntimeStatusBadge status={projector.status} />
                </td>
              </tr>
            ))
          )}
        </DiagnosticsTable>
      </div>
    </div>
  );
}

function ProviderDaemonTables({
  data,
  loading,
}: {
  data: ServerRuntimeLayerDiagnosticsResult | null;
  loading: boolean;
}) {
  if (!data) {
    return <EmptyRows loading={loading} label="No provider daemon data." />;
  }

  return (
    <div className="grid gap-0 border-t border-border-subtle lg:grid-cols-2 lg:divide-x lg:divide-border-subtle">
      <DiagnosticsTable
        headers={["Status", "Method", "Duration", "Updated", "Error"]}
        minTableWidth="min-w-[720px]"
      >
        {data.providerDaemon.recentCommands.length === 0 ? (
          <tr>
            <td colSpan={5} className="px-4 py-4 text-muted-foreground sm:px-5">
              No recent daemon commands.
            </td>
          </tr>
        ) : (
          data.providerDaemon.recentCommands.map((command) => (
            <tr
              key={`${command.status}:${command.method}:${command.updatedAt}:${
                command.durationMs ?? "—"
              }:${command.error ?? "ok"}`}
            >
              <td className="px-4 py-3 align-top first:sm:pl-5">
                <span className="rounded-sm bg-muted px-1.5 py-0.5 font-mono text-2xs">
                  {command.status}
                </span>
              </td>
              <td className="px-4 py-3 align-top font-mono text-2xs">{command.method}</td>
              <td className="px-4 py-3 text-right align-top font-mono tabular-nums">
                {command.durationMs === null ? "—" : formatDuration(command.durationMs)}
              </td>
              <td className="px-4 py-3 align-top font-mono tabular-nums text-muted-foreground">
                {formatRelativeIsoNoWrap(command.updatedAt)}
              </td>
              <td className="px-4 py-3 align-top text-muted-foreground last:sm:pr-5">
                {command.error ? (
                  <ExpandableText
                    text={command.error}
                    collapsedClassName="line-clamp-2"
                    expandLabel="Show full error"
                  />
                ) : (
                  "—"
                )}
              </td>
            </tr>
          ))
        )}
      </DiagnosticsTable>
      <DiagnosticsTable
        headers={["Runtime event", "Count", "Last seen"]}
        minTableWidth="min-w-[520px]"
      >
        {data.providerDaemon.runtimeEventSummaries.length === 0 ? (
          <tr>
            <td colSpan={3} className="px-4 py-4 text-muted-foreground sm:px-5">
              No recent daemon runtime events.
            </td>
          </tr>
        ) : (
          data.providerDaemon.runtimeEventSummaries.map((event) => (
            <tr key={event.eventType}>
              <td className="px-4 py-3 align-top font-mono text-2xs first:sm:pl-5">
                {event.eventType}
              </td>
              <td className="px-4 py-3 text-right align-top font-mono tabular-nums">
                {formatCount(event.count)}
              </td>
              <td className="px-4 py-3 align-top font-mono tabular-nums text-muted-foreground last:sm:pr-5">
                {formatRelativeIsoNoWrap(event.lastSeenAt)}
              </td>
            </tr>
          ))
        )}
      </DiagnosticsTable>
    </div>
  );
}

function ProviderSupervisorTable({
  data,
  loading,
}: {
  data: ServerRuntimeLayerDiagnosticsResult | null;
  loading: boolean;
}) {
  if (!data) {
    return <EmptyRows loading={loading} label="No supervisor data." />;
  }

  const sessionCounts = Object.entries(data.providerSupervisor.sessionCounts);
  return (
    <DiagnosticsTable headers={["Session state", "Count"]} minTableWidth="min-w-[420px]">
      {sessionCounts.length === 0 ? (
        <tr>
          <td colSpan={2} className="px-4 py-4 text-muted-foreground sm:px-5">
            No supervisor session counts found.
          </td>
        </tr>
      ) : (
        sessionCounts.map(([state, count]) => (
          <tr key={state}>
            <td className="px-4 py-3 align-top font-medium first:sm:pl-5">{state}</td>
            <td className="px-4 py-3 text-right align-top font-mono tabular-nums last:sm:pr-5">
              {formatCount(count)}
            </td>
          </tr>
        ))
      )}
    </DiagnosticsTable>
  );
}

export function DiagnosticsSettingsPanel() {
  const observability = useServerObservability();
  const availableEditors = useServerAvailableEditors();
  const environmentId = useWorkspaceEnvironmentId();
  const canOpenLocalEditor = getLocalShellCapabilities(environmentId).canOpenLocalEditor;
  const [resourceWindowMs, setResourceWindowMs] = useState(15 * 60_000);
  const selectedResourceWindow =
    RESOURCE_HISTORY_WINDOWS.find((option) => option.windowMs === resourceWindowMs) ??
    RESOURCE_HISTORY_WINDOWS[1];
  const {
    data: runtimeData,
    error: runtimeError,
    isPending: isRuntimePending,
    refresh: refreshRuntime,
  } = useRuntimeLayerDiagnostics();
  const { data, error, isPending, refresh } = useTraceDiagnostics();
  const {
    data: processData,
    error: processError,
    isPending: isProcessPending,
    refresh: refreshProcesses,
  } = useProcessDiagnostics();
  const {
    data: resourceData,
    error: resourceError,
    isPending: isResourcePending,
    refresh: refreshResources,
  } = useProcessResourceHistory({
    windowMs: selectedResourceWindow.windowMs,
    bucketMs: selectedResourceWindow.bucketMs,
  });
  const [isOpeningLogsDirectory, setIsOpeningLogsDirectory] = useState(false);
  const [openLogsDirectoryError, setOpenLogsDirectoryError] = useState<string | null>(null);
  const [signalingPid, setSignalingPid] = useState<number | null>(null);

  const openLogsDirectory = useCallback(() => {
    const logsDirectoryPath = observability?.logsDirectoryPath ?? null;
    if (!logsDirectoryPath) return;

    if (!canOpenLocalEditor) {
      void Promise.resolve()
        .then(() => copyTextToClipboard(logsDirectoryPath))
        .then(
          () => {
            toastManager.add({
              title: "Logs path copied",
              description: logsDirectoryPath,
              type: "success",
            });
          },
          (error: unknown) => {
            setOpenLogsDirectoryError(
              error instanceof Error ? error.message : "Unable to copy logs folder path.",
            );
          },
        );
      return;
    }

    const editor = resolveAndPersistPreferredEditor(availableEditors ?? []);
    if (!editor) {
      setOpenLogsDirectoryError("No available editors found.");
      return;
    }

    setIsOpeningLogsDirectory(true);
    setOpenLogsDirectoryError(null);
    void ensureWorkspaceApi()
      .shell.openInEditor(logsDirectoryPath, editor)
      .catch((error: unknown) => {
        setOpenLogsDirectoryError(
          error instanceof Error ? error.message : "Unable to open logs folder.",
        );
      })
      .finally(() => {
        setIsOpeningLogsDirectory(false);
      });
  }, [availableEditors, canOpenLocalEditor, observability?.logsDirectoryPath]);

  const isInitialLoading = isPending && data === null;
  const isRuntimeInitialLoading = isRuntimePending && runtimeData === null;
  const isProcessInitialLoading = isProcessPending && processData === null;
  const isResourceInitialLoading = isResourcePending && resourceData === null;
  // One placeholder per data source so every stat in a section switches from
  // empty to skeleton to value together instead of flickering independently.
  const runtimePlaceholder = useStatPlaceholder(isRuntimeInitialLoading);
  const processPlaceholder = useStatPlaceholder(isProcessInitialLoading);
  const resourcePlaceholder = useStatPlaceholder(isResourceInitialLoading);
  const tracePlaceholder = useStatPlaceholder(isInitialLoading);
  const signalProcess = useCallback(
    (pid: number, signal: ServerProcessSignal) => {
      if (
        signal === "SIGKILL" &&
        !window.confirm(`Send SIGKILL to process ${pid}? It can't clean up first.`)
      ) {
        return;
      }

      setSignalingPid(pid);
      void ensureWorkspaceApi()
        .server.signalProcess({ pid, signal })
        .then((result) => {
          if (!result.signaled) {
            const message = Option.getOrUndefined(result.message);
            refreshProcesses();
            if (isStaleProcessSignalMessage(message)) {
              toastManager.add({
                type: "info",
                title: "Process already exited",
                description: "It is no longer running under Cafe Code.",
              });
              return;
            }

            toastManager.add({
              type: "error",
              title: `Could not send ${signal}`,
              description: message ?? `Failed to send ${signal}.`,
            });
            return;
          }
          refreshProcesses();
        })
        .catch((error: unknown) => {
          toastManager.add({
            type: "error",
            title: `Could not send ${signal}`,
            description: error instanceof Error ? error.message : `Failed to send ${signal}.`,
          });
        })
        .finally(() => {
          setSignalingPid(null);
        });
    },
    [refreshProcesses],
  );

  const processDiagnosticsError = processData ? Option.getOrNull(processData.error) : null;
  const processResourceError = resourceData ? Option.getOrNull(resourceData.error) : null;
  const traceDiagnosticsError = data ? Option.getOrNull(data.error) : null;
  const traceDiagnosticsPartialFailure = data
    ? Option.getOrElse(data.partialFailure, () => false)
    : false;
  const runtimeErrors = visibleRuntimeErrors(runtimeData, runtimeError);
  const trackedRuntimeMemory = runtimeData ? summarizeRuntimeMemory(runtimeData.subprocesses) : 0;
  const trackedRuntimeCpu = runtimeData ? summarizeRuntimeCpu(runtimeData.subprocesses) : 0;
  const providerPipeline = runtimeData?.providerPipeline;

  return (
    <SettingsPageContainer title="Diagnostics">
      <SettingsSection
        title="Runtime overview"
        headerAction={
          <DiagnosticsRefreshButton
            isPending={isRuntimePending}
            label="Refresh runtime diagnostics"
            checkedAt={runtimeData?.readAt ?? null}
            onClick={refreshRuntime}
          />
        }
      >
        <StatsGrid>
          <StatBlock
            label="Backend"
            value={runtimeData ? `PID ${processData?.serverPid ?? "—"}` : runtimePlaceholder}
            tooltip="Main backend process that owns orchestration, persistence, and RPC routes."
          />
          <StatBlock
            label="Orchestrator lag"
            value={
              runtimeData ? formatCount(runtimeData.orchestrator.projectionLag) : runtimePlaceholder
            }
            tone={runtimeData && runtimeData.orchestrator.projectionLag > 0 ? "warning" : "default"}
            tooltip="Latest persisted orchestration sequence minus the slowest projector cursor."
          />
          <StatBlock
            label="Provider daemon"
            value={
              runtimeData
                ? runtimeData.providerDaemon.reachable
                  ? "Online"
                  : runtimeData.providerDaemon.available
                    ? "Probe failed"
                    : "Not configured"
                : runtimePlaceholder
            }
            tone={
              runtimeData ? runtimeLayerStatusTone(runtimeData.providerDaemon.status) : "default"
            }
          />
          <StatBlock
            label="Tracked memory"
            value={runtimeData ? formatBytes(trackedRuntimeMemory) : runtimePlaceholder}
            tooltip="Resident memory across backend, provider daemon, provider supervisor, and attributable child processes in the current process snapshot."
          />
        </StatsGrid>
        <RuntimeDiagnosticsErrors errors={runtimeErrors} />
        <RuntimeLayersTable data={runtimeData} loading={isRuntimeInitialLoading} />
      </SettingsSection>

      <SettingsSection title="Orchestrator subprocesses">
        <StatsGrid>
          <StatBlock
            label="Processes"
            value={runtimeData ? formatCount(runtimeData.subprocesses.length) : runtimePlaceholder}
          />
          <StatBlock
            label="CPU"
            value={runtimeData ? `${trackedRuntimeCpu.toFixed(1)}%` : runtimePlaceholder}
          />
          <StatBlock
            label="Memory"
            value={runtimeData ? formatBytes(trackedRuntimeMemory) : runtimePlaceholder}
          />
          <StatBlock
            label="Partial read"
            value={runtimeData ? (runtimeData.partialFailure ? "Yes" : "No") : runtimePlaceholder}
            tone={runtimeData?.partialFailure ? "warning" : "default"}
          />
        </StatsGrid>
        <RuntimeProcessTable
          processes={runtimeData?.subprocesses ?? []}
          loading={isRuntimeInitialLoading}
        />
      </SettingsSection>

      <SettingsSection title="Orchestrator health">
        <StatsGrid>
          <StatBlock
            label="Event sequence"
            value={
              runtimeData
                ? formatCount(runtimeData.orchestrator.latestEventSequence)
                : runtimePlaceholder
            }
          />
          <StatBlock
            label="Projection sequence"
            value={
              runtimeData
                ? formatCount(runtimeData.orchestrator.projectionSequence)
                : runtimePlaceholder
            }
          />
          <StatBlock
            label="Provider ingest lag"
            value={
              runtimeData
                ? formatCount(runtimeData.orchestrator.providerRuntimeIngestion.lag)
                : runtimePlaceholder
            }
            tone={
              runtimeData
                ? runtimeLayerStatusTone(runtimeData.orchestrator.providerRuntimeIngestion.status)
                : "default"
            }
            tooltip="Provider daemon runtime events not yet ingested by the backend. If this grows while the provider daemon has recent events, the provider can be alive while chat projection appears stale."
          />
          <StatBlock
            label="Queue"
            value={
              runtimeData
                ? formatCount(runtimeData.orchestrator.commandQueueDepth)
                : runtimePlaceholder
            }
            tone={
              runtimeData && runtimeData.orchestrator.commandQueueDepth > 0 ? "warning" : "default"
            }
          />
          <StatBlock
            label="Active turns"
            value={
              runtimeData
                ? formatCount(runtimeData.orchestrator.activeTurnCount)
                : runtimePlaceholder
            }
          />
        </StatsGrid>
        <StatsGrid>
          <StatBlock
            label="Accepted"
            value={
              runtimeData
                ? formatCount(runtimeData.orchestrator.acceptedCommandCount)
                : runtimePlaceholder
            }
          />
          <StatBlock
            label="Rejected"
            value={
              runtimeData
                ? formatCount(runtimeData.orchestrator.rejectedCommandCount)
                : runtimePlaceholder
            }
            tone={
              runtimeData && runtimeData.orchestrator.rejectedCommandCount > 0
                ? "warning"
                : "default"
            }
          />
          <StatBlock
            label="Failed"
            value={
              runtimeData
                ? formatCount(runtimeData.orchestrator.failedCommandCount)
                : runtimePlaceholder
            }
            tone={
              runtimeData && runtimeData.orchestrator.failedCommandCount > 0 ? "danger" : "default"
            }
          />
          <StatBlock
            label="Stale flags"
            value={
              runtimeData
                ? formatCount(runtimeData.orchestrator.staleStateFlags.length)
                : runtimePlaceholder
            }
            tone={
              runtimeData && runtimeData.orchestrator.staleStateFlags.length > 0
                ? "warning"
                : "default"
            }
          />
        </StatsGrid>
        {runtimeData && runtimeData.orchestrator.staleStateFlags.length > 0 ? (
          <div className="space-y-2 border-t border-border-subtle px-4 py-3 text-xs sm:px-5">
            {runtimeData.orchestrator.staleStateFlags.map((flag) => (
              <div
                key={flag.kind}
                className={cn(
                  "flex items-start gap-2",
                  flag.severity === "danger"
                    ? "text-destructive-foreground"
                    : "text-warning-foreground",
                )}
              >
                <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  <span className="font-medium">{flag.kind}</span>: {flag.message} (
                  {formatCount(flag.count)})
                </span>
              </div>
            ))}
          </div>
        ) : null}
        <OrchestratorHealthTables data={runtimeData} loading={isRuntimeInitialLoading} />
      </SettingsSection>

      <SettingsSection title="Provider daemon">
        <StatsGrid>
          <StatBlock
            label="Reachable"
            value={
              runtimeData
                ? runtimeData.providerDaemon.reachable
                  ? "Yes"
                  : "No"
                : runtimePlaceholder
            }
            tone={
              runtimeData ? runtimeLayerStatusTone(runtimeData.providerDaemon.status) : "default"
            }
          />
          <StatBlock
            label="PID"
            value={runtimeData ? String(runtimeData.providerDaemon.pid ?? "—") : runtimePlaceholder}
          />
          <StatBlock
            label="Sessions"
            value={
              runtimeData
                ? formatCount(runtimeData.providerDaemon.activeSessionCount)
                : runtimePlaceholder
            }
          />
          <StatBlock
            label="Event streams"
            value={
              runtimeData
                ? formatCount(runtimeData.providerDaemon.activeStreamCount)
                : runtimePlaceholder
            }
            tooltip="Connected consumers of the daemon event journal. This is transport activity, not the number of active model turns."
          />
        </StatsGrid>
        <StatsGrid>
          <StatBlock
            label="Events"
            value={
              runtimeData
                ? formatCount(runtimeData.providerDaemon.retainedEventCount)
                : runtimePlaceholder
            }
          />
          <StatBlock
            label="Cursor"
            value={
              runtimeData ? formatCount(runtimeData.providerDaemon.eventCursor) : runtimePlaceholder
            }
          />
          <StatBlock
            label="Commands"
            value={
              runtimeData
                ? formatCount(runtimeData.providerDaemon.commandCount)
                : runtimePlaceholder
            }
          />
          <StatBlock
            label="Request failures"
            value={
              runtimeData
                ? formatCount(runtimeData.providerDaemon.failedRpcCount)
                : runtimePlaceholder
            }
            tone={
              runtimeData && runtimeData.providerDaemon.failedRpcCount > 0 ? "warning" : "default"
            }
            tooltip="Failed RPC calls to the provider daemon."
          />
        </StatsGrid>
        <ProviderDaemonTables data={runtimeData} loading={isRuntimeInitialLoading} />
      </SettingsSection>

      <SettingsSection title="Provider pipeline">
        <StatsGrid>
          <StatBlock
            label="Loop p99"
            value={
              providerPipeline
                ? formatDuration(providerPipeline.eventLoop.p99LagMs)
                : runtimePlaceholder
            }
            tone={
              providerPipeline && providerPipeline.eventLoop.p99LagMs > 250 ? "warning" : "default"
            }
            tooltip="Backend event-loop scheduling lag. Sustained growth can delay both provider ingestion and WebSocket progress."
          />
          <StatBlock
            label="Loop max"
            value={
              providerPipeline
                ? formatDuration(providerPipeline.eventLoop.maxLagMs)
                : runtimePlaceholder
            }
          />
          <StatBlock
            label="Daemon queue"
            value={
              providerPipeline
                ? formatCount(providerPipeline.daemonStream.queuedLiveRecords)
                : runtimePlaceholder
            }
            tone={
              providerPipeline && providerPipeline.daemonStream.queuedLiveRecords > 0
                ? "warning"
                : "default"
            }
          />
          <StatBlock
            label="Daemon queue size"
            value={
              providerPipeline
                ? formatBytes(providerPipeline.daemonStream.queuedLiveBytes)
                : runtimePlaceholder
            }
          />
        </StatsGrid>
        <StatsGrid>
          <StatBlock
            label="Bridge pending"
            value={
              providerPipeline
                ? formatBytes(providerPipeline.backendBridge.pendingBytes)
                : runtimePlaceholder
            }
          />
          <StatBlock
            label="Bridge pauses"
            value={
              providerPipeline
                ? formatCount(providerPipeline.backendBridge.pauseCount)
                : runtimePlaceholder
            }
          />
          <StatBlock
            label="Subscribers"
            value={
              providerPipeline
                ? formatCount(
                    providerPipeline.subscriptions.activeShellSubscribers +
                      providerPipeline.subscriptions.activeThreadSubscribers,
                  )
                : runtimePlaceholder
            }
          />
          <StatBlock
            label="Replay ring"
            value={
              providerPipeline
                ? `${formatCount(providerPipeline.subscriptions.replayRingEvents)} / ${formatBytes(providerPipeline.subscriptions.replayRingBytes)}`
                : runtimePlaceholder
            }
          />
        </StatsGrid>
        <StatsGrid>
          <StatBlock
            label="WebSocket bulk"
            value={
              providerPipeline
                ? formatBytes(providerPipeline.webSocket.activeBulkBytes)
                : runtimePlaceholder
            }
          />
          <StatBlock
            label="WebSocket overloads"
            value={
              providerPipeline
                ? formatCount(providerPipeline.webSocket.overloadCloseCount)
                : runtimePlaceholder
            }
            tone={
              providerPipeline && providerPipeline.webSocket.overloadCloseCount > 0
                ? "warning"
                : "default"
            }
          />
          <StatBlock
            label="Compacted"
            value={
              providerPipeline
                ? formatCount(providerPipeline.compaction.compactedEventCount)
                : runtimePlaceholder
            }
          />
          <StatBlock
            label="Quarantined"
            value={
              providerPipeline
                ? formatCount(providerPipeline.compaction.quarantinedRowCount)
                : runtimePlaceholder
            }
            tone={
              providerPipeline && providerPipeline.compaction.quarantinedRowCount > 0
                ? "warning"
                : "default"
            }
          />
        </StatsGrid>
      </SettingsSection>

      <SettingsSection title="Provider supervisor">
        {runtimeData?.providerSupervisor.configured ? (
          <>
            <StatsGrid>
              <StatBlock
                label="Reachable"
                value={runtimeData.providerSupervisor.reachable ? "Yes" : "No"}
                tone={runtimeLayerStatusTone(runtimeData.providerSupervisor.status)}
              />
              <StatBlock label="PID" value={String(runtimeData.providerSupervisor.pid ?? "—")} />
              <StatBlock
                label="Sessions"
                value={formatCount(runtimeData.providerSupervisor.activeSessionCount)}
              />
              <StatBlock
                label="Event streams"
                value={formatCount(runtimeData.providerSupervisor.activeStreamCount)}
                tooltip="Connected consumers of the optional supervisor event journal. This is transport activity, not the number of active model turns."
              />
            </StatsGrid>
            <ProviderSupervisorTable data={runtimeData} loading={isRuntimeInitialLoading} />
          </>
        ) : (
          // An intentionally unconfigured supervisor is a neutral state, not an
          // offline failure (AGENTS.md), so it collapses to one quiet line
          // instead of a grid of empty values.
          <div className="flex min-h-11 items-center gap-1.5 px-4 py-3 text-xs text-muted-foreground sm:px-5">
            {runtimeData ? (
              <>
                <span>Not configured</span>
                <InfoTip label="About the provider supervisor">
                  Optional. Providers run in the provider daemon, which is the default.
                </InfoTip>
              </>
            ) : isRuntimeInitialLoading ? (
              runtimePlaceholder
            ) : (
              "Unavailable"
            )}
          </div>
        )}
      </SettingsSection>

      <SettingsSection
        title="Live processes"
        headerAction={
          <DiagnosticsRefreshButton
            isPending={isProcessPending}
            label="Refresh process diagnostics"
            checkedAt={processData ? DateTime.formatIso(processData.readAt) : null}
            onClick={refreshProcesses}
          />
        }
      >
        <StatsGrid>
          <StatBlock
            label="Child processes"
            value={processData ? formatCount(processData.processCount) : processPlaceholder}
          />
          <StatBlock
            label="CPU"
            value={processData ? `${processData.totalCpuPercent.toFixed(1)}%` : processPlaceholder}
            tooltip="Total CPU across live child processes of the current server process. The desktop shell and other parent processes are not included."
          />
          <StatBlock
            label="Memory"
            value={processData ? formatBytes(processData.totalRssBytes) : processPlaceholder}
            tooltip="Total resident memory across live child processes of the current server process. The desktop shell and other parent processes are not included."
          />
          <StatBlock
            label="Server PID"
            value={processData ? String(processData.serverPid) : processPlaceholder}
          />
        </StatsGrid>
        {processDiagnosticsError || processError ? (
          <div className="space-y-2 border-t border-border-subtle px-4 py-3 text-xs text-muted-foreground sm:px-5">
            {processDiagnosticsError ? (
              <div className="flex items-start gap-2 text-destructive-foreground">
                <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
                <span>{processDiagnosticsError.message}</span>
              </div>
            ) : null}
            {processError ? (
              <div className="flex items-start gap-2 text-destructive-foreground">
                <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
                <span>{processError}</span>
              </div>
            ) : null}
          </div>
        ) : null}
        <ProcessDiagnosticsTable
          processes={processData?.processes ?? []}
          signalingPid={signalingPid}
          onSignal={signalProcess}
          loading={isProcessInitialLoading}
        />
      </SettingsSection>

      <SettingsSection
        title="Resource history"
        headerAction={
          <div className="flex items-center gap-1.5">
            <ResourceHistoryWindowSelector
              selectedWindowMs={resourceWindowMs}
              onSelect={setResourceWindowMs}
            />
            <DiagnosticsRefreshButton
              isPending={isResourcePending}
              label="Refresh resource history"
              checkedAt={resourceData ? DateTime.formatIso(resourceData.readAt) : null}
              onClick={refreshResources}
            />
          </div>
        }
      >
        <StatsGrid>
          <StatBlock
            label="CPU time"
            value={
              resourceData ? formatCpuTime(resourceData.totalCpuSecondsApprox) : resourcePlaceholder
            }
            tooltip="Approximate active CPU time for the Cafe Code server root process and its descendants during the selected window. It grows only while sampled processes use CPU and older samples leave as the window moves."
          />
          <StatBlock
            label="Samples"
            value={
              resourceData ? formatCount(resourceData.retainedSampleCount) : resourcePlaceholder
            }
            tooltip="In-memory process samples retained by the server. This resets when the server restarts."
          />
          <StatBlock
            label="Interval"
            value={
              resourceData ? formatDuration(resourceData.sampleIntervalMs) : resourcePlaceholder
            }
          />
          <StatBlock
            label="Processes"
            value={
              resourceData ? formatCount(resourceData.topProcesses.length) : resourcePlaceholder
            }
          />
        </StatsGrid>
        {processResourceError || resourceError ? (
          <div className="space-y-2 border-t border-border-subtle px-4 py-3 text-xs text-muted-foreground sm:px-5">
            {processResourceError ? (
              <div className="flex items-start gap-2 text-destructive-foreground">
                <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
                <span>{processResourceError.message}</span>
              </div>
            ) : null}
            {resourceError ? (
              <div className="flex items-start gap-2 text-destructive-foreground">
                <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
                <span>{resourceError}</span>
              </div>
            ) : null}
          </div>
        ) : null}
        <ProcessResourceHistoryChart buckets={resourceData?.buckets ?? []} />
        <ProcessResourceHistoryTable
          processes={resourceData?.topProcesses ?? []}
          loading={isResourceInitialLoading}
        />
      </SettingsSection>

      <SettingsSection
        title="Traces"
        headerAction={
          <div className="flex items-center gap-1.5">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
                    disabled={!observability?.logsDirectoryPath || isOpeningLogsDirectory}
                    onClick={openLogsDirectory}
                    aria-label={canOpenLocalEditor ? "Open logs folder" : "Copy logs folder path"}
                  >
                    {canOpenLocalEditor ? (
                      <FolderOpenIcon className="size-3" />
                    ) : (
                      <CopyIcon className="size-3" />
                    )}
                  </Button>
                }
              />
              <TooltipPopup side="top">
                {canOpenLocalEditor ? "Open logs folder" : "Copy logs folder path"}
              </TooltipPopup>
            </Tooltip>
            <DiagnosticsRefreshButton
              isPending={isPending}
              label="Refresh trace diagnostics"
              checkedAt={data ? DateTime.formatIso(data.readAt) : null}
              onClick={refresh}
            />
          </div>
        }
      >
        <StatsGrid>
          <StatBlock
            label="Spans"
            value={data ? formatCount(data.recordCount) : tracePlaceholder}
          />
          <StatBlock
            label="Failures"
            value={data ? formatCount(data.failureCount) : tracePlaceholder}
            tone={data && data.failureCount > 0 ? "danger" : "default"}
          />
          <StatBlock
            label="Slow spans"
            value={data ? formatCount(data.slowSpanCount) : tracePlaceholder}
            tooltip={
              data
                ? `Spans with a duration of ${formatDuration(data.slowSpanThresholdMs)} or longer.`
                : "Spans at or above the configured slow-span threshold."
            }
            tone={data && data.slowSpanCount > 0 ? "warning" : "default"}
          />
          <StatBlock
            label="Parse errors"
            value={data ? formatCount(data.parseErrorCount) : tracePlaceholder}
            tone={data && data.parseErrorCount > 0 ? "warning" : "default"}
          />
        </StatsGrid>
        {openLogsDirectoryError || traceDiagnosticsError || error ? (
          <div className="space-y-2 border-t border-border-subtle px-4 py-3 text-xs text-muted-foreground sm:px-5">
            {openLogsDirectoryError ? (
              <div className="flex items-start gap-2 text-destructive-foreground">
                <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
                <span>{openLogsDirectoryError}</span>
              </div>
            ) : null}
            {traceDiagnosticsError ? (
              <div
                className={cn(
                  "flex items-start gap-2",
                  traceDiagnosticsPartialFailure
                    ? "text-warning-foreground"
                    : "text-destructive-foreground",
                )}
              >
                <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  {traceDiagnosticsPartialFailure
                    ? `Some trace files couldn't be read: ${traceDiagnosticsError.message}`
                    : traceDiagnosticsError.message}
                </span>
              </div>
            ) : null}
            {error ? (
              <div className="flex items-start gap-2 text-destructive-foreground">
                <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" />
                <span>{error}</span>
              </div>
            ) : null}
          </div>
        ) : null}
      </SettingsSection>

      <SettingsSection title="Latest failures">
        {data && data.latestFailures.length > 0 ? (
          <DiagnosticsTable headers={["Span", "Cause", "Duration", "Ended"]}>
            {data.latestFailures.map((failure) => (
              <tr key={`${failure.traceId}:${failure.spanId}`}>
                <td className="px-4 py-3 align-top text-xs font-medium text-foreground first:sm:pl-5">
                  {failure.name}
                </td>
                <td className="max-w-[360px] px-4 py-3 align-top text-muted-foreground">
                  <ExpandableText text={failure.cause} />
                </td>
                <td className="px-4 py-3 align-top font-mono tabular-nums">
                  {formatDuration(failure.durationMs)}
                </td>
                <td className="whitespace-nowrap px-4 py-3 align-top font-mono tabular-nums text-muted-foreground last:sm:pr-5">
                  {formatRelativeNoWrap(failure.endedAt)}
                </td>
              </tr>
            ))}
          </DiagnosticsTable>
        ) : (
          <EmptyRows loading={isInitialLoading} label="No failed spans found." />
        )}
      </SettingsSection>

      <SettingsSection title="Most common failures">
        {data && data.commonFailures.length > 0 ? (
          <DiagnosticsTable
            headers={["Span", "Count", "Cause", "Last seen"]}
            minTableWidth="min-w-[760px]"
          >
            {data.commonFailures.map((failure) => (
              <tr key={`${failure.name}:${failure.cause}`}>
                <td className="px-4 py-3 align-top text-xs font-medium text-foreground first:sm:pl-5">
                  {failure.name}
                </td>
                <td className="px-4 py-3 align-top font-mono tabular-nums">
                  {formatCount(failure.count)}
                </td>
                <td className="max-w-[360px] px-4 py-3 align-top text-muted-foreground">
                  <ExpandableText text={failure.cause} />
                </td>
                <td className="w-px whitespace-nowrap px-4 py-3 align-top font-mono tabular-nums text-muted-foreground last:sm:pr-5">
                  {formatRelativeNoWrap(failure.lastSeenAt)}
                </td>
              </tr>
            ))}
          </DiagnosticsTable>
        ) : (
          <EmptyRows loading={isInitialLoading} label="No repeated failures found." />
        )}
      </SettingsSection>

      <SettingsSection title="Slowest spans">
        {data && data.slowestSpans.length > 0 ? (
          <DiagnosticsTable
            headers={["Span", "Duration", "Ended", "Trace"]}
            minTableWidth="min-w-[900px]"
            columnWidths={["w-[44%]", "w-[14%]", "w-[12%]", "w-[30%]"]}
          >
            {data.slowestSpans.map((span) => (
              <tr key={`${span.traceId}:${span.spanId}`}>
                <td className="px-4 py-3 align-top text-xs font-medium text-foreground first:sm:pl-5">
                  {span.name}
                </td>
                <td className="px-4 py-3 align-top font-mono tabular-nums">
                  {formatDuration(span.durationMs)}
                </td>
                <td className="w-px whitespace-nowrap px-4 py-3 align-top font-mono tabular-nums text-muted-foreground">
                  {formatRelativeNoWrap(span.endedAt)}
                </td>
                <td className="min-w-0 whitespace-nowrap px-4 py-3 align-top text-muted-foreground last:sm:pr-5">
                  <TraceIdCell traceId={span.traceId} />
                </td>
              </tr>
            ))}
          </DiagnosticsTable>
        ) : (
          <EmptyRows loading={isInitialLoading} label="No spans found." />
        )}
      </SettingsSection>

      <SettingsSection title="Span logs">
        {data && data.latestWarningAndErrorLogs.length > 0 ? (
          <ScrollArea
            chainVerticalScroll
            scrollFade
            hideScrollbars
            className="w-full max-w-full rounded-none"
          >
            <table className="w-full min-w-[920px] table-fixed text-left text-xs">
              <colgroup>
                <col className="w-[11%]" />
                <col className="w-[9%]" />
                <col className="w-[24%]" />
                <col className="w-[26%]" />
                <col className="w-[30%]" />
              </colgroup>
              <thead className={TABLE_HEAD_CLASSNAME}>
                <tr>
                  <th className="whitespace-nowrap px-4 py-2.5 font-medium sm:pl-5">Time</th>
                  <th className="whitespace-nowrap px-4 py-2.5 font-medium">Level</th>
                  <th className="whitespace-nowrap px-4 py-2.5 font-medium">Span</th>
                  <th className="whitespace-nowrap px-4 py-2.5 font-medium">Message</th>
                  <th className="whitespace-nowrap px-4 py-2.5 font-medium sm:pr-5">Trace</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {data.latestWarningAndErrorLogs.map((event) => (
                  <tr
                    key={`${event.traceId}:${event.spanId}:${DateTime.formatIso(event.seenAt)}:${event.message}`}
                    className="hover:bg-muted/15"
                  >
                    <td className="whitespace-nowrap px-4 py-3 align-top font-mono tabular-nums text-muted-foreground sm:pl-5">
                      {formatRelativeNoWrap(event.seenAt)}
                    </td>
                    <td className="px-4 py-3 align-top">
                      <span className="inline-flex rounded-sm bg-muted px-1.5 py-0.5 font-mono text-2xs font-medium text-foreground">
                        {event.level}
                      </span>
                    </td>
                    <td className="px-4 py-3 align-top">
                      <div className="truncate font-medium text-foreground">{event.spanName}</div>
                    </td>
                    <td className="px-4 py-3 align-top text-muted-foreground">
                      <ExpandableText
                        collapsedClassName="line-clamp-2"
                        expandLabel="Show full message"
                        text={event.message}
                      />
                    </td>
                    <td className="min-w-0 whitespace-nowrap px-4 py-3 align-top text-muted-foreground sm:pr-5">
                      <TraceIdCell traceId={event.traceId} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollArea>
        ) : (
          <EmptyRows loading={isInitialLoading} label="No warnings or errors found." />
        )}
      </SettingsSection>

      <SettingsSection title="Top span names">
        {data && data.topSpansByCount.length > 0 ? (
          <DiagnosticsTable
            headers={["Span", "Count", "Failures", "Average", "Max"]}
            minTableWidth="min-w-[760px]"
            columnWidths={["w-[48%]", "w-[13%]", "w-[13%]", "w-[13%]", "w-[13%]"]}
          >
            {data.topSpansByCount.map((span) => (
              <tr key={span.name}>
                <td className="px-4 py-3 align-top text-xs font-medium text-foreground first:sm:pl-5">
                  {span.name}
                </td>
                <td className="whitespace-nowrap px-4 py-3 align-top font-mono tabular-nums">
                  {formatCount(span.count)}
                </td>
                <td className="whitespace-nowrap px-4 py-3 align-top font-mono tabular-nums">
                  {formatCount(span.failureCount)}
                </td>
                <td className="whitespace-nowrap px-4 py-3 align-top font-mono tabular-nums">
                  {formatDuration(span.averageDurationMs)}
                </td>
                <td className="whitespace-nowrap px-4 py-3 align-top font-mono tabular-nums last:sm:pr-5">
                  {formatDuration(span.maxDurationMs)}
                </td>
              </tr>
            ))}
          </DiagnosticsTable>
        ) : (
          <EmptyRows loading={isInitialLoading} label="No spans found." />
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
