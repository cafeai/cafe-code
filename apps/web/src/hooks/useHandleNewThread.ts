import { useUiLocale } from "~/i18n";
import { uiText } from "@cafecode/shared/i18n";
import { scopedProjectKey, scopeProjectRef, scopeThreadRef } from "@cafecode/client-runtime";
import {
  DEFAULT_RUNTIME_MODE,
  ProviderDriverKind,
  type EnvironmentId,
  type ModelSelection,
  type ScopedProjectRef,
} from "@cafecode/contracts";
import { createModelSelection } from "@cafecode/shared/model";
import { useParams, useRouter } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import { DEFAULT_GEMINI_PERMISSION_STATE } from "../components/chat/geminiPermissionMode";
import {
  deriveNewChatComposerDefaults,
  selectStandaloneDraftSessions,
  type DraftId,
  type DraftThreadEnvMode,
  type DraftThreadState,
  useComposerDraftStore,
} from "../composerDraftStore";
import { getWorkspaceServerConfig } from "../environments/workspaceApi";
import {
  deriveProviderInstanceEntries,
  resolveComposerProviderInstance,
  resolveProviderDriverKindForInstanceSelection,
  sortProviderInstanceEntries,
} from "../providerInstances";
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
 * Match the Full access / Bypass default used by other providers when a brand-new
 * draft resolves to a Gemini account. Existing persisted threads using legacy
 * `default` + `full-access` remain Ask permissions; only newly created drafts
 * receive `gemini-bypass`, bound to that exact Gemini account.
 */
function applyDefaultGeminiPermissionModeForNewDraft(input: {
  readonly draftId: DraftId;
  readonly environmentId: EnvironmentId;
  readonly projectDefaultModelSelection: ModelSelection | null | undefined;
}): void {
  const serverConfig = getWorkspaceServerConfig(input.environmentId);
  const providers = serverConfig?.providers ?? [];
  const entries = sortProviderInstanceEntries(deriveProviderInstanceEntries(providers));
  const drafts = useComposerDraftStore.getState();
  const draft = drafts.getComposerDraft(input.draftId);
  const initialInstanceId =
    draft?.activeProvider ??
    input.projectDefaultModelSelection?.instanceId ??
    serverConfig?.settings.defaultProviderInstanceId ??
    null;
  const resolvedDriver = initialInstanceId
    ? (resolveProviderDriverKindForInstanceSelection(entries, providers, initialInstanceId) ??
      serverConfig?.settings.providerInstances[initialInstanceId]?.driver ??
      (initialInstanceId === "gemini" ? ProviderDriverKind.make("gemini") : undefined))
    : undefined;
  const selectedProvider = resolvedDriver ?? ProviderDriverKind.make("codex");
  const selectedInstanceId =
    entries.length > 0
      ? resolveComposerProviderInstance({
          entries,
          activeProvider: draft?.activeProvider,
          sessionInstanceId: null,
          threadInstanceId: input.projectDefaultModelSelection?.instanceId,
          defaultInstanceId: serverConfig?.settings.defaultProviderInstanceId,
          projectInstanceId: input.projectDefaultModelSelection?.instanceId,
          selectedProvider,
          lockedProvider: null,
          lockedContinuationGroupKey: null,
        })
      : initialInstanceId;
  if (!selectedInstanceId) return;
  const effectiveDriver =
    resolveProviderDriverKindForInstanceSelection(entries, providers, selectedInstanceId) ??
    serverConfig?.settings.providerInstances[selectedInstanceId]?.driver ??
    (selectedInstanceId === "gemini" ? ProviderDriverKind.make("gemini") : undefined);
  if (effectiveDriver !== "gemini") return;

  if (draft?.activeProvider === selectedInstanceId) {
    drafts.setDraftThreadContext(input.draftId, DEFAULT_GEMINI_PERMISSION_STATE);
    drafts.setRuntimeMode(input.draftId, DEFAULT_GEMINI_PERMISSION_STATE.runtimeMode);
    drafts.setInteractionMode(input.draftId, DEFAULT_GEMINI_PERMISSION_STATE.interactionMode);
    return;
  }

  if (input.projectDefaultModelSelection?.instanceId === selectedInstanceId) {
    // `activeThread.modelSelection.instanceId` already matches this Gemini
    // account, so updating the draft thread keeps `geminiBypassInstanceId`
    // aligned without materializing an otherwise empty composer draft.
    drafts.setDraftThreadContext(input.draftId, DEFAULT_GEMINI_PERMISSION_STATE);
    return;
  }

  const matchedEntry = entries.find((entry) => entry.instanceId === selectedInstanceId);
  const fallbackModel =
    serverConfig?.settings.providerInstances[selectedInstanceId]?.defaultModel ??
    matchedEntry?.models[0]?.slug;
  if (!fallbackModel) return;
  drafts.setModelSelection(input.draftId, createModelSelection(selectedInstanceId, fallbackModel));
  drafts.setDraftThreadContext(input.draftId, DEFAULT_GEMINI_PERMISSION_STATE);
  drafts.setRuntimeMode(input.draftId, DEFAULT_GEMINI_PERMISSION_STATE.runtimeMode);
  drafts.setInteractionMode(input.draftId, DEFAULT_GEMINI_PERMISSION_STATE.interactionMode);
}

/**
 * Global creation captures its environment and Desk destination synchronously.
 * No active project or route can confer a workspace/defaults on this draft.
 */
function useNewStandaloneChatHandler() {
  const uiLocale = useUiLocale();

  const router = useRouter();
  const newChatDefaults = useSettings(deriveNewChatComposerDefaults);
  return useCallback(async () => {
    const descriptor = readWorkspaceEnvironmentDescriptor();
    if (!descriptor?.capabilities.standaloneChats) {
      toastManager.add({
        type: "error",
        title: uiText(
          "Update the server to create a standalone chat",
          undefined,
          undefined,
          uiLocale,
        ),
        description: uiText(
          "This server does not support standalone chats yet.",
          undefined,
          undefined,
          uiLocale,
        ),
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
      applyDefaultGeminiPermissionModeForNewDraft({
        draftId,
        environmentId,
        projectDefaultModelSelection: null,
      });
    }
    // This is an editor destination, not an open-chat tab. Keep the sidebar
    // mode and existing saved tabs until the first send materializes a thread.
    deskStore.showDraftEditor(draftId, groupId);
    await router.navigate({ to: "/draft/$draftId", params: { draftId } });
  }, [newChatDefaults, router, uiLocale]);
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
        // Model defaults/sticky selection keep their existing precedence.
        // Concurrency remains inherited from the selected account at send time,
        // not copied into a permanent per-chat override during draft creation.
        applyStickyState(draftId, newChatDefaults);
        applyDefaultGeminiPermissionModeForNewDraft({
          draftId,
          environmentId: projectRef.environmentId,
          projectDefaultModelSelection: project?.defaultModelSelection ?? null,
        });

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
