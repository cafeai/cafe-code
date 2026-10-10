import type { ProviderDeliveryPriority } from "@cafecode/contracts";
import { MenuRadioGroup, MenuRadioItem } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const DELIVERY_OPTIONS = [
  {
    value: "default",
    label: "Automatic",
    description: "Use Cafe’s normal queue and Claude’s default priority.",
  },
  {
    value: "now",
    label: "Now",
    description: "Join the active turn; supported work may move to the background.",
  },
  {
    value: "next",
    label: "Next",
    description: "Ask Claude to take this at its next available boundary.",
  },
  {
    value: "later",
    label: "Later",
    description: "Let Claude defer this behind more urgent messages—not a scheduled time.",
  },
] as const;

interface DeliveryPriorityProps {
  value: ProviderDeliveryPriority | undefined;
  onChange: (value: ProviderDeliveryPriority | undefined) => void;
  disabled: boolean;
}

export function ClaudeDeliveryPriorityPicker({ value, onChange, disabled }: DeliveryPriorityProps) {
  return (
    <>
      <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Message delivery</div>
      <MenuRadioGroup
        aria-label="Claude message delivery priority"
        value={value ?? "default"}
        onValueChange={(next) => {
          if (disabled) return;
          onChange(next === "now" || next === "next" || next === "later" ? next : undefined);
        }}
      >
        {DELIVERY_OPTIONS.map((option) => (
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
