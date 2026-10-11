import { useUiLocale } from "~/i18n";
import { uiText } from "@cafecode/shared/i18n";
import { type ApprovalRequestId, type ProviderApprovalDecision } from "@cafecode/contracts";
import { memo, useEffect, useRef } from "react";
import { Button } from "../ui/button";
import { InfoTip } from "../ui/info-tip";

interface ComposerPendingApprovalActionsProps {
  requestId: ApprovalRequestId;
  isResponding: boolean;
  defaultToNo?: boolean;
  suppressAlwaysAllowRule?: boolean;
  /** Session approval of a network request grants its destination, not one call. */
  networkApproval?: boolean;
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
  networkApproval = false,
  onRespondToApproval,
}: ComposerPendingApprovalActionsProps) {
  const uiLocale = useUiLocale();

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
        {uiText("Cancel turn", undefined, undefined, uiLocale)}
      </Button>
      <Button
        ref={declineRef}
        size="sm"
        variant="destructive-outline"
        disabled={isResponding}
        onClick={() => void onRespondToApproval(requestId, "decline")}
      >
        {uiText("Decline", undefined, undefined, uiLocale)}
      </Button>
      {!suppressAlwaysAllowRule && (
        <span className="inline-flex items-center gap-1">
          <Button
            size="sm"
            variant="outline"
            disabled={isResponding}
            onClick={() => void onRespondToApproval(requestId, "acceptForSession")}
          >
            {uiText("Always allow this session", undefined, undefined, uiLocale)}
          </Button>
          <InfoTip label={uiText("About session approval", undefined, undefined, uiLocale)}>
            {networkApproval
              ? uiText(
                  "Allows this network destination until the provider session ends.",
                  undefined,
                  undefined,
                  uiLocale,
                )
              : uiText(
                  "Allows matching requests until the provider session ends.",
                  undefined,
                  undefined,
                  uiLocale,
                )}
          </InfoTip>
        </span>
      )}
      <Button
        size="sm"
        variant="default"
        disabled={isResponding}
        onClick={() => void onRespondToApproval(requestId, "accept")}
      >
        {uiText("Approve once", undefined, undefined, uiLocale)}
      </Button>
    </>
  );
});
