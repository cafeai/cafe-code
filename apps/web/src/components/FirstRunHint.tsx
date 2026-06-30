import { type RefObject } from "react";
import { XIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Popover, PopoverClose, PopoverDescription, PopoverPopup } from "./ui/popover";

interface FirstRunHintProps {
  /** Whether the nudge is currently visible. */
  readonly open: boolean;
  /** Called when the user dismisses it (X, escape, or outside click). */
  readonly onDismiss: () => void;
  /** Element the bubble is anchored to. */
  readonly anchor: RefObject<HTMLElement | null>;
  readonly message: string;
  readonly testId?: string;
}

/**
 * A small, dismissible onboarding nudge anchored directly to the right of the
 * button it points at, with a chevron aimed back at the icon. It is a
 * controlled, anchor-based popover with no trigger of its own — visibility is
 * driven entirely by `open`, which the caller derives from persisted client
 * settings so a dismissed hint never returns.
 */
export function FirstRunHint({ open, onDismiss, anchor, message, testId }: FirstRunHintProps) {
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          onDismiss();
        }
      }}
    >
      <PopoverPopup
        align="center"
        anchor={anchor}
        arrow
        className="max-w-66"
        data-testid={testId}
        // Passive nudge: it opens automatically, so it must not pull focus
        // away from the user when it appears or when it is dismissed.
        finalFocus={false}
        initialFocus={false}
        side="right"
        sideOffset={9}
        tooltipStyle
      >
        <div className="flex items-center gap-1.5">
          <PopoverDescription className="font-medium text-[0.8125rem] text-popover-foreground leading-5">
            {message}
          </PopoverDescription>
          <PopoverClose
            aria-label="Dismiss"
            className={cn(
              "-mr-1 grid size-5 shrink-0 cursor-pointer place-items-center rounded-md text-muted-foreground",
              "transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring",
            )}
          >
            <XIcon className="size-3.5" />
          </PopoverClose>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
