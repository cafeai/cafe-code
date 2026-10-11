import { useUiLocale } from "~/i18n";
import { uiText } from "@cafecode/shared/i18n";
import { memo, type PointerEventHandler } from "react";
import { PaperclipIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";

const preventPointerFocus: PointerEventHandler<HTMLElement> = (event) => {
  event.preventDefault();
};

export const ComposerAttachImageButton = memo(function ComposerAttachImageButton({
  disabled = false,
  preserveComposerFocusOnPointerDown = false,
  className,
  onClick,
}: {
  disabled?: boolean;
  preserveComposerFocusOnPointerDown?: boolean;
  className?: string;
  onClick: () => void;
}) {
  const uiLocale = useUiLocale();

  return (
    <Button
      type="button"
      size="icon-sm"
      variant="ghost"
      className={cn("shrink-0 text-muted-foreground hover:text-foreground", className)}
      disabled={disabled}
      aria-label={uiText("Attach files or images", undefined, undefined, uiLocale)}
      title={uiText(
        "Upload copies of files or images. Workspace @ references stay linked.",
        undefined,
        undefined,
        uiLocale,
      )}
      {...(preserveComposerFocusOnPointerDown ? { onPointerDown: preventPointerFocus } : {})}
      onClick={onClick}
    >
      <PaperclipIcon aria-hidden="true" className="size-4" />
    </Button>
  );
});
