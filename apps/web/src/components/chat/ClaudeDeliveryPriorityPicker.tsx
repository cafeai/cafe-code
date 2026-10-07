import type { ProviderDeliveryPriority } from "@cafecode/contracts";
import { useState } from "react";
import { SendIcon } from "lucide-react";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useChatPane } from "../../chatPaneContext";

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

/** Both the tab and the existing options-menu shortcut edit the same account-
 * scoped composer choice. This popup owns only presentation, never delivery. */
export function ClaudeDeliveryPriorityControl({
  value,
  onChange,
  disabled,
  disabledReason,
  collapsed,
}: DeliveryPriorityProps & {
  disabledReason?: string | undefined;
  collapsed: boolean;
}) {
  const [open, setOpen] = useState(false);
  const pane = useChatPane();
  // A global minimize gesture can come from another pane. Retire this popup
  // before it can outlive a hidden/disabled trigger or reopen on restoration.
  if (open && (collapsed || disabled || !pane.visible)) setOpen(false);
  const selected = DELIVERY_OPTIONS.find((option) => option.value === (value ?? "default"))!;
  return (
    <Menu
      open={open}
      onOpenChange={(next, details) => {
        if (next && (disabled || collapsed || !pane.visible)) {
          details.cancel();
          return;
        }
        setOpen(next);
      }}
      modal={false}
    >
      <Tooltip>
        <TooltipTrigger
          delay={250}
          render={
            <MenuTrigger
              type="button"
              className="cafe-composer-tab-action"
              aria-disabled={disabled}
              aria-label={`Message delivery: ${selected.label}`}
            />
          }
        >
          <SendIcon aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="truncate">Delivery · {selected.label}</span>
        </TooltipTrigger>
        <TooltipPopup
          role="tooltip"
          side="top"
          className="no-drag pointer-events-none max-w-64 leading-relaxed"
        >
          {selected.description}
          {disabled && disabledReason ? ` ${disabledReason}` : null}
        </TooltipPopup>
      </Tooltip>
      <MenuPopup side="top" align="end" className="no-drag w-44 max-w-[calc(100vw-2rem)]">
        <ClaudeDeliveryPriorityPicker
          value={value}
          disabled={disabled}
          onChange={(next) => {
            onChange(next);
            setOpen(false);
          }}
        />
      </MenuPopup>
    </Menu>
  );
}
