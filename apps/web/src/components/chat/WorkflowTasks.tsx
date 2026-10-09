import { memo, type ReactNode } from "react";

import type { DerivedWorkflowTask, WorkflowTaskStatus } from "../../workflowTaskActivity";
import { formatDuration } from "../../session-logic";
import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import { InfoTip } from "../ui/info-tip";

const TOKEN_FORMATTER = new Intl.NumberFormat(undefined);
const STATUS_LABELS: Readonly<Record<WorkflowTaskStatus | "pending", string>> = {
  pending: "Waiting",
  running: "Working",
  completed: "Done",
  failed: "Failed",
  stopped: "Stopped",
  unknown: "Status unavailable",
};

function statusStyle(status: WorkflowTaskStatus | "pending"): string {
  return status === "running"
    ? "text-status-running"
    : status === "failed"
      ? "text-destructive-foreground"
      : "text-muted-foreground";
}

function reportedTokens(value: number | undefined): string {
  return value === undefined ? "Tokens unavailable" : `${TOKEN_FORMATTER.format(value)} tokens`;
}

/**
 * Snapshot agents are deliberately inert rows. Their indices group the public
 * snapshot only; no avatar/history/control route is constructed from them.
 */
function WorkflowAgentRow({
  agent,
  rootStatus,
}: {
  readonly agent: NonNullable<DerivedWorkflowTask["workflow"]["agents"]>[number];
  readonly rootStatus: WorkflowTaskStatus;
}) {
  const observedStatus = agent.status ?? "unknown";
  // Root retirement does not manufacture an agent's terminal outcome. Retain
  // a received Done/Failed edge; old Working/Waiting remains unverified.
  const status =
    (observedStatus === "running" || observedStatus === "pending") && rootStatus !== "running"
      ? "unknown"
      : observedStatus;
  return (
    <li className="min-w-0 rounded-md bg-muted px-2.5 py-2" data-workflow-agent-row="true">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-3 gap-y-1">
        <span className="min-w-0 flex-1 break-words text-xs font-medium text-foreground [overflow-wrap:anywhere]">
          {agent.label ?? `Agent ${agent.index}`}
        </span>
        <span className={cn("text-2xs", statusStyle(status))} data-workflow-agent-status="true">
          {STATUS_LABELS[status]}
        </span>
      </div>
      <p
        className="mt-1 break-words text-2xs text-muted-foreground [overflow-wrap:anywhere]"
        data-workflow-agent-model="true"
      >
        {agent.model ?? "Model unavailable"}
        {agent.fallbackModel ? ` · Fallback: ${agent.fallbackModel}` : null}
      </p>
      <p
        className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-2xs text-subtle-foreground tabular-nums"
        data-workflow-agent-usage="true"
      >
        <span>{reportedTokens(agent.totalTokens)}</span>
        <span>
          {agent.durationMs === undefined
            ? "Duration unavailable"
            : formatDuration(agent.durationMs)}
        </span>
      </p>
    </li>
  );
}

