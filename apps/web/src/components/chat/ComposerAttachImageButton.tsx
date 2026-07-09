import { memo, type PointerEventHandler } from "react";
import { ImagePlusIcon } from "lucide-react";
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
  return (
    <Button
      type="button"
      size="icon-sm"
      variant="ghost"
      className={cn("shrink-0 text-muted-foreground/70 hover:text-foreground/80", className)}
      disabled={disabled}
      aria-label="Attach image"
      {...(preserveComposerFocusOnPointerDown ? { onPointerDown: preventPointerFocus } : {})}
      onClick={onClick}
    >
      <ImagePlusIcon aria-hidden="true" className="size-4" />
    </Button>
  );
});
