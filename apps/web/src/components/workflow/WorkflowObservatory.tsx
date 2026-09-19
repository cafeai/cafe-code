import {
  BotIcon,
  CheckIcon,
  CircleAlertIcon,
  CircleDashedIcon,
  Clock3Icon,
  ListTreeIcon,
  NetworkIcon,
  PauseIcon,
  StopCircleIcon,
} from "lucide-react";
import { memo, type ReactNode, useEffect, useState } from "react";

import type { ActivePlanState } from "../../session-logic";
import type { TimestampFormat } from "@cafecode/contracts/settings";

import { formatTimestamp } from "../../timestampFormat";
import type {
  WorkflowNode,
  WorkflowNodeStatus,
  WorkflowProjectionSnapshot,
} from "../../workflowProjection";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { WorkflowGraph } from "./WorkflowGraph";

/**
 * Read-only view of the workflow that the selected thread recorded.
 *
 * The component renders one projection snapshot. It starts no request, and it
 * never asks a provider for state, so opening the view cannot change a run.
 */

/** Seconds without a recorded update before the view shows a quiet-time note. */
const QUIET_NOTE_SECONDS = 90;

const NON_TERMINAL_STATUSES: ReadonlySet<WorkflowNodeStatus> = new Set([
  "queued",
  "running",
  "waiting",
]);

function statusPresentation(status: WorkflowNodeStatus): {
  readonly icon: ReactNode;
  readonly label: string;
  readonly className: string;
} {
  switch (status) {
    case "queued":
      return {
        icon: <Clock3Icon aria-hidden="true" className="size-3.5" />,
        label: "Queued",
        className: "text-amber-400",
      };
    case "running":
      return {
        icon: <CircleDashedIcon aria-hidden="true" className="size-3.5" />,
        label: "Running",
        className: "text-blue-400",
      };
    case "waiting":
      return {
        icon: <PauseIcon aria-hidden="true" className="size-3.5" />,
        label: "Waiting",
        className: "text-violet-400",
      };
    case "completed":
      return {
        icon: <CheckIcon aria-hidden="true" className="size-3.5" />,
        label: "Completed",
        className: "text-emerald-400",
      };
    case "failed":
      return {
        icon: <CircleAlertIcon aria-hidden="true" className="size-3.5" />,
        label: "Failed",
        className: "text-red-400",
      };
    case "interrupted":
      return {
        icon: <StopCircleIcon aria-hidden="true" className="size-3.5" />,
        label: "Interrupted",
        className: "text-orange-400",
      };
    case "unknown":
      return {
        icon: <BotIcon aria-hidden="true" className="size-3.5" />,
        label: "Not reported",
        className: "text-muted-foreground",
      };
  }
}

function fidelityLabel(fidelity: WorkflowProjectionSnapshot["fidelity"]): string {
  switch (fidelity) {
    case "live":
      return "Live progress";
    case "lifecycle-only":
      return "Lifecycle only";
    case "not-reported":
      return "Not reported";
  }
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainderSeconds = seconds % 60;
  return [
    ...(hours > 0 ? [`${hours}h`] : []),
    ...(minutes > 0 ? [`${minutes}m`] : []),
    ...(hours === 0 && remainderSeconds > 0 ? [`${remainderSeconds}s`] : []),
  ].join(" ");
}

function ageInSeconds(iso: string | null, nowMs: number): number | null {
  if (!iso) return null;
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, Math.floor((nowMs - timestamp) / 1_000));
}

/**
 * Ticks once a second only while a node is not in a terminal state. The clock
 * updates the elapsed labels; it never changes a reported status.
 */
function useWorkflowClock(nodes: readonly WorkflowNode[]): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const hasOpenNode = nodes.some((node) => NON_TERMINAL_STATUSES.has(node.status));

  useEffect(() => {
    if (!hasOpenNode) return;
    const interval = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [hasOpenNode]);

  return nowMs;
}

