import type { ProviderDeliveryPriority } from "@cafecode/contracts";
import { MenuRadioGroup, MenuRadioItem } from "../ui/menu";

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

export function ClaudeDeliveryPriorityPicker({
  value,
  onChange,
  disabled,
}: {
  value: ProviderDeliveryPriority | undefined;
  onChange: (value: ProviderDeliveryPriority | undefined) => void;
  disabled: boolean;
}) {
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
          <MenuRadioItem
            key={option.value}
            value={option.value}
            disabled={disabled}
            className="min-w-0 py-1.5"
          >
            <span className="grid min-w-0 gap-0.5 py-0.5">
              <span className="font-medium text-foreground">{option.label}</span>
              <span className="text-muted-foreground text-xs leading-4">{option.description}</span>
            </span>
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
    </>
  );
}
