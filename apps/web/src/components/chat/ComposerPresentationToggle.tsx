import { MonitorIcon, SmartphoneIcon } from "lucide-react";
import { memo, type PointerEventHandler } from "react";

import { useMediaQuery } from "../../hooks/useMediaQuery";
import { resolveMobileLayout } from "../../mobilePresentation";
import { useUiStateStore } from "../../uiStateStore";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const preventPointerFocus: PointerEventHandler<HTMLElement> = (event) => {
  event.preventDefault();
};

export const ComposerPresentationToggle = memo(function ComposerPresentationToggle() {
  const viewportMatchesMobile = useMediaQuery("max-md");
  const mobileOptimizedPresentation = useUiStateStore((state) => state.mobileOptimizedPresentation);
  const setMobileOptimizedPresentation = useUiStateStore(
    (state) => state.setMobileOptimizedPresentation,
  );
  const effectiveMobileLayout = resolveMobileLayout(
    viewportMatchesMobile,
    mobileOptimizedPresentation,
  );
  const label = mobileOptimizedPresentation ? "Use automatic layout" : "Use mobile layout";
  const description = mobileOptimizedPresentation
    ? "Use the layout for this screen size."
    : "Use the mobile layout on this device.";

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            aria-pressed={mobileOptimizedPresentation}
            className={cn(
              "size-11 min-h-11 min-w-11 shrink-0 sm:size-11",
              mobileOptimizedPresentation
                ? "bg-primary/12 text-primary hover:bg-primary/18"
                : "text-muted-foreground/70 hover:text-foreground/80",
            )}
            data-effective-mobile-layout={effectiveMobileLayout ? "true" : "false"}
            data-mobile-presentation-source={
              mobileOptimizedPresentation
                ? "operator"
                : viewportMatchesMobile
                  ? "viewport"
                  : "responsive"
            }
            data-testid="composer-presentation-toggle"
            onClick={() => {
              setMobileOptimizedPresentation(!mobileOptimizedPresentation);
            }}
            onPointerDown={preventPointerFocus}
            size="icon-xl"
            type="button"
            variant="ghost"
          />
        }
      >
        {mobileOptimizedPresentation ? (
          <MonitorIcon aria-hidden="true" className="size-5" />
        ) : (
          <SmartphoneIcon aria-hidden="true" className="size-5" />
        )}
      </TooltipTrigger>
      <TooltipPopup side="top" className="max-w-56 whitespace-normal leading-tight">
        {description}
      </TooltipPopup>
    </Tooltip>
  );
});
