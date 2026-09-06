import { memo } from "react";
import { type PendingApproval } from "../../session-logic";

interface ComposerPendingApprovalPanelProps {
  approval: PendingApproval;
  pendingCount: number;
}

export const ComposerPendingApprovalPanel = memo(function ComposerPendingApprovalPanel({
  approval,
  pendingCount,
}: ComposerPendingApprovalPanelProps) {
  const approvalSummary = approval.networkApproval
    ? "Network access approval requested"
    : approval.requestKind === "command"
      ? "Command approval requested"
      : approval.requestKind === "terminal-input"
        ? "Terminal input approval requested"
        : approval.requestKind === "file-read"
          ? "File-read approval requested"
          : "File-change approval requested";

  return (
    <div className="px-4 py-3.5 sm:px-5 sm:py-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="uppercase text-sm tracking-[0.2em]">PENDING APPROVAL</span>
        <span className="text-sm font-medium">{approvalSummary}</span>
        {pendingCount > 1 ? (
          <span className="text-xs text-muted-foreground">1/{pendingCount}</span>
        ) : null}
      </div>
      {approval.networkApproval ? (
        <p className="mt-2 break-all text-sm">
          Destination: <strong>{approval.networkApproval.host}</strong> · Protocol:{" "}
          <strong>{approval.networkApproval.protocol}</strong>. Approval permits this network
          destination; session approval lasts for this provider session.
        </p>
      ) : null}
    </div>
  );
});
