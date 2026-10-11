import { useUiLocale } from "~/i18n";
import { uiText } from "@cafecode/shared/i18n";
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
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { InfoTip } from "../ui/info-tip";

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
  layout = "footer",
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  turnId: TurnId;
  reference: ProviderIndividualTaskControl;
  /** Ordinary task rows use a compact inline action group. Workflow/subagent
   * detail surfaces keep the default footer; delivery semantics are identical. */
  layout?: "footer" | "inline";
}) {
  const uiLocale = useUiLocale();

  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [requested, setRequested] = useState<ReadonlySet<"stop" | "background">>(new Set());
  const control = reference.capability;
  const send = async (action: "stop" | "background") => {
    const api = readEnvironmentApi(environmentId);
    if (!api?.orchestration.controlTask) {
      setMessage(
        uiText(
          "Task controls are unavailable. Reconnect and refresh the task.",
          undefined,
          undefined,
          uiLocale,
        ),
      );
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
            ? uiText(
                "Stop requested. Waiting for the provider’s status update.",
                undefined,
                undefined,
                uiLocale,
              )
            : uiText(
                "Background requested. This task may continue running.",
                undefined,
                undefined,
                uiLocale,
              )
          : result.status === "already-terminal"
            ? uiText(
                "The provider reports this task has already ended.",
                undefined,
                undefined,
                uiLocale,
              )
            : result.status === "not-foreground"
              ? uiText("This task is no longer in the foreground.", undefined, undefined, uiLocale)
              : uiText(
                  "Delivery is uncertain. Waiting for a provider update; this action will not be repeated automatically.",
                  undefined,
                  undefined,
                  uiLocale,
                ),
      );
    } catch {
      setMessage(
        uiText(
          "Could not confirm this action. Refresh the task status before taking another action.",
          undefined,
          undefined,
          uiLocale,
        ),
      );
    } finally {
      setPending(false);
    }
  };
  return (
    <div
      className={cn(
        layout === "inline"
          ? "min-w-0 max-w-full space-y-2"
          : "space-y-2 border-t border-border-subtle px-4 py-3 sm:px-6",
      )}
    >
      <div
        className="flex flex-wrap items-center gap-2"
        aria-label={uiText("Individual task controls", undefined, undefined, uiLocale)}
      >
        {control.canBackground && (
          <Button
            size="xs"
            variant="outline"
            disabled={pending || requested.has("background")}
            onClick={() => void send("background")}
          >
            {uiText("Run in background", undefined, undefined, uiLocale)}
          </Button>
        )}
        {control.canStop && (
          <span className="inline-flex items-center gap-1">
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={pending || requested.has("stop")}
              onClick={() => void send("stop")}
            >
              {uiText("Stop task", undefined, undefined, uiLocale)}
            </Button>
            <InfoTip label={uiText("About stopping a task", undefined, undefined, uiLocale)}>
              {uiText(
                "Stops only this task. Stop chat remains a separate control.",
                undefined,
                undefined,
                uiLocale,
              )}
            </InfoTip>
          </span>
        )}
      </div>
      {/* Mounted before any action so screen readers announce the result. */}
      <p
        className={cn("text-xs text-muted-foreground", message === null && "sr-only")}
        role="status"
        aria-live="polite"
      >
        {message}
      </p>
    </div>
  );
}
