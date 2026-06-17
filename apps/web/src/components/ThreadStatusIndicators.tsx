import { scopeProjectRef, scopedThreadKey, scopeThreadRef } from "@cafecode/client-runtime";
import type { VcsStatusResult } from "@cafecode/contracts";
import { GitPullRequestIcon } from "lucide-react";
import { useMemo } from "react";
import { useGitStatus } from "../lib/gitStatusState";
import { type AppState, selectProjectByRef, useStore } from "../store";
import { useUiStateStore } from "../uiStateStore";
import { resolveChangeRequestPresentation } from "../sourceControlPresentation";
import { resolveThreadStatusPill, type ThreadStatusPill } from "./Sidebar.logic";
import type { SidebarThreadSummary } from "../types";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export interface PrStatusIndicator {
  label: string;
  colorClass: string;
  tooltip: string;
  url: string;
}

export type ThreadPr = VcsStatusResult["pr"];

export function prStatusIndicator(
  pr: ThreadPr,
  provider: VcsStatusResult["sourceControlProvider"] | null | undefined,
): PrStatusIndicator | null {
  if (!pr) return null;
  const presentation = resolveChangeRequestPresentation(provider);

  if (pr.state === "open") {
    return {
      label: `${presentation.shortName} open`,
      colorClass: "text-emerald-600 dark:text-emerald-300/90",
      tooltip: `#${pr.number} ${presentation.shortName} open: ${pr.title}`,
      url: pr.url,
    };
  }
  if (pr.state === "closed") {
    return {
      label: `${presentation.shortName} closed`,
      colorClass: "text-zinc-500 dark:text-zinc-400/80",
      tooltip: `#${pr.number} ${presentation.shortName} closed: ${pr.title}`,
      url: pr.url,
    };
  }
  if (pr.state === "merged") {
    return {
      label: `${presentation.shortName} merged`,
      colorClass: "text-violet-600 dark:text-violet-300/90",
      tooltip: `#${pr.number} ${presentation.shortName} merged: ${pr.title}`,
      url: pr.url,
    };
  }
  return null;
}

export function ChangeRequestStatusIcon({ className }: { className?: string }) {
  return <GitPullRequestIcon className={className} />;
}

export function resolveThreadPr(
  threadBranch: string | null,
  gitStatus: VcsStatusResult | null,
): ThreadPr | null {
  if (threadBranch === null || gitStatus === null || gitStatus.refName !== threadBranch) {
    return null;
  }

  return gitStatus.pr ?? null;
}

export function ThreadStatusLabel({
  status,
  compact = false,
}: {
  status: ThreadStatusPill | null;
  compact?: boolean;
}) {
  const visible = status !== null;
  const dotSizeClass = compact ? "size-[9px]" : "size-1.5";

  return (
    <span
      title={status?.label}
      data-visible={visible ? "true" : "false"}
      data-compact={compact ? "true" : "false"}
      aria-hidden={!visible}
      className={`thread-status-dot-shell inline-flex shrink-0 items-center justify-center ${status?.colorClass ?? ""}`}
    >
      <span
        className={`thread-status-dot rounded-full ${dotSizeClass} ${status?.dotClass ?? ""} ${
          status?.pulse ? "animate-pulse" : ""
        }`}
      />
      {status ? <span className="sr-only">{status.label}</span> : null}
    </span>
  );
}

/**
 * Non-interactive leading status icons for a thread row in compact contexts
 * like the command palette. Shows the change request state icon (if present) and the
 * thread status dot, matching the sidebar's leading indicators.
 */
export function ThreadRowLeadingStatus({ thread }: { thread: SidebarThreadSummary }) {
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const lastVisitedAt = useUiStateStore(
    (state) => state.threadLastVisitedAtById[scopedThreadKey(threadRef)],
  );
  const threadProjectCwd = useStore(
    useMemo(
      () => (state: AppState) =>
        selectProjectByRef(state, scopeProjectRef(thread.environmentId, thread.projectId))?.cwd ??
        null,
      [thread.environmentId, thread.projectId],
    ),
  );
  const gitCwd = thread.worktreePath ?? threadProjectCwd;
  const gitStatus = useGitStatus({
    environmentId: thread.environmentId,
    cwd: thread.branch != null ? gitCwd : null,
  });
  const pr = resolveThreadPr(thread.branch, gitStatus.data);
  const prStatus = prStatusIndicator(pr, gitStatus.data?.sourceControlProvider);
  const threadStatus = resolveThreadStatusPill({
    thread: {
      ...thread,
      lastVisitedAt,
    },
  });

  if (!prStatus && !threadStatus) {
    return null;
  }

  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      {prStatus ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                aria-label={prStatus.tooltip}
                className={`inline-flex items-center justify-center ${prStatus.colorClass}`}
              />
            }
          >
            <ChangeRequestStatusIcon className="size-3" />
          </TooltipTrigger>
          <TooltipPopup side="top">{prStatus.tooltip}</TooltipPopup>
        </Tooltip>
      ) : null}
      <ThreadStatusLabel status={threadStatus} />
    </span>
  );
}

export function ThreadRowTrailingStatus(_props: { thread: SidebarThreadSummary }) {
  return null;
}
