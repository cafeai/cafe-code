import { useUiLocale, useUiPresentation } from "~/i18n";
import { uiText } from "@cafecode/shared/i18n";
import { UiMessage } from "~/i18n";
import { memo, type ReactNode } from "react";

import type { DerivedWorkflowTask, WorkflowTaskStatus } from "../../workflowTaskActivity";
import { formatDuration } from "../../session-logic";
import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import { InfoTip } from "../ui/info-tip";

const TOKEN_FORMATTER = new Intl.NumberFormat(undefined);
const STATUS_LABELS: Readonly<Record<WorkflowTaskStatus | "pending", string>> = {
  get pending() {
    return uiText("Waiting");
  },
  get running() {
    return uiText("Working");
  },
  get completed() {
    return uiText("Done");
  },
  get failed() {
    return uiText("Failed");
  },
  get stopped() {
    return uiText("Stopped");
  },
  get unknown() {
    return uiText("Status unavailable");
  },
};

function statusStyle(status: WorkflowTaskStatus | "pending"): string {
  return status === "running"
    ? "text-status-running"
    : status === "failed"
      ? "text-destructive-foreground"
      : "text-muted-foreground";
}

function reportedTokens(value: number | undefined): string {
  return value === undefined
    ? uiText("Tokens unavailable")
    : uiText("{count, plural, one {{formatted} token} other {{formatted} tokens}}", {
        count: value,
        formatted: TOKEN_FORMATTER.format(value),
      });
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
  const uiLocale = useUiLocale();
  const uiPresentation = useUiPresentation(UI_PRESENTATION_SOURCES);

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
          {agent.label ?? uiText("Agent {value0}", { value0: agent.index }, undefined, uiLocale)}
        </span>
        <span className={cn("text-2xs", statusStyle(status))} data-workflow-agent-status="true">
          {uiPresentation.STATUS_LABELS[status]}
        </span>
      </div>
      <p
        className="mt-1 break-words text-2xs text-muted-foreground [overflow-wrap:anywhere]"
        data-workflow-agent-model="true"
      >
        {agent.model ?? uiText("Model unavailable", undefined, undefined, uiLocale)}
        {agent.fallbackModel
          ? uiText(" · Fallback: {value0}", { value0: agent.fallbackModel }, undefined, uiLocale)
          : null}
      </p>
      <p
        className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-2xs text-subtle-foreground tabular-nums"
        data-workflow-agent-usage="true"
      >
        <span>{uiPresentation.reportedTokens(agent.totalTokens)}</span>
        <span>
          {agent.durationMs === undefined
            ? uiText("Duration unavailable", undefined, undefined, uiLocale)
            : uiPresentation.formatDuration(agent.durationMs)}
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
  const uiLocale = useUiLocale();
  const uiPresentation = useUiPresentation(UI_PRESENTATION_SOURCES);

  const phases = task.workflow.phases ?? [];
  const agents = task.workflow.agents ?? [];
  const hasSnapshot = task.workflow.phases !== undefined && task.workflow.agents !== undefined;
  const phaseIndices = new Set(phases.map((phase) => phase.index));
  const ungrouped = agents.filter(
    (agent) => agent.phaseIndex === undefined || !phaseIndices.has(agent.phaseIndex),
  );
  return (
    <article
      aria-label={uiText("Workflow: {value0}", { value0: task.title }, undefined, uiLocale)}
      className="min-w-0 rounded-xl border border-border-subtle bg-card p-3"
      data-workflow-task-card="true"
    >
      <header className="flex min-w-0 flex-wrap items-start justify-between gap-x-3 gap-y-1.5">
        <h3 className="min-w-0 flex-1 break-words text-sm font-medium [overflow-wrap:anywhere]">
          {task.title}
        </h3>
        <Badge variant="secondary" size="sm" className={statusStyle(task.status)}>
          {uiPresentation.STATUS_LABELS[task.status]}
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
            {phases.length}{" "}
            {phases.length === 1
              ? uiText("phase", undefined, undefined, uiLocale)
              : uiText("phases", undefined, undefined, uiLocale)}{" "}
            · {agents.length}{" "}
            {agents.length === 1
              ? uiText("agent", undefined, undefined, uiLocale)
              : uiText("agents", undefined, undefined, uiLocale)}
          </span>
        ) : null}
        {task.totalTokens !== undefined ? (
          <span>{uiPresentation.reportedTokens(task.totalTokens)}</span>
        ) : null}
        {task.durationMs !== undefined ? <span>{formatDuration(task.durationMs)}</span> : null}
        <InfoTip label={uiText("About workflow telemetry", undefined, undefined, uiLocale)}>
          {uiText(
            "Model, tokens, duration and status are reported by Claude. Missing values remain unavailable; token counts are not billing totals. Duration is the reported work time, not a running clock.",
            undefined,
            undefined,
            uiLocale,
          )}
        </InfoTip>
      </div>
      {!hasSnapshot ? (
        <p className="mt-3 text-xs text-muted-foreground">
          {uiText("Phase details unavailable.", undefined, undefined, uiLocale)}
        </p>
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
                aria-label={uiText(
                  "Phase {value0}: {value1}",
                  {
                    value0: phase.index,
                    value1: phase.title ?? uiText("Untitled phase", undefined, undefined, uiLocale),
                  },
                  undefined,
                  uiLocale,
                )}
                data-workflow-phase="true"
              >
                <div className="mb-1.5 flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <h4 className="min-w-0 break-words text-xs font-medium [overflow-wrap:anywhere]">
                    {phase.title ??
                      uiText("Phase {value0}", { value0: phase.index }, undefined, uiLocale)}
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
                      <UiMessage
                        message={"<slot1></slot1>/<slot3></slot3> reported agents done"}
                        slots={{ slot1: completedAgents, slot3: phaseAgents.length }}
                      />
                    </span>
                  ) : null}
                </div>
                {phaseAgents.length ? (
                  <ul
                    className="space-y-1.5"
                    aria-label={uiText(
                      "Agents in phase {value0}",
                      { value0: phase.index },
                      undefined,
                      uiLocale,
                    )}
                  >
                    {phaseAgents.map((agent) => (
                      <WorkflowAgentRow key={agent.index} agent={agent} rootStatus={task.status} />
                    ))}
                  </ul>
                ) : (
                  <p className="text-2xs text-subtle-foreground">
                    {uiText("No agents reported.", undefined, undefined, uiLocale)}
                  </p>
                )}
              </section>
            );
          })}
          {ungrouped.length ? (
            <section
              aria-label={uiText("Agents without a reported phase", undefined, undefined, uiLocale)}
            >
              <h4 className="mb-1.5 text-xs font-medium">
                {uiText("Other agents", undefined, undefined, uiLocale)}
              </h4>
              <ul className="space-y-1.5">
                {ungrouped.map((agent) => (
                  <WorkflowAgentRow key={agent.index} agent={agent} rootStatus={task.status} />
                ))}
              </ul>
            </section>
          ) : null}
          {phases.length === 0 && agents.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {uiText("No phase activity reported.", undefined, undefined, uiLocale)}
            </p>
          ) : null}
        </div>
      )}
      {task.workflow.truncated ? (
        <p className="mt-2 text-2xs text-muted-foreground">
          {uiText("Some workflow details were omitted.", undefined, undefined, uiLocale)}
        </p>
      ) : null}
      {footer ? <div className="-mx-3 -mb-3 mt-3">{footer}</div> : null}
    </article>
  );
});

// Finite source-owned labels/helpers only; no received or user data.
const UI_PRESENTATION_SOURCES = { STATUS_LABELS, formatDuration, reportedTokens };
