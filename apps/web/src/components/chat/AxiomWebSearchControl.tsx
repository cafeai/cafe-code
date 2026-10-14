import { CheckIcon, GlobeIcon } from "lucide-react";
import { uiText } from "@cafecode/shared/i18n";
import { useUiLocale } from "~/i18n";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";

export function AxiomWebSearchControl({
  enabled,
  disabled,
  compact,
  onChange,
}: {
  enabled: boolean;
  disabled: boolean;
  compact: boolean;
  onChange: (enabled: boolean) => void;
}) {
  const locale = useUiLocale();
  const label = uiText("Web search", undefined, undefined, locale);
  return (
    <Tooltip>
      <TooltipTrigger
        delay={250}
        render={
          <Button
            type="button"
            size="sm"
            variant="ghost"
            data-axiom-web-search="true"
            aria-label={label}
            aria-pressed={enabled}
            disabled={disabled}
            className={cn(
              "shrink-0 gap-1.5 px-2 text-muted-foreground hover:text-foreground",
              enabled && "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary",
            )}
            onPointerDown={(event) => {
              if (event.pointerType === "mouse") event.preventDefault();
            }}
            onClick={() => onChange(!enabled)}
          />
        }
      >
        <GlobeIcon aria-hidden="true" className="size-3.5" />
        {!compact ? <span>{label}</span> : null}
        {enabled ? <CheckIcon aria-hidden="true" className="size-3" /> : null}
      </TooltipTrigger>
      <TooltipPopup role="tooltip" className="no-drag pointer-events-none">
        {uiText("Allow web search for this message.", undefined, undefined, locale)}
      </TooltipPopup>
    </Tooltip>
  );
}
