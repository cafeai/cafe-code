import { memo } from "react";
import { type PendingApproval } from "../../session-logic";

interface ComposerPendingApprovalPanelProps {
  approval: PendingApproval;
  pendingCount: number;
}

function approvalTitle(approval: PendingApproval): string {
  if (approval.networkApproval) return "Network access needs approval";
  switch (approval.requestKind) {
    case "command":
      return "Command needs approval";
    case "terminal-input":
      return "Terminal input needs approval";
    case "file-read":
      return "File read needs approval";
    case "file-change":
      return "File change needs approval";
  }
}

/**
 * The request being approved is shown here, not as composer placeholder text:
 * a provider's command or reason is the thing the user is deciding on. Network
 * approvals always keep their destination host and protocol visible next to
 * the requested command/rule context.
 */
export const ComposerPendingApprovalPanel = memo(function ComposerPendingApprovalPanel({
  approval,
  pendingCount,
}: ComposerPendingApprovalPanelProps) {
  return (
    <div className="px-4 py-3 sm:px-5">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-sm font-medium text-foreground">{approvalTitle(approval)}</span>
        {pendingCount > 1 ? (
          <span className="text-2xs tabular-nums text-subtle-foreground">1 of {pendingCount}</span>
        ) : null}
      </div>
      {approval.networkApproval ? (
        <dl
          className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-ui"
          aria-label="Network destination"
        >
          <dt className="text-muted-foreground">Host</dt>
          <dd className="break-all font-mono text-foreground">{approval.networkApproval.host}</dd>
          <dt className="text-muted-foreground">Protocol</dt>
          <dd className="break-all font-mono text-foreground">
            {approval.networkApproval.protocol}
          </dd>
        </dl>
      ) : null}
      {approval.detail ? (
        <pre
          className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap break-all rounded-lg bg-muted px-3 py-2 font-mono text-ui text-foreground"
          data-pending-approval-detail="true"
        >
          {approval.detail}
        </pre>
      ) : null}
    </div>
  );
});
