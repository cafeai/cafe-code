import { useUiLocale, useUiPresentation } from "~/i18n";
import { uiText } from "@cafecode/shared/i18n";
import type { ProviderDeliveryPriority } from "@cafecode/contracts";
import { MenuRadioGroup, MenuRadioItem } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const DELIVERY_OPTIONS = [
  {
    value: "default",
    get label() {
      return uiText("Automatic");
    },
    get description() {
      return uiText("Use Cafe’s normal queue and Claude’s default priority.");
    },
  },
  {
    value: "now",
    get label() {
      return uiText("Now");
    },
    get description() {
      return uiText("Join the active turn; supported work may move to the background.");
    },
  },
  {
    value: "next",
    get label() {
      return uiText("Next");
    },
    get description() {
      return uiText("Ask Claude to take this at its next available boundary.");
    },
  },
  {
    value: "later",
    get label() {
      return uiText("Later");
    },
    get description() {
      return uiText("Let Claude defer this behind more urgent messages—not a scheduled time.");
    },
  },
] as const;

interface DeliveryPriorityProps {
  value: ProviderDeliveryPriority | undefined;
  onChange: (value: ProviderDeliveryPriority | undefined) => void;
  disabled: boolean;
}

export function ClaudeDeliveryPriorityPicker({ value, onChange, disabled }: DeliveryPriorityProps) {
  const uiLocale = useUiLocale();
  const uiPresentation = useUiPresentation(UI_PRESENTATION_SOURCES);

  return (
    <>
      <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">
        {uiText("Message delivery", undefined, undefined, uiLocale)}
      </div>
      <MenuRadioGroup
        aria-label={uiText("Claude message delivery priority", undefined, undefined, uiLocale)}
        value={value ?? "default"}
        onValueChange={(next) => {
          if (disabled) return;
          onChange(next === "now" || next === "next" || next === "later" ? next : undefined);
        }}
      >
        {uiPresentation.DELIVERY_OPTIONS.map((option) => (
          <Tooltip key={option.value}>
            <TooltipTrigger
              delay={250}
              render={
                <MenuRadioItem
                  value={option.value}
                  disabled={disabled}
                  aria-label={option.label}
                  className="min-w-0 py-1.5"
                />
              }
            >
              {option.label}
            </TooltipTrigger>
            <TooltipPopup
              role="tooltip"
              side="top"
              className="no-drag pointer-events-none max-w-64 leading-relaxed"
            >
              {option.description}
            </TooltipPopup>
          </Tooltip>
        ))}
      </MenuRadioGroup>
    </>
  );
}

// Finite source-owned labels/helpers only; no received or user data.
const UI_PRESENTATION_SOURCES = { DELIVERY_OPTIONS };
