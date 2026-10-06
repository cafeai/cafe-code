import { scopedProjectKey, scopeProjectRef, scopeThreadRef } from "@cafecode/client-runtime";
import { DEFAULT_RUNTIME_MODE, type ScopedProjectRef } from "@cafecode/contracts";
import { useParams, useRouter } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import {
  deriveNewChatComposerDefaults,
  selectStandaloneDraftSessions,
  type DraftThreadEnvMode,
  type DraftThreadState,
  useComposerDraftStore,
} from "../composerDraftStore";
import { newDraftId, newThreadId } from "../lib/utils";
import { orderItemsByPreferredIds } from "../components/Sidebar.logic";
import {
  deriveLogicalProjectKeyFromSettings,
  getProjectOrderKey,
  selectProjectGroupingSettings,
} from "../logicalProject";
import { selectThreadExistsByRef, useStore } from "../store";
import { useWorkspaceProjects } from "../environments/workspaceData";
import { createThreadSelectorByRef } from "../storeSelectors";
import { resolveThreadRouteTarget } from "../threadRoutes";
import { useUiStateStore } from "../uiStateStore";
import { useSettings } from "./useSettings";
import {
  readWorkspaceEnvironmentDescriptor,
  useWorkspaceEnvironmentId,
} from "../environments/workspace";
import { useDeskStore } from "../deskStore";
import { toastManager } from "../components/ui/toast";
import { isChatSendInFlight } from "../chatPaneContext";

/**
 * Global creation captures its environment and Desk destination synchronously.
 * No active project or route can confer a workspace/defaults on this draft.
 */
function useNewStandaloneChatHandler() {
  const router = useRouter();
  const newChatDefaults = useSettings(deriveNewChatComposerDefaults);
  return useCallback(async () => {
    const descriptor = readWorkspaceEnvironmentDescriptor();
    if (!descriptor?.capabilities.standaloneChats) {
      toastManager.add({
        type: "error",
        title: "Update the server to create a standalone chat",
        description: "This server does not support standalone chats yet.",
      });
      return;
    }
    const environmentId = descriptor.environmentId;
    const deskStore = useDeskStore.getState();
    deskStore.bindEnvironment(environmentId);
    const groupId = useDeskStore.getState().desk.activeGroupId;
    const drafts = useComposerDraftStore.getState();
    const params = router.state.matches[router.state.matches.length - 1]?.params ?? {};
    const currentTarget = resolveThreadRouteTarget(params);
    const preferredId =
      currentTarget?.kind === "draft" ? currentTarget.draftId : deskStore.activeDraftId;
    const reusable = selectStandaloneDraftSessions(drafts, environmentId)
      .filter(
        (draft) =>
          !isChatSendInFlight(environmentId, draft.threadId) &&
          !selectThreadExistsByRef(
            useStore.getState(),
            scopeThreadRef(environmentId, draft.threadId),
          ),
      )
      .toSorted(
        (left, right) =>
          Number(right.draftId === preferredId) - Number(left.draftId === preferredId) ||
          right.createdAt.localeCompare(left.createdAt) ||
          left.draftId.localeCompare(right.draftId),
      )[0];
    const draftId = reusable?.draftId ?? newDraftId();
    if (!reusable) {
      drafts.createStandaloneDraftSession(draftId, environmentId, newThreadId());
      drafts.applyStickyState(draftId, newChatDefaults);
    }
    // This is an editor destination, not an open-chat tab. Keep the sidebar
    // mode and existing saved tabs until the first send materializes a thread.
    deskStore.showDraftEditor(draftId, groupId);
    await router.navigate({ to: "/draft/$draftId", params: { draftId } });
  }, [newChatDefaults, router]);
}

