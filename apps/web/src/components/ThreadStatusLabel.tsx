import { useUiLocale, useUiPresentation } from "~/i18n";
import type { ThreadStatusPill } from "./Sidebar.logic";
import { threadStatusDisplayLabel } from "./Sidebar.logic";
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
/**
 * Scheduled follow-up indicator: a small clock whose hands sweep on the same
 * stepped, pausable `animate-spin` token as the working spinner, but muted
 * rather than accent-coloured because nothing is running yet (minute hand
 * 4s, hour hand 48s, both capped at 60 updates/second). Reduced motion leaves
 * a static clock face.
 */
function ScheduledClock({ className }: { className?: string | undefined }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      data-slot="thread-status-dot"
      data-spinning="true"
      data-clock="true"
      className={cn("thread-status-dot text-muted-foreground", className)}
    >
      <circle cx="12" cy="12" r="9.5" />
      <line
        x1="12"
        y1="12"
        x2="12"
        y2="8.5"
        className="thread-status-clock-hand animate-spin motion-reduce:animate-none"
        style={
          {
            "--cafe-spin-duration": "48s",
            "--cafe-spin-steps": "480",
            rotate: "60deg",
          } as React.CSSProperties
        }
      />
      <line
        x1="12"
        y1="12"
        x2="12"
        y2="6"
        className="thread-status-clock-hand animate-spin motion-reduce:animate-none"
        style={
          {
            "--cafe-spin-duration": "4s",
            "--cafe-spin-steps": "240",
          } as React.CSSProperties
        }
      />
    </svg>
  );
}

export function ThreadStatusDot({
  status,
  className,
}: {
  status: Pick<ThreadStatusPill, "dotClass" | "pulse" | "clock">;
  className?: string;
}) {
  if (status.clock) return <ScheduledClock className={className} />;
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
  const uiPresentation = useUiPresentation(UI_PRESENTATION_SOURCES);

  const visible = status !== null;

  return (
    <span
      title={status ? uiPresentation.threadStatusDisplayLabel(status.label) : undefined}
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
      {status ? (
        <span className="sr-only">{uiPresentation.threadStatusDisplayLabel(status.label)}</span>
      ) : null}
    </span>
  );
}

// Finite source-owned labels/helpers only; no received or user data.
const UI_PRESENTATION_SOURCES = { threadStatusDisplayLabel };
