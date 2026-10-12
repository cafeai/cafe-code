import { useUiLocale, useUiPresentation } from "~/i18n";
import { uiFormatNumber, uiText } from "@cafecode/shared/i18n";
import { UiMessage } from "~/i18n";
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
import { formatRelativeTime, formatRelativeTimeLabel } from "../../timestampFormat";
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

function formatCount(value: number): string {
  return uiFormatNumber(value);
}

function formatDuration(value: number): string {
  if (value < 1_000) return uiText("{value} ms", { value: Math.round(value) });
  return uiText("{value} s", { value: (value / 1_000).toFixed(value >= 10_000 ? 1 : 2) });
}

function formatBytes(value: number): string {
  if (value < 1024) return uiText("{value} B", { value });
  const units = ["KB", "MB", "GB"] as const;
  let unitIndex = -1;
  let next = value;
  do {
    next /= 1024;
    unitIndex += 1;
  } while (next >= 1024 && unitIndex < units.length - 1);
  return uiText("{value} {unit, select, KB {KB} MB {MB} other {GB}}", {
    value: next.toFixed(next >= 10 ? 1 : 2),
    unit: units[unitIndex],
  });
}

function formatRelative(value: DateTime.Utc | null): string {
  if (!value) return "—";
  return formatRelativeTimeLabel(DateTime.formatIso(value));
}

function formatRelativeNoWrap(value: DateTime.Utc | null): string {
  return formatRelative(value).replaceAll(" ", "\u00a0");
}

