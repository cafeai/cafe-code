import { scopedThreadKey, scopeProjectRef } from "@cafecode/client-runtime";

import { useComposerDraftStore } from "../../composerDraftStore";
import type { DraftSessionState } from "../../composerDraftStore";
import type { SidebarThreadSummary } from "../../types";
import { selectProjectByRef, selectSidebarThreadSummaryByRef, useStore } from "../../store";
import type { ThreadRouteTarget } from "../../threadRoutes";
import { useUiStateStore } from "../../uiStateStore";
import { resolveThreadStatusPill } from "../Sidebar.logic";

function deriveMetadata(
  target: ThreadRouteTarget,
  draft: DraftSessionState | undefined,
  thread: SidebarThreadSummary | undefined,
  projectName: string | undefined,
  lastVisitedAt: string | undefined,
) {
  return {
    title: thread?.title ?? (target.kind === "draft" ? "New chat" : "Unavailable chat"),
    projectName: projectName ?? null,
    // Match the Projects row's shell timestamp precedence, including immediately
    // after draft promotion. A missing shell can still use its local draft date.
    activityAt: thread
      ? (thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt)
      : (draft?.createdAt ?? null),
    threadRef: target.kind === "server" ? target.threadRef : (draft?.promotedTo ?? null),
    working: thread?.session?.status === "running" || thread?.session?.status === "connecting",
    attention: thread?.hasPendingApprovals === true || thread?.hasPendingUserInput === true,
    exists: thread !== undefined || (target.kind === "draft" && draft !== undefined),
    status: thread ? resolveThreadStatusPill({ thread: { ...thread, lastVisitedAt } }) : null,
  };
}

/** Event-handler snapshot equivalent; does not create subscriptions or fetches. */
export function readDeskTabMetadata(target: ThreadRouteTarget) {
  const draft =
    target.kind === "draft"
      ? useComposerDraftStore.getState().draftThreadsByThreadKey[target.draftId]
      : undefined;
  const threadRef = target.kind === "server" ? target.threadRef : (draft?.promotedTo ?? null);
  const thread = selectSidebarThreadSummaryByRef(useStore.getState(), threadRef);
  const environmentId = thread?.environmentId ?? draft?.environmentId;
  const projectId = thread?.projectId ?? draft?.projectId;
  const projectName =
    environmentId && projectId
      ? selectProjectByRef(useStore.getState(), scopeProjectRef(environmentId, projectId))?.name
      : undefined;
  const lastVisitedAt = threadRef
    ? useUiStateStore.getState().threadLastVisitedAtById[scopedThreadKey(threadRef)]
    : undefined;
  return deriveMetadata(target, draft, thread, projectName, lastVisitedAt);
}

/** Resolve a menu's exact shell/draft workspace without loading its transcript. */
export function readDeskTabOpenContext(target: ThreadRouteTarget) {
  const metadata = readDeskTabMetadata(target);
  const draft =
    target.kind === "draft"
      ? useComposerDraftStore.getState().draftThreadsByThreadKey[target.draftId]
      : undefined;
  const thread = selectSidebarThreadSummaryByRef(useStore.getState(), metadata.threadRef);
  const environmentId = thread?.environmentId ?? draft?.environmentId;
  const projectId = thread?.projectId ?? draft?.projectId;
  const project =
    environmentId && projectId
      ? selectProjectByRef(useStore.getState(), scopeProjectRef(environmentId, projectId))
      : undefined;
  return {
    environmentId,
    cwd:
      metadata.exists && project
        ? thread
          ? (thread.worktreePath ?? project.cwd)
          : (draft?.worktreePath ?? project.cwd)
        : null,
  };
}

/** Navigation reads shell summaries only. Opening a tab must not subscribe to
 * its full transcript, queue, provider runtime or a second detail controller.
 * Draft titles remain the existing “New chat” until the first send creates
 * canonical server metadata; there is no separate tab-only title to diverge.
 */
export function useDeskTabMetadata(target: ThreadRouteTarget) {
  const draft = useComposerDraftStore((state) =>
    target.kind === "draft" ? state.draftThreadsByThreadKey[target.draftId] : undefined,
  );
  const threadRef = target.kind === "server" ? target.threadRef : (draft?.promotedTo ?? null);
  const thread = useStore((state) => selectSidebarThreadSummaryByRef(state, threadRef));
  const environmentId = thread?.environmentId ?? draft?.environmentId;
  const projectId = thread?.projectId ?? draft?.projectId;
  const projectName = useStore((state) =>
    environmentId && projectId
      ? selectProjectByRef(state, scopeProjectRef(environmentId, projectId))?.name
      : undefined,
  );
  const lastVisitedAt = useUiStateStore((state) =>
    threadRef ? state.threadLastVisitedAtById[scopedThreadKey(threadRef)] : undefined,
  );
  return deriveMetadata(target, draft, thread, projectName, lastVisitedAt);
}
