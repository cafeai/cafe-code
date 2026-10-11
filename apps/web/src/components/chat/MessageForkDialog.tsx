import { useUiLocale } from "~/i18n";
import { uiText } from "@cafecode/shared/i18n";
import { UiMessage } from "~/i18n";
import { useEffect, useRef, useState } from "react";
import type { MessageId } from "@cafecode/contracts";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
} from "../ui/dialog";

export interface MessageForkDialogProps {
  readonly messageId: MessageId;
  readonly accountLabel: string;
  readonly disabled: boolean;
  readonly busy?: boolean;
  readonly onClose: () => void;
  readonly onFork: (messageId: MessageId) => Promise<void>;
}

/** Key by exact environment/chat/account/message so a changed owner cannot
 * inherit an open confirmation. No native identities or raw errors enter UI.
 */
export function MessageForkDialog({
  messageId,
  accountLabel,
  disabled,
  busy = false,
  onClose,
  onFork,
}: MessageForkDialogProps) {
  const uiLocale = useUiLocale();

  const pendingRef = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pendingRef.current && !busy) onClose();
      }}
    >
      {/* Restoring focus to a now-inactive Desk pane would reactivate it and
        override the owner's navigation while this request is pending. */}
      <DialogPopup className="no-drag max-w-lg" finalFocus={false}>
        <DialogHeader>
          <DialogTitle>
            {uiText("Fork from this message?", undefined, undefined, uiLocale)}
          </DialogTitle>
          <DialogDescription>
            <UiMessage
              message={
                "Create a separate Claude chat with <slot1></slot1>, including this message and everything before it."
              }
              slots={{ slot1: accountLabel }}
            />
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {uiText(
              "Original stays unchanged; workspace files are shared, not rewound.",
              undefined,
              undefined,
              uiLocale,
            )}
          </p>
          {/* Why a fork can be refused only matters once it has been. */}
          {failed ? (
            <p role="alert" className="text-sm text-destructive-foreground">
              {uiText(
                "The fork could not be confirmed. Older, very large or compacted histories may be unavailable, and the chat and its background work must be idle. Check the chat and connection, then try again; nothing was resent.",
                undefined,
                undefined,
                uiLocale,
              )}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button variant="outline" disabled={pending || busy} onClick={onClose}>
              {uiText("Cancel", undefined, undefined, uiLocale)}
            </Button>
            <Button
              className="min-w-32"
              disabled={disabled || pending || busy || failed}
              onClick={async () => {
                if (disabled || pendingRef.current || busy || failed) return;
                pendingRef.current = true;
                setPending(true);
                // An account/pane change can unmount this confirmation while the
                // server finishes. Its old completion must not dismiss a new one.
                try {
                  await onFork(messageId);
                  if (mounted.current) onClose();
                } catch {
                  if (mounted.current) setFailed(true);
                } finally {
                  pendingRef.current = false;
                  if (mounted.current) setPending(false);
                }
              }}
            >
              {/* Keep the label and width while working. */}
              {pending || busy ? <Spinner aria-hidden="true" /> : null}
              {uiText("Create fork", undefined, undefined, uiLocale)}
            </Button>
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