function formatRelativeIso(value: string | null): string {
  if (!value) return "—";
  return formatRelativeTimeLabel(value);
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
  const uiLocale = useUiLocale();

  const showSkeleton = useDelayedFlag(isInitialLoading);
  if (showSkeleton) return <Skeleton className="my-1 h-5 w-16" />;
  if (isInitialLoading)
    return (
      <span aria-hidden className="invisible">
        0
      </span>
    );
  return (
    <span className="text-subtle-foreground">{uiText("—", undefined, undefined, uiLocale)}</span>
  );
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
  const uiLocale = useUiLocale();

  return (
    <div className="min-w-0 px-4 py-3 sm:px-5">
      <div className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
        <span className="min-w-0 truncate max-md:whitespace-normal max-md:break-words">
          {label}
        </span>
        {tooltip ? (
          <InfoTip
            label={uiText("{value0} details", { value0: label }, undefined, uiLocale)}
            popupClassName="text-left"
          >
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
  expandLabel = uiText("Show full error"),
}: {
  text: string;
  className?: string;
  collapsedClassName?: string;
  expandLabel?: string;
}) {
  const uiLocale = useUiLocale();

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
          {expanded ? uiText("Show less", undefined, undefined, uiLocale) : expandLabel}
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
  const uiLocale = useUiLocale();

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
              aria-label={
                copied
                  ? uiText("Copied trace ID", undefined, undefined, uiLocale)
                  : uiText("Copy trace ID", undefined, undefined, uiLocale)
              }
              onClick={copyTraceId}
            >
              <CopyIcon className="size-3" />
            </button>
          }
        />
        <TooltipPopup side="top">
          {copied
            ? uiText("Copied", undefined, undefined, uiLocale)
            : uiText("Copy full trace ID", undefined, undefined, uiLocale)}
        </TooltipPopup>
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
  if (process.depth > 0) return uiText("Subprocess");
  if (/\b(codex|claude)\b/i.test(process.command)) return uiText("Agent");
  return uiText("Process");
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
  const uiLocale = useUiLocale();

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
          aria-label={
            isExpanded
              ? uiText("Collapse {value0}", { value0: name }, undefined, uiLocale)
              : uiText("Expand {value0}", { value0: name }, undefined, uiLocale)
          }
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
  const uiLocale = useUiLocale();

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
              {uiText("INT", undefined, undefined, uiLocale)}
            </button>
          }
        />
        <TooltipPopup side="top">
          {uiText("Send SIGINT", undefined, undefined, uiLocale)}
        </TooltipPopup>
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
              {uiText("KILL", undefined, undefined, uiLocale)}
            </button>
          }
        />
        <TooltipPopup side="top">
          {uiText("Send SIGKILL", undefined, undefined, uiLocale)}
        </TooltipPopup>
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
  const uiLocale = useUiLocale();
  const uiPresentation = useUiPresentation(UI_PRESENTATION_SOURCES);

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
            <th className="px-4 py-2 font-medium sm:pl-5">
              {uiText("Name", undefined, undefined, uiLocale)}
            </th>
            <th className="px-3 py-2 text-right font-medium">
              {uiText("CPU", undefined, undefined, uiLocale)}
            </th>
            <th className="px-3 py-2 text-right font-medium">
              {uiText("Memory", undefined, undefined, uiLocale)}
            </th>
            <th className="px-3 py-2 font-medium">
              {uiText("Command", undefined, undefined, uiLocale)}
            </th>
            <th className="px-3 py-2 text-right font-medium">
              {uiText("PID", undefined, undefined, uiLocale)}
            </th>
            <th className="px-3 py-2 font-medium">
              {uiText("Type", undefined, undefined, uiLocale)}
            </th>
            <th className="p-2 text-right font-medium sm:pr-4">
              {uiText("Signal", undefined, undefined, uiLocale)}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border-subtle">
          {visibleProcesses.length === 0 ? (
            <tr>
              <td colSpan={7} className="p-0">
                <EmptyRows
                  loading={loading}
                  label={uiText("No child processes running.", undefined, undefined, uiLocale)}
                />
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
                {uiPresentation.formatBytes(process.rssBytes)}
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
                {uiPresentation.formatProcessType(process)}
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
  {
    get label() {
      return uiText("5m");
    },
    windowMs: 5 * 60_000,
    bucketMs: 30_000,
  },
  {
    get label() {
      return uiText("15m");
    },
    windowMs: 15 * 60_000,
    bucketMs: 60_000,
  },
  {
    get label() {
      return uiText("30m");
    },
    windowMs: 30 * 60_000,
    bucketMs: 2 * 60_000,
  },
  {
    get label() {
      return uiText("1h");
    },
    windowMs: 60 * 60_000,
    bucketMs: 5 * 60_000,
  },
] as const;

function formatCpuTime(seconds: number): string {
  if (seconds < 60) return uiText("{value}s", { value: seconds.toFixed(seconds >= 10 ? 1 : 2) });
  const minutes = seconds / 60;
  if (minutes < 60) return uiText("{value}m", { value: minutes.toFixed(minutes >= 10 ? 1 : 2) });
  return uiText("{value}h", { value: (minutes / 60).toFixed(2) });
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
  const uiLocale = useUiLocale();

  const name = formatShortProcessName(process.command);

  return (
    <div
      className="grid min-w-0 grid-cols-[1.25rem_0.375rem_minmax(0,1fr)] items-center gap-2"
      style={{ paddingLeft: `${Math.min(visualDepth, 6) * 10}px` }}
      aria-label={uiText(
        "{root, select, yes {Root} other {Child}} process {name}",
        {
          root: process.isServerRoot ? "yes" : "no",
          name,
        },
        undefined,
        uiLocale,
      )}
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
  const uiLocale = useUiLocale();

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
                      aria-label={uiText(
                        "Average CPU {value0}%, peak CPU {value1}%",
                        {
                          value0: bucket.avgCpuPercent.toFixed(1),
                          value1: bucket.maxCpuPercent.toFixed(1),
                        },
                        undefined,
                        uiLocale,
                      )}
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
                <UiMessage
                  message="Avg <slot1></slot1>%, peak <slot3></slot3>%"
                  slots={{
                    slot1: bucket.avgCpuPercent.toFixed(1),
                    slot3: bucket.maxCpuPercent.toFixed(1),
                  }}
                />
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
  const uiLocale = useUiLocale();
  const uiPresentation = useUiPresentation(UI_PRESENTATION_SOURCES);

  const selectedLabel =
    uiPresentation.RESOURCE_HISTORY_WINDOWS.find((option) => option.windowMs === selectedWindowMs)
      ?.label ?? uiPresentation.RESOURCE_HISTORY_WINDOWS[1].label;
  return (
    <SegmentedControl
      size="xs"
      aria-label={uiText("Resource history window", undefined, undefined, uiLocale)}
      value={selectedLabel}
      onValueChange={(label) => {
        const option = uiPresentation.RESOURCE_HISTORY_WINDOWS.find(
          (entry) => entry.label === label,
        );
        if (option) onSelect(option.windowMs);
      }}
      options={uiPresentation.RESOURCE_HISTORY_WINDOWS.map((option) => ({
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
  const uiLocale = useUiLocale();
  const uiPresentation = useUiPresentation(UI_PRESENTATION_SOURCES);

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
            <th className="px-4 py-2 font-medium sm:pl-5">
              {uiText("Process", undefined, undefined, uiLocale)}
            </th>
            <th className="px-3 py-2 text-right font-medium">
              {uiText("CPU time", undefined, undefined, uiLocale)}
            </th>
            <th className="px-3 py-2 text-right font-medium">
              {uiText("Current", undefined, undefined, uiLocale)}
            </th>
            <th className="px-3 py-2 text-right font-medium">
              {uiText("Average", undefined, undefined, uiLocale)}
            </th>
            <th className="px-3 py-2 text-right font-medium">
              {uiText("Peak", undefined, undefined, uiLocale)}
            </th>
            <th className="px-3 py-2 text-right font-medium">
              {uiText("Max memory", undefined, undefined, uiLocale)}
            </th>
            <th className="px-3 py-2 font-medium">
              {uiText("Command", undefined, undefined, uiLocale)}
            </th>
            <th className="px-3 py-2 text-right font-medium sm:pr-5">
              {uiText("PID", undefined, undefined, uiLocale)}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border-subtle">
          {processes.length === 0 ? (
            <tr>
              <td colSpan={8} className="p-0">
                <EmptyRows
                  loading={loading}
                  label={uiText("No samples in this window yet.", undefined, undefined, uiLocale)}
                />
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
                {uiPresentation.formatCpuTime(process.cpuSecondsApprox)}
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
                {uiPresentation.formatBytes(process.maxRssBytes)}
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
  const uiLocale = useUiLocale();
  const uiPresentation = useUiPresentation(UI_PRESENTATION_SOURCES);

  useRelativeTimeTick();
  const relative = checkedAt ? uiPresentation.formatRelativeTime(checkedAt) : null;
  if (!relative) return <>{uiText("Not checked yet", undefined, undefined, uiLocale)}</>;
  return (
    <UiMessage
      message="Checked <duration></duration>"
      slots={{
        duration: (
          <span className="tabular-nums">{uiPresentation.formatRelativeTimeLabel(checkedAt!)}</span>
        ),
      }}
    />
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
  const uiPresentation = useUiPresentation(UI_PRESENTATION_SOURCES);

  return (
    <span
      className={cn(
        "inline-flex whitespace-nowrap rounded-sm px-1.5 py-0.5 text-2xs font-medium",
        runtimeLayerStatusClasses(status),
      )}
    >
      {uiPresentation.formatRuntimeLayerStatus(status)}
    </span>
  );
}

function RuntimeDiagnosticsErrors({
  errors,
}: {
  errors: ReadonlyArray<ServerRuntimeLayerDiagnosticsError>;
}) {
  const uiLocale = useUiLocale();
  const uiPresentation = useUiPresentation(UI_PRESENTATION_SOURCES);

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
            <span className="font-medium">
              {uiPresentation.formatRuntimeLayerRole(error.source)}
            </span>
            <ExpandableText
              text={error.message}
              collapsedClassName="line-clamp-2"
              expandLabel={uiText("Show full message", undefined, undefined, uiLocale)}
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
  const uiLocale = useUiLocale();
  const uiPresentation = useUiPresentation(UI_PRESENTATION_SOURCES);

  const layers = data ? sortRuntimeLayers(data.runtimeLayers) : [];
  if (layers.length === 0) {
    return (
      <EmptyRows
        loading={loading}
        label={uiText("No runtime layers found.", undefined, undefined, uiLocale)}
      />
    );
  }

  return (
    <DiagnosticsTable
      headers={[
        uiText("Layer", undefined, undefined, uiLocale),
        uiText("Status", undefined, undefined, uiLocale),
        uiText("PID", undefined, undefined, uiLocale),
        uiText("Memory", undefined, undefined, uiLocale),
        uiText("CPU", undefined, undefined, uiLocale),
        uiText("Uptime", undefined, undefined, uiLocale),
        uiText("Last event", undefined, undefined, uiLocale),
        uiText("Notes", undefined, undefined, uiLocale),
      ]}
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
            {uiPresentation.formatRuntimeLayerRole(layer.role)}
          </td>
          <td className="px-4 py-3 align-top">
            <RuntimeStatusBadge status={layer.status} />
          </td>
          <td className="px-4 py-3 align-top text-right font-mono tabular-nums">
            {layer.pid ?? uiText("—", undefined, undefined, uiLocale)}
          </td>
          <td className="px-4 py-3 align-top text-right font-mono tabular-nums">
            {uiPresentation.formatBytes(layer.rssBytes)}
          </td>
          <td className="px-4 py-3 align-top text-right font-mono tabular-nums">
            {layer.cpuPercent.toFixed(1)}%
          </td>
          <td className="px-4 py-3 align-top font-mono tabular-nums text-muted-foreground">
            {layer.uptimeLabel ?? uiText("—", undefined, undefined, uiLocale)}
          </td>
          <td className="px-4 py-3 align-top font-mono tabular-nums text-muted-foreground">
            {uiPresentation.formatRelativeIsoNoWrap(layer.lastEventAt)}
          </td>
          <td className="px-4 py-3 align-top text-muted-foreground last:sm:pr-5">
            <ExpandableText
              text={layer.notes.length > 0 ? layer.notes.join("\n") : "—"}
              collapsedClassName="line-clamp-2"
              expandLabel={uiText("Show notes", undefined, undefined, uiLocale)}
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
  const uiLocale = useUiLocale();

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
            isExpanded
              ? uiText("Collapse {value0}", { value0: process.commandLabel }, undefined, uiLocale)
              : uiText("Expand {value0}", { value0: process.commandLabel }, undefined, uiLocale)
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
  const uiLocale = useUiLocale();
  const uiPresentation = useUiPresentation(UI_PRESENTATION_SOURCES);

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
            <th className="px-4 py-2 font-medium sm:pl-5">
              {uiText("Process", undefined, undefined, uiLocale)}
            </th>
            <th className="px-3 py-2 font-medium">
              {uiText("Role", undefined, undefined, uiLocale)}
            </th>
            <th className="px-3 py-2 font-medium">
              {uiText("Status", undefined, undefined, uiLocale)}
            </th>
            <th className="px-3 py-2 text-right font-medium">
              {uiText("PID", undefined, undefined, uiLocale)}
            </th>
            <th className="px-3 py-2 text-right font-medium">
              {uiText("Memory", undefined, undefined, uiLocale)}
            </th>
            <th className="px-3 py-2 text-right font-medium">
              {uiText("CPU", undefined, undefined, uiLocale)}
            </th>
            <th className="px-3 py-2 font-medium">
              {uiText("Owner", undefined, undefined, uiLocale)}
            </th>
            <th className="px-3 py-2 font-medium sm:pr-5">
              {uiText("Command", undefined, undefined, uiLocale)}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border-subtle">
          {visibleProcesses.length === 0 ? (
            <tr>
              <td colSpan={8} className="p-0">
                <EmptyRows
                  loading={loading}
                  label={uiText("No runtime processes found.", undefined, undefined, uiLocale)}
                />
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
                {uiPresentation.formatRuntimeLayerRole(process.role)}
              </td>
              <td className="px-3 py-2 align-middle font-mono text-muted-foreground">
                {process.status}
              </td>
              <td className="px-3 py-2 text-right align-middle font-mono tabular-nums">
                {process.pid ?? uiText("—", undefined, undefined, uiLocale)}
              </td>
              <td className="px-3 py-2 text-right align-middle font-mono tabular-nums">
                {uiPresentation.formatBytes(process.rssBytes)}
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
  const uiLocale = useUiLocale();
  const uiPresentation = useUiPresentation(UI_PRESENTATION_SOURCES);

  if (!data) {
    return (
      <EmptyRows
        loading={loading}
        label={uiText("No orchestrator data.", undefined, undefined, uiLocale)}
      />
    );
  }

  return (
    <div className="grid gap-0 border-t border-border-subtle lg:grid-cols-2 lg:divide-x lg:divide-border-subtle">
      <div className="min-w-0">
        <DiagnosticsTable
          headers={[
            uiText("Event type", undefined, undefined, uiLocale),
            uiText("Count", undefined, undefined, uiLocale),
            uiText("Actor", undefined, undefined, uiLocale),
            uiText("Last seen", undefined, undefined, uiLocale),
          ]}
          minTableWidth="min-w-[620px]"
        >
          {data.orchestrator.recentEventTypeCounts.length === 0 ? (
            <tr>
              <td colSpan={4} className="px-4 py-4 text-muted-foreground sm:px-5">
                {uiText("No recent orchestration events.", undefined, undefined, uiLocale)}
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
                  {event.actorKind ?? uiText("—", undefined, undefined, uiLocale)}
                </td>
                <td className="px-4 py-3 align-top font-mono tabular-nums text-muted-foreground last:sm:pr-5">
                  {uiPresentation.formatRelativeIsoNoWrap(event.lastSeenAt)}
                </td>
              </tr>
            ))
          )}
        </DiagnosticsTable>
      </div>
      <div className="min-w-0 border-t border-border-subtle lg:border-t-0">
        <DiagnosticsTable
          headers={[
            uiText("Projector", undefined, undefined, uiLocale),
            uiText("Cursor", undefined, undefined, uiLocale),
            uiText("Lag", undefined, undefined, uiLocale),
            uiText("Status", undefined, undefined, uiLocale),
          ]}
          minTableWidth="min-w-[520px]"
        >
          {data.orchestrator.projectorCursors.length === 0 ? (
            <tr>
              <td colSpan={4} className="px-4 py-4 text-muted-foreground sm:px-5">
                {uiText("No projector cursors found.", undefined, undefined, uiLocale)}
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
  const uiLocale = useUiLocale();
  const uiPresentation = useUiPresentation(UI_PRESENTATION_SOURCES);

  if (!data) {
    return (
      <EmptyRows
        loading={loading}
        label={uiText("No provider daemon data.", undefined, undefined, uiLocale)}
      />
    );
  }

  return (
    <div className="grid gap-0 border-t border-border-subtle lg:grid-cols-2 lg:divide-x lg:divide-border-subtle">
      <DiagnosticsTable
        headers={[
          uiText("Status", undefined, undefined, uiLocale),
          uiText("Method", undefined, undefined, uiLocale),
          uiText("Duration", undefined, undefined, uiLocale),
          uiText("Updated", undefined, undefined, uiLocale),
          uiText("Error", undefined, undefined, uiLocale),
        ]}
        minTableWidth="min-w-[720px]"
      >
        {data.providerDaemon.recentCommands.length === 0 ? (
          <tr>
            <td colSpan={5} className="px-4 py-4 text-muted-foreground sm:px-5">
              {uiText("No recent daemon commands.", undefined, undefined, uiLocale)}
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
                {command.durationMs === null
                  ? uiText("—", undefined, undefined, uiLocale)
                  : uiPresentation.formatDuration(command.durationMs)}
              </td>
              <td className="px-4 py-3 align-top font-mono tabular-nums text-muted-foreground">
                {uiPresentation.formatRelativeIsoNoWrap(command.updatedAt)}
              </td>
              <td className="px-4 py-3 align-top text-muted-foreground last:sm:pr-5">
                {command.error ? (
                  <ExpandableText
                    text={command.error}
                    collapsedClassName="line-clamp-2"
                    expandLabel={uiText("Show full error", undefined, undefined, uiLocale)}
                  />
                ) : (
                  uiText("—", undefined, undefined, uiLocale)
                )}
              </td>
            </tr>
          ))
        )}
      </DiagnosticsTable>
      <DiagnosticsTable
        headers={[
          uiText("Runtime event", undefined, undefined, uiLocale),
          uiText("Count", undefined, undefined, uiLocale),
          uiText("Last seen", undefined, undefined, uiLocale),
        ]}
        minTableWidth="min-w-[520px]"
      >
        {data.providerDaemon.runtimeEventSummaries.length === 0 ? (
          <tr>
            <td colSpan={3} className="px-4 py-4 text-muted-foreground sm:px-5">
              {uiText("No recent daemon runtime events.", undefined, undefined, uiLocale)}
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
                {uiPresentation.formatRelativeIsoNoWrap(event.lastSeenAt)}
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
  const uiLocale = useUiLocale();

  if (!data) {
    return (
      <EmptyRows
        loading={loading}
        label={uiText("No supervisor data.", undefined, undefined, uiLocale)}
      />
    );
  }

  const sessionCounts = Object.entries(data.providerSupervisor.sessionCounts);
  return (
    <DiagnosticsTable
      headers={[
        uiText("Session state", undefined, undefined, uiLocale),
        uiText("Count", undefined, undefined, uiLocale),
      ]}
      minTableWidth="min-w-[420px]"
    >
      {sessionCounts.length === 0 ? (
        <tr>
          <td colSpan={2} className="px-4 py-4 text-muted-foreground sm:px-5">
            {uiText("No supervisor session counts found.", undefined, undefined, uiLocale)}
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
  const uiLocale = useUiLocale();
  const uiPresentation = useUiPresentation(UI_PRESENTATION_SOURCES);

  const observability = useServerObservability();
  const availableEditors = useServerAvailableEditors();
  const environmentId = useWorkspaceEnvironmentId();
  const canOpenLocalEditor = getLocalShellCapabilities(environmentId).canOpenLocalEditor;
  const [resourceWindowMs, setResourceWindowMs] = useState(15 * 60_000);
  const selectedResourceWindow =
    uiPresentation.RESOURCE_HISTORY_WINDOWS.find(
      (option) => option.windowMs === resourceWindowMs,
    ) ?? uiPresentation.RESOURCE_HISTORY_WINDOWS[1];
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
              title: uiText("Logs path copied", undefined, undefined, uiLocale),
              description: logsDirectoryPath,
              type: "success",
            });
          },
          (error: unknown) => {
            setOpenLogsDirectoryError(
              error instanceof Error
                ? error.message
                : uiText("Unable to copy logs folder path.", undefined, undefined, uiLocale),
            );
          },
        );
      return;
    }

    const editor = resolveAndPersistPreferredEditor(availableEditors ?? []);
    if (!editor) {
      setOpenLogsDirectoryError(
        uiText("No available editors found.", undefined, undefined, uiLocale),
      );
      return;
    }

    setIsOpeningLogsDirectory(true);
    setOpenLogsDirectoryError(null);
    void ensureWorkspaceApi()
      .shell.openInEditor(logsDirectoryPath, editor)
      .catch((error: unknown) => {
        setOpenLogsDirectoryError(
          error instanceof Error
            ? error.message
            : uiText("Unable to open logs folder.", undefined, undefined, uiLocale),
        );
      })
      .finally(() => {
        setIsOpeningLogsDirectory(false);
      });
  }, [availableEditors, canOpenLocalEditor, observability?.logsDirectoryPath, uiLocale]);

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
        !window.confirm(
          uiText(
            "Send SIGKILL to process {value0}? It can''t clean up first.",
            { value0: pid },
            undefined,
            uiLocale,
          ),
        )
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
                title: uiText("Process already exited", undefined, undefined, uiLocale),
                description: uiText(
                  "It is no longer running under Cafe Code.",
                  undefined,
                  undefined,
                  uiLocale,
                ),
              });
              return;
            }

            toastManager.add({
              type: "error",
              title: uiText("Could not send {value0}", { value0: signal }, undefined, uiLocale),
              description:
                message ??
                uiText("Failed to send {value0}.", { value0: signal }, undefined, uiLocale),
            });
            return;
          }
          refreshProcesses();
        })
        .catch((error: unknown) => {
          toastManager.add({
            type: "error",
            title: uiText("Could not send {value0}", { value0: signal }, undefined, uiLocale),
            description:
              error instanceof Error
                ? error.message
                : uiText("Failed to send {value0}.", { value0: signal }, undefined, uiLocale),
          });
        })
        .finally(() => {
          setSignalingPid(null);
        });
    },
    [refreshProcesses, uiLocale],
  );

  const processDiagnosticsError = processData ? Option.getOrNull(processData.error) : null;
  const processResourceError = resourceData ? Option.getOrNull(resourceData.error) : null;
  const traceDiagnosticsError = data ? Option.getOrNull(data.error) : null;
  const traceDiagnosticsPartialFailure = data
    ? Option.getOrElse(data.partialFailure, () => false)
    : false;
  const runtimeErrors = uiPresentation.visibleRuntimeErrors(runtimeData, runtimeError);
  const trackedRuntimeMemory = runtimeData ? summarizeRuntimeMemory(runtimeData.subprocesses) : 0;
  const trackedRuntimeCpu = runtimeData ? summarizeRuntimeCpu(runtimeData.subprocesses) : 0;
  const providerPipeline = runtimeData?.providerPipeline;

  return (
    <SettingsPageContainer title={uiText("Diagnostics", undefined, undefined, uiLocale)}>
      <SettingsSection
        title={uiText("Runtime overview", undefined, undefined, uiLocale)}
        headerAction={
          <DiagnosticsRefreshButton
            isPending={isRuntimePending}
            label={uiText("Refresh runtime diagnostics", undefined, undefined, uiLocale)}
            checkedAt={runtimeData?.readAt ?? null}
            onClick={refreshRuntime}
          />
        }
      >
        <StatsGrid>
          <StatBlock
            label={uiText("Backend", undefined, undefined, uiLocale)}
            value={runtimeData ? `PID ${processData?.serverPid ?? "—"}` : runtimePlaceholder}
            tooltip={uiText(
              "Main backend process that owns orchestration, persistence, and RPC routes.",
              undefined,
              undefined,
              uiLocale,
            )}
          />
          <StatBlock
            label={uiText("Orchestrator lag", undefined, undefined, uiLocale)}
            value={
              runtimeData ? formatCount(runtimeData.orchestrator.projectionLag) : runtimePlaceholder
            }
            tone={runtimeData && runtimeData.orchestrator.projectionLag > 0 ? "warning" : "default"}
            tooltip={uiText(
              "Latest persisted orchestration sequence minus the slowest projector cursor.",
              undefined,
              undefined,
              uiLocale,
            )}
          />
          <StatBlock
            label={uiText("Provider daemon", undefined, undefined, uiLocale)}
            value={
              runtimeData
                ? runtimeData.providerDaemon.reachable
                  ? uiText("Online", undefined, undefined, uiLocale)
                  : runtimeData.providerDaemon.available
                    ? uiText("Probe failed", undefined, undefined, uiLocale)
                    : uiText("Not configured", undefined, undefined, uiLocale)
                : runtimePlaceholder
            }
            tone={
              runtimeData ? runtimeLayerStatusTone(runtimeData.providerDaemon.status) : "default"
            }
          />
          <StatBlock
            label={uiText("Tracked memory", undefined, undefined, uiLocale)}
            value={
              runtimeData ? uiPresentation.formatBytes(trackedRuntimeMemory) : runtimePlaceholder
            }
            tooltip={uiText(
              "Resident memory across backend, provider daemon, provider supervisor, and attributable child processes in the current process snapshot.",
              undefined,
              undefined,
              uiLocale,
            )}
          />
        </StatsGrid>
        <RuntimeDiagnosticsErrors errors={runtimeErrors} />
        <RuntimeLayersTable data={runtimeData} loading={isRuntimeInitialLoading} />
      </SettingsSection>

      <SettingsSection title={uiText("Orchestrator subprocesses", undefined, undefined, uiLocale)}>
        <StatsGrid>
          <StatBlock
            label={uiText("Processes", undefined, undefined, uiLocale)}
            value={runtimeData ? formatCount(runtimeData.subprocesses.length) : runtimePlaceholder}
          />
          <StatBlock
            label={uiText("CPU", undefined, undefined, uiLocale)}
            value={runtimeData ? `${trackedRuntimeCpu.toFixed(1)}%` : runtimePlaceholder}
          />
          <StatBlock
            label={uiText("Memory", undefined, undefined, uiLocale)}
            value={
              runtimeData ? uiPresentation.formatBytes(trackedRuntimeMemory) : runtimePlaceholder
            }
          />
          <StatBlock
            label={uiText("Partial read", undefined, undefined, uiLocale)}
            value={
              runtimeData
                ? runtimeData.partialFailure
                  ? uiText("Yes", undefined, undefined, uiLocale)
                  : uiText("No", undefined, undefined, uiLocale)
                : runtimePlaceholder
            }
            tone={runtimeData?.partialFailure ? "warning" : "default"}
          />
        </StatsGrid>
        <RuntimeProcessTable
          processes={runtimeData?.subprocesses ?? []}
          loading={isRuntimeInitialLoading}
        />
      </SettingsSection>

      <SettingsSection title={uiText("Orchestrator health", undefined, undefined, uiLocale)}>
        <StatsGrid>
          <StatBlock
            label={uiText("Event sequence", undefined, undefined, uiLocale)}
            value={
              runtimeData
                ? formatCount(runtimeData.orchestrator.latestEventSequence)
                : runtimePlaceholder
            }
          />
          <StatBlock
            label={uiText("Projection sequence", undefined, undefined, uiLocale)}
            value={
              runtimeData
                ? formatCount(runtimeData.orchestrator.projectionSequence)
                : runtimePlaceholder
            }
          />
          <StatBlock
            label={uiText("Provider ingest lag", undefined, undefined, uiLocale)}
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
            tooltip={uiText(
              "Provider daemon runtime events not yet ingested by the backend. If this grows while the provider daemon has recent events, the provider can be alive while chat projection appears stale.",
              undefined,
              undefined,
              uiLocale,
            )}
          />
          <StatBlock
            label={uiText("Queue", undefined, undefined, uiLocale)}
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
            label={uiText("Active turns", undefined, undefined, uiLocale)}
            value={
              runtimeData
                ? formatCount(runtimeData.orchestrator.activeTurnCount)
                : runtimePlaceholder
            }
          />
        </StatsGrid>
        <StatsGrid>
          <StatBlock
            label={uiText("Accepted", undefined, undefined, uiLocale)}
            value={
              runtimeData
                ? formatCount(runtimeData.orchestrator.acceptedCommandCount)
                : runtimePlaceholder
            }
          />
          <StatBlock
            label={uiText("Rejected", undefined, undefined, uiLocale)}
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
            label={uiText("Failed", undefined, undefined, uiLocale)}
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
            label={uiText("Stale flags", undefined, undefined, uiLocale)}
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

      <SettingsSection title={uiText("Provider daemon", undefined, undefined, uiLocale)}>
        <StatsGrid>
          <StatBlock
            label={uiText("Reachable", undefined, undefined, uiLocale)}
            value={
              runtimeData
                ? runtimeData.providerDaemon.reachable
                  ? uiText("Yes", undefined, undefined, uiLocale)
                  : uiText("No", undefined, undefined, uiLocale)
                : runtimePlaceholder
            }
            tone={
              runtimeData ? runtimeLayerStatusTone(runtimeData.providerDaemon.status) : "default"
            }
          />
          <StatBlock
            label={uiText("PID", undefined, undefined, uiLocale)}
            value={runtimeData ? String(runtimeData.providerDaemon.pid ?? "—") : runtimePlaceholder}
          />
          <StatBlock
            label={uiText("Sessions", undefined, undefined, uiLocale)}
            value={
              runtimeData
                ? formatCount(runtimeData.providerDaemon.activeSessionCount)
                : runtimePlaceholder
            }
          />
          <StatBlock
            label={uiText("Event streams", undefined, undefined, uiLocale)}
            value={
              runtimeData
                ? formatCount(runtimeData.providerDaemon.activeStreamCount)
                : runtimePlaceholder
            }
            tooltip={uiText(
              "Connected consumers of the daemon event journal. This is transport activity, not the number of active model turns.",
              undefined,
              undefined,
              uiLocale,
            )}
          />
        </StatsGrid>
        <StatsGrid>
          <StatBlock
            label={uiText("Events", undefined, undefined, uiLocale)}
            value={
              runtimeData
                ? formatCount(runtimeData.providerDaemon.retainedEventCount)
                : runtimePlaceholder
            }
          />
          <StatBlock
            label={uiText("Cursor", undefined, undefined, uiLocale)}
            value={
              runtimeData ? formatCount(runtimeData.providerDaemon.eventCursor) : runtimePlaceholder
            }
          />
          <StatBlock
            label={uiText("Commands", undefined, undefined, uiLocale)}
            value={
              runtimeData
                ? formatCount(runtimeData.providerDaemon.commandCount)
                : runtimePlaceholder
            }
          />
          <StatBlock
            label={uiText("Request failures", undefined, undefined, uiLocale)}
            value={
              runtimeData
                ? formatCount(runtimeData.providerDaemon.failedRpcCount)
                : runtimePlaceholder
            }
            tone={
              runtimeData && runtimeData.providerDaemon.failedRpcCount > 0 ? "warning" : "default"
            }
            tooltip={uiText(
              "Failed RPC calls to the provider daemon.",
              undefined,
              undefined,
              uiLocale,
            )}
          />
        </StatsGrid>
        <ProviderDaemonTables data={runtimeData} loading={isRuntimeInitialLoading} />
      </SettingsSection>

      <SettingsSection title={uiText("Provider pipeline", undefined, undefined, uiLocale)}>
        <StatsGrid>
          <StatBlock
            label={uiText("Loop p99", undefined, undefined, uiLocale)}
            value={
              providerPipeline
                ? uiPresentation.formatDuration(providerPipeline.eventLoop.p99LagMs)
                : runtimePlaceholder
            }
            tone={
              providerPipeline && providerPipeline.eventLoop.p99LagMs > 250 ? "warning" : "default"
            }
            tooltip={uiText(
              "Backend event-loop scheduling lag. Sustained growth can delay both provider ingestion and WebSocket progress.",
              undefined,
              undefined,
              uiLocale,
            )}
          />
          <StatBlock
            label={uiText("Loop max", undefined, undefined, uiLocale)}
            value={
              providerPipeline
                ? uiPresentation.formatDuration(providerPipeline.eventLoop.maxLagMs)
                : runtimePlaceholder
            }
          />
          <StatBlock
            label={uiText("Daemon queue", undefined, undefined, uiLocale)}
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
            label={uiText("Daemon queue size", undefined, undefined, uiLocale)}
            value={
              providerPipeline
                ? uiPresentation.formatBytes(providerPipeline.daemonStream.queuedLiveBytes)
                : runtimePlaceholder
            }
          />
        </StatsGrid>
        <StatsGrid>
          <StatBlock
            label={uiText("Bridge pending", undefined, undefined, uiLocale)}
            value={
              providerPipeline
                ? uiPresentation.formatBytes(providerPipeline.backendBridge.pendingBytes)
                : runtimePlaceholder
            }
          />
          <StatBlock
            label={uiText("Bridge pauses", undefined, undefined, uiLocale)}
            value={
              providerPipeline
                ? formatCount(providerPipeline.backendBridge.pauseCount)
                : runtimePlaceholder
            }
          />
          <StatBlock
            label={uiText("Subscribers", undefined, undefined, uiLocale)}
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
            label={uiText("Replay ring", undefined, undefined, uiLocale)}
            value={
              providerPipeline
                ? `${formatCount(providerPipeline.subscriptions.replayRingEvents)} / ${uiPresentation.formatBytes(providerPipeline.subscriptions.replayRingBytes)}`
                : runtimePlaceholder
            }
          />
        </StatsGrid>
        <StatsGrid>
          <StatBlock
            label={uiText("WebSocket bulk", undefined, undefined, uiLocale)}
            value={
              providerPipeline
                ? uiPresentation.formatBytes(providerPipeline.webSocket.activeBulkBytes)
                : runtimePlaceholder
            }
          />
          <StatBlock
            label={uiText("WebSocket overloads", undefined, undefined, uiLocale)}
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
            label={uiText("Compacted", undefined, undefined, uiLocale)}
            value={
              providerPipeline
                ? formatCount(providerPipeline.compaction.compactedEventCount)
                : runtimePlaceholder
            }
          />
          <StatBlock
            label={uiText("Quarantined", undefined, undefined, uiLocale)}
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

      <SettingsSection title={uiText("Provider supervisor", undefined, undefined, uiLocale)}>
        {runtimeData?.providerSupervisor.configured ? (
          <>
            <StatsGrid>
              <StatBlock
                label={uiText("Reachable", undefined, undefined, uiLocale)}
                value={
                  runtimeData.providerSupervisor.reachable
                    ? uiText("Yes", undefined, undefined, uiLocale)
                    : uiText("No", undefined, undefined, uiLocale)
                }
                tone={runtimeLayerStatusTone(runtimeData.providerSupervisor.status)}
              />
              <StatBlock
                label={uiText("PID", undefined, undefined, uiLocale)}
                value={String(runtimeData.providerSupervisor.pid ?? "—")}
              />
              <StatBlock
                label={uiText("Sessions", undefined, undefined, uiLocale)}
                value={formatCount(runtimeData.providerSupervisor.activeSessionCount)}
              />
              <StatBlock
                label={uiText("Event streams", undefined, undefined, uiLocale)}
                value={formatCount(runtimeData.providerSupervisor.activeStreamCount)}
                tooltip={uiText(
                  "Connected consumers of the optional supervisor event journal. This is transport activity, not the number of active model turns.",
                  undefined,
                  undefined,
                  uiLocale,
                )}
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
                <span>{uiText("Not configured", undefined, undefined, uiLocale)}</span>
                <InfoTip
                  label={uiText("About the provider supervisor", undefined, undefined, uiLocale)}
                >
                  {uiText(
                    "Optional. Providers run in the provider daemon, which is the default.",
                    undefined,
                    undefined,
                    uiLocale,
                  )}
                </InfoTip>
              </>
            ) : isRuntimeInitialLoading ? (
              runtimePlaceholder
            ) : (
              uiText("Unavailable", undefined, undefined, uiLocale)
            )}
          </div>
        )}
      </SettingsSection>

      <SettingsSection
        title={uiText("Live processes", undefined, undefined, uiLocale)}
        headerAction={
          <DiagnosticsRefreshButton
            isPending={isProcessPending}
            label={uiText("Refresh process diagnostics", undefined, undefined, uiLocale)}
            checkedAt={processData ? DateTime.formatIso(processData.readAt) : null}
            onClick={refreshProcesses}
          />
        }
      >
        <StatsGrid>
          <StatBlock
            label={uiText("Child processes", undefined, undefined, uiLocale)}
            value={processData ? formatCount(processData.processCount) : processPlaceholder}
          />
          <StatBlock
            label={uiText("CPU", undefined, undefined, uiLocale)}
            value={processData ? `${processData.totalCpuPercent.toFixed(1)}%` : processPlaceholder}
            tooltip={uiText(
              "Total CPU across live child processes of the current server process. The desktop shell and other parent processes are not included.",
              undefined,
              undefined,
              uiLocale,
            )}
          />
          <StatBlock
            label={uiText("Memory", undefined, undefined, uiLocale)}
            value={
              processData
                ? uiPresentation.formatBytes(processData.totalRssBytes)
                : processPlaceholder
            }
            tooltip={uiText(
              "Total resident memory across live child processes of the current server process. The desktop shell and other parent processes are not included.",
              undefined,
              undefined,
              uiLocale,
            )}
          />
          <StatBlock
            label={uiText("Server PID", undefined, undefined, uiLocale)}
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
        title={uiText("Resource history", undefined, undefined, uiLocale)}
        headerAction={
          <div className="flex items-center gap-1.5">
            <ResourceHistoryWindowSelector
              selectedWindowMs={resourceWindowMs}
              onSelect={setResourceWindowMs}
            />
            <DiagnosticsRefreshButton
              isPending={isResourcePending}
              label={uiText("Refresh resource history", undefined, undefined, uiLocale)}
              checkedAt={resourceData ? DateTime.formatIso(resourceData.readAt) : null}
              onClick={refreshResources}
            />
          </div>
        }
      >
        <StatsGrid>
          <StatBlock
            label={uiText("CPU time", undefined, undefined, uiLocale)}
            value={
              resourceData
                ? uiPresentation.formatCpuTime(resourceData.totalCpuSecondsApprox)
                : resourcePlaceholder
            }
            tooltip={uiText(
              "Approximate active CPU time for the Cafe Code server root process and its descendants during the selected window. It grows only while sampled processes use CPU and older samples leave as the window moves.",
              undefined,
              undefined,
              uiLocale,
            )}
          />
          <StatBlock
            label={uiText("Samples", undefined, undefined, uiLocale)}
            value={
              resourceData ? formatCount(resourceData.retainedSampleCount) : resourcePlaceholder
            }
            tooltip={uiText(
              "In-memory process samples retained by the server. This resets when the server restarts.",
              undefined,
              undefined,
              uiLocale,
            )}
          />
          <StatBlock
            label={uiText("Interval", undefined, undefined, uiLocale)}
            value={
              resourceData
                ? uiPresentation.formatDuration(resourceData.sampleIntervalMs)
                : resourcePlaceholder
            }
          />
          <StatBlock
            label={uiText("Processes", undefined, undefined, uiLocale)}
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
        title={uiText("Traces", undefined, undefined, uiLocale)}
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
                    aria-label={
                      canOpenLocalEditor
                        ? uiText("Open logs folder", undefined, undefined, uiLocale)
                        : uiText("Copy logs folder path", undefined, undefined, uiLocale)
                    }
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
                {canOpenLocalEditor
                  ? uiText("Open logs folder", undefined, undefined, uiLocale)
                  : uiText("Copy logs folder path", undefined, undefined, uiLocale)}
              </TooltipPopup>
            </Tooltip>
            <DiagnosticsRefreshButton
              isPending={isPending}
              label={uiText("Refresh trace diagnostics", undefined, undefined, uiLocale)}
              checkedAt={data ? DateTime.formatIso(data.readAt) : null}
              onClick={refresh}
            />
          </div>
        }
      >
        <StatsGrid>
          <StatBlock
            label={uiText("Spans", undefined, undefined, uiLocale)}
            value={data ? formatCount(data.recordCount) : tracePlaceholder}
          />
          <StatBlock
            label={uiText("Failures", undefined, undefined, uiLocale)}
            value={data ? formatCount(data.failureCount) : tracePlaceholder}
            tone={data && data.failureCount > 0 ? "danger" : "default"}
          />
          <StatBlock
            label={uiText("Slow spans", undefined, undefined, uiLocale)}
            value={data ? formatCount(data.slowSpanCount) : tracePlaceholder}
            tooltip={
              data
                ? uiText(
                    "Spans with a duration of {value0} or longer.",
                    {
                      value0: uiPresentation.formatDuration(data.slowSpanThresholdMs),
                    },
                    undefined,
                    uiLocale,
                  )
                : uiText(
                    "Spans at or above the configured slow-span threshold.",
                    undefined,
                    undefined,
                    uiLocale,
                  )
            }
            tone={data && data.slowSpanCount > 0 ? "warning" : "default"}
          />
          <StatBlock
            label={uiText("Parse errors", undefined, undefined, uiLocale)}
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
                    ? uiText(
                        "Some trace files couldn''t be read: {value0}",
                        {
                          value0: traceDiagnosticsError.message,
                        },
                        undefined,
                        uiLocale,
                      )
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

      <SettingsSection title={uiText("Latest failures", undefined, undefined, uiLocale)}>
        {data && data.latestFailures.length > 0 ? (
          <DiagnosticsTable
            headers={[
              uiText("Span", undefined, undefined, uiLocale),
              uiText("Cause", undefined, undefined, uiLocale),
              uiText("Duration", undefined, undefined, uiLocale),
              uiText("Ended", undefined, undefined, uiLocale),
            ]}
          >
            {data.latestFailures.map((failure) => (
              <tr key={`${failure.traceId}:${failure.spanId}`}>
                <td className="px-4 py-3 align-top text-xs font-medium text-foreground first:sm:pl-5">
                  {failure.name}
                </td>
                <td className="max-w-[360px] px-4 py-3 align-top text-muted-foreground">
                  <ExpandableText text={failure.cause} />
                </td>
                <td className="px-4 py-3 align-top font-mono tabular-nums">
                  {uiPresentation.formatDuration(failure.durationMs)}
                </td>
                <td className="whitespace-nowrap px-4 py-3 align-top font-mono tabular-nums text-muted-foreground last:sm:pr-5">
                  {uiPresentation.formatRelativeNoWrap(failure.endedAt)}
                </td>
              </tr>
            ))}
          </DiagnosticsTable>
        ) : (
          <EmptyRows
            loading={isInitialLoading}
            label={uiText("No failed spans found.", undefined, undefined, uiLocale)}
          />
        )}
      </SettingsSection>

      <SettingsSection title={uiText("Most common failures", undefined, undefined, uiLocale)}>
        {data && data.commonFailures.length > 0 ? (
          <DiagnosticsTable
            headers={[
              uiText("Span", undefined, undefined, uiLocale),
              uiText("Count", undefined, undefined, uiLocale),
              uiText("Cause", undefined, undefined, uiLocale),
              uiText("Last seen", undefined, undefined, uiLocale),
            ]}
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
                  {uiPresentation.formatRelativeNoWrap(failure.lastSeenAt)}
                </td>
              </tr>
            ))}
          </DiagnosticsTable>
        ) : (
          <EmptyRows
            loading={isInitialLoading}
            label={uiText("No repeated failures found.", undefined, undefined, uiLocale)}
          />
        )}
      </SettingsSection>

      <SettingsSection title={uiText("Slowest spans", undefined, undefined, uiLocale)}>
        {data && data.slowestSpans.length > 0 ? (
          <DiagnosticsTable
            headers={[
              uiText("Span", undefined, undefined, uiLocale),
              uiText("Duration", undefined, undefined, uiLocale),
              uiText("Ended", undefined, undefined, uiLocale),
              uiText("Trace", undefined, undefined, uiLocale),
            ]}
            minTableWidth="min-w-[900px]"
            columnWidths={["w-[44%]", "w-[14%]", "w-[12%]", "w-[30%]"]}
          >
            {data.slowestSpans.map((span) => (
              <tr key={`${span.traceId}:${span.spanId}`}>
                <td className="px-4 py-3 align-top text-xs font-medium text-foreground first:sm:pl-5">
                  {span.name}
                </td>
                <td className="px-4 py-3 align-top font-mono tabular-nums">
                  {uiPresentation.formatDuration(span.durationMs)}
                </td>
                <td className="w-px whitespace-nowrap px-4 py-3 align-top font-mono tabular-nums text-muted-foreground">
                  {uiPresentation.formatRelativeNoWrap(span.endedAt)}
                </td>
                <td className="min-w-0 whitespace-nowrap px-4 py-3 align-top text-muted-foreground last:sm:pr-5">
                  <TraceIdCell traceId={span.traceId} />
                </td>
              </tr>
            ))}
          </DiagnosticsTable>
        ) : (
          <EmptyRows
            loading={isInitialLoading}
            label={uiText("No spans found.", undefined, undefined, uiLocale)}
          />
        )}
      </SettingsSection>

      <SettingsSection title={uiText("Span logs", undefined, undefined, uiLocale)}>
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
                  <th className="whitespace-nowrap px-4 py-2.5 font-medium sm:pl-5">
                    {uiText("Time", undefined, undefined, uiLocale)}
                  </th>
                  <th className="whitespace-nowrap px-4 py-2.5 font-medium">
                    {uiText("Level", undefined, undefined, uiLocale)}
                  </th>
                  <th className="whitespace-nowrap px-4 py-2.5 font-medium">
                    {uiText("Span", undefined, undefined, uiLocale)}
                  </th>
                  <th className="whitespace-nowrap px-4 py-2.5 font-medium">
                    {uiText("Message", undefined, undefined, uiLocale)}
                  </th>
                  <th className="whitespace-nowrap px-4 py-2.5 font-medium sm:pr-5">
                    {uiText("Trace", undefined, undefined, uiLocale)}
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {data.latestWarningAndErrorLogs.map((event) => (
                  <tr
                    key={`${event.traceId}:${event.spanId}:${DateTime.formatIso(event.seenAt)}:${event.message}`}
                    className="hover:bg-muted/15"
                  >
                    <td className="whitespace-nowrap px-4 py-3 align-top font-mono tabular-nums text-muted-foreground sm:pl-5">
                      {uiPresentation.formatRelativeNoWrap(event.seenAt)}
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
                        expandLabel={uiText("Show full message", undefined, undefined, uiLocale)}
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
          <EmptyRows
            loading={isInitialLoading}
            label={uiText("No warnings or errors found.", undefined, undefined, uiLocale)}
          />
        )}
      </SettingsSection>

      <SettingsSection title={uiText("Top span names", undefined, undefined, uiLocale)}>
        {data && data.topSpansByCount.length > 0 ? (
          <DiagnosticsTable
            headers={[
              uiText("Span", undefined, undefined, uiLocale),
              uiText("Count", undefined, undefined, uiLocale),
              uiText("Failures", undefined, undefined, uiLocale),
              uiText("Average", undefined, undefined, uiLocale),
              uiText("Max", undefined, undefined, uiLocale),
            ]}
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
                  {uiPresentation.formatDuration(span.averageDurationMs)}
                </td>
                <td className="whitespace-nowrap px-4 py-3 align-top font-mono tabular-nums last:sm:pr-5">
                  {uiPresentation.formatDuration(span.maxDurationMs)}
                </td>
              </tr>
            ))}
          </DiagnosticsTable>
        ) : (
          <EmptyRows
            loading={isInitialLoading}
            label={uiText("No spans found.", undefined, undefined, uiLocale)}
          />
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}

// Finite source-owned labels/helpers only; no received or user data.
const UI_PRESENTATION_SOURCES = {
  RESOURCE_HISTORY_WINDOWS,
  formatBytes,
  formatCpuTime,
  formatDuration,
  formatProcessType,
  formatRelativeIsoNoWrap,
  formatRelativeNoWrap,
  formatRelativeTime,
  formatRelativeTimeLabel,
  formatRuntimeLayerRole,
  formatRuntimeLayerStatus,
  visibleRuntimeErrors,
};
