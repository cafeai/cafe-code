import { useUiLocale } from "~/i18n";
import { uiText } from "@cafecode/shared/i18n";
import { parseScopedThreadKey, scopeProjectRef, scopeThreadRef } from "@cafecode/client-runtime";
import { type ScopedThreadRef, ThreadId } from "@cafecode/contracts";
import { isCodexHistoryRecoveryRequiredError } from "@cafecode/shared/codexHistorySafety";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useCallback, useLayoutEffect, useRef } from "react";

import { getFallbackThreadIdAfterDelete } from "../components/Sidebar.logic";
import { useComposerDraftStore } from "../composerDraftStore";
import { useDeskStore } from "../deskStore";
import { useNewThreadHandler } from "./useHandleNewThread";
import { ensureEnvironmentApi, readEnvironmentApi } from "../environmentApi";
import { invalidateGitQueries } from "../lib/gitReactQuery";
import { refreshArchivedThreadsForEnvironment } from "../lib/archivedThreadsState";
import { refreshDeletedThreadsForEnvironment } from "../lib/deletedThreadsState";
import { newCommandId, newThreadId } from "../lib/utils";
import {
  canDuplicateThread,
  claimThreadDuplication,
  isThreadDuplicationPending,
} from "../lib/threadDuplication";
import { readWorkspaceEnvironmentId, useWorkspaceSelection } from "../environments/workspace";
import { readLocalApi } from "../localApi";
import {
  selectProjectByRef,
  selectSidebarThreadSummaryByRef,
  selectThreadByRef,
  selectThreadsForEnvironment,
  useStore,
} from "../store";
import { buildThreadRouteParams, resolveThreadRouteRef } from "../threadRoutes";
import { formatWorktreePathForDisplay, getOrphanedWorktreePathForThread } from "../worktreeCleanup";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { useSettings } from "./useSettings";

// A second mounted pane must not admit a second copy while the first pane's
// confirmation or command is unresolved. This is UI admission only; the stable
// command/target identities below remain the server's idempotency boundary.
const pendingHistoryRecoveries = new Set<string>();