const WorkflowNodeCard = memo(function WorkflowNodeCard({
  expanded,
  node,
  nowMs,
  onExpandedChange,
  timestampFormat,
}: {
  readonly expanded: boolean;
  readonly node: WorkflowNode;
  readonly nowMs: number;
  readonly onExpandedChange: (expanded: boolean) => void;
  readonly timestampFormat: TimestampFormat;
}) {
  const status = statusPresentation(node.status);
  const lastActivityAgeSeconds = ageInSeconds(node.lastActivityAt, nowMs);
  const quiet =
    NON_TERMINAL_STATUSES.has(node.status) &&
    lastActivityAgeSeconds !== null &&
    lastActivityAgeSeconds >= QUIET_NOTE_SECONDS;

  return (
    <li className="list-none" data-testid={`workflow-node-${node.id}`}>
      <div className="rounded-lg border border-border/50 bg-background/45 px-2.5 py-2">
        <button
          aria-expanded={expanded}
          aria-label={`${expanded ? "Collapse" : "Expand"} details for ${node.title}`}
          className="flex w-full min-w-0 cursor-pointer items-start justify-between gap-2 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          onClick={() => onExpandedChange(!expanded)}
          type="button"
        >
          <span className="min-w-0">
            <span className="block truncate text-[12px] font-medium text-foreground/90">
              {node.title}
            </span>
            <span className="mt-0.5 block truncate text-[10px] text-muted-foreground/55">
              {node.kind === "thread" ? "Thread" : "Agent reported by the provider"}
            </span>
          </span>
          <span
            className={`flex shrink-0 items-center gap-1 text-[10px] font-medium ${status.className}`}
          >
            {status.icon}
            {status.label}
          </span>
        </button>
        {expanded ? (
          <div className="mt-2 space-y-1 border-t border-border/40 pt-2">
            <p className="text-[11px] leading-relaxed text-muted-foreground/75">
              {node.objective ?? node.detail ?? "Objective not reported"}
            </p>
            <p className="text-[10px] leading-relaxed text-muted-foreground/65">
              <span className="font-medium text-muted-foreground/80">Latest detail: </span>
              {node.detail ?? "Not reported"}
            </p>
            <p className="text-[10px] text-muted-foreground/55">
              <span className="font-medium text-muted-foreground/75">Observed span: </span>
              {node.observedSpanSeconds === null
                ? "Not reported"
                : `${formatDuration(node.observedSpanSeconds)} between the first and the last recorded update`}
            </p>
            <p className="text-[10px] leading-relaxed text-muted-foreground/55">
              <span className="font-medium text-muted-foreground/75">Last activity: </span>
              {node.lastActivityAt && lastActivityAgeSeconds !== null ? (
                <time dateTime={node.lastActivityAt} title={node.lastActivityAt}>
                  {formatTimestamp(node.lastActivityAt, timestampFormat)} (
                  {formatDuration(lastActivityAgeSeconds)} ago)
                </time>
              ) : (
                "Not reported"
              )}
            </p>
            {quiet && lastActivityAgeSeconds !== null ? (
              <p
                className="rounded-md border border-amber-400/30 bg-amber-400/10 px-2 py-1 text-[10px] leading-relaxed text-amber-300"
                data-testid={`workflow-node-quiet-${node.id}`}
                role="status"
              >
                No recorded update for {formatDuration(lastActivityAgeSeconds)}. The last reported
                state is shown. This is not proof that the agent stopped.
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </li>
  );
});

export const WorkflowObservatory = memo(function WorkflowObservatory({
  activePlan,
  snapshot,
  timestampFormat,
}: {
  readonly activePlan: ActivePlanState | null;
  readonly snapshot: WorkflowProjectionSnapshot;
  readonly timestampFormat: TimestampFormat;
}) {
  const [view, setView] = useState<"list" | "graph">("list");
  const [expandedNodeById, setExpandedNodeById] = useState<Readonly<Record<string, boolean>>>({});
  const nowMs = useWorkflowClock(snapshot.nodes);

  // A thread or environment switch replaces the source. Drop the per-node view
  // state so an expanded card cannot carry over to a different thread.
  useEffect(() => {
    setExpandedNodeById({});
    setView("list");
  }, [snapshot.environmentId, snapshot.threadId]);

  return (
    <div className="space-y-4" data-testid="workflow-observatory">
      <section aria-labelledby="workflow-plan-heading" className="space-y-2">
        <h2
          id="workflow-plan-heading"
          className="text-[10px] font-semibold tracking-widest text-muted-foreground/45 uppercase"
        >
          Current plan
        </h2>
        {activePlan?.steps.length ? (
          <ol
            className="space-y-1 rounded-lg border border-border/45 p-2"
            data-testid="workflow-plan"
          >
            {activePlan.steps.map((step) => {
              const presentation = statusPresentation(
                step.status === "completed"
                  ? "completed"
                  : step.status === "inProgress"
                    ? "running"
                    : "queued",
              );
              return (
                <li
                  className="flex items-start gap-2 text-[11px] text-foreground/80"
                  key={`${step.status}:${step.step}`}
                >
                  <span className={`mt-0.5 shrink-0 ${presentation.className}`}>
                    {presentation.icon}
                    <span className="sr-only">{presentation.label}</span>
                  </span>
                  <span className="leading-relaxed">{step.step}</span>
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="rounded-lg border border-border/45 px-3 py-3 text-[11px] text-muted-foreground/50">
            No plan reported for this thread.
          </p>
        )}
      </section>

      <section aria-labelledby="workflow-agents-heading" className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h2
            id="workflow-agents-heading"
            className="text-[10px] font-semibold tracking-widest text-muted-foreground/45 uppercase"
          >
            Thread and agents
          </h2>
          <div className="flex items-center gap-1">
            <Button
              aria-pressed={view === "list"}
              onClick={() => setView("list")}
              size="xs"
              variant={view === "list" ? "secondary" : "ghost"}
            >
              <ListTreeIcon />
              List
            </Button>
            <Button
              aria-pressed={view === "graph"}
              onClick={() => setView("graph")}
              size="xs"
              variant={view === "graph" ? "secondary" : "ghost"}
            >
              <NetworkIcon />
              Graph
            </Button>
            <Badge
              className="h-5 rounded-md px-1.5 text-[9px]"
              data-testid="workflow-fidelity"
              variant="secondary"
            >
              {fidelityLabel(snapshot.fidelity)}
            </Badge>
          </div>
        </div>

        <p
          className="rounded-md border border-border/45 bg-background/35 px-2 py-1 text-[10px] text-muted-foreground/65"
          data-testid="workflow-source-summary"
        >
          {snapshot.providerLabel
            ? `Provider: ${snapshot.providerLabel}`
            : "Provider: not reported"}
          {snapshot.modelLabel ? ` · Model: ${snapshot.modelLabel}` : " · Model: not reported"}
          {" · "}
          Agents reported: {snapshot.agentCount}
        </p>

        {snapshot.nodes.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border/60 px-3 py-8 text-center">
            <p className="text-[12px] text-muted-foreground/60">No thread is selected.</p>
          </div>
        ) : view === "graph" ? (
          <WorkflowGraph nodes={snapshot.nodes} />
        ) : (
          <ul aria-label="Thread and reported agents" className="space-y-1.5">
            {snapshot.nodes.map((node) => (
              <WorkflowNodeCard
                expanded={expandedNodeById[node.id] ?? NON_TERMINAL_STATUSES.has(node.status)}
                key={node.id}
                node={node}
                nowMs={nowMs}
                onExpandedChange={(expanded) =>
                  setExpandedNodeById((previous) => ({ ...previous, [node.id]: expanded }))
                }
                timestampFormat={timestampFormat}
              />
            ))}
          </ul>
        )}

        {snapshot.agentCount === 0 && snapshot.threadId !== null ? (
          <p className="text-[10px] text-muted-foreground/50" data-testid="workflow-no-agents">
            This provider reported no agent lifecycle for this thread.
          </p>
        ) : null}
      </section>

      <section aria-labelledby="workflow-activity-heading" className="space-y-2">
        <h2
          id="workflow-activity-heading"
          className="text-[10px] font-semibold tracking-widest text-muted-foreground/45 uppercase"
        >
          Recent activity
        </h2>
        {snapshot.recentActivities.length === 0 ? (
          <p className="rounded-lg border border-border/45 px-3 py-4 text-[11px] text-muted-foreground/50">
            No recorded workflow activity.
          </p>
        ) : (
          <ol
            aria-label="Recorded workflow activity, newest first"
            className="max-h-64 overflow-y-auto rounded-lg border border-border/45"
            data-testid="workflow-recent-activity"
          >
            {snapshot.recentActivities.map((activity) => (
              <li
                className="flex min-w-0 gap-2 border-b border-border/35 px-2 py-2 last:border-b-0"
                key={`${activity.id}:${activity.createdAt}`}
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[11px] text-foreground/80">{activity.summary}</p>
                  <p className="mt-0.5 flex gap-1.5 text-[9px] text-muted-foreground/45">
                    <span className="truncate">{activity.kind}</span>
                    <span aria-hidden="true">·</span>
                    <time dateTime={activity.createdAt}>
                      {formatTimestamp(activity.createdAt, timestampFormat)}
                    </time>
                  </p>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section aria-labelledby="workflow-limits-heading" className="space-y-1">
        <h2
          id="workflow-limits-heading"
          className="text-[10px] font-semibold tracking-widest text-muted-foreground/45 uppercase"
        >
          Limits
        </h2>
        <ul
          className="space-y-1 rounded-lg border border-border/45 px-2.5 py-2 text-[10px] leading-relaxed text-muted-foreground/60"
          data-testid="workflow-limits"
        >
          <li>Cafe reads recorded thread events. It does not poll or prompt the provider.</li>
          <li>
            An edge shows the thread that recorded an agent. Providers do not report which agent
            started another agent.
          </li>
          <li>
            Durations are observed spans between recorded updates. Providers report no task
            duration.
          </li>
          {snapshot.omittedNodeCount > 0 ? (
            <li data-testid="workflow-omitted-nodes">
              {snapshot.omittedNodeCount} node
              {snapshot.omittedNodeCount === 1 ? " is" : "s are"} omitted to keep this view bounded.
            </li>
          ) : null}
          {snapshot.omittedActivityCount > 0 ? (
            <li data-testid="workflow-omitted-activities">
              {snapshot.omittedActivityCount} older activity row
              {snapshot.omittedActivityCount === 1 ? " is" : "s are"} omitted.
            </li>
          ) : null}
          {snapshot.duplicateNodeIdCount > 0 ? (
            <li data-testid="workflow-duplicate-nodes">
              {snapshot.duplicateNodeIdCount} source row
              {snapshot.duplicateNodeIdCount === 1 ? " used" : "s used"} an identifier that is
              already in use. Cafe dropped the repeat.
            </li>
          ) : null}
        </ul>
      </section>
    </div>
  );
});
