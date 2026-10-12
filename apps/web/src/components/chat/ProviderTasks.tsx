import { useUiLocale, useUiPresentation } from "~/i18n";
import { uiText } from "@cafecode/shared/i18n";
import { UiMessage } from "~/i18n";
import {
  ProviderIndividualTaskControl,
  type EnvironmentId,
  type OrchestrationThreadActivity,
  type OrchestrationLiveWork,
  type ProviderInstanceId,
  type ThreadId,
  type TurnId,
} from "@cafecode/contracts";
import * as Schema from "effect/Schema";
import { BotIcon, TerminalIcon, WrenchIcon } from "lucide-react";
import { useState } from "react";
import { isSubagentRuntimeCurrent, type SubagentRuntimeContext } from "../../subagent-activity";
import { deriveWorkflowTasks, readWorkflowTaskPresentation } from "../../workflowTaskActivity";
import { Button } from "../ui/button";
import { IndividualTaskControls } from "./SubagentTaskControls";
import { deriveForegroundTools } from "./chatActivity";
import { deriveWorkLogEntries } from "../../session-logic";
import { deriveLiveWorkObservations, isLiveWorkRuntimeCurrent } from "@cafecode/shared/liveWork";
import { WorkflowTaskCard } from "./WorkflowTasks";
import {
  readProviderTaskPresentation,
  type ProviderTaskPresentation,
} from "./providerTaskPresentation";

const isControl = Schema.is(ProviderIndividualTaskControl);
export interface ProviderTasksContext {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  providerInstanceId: ProviderInstanceId;
  activities: ReadonlyArray<OrchestrationThreadActivity>;
  runtimeSession: SubagentRuntimeContext | null;
  activeTurnId?: TurnId | null | undefined;
  activeTurnRunning?: boolean | undefined;
  liveWork?: OrchestrationLiveWork | undefined;
}
export interface ActiveProviderTask extends ProviderTaskPresentation {
  key: string;
  turnId: TurnId;
  reference?: ProviderIndividualTaskControl | undefined;
}

/** Rebuild only from exact current-runtime observations. Historical labels,
 * elapsed time and a resumed parent turn are never liveness evidence. */
export function deriveActiveProviderTasks(context: ProviderTasksContext): ActiveProviderTask[] {
  const current = new Map<string, ActiveProviderTask>();
  const workflowKeys = new Set<string>();
  const activities = context.activities.toSorted((left, right) => {
    if (
      left.sequence !== undefined &&
      right.sequence !== undefined &&
      left.sequence !== right.sequence
    )
      return left.sequence - right.sequence;
    return (
      left.createdAt.localeCompare(right.createdAt) ||
      String(left.id).localeCompare(String(right.id))
    );
  });
  for (const activity of activities) {
    const taskEvent = activity.kind.startsWith("task.");
    if (!taskEvent && !activity.kind.startsWith("tool.")) continue;
    const payload = activity.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) continue;
    const data = payload as Record<string, unknown>;
    const identity = taskEvent ? data.taskId : data.itemId;
    if (typeof identity !== "string" || !activity.turnId) continue;
    const key = JSON.stringify([taskEvent ? "task" : "tool", activity.turnId, identity]);
    // A workflow root has one richer card. Keep its existing exact controls on
    // that card instead of presenting a duplicate ordinary task row beside it.
    if (taskEvent && (data.workflow !== undefined || readWorkflowTaskPresentation(activity)))
      workflowKeys.add(key);
    // An unstamped update invalidates prior mutation affordances. In particular,
    // detached placeholders, hidden tasks and terminal events must remove them.
    current.delete(key);
    if (
      activity.kind.endsWith(".completed") ||
      workflowKeys.has(key) ||
      data.subagent ||
      data.visibility === "ambient" ||
      !isControl(data.individualTaskControl)
    )
      continue;
    const reference = data.individualTaskControl;
    if (
      reference.capability.providerInstanceId !== context.providerInstanceId ||
      !isSubagentRuntimeCurrent(reference.runtimeId, context.runtimeSession)
    )
      continue;
    current.set(key, {
      key,
      turnId: activity.turnId,
      reference,
      ...readProviderTaskPresentation(activity),
    });
  }
  if (
    isLiveWorkRuntimeCurrent(context.liveWork?.runtimeId, context.runtimeSession) &&
    context.liveWork?.taskCount === 0
  )
    current.clear();
  else
    for (const { activity, observation } of deriveLiveWorkObservations(
      context.activities,
      context.runtimeSession,
    )) {
      if (observation.agent || !activity.turnId) continue;
      const key = JSON.stringify([observation.lane, activity.turnId, observation.workId]);
      // Workflows already have their own admitted card, and malformed workflow
      // metadata must not regain presentation through the read-only fallback.
      if (current.has(key) || workflowKeys.has(key)) continue;
      const entry = deriveWorkLogEntries([activity], activity.turnId)[0];
      current.set(key, {
        key,
        turnId: activity.turnId,
        ...readProviderTaskPresentation(activity, entry?.command ?? entry?.detail ?? entry?.label),
      });
    }
  for (const activity of deriveForegroundTools(
    context.activities,
    context.activeTurnId ?? null,
    context.activeTurnRunning === true,
  )) {
    const payload = activity.payload as Record<string, unknown>;
    const key = JSON.stringify(["tool", activity.turnId, payload.itemId]);
    if (current.has(key) || !activity.turnId) continue;
    const entry = deriveWorkLogEntries([{ ...activity, kind: "tool.updated" }], activity.turnId)[0];
    current.set(key, {
      key,
      turnId: activity.turnId,
      ...readProviderTaskPresentation(activity, entry?.command ?? entry?.detail ?? entry?.label),
    });
  }
  return [...current.values()];
}

