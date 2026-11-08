import { useUiLocale } from "~/i18n";
import { uiText } from "@cafecode/shared/i18n";
import { SquarePenIcon } from "lucide-react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

// "section" matches the other icon actions in a sidebar section heading (such
// as Projects' sort and add buttons) so heading rows share one height and
// their trailing icons line up.
const BUTTON_CLASS_BY_VARIANT = {
  default:
    "inline-flex size-7 items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50 max-md:size-8 pointer-coarse:size-8",
  section:
    "inline-flex size-5 cursor-pointer items-center justify-center rounded-sm text-subtle-foreground transition-colors duration-(--duration-fast) hover:bg-accent hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default disabled:opacity-50",
} as const;

export function SidebarNewChatButton({
  label = uiText("New chat"),
  variant = "default",
  disabled,
  onClick,
}: {
  label?: string;
  variant?: keyof typeof BUTTON_CLASS_BY_VARIANT;
  disabled?: boolean;
  onClick: () => void;
}) {
  const uiLocale = useUiLocale();

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            disabled={disabled}
            className={BUTTON_CLASS_BY_VARIANT[variant]}
            onClick={onClick}
          >
            <SquarePenIcon aria-hidden="true" className="size-3.5" />
          </button>
        }
      />
      <TooltipPopup side="right">{uiText("New chat", undefined, undefined, uiLocale)}</TooltipPopup>
    </Tooltip>
  );
}
