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
import { useState } from "react";
import { isSubagentRuntimeCurrent, type SubagentRuntimeContext } from "../../subagent-activity";
import { Button } from "../ui/button";
import { IndividualTaskControls } from "./SubagentTaskControls";
import { deriveForegroundTools } from "./chatActivity";
import { deriveWorkLogEntries } from "../../session-logic";
import { readComputerUsePresentation } from "./computerUsePresentation";
import { deriveLiveWorkObservations, isLiveWorkRuntimeCurrent } from "@cafecode/shared/liveWork";

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
export interface ActiveProviderTask {
  key: string;
  title: string;
  turnId: TurnId;
  reference?: ProviderIndividualTaskControl | undefined;
}

/** Rebuild only from exact current-runtime observations. Historical labels,
 * elapsed time and a resumed parent turn are never liveness evidence. */
export function deriveActiveProviderTasks(context: ProviderTasksContext): ActiveProviderTask[] {
  const current = new Map<string, ActiveProviderTask>();
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
    // An unstamped update invalidates prior mutation affordances. In particular,
    // detached placeholders, hidden tasks and terminal events must remove them.
    current.delete(key);
    if (
      activity.kind.endsWith(".completed") ||
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
      title:
        typeof data.detail === "string" && data.detail.trim()
          ? data.detail.slice(0, 300)
          : activity.summary,
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
      if (current.has(key)) continue;
      const entry = deriveWorkLogEntries([activity], activity.turnId)[0];
      current.set(key, {
        key,
        turnId: activity.turnId,
        title: entry?.command ?? entry?.detail ?? entry?.label ?? activity.summary,
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
    const computerUse = readComputerUsePresentation(activity);
    const entry = deriveWorkLogEntries([{ ...activity, kind: "tool.updated" }], activity.turnId)[0];
    current.set(key, {
      key,
      turnId: activity.turnId,
      title:
        computerUse?.active ?? entry?.command ?? entry?.detail ?? entry?.label ?? activity.summary,
    });
  }
  return [...current.values()];
}

export function ProviderTasks({ context }: { context: ProviderTasksContext }) {
  const [page, setPage] = useState(0);
  const tasks = deriveActiveProviderTasks(context);
  if (!tasks.length) return null;
  const pages = Math.ceil(tasks.length / 5);
  const selectedPage = Math.min(page, pages - 1);
  return (
    <section aria-label="Active provider tasks" className="mb-3 border-b border-border-subtle pb-3">
      <p className="mb-2 text-xs font-medium text-muted-foreground">
        Provider tasks · <span className="tabular-nums">{tasks.length}</span> active
      </p>
      <div className="space-y-2">
        {tasks.slice(selectedPage * 5, (selectedPage + 1) * 5).map((task) => (
          <div
            key={`${task.key}:${task.reference?.capability.taskGeneration ?? "read-only"}`}
            className="rounded-lg border border-border-subtle"
          >
            <p className="break-words px-3 py-2 text-xs text-foreground [overflow-wrap:anywhere]">
              {task.title}
            </p>
            {task.reference ? (
              <IndividualTaskControls
                environmentId={context.environmentId}
                threadId={context.threadId}
                turnId={task.turnId}
                reference={task.reference}
              />
            ) : null}
          </div>
        ))}
      </div>
      {pages > 1 && (
        <nav
          aria-label="Provider task pages"
          className="mt-2 flex items-center justify-between text-xs"
        >
          <Button
            size="xs"
            variant="ghost"
            disabled={selectedPage === 0}
            onClick={() => setPage(selectedPage - 1)}
          >
            Previous
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
            Next
          </Button>
        </nav>
      )}
    </section>
  );
}
