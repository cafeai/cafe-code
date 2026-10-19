import { useId, type ReactNode } from "react";
import { ChevronRightIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";

/**
 * Presentation-only disclosure shared by received commands and diagnostics.
 * The caller owns any data read and supplies an already-public header: the
 * shell must not derive a tooltip, accessible name, or preview from its body.
 * Base UI retains keyboard/focus semantics and the existing measured-height
 * animation; no nested scrolling or provider action is introduced here.
 *
 * `compact` matches an ordinary work-log row: the same 28px row height and
 * hover surface, with the disclosure chevron revealed only on hover, keyboard
 * focus or while open (always shown on devices without hover).
 */
export function InspectableWorkEntry(props: {
  readonly kind: "claude-command" | "provider-diagnostic";
  readonly icon: ReactNode;
  readonly heading: ReactNode;
  readonly metadata?: ReactNode;
  readonly accessibleLabel: string;
  readonly compact?: boolean;
  readonly expanded?: boolean;
  readonly onExpandedChange?: (expanded: boolean) => void;
  readonly children: ReactNode;
}) {
  const panelId = useId();
  const compact = props.compact === true;
  return (
    <Collapsible
      className={cn("min-w-0", compact ? undefined : "rounded-lg px-1 py-1")}
      data-claude-command-inspection={props.kind === "claude-command" ? "true" : undefined}
      data-provider-diagnostic={props.kind === "provider-diagnostic" ? "true" : undefined}
      {...(props.expanded !== undefined ? { open: props.expanded } : {})}
      {...(props.onExpandedChange ? { onOpenChange: props.onExpandedChange } : {})}
    >
      <CollapsibleTrigger
        aria-controls={panelId}
        aria-label={props.accessibleLabel}
        className={cn(
          "focus-ring group flex min-h-7 w-full min-w-0 items-center gap-2 text-left text-xs leading-5 hover:bg-accent",
          compact
            ? "rounded-lg px-1 py-1 transition-colors duration-(--duration-fast)"
            : "rounded-sm",
        )}
      >
        <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
          {props.icon}
        </span>
        {props.heading}
        {props.metadata}
        <ChevronRightIcon
          className={cn(
            "size-3 shrink-0 text-subtle-foreground transition-transform duration-(--duration-fast) motion-reduce:transition-none motion-reduce:duration-0 group-data-[panel-open]:rotate-90",
            compact &&
              "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 group-data-[panel-open]:opacity-100 [@media(hover:none)]:opacity-100",
          )}
          aria-hidden
        />
      </CollapsibleTrigger>
      <CollapsiblePanel
        id={panelId}
        className="motion-reduce:transition-none motion-reduce:duration-0"
      >
        <div
          className={cn(
            "mt-1 min-w-0 space-y-2 rounded-md border border-border-subtle bg-sunken p-2 text-xs text-muted-foreground",
            compact && "mx-1 mb-1",
          )}
        >
          {props.children}
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}