/** Shared Tasks/rail availability, independent of root mutation capability. */
export function hasProviderTaskContent(context: ProviderTasksContext): boolean {
  return deriveWorkflowTasks(context).length > 0 || deriveActiveProviderTasks(context).length > 0;
}

export function ProviderTasks({
  context,
  section,
}: {
  context: ProviderTasksContext;
  section?: "workflows" | "tasks";
}) {
  const uiLocale = useUiLocale();
  const uiPresentation = useUiPresentation(UI_PRESENTATION_SOURCES);

  const [page, setPage] = useState(0);
  const [workflowPage, setWorkflowPage] = useState(0);
  // Hosts keep workflow cards in their existing position and put short-lived
  // ordinary tasks last. Derive only the selected section, retaining combined
  // rendering for other consumers. This is layout selection, not a change to
  // runtime evidence, liveness or control admission.
  const tasks = section === "workflows" ? [] : uiPresentation.deriveActiveProviderTasks(context);
  const workflows = section === "tasks" ? [] : uiPresentation.deriveWorkflowTasks(context);
  if (!tasks.length && !workflows.length) return null;
  const pages = Math.ceil(tasks.length / 5);
  const selectedPage = Math.max(0, Math.min(page, pages - 1));
  const workflowPages = Math.ceil(workflows.length / 5);
  const selectedWorkflowPage = Math.max(0, Math.min(workflowPage, workflowPages - 1));
  return (
    <>
      {workflows.length > 0 ? (
        <section
          aria-label={uiText("Workflows", undefined, undefined, uiLocale)}
          className="mb-3 border-b border-border-subtle pb-3"
        >
          <p className="mb-2 text-xs font-medium text-muted-foreground">
            {uiText("Workflows", undefined, undefined, uiLocale)}
          </p>
          <div className="space-y-2">
            {workflows
              .slice(selectedWorkflowPage * 5, (selectedWorkflowPage + 1) * 5)
              .map((task) => (
                <WorkflowTaskCard
                  key={`${task.key}:${task.workflow.runtimeId}:${task.startedAt}`}
                  task={task}
                  footer={
                    task.reference ? (
                      <IndividualTaskControls
                        key={task.reference.capability.taskGeneration}
                        environmentId={context.environmentId}
                        threadId={context.threadId}
                        turnId={task.turnId}
                        reference={task.reference}
                      />
                    ) : undefined
                  }
                />
              ))}
          </div>
          {workflowPages > 1 ? (
            <nav
              aria-label={uiText("Workflow pages", undefined, undefined, uiLocale)}
              className="mt-2 flex items-center justify-between text-xs"
            >
              <Button
                size="xs"
                variant="ghost"
                aria-label={uiText("Previous workflow page", undefined, undefined, uiLocale)}
                disabled={selectedWorkflowPage === 0}
                onClick={() => setWorkflowPage(selectedWorkflowPage - 1)}
              >
                {uiText("Previous", undefined, undefined, uiLocale)}
              </Button>
              <span className="tabular-nums text-muted-foreground">
                {selectedWorkflowPage + 1} / {workflowPages}
              </span>
              <Button
                size="xs"
                variant="ghost"
                aria-label={uiText("Next workflow page", undefined, undefined, uiLocale)}
                disabled={selectedWorkflowPage + 1 === workflowPages}
                onClick={() => setWorkflowPage(selectedWorkflowPage + 1)}
              >
                {uiText("Next", undefined, undefined, uiLocale)}
              </Button>
            </nav>
          ) : null}
        </section>
      ) : null}
      {tasks.length > 0 ? (
        <section
          aria-label={uiText("Active provider tasks", undefined, undefined, uiLocale)}
          className={
            section === "tasks"
              ? "mt-4 border-t border-border-subtle pt-3"
              : "mb-3 border-b border-border-subtle pb-3"
          }
        >
          <p className="mb-2 text-xs font-medium text-muted-foreground">
            <UiMessage
              message={"Provider tasks · <slot1></slot1> active"}
              slots={{ slot1: <span className="tabular-nums">{tasks.length}</span> }}
            />
          </p>
          <div className="space-y-2">
            {tasks.slice(selectedPage * 5, (selectedPage + 1) * 5).map((task) => (
              <div
                key={`${task.key}:${task.reference?.capability.taskGeneration ?? "read-only"}`}
                data-provider-task-row
                className="flex flex-wrap items-start gap-x-3 gap-y-2 rounded-xl border border-border-subtle px-3 py-2"
              >
                <div className="flex min-w-0 flex-1 basis-36 items-start gap-2 py-1">
                  {task.kind === "agent" ? (
                    <BotIcon
                      className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                  ) : task.kind === "command" ? (
                    <TerminalIcon
                      className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                  ) : (
                    <WrenchIcon
                      className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                  )}
                  <p
                    data-provider-task-title
                    className="min-w-0 break-words text-xs font-medium text-foreground [overflow-wrap:anywhere]"
                  >
                    {task.title}
                  </p>
                </div>
                {task.reference ? (
                  <IndividualTaskControls
                    environmentId={context.environmentId}
                    threadId={context.threadId}
                    turnId={task.turnId}
                    reference={task.reference}
                    layout="inline"
                  />
                ) : null}
              </div>
            ))}
          </div>
          {pages > 1 && (
            <nav
              aria-label={uiText("Provider task pages", undefined, undefined, uiLocale)}
              className="mt-2 flex items-center justify-between text-xs"
            >
              <Button
                size="xs"
                variant="ghost"
                disabled={selectedPage === 0}
                onClick={() => setPage(selectedPage - 1)}
              >
                {uiText("Previous", undefined, undefined, uiLocale)}
              </Button>
              <span className="tabular-nums text-muted-foreground">
                {selectedPage + 1} / {pages}
              </span>
              <Button
                size="xs"
                variant="ghost"
                disabled={selectedPage + 1 === pages}
                onClick={() => setPage(selectedPage + 1)}
              >
                {uiText("Next", undefined, undefined, uiLocale)}
              </Button>
            </nav>
          )}
        </section>
      ) : null}
    </>
  );
}

// Finite source-owned labels/helpers only; no received or user data.
const UI_PRESENTATION_SOURCES = { deriveActiveProviderTasks, deriveWorkflowTasks };
