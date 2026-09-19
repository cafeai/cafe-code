import type { TimestampFormat } from "@cafecode/contracts/settings";
import type { OrchestrationThreadActivity } from "@cafecode/contracts";
import { memo, useMemo } from "react";

import type { ActivePlanState } from "../../session-logic";
import type { DeriveSubagentActivityOptions } from "../../subagent-activity";
import {
  deriveWorkflowProjection,
  EMPTY_WORKFLOW_SNAPSHOT,
  type WorkflowLatestTurn,
} from "../../workflowProjection";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { WorkflowObservatory } from "./WorkflowObservatory";

export interface WorkflowObservatoryDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly threadId: string | null;
  readonly environmentId: string | null;
  readonly threadTitle: string | null;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly latestTurn: WorkflowLatestTurn | null;
  readonly providerLabel: string | null;
  readonly modelLabel: string | null;
  readonly activePlan: ActivePlanState | null;
  readonly timestampFormat: TimestampFormat;
  readonly subagentOptions?: DeriveSubagentActivityOptions | undefined;
}

/**
 * Panel that shows the workflow of the selected thread.
 *
 * The dialog holds no copy of the thread state. While it is closed the
 * projection is the empty snapshot, so a thread or environment switch cannot
 * leave stale nodes behind. The dialog opens even when the thread has no plan.
 */
export const WorkflowObservatoryDialog = memo(function WorkflowObservatoryDialog({
  activePlan,
  activities,
  environmentId,
  latestTurn,
  modelLabel,
  onOpenChange,
  open,
  providerLabel,
  subagentOptions,
  threadId,
  threadTitle,
  timestampFormat,
}: WorkflowObservatoryDialogProps) {
  const snapshot = useMemo(
    () =>
      open
        ? deriveWorkflowProjection({
            threadId,
            environmentId,
            threadTitle,
            activities,
            latestTurn,
            providerLabel,
            modelLabel,
            ...(subagentOptions ? { subagentOptions } : {}),
          })
        : EMPTY_WORKFLOW_SNAPSHOT,
    [
      activities,
      environmentId,
      latestTurn,
      modelLabel,
      open,
      providerLabel,
      subagentOptions,
      threadId,
      threadTitle,
    ],
  );

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogPopup className="max-w-2xl" data-testid="workflow-observatory-dialog">
        <DialogHeader>
          <DialogTitle>Workflow</DialogTitle>
          <DialogDescription>
            Recorded plan, agents, and activity for the selected thread. This view reads saved
            events only.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <WorkflowObservatory
            activePlan={activePlan}
            key={JSON.stringify([environmentId, threadId])}
            snapshot={snapshot}
            timestampFormat={timestampFormat}
          />
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
});
