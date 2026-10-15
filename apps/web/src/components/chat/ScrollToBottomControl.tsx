import { uiText } from "@cafecode/shared/i18n";
import { ChevronDownIcon, ChevronUpIcon, EyeOffIcon } from "lucide-react";
import { useId, useRef, useState, type ComponentProps, type FocusEvent } from "react";

import { useUiLocale } from "~/i18n";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

type PopoverChangeDetails = Parameters<
  NonNullable<ComponentProps<typeof Popover>["onOpenChange"]>
>[1];

/**
 * Presentational review controls only. Hiding this pill must not mean following
 * the live tail: the caller owns dismissal and the actual physical-bottom edge.
 * Two sibling native buttons keep the scroll action independent from the
 * optional disclosure, including on devices that cannot hover.
 */
export function ScrollToBottomControl({
  onScrollToBottom,
  onHideUntilBottom,
}: {
  readonly onScrollToBottom: () => void;
  readonly onHideUntilBottom: () => void;
}) {
  const uiLocale = useUiLocale();
  const primaryId = useId();
  const optionsId = useId();
  const [open, setOpen] = useState(false);
  const [triggerId, setTriggerId] = useState<string | null>(null);
  const openModeRef = useRef<"hover" | "focus" | "press" | null>(null);
  const suppressRestoredFocusRef = useRef(false);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const primaryRef = useRef<HTMLButtonElement | null>(null);
  const optionsRef = useRef<HTMLButtonElement | null>(null);
  const optionsLabel = uiText("Scroll to bottom options", undefined, undefined, uiLocale);

  const close = () => {
    openModeRef.current = null;
    // The caller may keep the pill mounted after the action. Returning focus
    // during the popup exit must not recreate that just-dismissed disclosure.
    suppressRestoredFocusRef.current = true;
    setOpen(false);
  };
  const revealOnFocus = (event: FocusEvent<HTMLButtonElement>) => {
    // Escape returns keyboard focus to the exact trigger. That restoration is
    // not a new inspection request; opening again would make Escape ineffective.
    // A subsequent blur or genuine hover entry permits another disclosure.
    if (suppressRestoredFocusRef.current) return;
    if (openModeRef.current !== "press") openModeRef.current = "focus";
    setTriggerId(event.currentTarget.id);
    setOpen(true);
  };
  const handleOpenChange = (nextOpen: boolean, details: PopoverChangeDetails) => {
    if (details.reason === "trigger-press") {
      if (details.trigger?.id === primaryId) {
        // Cancel only Base UI's popup toggle, never the browser click. The main
        // button's own onClick still invokes the existing scroll action once.
        details.cancel();
        close();
        return;
      }
      // A press may follow the hover/focus preview. Its first activation pins
      // that preview for touch/keyboard inspection instead of closing it.
      if (!nextOpen && openModeRef.current !== "press") {
        openModeRef.current = "press";
        setOpen(true);
        return;
      }
      openModeRef.current = nextOpen ? "press" : null;
    } else if (details.reason === "trigger-hover" || details.reason === "trigger-focus") {
      if (!nextOpen) {
        const focused = document.activeElement;
        if (
          openModeRef.current === "press" ||
          focused === primaryRef.current ||
          focused === optionsRef.current ||
          (focused !== null && popupRef.current?.contains(focused))
        ) {
          details.cancel();
          return;
        }
        openModeRef.current = null;
      } else if (openModeRef.current !== "press" && openModeRef.current !== "focus") {
        openModeRef.current = "hover";
      }
    } else if (!nextOpen) {
      openModeRef.current = null;
      suppressRestoredFocusRef.current = details.reason === "escape-key";
    }
    if (nextOpen) {
      suppressRestoredFocusRef.current = false;
      if (details.trigger) setTriggerId(details.trigger.id);
    }
    setOpen(nextOpen);
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange} triggerId={triggerId} modal={false}>
      <div
        data-scroll-to-bottom-control="true"
        className="pointer-events-auto flex max-w-full items-center rounded-full border border-border bg-raised text-muted-foreground shadow-sm animate-enter-rise"
      >
        <PopoverTrigger
          id={primaryId}
          ref={primaryRef}
          openOnHover
          delay={0}
          closeDelay={100}
          onFocus={revealOnFocus}
          onBlur={() => {
            suppressRestoredFocusRef.current = false;
          }}
          onClick={() => {
            close();
            onScrollToBottom();
          }}
          render={
            <Button
              data-scroll-to-bottom-primary="true"
              variant="ghost"
              size="xs"
              className="h-auto gap-1.5 rounded-full px-3 py-1 text-xs text-muted-foreground transition-colors duration-(--duration-fast) hover:text-foreground sm:text-xs"
            />
          }
        >
          <ChevronDownIcon className="size-3.5" aria-hidden="true" />
          {uiText("Scroll to bottom", undefined, undefined, uiLocale)}
        </PopoverTrigger>
        <PopoverTrigger
          id={optionsId}
          ref={optionsRef}
          aria-label={optionsLabel}
          data-scroll-to-bottom-options="true"
          openOnHover
          delay={0}
          closeDelay={100}
          onFocus={revealOnFocus}
          onBlur={() => {
            suppressRestoredFocusRef.current = false;
          }}
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              className="mr-0.5 rounded-full text-muted-foreground hover:text-foreground"
            />
          }
        >
          <ChevronUpIcon className="size-3.5" aria-hidden="true" />
        </PopoverTrigger>
      </div>
      <PopoverPopup
        ref={popupRef}
        data-scroll-to-bottom-popup="true"
        aria-label={optionsLabel}
        side="top"
        align="center"
        initialFocus={false}
        viewportClassName="p-1 [--viewport-inline-padding:0]"
      >
        <Button
          data-scroll-to-bottom-hide="true"
          variant="ghost"
          size="sm"
          className="h-auto min-h-7 max-w-full justify-start whitespace-normal px-2 py-1 text-xs sm:text-xs"
          onClick={() => {
            close();
            onHideUntilBottom();
          }}
        >
          <EyeOffIcon className="size-3.5" aria-hidden="true" />
          {uiText("Hide until bottom", undefined, undefined, uiLocale)}
        </Button>
      </PopoverPopup>
    </Popover>
  );
}