function useNewThreadState() {
  const projects = useWorkspaceProjects();
  const projectGroupingSettings = useSettings(selectProjectGroupingSettings);
  const newChatDefaults = useSettings(deriveNewChatComposerDefaults);
  const router = useRouter();
  const getCurrentRouteTarget = useCallback(() => {
    const currentRouteParams = router.state.matches[router.state.matches.length - 1]?.params ?? {};
    return resolveThreadRouteTarget(currentRouteParams);
  }, [router]);

  return useCallback(
    (
      projectRef: ScopedProjectRef,
      options?: {
        branch?: string | null;
        worktreePath?: string | null;
        envMode?: DraftThreadEnvMode;
      },
    ): Promise<void> => {
      const {
        getDraftSessionByLogicalProjectKey,
        getDraftSessionByProjectRef,
        getDraftSession,
        getDraftThread,
        applyStickyState,
        setDraftThreadContext,
        setLogicalProjectDraftThreadId,
      } = useComposerDraftStore.getState();
      const currentRouteTarget = getCurrentRouteTarget();
      const project = projects.find(
        (candidate) =>
          candidate.id === projectRef.projectId &&
          candidate.environmentId === projectRef.environmentId,
      );
      const logicalProjectKey = project
        ? deriveLogicalProjectKeyFromSettings(project, projectGroupingSettings)
        : scopedProjectKey(projectRef);
      const hasBranchOption = options?.branch !== undefined;
      const hasWorktreePathOption = options?.worktreePath !== undefined;
      const hasEnvModeOption = options?.envMode !== undefined;
      const logicalDraft = getDraftSessionByLogicalProjectKey(logicalProjectKey);
      const storedDraftThread =
        logicalDraft?.environmentId === projectRef.environmentId
          ? logicalDraft
          : getDraftSessionByProjectRef(projectRef);
      const latestActiveDraftThread: DraftThreadState | null = currentRouteTarget
        ? currentRouteTarget.kind === "server"
          ? getDraftThread(currentRouteTarget.threadRef)
          : getDraftSession(currentRouteTarget.draftId)
        : null;
      if (storedDraftThread) {
        return (async () => {
          if (hasBranchOption || hasWorktreePathOption || hasEnvModeOption) {
            setDraftThreadContext(storedDraftThread.draftId, {
              ...(hasBranchOption ? { branch: options?.branch ?? null } : {}),
              ...(hasWorktreePathOption ? { worktreePath: options?.worktreePath ?? null } : {}),
              ...(hasEnvModeOption ? { envMode: options?.envMode } : {}),
            });
          }
          setLogicalProjectDraftThreadId(logicalProjectKey, projectRef, storedDraftThread.draftId, {
            threadId: storedDraftThread.threadId,
          });
          if (
            currentRouteTarget?.kind === "draft" &&
            currentRouteTarget.draftId === storedDraftThread.draftId
          ) {
            return;
          }
          await router.navigate({
            to: "/draft/$draftId",
            params: { draftId: storedDraftThread.draftId },
          });
        })();
      }

      if (
        latestActiveDraftThread &&
        currentRouteTarget?.kind === "draft" &&
        latestActiveDraftThread.logicalProjectKey === logicalProjectKey &&
        latestActiveDraftThread.environmentId === projectRef.environmentId &&
        latestActiveDraftThread.promotedTo == null
      ) {
        if (hasBranchOption || hasWorktreePathOption || hasEnvModeOption) {
          setDraftThreadContext(currentRouteTarget.draftId, {
            ...(hasBranchOption ? { branch: options?.branch ?? null } : {}),
            ...(hasWorktreePathOption ? { worktreePath: options?.worktreePath ?? null } : {}),
            ...(hasEnvModeOption ? { envMode: options?.envMode } : {}),
          });
        }
        setLogicalProjectDraftThreadId(logicalProjectKey, projectRef, currentRouteTarget.draftId, {
          threadId: latestActiveDraftThread.threadId,
          createdAt: latestActiveDraftThread.createdAt,
          runtimeMode: latestActiveDraftThread.runtimeMode,
          interactionMode: latestActiveDraftThread.interactionMode,
          ...(hasBranchOption ? { branch: options?.branch ?? null } : {}),
          ...(hasWorktreePathOption ? { worktreePath: options?.worktreePath ?? null } : {}),
          ...(hasEnvModeOption ? { envMode: options?.envMode } : {}),
        });
        return Promise.resolve();
      }

      const draftId = newDraftId();
      const threadId = newThreadId();
      const createdAt = new Date().toISOString();
      return (async () => {
        setLogicalProjectDraftThreadId(logicalProjectKey, projectRef, draftId, {
          threadId,
          createdAt,
          branch: options?.branch ?? null,
          worktreePath: options?.worktreePath ?? null,
          envMode: options?.envMode ?? "local",
          runtimeMode: DEFAULT_RUNTIME_MODE,
        });
        // Project defaults are the initial provider only when neither an
        // explicit global default nor the existing sticky picker wins. Copy
        // that exact account's numeric default once, never a same-driver peer.
        applyStickyState(draftId, newChatDefaults, project?.defaultModelSelection?.instanceId);

        await router.navigate({
          to: "/draft/$draftId",
          params: { draftId },
        });
      })();
    },
    [getCurrentRouteTarget, newChatDefaults, projectGroupingSettings, router, projects],
  );
}

export function useNewThreadHandler() {
  const handleNewThread = useNewThreadState();
  const handleNewStandaloneChat = useNewStandaloneChatHandler();

  return {
    handleNewThread,
    handleNewStandaloneChat,
  };
}

export function useHandleNewThread() {
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const routeThreadRef = routeTarget?.kind === "server" ? routeTarget.threadRef : null;
  const activeThread = useStore(
    useMemo(() => createThreadSelectorByRef(routeThreadRef), [routeThreadRef]),
  );
  const getDraftThread = useComposerDraftStore((store) => store.getDraftThread);
  const activeDraftThread = useComposerDraftStore(() =>
    routeTarget
      ? routeTarget.kind === "server"
        ? getDraftThread(routeTarget.threadRef)
        : useComposerDraftStore.getState().getDraftSession(routeTarget.draftId)
      : null,
  );
  const projects = useWorkspaceProjects();
  const workspaceEnvironmentId = useWorkspaceEnvironmentId();
  const orderedProjects = useMemo(() => {
    return orderItemsByPreferredIds({
      items: projects,
      preferredIds: projectOrder,
      getId: getProjectOrderKey,
    });
  }, [projectOrder, projects]);
  const handleNewThread = useNewThreadState();
  const handleNewStandaloneChat = useNewStandaloneChatHandler();

  return {
    activeDraftThread:
      activeDraftThread?.environmentId === workspaceEnvironmentId ? activeDraftThread : null,
    activeThread: activeThread?.environmentId === workspaceEnvironmentId ? activeThread : undefined,
    defaultProjectRef: orderedProjects.find(
      (project) => project.environmentId === workspaceEnvironmentId,
    )
      ? scopeProjectRef(
          workspaceEnvironmentId!,
          orderedProjects.find((project) => project.environmentId === workspaceEnvironmentId)!.id,
        )
      : null,
    handleNewThread,
    handleNewStandaloneChat,
    routeThreadRef,
  };
}
