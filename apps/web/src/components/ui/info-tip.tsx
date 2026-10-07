import { InfoIcon } from "lucide-react";
import { type ReactNode, useId, useState } from "react";

import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./tooltip";

/**
 * A small info icon whose tooltip carries secondary detail, caveats and
 * technical notes that would otherwise become extra paragraphs
 * (docs/style-guide.md §10).
 *
 * The trigger is a real button. It opens on hover and keyboard focus like any
 * tooltip, and a click or tap also opens it: Base UI tooltips ignore touch
 * input on their own, and the remote browser UI must work on phones. Base UI
 * tooltips are visual-only, so while open the popup is also the button's
 * accessible description.
 */
export function InfoTip({
  children,
  label = "More information",
  side = "top",
  className,
  popupClassName,
}: {
  children: ReactNode;
  /** Accessible name for the icon button. */
  label?: string;
  side?: "top" | "bottom" | "left" | "right";
  className?: string;
  popupClassName?: string;
}) {
  const popupId = useId();
  const [open, setOpen] = useState(false);
  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger
        delay={150}
        // A press pins the tip open (and opens it for touch, which never
        // hovers) rather than dismissing it; pointer leave, outside press and
        // Escape still close it.
        closeOnClick={false}
        render={
          <button
            type="button"
            aria-label={label}
            // Describe the button by the open popup (the Radix tooltip
            // pattern), so the text exists once in the DOM and is announced
            // when keyboard focus opens it.
            aria-describedby={open ? popupId : undefined}
            data-slot="info-tip-trigger"
            className={cn(
              "focus-ring inline-flex size-4 shrink-0 cursor-help items-center justify-center rounded-full align-middle text-subtle-foreground transition-colors duration-(--duration-fast) hover:text-foreground",
              className,
            )}
            onClick={() => setOpen(true)}
          />
        }
      >
        <InfoIcon aria-hidden="true" className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup id={popupId} side={side} className={cn("max-w-72 text-pretty", popupClassName)}>
        {children}
      </TooltipPopup>
    </Tooltip>
  );
}
