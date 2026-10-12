import { useUiLocale } from "~/i18n";
import { uiText } from "@cafecode/shared/i18n";
import { memo, useRef } from "react";
import { CopyIcon, CheckIcon } from "lucide-react";
import { Button } from "../ui/button";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";
import { anchoredToastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const ANCHORED_TOAST_TIMEOUT_MS = 1000;
// Success stays inline (check icon + "Copied" tooltip label) per the style
// guide; only a failure uses the anchored tooltip-style notice.
const COPIED_STATE_MS = 1200;

const onCopyError = (ref: React.RefObject<HTMLButtonElement | null>, error: Error) => {
  if (ref.current) {
    anchoredToastManager.add({
      data: {
        tooltipStyle: true,
      },
      positionerProps: {
        anchor: ref.current,
      },
      timeout: ANCHORED_TOAST_TIMEOUT_MS,
      title: uiText("Failed to copy"),
      description: error.message,
    });
  }
};

export const MessageCopyButton = memo(function MessageCopyButton({
  text,
  size = "xs",
  variant = "outline",
  className,
}: {
  text: string;
  size?: "xs" | "icon-xs";
  variant?: "outline" | "ghost";
  className?: string;
}) {
  const uiLocale = useUiLocale();

  const ref = useRef<HTMLButtonElement>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>({
    onError: (error: Error) => onCopyError(ref, error),
    timeout: COPIED_STATE_MS,
  });

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={
              isCopied
                ? uiText("Copied", undefined, undefined, uiLocale)
                : uiText("Copy message", undefined, undefined, uiLocale)
            }
            onClick={() => copyToClipboard(text)}
            ref={ref}
            type="button"
            size={size}
            variant={variant}
            className={cn(className)}
          />
        }
      >
        {isCopied ? <CheckIcon className="size-3 text-success" /> : <CopyIcon className="size-3" />}
      </TooltipTrigger>
      <TooltipPopup>
        <p>
          {isCopied
            ? uiText("Copied", undefined, undefined, uiLocale)
            : uiText("Copy message", undefined, undefined, uiLocale)}
        </p>
      </TooltipPopup>
    </Tooltip>
  );
});

// Finite source-owned labels/helpers only; no received or user data.
