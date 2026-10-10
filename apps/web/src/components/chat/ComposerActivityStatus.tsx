import { ChevronRightIcon, Clock3Icon } from "lucide-react";
import type { ChatActivityPresentation } from "./chatActivity";
import { Spinner } from "../ui/spinner";
import { cn } from "~/lib/utils";

export function ComposerActivityStatus({
  activity,
  onOpenTasks,
}: {
  activity: ChatActivityPresentation;
  onOpenTasks: () => void;
}) {
  const content = (
    <>
      {activity.attention ? (
        <Clock3Icon className="size-3.5 shrink-0" aria-hidden="true" />
      ) : (
        <Spinner
          className="size-3.5 shrink-0 motion-reduce:animate-none"
          strokeWidth={2.5}
          aria-hidden="true"
        />
      )}
      <span role="status" aria-live="polite" aria-atomic="true" className="min-w-0 truncate">
        {activity.label}
      </span>
      {activity.canInspect ? (
        <ChevronRightIcon className="size-3 shrink-0" aria-hidden="true" />
      ) : null}
    </>
  );
  const className = cn(
    "flex min-w-0 max-w-full items-center gap-2 px-1 py-1 text-xs",
    activity.attention ? "text-status-attention-foreground" : "text-muted-foreground",
  );
  return activity.canInspect ? (
    <button
      type="button"
      onClick={onOpenTasks}
      className={cn(className, "focus-ring rounded-sm hover:text-foreground")}
      aria-label={`${activity.label}. Show tasks`}
    >
      {content}
    </button>
  ) : (
    <div className={className}>{content}</div>
  );
}