export function useThreadActions() {
  const uiLocale = useUiLocale();

  const sidebarThreadSortOrder = useSettings((settings) => settings.sidebarThreadSortOrder);
  const confirmThreadDelete = useSettings((settings) => settings.confirmThreadDelete);
  const clearComposerDraftForThread = useComposerDraftStore((store) => store.clearDraftThread);
  const clearProjectDraftThreadById = useComposerDraftStore(
    (store) => store.clearProjectDraftThreadById,
  );
  const router = useRouter();
  // A completed destructive command owns its captured chat, not later route
  // intent or a replacement mounted action surface. Retire navigation authority
  // synchronously on unmount without cancelling the already accepted mutation.
  const navigationOwner = useRef<object | null>(null);
  useLayoutEffect(() => {
    const owner = {};
    navigationOwner.current = owner;
    return () => {
      if (navigationOwner.current === owner) navigationOwner.current = null;
    };
  }, []);
  const { handleNewThread, handleNewStandaloneChat } = useNewThreadHandler();
  // Keep a ref so archiveThread can call handleNewThread without appearing in
  // its dependency array — handleNewThread is inherently unstable (depends on
  // the projects list) and would otherwise cascade new references into every
  // sidebar row via archiveThread → attemptArchiveThread.
  const handleNewThreadRef = useRef(handleNewThread);
  handleNewThreadRef.current = handleNewThread;
  const handleNewStandaloneChatRef = useRef(handleNewStandaloneChat);
  handleNewStandaloneChatRef.current = handleNewStandaloneChat;
  const queryClient = useQueryClient();
  const uncertainHistoryRecovery = useRef<{
    key: string;
    command: {
      type: "thread.duplicate";
      commandId: ReturnType<typeof newCommandId>;
      sourceThreadId: ThreadId;
      targetThreadId: ThreadId;
      title: string;
      createdAt: string;
    };
  } | null>(null);

  const resolveThreadTarget = useCallback((target: ScopedThreadRef) => {
    const state = useStore.getState();
    const thread = selectThreadByRef(state, target);
    if (!thread) {
      return null;
    }
    return {
      thread,
      threadRef: target,
    };
  }, []);
  const getCurrentRouteThreadRef = useCallback(() => {
    const currentRouteParams = router.state.matches[router.state.matches.length - 1]?.params ?? {};
    return resolveThreadRouteRef(currentRouteParams);
  }, [router]);

  const duplicateThread = useCallback(
    async (target: ScopedThreadRef): Promise<void> => {
      // Menu labels and the selected pane are not authority. Re-read the exact
      // clicked shell and its provider configuration without subscribing to or
      // fetching another conversation's transcript.
      const source = resolveThreadTarget(target)?.thread;
      const summary = selectSidebarThreadSummaryByRef(useStore.getState(), target);
      const owner = navigationOwner.current;
      if (!owner || !canDuplicateThread(summary) || !canDuplicateThread(source) || !source) return;
      const api = readEnvironmentApi(target.environmentId);
      if (!api) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: uiText("Could not duplicate chat", undefined, undefined, uiLocale),
            description: uiText(
              "Reconnect to the chat''s environment and try again.",
              undefined,
              undefined,
              uiLocale,
            ),
          }),
        );
        return;
      }
      const location = router.state.location;
      const workspace = useWorkspaceSelection.getState();
      const desk = useDeskStore.getState().desk;
      const selection = source.modelSelection;
      const selectedAccount = source.modelSelection.instanceId;
      const nativeAccount = source.session?.providerInstanceId;
      const nativeRuntime = source.session?.subagentRuntimeId;
      const operation = claimThreadDuplication(
        source,
        uiText("{title} (copy)", { title: source.title.slice(0, 180) }, undefined, uiLocale),
      );
      if (!operation) {
        // A second pending gesture is inert. An unresolved older operation or
        // a full bounded receipt table must not silently mint another branch.
        if (!isThreadDuplicationPending(target)) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: uiText("Could not duplicate chat", undefined, undefined, uiLocale),
              description: uiText(
                "Check the chat list for an earlier copy before trying again.",
                undefined,
                undefined,
                uiLocale,
              ),
            }),
          );
        }
        return;
      }
      let outcome: "acknowledged" | "uncertain" = "uncertain";
      try {
        // This is the established provider-native fork. The visible-history
        // recovery duplicate cannot preserve a resumable provider snapshot and
        // is deliberately never a fallback. No turn or prompt is submitted.
        await api.orchestration.dispatchCommand(operation.command);
        outcome = "acknowledged";
        const current = resolveThreadTarget(target)?.thread;
        if (
          navigationOwner.current === owner &&
          router.state.location === location &&
          useWorkspaceSelection.getState() === workspace &&
          useDeskStore.getState().desk === desk &&
          readEnvironmentApi(target.environmentId) === api &&
          current?.modelSelection === selection &&
          current.modelSelection.instanceId === selectedAccount &&
          current.session?.providerInstanceId === nativeAccount &&
          current.session?.subagentRuntimeId === nativeRuntime
        ) {
          await router.navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(
              scopeThreadRef(target.environmentId, operation.command.targetThreadId),
            ),
          });
        }
      } catch {
        if (outcome === "acknowledged") {
          // Navigation is presentation after a proven commit. Never describe
          // an opening failure as uncertain creation or invite another copy.
          toastManager.add(
            stackedThreadToast({
              type: "warning",
              title: uiText(
                "Chat duplicated, but could not open it",
                undefined,
                undefined,
                uiLocale,
              ),
              description: uiText(
                "Open the copy from the chat list. Do not duplicate it again.",
                undefined,
                undefined,
                uiLocale,
              ),
            }),
          );
          return;
        }
        // A lost response does not prove the native branch was never created.
        // Retain its exact command/target for a deliberate same-source retry;
        // never expose provider diagnostics or automatically repeat the action.
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: uiText("Could not duplicate chat", undefined, undefined, uiLocale),
            description: uiText(
              "Check the chat list and connection before trying again. The action was not automatically repeated.",
              undefined,
              undefined,
              uiLocale,
            ),
          }),
        );
      } finally {
        operation.finish(outcome);
      }
    },
    [resolveThreadTarget, router, uiLocale],
  );

  const continueInNewChat = useCallback(
    async (target: ScopedThreadRef, isCurrentSurface: () => boolean): Promise<void> => {
      const source = resolveThreadTarget(target)?.thread;
      const api = readEnvironmentApi(target.environmentId);
      const localApi = readLocalApi();
      const owner = navigationOwner.current;
      const location = router.state.location;
      const workspace = useWorkspaceSelection.getState();
      const route = getCurrentRouteThreadRef();
      if (
        !source ||
        !api ||
        !localApi ||
        !owner ||
        source.session?.provider !== "codex" ||
        !isCodexHistoryRecoveryRequiredError(source.error ?? "") ||
        source.session.activeTurnId != null ||
        source.session.status === "running" ||
        source.session.status === "connecting" ||
        (source.latestTurn !== null && !source.latestTurn.completedAt) ||
        route?.threadId !== target.threadId ||
        route.environmentId !== target.environmentId ||
        readWorkspaceEnvironmentId() !== target.environmentId ||
        !isCurrentSurface()
      )
        return;

      const pendingKey = JSON.stringify([target.environmentId, target.threadId]);
      const key = JSON.stringify([
        target.environmentId,
        target.threadId,
        source.createdAt,
        source.updatedAt,
        source.modelSelection,
        source.codexThreadId,
        source.session.subagentRuntimeId,
      ]);
      if (pendingHistoryRecoveries.has(pendingKey)) return;
      pendingHistoryRecoveries.add(pendingKey);
      // Never redirect a new route, a replacement pane, or a newly selected
      // account after the owner has spent time reviewing the confirmation.
      const stillCurrent = () => {
        const current = resolveThreadTarget(target)?.thread;
        return (
          navigationOwner.current === owner &&
          router.state.location === location &&
          useWorkspaceSelection.getState() === workspace &&
          isCurrentSurface() &&
          current?.createdAt === source.createdAt &&
          current.error === source.error &&
          current.modelSelection === source.modelSelection &&
          current.latestTurn === source.latestTurn &&
          current.codexThreadId === source.codexThreadId &&
          current.session?.subagentRuntimeId === source.session?.subagentRuntimeId &&
          current.session?.providerInstanceId === source.session?.providerInstanceId &&
          current.session?.activeTurnId == null &&
          current.session?.status !== "running" &&
          current.session?.status !== "connecting" &&
          current.archivedAt === null &&
          current.projectId === source.projectId &&
          current.branch === source.branch &&
          current.worktreePath === source.worktreePath &&
          current.runtimeMode === source.runtimeMode &&
          current.interactionMode === source.interactionMode
        );
      };
      try {
        const confirmed = await localApi.dialogs.confirm(
          [
            uiText("Continue in a new chat?", undefined, undefined, uiLocale),
            uiText(
              "Cafe will copy the visible conversation into a new chat using the same selected account. On your next explicit message, a bounded excerpt of recent visible messages will provide context to a fresh Codex session; hidden native history is not copied.",
              undefined,
              undefined,
              uiLocale,
            ),
            source.projectId === null
              ? uiText(
                  "This standalone chat receives a new empty workspace; existing workspace files are not copied.",
                  undefined,
                  undefined,
                  uiLocale,
                )
              : uiText(
                  "The new chat keeps this project's workspace context.",
                  undefined,
                  undefined,
                  uiLocale,
                ),
            uiText(
              "Your original chat and workspace files remain unchanged. No prompt is sent automatically, and your current draft stays in the original chat.",
              undefined,
              undefined,
              uiLocale,
            ),
          ].join("\n\n"),
        );
        if (!confirmed || !stillCurrent()) return;
        // Retain this exact command after an uncertain transport error. A
        // subsequent explicit retry must resolve the same copy, not create a
        // second chat merely because its first acknowledgement was lost.
        let operation = uncertainHistoryRecovery.current;
        if (operation?.key !== key) {
          operation = {
            key,
            command: {
              type: "thread.duplicate",
              commandId: newCommandId(),
              sourceThreadId: target.threadId,
              targetThreadId: newThreadId(),
              title: `${source.title.slice(0, 180)} (continued)`,
              createdAt: new Date().toISOString(),
            },
          };
          uncertainHistoryRecovery.current = operation;
        }
        await api.orchestration.dispatchCommand(operation.command);
        // Keep the identity after acknowledgement too: failed/stale navigation
        // must not turn a later explicit retry into another copy of this same
        // source revision. A changed source/account gets a new operation key.
        if (stillCurrent()) {
          await router.navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(
              scopeThreadRef(target.environmentId, operation.command.targetThreadId),
            ),
          });
        }
      } finally {
        pendingHistoryRecoveries.delete(pendingKey);
      }
    },
    [getCurrentRouteThreadRef, resolveThreadTarget, router, uiLocale],
  );

  const archiveThread = useCallback(
    async (target: ScopedThreadRef) => {
      const api = readEnvironmentApi(target.environmentId);
      if (!api) return;
      const resolved = resolveThreadTarget(target);
      if (!resolved) return;
      const { thread, threadRef } = resolved;
      if (thread.session?.status === "running" && thread.session.activeTurnId != null) {
        throw new Error(
          uiText("Can't archive a chat while it's running.", undefined, undefined, uiLocale),
        );
      }

      const currentRouteThreadRef = getCurrentRouteThreadRef();
      const shouldNavigateToDraft =
        currentRouteThreadRef?.threadId === threadRef.threadId &&
        currentRouteThreadRef.environmentId === threadRef.environmentId;
      const archiveCommand = api.orchestration.dispatchCommand({
        type: "thread.archive",
        commandId: newCommandId(),
        threadId: threadRef.threadId,
      });

      if (shouldNavigateToDraft) {
        if (thread.projectId === null) {
          await handleNewStandaloneChatRef.current();
        } else {
          await handleNewThreadRef.current(scopeProjectRef(thread.environmentId, thread.projectId));
        }
      }

      await archiveCommand;
      refreshArchivedThreadsForEnvironment(threadRef.environmentId);
    },
    [getCurrentRouteThreadRef, resolveThreadTarget, uiLocale],
  );

  const unarchiveThread = useCallback(async (target: ScopedThreadRef) => {
    const api = readEnvironmentApi(target.environmentId);
    if (!api) return;
    await api.orchestration.dispatchCommand({
      type: "thread.unarchive",
      commandId: newCommandId(),
      threadId: target.threadId,
    });
    refreshArchivedThreadsForEnvironment(target.environmentId);
  }, []);

  const restoreThread = useCallback(async (target: ScopedThreadRef) => {
    const api = readEnvironmentApi(target.environmentId);
    if (!api) return;
    await api.orchestration.dispatchCommand({
      type: "thread.restore",
      commandId: newCommandId(),
      threadId: target.threadId,
    });
    refreshDeletedThreadsForEnvironment(target.environmentId);
  }, []);

  const hardDeleteThread = useCallback(
    async (
      target: ScopedThreadRef,
      opts: { readonly confirm?: boolean; readonly refresh?: boolean } = {},
    ) => {
      const api = readEnvironmentApi(target.environmentId);
      if (!api) return;
      if (opts.confirm !== false) {
        const localApi = readLocalApi();
        if (!localApi) return;
        const confirmed = await localApi.dialogs.confirm(
          [
            uiText("Delete this chat forever?", undefined, undefined, uiLocale),
            uiText(
              "Its history, attachments and checkpoints are removed. This can't be undone.",
              undefined,
              undefined,
              uiLocale,
            ),
          ].join("\n"),
        );
        if (!confirmed) {
          return;
        }
      }

      await api.orchestration.hardDeleteThread({ threadId: target.threadId });
      clearComposerDraftForThread(target);
      if (opts.refresh !== false) {
        refreshDeletedThreadsForEnvironment(target.environmentId);
      }
    },
    [clearComposerDraftForThread, uiLocale],
  );

  const deleteThread = useCallback(
    async (target: ScopedThreadRef, opts: { deletedThreadKeys?: ReadonlySet<string> } = {}) => {
      const api = readEnvironmentApi(target.environmentId);
      if (!api) return;
      const resolved = resolveThreadTarget(target);
      if (!resolved) {
        // Thread not in main store (e.g. archived thread) — dispatch delete directly.
        await api.orchestration.dispatchCommand({
          type: "thread.delete",
          commandId: newCommandId(),
          threadId: target.threadId,
        });
        refreshArchivedThreadsForEnvironment(target.environmentId);
        refreshDeletedThreadsForEnvironment(target.environmentId);
        return;
      }
      const { thread, threadRef } = resolved;
      // Capture before any worktree confirmation or session-stop await. A newer
      // navigation, including away-and-back to this same URL, must win over this
      // action's eventual delete ACK. Router locations are immutable snapshots.
      const originalNavigationOwner = navigationOwner.current;
      const originalLocation = router.state.location;
      const originalRouteThreadRef = getCurrentRouteThreadRef();
      const wasCurrentChat =
        originalRouteThreadRef?.threadId === threadRef.threadId &&
        originalRouteThreadRef.environmentId === threadRef.environmentId;
      const state = useStore.getState();
      const threads = selectThreadsForEnvironment(state, threadRef.environmentId);
      const threadProject =
        thread.projectId === null
          ? undefined
          : selectProjectByRef(state, {
              environmentId: threadRef.environmentId,
              projectId: thread.projectId,
            });
      const deletedIds =
        opts.deletedThreadKeys && opts.deletedThreadKeys.size > 0
          ? new Set<ThreadId>(
              [...opts.deletedThreadKeys].flatMap((threadKey) => {
                const ref = parseScopedThreadKey(threadKey);
                return ref && ref.environmentId === threadRef.environmentId ? [ref.threadId] : [];
              }),
            )
          : undefined;
      const survivingThreads =
        deletedIds && deletedIds.size > 0
          ? threads.filter((entry) => entry.id === threadRef.threadId || !deletedIds.has(entry.id))
          : threads;
      const orphanedWorktreePath = getOrphanedWorktreePathForThread(
        survivingThreads,
        threadRef.threadId,
      );
      const displayWorktreePath = orphanedWorktreePath
        ? formatWorktreePathForDisplay(orphanedWorktreePath)
        : null;
      const canDeleteWorktree = orphanedWorktreePath !== null && threadProject !== undefined;
      const localApi = readLocalApi();
      const shouldDeleteWorktree =
        canDeleteWorktree &&
        localApi &&
        (await localApi.dialogs.confirm(
          [
            uiText(
              "This chat is the only one using this worktree:",
              undefined,
              undefined,
              uiLocale,
            ),
            displayWorktreePath ?? orphanedWorktreePath,
            "",
            uiText("Delete the worktree too?", undefined, undefined, uiLocale),
          ].join("\n"),
        ));

      if (thread.session && thread.session.status !== "closed") {
        await api.orchestration
          .dispatchCommand({
            type: "thread.session.stop",
            commandId: newCommandId(),
            threadId: threadRef.threadId,
            createdAt: new Date().toISOString(),
          })
          .catch(() => undefined);
      }

      const deletedThreadIds = deletedIds ?? new Set<ThreadId>();
      const fallbackThreadId = getFallbackThreadIdAfterDelete({
        threads,
        deletedThreadId: threadRef.threadId,
        deletedThreadIds,
        sortOrder: sidebarThreadSortOrder,
      });
      await api.orchestration.dispatchCommand({
        type: "thread.delete",
        commandId: newCommandId(),
        threadId: threadRef.threadId,
      });
      refreshArchivedThreadsForEnvironment(threadRef.environmentId);
      refreshDeletedThreadsForEnvironment(threadRef.environmentId);
      clearComposerDraftForThread(threadRef);
      if (thread.projectId !== null)
        clearProjectDraftThreadById(
          scopeProjectRef(threadRef.environmentId, thread.projectId),
          threadRef,
        );

      const currentRouteThreadRef = getCurrentRouteThreadRef();
      if (
        wasCurrentChat &&
        originalNavigationOwner !== null &&
        navigationOwner.current === originalNavigationOwner &&
        router.state.location === originalLocation &&
        currentRouteThreadRef?.threadId === threadRef.threadId &&
        currentRouteThreadRef.environmentId === threadRef.environmentId
      ) {
        if (fallbackThreadId) {
          const fallbackThread = selectThreadByRef(
            useStore.getState(),
            scopeThreadRef(threadRef.environmentId, fallbackThreadId),
          );
          if (fallbackThread) {
            await router.navigate({
              to: "/$environmentId/$threadId",
              params: buildThreadRouteParams(
                scopeThreadRef(fallbackThread.environmentId, fallbackThread.id),
              ),
              replace: true,
            });
          } else {
            await router.navigate({ to: "/", replace: true });
          }
        } else {
          await router.navigate({ to: "/", replace: true });
        }
      }

      if (!shouldDeleteWorktree || !orphanedWorktreePath || !threadProject) {
        return;
      }

      try {
        await ensureEnvironmentApi(threadRef.environmentId).vcs.removeWorktree({
          cwd: threadProject.cwd,
          path: orphanedWorktreePath,
          force: true,
        });
        await invalidateGitQueries(queryClient, {
          environmentId: threadRef.environmentId,
        });
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : uiText("Unknown error removing worktree.", undefined, undefined, uiLocale);
        console.error("Failed to remove orphaned worktree after thread deletion", {
          threadId: threadRef.threadId,
          projectCwd: threadProject.cwd,
          worktreePath: orphanedWorktreePath,
          error,
        });
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: uiText(
              "Chat deleted, but the worktree couldn't be removed",
              undefined,
              undefined,
              uiLocale,
            ),
            description: uiText(
              "Could not remove {value1}. {message}",
              {
                value1: displayWorktreePath ?? orphanedWorktreePath,
                message: message,
              },
              undefined,
              uiLocale,
            ),
          }),
        );
      }
    },
    [
      clearComposerDraftForThread,
      clearProjectDraftThreadById,
      getCurrentRouteThreadRef,
      router,
      queryClient,
      resolveThreadTarget,
      sidebarThreadSortOrder,
      uiLocale,
    ],
  );

  const confirmAndDeleteThread = useCallback(
    async (target: ScopedThreadRef) => {
      const api = readEnvironmentApi(target.environmentId);
      if (!api) return;
      const localApi = readLocalApi();
      const resolved = resolveThreadTarget(target);

      if (confirmThreadDelete && localApi) {
        const title = resolved?.thread.title ?? uiText("this chat", undefined, undefined, uiLocale);
        const confirmed = await localApi.dialogs.confirm(
          [
            uiText('Move "{title}" to the Recycle Bin?', { title: title }, undefined, uiLocale),
            uiText(
              "You can restore it from Settings > Recently Deleted.",
              undefined,
              undefined,
              uiLocale,
            ),
          ].join("\n"),
        );
        if (!confirmed) {
          return;
        }
      }

      await deleteThread(target);
    },
    [confirmThreadDelete, deleteThread, resolveThreadTarget, uiLocale],
  );

  return {
    archiveThread,
    unarchiveThread,
    restoreThread,
    deleteThread,
    confirmAndDeleteThread,
    hardDeleteThread,
    continueInNewChat,
    duplicateThread,
  };
}
