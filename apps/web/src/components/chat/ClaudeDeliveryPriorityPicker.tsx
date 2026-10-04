import type { ProviderDeliveryPriority } from "@cafecode/contracts";

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
    <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
      <label className="flex items-center gap-2">
        Message delivery
        <select
          aria-label="Claude message delivery priority"
          value={value ?? "default"}
          disabled={disabled}
          className="rounded-md border border-border bg-background px-2 py-1 text-foreground"
          onChange={(event) => {
            const next = event.currentTarget.value;
            onChange(next === "now" || next === "next" || next === "later" ? next : undefined);
          }}
        >
          <option value="default">Automatic</option>
          <option value="now">Now</option>
          <option value="next">Next</option>
          <option value="later">Later</option>
        </select>
      </label>
      <span>
        {value === "now"
          ? "Join the active turn; supported work may move to the background."
          : value === "next"
            ? "Ask Claude to take this at its next available boundary."
            : value === "later"
              ? "Let Claude defer this behind more urgent messages—not a scheduled time."
              : "Use Cafe’s normal queue and Claude’s default priority."}
      </span>
    </div>
  );
}
