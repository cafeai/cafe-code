import { type ApprovalRequestId, type ProviderApprovalDecision } from "@cafecode/contracts";
import { memo, useEffect, useRef } from "react";
import { Button } from "../ui/button";

interface ComposerPendingApprovalActionsProps {
  requestId: ApprovalRequestId;
  isResponding: boolean;
  defaultToNo?: boolean;
  suppressAlwaysAllowRule?: boolean;
  onRespondToApproval: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<void>;
}

export const ComposerPendingApprovalActions = memo(function ComposerPendingApprovalActions({
  requestId,
  isResponding,
  defaultToNo = false,
  suppressAlwaysAllowRule = false,
  onRespondToApproval,
}: ComposerPendingApprovalActionsProps) {
  const declineRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    // Sensitive asks must not land on an approval button after a stray Enter.
    // Focus only when a new request arrives, never after a response rerender.
    if (defaultToNo) declineRef.current?.focus();
  }, [defaultToNo, requestId]);
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        disabled={isResponding}
        onClick={() => void onRespondToApproval(requestId, "cancel")}
      >
        Cancel turn
      </Button>
      <Button
        ref={declineRef}
        size="sm"
        variant="destructive-outline"
        disabled={isResponding}
        onClick={() => void onRespondToApproval(requestId, "decline")}
      >
        Decline
      </Button>
      {!suppressAlwaysAllowRule && (
        <Button
          size="sm"
          variant="outline"
          disabled={isResponding}
          onClick={() => void onRespondToApproval(requestId, "acceptForSession")}
        >
          Always allow this session
        </Button>
      )}
      <Button
        size="sm"
        variant="default"
        disabled={isResponding}
        onClick={() => void onRespondToApproval(requestId, "accept")}
      >
        Approve once
      </Button>
    </>
  );
});