export const WorkflowTaskCard = memo(function WorkflowTaskCard({
  task,
  footer,
}: {
  readonly task: DerivedWorkflowTask;
  readonly footer?: ReactNode;
}) {
  const phases = task.workflow.phases ?? [];
  const agents = task.workflow.agents ?? [];
  const hasSnapshot = task.workflow.phases !== undefined && task.workflow.agents !== undefined;
  const phaseIndices = new Set(phases.map((phase) => phase.index));
  const ungrouped = agents.filter(
    (agent) => agent.phaseIndex === undefined || !phaseIndices.has(agent.phaseIndex),
  );
  return (
    <article
      aria-label={`Workflow: ${task.title}`}
      className="min-w-0 rounded-xl border border-border-subtle bg-card p-3"
      data-workflow-task-card="true"
    >
      <header className="flex min-w-0 flex-wrap items-start justify-between gap-x-3 gap-y-1.5">
        <h3 className="min-w-0 flex-1 break-words text-sm font-medium [overflow-wrap:anywhere]">
          {task.title}
        </h3>
        <Badge variant="secondary" size="sm" className={statusStyle(task.status)}>
          {STATUS_LABELS[task.status]}
        </Badge>
      </header>
      {task.description ? (
        <p className="mt-1.5 break-words text-xs text-muted-foreground [overflow-wrap:anywhere]">
          {task.description}
        </p>
      ) : null}
      {task.summary && task.summary !== task.description ? (
        <p className="mt-1.5 break-words text-xs text-foreground [overflow-wrap:anywhere]">
          {task.summary}
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-subtle-foreground tabular-nums">
        {hasSnapshot ? (
          <span>
            {phases.length} {phases.length === 1 ? "phase" : "phases"} · {agents.length}{" "}
            {agents.length === 1 ? "agent" : "agents"}
          </span>
        ) : null}
        {task.totalTokens !== undefined ? <span>{reportedTokens(task.totalTokens)}</span> : null}
        {task.durationMs !== undefined ? <span>{formatDuration(task.durationMs)}</span> : null}
        <InfoTip label="About workflow telemetry">
          Model, tokens, duration and status are reported by Claude. Missing values remain
          unavailable; token counts are not billing totals. Duration is the reported work time, not
          a running clock.
        </InfoTip>
      </div>
      {!hasSnapshot ? (
        <p className="mt-3 text-xs text-muted-foreground">Phase details unavailable.</p>
      ) : (
        <div className="mt-3 space-y-3">
          {phases.map((phase) => {
            const phaseAgents = agents.filter((agent) => agent.phaseIndex === phase.index);
            // This is progress within the received snapshot only, not a phase
            // completion claim. Root outcomes, missing rows and failed agents
            // cannot increase the numerator or invent the expected team size.
            const completedAgents = phaseAgents.filter(
              (agent) => agent.status === "completed",
            ).length;
            return (
              <section
                key={phase.index}
                aria-label={`Phase ${phase.index}: ${phase.title ?? "Untitled phase"}`}
                data-workflow-phase="true"
              >
                <div className="mb-1.5 flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <h4 className="min-w-0 break-words text-xs font-medium [overflow-wrap:anywhere]">
                    {phase.title ?? `Phase ${phase.index}`}
                  </h4>
                  {phase.kind ? (
                    <span className="break-words text-2xs text-subtle-foreground [overflow-wrap:anywhere]">
                      {phase.kind}
                    </span>
                  ) : null}
                  {phaseAgents.length > 0 ? (
                    <span
                      className="text-2xs text-subtle-foreground tabular-nums"
                      data-workflow-phase-progress="true"
                    >
                      {completedAgents}/{phaseAgents.length} reported agents done
                    </span>
                  ) : null}
                </div>
                {phaseAgents.length ? (
                  <ul className="space-y-1.5" aria-label={`Agents in phase ${phase.index}`}>
                    {phaseAgents.map((agent) => (
                      <WorkflowAgentRow key={agent.index} agent={agent} rootStatus={task.status} />
                    ))}
                  </ul>
                ) : (
                  <p className="text-2xs text-subtle-foreground">No agents reported.</p>
                )}
              </section>
            );
          })}
          {ungrouped.length ? (
            <section aria-label="Agents without a reported phase">
              <h4 className="mb-1.5 text-xs font-medium">Other agents</h4>
              <ul className="space-y-1.5">
                {ungrouped.map((agent) => (
                  <WorkflowAgentRow key={agent.index} agent={agent} rootStatus={task.status} />
                ))}
              </ul>
            </section>
          ) : null}
          {phases.length === 0 && agents.length === 0 ? (
            <p className="text-xs text-muted-foreground">No phase activity reported.</p>
          ) : null}
        </div>
      )}
      {task.workflow.truncated ? (
        <p className="mt-2 text-2xs text-muted-foreground">Some workflow details were omitted.</p>
      ) : null}
      {footer ? <div className="-mx-3 -mb-3 mt-3">{footer}</div> : null}
    </article>
  );
});
