import { useId, type ReactNode } from "react";
import { ChevronRightIcon } from "lucide-react";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";

/**
 * Presentation-only disclosure shared by received commands and diagnostics.
 * The caller owns any data read and supplies an already-public header: the
 * shell must not derive a tooltip, accessible name, or preview from its body.
 * Base UI retains keyboard/focus semantics and the existing measured-height
 * animation; no nested scrolling or provider action is introduced here.
 */
export function InspectableWorkEntry(props: {
  readonly kind: "claude-command" | "provider-diagnostic";
  readonly icon: ReactNode;
  readonly heading: ReactNode;
  readonly metadata?: ReactNode;
  readonly accessibleLabel: string;
  readonly expanded?: boolean;
  readonly onExpandedChange?: (expanded: boolean) => void;
  readonly children: ReactNode;
}) {
  const panelId = useId();
  return (
    <Collapsible
      className="min-w-0 rounded-lg px-1 py-1"
      data-claude-command-inspection={props.kind === "claude-command" ? "true" : undefined}
      data-provider-diagnostic={props.kind === "provider-diagnostic" ? "true" : undefined}
      {...(props.expanded !== undefined ? { open: props.expanded } : {})}
      {...(props.onExpandedChange ? { onOpenChange: props.onExpandedChange } : {})}
    >
      <CollapsibleTrigger
        aria-controls={panelId}
        aria-label={props.accessibleLabel}
        className="focus-ring group flex min-h-7 w-full min-w-0 items-center gap-2 rounded-sm text-left text-xs leading-5 hover:bg-accent"
      >
        <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
          {props.icon}
        </span>
        {props.heading}
        {props.metadata}
        <ChevronRightIcon
          className="size-3 shrink-0 text-subtle-foreground transition-transform duration-(--duration-fast) motion-reduce:transition-none motion-reduce:duration-0 group-data-[panel-open]:rotate-90"
          aria-hidden
        />
      </CollapsibleTrigger>
      <CollapsiblePanel
        id={panelId}
        className="motion-reduce:transition-none motion-reduce:duration-0"
      >
        <div className="mt-1 min-w-0 space-y-2 rounded-md border border-border-subtle bg-sunken p-2 text-xs text-muted-foreground">
          {props.children}
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}
