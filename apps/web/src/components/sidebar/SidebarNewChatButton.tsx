import { SquarePenIcon } from "lucide-react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function SidebarNewChatButton({
  label = "New chat",
  disabled,
  onClick,
}: {
  label?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            disabled={disabled}
            className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50 max-md:size-8 pointer-coarse:size-8"
            onClick={onClick}
          >
            <SquarePenIcon aria-hidden="true" className="size-3.5" />
          </button>
        }
      />
      <TooltipPopup side="right">New chat</TooltipPopup>
    </Tooltip>
  );
}
