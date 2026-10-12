import { useUiLocale, useUiPresentation } from "~/i18n";
import { uiText } from "@cafecode/shared/i18n";
import { scopeProjectRef, scopedThreadKey, scopeThreadRef } from "@cafecode/client-runtime";
import type { VcsStatusResult } from "@cafecode/contracts";
import { GitPullRequestIcon } from "lucide-react";
import { useMemo } from "react";
import { useGitStatus } from "../lib/gitStatusState";
import { type AppState, selectProjectByRef, useStore } from "../store";
import { useUiStateStore } from "../uiStateStore";
import { resolveChangeRequestPresentation } from "../sourceControlPresentation";
import { resolveThreadStatusPill } from "./Sidebar.logic";
import type { SidebarThreadSummary } from "../types";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { ThreadStatusLabel } from "./ThreadStatusLabel";

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
      label: uiText("{value0} open", { value0: presentation.shortName }),
      colorClass: "text-success-foreground",
      tooltip: uiText("#{value0} {value1} open: {value2}", {
        value0: pr.number,
        value1: presentation.shortName,
        value2: pr.title,
      }),
      url: pr.url,
    };
  }
  if (pr.state === "closed") {
    return {
      label: uiText("{value0} closed", { value0: presentation.shortName }),
      colorClass: "text-subtle-foreground",
      tooltip: uiText("#{value0} {value1} closed: {value2}", {
        value0: pr.number,
        value1: presentation.shortName,
        value2: pr.title,
      }),
      url: pr.url,
    };
  }
  if (pr.state === "merged") {
    return {
      label: uiText("{value0} merged", { value0: presentation.shortName }),
      // Merged keeps the source-control hosts' conventional violet; there is
      // no semantic token for it and recolouring it would hurt recognition.
      colorClass: "text-violet-600 dark:text-violet-300",
      tooltip: uiText("#{value0} {value1} merged: {value2}", {
        value0: pr.number,
        value1: presentation.shortName,
        value2: pr.title,
      }),
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

// The shared status dot and label live in a dependency-light module; they are
// re-exported here for existing callers.
export { ThreadStatusDot, ThreadStatusLabel } from "./ThreadStatusLabel";

/**
 * Non-interactive leading status icons for a thread row in compact contexts
 * like the command palette. Shows the change request state icon (if present) and the
 * thread status dot, matching the sidebar's leading indicators.
 */
export function ThreadRowLeadingStatus({ thread }: { thread: SidebarThreadSummary }) {
  const uiPresentation = useUiPresentation(UI_PRESENTATION_SOURCES);

  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const lastVisitedAt = useUiStateStore(
    (state) => state.threadLastVisitedAtById[scopedThreadKey(threadRef)],
  );
  const threadProjectCwd = useStore(
    useMemo(
      () => (state: AppState) =>
        thread.projectId === null
          ? null
          : (selectProjectByRef(state, scopeProjectRef(thread.environmentId, thread.projectId))
              ?.cwd ?? null),
      [thread.environmentId, thread.projectId],
    ),
  );
  const gitCwd = thread.worktreePath ?? threadProjectCwd;
  const gitStatus = useGitStatus({
    environmentId: thread.environmentId,
    cwd: thread.branch != null ? gitCwd : null,
  });
  const pr = resolveThreadPr(thread.branch, gitStatus.data);
  const prStatus = uiPresentation.prStatusIndicator(pr, gitStatus.data?.sourceControlProvider);
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

// Finite source-owned labels/helpers only; no received or user data.
const UI_PRESENTATION_SOURCES = { prStatusIndicator };
