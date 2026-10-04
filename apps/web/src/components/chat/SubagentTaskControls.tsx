import {
  SubagentRuntimeId,
  type ProviderIndividualTaskControl,
  type EnvironmentId,
  type ThreadId,
  type TurnId,
} from "@cafecode/contracts";
import { useState } from "react";
import { readEnvironmentApi } from "../../environmentApi";
import type { WorkLogEntry } from "../../session-logic";

/** These controls never optimistically mark a worker stopped. A native status
 * edge is the completion authority; receipts only describe request delivery. */
export function SubagentTaskControls({
  environmentId,
  threadId,
  turnId,
  subagent,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  turnId: TurnId;
  subagent: NonNullable<WorkLogEntry["subagent"]>;
}) {
  if (
    !subagent.taskControl ||
    !subagent.runtimeId ||
    (subagent.status !== "active" && subagent.status !== "waiting")
  )
    return null;
  return (
    <IndividualTaskControls
      {...{ environmentId, threadId, turnId }}
      reference={{
        taskId: subagent.id,
        runtimeId: SubagentRuntimeId.make(subagent.runtimeId),
        capability: subagent.taskControl,
      }}
    />
  );
}

export function IndividualTaskControls({
  environmentId,
  threadId,
  turnId,
  reference,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  turnId: TurnId;
  reference: ProviderIndividualTaskControl;
}) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [requested, setRequested] = useState<ReadonlySet<"stop" | "background">>(new Set());
  const control = reference.capability;
  const send = async (action: "stop" | "background") => {
    const api = readEnvironmentApi(environmentId);
    if (!api?.orchestration.controlTask) {
      setMessage("Task controls are unavailable. Reconnect and refresh the task.");
      return;
    }
    setPending(true);
    setRequested((previous) => new Set([...previous, action]));
    try {
      const result = await api.orchestration.controlTask({
        threadId,
        turnId,
        providerInstanceId: control.providerInstanceId,
        runtimeId: reference.runtimeId,
        taskId: reference.taskId,
        taskGeneration: control.taskGeneration,
        action,
      });
      setMessage(
        result.status === "accepted"
          ? action === "stop"
            ? "Stop requested. Waiting for the provider’s status update."
            : "Background requested. This task may continue running."
          : result.status === "already-terminal"
            ? "The provider reports this task has already ended."
            : result.status === "not-foreground"
              ? "This task is no longer in the foreground."
              : "Delivery is uncertain. Waiting for a provider update; this action will not be repeated automatically.",
      );
    } catch {
      setMessage(
        "Could not confirm this action. Refresh the task status before taking another action.",
      );
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="space-y-2 border-t border-border/40 px-4 py-3 sm:px-6">
      <div className="flex flex-wrap gap-2" aria-label="Individual task controls">
        {control.canBackground && (
          <button
            type="button"
            disabled={pending || requested.has("background")}
            onClick={() => void send("background")}
            className="rounded-md border border-border px-3 py-1.5 text-xs text-foreground disabled:opacity-50"
          >
            Run in background
          </button>
        )}
        {control.canStop && (
          <button
            type="button"
            disabled={pending || requested.has("stop")}
            onClick={() => void send("stop")}
            className="rounded-md border border-border px-3 py-1.5 text-xs text-destructive disabled:opacity-50"
          >
            Stop task
          </button>
        )}
      </div>
      <p className="text-xs text-muted-foreground" role="status" aria-live="polite">
        {message ?? "Only this task is affected. Stop chat remains a separate control."}
      </p>
    </div>
  );
}
