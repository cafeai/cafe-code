import type { ThreadStatusPill } from "./Sidebar.logic";
import { cn } from "~/lib/utils";
import { Spinner } from "./ui/spinner";

// Presentation-only status primitives. They live apart from
// ThreadStatusIndicators (which reads git/runtime state for PR badges) so
// lightweight surfaces such as Desk tabs can render chat state without
// importing transport modules.

/**
 * The shared status indicator (docs/style-guide.md §2). Working and connecting
 * use a spinner; other visible states use the `--thread-status-dot-size` token.
 * Sidebar rows, collapsed
 * projects, the hidden-chats toggle, Desk tabs and the command palette all
 * draw the same indicator and colour.
 */
export function ThreadStatusDot({
  status,
  className,
}: {
  status: Pick<ThreadStatusPill, "dotClass" | "pulse">;
  className?: string;
}) {
  if (status.pulse)
    return (
      <Spinner
        aria-hidden="true"
        strokeWidth={2.5}
        data-slot="thread-status-dot"
        data-spinning="true"
        className={cn(
          "thread-status-dot text-status-running-foreground motion-reduce:animate-none",
          className,
        )}
      />
    );
  return (
    <span
      aria-hidden="true"
      data-slot="thread-status-dot"
      data-spinning={status.pulse}
      className={cn("thread-status-dot rounded-full", status.dotClass, className)}
    />
  );
}

export function ThreadStatusLabel({
  status,
  compact = false,
}: {
  status: ThreadStatusPill | null;
  /** Reserves a wider slot for chevron-sized columns. */
  compact?: boolean;
}) {
  const visible = status !== null;

  return (
    <span
      title={status?.label}
      data-visible={visible ? "true" : "false"}
      data-compact={compact ? "true" : "false"}
      data-status={status?.label}
      aria-hidden={!visible}
      className={cn(
        "thread-status-dot-shell inline-flex shrink-0 items-center justify-center",
        status?.colorClass,
      )}
    >
      {/* Keep the dot mounted while hidden so the shell can fade it out. */}
      <ThreadStatusDot status={status ?? { dotClass: "", pulse: false }} />
      {status ? <span className="sr-only">{status.label}</span> : null}
    </span>
  );
}
