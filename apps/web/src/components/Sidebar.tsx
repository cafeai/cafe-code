import { useUiLocale, useUiPresentation } from "~/i18n";
import { uiText } from "@cafecode/shared/i18n";
import { UiMessage } from "~/i18n";
import {
  ArchiveIcon,
  ArrowUpDownIcon,
  ChevronRightIcon,
  FolderPlusIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  SquarePenIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import {
  ChangeRequestStatusIcon,
  prStatusIndicator,
  resolveThreadPr,
  ThreadStatusDot,
  ThreadStatusLabel,
} from "./ThreadStatusIndicators";
import { SegmentedControl } from "./ui/segmented-control";
import { ProjectFavicon } from "./ProjectFavicon";
import { autoAnimate } from "@formkit/auto-animate";
import React, { useCallback, useEffect, memo, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  DndContext,
  type DragCancelEvent,
  type CollisionDetection,
  PointerSensor,
  type DragStartEvent,
  closestCorners,
  pointerWithin,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { CSS } from "@dnd-kit/utilities";
import {
  type ContextMenuItem,
  type DesktopUpdateState,
  type ProviderThreadAssistantMessagesRepairResult,
  ProjectId,
  type ScopedThreadRef,
  type SidebarProjectGroupingMode,
  type ThreadEnvMode,
  ThreadId,
} from "@cafecode/contracts";
import {
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@cafecode/client-runtime";
import { Link, useLocation, useNavigate, useParams, useRouter } from "@tanstack/react-router";
import {
  DEFAULT_BRAND_WORDMARK_PREFIX,
  MAX_SIDEBAR_THREAD_PREVIEW_COUNT,
  MIN_SIDEBAR_THREAD_PREVIEW_COUNT,
  type SidebarBrandImageAsset,
  type SidebarProjectSortOrder,
  type SidebarThreadPreviewCount,
  type SidebarThreadSortOrder,
} from "@cafecode/contracts/settings";
import { useWorkspaceEnvironmentId, useIsSavedRemoteEnvironment } from "../environments/workspace";
import { useWorkspaceProjects, useWorkspaceSidebarThreads } from "../environments/workspaceData";
import { WorkspaceEnvironmentSelector } from "./WorkspaceEnvironmentSelector";
import { isElectron } from "../env";
import { APP_STAGE_LABEL, APP_VERSION } from "../branding";
import {
  DEFAULT_SIDEBAR_BRAND_IMAGE_SIZES,
  DEFAULT_SIDEBAR_BRAND_IMAGE_SRC_SET,
  useSidebarBrandImageSrc,
} from "../brandingImages";
import { cn, isMacPlatform, newCommandId, newThreadId } from "../lib/utils";
import {
  selectBootstrapCompleteForEnvironment,
  selectProjectByRef,
  selectSidebarThreadsForProjectRefs,
  selectThreadByRef,
  useStore,
} from "../store";
import { useUiStateStore } from "../uiStateStore";
import {
  resolveShortcutCommand,
  shortcutLabelForCommand,
  shouldShowThreadJumpHintsForModifiers,
  threadJumpCommandForIndex,
  threadJumpIndexFromCommand,
  threadTraversalDirectionFromCommand,
} from "../keybindings";
import { useModelPickerOpen } from "../modelPickerOpenState";
import { useShortcutModifierState } from "../shortcutModifierState";
import { useGitStatus } from "../lib/gitStatusState";
import { useDesktopDebugEnabled } from "../lib/desktopDebugState";
import { readLocalApi } from "../localApi";
import { useComposerDraftStore } from "../composerDraftStore";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { useThreadActions } from "../hooks/useThreadActions";
import { canDuplicateThread, isThreadDuplicationPending } from "../lib/threadDuplication";
import {
  buildThreadRouteParams,
  resolveThreadRouteRef,
  resolveThreadRouteTarget,
} from "../threadRoutes";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { SettingsSidebarNav } from "./settings/SettingsSidebarNav";
import { SidebarFooterNavigation } from "./SidebarFooterNavigation";
import { useTaskAtriumStore } from "./atrium/taskAtriumStore";
import { Kbd } from "./ui/kbd";
import {
  getArm64IntelBuildWarningDescription,
  getDesktopUpdateActionError,
  getDesktopUpdateInstallConfirmationMessage,
  getDesktopUpdateReleaseUrl,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
  shouldShowArm64IntelBuildWarning,
  shouldToastDesktopUpdateActionResult,
  type DesktopUpdateButtonAction,
} from "./desktopUpdate.logic";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "./ui/alert";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import {
  Menu,
  MenuGroup,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "./ui/menu";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "./ui/number-field";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarSeparator,
  useSidebar,
} from "./ui/sidebar";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { useCommandPaletteStore } from "../commandPaletteStore";
import {
  buildSidebarThreadContextMenuItems,
  isProjectDeleteRequiresForceError,
  resolveAdjacentThreadId,
  isContextMenuPointerDown,
  resolveProjectStatusIndicator,
  resolveSidebarNewThreadSeedContext,
  resolveSidebarNewThreadEnvMode,
  resolveThreadRowClassName,
  resolveThreadStatusPill,
  orderItemsByPreferredIds,
  shouldClearThreadSelectionOnMouseDown,
  sortProjectsForSidebar,
  summarizeHiddenThreadStatuses,
  useThreadJumpHintVisibility,
  type HiddenThreadStatusSummary,
} from "./Sidebar.logic";
import { sortThreads } from "../lib/threadSort";
import { SidebarUpdatePill } from "./sidebar/SidebarUpdatePill";
import { SidebarStatusBadge } from "./sidebar/SidebarStatusBadge";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useIsMobile } from "~/hooks/useMediaQuery";
import { CommandDialogTrigger } from "./ui/command";
import { FirstRunHint } from "./FirstRunHint";
import {
  FIRST_RUN_HINT_KEYS,
  shouldShowAddProjectHint,
  withDismissedHint,
} from "../firstRunOnboarding";
import { readEnvironmentApi } from "../environmentApi";
import { getClientSettings, useSettings, useUpdateSettings } from "~/hooks/useSettings";
import { useServerKeybindings } from "../rpc/serverState";
import {
  derivePhysicalProjectKey,
  deriveProjectGroupingOverrideKey,
  getProjectOrderKey,
  selectProjectGroupingSettings,
} from "../logicalProject";
import type { Project, SidebarThreadSummary } from "../types";
import {
  buildPhysicalToLogicalProjectKeyMap,
  buildSidebarProjectSnapshots,
  type SidebarProjectGroupMember,
  type SidebarProjectSnapshot,
} from "../sidebarProjectGrouping";
import { SidebarProviderUpdatePill } from "./sidebar/SidebarProviderUpdatePill";
import { SidebarNewChatButton } from "./sidebar/SidebarNewChatButton";
import { SidebarThreadOverflowToggle } from "./sidebar/SidebarThreadOverflowToggle";
import { SidebarTriggerWithUnreadDot } from "./sidebar/unseenCompletions";
import { DeskSidebar } from "./desk/DeskSidebar";
import { useDeskStore } from "../deskStore";
import { deskTabKey } from "../deskModel";
import { renameThread } from "../threadRename";
import type { ThreadRouteTarget } from "../threadRoutes";
import {
  readScheduledFollowUpAtFrom,
  useScheduledFollowUpAt,
  useScheduledFollowupPresenceByEnvironment,
} from "./chat/scheduledFollowupPresence";
import {
  buildStandaloneCatalog,
  type StandaloneCatalogEntry,
} from "./sidebar/standaloneNavigation.logic";
const SIDEBAR_SORT_LABELS: Record<SidebarProjectSortOrder, string> = {
  get updated_at() {
    return uiText("Last user message");
  },
  get created_at() {
    return uiText("Created at");
  },
  get manual() {
    return uiText("Manual");
  },
};
const SIDEBAR_THREAD_SORT_LABELS: Record<SidebarThreadSortOrder, string> = {
  get updated_at() {
    return uiText("Last user message");
  },
  get created_at() {
    return uiText("Created at");
  },
};
const SIDEBAR_LIST_ANIMATION_OPTIONS = {
  duration: 180,
  easing: "ease-out",
} as const;
const EMPTY_THREAD_JUMP_LABELS = new Map<string, string>();
const PATH_SEPARATOR_REGEX = /[/\\]+/g;

function normalizePathForComparison(pathValue: string): string {
  return pathValue.trim().replace(PATH_SEPARATOR_REGEX, "/").replace(/\/+$/, "");
}

function pathContainsPath(parentPath: string, childPath: string): boolean {
  const parent = normalizePathForComparison(parentPath);
  const child = normalizePathForComparison(childPath);
  return child.startsWith(`${parent}/`);
}
const PROJECT_GROUPING_MODE_LABELS: Record<SidebarProjectGroupingMode, string> = {
  get repository() {
    return uiText("Group by repository");
  },
  get repository_path() {
    return uiText("Group by repository path");
  },
  get separate() {
    return uiText("Keep separate");
  },
};

function sortThreadMoveCandidates(projects: readonly Project[]): Project[] {
  return projects.toSorted(
    (left, right) =>
      left.name.localeCompare(right.name, undefined, { sensitivity: "base" }) ||
      left.cwd.localeCompare(right.cwd, undefined, { sensitivity: "base" }) ||
      left.id.localeCompare(right.id),
  );
}

function clampSidebarThreadPreviewCount(value: number): SidebarThreadPreviewCount {
  return Math.min(
    MAX_SIDEBAR_THREAD_PREVIEW_COUNT,
    Math.max(MIN_SIDEBAR_THREAD_PREVIEW_COUNT, value),
  ) as SidebarThreadPreviewCount;
}

function formatProjectMemberActionLabel(
  member: SidebarProjectGroupMember,
  groupedProjectCount: number,
): string {
  if (groupedProjectCount <= 1) {
    return member.name;
  }

  return member.environmentLabel
    ? uiText("{environment} — {path}", {
        environment: member.environmentLabel,
        path: member.cwd,
      })
    : member.cwd;
}

function projectGroupingModeDescription(mode: SidebarProjectGroupingMode): string {
  switch (mode) {
    case "repository":
      return uiText("Projects from the same repository share one sidebar row.");
    case "repository_path":
      return uiText("Projects group only when both the repository and repo-relative path match.");
    case "separate":
      return uiText("Every project path gets its own sidebar row.");
  }
}

function buildThreadJumpLabelMap(input: {
  keybindings: ReturnType<typeof useServerKeybindings>;
  platform: string;
  threadJumpCommandByKey: ReadonlyMap<
    string,
    NonNullable<ReturnType<typeof threadJumpCommandForIndex>>
  >;
}): ReadonlyMap<string, string> {
  if (input.threadJumpCommandByKey.size === 0) {
    return EMPTY_THREAD_JUMP_LABELS;
  }

  const shortcutLabelOptions = {
    platform: input.platform,
    context: {},
  } as const;
  const mapping = new Map<string, string>();
  for (const [threadKey, command] of input.threadJumpCommandByKey) {
    const label = shortcutLabelForCommand(input.keybindings, command, shortcutLabelOptions);
    if (label) {
      mapping.set(threadKey, label);
    }
  }
  return mapping.size > 0 ? mapping : EMPTY_THREAD_JUMP_LABELS;
}

interface SidebarThreadRowProps {
  thread: SidebarThreadSummary;
  projectCwd: string | null;
  orderedProjectThreadKeys: readonly string[];
  isActive: boolean;
  jumpLabel: string | null;
  appSettingsConfirmThreadArchive: boolean;
  renamingThreadKey: string | null;
  renamingTitle: string;
  setRenamingTitle: (title: string) => void;
  renamingInputRef: React.RefObject<HTMLInputElement | null>;
  renamingCommittedRef: React.RefObject<boolean>;
  confirmingArchiveThreadKey: string | null;
  setConfirmingArchiveThreadKey: React.Dispatch<React.SetStateAction<string | null>>;
  confirmArchiveButtonRefs: React.RefObject<Map<string, HTMLButtonElement>>;
  handleThreadClick: (
    event: React.MouseEvent,
    threadRef: ScopedThreadRef,
    orderedProjectThreadKeys: readonly string[],
  ) => void;
  navigateToThread: (threadRef: ScopedThreadRef) => void;
  handleMultiSelectContextMenu: (position: { x: number; y: number }) => Promise<void>;
  handleThreadContextMenu: (
    threadRef: ScopedThreadRef,
    position: { x: number; y: number },
  ) => Promise<void>;
  clearSelection: () => void;
  commitRename: (
    threadRef: ScopedThreadRef,
    newTitle: string,
    originalTitle: string,
  ) => Promise<void>;
  cancelRename: () => void;
  beginRename: (threadRef: ScopedThreadRef, title: string) => void;
  attemptArchiveThread: (threadRef: ScopedThreadRef) => Promise<void>;
  openPrLink: (event: React.MouseEvent<HTMLElement>, prUrl: string) => void;
}

type ThreadRepairDialogState =
  | {
      readonly phase: "running";
      readonly thread: SidebarThreadSummary;
    }
  | {
      readonly phase: "complete";
      readonly thread: SidebarThreadSummary;
      readonly result: ProviderThreadAssistantMessagesRepairResult;
    }
  | {
      readonly phase: "error";
      readonly thread: SidebarThreadSummary;
      readonly message: string;
    };

function repairDialogSkippedCount(result: ProviderThreadAssistantMessagesRepairResult): number {
  const counts = result.counts;
  return (
    counts.notEligible +
    counts.sourceNotFound +
    counts.ambiguousSource +
    counts.diverged +
    counts.upstreamUnavailable
  );
}

function RepairCountCell({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border-subtle bg-muted px-3 py-2">
      <span className="block text-xs text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  );
}

function ThreadRepairProgressDialog({
  state,
  onClose,
}: {
  state: ThreadRepairDialogState | null;
  onClose: () => void;
}) {
  const uiLocale = useUiLocale();

  const running = state?.phase === "running";
  const result = state?.phase === "complete" ? state.result : null;
  const skipped = result ? repairDialogSkippedCount(result) : 0;

  return (
    <Dialog
      open={state !== null}
      onOpenChange={(open) => {
        if (!open && !running) {
          onClose();
        }
      }}
    >
      <DialogPopup className="max-w-md" showCloseButton={!running}>
        <DialogHeader>
          <DialogTitle>
            {uiText("Repair chat messages", undefined, undefined, uiLocale)}
          </DialogTitle>
          <DialogDescription>
            {state
              ? uiText('"{title}"', { title: state.thread.title }, undefined, uiLocale)
              : uiText("Repairing the selected chat.", undefined, undefined, uiLocale)}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          {running ? (
            <div className="space-y-3">
              <div
                role="progressbar"
                aria-label={uiText("Repair progress", undefined, undefined, uiLocale)}
                className="h-2 overflow-hidden rounded-full bg-muted"
              >
                <div className="h-full w-1/2 animate-pulse rounded-full bg-primary" />
              </div>
              <p className="text-sm text-muted-foreground">
                {uiText("Checking saved and provider history…", undefined, undefined, uiLocale)}
              </p>
            </div>
          ) : null}

          {result ? (
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-2 text-sm">
                <RepairCountCell
                  label={uiText("Messages", undefined, undefined, uiLocale)}
                  value={result.counts.totalMessages}
                />
                <RepairCountCell
                  label={uiText("Repaired", undefined, undefined, uiLocale)}
                  value={result.counts.repaired}
                />
                <RepairCountCell
                  label={uiText("Already complete", undefined, undefined, uiLocale)}
                  value={result.counts.unchanged}
                />
                <RepairCountCell
                  label={uiText("Skipped", undefined, undefined, uiLocale)}
                  value={skipped}
                />
              </div>
              {/* Which history sources were consulted is diagnostic detail,
                  so it stays collapsed (docs/style-guide.md §10). */}
              <details className="group/repair-details text-xs text-muted-foreground">
                <summary className="focus-ring inline-flex cursor-pointer list-none items-center gap-1 rounded-sm select-none hover:text-foreground [&::-webkit-details-marker]:hidden">
                  <ChevronRightIcon className="size-3.5 transition-transform duration-(--duration-fast) group-open/repair-details:rotate-90" />
                  {uiText("Details", undefined, undefined, uiLocale)}
                </summary>
                <div className="mt-2 grid animate-enter-rise grid-cols-2 gap-2 text-sm">
                  <RepairCountCell
                    label={uiText("Local checks", undefined, undefined, uiLocale)}
                    value={result.counts.localAttempts}
                  />
                  <RepairCountCell
                    label={uiText("Upstream checks", undefined, undefined, uiLocale)}
                    value={result.counts.upstreamAttempts}
                  />
                </div>
              </details>
            </div>
          ) : null}

          {state?.phase === "error" ? (
            <Alert variant="error">
              <TriangleAlertIcon className="size-4" />
              <AlertTitle>
                {uiText("Could not repair chat", undefined, undefined, uiLocale)}
              </AlertTitle>
              <AlertDescription>{state.message}</AlertDescription>
            </Alert>
          ) : null}
        </DialogPanel>
        {!running ? (
          <DialogFooter>
            <Button onClick={onClose}>{uiText("Close", undefined, undefined, uiLocale)}</Button>
          </DialogFooter>
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

const SidebarThreadRow = memo(function SidebarThreadRow(props: SidebarThreadRowProps) {
  const uiLocale = useUiLocale();
  const uiPresentation = useUiPresentation(UI_PRESENTATION_SOURCES);

  const {
    orderedProjectThreadKeys,
    isActive,
    jumpLabel,
    appSettingsConfirmThreadArchive,
    renamingThreadKey,
    renamingTitle,
    setRenamingTitle,
    renamingInputRef,
    renamingCommittedRef,
    confirmingArchiveThreadKey,
    setConfirmingArchiveThreadKey,
    confirmArchiveButtonRefs,
    handleThreadClick,
    navigateToThread,
    handleMultiSelectContextMenu,
    handleThreadContextMenu,
    clearSelection,
    commitRename,
    cancelRename,
    beginRename,
    attemptArchiveThread,
    openPrLink,
    thread,
  } = props;
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const threadKey = scopedThreadKey(threadRef);
  const lastVisitedAt = useUiStateStore((state) => state.threadLastVisitedAtById[threadKey]);
  const isSelected = useThreadSelectionStore((state) => state.selectedThreadKeys.has(threadKey));
  // For grouped projects, the thread may belong to a different environment
  // than the representative project.  Look up the thread's own project cwd
  // so git status (and thus PR detection) queries the correct path.
  const threadProjectCwd = useStore(
    useMemo(
      () => (state: import("../store").AppState) =>
        thread.projectId === null
          ? null
          : (selectProjectByRef(state, scopeProjectRef(thread.environmentId, thread.projectId))
              ?.cwd ?? null),
      [thread.environmentId, thread.projectId],
    ),
  );
  // Even malformed/imported standalone shell metadata must not authorize a
  // repository status request. Projectless chats have no workspace boundary.
  const gitCwd =
    thread.projectId === null
      ? null
      : (thread.worktreePath ?? threadProjectCwd ?? props.projectCwd);
  const gitStatus = useGitStatus({
    environmentId: thread.environmentId,
    cwd: thread.branch != null ? gitCwd : null,
  });
  const isHighlighted = isActive || isSelected;
  const isThreadRunning =
    thread.session?.status === "running" && thread.session.activeTurnId != null;
  const scheduledFollowUpAt = useScheduledFollowUpAt(thread.environmentId, thread.id);
  const threadStatus = resolveThreadStatusPill({
    thread: {
      ...thread,
      lastVisitedAt,
      scheduledFollowUpAt,
    },
  });
  const pr = thread.projectId === null ? null : resolveThreadPr(thread.branch, gitStatus.data);
  const prStatus = uiPresentation.prStatusIndicator(pr, gitStatus.data?.sourceControlProvider);
  const isConfirmingArchive = confirmingArchiveThreadKey === threadKey && !isThreadRunning;
  const threadMetaClassName = isConfirmingArchive
    ? "pointer-events-none opacity-0"
    : "pointer-events-none transition-opacity duration-150 max-md:opacity-0 pointer-coarse:opacity-0 group-hover/menu-sub-item:opacity-0 group-focus-within/menu-sub-item:opacity-0";
  const clearConfirmingArchive = useCallback(() => {
    setConfirmingArchiveThreadKey((current) => (current === threadKey ? null : current));
  }, [setConfirmingArchiveThreadKey, threadKey]);
  const handleMouseLeave = useCallback(() => {
    clearConfirmingArchive();
  }, [clearConfirmingArchive]);
  const handleBlurCapture = useCallback(
    (event: React.FocusEvent<HTMLLIElement>) => {
      const currentTarget = event.currentTarget;
      requestAnimationFrame(() => {
        if (currentTarget.contains(document.activeElement)) {
          return;
        }
        clearConfirmingArchive();
      });
    },
    [clearConfirmingArchive],
  );
  const handleRowClick = useCallback(
    (event: React.MouseEvent) => {
      handleThreadClick(event, threadRef, orderedProjectThreadKeys);
    },
    [handleThreadClick, orderedProjectThreadKeys, threadRef],
  );
  const handleRowKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      // Nested actions own their native Enter/Space behavior.
      if (event.target !== event.currentTarget) return;
      if (event.key === "F2") {
        event.preventDefault();
        event.stopPropagation();
        beginRename(threadRef, thread.title);
        return;
      }
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      navigateToThread(threadRef);
    },
    [beginRename, navigateToThread, thread.title, threadRef],
  );
  const handleRowContextMenu = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      const hasSelection = useThreadSelectionStore.getState().hasSelection();
      if (hasSelection && isSelected) {
        void handleMultiSelectContextMenu({
          x: event.clientX,
          y: event.clientY,
        });
        return;
      }

      if (hasSelection) {
        clearSelection();
      }
      void handleThreadContextMenu(threadRef, {
        x: event.clientX,
        y: event.clientY,
      });
    },
    [clearSelection, handleMultiSelectContextMenu, handleThreadContextMenu, isSelected, threadRef],
  );
  const handlePrClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      if (!prStatus) return;
      openPrLink(event, prStatus.url);
    },
    [openPrLink, prStatus],
  );
  const handleRenameInputRef = useCallback(
    (element: HTMLInputElement | null) => {
      if (element && renamingInputRef.current !== element) {
        renamingInputRef.current = element;
        element.focus();
        element.select();
      }
    },
    [renamingInputRef],
  );
  const handleRenameInputChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      setRenamingTitle(event.target.value);
    },
    [setRenamingTitle],
  );
  const handleRenameInputKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      event.stopPropagation();
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (event.key === "Enter") {
        event.preventDefault();
        renamingCommittedRef.current = true;
        void commitRename(threadRef, renamingTitle, thread.title);
      } else if (event.key === "Escape") {
        event.preventDefault();
        renamingCommittedRef.current = true;
        cancelRename();
      }
    },
    [cancelRename, commitRename, renamingCommittedRef, renamingTitle, thread.title, threadRef],
  );
  const handleRenameInputBlur = useCallback(() => {
    if (!renamingCommittedRef.current) {
      void commitRename(threadRef, renamingTitle, thread.title);
    }
  }, [commitRename, renamingCommittedRef, renamingTitle, thread.title, threadRef]);
  const handleRenameInputClick = useCallback((event: React.MouseEvent<HTMLInputElement>) => {
    event.stopPropagation();
  }, []);
  const handleConfirmArchiveRef = useCallback(
    (element: HTMLButtonElement | null) => {
      if (element) {
        confirmArchiveButtonRefs.current.set(threadKey, element);
      } else {
        confirmArchiveButtonRefs.current.delete(threadKey);
      }
    },
    [confirmArchiveButtonRefs, threadKey],
  );
  const stopPropagationOnPointerDown = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      event.stopPropagation();
    },
    [],
  );
  const handleConfirmArchiveClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      clearConfirmingArchive();
      void attemptArchiveThread(threadRef);
    },
    [attemptArchiveThread, clearConfirmingArchive, threadRef],
  );
  const handleStartArchiveConfirmation = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      setConfirmingArchiveThreadKey(threadKey);
      requestAnimationFrame(() => {
        confirmArchiveButtonRefs.current.get(threadKey)?.focus();
      });
    },
    [confirmArchiveButtonRefs, setConfirmingArchiveThreadKey, threadKey],
  );
  const handleArchiveImmediateClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      void attemptArchiveThread(threadRef);
    },
    [attemptArchiveThread, threadRef],
  );
  const rowButtonRender = useMemo(() => <div role="button" tabIndex={0} />, []);

  return (
    <SidebarMenuSubItem
      className="w-full"
      data-thread-item
      onMouseLeave={handleMouseLeave}
      onBlurCapture={handleBlurCapture}
    >
      <SidebarMenuSubButton
        render={rowButtonRender}
        size="sm"
        isActive={isActive}
        data-thread-selected={isSelected ? "true" : undefined}
        data-testid={`thread-row-${thread.id}`}
        className={`${resolveThreadRowClassName({
          isActive,
          isSelected,
        })} relative isolate`}
        onClick={handleRowClick}
        onKeyDown={handleRowKeyDown}
        onContextMenu={handleRowContextMenu}
      >
        <div className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
          {prStatus && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label={prStatus.tooltip}
                    className={`inline-flex items-center justify-center ${prStatus.colorClass} cursor-pointer rounded-sm outline-hidden focus-visible:ring-1 focus-visible:ring-ring`}
                    onClick={handlePrClick}
                  >
                    <ChangeRequestStatusIcon className="size-3" />
                  </button>
                }
              />
              <TooltipPopup side="top">{prStatus.tooltip}</TooltipPopup>
            </Tooltip>
          )}
          <ThreadStatusLabel status={threadStatus} />
          {renamingThreadKey === threadKey ? (
            <input
              ref={handleRenameInputRef}
              aria-label={uiText("Chat title", undefined, undefined, uiLocale)}
              className="min-w-0 flex-1 truncate rounded-sm border border-ring bg-transparent px-0.5 text-base outline-none sm:text-ui"
              value={renamingTitle}
              onChange={handleRenameInputChange}
              onKeyDown={handleRenameInputKeyDown}
              onBlur={handleRenameInputBlur}
              onClick={handleRenameInputClick}
            />
          ) : (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    className="min-w-0 flex-1 truncate text-ui"
                    data-testid={`thread-title-${thread.id}`}
                  >
                    {thread.title}
                  </span>
                }
              />
              <TooltipPopup side="top" className="max-w-80 whitespace-normal leading-tight">
                {thread.title}
              </TooltipPopup>
            </Tooltip>
          )}
        </div>
        {/* Keep row actions in one trailing cluster. The metadata reserves
            its normal width underneath, so revealing actions cannot move the
            title or leave the rename button stranded before the timestamp. */}
        <div className="ml-auto flex min-w-12 shrink-0 justify-end max-md:min-w-20 pointer-coarse:min-w-20">
          <div className="pointer-events-none absolute top-1/2 right-1 flex -translate-y-1/2 items-center gap-1 opacity-0 transition-opacity duration-150 max-md:pointer-events-auto max-md:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100 group-hover/menu-sub-item:pointer-events-auto group-hover/menu-sub-item:opacity-100 group-focus-within/menu-sub-item:pointer-events-auto group-focus-within/menu-sub-item:opacity-100">
            {renamingThreadKey !== threadKey && !isConfirmingArchive ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    // The button stays a direct child of the action cluster;
                    // its own pointerdown guard still keeps row selection out.
                    <button
                      type="button"
                      data-thread-selection-safe
                      aria-label={uiText(
                        "Rename {value0}",
                        { value0: thread.title },
                        undefined,
                        uiLocale,
                      )}
                      className="inline-flex size-5 shrink-0 items-center justify-center rounded-sm text-subtle-foreground transition-colors duration-(--duration-fast) hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring max-md:size-8 pointer-coarse:size-8"
                      onPointerDown={stopPropagationOnPointerDown}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        beginRename(threadRef, thread.title);
                      }}
                    >
                      <PencilIcon className="size-3" />
                    </button>
                  }
                />
                <TooltipPopup side="top">
                  {uiText("Rename (F2)", undefined, undefined, uiLocale)}
                </TooltipPopup>
              </Tooltip>
            ) : null}
            {isConfirmingArchive ? (
              <button
                ref={handleConfirmArchiveRef}
                type="button"
                data-thread-selection-safe
                data-testid={`thread-archive-confirm-${thread.id}`}
                aria-label={uiText(
                  "Confirm archive {value0}",
                  { value0: thread.title },
                  undefined,
                  uiLocale,
                )}
                className="inline-flex h-5 cursor-pointer items-center rounded-full bg-destructive/12 px-2 text-2xs font-medium text-destructive-foreground transition-colors duration-(--duration-fast) hover:bg-destructive/18 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-destructive/40"
                onPointerDown={stopPropagationOnPointerDown}
                onClick={handleConfirmArchiveClick}
              >
                {uiText("Confirm", undefined, undefined, uiLocale)}
              </button>
            ) : !isThreadRunning ? (
              appSettingsConfirmThreadArchive ? (
                <button
                  type="button"
                  data-thread-selection-safe
                  data-testid={`thread-archive-${thread.id}`}
                  aria-label={uiText(
                    "Archive {value0}",
                    { value0: thread.title },
                    undefined,
                    uiLocale,
                  )}
                  className="inline-flex size-5 cursor-pointer items-center justify-center rounded-sm text-subtle-foreground transition-colors duration-(--duration-fast) hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring max-md:size-8 pointer-coarse:size-8"
                  onPointerDown={stopPropagationOnPointerDown}
                  onClick={handleStartArchiveConfirmation}
                >
                  <ArchiveIcon className="size-3.5" />
                </button>
              ) : (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      // Preserve the existing separation between tooltip
                      // pointer handlers and the archive action's click handler.
                      <span className="inline-flex shrink-0">
                        <button
                          type="button"
                          data-thread-selection-safe
                          data-testid={`thread-archive-${thread.id}`}
                          aria-label={uiText(
                            "Archive {value0}",
                            { value0: thread.title },
                            undefined,
                            uiLocale,
                          )}
                          className="inline-flex size-5 cursor-pointer items-center justify-center rounded-sm text-subtle-foreground transition-colors duration-(--duration-fast) hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring max-md:size-8 pointer-coarse:size-8"
                          onPointerDown={stopPropagationOnPointerDown}
                          onClick={handleArchiveImmediateClick}
                        >
                          <ArchiveIcon className="size-3.5" />
                        </button>
                      </span>
                    }
                  />
                  <TooltipPopup side="top">
                    {uiText("Archive", undefined, undefined, uiLocale)}
                  </TooltipPopup>
                </Tooltip>
              )
            ) : null}
          </div>
          <span className={threadMetaClassName}>
            {jumpLabel ? (
              <span className="inline-flex h-5 items-center rounded-full border border-border bg-background px-1.5 font-mono text-2xs font-medium tracking-tight text-foreground shadow-sm">
                {jumpLabel}
              </span>
            ) : (
              <span
                className={`text-2xs tabular-nums ${
                  isHighlighted ? "text-muted-foreground" : "text-subtle-foreground"
                }`}
              >
                {uiPresentation.formatRelativeTimeLabel(
                  thread.latestUserMessageAt ?? thread.updatedAt ?? thread.createdAt,
                )}
              </span>
            )}
          </span>
        </div>
      </SidebarMenuSubButton>
    </SidebarMenuSubItem>
  );
});

/**
 * Projectless saved chats share Projects' canonical row and mutation controls.
 * Local drafts stay in the composer/Desk until first send creates a canonical
 * thread. Closing a tab remains view-only.
 * This component intentionally receives shell metadata, not full chat history.
 */
export const SidebarStandaloneChats = memo(function SidebarStandaloneChats({
  entries,
  previewCount,
  expanded,
  activeTarget,
  jumpLabelByKey,
  onOpen,
  onExpansionChange,
  onNewChat,
  newChatDisabled = false,
}: {
  entries: readonly StandaloneCatalogEntry[];
  previewCount: number;
  expanded: boolean;
  activeTarget: ThreadRouteTarget | null;
  jumpLabelByKey: ReadonlyMap<string, string>;
  onOpen: (target: ThreadRouteTarget, preview?: boolean) => void;
  onExpansionChange: (expanded: boolean) => void;
  onNewChat: () => void;
  newChatDisabled?: boolean;
}) {
  const uiLocale = useUiLocale();
  const uiPresentation = useUiPresentation(UI_PRESENTATION_SOURCES);

  const [renamingThreadKey, setRenamingThreadKey] = useState<string | null>(null);
  const [renamingTitle, setRenamingTitle] = useState("");
  const [confirmingArchiveThreadKey, setConfirmingArchiveThreadKey] = useState<string | null>(null);
  const renamingInputRef = useRef<HTMLInputElement | null>(null);
  const renamingCommittedRef = useRef(false);
  const confirmArchiveButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const { archiveThread, deleteThread, confirmAndDeleteThread, duplicateThread } =
    useThreadActions();
  const deletingThreadKeysRef = useRef(new Set<string>());
  const isMobile = useIsMobile();
  const archiveRequiresConfirmation =
    useSettings((settings) => settings.confirmThreadArchive) || isMobile;
  const confirmThreadDelete = useSettings((settings) => settings.confirmThreadDelete);
  const clearSelection = useThreadSelectionStore((state) => state.clearSelection);
  const toggleSelection = useThreadSelectionStore((state) => state.toggleThread);
  const rangeSelectTo = useThreadSelectionStore((state) => state.rangeSelectTo);
  const removeFromSelection = useThreadSelectionStore((state) => state.removeFromSelection);
  const orderedKeys = useMemo(() => entries.map((entry) => entry.key), [entries]);
  const rowsByKey = useMemo(
    () => new Map(entries.map((entry) => [entry.key, entry.thread])),
    [entries],
  );
  const rowsByKeyRef = useRef(rowsByKey);
  rowsByKeyRef.current = rowsByKey;
  const visibleEntries = expanded ? entries : entries.slice(0, previewCount);
  const hiddenEntryCount = Math.max(0, entries.length - previewCount);
  // Visible rows resolve their own status. Subscribe only to the hidden rows'
  // visit cursors so the collapsed toggle can summarize what it hides.
  const hiddenLastVisitedAts = useUiStateStore(
    useShallow((state) =>
      expanded
        ? []
        : entries
            .slice(previewCount)
            .map((entry) => state.threadLastVisitedAtById[entry.key] ?? null),
    ),
  );
  const standaloneEnvironmentIds = useMemo(
    () => [...new Set(entries.map((entry) => entry.thread.environmentId))],
    [entries],
  );
  const scheduledPresence = useScheduledFollowupPresenceByEnvironment(standaloneEnvironmentIds);
  const hiddenSummary = useMemo(
    () =>
      expanded
        ? null
        : uiPresentation.summarizeHiddenThreadStatuses(
            entries.slice(previewCount).map((entry, index) => {
              const lastVisitedAt = hiddenLastVisitedAts[index];
              return resolveThreadStatusPill({
                thread: {
                  ...entry.thread,
                  ...(lastVisitedAt !== null && lastVisitedAt !== undefined
                    ? { lastVisitedAt }
                    : {}),
                  scheduledFollowUpAt: readScheduledFollowUpAtFrom(
                    scheduledPresence,
                    entry.thread.environmentId,
                    entry.thread.id,
                  ),
                },
              });
            }),
          ),
    [entries, expanded, hiddenLastVisitedAts, previewCount, scheduledPresence, uiPresentation],
  );
  const cancelRename = useCallback(() => {
    setRenamingThreadKey(null);
    renamingInputRef.current = null;
  }, []);
  const beginRename = useCallback((threadRef: ScopedThreadRef, title: string) => {
    setRenamingThreadKey(scopedThreadKey(threadRef));
    setRenamingTitle(title);
    renamingCommittedRef.current = false;
  }, []);
  const commitRename = useCallback(
    async (threadRef: ScopedThreadRef, title: string, originalTitle: string) => {
      const key = scopedThreadKey(threadRef);
      renamingCommittedRef.current = true;
      try {
        await renameThread(threadRef, title, originalTitle);
      } catch {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: uiText("Could not rename chat", undefined, undefined, uiLocale),
            description: uiText(
              "Check the chat title and reconnect to its environment before trying again.",
              undefined,
              undefined,
              uiLocale,
            ),
          }),
        );
      } finally {
        setRenamingThreadKey((current) => (current === key ? null : current));
      }
    },
    [uiLocale],
  );
  const attemptArchiveThread = useCallback(
    async (threadRef: ScopedThreadRef) => {
      try {
        await archiveThread(threadRef);
        removeFromSelection([scopedThreadKey(threadRef)]);
      } catch {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: uiText("Could not archive chat", undefined, undefined, uiLocale),
            description: uiText(
              "Reconnect to the chat''s environment before trying again.",
              undefined,
              undefined,
              uiLocale,
            ),
          }),
        );
      }
    },
    [archiveThread, removeFromSelection, uiLocale],
  );
  const navigateToThread = useCallback(
    (threadRef: ScopedThreadRef) => onOpen({ kind: "server", threadRef }),
    [onOpen],
  );
  const attemptDeleteThread = useCallback(
    async (threadRef: ScopedThreadRef) => {
      const key = scopedThreadKey(threadRef);
      if (deletingThreadKeysRef.current.has(key)) return;
      deletingThreadKeysRef.current.add(key);
      try {
        await confirmAndDeleteThread(threadRef);
      } catch {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: uiText("Could not delete chat", undefined, undefined, uiLocale),
            description: uiText(
              "Reconnect to the chat''s environment before trying again.",
              undefined,
              undefined,
              uiLocale,
            ),
          }),
        );
      } finally {
        deletingThreadKeysRef.current.delete(key);
      }
    },
    [confirmAndDeleteThread, uiLocale],
  );
  const handleThreadClick = useCallback(
    (event: React.MouseEvent, threadRef: ScopedThreadRef, keys: readonly string[]) => {
      const key = scopedThreadKey(threadRef);
      if (isMacPlatform(navigator.platform) ? event.metaKey : event.ctrlKey) {
        event.preventDefault();
        toggleSelection(key);
      } else if (event.shiftKey) {
        event.preventDefault();
        rangeSelectTo(key, keys);
      } else {
        onOpen({ kind: "server", threadRef }, event.detail < 2);
      }
    },
    [onOpen, rangeSelectTo, toggleSelection],
  );
  const handleThreadContextMenu = useCallback(
    async (threadRef: ScopedThreadRef, position: { x: number; y: number }) => {
      const api = readLocalApi();
      const thread = rowsByKey.get(scopedThreadKey(threadRef));
      if (!api || !thread) return;
      const running = thread.session?.status === "running" && thread.session.activeTurnId != null;
      const duplicateAvailable =
        canDuplicateThread(thread) && !isThreadDuplicationPending(threadRef);
      const action = await api.contextMenu.show(
        [
          { id: "rename", label: uiText("Rename", undefined, undefined, uiLocale) },
          {
            id: "duplicate",
            label: uiText("Duplicate chat", undefined, undefined, uiLocale),
            disabled: !duplicateAvailable,
          },
          {
            id: "archive",
            label: uiText("Archive", undefined, undefined, uiLocale),
            disabled: running,
          },
          {
            id: "delete",
            label: uiText("Move to Recycle Bin", undefined, undefined, uiLocale),
            destructive: true,
          },
        ],
        position,
      );
      if (action === "rename") beginRename(threadRef, thread.title);
      else if (
        action === "duplicate" &&
        duplicateAvailable &&
        canDuplicateThread(rowsByKeyRef.current.get(scopedThreadKey(threadRef)))
      )
        await duplicateThread(threadRef);
      else if (action === "archive" && !running) {
        if (archiveRequiresConfirmation) {
          setConfirmingArchiveThreadKey(scopedThreadKey(threadRef));
          requestAnimationFrame(() =>
            confirmArchiveButtonRefs.current.get(scopedThreadKey(threadRef))?.focus(),
          );
        } else await attemptArchiveThread(threadRef);
      } else if (action === "delete") {
        await attemptDeleteThread(threadRef);
      }
    },
    [
      archiveRequiresConfirmation,
      attemptArchiveThread,
      attemptDeleteThread,
      beginRename,
      duplicateThread,
      rowsByKey,
      uiLocale,
    ],
  );
  const handleMultiSelectContextMenu = useCallback(
    async (position: { x: number; y: number }) => {
      const api = readLocalApi();
      if (!api) return;
      // Resolve opaque scoped keys through the current shell catalog, never by
      // splitting untrusted ids or guessing an environment/project association.
      const keys = [...useThreadSelectionStore.getState().selectedThreadKeys].filter((key) =>
        rowsByKey.has(key),
      );
      if (keys.length === 0) return;
      const action = await api.contextMenu.show(
        [
          {
            id: "delete",
            label: uiText(
              "Move to Recycle Bin ({value0})",
              { value0: keys.length },
              undefined,
              uiLocale,
            ),
            destructive: true,
          },
        ],
        position,
      );
      if (action !== "delete") return;
      if (
        confirmThreadDelete &&
        !(await api.dialogs.confirm(
          uiText(
            "Move {count} {count, plural, one {chat} other {chats}} to the Recycle Bin?\nYou can review them later in Settings '>' Recently Deleted.",
            { count: keys.length },
            undefined,
            uiLocale,
          ),
        ))
      )
        return;
      try {
        const deletedThreadKeys = new Set(keys);
        for (const key of keys) {
          const thread = rowsByKey.get(key);
          if (thread)
            await deleteThread(scopeThreadRef(thread.environmentId, thread.id), {
              deletedThreadKeys,
            });
        }
        removeFromSelection(keys);
      } catch {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: uiText("Could not delete selected chats", undefined, undefined, uiLocale),
            description: uiText(
              "Some chats may remain. Reconnect before trying again.",
              undefined,
              undefined,
              uiLocale,
            ),
          }),
        );
      }
    },
    [confirmThreadDelete, deleteThread, removeFromSelection, rowsByKey, uiLocale],
  );
  // Same list motion as project chat lists (docs/style-guide.md §8).
  const animatedListRef = useRef<HTMLElement | null>(null);
  const attachListAutoAnimate = useCallback((node: HTMLElement | null) => {
    if (!node || animatedListRef.current === node) return;
    autoAnimate(node, SIDEBAR_LIST_ANIMATION_OPTIONS);
    animatedListRef.current = node;
  }, []);
  // Standalone chats have no workspace PR action. Supplying this boundary to
  // the shared row keeps accidental imported branch data from launching links.
  const ignorePrLink = useCallback((event: React.MouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
  }, []);

  return (
    <SidebarGroup
      aria-label={uiText("Standalone chats", undefined, undefined, uiLocale)}
      className="px-2 pt-2 pb-1"
    >
      <div className="mb-1 flex items-center justify-between pl-2 pr-1.5">
        <span className="label-overline">{uiText("Chats", undefined, undefined, uiLocale)}</span>
        <SidebarNewChatButton disabled={newChatDisabled} onClick={onNewChat} />
      </div>
      <SidebarMenuSub
        ref={attachListAutoAnimate}
        className="mx-1 my-0 w-full translate-x-0 gap-0.5 overflow-hidden px-1.5 py-0"
      >
        {visibleEntries.map((entry) => (
          <SidebarThreadRow
            key={JSON.stringify(["server", entry.thread.environmentId, entry.thread.id])}
            thread={entry.thread}
            projectCwd={null}
            orderedProjectThreadKeys={orderedKeys}
            isActive={
              activeTarget?.kind === "server" &&
              scopedThreadKey(activeTarget.threadRef) === entry.key
            }
            jumpLabel={jumpLabelByKey.get(entry.key) ?? null}
            appSettingsConfirmThreadArchive={archiveRequiresConfirmation}
            renamingThreadKey={renamingThreadKey}
            renamingTitle={renamingTitle}
            setRenamingTitle={setRenamingTitle}
            renamingInputRef={renamingInputRef}
            renamingCommittedRef={renamingCommittedRef}
            confirmingArchiveThreadKey={confirmingArchiveThreadKey}
            setConfirmingArchiveThreadKey={setConfirmingArchiveThreadKey}
            confirmArchiveButtonRefs={confirmArchiveButtonRefs}
            handleThreadClick={handleThreadClick}
            navigateToThread={navigateToThread}
            handleMultiSelectContextMenu={handleMultiSelectContextMenu}
            handleThreadContextMenu={handleThreadContextMenu}
            clearSelection={clearSelection}
            commitRename={commitRename}
            cancelRename={cancelRename}
            beginRename={beginRename}
            attemptArchiveThread={attemptArchiveThread}
            openPrLink={ignorePrLink}
          />
        ))}
        {hiddenEntryCount > 0 ? (
          <SidebarThreadOverflowToggle
            expanded={expanded}
            hiddenCount={hiddenEntryCount}
            hiddenSummary={hiddenSummary}
            onToggle={() => onExpansionChange(!expanded)}
          />
        ) : null}
      </SidebarMenuSub>
      {entries.length === 0 ? (
        <p className="px-3 py-1 text-xs text-subtle-foreground">
          {uiText("No chats yet", undefined, undefined, uiLocale)}
        </p>
      ) : null}
    </SidebarGroup>
  );
});

interface SidebarProjectThreadListProps {
  projectKey: string;
  projectExpanded: boolean;
  hasOverflowingThreads: boolean;
  hiddenThreadCount: number;
  hiddenThreadSummary: HiddenThreadStatusSummary | null;
  orderedProjectThreadKeys: readonly string[];
  renderedThreads: readonly SidebarThreadSummary[];
  showEmptyThreadState: boolean;
  shouldShowThreadPanel: boolean;
  isThreadListExpanded: boolean;
  projectCwd: string;
  activeRouteThreadKey: string | null;
  threadJumpLabelByKey: ReadonlyMap<string, string>;
  appSettingsConfirmThreadArchive: boolean;
  renamingThreadKey: string | null;
  renamingTitle: string;
  setRenamingTitle: (title: string) => void;
  renamingInputRef: React.RefObject<HTMLInputElement | null>;
  renamingCommittedRef: React.RefObject<boolean>;
  confirmingArchiveThreadKey: string | null;
  setConfirmingArchiveThreadKey: React.Dispatch<React.SetStateAction<string | null>>;
  confirmArchiveButtonRefs: React.RefObject<Map<string, HTMLButtonElement>>;
  attachThreadListAutoAnimateRef: (node: HTMLElement | null) => void;
  handleThreadClick: (
    event: React.MouseEvent,
    threadRef: ScopedThreadRef,
    orderedProjectThreadKeys: readonly string[],
  ) => void;
  navigateToThread: (threadRef: ScopedThreadRef) => void;
  handleMultiSelectContextMenu: (position: { x: number; y: number }) => Promise<void>;
  handleThreadContextMenu: (
    threadRef: ScopedThreadRef,
    position: { x: number; y: number },
  ) => Promise<void>;
  clearSelection: () => void;
  commitRename: (
    threadRef: ScopedThreadRef,
    newTitle: string,
    originalTitle: string,
  ) => Promise<void>;
  cancelRename: () => void;
  beginRename: (threadRef: ScopedThreadRef, title: string) => void;
  attemptArchiveThread: (threadRef: ScopedThreadRef) => Promise<void>;
  openPrLink: (event: React.MouseEvent<HTMLElement>, prUrl: string) => void;
  expandThreadListForProject: (projectKey: string) => void;
  collapseThreadListForProject: (projectKey: string) => void;
}

const SidebarProjectThreadList = memo(function SidebarProjectThreadList(
  props: SidebarProjectThreadListProps,
) {
  const uiLocale = useUiLocale();

  const {
    projectKey,
    projectExpanded,
    hasOverflowingThreads,
    hiddenThreadCount,
    hiddenThreadSummary,
    orderedProjectThreadKeys,
    renderedThreads,
    showEmptyThreadState,
    shouldShowThreadPanel,
    isThreadListExpanded,
    projectCwd,
    activeRouteThreadKey,
    threadJumpLabelByKey,
    appSettingsConfirmThreadArchive,
    renamingThreadKey,
    renamingTitle,
    setRenamingTitle,
    renamingInputRef,
    renamingCommittedRef,
    confirmingArchiveThreadKey,
    setConfirmingArchiveThreadKey,
    confirmArchiveButtonRefs,
    attachThreadListAutoAnimateRef,
    handleThreadClick,
    navigateToThread,
    handleMultiSelectContextMenu,
    handleThreadContextMenu,
    clearSelection,
    commitRename,
    cancelRename,
    beginRename,
    attemptArchiveThread,
    openPrLink,
    expandThreadListForProject,
    collapseThreadListForProject,
  } = props;

  return (
    <SidebarMenuSub
      ref={attachThreadListAutoAnimateRef}
      className="mx-1 my-0 w-full translate-x-0 gap-0.5 overflow-hidden px-1.5 py-0"
    >
      {shouldShowThreadPanel && showEmptyThreadState ? (
        <SidebarMenuSubItem className="w-full" data-thread-selection-safe>
          <div
            data-thread-selection-safe
            data-testid="sidebar-project-empty-chats"
            className="flex h-7 w-full translate-x-0 items-center px-2 text-left text-xs text-subtle-foreground"
          >
            <span>{uiText("No chats yet", undefined, undefined, uiLocale)}</span>
          </div>
        </SidebarMenuSubItem>
      ) : null}
      {shouldShowThreadPanel &&
        renderedThreads.map((thread) => {
          const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
          return (
            <SidebarThreadRow
              key={threadKey}
              thread={thread}
              projectCwd={projectCwd}
              orderedProjectThreadKeys={orderedProjectThreadKeys}
              isActive={activeRouteThreadKey === threadKey}
              jumpLabel={threadJumpLabelByKey.get(threadKey) ?? null}
              appSettingsConfirmThreadArchive={appSettingsConfirmThreadArchive}
              renamingThreadKey={renamingThreadKey}
              renamingTitle={renamingTitle}
              setRenamingTitle={setRenamingTitle}
              renamingInputRef={renamingInputRef}
              renamingCommittedRef={renamingCommittedRef}
              confirmingArchiveThreadKey={confirmingArchiveThreadKey}
              setConfirmingArchiveThreadKey={setConfirmingArchiveThreadKey}
              confirmArchiveButtonRefs={confirmArchiveButtonRefs}
              handleThreadClick={handleThreadClick}
              navigateToThread={navigateToThread}
              handleMultiSelectContextMenu={handleMultiSelectContextMenu}
              handleThreadContextMenu={handleThreadContextMenu}
              clearSelection={clearSelection}
              commitRename={commitRename}
              cancelRename={cancelRename}
              beginRename={beginRename}
              attemptArchiveThread={attemptArchiveThread}
              openPrLink={openPrLink}
            />
          );
        })}

      {projectExpanded && hasOverflowingThreads ? (
        <SidebarThreadOverflowToggle
          expanded={isThreadListExpanded}
          hiddenCount={hiddenThreadCount}
          hiddenSummary={hiddenThreadSummary}
          onToggle={() => {
            if (isThreadListExpanded) {
              collapseThreadListForProject(projectKey);
            } else {
              expandThreadListForProject(projectKey);
            }
          }}
        />
      ) : null}
    </SidebarMenuSub>
  );
});

interface SidebarProjectItemProps {
  project: SidebarProjectSnapshot;
  bootstrappedEnvironmentIds: ReadonlySet<string>;
  desktopDebugEnabled: boolean;
  isThreadListExpanded: boolean;
  activeRouteThreadKey: string | null;
  newThreadShortcutLabel: string | null;
  handleNewThread: ReturnType<typeof useNewThreadHandler>["handleNewThread"];
  archiveThread: ReturnType<typeof useThreadActions>["archiveThread"];
  deleteThread: ReturnType<typeof useThreadActions>["deleteThread"];
  duplicateThread: ReturnType<typeof useThreadActions>["duplicateThread"];
  threadJumpLabelByKey: ReadonlyMap<string, string>;
  attachThreadListAutoAnimateRef: (node: HTMLElement | null) => void;
  expandThreadListForProject: (projectKey: string) => void;
  collapseThreadListForProject: (projectKey: string) => void;
  dragInProgressRef: React.RefObject<boolean>;
  suppressProjectClickAfterDragRef: React.RefObject<boolean>;
  suppressProjectClickForContextMenuRef: React.RefObject<boolean>;
  isManualProjectSorting: boolean;
  dragHandleProps: SortableProjectHandleProps | null;
}

const SidebarProjectItem = memo(function SidebarProjectItem(props: SidebarProjectItemProps) {
  const uiLocale = useUiLocale();
  const uiPresentation = useUiPresentation(UI_PRESENTATION_SOURCES);

  const {
    project,
    bootstrappedEnvironmentIds,
    desktopDebugEnabled,
    isThreadListExpanded,
    activeRouteThreadKey,
    newThreadShortcutLabel,
    handleNewThread,
    archiveThread,
    deleteThread,
    duplicateThread,
    threadJumpLabelByKey,
    attachThreadListAutoAnimateRef,
    expandThreadListForProject,
    collapseThreadListForProject,
    dragInProgressRef,
    suppressProjectClickAfterDragRef,
    suppressProjectClickForContextMenuRef,
    isManualProjectSorting,
    dragHandleProps,
  } = props;
  const threadSortOrder = useSettings<SidebarThreadSortOrder>(
    (settings) => settings.sidebarThreadSortOrder,
  );
  const appSettingsConfirmThreadDelete = useSettings<boolean>(
    (settings) => settings.confirmThreadDelete,
  );
  const confirmThreadArchiveSetting = useSettings<boolean>(
    (settings) => settings.confirmThreadArchive,
  );
  // On mobile the archive action is always visible (no hover to reveal it) and
  // sits near the screen edge, so it is easy to mis-tap. Always require the
  // two-step "tap archive -> tap Confirm" flow on mobile, regardless of the
  // user's confirm-archive setting. Desktop keeps the setting-driven behavior.
  const archiveRequiresConfirmation = useIsMobile();
  const appSettingsConfirmThreadArchive =
    confirmThreadArchiveSetting || archiveRequiresConfirmation;
  const defaultThreadEnvMode = useSettings<ThreadEnvMode>(
    (settings) => settings.defaultThreadEnvMode,
  );
  const projectGroupingSettings = useSettings(selectProjectGroupingSettings);
  const { updateSettings } = useUpdateSettings();
  const sidebarThreadPreviewCount = useSettings<SidebarThreadPreviewCount>(
    (settings) => settings.sidebarThreadPreviewCount,
  );
  const router = useRouter();
  const { isMobile, setOpenMobile } = useSidebar();
  const toggleProject = useUiStateStore((state) => state.toggleProject);
  const toggleThreadSelection = useThreadSelectionStore((state) => state.toggleThread);
  const rangeSelectTo = useThreadSelectionStore((state) => state.rangeSelectTo);
  const clearSelection = useThreadSelectionStore((state) => state.clearSelection);
  const removeFromSelection = useThreadSelectionStore((state) => state.removeFromSelection);
  const setSelectionAnchor = useThreadSelectionStore((state) => state.setAnchor);
  // Copying from a native context menu has no inline anchor for a "copied"
  // confirmation, and a success toast for a trivial action is noise
  // (docs/style-guide.md §10). Only failures are reported.
  const { copyToClipboard: copyThreadIdToClipboard } = useCopyToClipboard<{
    threadId: ThreadId;
  }>({
    onError: (error) => {
      console.warn("Failed to copy chat ID", { error });
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: uiText("Could not copy chat ID", undefined, undefined, uiLocale),
        }),
      );
    },
  });
  const { copyToClipboard: copyPathToClipboard } = useCopyToClipboard<{
    path: string;
  }>({
    onError: (error) => {
      console.warn("Failed to copy path", { error });
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: uiText("Could not copy path", undefined, undefined, uiLocale),
        }),
      );
    },
  });
  const openPrLink = useCallback(
    (event: React.MouseEvent<HTMLElement>, prUrl: string) => {
      event.preventDefault();
      event.stopPropagation();

      const api = readLocalApi();
      if (!api) {
        toastManager.add({
          type: "error",
          title: uiText("Links can''t be opened here", undefined, undefined, uiLocale),
        });
        return;
      }

      void api.shell.openExternal(prUrl).catch((error) => {
        console.warn("Failed to open pull request link", { error });
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: uiText("Could not open pull request link", undefined, undefined, uiLocale),
          }),
        );
      });
    },
    [uiLocale],
  );
  const sidebarThreads = useStore(
    useShallow(
      useMemo(
        () => (state: import("../store").AppState) =>
          selectSidebarThreadsForProjectRefs(state, project.memberProjectRefs),
        [project.memberProjectRefs],
      ),
    ),
  );
  const allProjects = useWorkspaceProjects();
  const sidebarThreadByKey = useMemo(
    () =>
      new Map(
        sidebarThreads.map(
          (thread) =>
            [scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)), thread] as const,
        ),
      ),
    [sidebarThreads],
  );
  // Keep a ref so callbacks can read the latest map without appearing in
  // dependency arrays (avoids invalidating every thread-row memo on each
  // thread-list change).
  const sidebarThreadByKeyRef = useRef(sidebarThreadByKey);
  sidebarThreadByKeyRef.current = sidebarThreadByKey;
  const projectThreads = sidebarThreads;
  const projectEnvironmentIds = useMemo(
    () => project.memberProjects.map((member) => member.environmentId),
    [project.memberProjects],
  );
  const scheduledPresence = useScheduledFollowupPresenceByEnvironment(projectEnvironmentIds);
  const projectExpanded = useUiStateStore(
    (state) => state.projectExpandedById[project.projectKey] ?? true,
  );
  const threadLastVisitedAts = useUiStateStore(
    useShallow((state) =>
      projectThreads.map(
        (thread) =>
          state.threadLastVisitedAtById[
            scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))
          ] ?? null,
      ),
    ),
  );
  const [renamingThreadKey, setRenamingThreadKey] = useState<string | null>(null);
  const [renamingTitle, setRenamingTitle] = useState("");
  const [confirmingArchiveThreadKey, setConfirmingArchiveThreadKey] = useState<string | null>(null);
  const [projectRenameTarget, setProjectRenameTarget] = useState<SidebarProjectGroupMember | null>(
    null,
  );
  const [projectRenameTitle, setProjectRenameTitle] = useState("");
  const [projectGroupingTarget, setProjectGroupingTarget] =
    useState<SidebarProjectGroupMember | null>(null);
  const [projectGroupingSelection, setProjectGroupingSelection] = useState<
    SidebarProjectGroupingMode | "inherit"
  >("inherit");
  const [additionalDirectoriesTarget, setAdditionalDirectoriesTarget] =
    useState<SidebarProjectGroupMember | null>(null);
  const [additionalDirectoriesDraft, setAdditionalDirectoriesDraft] = useState<string[]>([]);
  const [additionalDirectoryInput, setAdditionalDirectoryInput] = useState("");
  const [additionalDirectoriesError, setAdditionalDirectoriesError] = useState<string | null>(null);
  const [additionalDirectoriesSubmitting, setAdditionalDirectoriesSubmitting] = useState(false);
  const [threadMoveTarget, setThreadMoveTarget] = useState<SidebarThreadSummary | null>(null);
  const [threadMoveProjectId, setThreadMoveProjectId] = useState<ProjectId | null>(null);
  const [threadMoveSubmitting, setThreadMoveSubmitting] = useState(false);
  const [threadRepairDialog, setThreadRepairDialog] = useState<ThreadRepairDialogState | null>(
    null,
  );
  const renamingCommittedRef = useRef(false);
  const renamingInputRef = useRef<HTMLInputElement | null>(null);
  const confirmArchiveButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const memberProjectByScopedKey = useMemo(
    () =>
      new Map(
        project.memberProjects.map((member) => [
          scopedProjectKey(scopeProjectRef(member.environmentId, member.id)),
          member,
        ]),
      ),
    [project.memberProjects],
  );
  const memberThreadCountByPhysicalKey = useMemo(() => {
    const counts = new Map<string, number>(
      project.memberProjects.map((member) => [member.physicalProjectKey, 0] as const),
    );
    for (const thread of projectThreads) {
      if (thread.projectId === null) continue;
      const member = memberProjectByScopedKey.get(
        scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)),
      );
      if (!member) {
        continue;
      }
      counts.set(member.physicalProjectKey, (counts.get(member.physicalProjectKey) ?? 0) + 1);
    }
    return counts;
  }, [memberProjectByScopedKey, project.memberProjects, projectThreads]);
  const projectBootstrapComplete = useMemo(
    () =>
      project.memberProjects.every((member) =>
        bootstrappedEnvironmentIds.has(member.environmentId),
      ),
    [bootstrappedEnvironmentIds, project.memberProjects],
  );

  const { projectStatus, visibleProjectThreads, orderedProjectThreadKeys } = useMemo(() => {
    const lastVisitedAtByThreadKey = new Map(
      projectThreads.map((thread, index) => [
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
        threadLastVisitedAts[index] ?? null,
      ]),
    );
    const resolveProjectThreadStatus = (thread: SidebarThreadSummary) => {
      const lastVisitedAt = lastVisitedAtByThreadKey.get(
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      );
      return resolveThreadStatusPill({
        thread: {
          ...thread,
          ...(lastVisitedAt !== null && lastVisitedAt !== undefined ? { lastVisitedAt } : {}),
          scheduledFollowUpAt: readScheduledFollowUpAtFrom(
            scheduledPresence,
            thread.environmentId,
            thread.id,
          ),
        },
      });
    };
    const visibleProjectThreads = sortThreads(
      projectThreads.filter((thread) => thread.archivedAt === null),
      threadSortOrder,
    );
    const projectStatus = resolveProjectStatusIndicator(
      visibleProjectThreads.map((thread) => resolveProjectThreadStatus(thread)),
    );
    return {
      orderedProjectThreadKeys: visibleProjectThreads.map((thread) =>
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      ),
      projectStatus,
      visibleProjectThreads,
    };
  }, [projectThreads, scheduledPresence, threadLastVisitedAts, threadSortOrder]);

  const pinnedCollapsedThread = useMemo(() => {
    const activeThreadKey = activeRouteThreadKey ?? undefined;
    if (!activeThreadKey || projectExpanded) {
      return null;
    }
    return (
      visibleProjectThreads.find(
        (thread) =>
          scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) === activeThreadKey,
      ) ?? null
    );
  }, [activeRouteThreadKey, projectExpanded, visibleProjectThreads]);

  const {
    hasOverflowingThreads,
    hiddenThreadCount,
    hiddenThreadSummary,
    renderedThreads,
    showEmptyThreadState,
    shouldShowThreadPanel,
  } = useMemo(() => {
    const lastVisitedAtByThreadKey = new Map(
      projectThreads.map((thread, index) => [
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
        threadLastVisitedAts[index] ?? null,
      ]),
    );
    const resolveProjectThreadStatus = (thread: SidebarThreadSummary) => {
      const lastVisitedAt = lastVisitedAtByThreadKey.get(
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      );
      return resolveThreadStatusPill({
        thread: {
          ...thread,
          ...(lastVisitedAt !== null && lastVisitedAt !== undefined ? { lastVisitedAt } : {}),
          scheduledFollowUpAt: readScheduledFollowUpAtFrom(
            scheduledPresence,
            thread.environmentId,
            thread.id,
          ),
        },
      });
    };
    const hasOverflowingThreads = visibleProjectThreads.length > sidebarThreadPreviewCount;
    const previewThreads =
      isThreadListExpanded || !hasOverflowingThreads
        ? visibleProjectThreads
        : visibleProjectThreads.slice(0, sidebarThreadPreviewCount);
    const visibleThreadKeys = new Set(
      [...previewThreads, ...(pinnedCollapsedThread ? [pinnedCollapsedThread] : [])].map((thread) =>
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      ),
    );
    const renderedThreads = pinnedCollapsedThread
      ? [pinnedCollapsedThread]
      : visibleProjectThreads.filter((thread) =>
          visibleThreadKeys.has(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))),
        );
    const hiddenThreads = visibleProjectThreads.filter(
      (thread) =>
        !visibleThreadKeys.has(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))),
    );
    return {
      hasOverflowingThreads,
      hiddenThreadCount: Math.max(0, visibleProjectThreads.length - sidebarThreadPreviewCount),
      hiddenThreadSummary: uiPresentation.summarizeHiddenThreadStatuses(
        hiddenThreads.map((thread) => resolveProjectThreadStatus(thread)),
      ),
      renderedThreads,
      showEmptyThreadState:
        projectBootstrapComplete && projectExpanded && visibleProjectThreads.length === 0,
      shouldShowThreadPanel: projectExpanded || pinnedCollapsedThread !== null,
    };
  }, [
    isThreadListExpanded,
    pinnedCollapsedThread,
    projectBootstrapComplete,
    projectExpanded,
    projectThreads,
    scheduledPresence,
    sidebarThreadPreviewCount,
    threadLastVisitedAts,
    visibleProjectThreads,
    uiPresentation,
  ]);

  const handleProjectButtonClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      if (suppressProjectClickForContextMenuRef.current) {
        suppressProjectClickForContextMenuRef.current = false;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (dragInProgressRef.current) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (suppressProjectClickAfterDragRef.current) {
        suppressProjectClickAfterDragRef.current = false;
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (useThreadSelectionStore.getState().hasSelection()) {
        clearSelection();
      }
      toggleProject(project.projectKey);
    },
    [
      clearSelection,
      dragInProgressRef,
      project.projectKey,
      suppressProjectClickAfterDragRef,
      suppressProjectClickForContextMenuRef,
      toggleProject,
    ],
  );

  const handleProjectButtonKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      if (dragInProgressRef.current) {
        return;
      }
      toggleProject(project.projectKey);
    },
    [dragInProgressRef, project.projectKey, toggleProject],
  );

  const handleProjectButtonPointerDownCapture = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      suppressProjectClickForContextMenuRef.current = false;
      if (
        isContextMenuPointerDown({
          button: event.button,
          ctrlKey: event.ctrlKey,
          isMac: isMacPlatform(navigator.platform),
        })
      ) {
        event.stopPropagation();
      }

      suppressProjectClickAfterDragRef.current = false;
    },
    [suppressProjectClickAfterDragRef, suppressProjectClickForContextMenuRef],
  );

  const openProjectRenameDialog = useCallback((member: SidebarProjectGroupMember) => {
    setProjectRenameTarget(member);
    setProjectRenameTitle(member.name);
  }, []);

  const openAdditionalDirectoriesDialog = useCallback((member: SidebarProjectGroupMember) => {
    setAdditionalDirectoriesTarget(member);
    setAdditionalDirectoriesDraft([...(member.additionalWorkspaceRoots ?? [])]);
    setAdditionalDirectoryInput("");
    setAdditionalDirectoriesError(null);
  }, []);

  const openProjectGroupingDialog = useCallback(
    (member: SidebarProjectGroupMember) => {
      const overrideKey = deriveProjectGroupingOverrideKey(member);
      setProjectGroupingTarget(member);
      setProjectGroupingSelection(
        projectGroupingSettings.sidebarProjectGroupingOverrides?.[overrideKey] ?? "inherit",
      );
    },
    [projectGroupingSettings.sidebarProjectGroupingOverrides],
  );

  const removeProject = useCallback(
    async (member: SidebarProjectGroupMember, options: { force?: boolean } = {}): Promise<void> => {
      const memberProjectRef = scopeProjectRef(member.environmentId, member.id);
      const draftStore = useComposerDraftStore.getState();
      const projectDraftThread = draftStore.getDraftThreadByProjectRef(memberProjectRef);
      if (projectDraftThread) {
        draftStore.clearDraftThread(projectDraftThread.draftId);
      }
      draftStore.clearProjectDraftThreadId(memberProjectRef);

      const projectApi = readEnvironmentApi(member.environmentId);
      if (!projectApi) {
        throw new Error("Project API unavailable.");
      }

      await projectApi.orchestration.dispatchCommand({
        type: "project.delete",
        commandId: newCommandId(),
        projectId: member.id,
        ...(options.force === true ? { force: true } : {}),
      });
    },
    [],
  );

  const confirmAndForceRemoveProject = useCallback(
    async (member: SidebarProjectGroupMember): Promise<void> => {
      const api = readLocalApi();
      if (!api) {
        return;
      }

      const memberProjectRef = scopeProjectRef(member.environmentId, member.id);
      const latestProjectThreads = selectSidebarThreadsForProjectRefs(useStore.getState(), [
        memberProjectRef,
      ]);
      const confirmed = await api.dialogs.confirm(
        latestProjectThreads.length > 0
          ? uiText(
              'Remove project "{name}" and delete its {count} {count, plural, one {chat} other {chats}}?\nPath: {path}\n{hasEnvironment, select, yes {Environment: {environment}\n} other {}}This permanently clears conversation history for those chats.\nThis removes only this project entry.\nThis action cannot be undone.',
              {
                name: member.name,
                count: latestProjectThreads.length,
                path: member.cwd,
                hasEnvironment: member.environmentLabel ? "yes" : "no",
                environment: member.environmentLabel ?? "",
              },
              undefined,
              uiLocale,
            )
          : uiText(
              'Force remove project "{name}"?\nPath: {path}\n{hasEnvironment, select, yes {Environment: {environment}\n} other {}}This project still has hidden or stale chats attached to it.\nThis removes the project entry and any chats still attached to it.\nThis action cannot be undone.',
              {
                name: member.name,
                path: member.cwd,
                hasEnvironment: member.environmentLabel ? "yes" : "no",
                environment: member.environmentLabel ?? "",
              },
              undefined,
              uiLocale,
            ),
      );
      if (!confirmed) {
        return;
      }

      await removeProject(member, { force: true });
    },
    [removeProject, uiLocale],
  );

  const showForceRemoveProjectToast = useCallback(
    (member: SidebarProjectGroupMember, description: string): void => {
      const forceToastId = toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: uiText(
            'Could not remove "{value0}"',
            { value0: member.name },
            undefined,
            uiLocale,
          ),
          description,
          actionVariant: "destructive",
          actionProps: {
            children: uiText("Force remove", undefined, undefined, uiLocale),
            onClick: () => {
              void (async () => {
                toastManager.close(forceToastId);
                await new Promise<void>((resolve) => {
                  window.setTimeout(resolve, 180);
                });
                await confirmAndForceRemoveProject(member);
              })().catch((forceError) => {
                const message =
                  forceError instanceof Error
                    ? forceError.message
                    : uiText(
                        "Unknown error force-removing project.",
                        undefined,
                        undefined,
                        uiLocale,
                      );
                console.error("Failed to force remove project", {
                  projectId: member.id,
                  environmentId: member.environmentId,
                  error: forceError,
                });
                toastManager.add(
                  stackedThreadToast({
                    type: "error",
                    title: uiText(
                      'Failed to force remove "{value0}"',
                      { value0: member.name },
                      undefined,
                      uiLocale,
                    ),
                    description: message,
                  }),
                );
              });
            },
          },
        }),
      );
    },
    [confirmAndForceRemoveProject, uiLocale],
  );

  const handleRemoveProject = useCallback(
    async (member: SidebarProjectGroupMember) => {
      const api = readLocalApi();
      if (!api) {
        return;
      }

      const memberThreadCount = memberThreadCountByPhysicalKey.get(member.physicalProjectKey) ?? 0;
      if (memberThreadCount > 0) {
        const warningToastId = toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: uiText("Project is not empty", undefined, undefined, uiLocale),
            description: uiText(
              "Delete its chats first, or delete the project anyway.",
              undefined,
              undefined,
              uiLocale,
            ),
            actionVariant: "destructive",
            actionProps: {
              children: uiText("Delete anyway", undefined, undefined, uiLocale),
              onClick: () => {
                void (async () => {
                  toastManager.close(warningToastId);
                  await new Promise<void>((resolve) => {
                    window.setTimeout(resolve, 180);
                  });
                  await confirmAndForceRemoveProject(member);
                })().catch((error) => {
                  const message =
                    error instanceof Error
                      ? error.message
                      : uiText("Unknown error removing project.", undefined, undefined, uiLocale);
                  console.error("Failed to remove project", {
                    projectId: member.id,
                    environmentId: member.environmentId,
                    error,
                  });
                  toastManager.add(
                    stackedThreadToast({
                      type: "error",
                      title: uiText(
                        'Failed to remove "{value0}"',
                        { value0: member.name },
                        undefined,
                        uiLocale,
                      ),
                      description: message,
                    }),
                  );
                });
              },
            },
          }),
        );
        return;
      }

      const message = uiText(
        'Remove project "{name}"?\nPath: {path}\n{hasEnvironment, select, yes {Environment: {environment}\n} other {}}This removes only this project entry.',
        {
          name: member.name,
          path: member.cwd,
          hasEnvironment: member.environmentLabel ? "yes" : "no",
          environment: member.environmentLabel ?? "",
        },
        undefined,
        uiLocale,
      );
      const confirmed = await api.dialogs.confirm(message);
      if (!confirmed) {
        return;
      }

      try {
        await removeProject(member);
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : uiText("Unknown error removing project.", undefined, undefined, uiLocale);
        if (isProjectDeleteRequiresForceError(error)) {
          console.warn("Project removal requires force after backend invariant rejection", {
            projectId: member.id,
            environmentId: member.environmentId,
            error,
          });
          showForceRemoveProjectToast(
            member,
            uiText(
              "This project still has hidden or stale chats. Force remove clears them too.",
              undefined,
              undefined,
              uiLocale,
            ),
          );
          return;
        }
        console.error("Failed to remove project", {
          projectId: member.id,
          environmentId: member.environmentId,
          error,
        });
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: uiText(
              'Failed to remove "{value0}"',
              { value0: member.name },
              undefined,
              uiLocale,
            ),
            description: message,
          }),
        );
      }
    },
    [
      confirmAndForceRemoveProject,
      memberThreadCountByPhysicalKey,
      removeProject,
      showForceRemoveProjectToast,
      uiLocale,
    ],
  );

  const handleProjectButtonContextMenu = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      suppressProjectClickForContextMenuRef.current = true;
      void (async () => {
        const api = readLocalApi();
        if (!api) return;

        const actionHandlers = new Map<string, () => Promise<void> | void>();
        const makeLeaf = (
          action: "rename" | "directories" | "grouping" | "copy-path" | "delete",
          member: SidebarProjectGroupMember,
          options?: {
            destructive?: boolean;
            disabled?: boolean;
          },
        ): ContextMenuItem<string> => {
          const id = `${action}:${member.physicalProjectKey}`;
          actionHandlers.set(id, () => {
            switch (action) {
              case "rename":
                openProjectRenameDialog(member);
                return;
              case "directories":
                openAdditionalDirectoriesDialog(member);
                return;
              case "grouping":
                openProjectGroupingDialog(member);
                return;
              case "copy-path":
                copyPathToClipboard(member.cwd, { path: member.cwd });
                return;
              case "delete":
                return handleRemoveProject(member);
            }
          });

          return {
            id,
            label: uiPresentation.formatProjectMemberActionLabel(
              member,
              project.groupedProjectCount,
            ),
            ...(options?.destructive ? { destructive: true } : {}),
            ...(options?.disabled ? { disabled: true } : {}),
          };
        };

        const buildTargetedItem = (
          action: "rename" | "directories" | "grouping" | "copy-path" | "delete",
          label: string,
          options?: {
            destructive?: boolean;
            isDisabled?: (member: SidebarProjectGroupMember) => boolean;
          },
        ): ContextMenuItem<string> => {
          if (project.memberProjects.length === 1) {
            const singleMember = project.memberProjects[0]!;
            return {
              ...makeLeaf(action, singleMember, {
                ...(options?.destructive ? { destructive: true } : {}),
                ...(options?.isDisabled?.(singleMember) ? { disabled: true } : {}),
              }),
              label,
            };
          }

          return {
            id: `${action}:submenu`,
            label,
            children: project.memberProjects.map((member) =>
              makeLeaf(action, member, {
                ...(options?.destructive ? { destructive: true } : {}),
                ...(options?.isDisabled?.(member) ? { disabled: true } : {}),
              }),
            ),
          };
        };

        const clicked = await api.contextMenu.show(
          [
            buildTargetedItem("rename", uiText("Rename project", undefined, undefined, uiLocale)),
            buildTargetedItem(
              "directories",
              uiText("Configure additional directories…", undefined, undefined, uiLocale),
            ),
            buildTargetedItem(
              "grouping",
              uiText("Project grouping…", undefined, undefined, uiLocale),
            ),
            buildTargetedItem(
              "copy-path",
              uiText("Copy Project Path", undefined, undefined, uiLocale),
            ),
            buildTargetedItem("delete", uiText("Remove project", undefined, undefined, uiLocale), {
              destructive: true,
            }),
          ],
          {
            x: event.clientX,
            y: event.clientY,
          },
        );

        if (!clicked) {
          return;
        }

        await actionHandlers.get(clicked)?.();
      })();
    },
    [
      copyPathToClipboard,
      handleRemoveProject,
      openAdditionalDirectoriesDialog,
      openProjectGroupingDialog,
      openProjectRenameDialog,
      project.groupedProjectCount,
      project.memberProjects,
      suppressProjectClickForContextMenuRef,
      uiLocale,
      uiPresentation,
    ],
  );

  const navigateToThread = useCallback(
    (threadRef: ScopedThreadRef) => {
      if (useThreadSelectionStore.getState().selectedThreadKeys.size > 0) {
        clearSelection();
      }
      setSelectionAnchor(scopedThreadKey(threadRef));
      if (isMobile) {
        setOpenMobile(false);
      }
      void router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
      });
    },
    [clearSelection, isMobile, router, setOpenMobile, setSelectionAnchor],
  );

  const handleThreadClick = useCallback(
    (
      event: React.MouseEvent,
      threadRef: ScopedThreadRef,
      orderedProjectThreadKeys: readonly string[],
    ) => {
      const isMac = isMacPlatform(navigator.platform);
      const isModClick = isMac ? event.metaKey : event.ctrlKey;
      const isShiftClick = event.shiftKey;
      const threadKey = scopedThreadKey(threadRef);
      const currentSelectionCount = useThreadSelectionStore.getState().selectedThreadKeys.size;

      if (isModClick) {
        event.preventDefault();
        toggleThreadSelection(threadKey);
        return;
      }

      if (isShiftClick) {
        event.preventDefault();
        rangeSelectTo(threadKey, orderedProjectThreadKeys);
        return;
      }

      if (currentSelectionCount > 0) {
        clearSelection();
      }
      setSelectionAnchor(threadKey);
      if (isMobile) {
        setOpenMobile(false);
      }
      if (event.detail >= 2 || getClientSettings().chatClickBehavior === "open")
        useDeskStore.getState().dispatch({ type: "open", target: { kind: "server", threadRef } });
      void router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
      });
    },
    [
      clearSelection,
      isMobile,
      rangeSelectTo,
      router,
      setOpenMobile,
      setSelectionAnchor,
      toggleThreadSelection,
    ],
  );

  const handleMultiSelectContextMenu = useCallback(
    async (position: { x: number; y: number }) => {
      const api = readLocalApi();
      if (!api) return;
      const threadKeys = [...useThreadSelectionStore.getState().selectedThreadKeys];
      if (threadKeys.length === 0) return;
      const count = threadKeys.length;

      const clicked = await api.contextMenu.show(
        [
          {
            id: "delete",
            label: uiText("Move to Recycle Bin ({value0})", { value0: count }, undefined, uiLocale),
            destructive: true,
          },
        ],
        position,
      );

      if (clicked !== "delete") return;

      if (appSettingsConfirmThreadDelete) {
        const confirmed = await api.dialogs.confirm(
          uiText(
            "Move {count} {count, plural, one {chat} other {chats}} to the Recycle Bin?\nYou can review them later in Settings '>' Recently Deleted.",
            { count },
            undefined,
            uiLocale,
          ),
        );
        if (!confirmed) return;
      }

      const deletedThreadKeys = new Set(threadKeys);
      for (const threadKey of threadKeys) {
        const thread = sidebarThreadByKeyRef.current.get(threadKey);
        if (!thread) continue;
        await deleteThread(scopeThreadRef(thread.environmentId, thread.id), {
          deletedThreadKeys,
        });
      }
      removeFromSelection(threadKeys);
    },
    [appSettingsConfirmThreadDelete, deleteThread, removeFromSelection, uiLocale],
  );

  const createThreadForProjectMember = useCallback(
    (member: SidebarProjectGroupMember) => {
      const currentRouteParams =
        router.state.matches[router.state.matches.length - 1]?.params ?? {};
      const currentRouteTarget = resolveThreadRouteTarget(currentRouteParams);
      const currentActiveThread =
        currentRouteTarget?.kind === "server"
          ? (selectThreadByRef(useStore.getState(), currentRouteTarget.threadRef) ?? null)
          : null;
      const draftStore = useComposerDraftStore.getState();
      const currentActiveDraftThread =
        currentRouteTarget?.kind === "server"
          ? (draftStore.getDraftThread(currentRouteTarget.threadRef) ?? null)
          : currentRouteTarget?.kind === "draft"
            ? (draftStore.getDraftSession(currentRouteTarget.draftId) ?? null)
            : null;
      const seedContext = resolveSidebarNewThreadSeedContext({
        projectId: member.id,
        defaultEnvMode: resolveSidebarNewThreadEnvMode({
          defaultEnvMode: defaultThreadEnvMode,
        }),
        activeThread:
          currentActiveThread && currentActiveThread.projectId === member.id
            ? {
                projectId: currentActiveThread.projectId,
                branch: currentActiveThread.branch,
                worktreePath: currentActiveThread.worktreePath,
              }
            : null,
        activeDraftThread:
          currentActiveDraftThread && currentActiveDraftThread.projectId === member.id
            ? {
                projectId: currentActiveDraftThread.projectId,
                branch: currentActiveDraftThread.branch,
                worktreePath: currentActiveDraftThread.worktreePath,
                envMode: currentActiveDraftThread.envMode,
              }
            : null,
      });
      if (isMobile) {
        setOpenMobile(false);
      }
      void handleNewThread(scopeProjectRef(member.environmentId, member.id), {
        ...(seedContext.branch !== undefined ? { branch: seedContext.branch } : {}),
        ...(seedContext.worktreePath !== undefined
          ? { worktreePath: seedContext.worktreePath }
          : {}),
        envMode: seedContext.envMode,
      });
    },
    [defaultThreadEnvMode, handleNewThread, isMobile, router, setOpenMobile],
  );

  const handleCreateThreadClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();

      if (project.memberProjects.length === 1) {
        createThreadForProjectMember(project.memberProjects[0]!);
        return;
      }

      void (async () => {
        const api = readLocalApi();
        if (!api) {
          return;
        }
        const clicked = await api.contextMenu.show(
          project.memberProjects.map((member) => ({
            id: member.physicalProjectKey,
            label: uiPresentation.formatProjectMemberActionLabel(
              member,
              project.groupedProjectCount,
            ),
          })),
          {
            x: event.clientX,
            y: event.clientY,
          },
        );
        if (!clicked) {
          return;
        }
        const targetMember = project.memberProjects.find(
          (member) => member.physicalProjectKey === clicked,
        );
        if (!targetMember) {
          return;
        }
        createThreadForProjectMember(targetMember);
      })();
    },
    [
      createThreadForProjectMember,
      project.groupedProjectCount,
      project.memberProjects,
      uiPresentation,
    ],
  );

  const attemptArchiveThread = useCallback(
    async (threadRef: ScopedThreadRef) => {
      try {
        await archiveThread(threadRef);
      } catch (error) {
        console.warn("Failed to archive chat", { error });
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: uiText("Could not archive chat", undefined, undefined, uiLocale),
          }),
        );
      }
    },
    [archiveThread, uiLocale],
  );

  const cancelRename = useCallback(() => {
    setRenamingThreadKey(null);
    renamingInputRef.current = null;
  }, []);

  const beginRename = useCallback((threadRef: ScopedThreadRef, title: string) => {
    setRenamingThreadKey(scopedThreadKey(threadRef));
    setRenamingTitle(title);
    renamingCommittedRef.current = false;
  }, []);

  const commitRename = useCallback(
    async (threadRef: ScopedThreadRef, newTitle: string, originalTitle: string) => {
      const threadKey = scopedThreadKey(threadRef);
      const finishRename = () => {
        setRenamingThreadKey((current) => {
          if (current !== threadKey) return current;
          renamingInputRef.current = null;
          return null;
        });
      };

      const trimmed = newTitle.trim();
      if (trimmed.length === 0) {
        toastManager.add({
          type: "warning",
          title: uiText("Chat title can''t be empty", undefined, undefined, uiLocale),
        });
        finishRename();
        return;
      }
      if (trimmed === originalTitle) {
        finishRename();
        return;
      }
      try {
        await renameThread(threadRef, trimmed, originalTitle);
      } catch (error) {
        console.warn("Failed to rename chat", { error });
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: uiText("Could not rename chat", undefined, undefined, uiLocale),
          }),
        );
      }
      finishRename();
    },
    [uiLocale],
  );

  const closeProjectRenameDialog = useCallback(() => {
    setProjectRenameTarget(null);
    setProjectRenameTitle("");
  }, []);

  const submitProjectRename = useCallback(async () => {
    if (!projectRenameTarget) {
      return;
    }

    const trimmed = projectRenameTitle.trim();
    if (trimmed.length === 0) {
      toastManager.add({
        type: "warning",
        title: uiText("Project title cannot be empty", undefined, undefined, uiLocale),
      });
      return;
    }

    if (trimmed === projectRenameTarget.name) {
      closeProjectRenameDialog();
      return;
    }

    const api = readEnvironmentApi(projectRenameTarget.environmentId);
    if (!api) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: uiText("Could not rename project", undefined, undefined, uiLocale),
          description: uiText(
            "Reconnect to the project''s environment and try again.",
            undefined,
            undefined,
            uiLocale,
          ),
        }),
      );
      return;
    }

    try {
      await api.orchestration.dispatchCommand({
        type: "project.meta.update",
        commandId: newCommandId(),
        projectId: projectRenameTarget.id,
        title: trimmed,
      });
      closeProjectRenameDialog();
    } catch (error) {
      console.warn("Failed to rename project", { error });
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: uiText("Could not rename project", undefined, undefined, uiLocale),
        }),
      );
    }
  }, [closeProjectRenameDialog, projectRenameTarget, projectRenameTitle, uiLocale]);

  const closeProjectGroupingDialog = useCallback(() => {
    setProjectGroupingTarget(null);
    setProjectGroupingSelection("inherit");
  }, []);

  const closeAdditionalDirectoriesDialog = useCallback(() => {
    if (additionalDirectoriesSubmitting) {
      return;
    }
    setAdditionalDirectoriesTarget(null);
    setAdditionalDirectoriesDraft([]);
    setAdditionalDirectoryInput("");
    setAdditionalDirectoriesError(null);
  }, [additionalDirectoriesSubmitting]);

  const addAdditionalDirectoryDraft = useCallback((pathValue: string) => {
    const trimmed = pathValue.trim();
    if (trimmed.length === 0) {
      return;
    }
    setAdditionalDirectoriesDraft((current) =>
      current.some(
        (entry) => normalizePathForComparison(entry) === normalizePathForComparison(trimmed),
      )
        ? current
        : [...current, trimmed],
    );
    setAdditionalDirectoryInput("");
    setAdditionalDirectoriesError(null);
  }, []);

  const browseAdditionalDirectory = useCallback(async () => {
    if (!additionalDirectoriesTarget) {
      return;
    }
    const api = readLocalApi();
    if (!api) {
      return;
    }
    const selectedPath = await api.dialogs.pickFolder({
      initialPath: additionalDirectoriesTarget.cwd,
    });
    if (selectedPath) {
      addAdditionalDirectoryDraft(selectedPath);
    }
  }, [addAdditionalDirectoryDraft, additionalDirectoriesTarget]);

  const removeAdditionalDirectoryDraft = useCallback((indexToRemove: number) => {
    setAdditionalDirectoriesDraft((current) =>
      current.filter((_, index) => index !== indexToRemove),
    );
  }, []);

  const submitAdditionalDirectories = useCallback(async () => {
    if (!additionalDirectoriesTarget) {
      return;
    }
    const api = readEnvironmentApi(additionalDirectoriesTarget.environmentId);
    if (!api) {
      setAdditionalDirectoriesError(
        uiText("Project API unavailable.", undefined, undefined, uiLocale),
      );
      return;
    }

    setAdditionalDirectoriesSubmitting(true);
    setAdditionalDirectoriesError(null);
    try {
      await api.orchestration.dispatchCommand({
        type: "project.meta.update",
        commandId: newCommandId(),
        projectId: additionalDirectoriesTarget.id,
        additionalWorkspaceRoots: additionalDirectoriesDraft,
      });
      setAdditionalDirectoriesTarget(null);
      setAdditionalDirectoriesDraft([]);
      setAdditionalDirectoryInput("");
    } catch (error) {
      setAdditionalDirectoriesError(
        error instanceof Error
          ? error.message
          : uiText("An error occurred.", undefined, undefined, uiLocale),
      );
    } finally {
      setAdditionalDirectoriesSubmitting(false);
    }
  }, [additionalDirectoriesDraft, additionalDirectoriesTarget, uiLocale]);

  const closeThreadMoveDialog = useCallback(() => {
    setThreadMoveTarget(null);
    setThreadMoveProjectId(null);
    setThreadMoveSubmitting(false);
  }, []);

  const saveProjectGroupingPreference = useCallback(() => {
    if (!projectGroupingTarget) {
      return;
    }

    const overrideKey = deriveProjectGroupingOverrideKey(projectGroupingTarget);
    const nextOverrides = {
      ...projectGroupingSettings.sidebarProjectGroupingOverrides,
    };
    if (projectGroupingSelection === "inherit") {
      delete nextOverrides[overrideKey];
    } else {
      nextOverrides[overrideKey] = projectGroupingSelection;
    }
    updateSettings({
      sidebarProjectGroupingOverrides: nextOverrides,
    });
    closeProjectGroupingDialog();
  }, [
    closeProjectGroupingDialog,
    projectGroupingSelection,
    projectGroupingSettings.sidebarProjectGroupingOverrides,
    projectGroupingTarget,
    updateSettings,
  ]);

  const getThreadMoveCandidates = useCallback(
    (thread: SidebarThreadSummary) =>
      sortThreadMoveCandidates(
        allProjects.filter(
          (candidate) =>
            candidate.environmentId === thread.environmentId && candidate.id !== thread.projectId,
        ),
      ),
    [allProjects],
  );

  const openThreadMoveDialog = useCallback(
    (thread: SidebarThreadSummary) => {
      const candidates = getThreadMoveCandidates(thread);
      if (candidates.length === 0) {
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: uiText("No project folder to move to", undefined, undefined, uiLocale),
            description: uiText(
              "Add another project in this environment first.",
              undefined,
              undefined,
              uiLocale,
            ),
          }),
        );
        return;
      }

      setThreadMoveTarget(thread);
      setThreadMoveProjectId(candidates[0]!.id);
    },
    [getThreadMoveCandidates, uiLocale],
  );

  const threadMoveCandidateProjects = useMemo(
    () => (threadMoveTarget ? getThreadMoveCandidates(threadMoveTarget) : []),
    [getThreadMoveCandidates, threadMoveTarget],
  );

  const selectedThreadMoveProject = useMemo(
    () =>
      threadMoveProjectId
        ? (threadMoveCandidateProjects.find((candidate) => candidate.id === threadMoveProjectId) ??
          null)
        : null,
    [threadMoveCandidateProjects, threadMoveProjectId],
  );

  const submitThreadMove = useCallback(async () => {
    if (!threadMoveTarget || !threadMoveProjectId) {
      return;
    }

    const targetProject = threadMoveCandidateProjects.find(
      (candidate) => candidate.id === threadMoveProjectId,
    );
    if (!targetProject) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: uiText("Project folder unavailable", undefined, undefined, uiLocale),
          description: uiText("Choose another project folder.", undefined, undefined, uiLocale),
        }),
      );
      return;
    }

    const api = readEnvironmentApi(threadMoveTarget.environmentId);
    if (!api) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: uiText("Could not move chat", undefined, undefined, uiLocale),
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

    setThreadMoveSubmitting(true);
    try {
      await api.orchestration.dispatchCommand({
        type: "thread.meta.update",
        commandId: newCommandId(),
        threadId: threadMoveTarget.id,
        projectId: targetProject.id,
        worktreePath: null,
      });
      // The chat visibly moves under its new project, so no success toast.
      closeThreadMoveDialog();
    } catch (error) {
      setThreadMoveSubmitting(false);
      console.warn("Failed to move chat", { error });
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: uiText("Could not move chat", undefined, undefined, uiLocale),
        }),
      );
    }
  }, [
    closeThreadMoveDialog,
    threadMoveCandidateProjects,
    threadMoveProjectId,
    threadMoveTarget,
    uiLocale,
  ]);

  const closeThreadRepairDialog = useCallback(() => {
    setThreadRepairDialog((current) => (current?.phase === "running" ? current : null));
  }, []);

  const startThreadRepair = useCallback(
    async (thread: SidebarThreadSummary) => {
      const api = readEnvironmentApi(thread.environmentId);
      if (!api) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: uiText("Could not repair chat", undefined, undefined, uiLocale),
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

      setThreadRepairDialog({ phase: "running", thread });
      try {
        const result = await api.orchestration.repairThreadAssistantMessages({
          threadId: thread.id,
          sourcePolicy: "local-then-upstream",
        });
        setThreadRepairDialog({ phase: "complete", thread, result });
      } catch (error) {
        setThreadRepairDialog({
          phase: "error",
          thread,
          message:
            error instanceof Error
              ? error.message
              : uiText("The repair request failed.", undefined, undefined, uiLocale),
        });
      }
    },
    [uiLocale],
  );

  const handleThreadContextMenu = useCallback(
    async (threadRef: ScopedThreadRef, position: { x: number; y: number }) => {
      const api = readLocalApi();
      if (!api) return;
      const threadKey = scopedThreadKey(threadRef);
      const thread = sidebarThreadByKeyRef.current.get(threadKey) ?? null;
      if (!thread) return;
      const threadProject =
        thread.projectId === null
          ? undefined
          : memberProjectByScopedKey.get(
              scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)),
            );
      const threadWorkspacePath = thread.worktreePath ?? threadProject?.cwd ?? project.cwd ?? null;
      const duplicateAvailable =
        canDuplicateThread(thread) && !isThreadDuplicationPending(threadRef);
      const clicked = await api.contextMenu.show(
        uiPresentation.buildSidebarThreadContextMenuItems({
          debugEnabled: desktopDebugEnabled,
          repairRunning: threadRepairDialog?.phase === "running",
          forkDisabled: !duplicateAvailable,
        }),
        position,
      );

      if (clicked === "rename") {
        beginRename(threadRef, thread.title);
        return;
      }

      if (clicked === "fork") {
        // Keep the established menu ID while sharing the exact same native
        // duplication path as Desk and standalone chats. Recheck after choice.
        if (
          duplicateAvailable &&
          canDuplicateThread(sidebarThreadByKeyRef.current.get(threadKey))
        ) {
          await duplicateThread(threadRef);
        }
        return;
      }

      if (clicked === "move") {
        openThreadMoveDialog(thread);
        return;
      }
      if (clicked === "copy-path") {
        if (!threadWorkspacePath) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: uiText("No folder to copy", undefined, undefined, uiLocale),
              description: uiText(
                "This chat has no workspace folder.",
                undefined,
                undefined,
                uiLocale,
              ),
            }),
          );
          return;
        }
        copyPathToClipboard(threadWorkspacePath, { path: threadWorkspacePath });
        return;
      }
      if (clicked === "copy-thread-id") {
        copyThreadIdToClipboard(thread.id, { threadId: thread.id });
        return;
      }
      if (clicked === "repair-thread") {
        await startThreadRepair(thread);
        return;
      }
      if (clicked !== "delete") return;
      if (appSettingsConfirmThreadDelete) {
        const confirmed = await api.dialogs.confirm(
          uiText(
            "Move \"{title}\" to the Recycle Bin?\nYou can review it later in Settings '>' Recently Deleted.",
            { title: thread.title },
            undefined,
            uiLocale,
          ),
        );
        if (!confirmed) {
          return;
        }
      }
      await deleteThread(threadRef);
    },
    [
      appSettingsConfirmThreadDelete,
      beginRename,
      copyPathToClipboard,
      copyThreadIdToClipboard,
      desktopDebugEnabled,
      deleteThread,
      duplicateThread,
      memberProjectByScopedKey,
      openThreadMoveDialog,
      project.cwd,
      router,
      startThreadRepair,
      threadRepairDialog?.phase,
      uiLocale,
      uiPresentation,
    ],
  );

  const additionalDirectoryWarnings = additionalDirectoriesDraft.flatMap((candidate, index) =>
    additionalDirectoriesDraft.some(
      (other, otherIndex) => otherIndex !== index && pathContainsPath(other, candidate),
    )
      ? [
          uiText(
            "{path} is inside another configured directory.",
            { path: candidate },
            undefined,
            uiLocale,
          ),
        ]
      : [],
  );

  return (
    <>
      <div className="group/project-header relative">
        <SidebarMenuButton
          ref={isManualProjectSorting ? dragHandleProps?.setActivatorNodeRef : undefined}
          size="sm"
          className={`gap-2 px-2 py-1.5 pr-8 text-left hover:bg-accent group-hover/project-header:bg-accent group-hover/project-header:text-sidebar-accent-foreground max-md:pr-14 ${
            isManualProjectSorting ? "cursor-grab active:cursor-grabbing" : "cursor-pointer"
          }`}
          {...(isManualProjectSorting && dragHandleProps ? dragHandleProps.attributes : {})}
          {...(isManualProjectSorting && dragHandleProps ? dragHandleProps.listeners : {})}
          onPointerDownCapture={handleProjectButtonPointerDownCapture}
          onClick={handleProjectButtonClick}
          onKeyDown={handleProjectButtonKeyDown}
          onContextMenu={handleProjectButtonContextMenu}
        >
          {!projectExpanded && projectStatus ? (
            // A collapsed project shows its most urgent chat's state with the
            // same dot as the chat rows; hovering reveals the chevron.
            <span
              title={projectStatus.label}
              data-project-status={projectStatus.label}
              className={`-ml-0.5 relative inline-flex size-3.5 shrink-0 items-center justify-center ${projectStatus.colorClass}`}
            >
              <span className="absolute inset-0 flex items-center justify-center transition-opacity duration-(--duration-fast) group-hover/project-header:opacity-0">
                <ThreadStatusDot status={projectStatus} />
              </span>
              <span className="sr-only">{projectStatus.label}</span>
              <ChevronRightIcon
                aria-hidden="true"
                className="absolute inset-0 m-auto size-3.5 text-subtle-foreground opacity-0 transition-opacity duration-(--duration-fast) group-hover/project-header:opacity-100"
              />
            </span>
          ) : (
            <ChevronRightIcon
              className={`-ml-0.5 size-3.5 shrink-0 text-subtle-foreground transition-transform duration-(--duration-fast) ${
                projectExpanded ? "rotate-90" : ""
              }`}
            />
          )}
          <ProjectFavicon environmentId={project.environmentId} cwd={project.cwd} />
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <span className="truncate text-ui font-medium text-foreground">
              {project.displayName}
            </span>
            {project.groupedProjectCount > 1 ? (
              <span className="shrink-0 text-2xs text-subtle-foreground">
                <UiMessage
                  message={"<slot1></slot1> projects"}
                  slots={{ slot1: project.groupedProjectCount }}
                />
              </span>
            ) : null}
          </span>
        </SidebarMenuButton>
        <Tooltip>
          <TooltipTrigger
            render={
              <div className="pointer-events-none absolute top-1 right-1.5 opacity-0 transition-opacity duration-150 max-md:pointer-events-auto max-md:opacity-100 group-hover/project-header:pointer-events-auto group-hover/project-header:opacity-100 group-focus-within/project-header:pointer-events-auto group-focus-within/project-header:opacity-100">
                <button
                  type="button"
                  aria-label={uiText(
                    "New chat in {value0}",
                    { value0: project.displayName },
                    undefined,
                    uiLocale,
                  )}
                  data-testid="new-thread-button"
                  className="inline-flex size-5 cursor-pointer items-center justify-center rounded-sm text-subtle-foreground transition-colors duration-(--duration-fast) hover:bg-secondary hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring max-md:size-8"
                  onClick={handleCreateThreadClick}
                >
                  <SquarePenIcon className="size-3.5" />
                </button>
              </div>
            }
          />
          <TooltipPopup side="top">
            {newThreadShortcutLabel
              ? uiText(
                  "New chat ({value0})",
                  { value0: newThreadShortcutLabel },
                  undefined,
                  uiLocale,
                )
              : uiText("New chat", undefined, undefined, uiLocale)}
          </TooltipPopup>
        </Tooltip>
      </div>

      <SidebarProjectThreadList
        projectKey={project.projectKey}
        projectExpanded={projectExpanded}
        hasOverflowingThreads={hasOverflowingThreads}
        hiddenThreadCount={hiddenThreadCount}
        hiddenThreadSummary={hiddenThreadSummary}
        orderedProjectThreadKeys={orderedProjectThreadKeys}
        renderedThreads={renderedThreads}
        showEmptyThreadState={showEmptyThreadState}
        shouldShowThreadPanel={shouldShowThreadPanel}
        isThreadListExpanded={isThreadListExpanded}
        projectCwd={project.cwd}
        activeRouteThreadKey={activeRouteThreadKey}
        threadJumpLabelByKey={threadJumpLabelByKey}
        appSettingsConfirmThreadArchive={appSettingsConfirmThreadArchive}
        renamingThreadKey={renamingThreadKey}
        renamingTitle={renamingTitle}
        setRenamingTitle={setRenamingTitle}
        renamingInputRef={renamingInputRef}
        renamingCommittedRef={renamingCommittedRef}
        confirmingArchiveThreadKey={confirmingArchiveThreadKey}
        setConfirmingArchiveThreadKey={setConfirmingArchiveThreadKey}
        confirmArchiveButtonRefs={confirmArchiveButtonRefs}
        attachThreadListAutoAnimateRef={attachThreadListAutoAnimateRef}
        handleThreadClick={handleThreadClick}
        navigateToThread={navigateToThread}
        handleMultiSelectContextMenu={handleMultiSelectContextMenu}
        handleThreadContextMenu={handleThreadContextMenu}
        clearSelection={clearSelection}
        commitRename={commitRename}
        cancelRename={cancelRename}
        beginRename={beginRename}
        attemptArchiveThread={attemptArchiveThread}
        openPrLink={openPrLink}
        expandThreadListForProject={expandThreadListForProject}
        collapseThreadListForProject={collapseThreadListForProject}
      />

      <ThreadRepairProgressDialog state={threadRepairDialog} onClose={closeThreadRepairDialog} />

      <Dialog
        open={projectRenameTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            closeProjectRenameDialog();
          }
        }}
      >
        <DialogPopup className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{uiText("Rename project", undefined, undefined, uiLocale)}</DialogTitle>
            <DialogDescription>
              {projectRenameTarget
                ? uiText(
                    "Update the title for {value0}.",
                    { value0: projectRenameTarget.cwd },
                    undefined,
                    uiLocale,
                  )
                : uiText("Update the project title.", undefined, undefined, uiLocale)}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            <div className="grid gap-1.5">
              <span className="text-xs font-medium text-foreground">
                {uiText("Project title", undefined, undefined, uiLocale)}
              </span>
              <Input
                aria-label={uiText("Project title", undefined, undefined, uiLocale)}
                value={projectRenameTitle}
                onChange={(event) => setProjectRenameTitle(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void submitProjectRename();
                  }
                }}
              />
            </div>
            {projectRenameTarget?.environmentLabel ? (
              <p className="text-xs text-muted-foreground">
                <UiMessage
                  message={"Environment: <slot1></slot1>"}
                  slots={{ slot1: projectRenameTarget.environmentLabel }}
                />
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={closeProjectRenameDialog}>
              {uiText("Cancel", undefined, undefined, uiLocale)}
            </Button>
            <Button onClick={() => void submitProjectRename()}>
              {uiText("Save", undefined, undefined, uiLocale)}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <Dialog
        open={additionalDirectoriesTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            closeAdditionalDirectoriesDialog();
          }
        }}
      >
        <DialogPopup className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {uiText("Additional directories", undefined, undefined, uiLocale)}
            </DialogTitle>
            <DialogDescription>
              {additionalDirectoriesTarget
                ? uiText(
                    "Configure directories available to agents for {value0}.",
                    {
                      value0: additionalDirectoriesTarget.cwd,
                    },
                    undefined,
                    uiLocale,
                  )
                : uiText(
                    "Configure directories available to agents.",
                    undefined,
                    undefined,
                    uiLocale,
                  )}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            <div className="grid gap-1.5">
              <span className="text-xs font-medium text-foreground">
                {uiText("Primary directory", undefined, undefined, uiLocale)}
              </span>
              <div className="min-h-9 overflow-hidden rounded-lg border bg-muted px-3 py-2 text-xs text-muted-foreground">
                <span className="block truncate">{additionalDirectoriesTarget?.cwd ?? ""}</span>
              </div>
            </div>

            <div className="grid gap-2">
              <span className="text-xs font-medium text-foreground">
                {uiText("Additional directories", undefined, undefined, uiLocale)}
              </span>
              {additionalDirectoriesDraft.length > 0 ? (
                <div className="grid gap-2">
                  {additionalDirectoriesDraft.map((directory, index) => (
                    <div key={directory} className="flex min-w-0 items-center gap-2">
                      <div className="min-w-0 flex-1 rounded-lg border bg-background px-3 py-2 text-xs">
                        <span className="block truncate">{directory}</span>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={uiText(
                          "Remove {value0}",
                          { value0: directory },
                          undefined,
                          uiLocale,
                        )}
                        onClick={() => removeAdditionalDirectoryDraft(index)}
                      >
                        <Trash2Icon className="size-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="rounded-lg border border-dashed px-3 py-4 text-xs text-muted-foreground">
                  {uiText("No additional directories configured.", undefined, undefined, uiLocale)}
                </p>
              )}
            </div>

            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                aria-label={uiText("Additional directory path", undefined, undefined, uiLocale)}
                value={additionalDirectoryInput}
                placeholder={uiText("Absolute path", undefined, undefined, uiLocale)}
                onChange={(event) => setAdditionalDirectoryInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    addAdditionalDirectoryDraft(additionalDirectoryInput);
                  }
                }}
              />
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => addAdditionalDirectoryDraft(additionalDirectoryInput)}
                >
                  <PlusIcon className="size-4" />
                  {uiText("Add", undefined, undefined, uiLocale)}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void browseAdditionalDirectory()}
                >
                  <FolderPlusIcon className="size-4" />
                  {uiText("Browse", undefined, undefined, uiLocale)}
                </Button>
              </div>
            </div>

            {additionalDirectoryWarnings.length > 0 ? (
              <Alert>
                <TriangleAlertIcon className="size-4" />
                <AlertTitle>
                  {uiText("Redundant directories", undefined, undefined, uiLocale)}
                </AlertTitle>
                <AlertDescription>{additionalDirectoryWarnings.join(" ")}</AlertDescription>
              </Alert>
            ) : null}

            {additionalDirectoriesError ? (
              <Alert variant="error">
                <TriangleAlertIcon className="size-4" />
                <AlertTitle>
                  {uiText("Unable to save directories", undefined, undefined, uiLocale)}
                </AlertTitle>
                <AlertDescription>{additionalDirectoriesError}</AlertDescription>
              </Alert>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={closeAdditionalDirectoriesDialog}
              disabled={additionalDirectoriesSubmitting}
            >
              {uiText("Cancel", undefined, undefined, uiLocale)}
            </Button>
            <Button
              onClick={() => void submitAdditionalDirectories()}
              disabled={additionalDirectoriesSubmitting}
            >
              {uiText("Save", undefined, undefined, uiLocale)}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <Dialog
        open={projectGroupingTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            closeProjectGroupingDialog();
          }
        }}
      >
        <DialogPopup className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{uiText("Project grouping", undefined, undefined, uiLocale)}</DialogTitle>
            <DialogDescription>
              {projectGroupingTarget
                ? uiText(
                    "Choose how {value0} should be grouped in the sidebar.",
                    {
                      value0: projectGroupingTarget.cwd,
                    },
                    undefined,
                    uiLocale,
                  )
                : uiText(
                    "Choose how this project should be grouped in the sidebar.",
                    undefined,
                    undefined,
                    uiLocale,
                  )}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            <div className="grid gap-1.5">
              <span className="text-xs font-medium text-foreground">
                {uiText("Grouping rule", undefined, undefined, uiLocale)}
              </span>
              <Select
                value={projectGroupingSelection}
                onValueChange={(value) => {
                  if (
                    value === "inherit" ||
                    value === "repository" ||
                    value === "repository_path" ||
                    value === "separate"
                  ) {
                    setProjectGroupingSelection(value);
                  }
                }}
              >
                <SelectTrigger
                  className="w-full"
                  aria-label={uiText("Project grouping rule", undefined, undefined, uiLocale)}
                >
                  <SelectValue>
                    {projectGroupingSelection === "inherit"
                      ? uiText(
                          "Use global default ({value0})",
                          {
                            value0:
                              uiPresentation.PROJECT_GROUPING_MODE_LABELS[
                                projectGroupingSettings.sidebarProjectGroupingMode
                              ],
                          },
                          undefined,
                          uiLocale,
                        )
                      : uiPresentation.PROJECT_GROUPING_MODE_LABELS[projectGroupingSelection]}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem hideIndicator value="inherit">
                    {uiText("Use global default", undefined, undefined, uiLocale)}
                  </SelectItem>
                  <SelectItem hideIndicator value="repository">
                    {uiPresentation.PROJECT_GROUPING_MODE_LABELS.repository}
                  </SelectItem>
                  <SelectItem hideIndicator value="repository_path">
                    {uiPresentation.PROJECT_GROUPING_MODE_LABELS.repository_path}
                  </SelectItem>
                  <SelectItem hideIndicator value="separate">
                    {uiPresentation.PROJECT_GROUPING_MODE_LABELS.separate}
                  </SelectItem>
                </SelectPopup>
              </Select>
            </div>
            <p className="text-xs text-muted-foreground">
              {projectGroupingSelection === "inherit"
                ? uiPresentation.projectGroupingModeDescription(
                    projectGroupingSettings.sidebarProjectGroupingMode,
                  )
                : uiPresentation.projectGroupingModeDescription(projectGroupingSelection)}
            </p>
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={closeProjectGroupingDialog}>
              {uiText("Cancel", undefined, undefined, uiLocale)}
            </Button>
            <Button onClick={saveProjectGroupingPreference}>
              {uiText("Save", undefined, undefined, uiLocale)}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <Dialog
        open={threadMoveTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            closeThreadMoveDialog();
          }
        }}
      >
        <DialogPopup className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{uiText("Move chat", undefined, undefined, uiLocale)}</DialogTitle>
            <DialogDescription>
              {threadMoveTarget
                ? uiText(
                    'Move "{value0}" to another project folder.',
                    {
                      value0: threadMoveTarget.title,
                    },
                    undefined,
                    uiLocale,
                  )
                : uiText(
                    "Move this chat to another project folder.",
                    undefined,
                    undefined,
                    uiLocale,
                  )}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            <div className="grid gap-1.5">
              <span className="text-xs font-medium text-foreground">
                {uiText("Project folder", undefined, undefined, uiLocale)}
              </span>
              <Select
                value={threadMoveProjectId ?? ""}
                onValueChange={(value) => {
                  const nextProject = threadMoveCandidateProjects.find(
                    (candidate) => candidate.id === value,
                  );
                  if (nextProject) {
                    setThreadMoveProjectId(nextProject.id);
                  }
                }}
              >
                <SelectTrigger
                  className="w-full"
                  aria-label={uiText("Destination project folder", undefined, undefined, uiLocale)}
                >
                  <SelectValue>
                    {selectedThreadMoveProject
                      ? selectedThreadMoveProject.name
                      : uiText("Choose a project folder", undefined, undefined, uiLocale)}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {threadMoveCandidateProjects.map((candidate) => (
                    <SelectItem hideIndicator key={candidate.id} value={candidate.id}>
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate">{candidate.name}</span>
                        <span className="truncate text-xs text-subtle-foreground">
                          {candidate.cwd}
                        </span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
            {selectedThreadMoveProject ? (
              <p className="text-xs text-muted-foreground">
                <UiMessage
                  message={"Destination path: <slot1></slot1>"}
                  slots={{ slot1: selectedThreadMoveProject.cwd }}
                />
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={closeThreadMoveDialog}>
              {uiText("Cancel", undefined, undefined, uiLocale)}
            </Button>
            <Button
              disabled={threadMoveSubmitting || !threadMoveTarget || !selectedThreadMoveProject}
              onClick={() => void submitThreadMove()}
            >
              {threadMoveSubmitting
                ? uiText("Moving…", undefined, undefined, uiLocale)
                : uiText("Move", undefined, undefined, uiLocale)}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
});

const SidebarProjectListRow = memo(function SidebarProjectListRow(props: SidebarProjectItemProps) {
  return (
    <SidebarMenuItem className="rounded-md">
      <SidebarProjectItem {...props} />
    </SidebarMenuItem>
  );
});

function CafeCodeWordmark({ className }: { className?: string }) {
  const uiLocale = useUiLocale();

  const prefix = useSettings((s) => {
    const raw = s.brandWordmarkPrefix?.trim();
    return raw || DEFAULT_BRAND_WORDMARK_PREFIX;
  });
  return (
    <span
      aria-label={uiText("{value0} Code", { value0: prefix }, undefined, uiLocale)}
      className={cn("shrink-0 text-sm text-foreground", className)}
    >
      <span className="font-bold">{prefix}</span>
      <span className="font-medium text-muted-foreground">
        {uiText(" Code", undefined, undefined, uiLocale)}
      </span>
    </span>
  );
}

type SortableProjectHandleProps = Pick<
  ReturnType<typeof useSortable>,
  "attributes" | "listeners" | "setActivatorNodeRef"
>;

function ProjectSortMenu({
  projectSortOrder,
  threadSortOrder,
  projectGroupingMode,
  threadPreviewCount,
  onProjectSortOrderChange,
  onThreadSortOrderChange,
  onProjectGroupingModeChange,
  onThreadPreviewCountChange,
}: {
  projectSortOrder: SidebarProjectSortOrder;
  threadSortOrder: SidebarThreadSortOrder;
  projectGroupingMode: SidebarProjectGroupingMode;
  threadPreviewCount: SidebarThreadPreviewCount;
  onProjectSortOrderChange: (sortOrder: SidebarProjectSortOrder) => void;
  onThreadSortOrderChange: (sortOrder: SidebarThreadSortOrder) => void;
  onProjectGroupingModeChange: (mode: SidebarProjectGroupingMode) => void;
  onThreadPreviewCountChange: (count: SidebarThreadPreviewCount) => void;
}) {
  const uiLocale = useUiLocale();
  const uiPresentation = useUiPresentation(UI_PRESENTATION_SOURCES);

  const handleThreadPreviewCountChange = useCallback(
    (nextValue: number | null) => {
      if (nextValue === null) {
        return;
      }

      const clampedValue = clampSidebarThreadPreviewCount(nextValue);
      if (clampedValue !== threadPreviewCount) {
        onThreadPreviewCountChange(clampedValue);
      }
    },
    [onThreadPreviewCountChange, threadPreviewCount],
  );

  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger className="inline-flex size-5 cursor-pointer items-center justify-center rounded-sm text-subtle-foreground transition-colors duration-(--duration-fast) hover:bg-accent hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring" />
          }
        >
          <ArrowUpDownIcon className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup side="right">
          {uiText("Sidebar options", undefined, undefined, uiLocale)}
        </TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" side="bottom" className="min-w-52">
        <MenuGroup>
          <div className="px-2 py-1 sm:text-xs font-medium text-muted-foreground">
            {uiText("Sort projects", undefined, undefined, uiLocale)}
          </div>
          <MenuRadioGroup
            value={projectSortOrder}
            onValueChange={(value) => {
              onProjectSortOrderChange(value as SidebarProjectSortOrder);
            }}
          >
            {(
              Object.entries(uiPresentation.SIDEBAR_SORT_LABELS) as Array<
                [SidebarProjectSortOrder, string]
              >
            ).map(([value, label]) => (
              <MenuRadioItem key={value} value={value} className="min-h-7 py-1 sm:text-xs">
                {label}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
        <MenuGroup>
          <div className="px-2 pt-2 pb-1 sm:text-xs font-medium text-muted-foreground">
            {uiText("Sort chats", undefined, undefined, uiLocale)}
          </div>
          <MenuRadioGroup
            value={threadSortOrder}
            onValueChange={(value) => {
              onThreadSortOrderChange(value as SidebarThreadSortOrder);
            }}
          >
            {(
              Object.entries(uiPresentation.SIDEBAR_THREAD_SORT_LABELS) as Array<
                [SidebarThreadSortOrder, string]
              >
            ).map(([value, label]) => (
              <MenuRadioItem key={value} value={value} className="min-h-7 py-1 sm:text-xs">
                {label}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
        <MenuGroup>
          <div className="px-2 pt-2 pb-1 text-muted-foreground sm:text-xs font-medium">
            {uiText("Visible chats", undefined, undefined, uiLocale)}
          </div>
          <div className="px-2 py-1">
            <NumberField
              aria-label={uiText("Visible chat count", undefined, undefined, uiLocale)}
              className="w-28 gap-0"
              max={MAX_SIDEBAR_THREAD_PREVIEW_COUNT}
              min={MIN_SIDEBAR_THREAD_PREVIEW_COUNT}
              onValueChange={handleThreadPreviewCountChange}
              size="sm"
              step={1}
              value={threadPreviewCount}
            >
              <NumberFieldGroup className="h-7 rounded-md sm:h-6.5">
                <NumberFieldDecrement
                  aria-label={uiText("Decrease visible chat count", undefined, undefined, uiLocale)}
                  className="px-2 sm:px-2 [&_svg]:size-3.5"
                />
                <NumberFieldInput
                  aria-label={uiText("Visible chat count", undefined, undefined, uiLocale)}
                  className="h-7 w-9 grow-0 px-0 text-xs leading-7 sm:h-6.5 sm:leading-6.5"
                  inputMode="numeric"
                  onKeyDownCapture={(event) => {
                    event.stopPropagation();
                  }}
                />
                <NumberFieldIncrement
                  aria-label={uiText("Increase visible chat count", undefined, undefined, uiLocale)}
                  className="px-2 sm:px-2 [&_svg]:size-3.5"
                />
              </NumberFieldGroup>
            </NumberField>
          </div>
        </MenuGroup>
        <MenuSeparator />
        <MenuGroup>
          <div className="px-2 pt-2 pb-1 font-medium text-muted-foreground sm:text-xs">
            {uiText("Group projects", undefined, undefined, uiLocale)}
          </div>
          <MenuRadioGroup
            value={projectGroupingMode}
            onValueChange={(value) => {
              if (value === "repository" || value === "repository_path" || value === "separate") {
                onProjectGroupingModeChange(value);
              }
            }}
          >
            {(
              Object.entries(uiPresentation.PROJECT_GROUPING_MODE_LABELS) as Array<
                [SidebarProjectGroupingMode, string]
              >
            ).map(([value, label]) => (
              <MenuRadioItem key={value} value={value} className="min-h-7 py-1 sm:text-xs">
                {label}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}

function SortableProjectItem({
  projectId,
  disabled = false,
  children,
}: {
  projectId: string;
  disabled?: boolean;
  children: (handleProps: SortableProjectHandleProps) => React.ReactNode;
}) {
  const {
    attributes,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
    isDragging,
    isOver,
  } = useSortable({ id: projectId, disabled });
  return (
    <li
      ref={setNodeRef}
      style={{
        transform: CSS.Translate.toString(transform),
        transition,
      }}
      className={`group/menu-item relative rounded-md ${
        isDragging ? "z-20 opacity-80" : ""
      } ${isOver && !isDragging ? "ring-1 ring-primary/40" : ""}`}
      data-sidebar="menu-item"
      data-slot="sidebar-menu-item"
    >
      {children({ attributes, listeners, setActivatorNodeRef })}
    </li>
  );
}

/** The release-stage chip beside the wordmark. Sentence case at the 11px
 * minimum keeps it readable instead of an 8px letter-spaced caption. */
const SIDEBAR_STAGE_BADGE_CLASS_NAME =
  "rounded-full bg-muted px-1.5 py-0.5 text-2xs leading-none font-medium text-subtle-foreground";

export const SidebarChromeHeader = memo(function SidebarChromeHeader({
  isElectron,
}: {
  isElectron: boolean;
}) {
  const uiLocale = useUiLocale();

  const { isMobile } = useSidebar();
  const isMacDesktop = isElectron && !isMobile && isMacPlatform(navigator.platform);
  const wordmark = (
    <div
      className={cn(
        "flex min-w-0 flex-1 items-center gap-2",
        isMacDesktop && "@container/sidebar-header",
      )}
    >
      <SidebarTriggerWithUnreadDot className={cn(isMacDesktop && "order-last ml-auto")} />
      <Tooltip>
        <TooltipTrigger
          render={
            // In Electron the wordmark shares the frameless title bar, so
            // keep it non-interactive: a <span> inherits the header's
            // `drag-region` (letting the whole title band drag the window),
            // whereas an <a>/<button> would opt out via `.drag-region a`.
            // On the web it stays a link back to the threads home.
            isElectron ? (
              <span
                className={cn(
                  "ml-1 flex min-w-0 items-center gap-1",
                  isMacDesktop && "ml-0 flex-1 overflow-hidden",
                )}
              >
                <CafeCodeWordmark className={cn(isMacDesktop && "min-w-0 shrink truncate")} />
                <span
                  className={cn(
                    SIDEBAR_STAGE_BADGE_CLASS_NAME,
                    isMacDesktop && "shrink-0 @max-[150px]/sidebar-header:hidden",
                  )}
                >
                  {APP_STAGE_LABEL}
                </span>
              </span>
            ) : (
              <Link
                aria-label={uiText("Go to chats", undefined, undefined, uiLocale)}
                className="ml-1 flex min-w-0 flex-1 cursor-pointer items-center gap-1 rounded-md outline-hidden ring-ring transition-colors hover:text-foreground focus-visible:ring-2"
                to="/"
              >
                <CafeCodeWordmark />
                <span className={SIDEBAR_STAGE_BADGE_CLASS_NAME}>{APP_STAGE_LABEL}</span>
              </Link>
            )
          }
        />
        <TooltipPopup side="bottom" sideOffset={2}>
          <UiMessage message={"Version <slot1></slot1>"} slots={{ slot1: APP_VERSION }} />
        </TooltipPopup>
      </Tooltip>
    </div>
  );
  const persistentHeaderClassName = "relative z-30 transition-[padding] duration-200 ease-linear";

  return isElectron ? (
    <SidebarHeader
      data-mac-titlebar={isMacDesktop}
      className={cn(
        persistentHeaderClassName,
        "drag-region h-[max(var(--app-titlebar-height),2.75rem)] flex-row items-center gap-2 px-4 py-0 pl-[90px] wco:h-[max(var(--app-titlebar-height),2.75rem,env(titlebar-area-height,40px))] wco:pl-[calc(env(titlebar-area-x)+1em)]",
      )}
    >
      {wordmark}
    </SidebarHeader>
  ) : (
    <SidebarHeader
      className={cn(persistentHeaderClassName, "gap-3 px-3 py-2 sm:gap-2.5 sm:px-4 sm:py-3")}
    >
      {wordmark}
    </SidebarHeader>
  );
});

const SidebarChromeFooter = memo(function SidebarChromeFooter() {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (loc) => loc.pathname });
  const { isMobile, setOpenMobile } = useSidebar();
  const atriumEnabled = useSettings((settings) => settings.ambianceAtriumEnabled);
  const atriumOpen = useTaskAtriumStore((state) => state.open);
  const setAtriumOpen = useTaskAtriumStore((state) => state.setOpen);
  const isOnSettingsFooter = pathname.startsWith("/settings");
  const handleAtriumClick = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
    setAtriumOpen(true);
  }, [isMobile, setAtriumOpen, setOpenMobile]);
  const handleSettingsClick = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
    void navigate({ to: "/settings" });
  }, [isMobile, navigate, setOpenMobile]);

  return (
    <SidebarFooter className="p-2">
      <SidebarProviderUpdatePill />
      <SidebarUpdatePill />
      <SidebarFooterNavigation
        settingsTrailing={<SidebarStatusBadge />}
        atriumEnabled={atriumEnabled}
        atriumOpen={atriumOpen}
        settingsActive={isOnSettingsFooter}
        onOpenAtrium={handleAtriumClick}
        onOpenSettings={handleSettingsClick}
      />
    </SidebarFooter>
  );
});

interface SidebarProjectsContentProps {
  sidebarMode: "desk" | "projects";
  onSidebarModeChange: (mode: "desk" | "projects") => void;
  standaloneContent: React.ReactNode;
  deskContent: React.ReactNode;
  primaryEnvironmentBootstrapped: boolean;
  bootstrappedEnvironmentIds: ReadonlySet<string>;
  showArm64IntelBuildWarning: boolean;
  arm64IntelBuildWarningDescription: string | null;
  desktopUpdateButtonAction: DesktopUpdateButtonAction;
  desktopUpdateButtonDisabled: boolean;
  handleDesktopUpdateButtonClick: () => void;
  desktopDebugEnabled: boolean;
  projectSortOrder: SidebarProjectSortOrder;
  threadSortOrder: SidebarThreadSortOrder;
  projectGroupingMode: SidebarProjectGroupingMode;
  threadPreviewCount: SidebarThreadPreviewCount;
  updateSettings: ReturnType<typeof useUpdateSettings>["updateSettings"];
  openAddProject: () => void;
  showAddProjectHint: boolean;
  onDismissAddProjectHint: () => void;
  isManualProjectSorting: boolean;
  projectDnDSensors: ReturnType<typeof useSensors>;
  projectCollisionDetection: CollisionDetection;
  handleProjectDragStart: (event: DragStartEvent) => void;
  handleProjectDragEnd: (event: DragEndEvent) => void;
  handleProjectDragCancel: (event: DragCancelEvent) => void;
  handleNewThread: ReturnType<typeof useNewThreadHandler>["handleNewThread"];
  archiveThread: ReturnType<typeof useThreadActions>["archiveThread"];
  deleteThread: ReturnType<typeof useThreadActions>["deleteThread"];
  duplicateThread: ReturnType<typeof useThreadActions>["duplicateThread"];
  sortedProjects: readonly SidebarProjectSnapshot[];
  expandedThreadListsByProject: ReadonlySet<string>;
  activeRouteProjectKey: string | null;
  routeThreadKey: string | null;
  newThreadShortcutLabel: string | null;
  commandPaletteShortcutLabel: string | null;
  threadJumpLabelByKey: ReadonlyMap<string, string>;
  attachThreadListAutoAnimateRef: (node: HTMLElement | null) => void;
  expandThreadListForProject: (projectKey: string) => void;
  collapseThreadListForProject: (projectKey: string) => void;
  dragInProgressRef: React.RefObject<boolean>;
  suppressProjectClickAfterDragRef: React.RefObject<boolean>;
  suppressProjectClickForContextMenuRef: React.RefObject<boolean>;
  attachProjectListAutoAnimateRef: (node: HTMLElement | null) => void;
  projectsLength: number;
  showSidebarSearch: boolean;
  showSidebarMascot: boolean;
  sidebarBrandImage: SidebarBrandImageAsset | null;
  showSidebarAttribution: boolean;
}

const SIDEBAR_MODE_OPTIONS = [
  {
    value: "desk",
    get label() {
      return uiText("Desk");
    },
  },
  {
    value: "projects",
    get label() {
      return uiText("Projects");
    },
  },
] as const;

const SidebarProjectsContent = memo(function SidebarProjectsContent(
  props: SidebarProjectsContentProps,
) {
  const uiLocale = useUiLocale();
  const uiPresentation = useUiPresentation(UI_PRESENTATION_SOURCES);

  const {
    sidebarMode,
    onSidebarModeChange,
    standaloneContent,
    deskContent,
    primaryEnvironmentBootstrapped,
    bootstrappedEnvironmentIds,
    showArm64IntelBuildWarning,
    arm64IntelBuildWarningDescription,
    desktopUpdateButtonAction,
    desktopUpdateButtonDisabled,
    handleDesktopUpdateButtonClick,
    desktopDebugEnabled,
    projectSortOrder,
    threadSortOrder,
    projectGroupingMode,
    threadPreviewCount,
    updateSettings,
    openAddProject,
    showAddProjectHint,
    onDismissAddProjectHint,
    isManualProjectSorting,
    projectDnDSensors,
    projectCollisionDetection,
    handleProjectDragStart,
    handleProjectDragEnd,
    handleProjectDragCancel,
    handleNewThread,
    archiveThread,
    deleteThread,
    duplicateThread,
    sortedProjects,
    expandedThreadListsByProject,
    activeRouteProjectKey,
    routeThreadKey,
    newThreadShortcutLabel,
    commandPaletteShortcutLabel,
    threadJumpLabelByKey,
    attachThreadListAutoAnimateRef,
    expandThreadListForProject,
    collapseThreadListForProject,
    dragInProgressRef,
    suppressProjectClickAfterDragRef,
    suppressProjectClickForContextMenuRef,
    attachProjectListAutoAnimateRef,
    projectsLength,
    showSidebarSearch,
    showSidebarMascot,
    sidebarBrandImage,
    showSidebarAttribution,
  } = props;

  const addProjectHintAnchorRef = useRef<HTMLButtonElement>(null);
  const sidebarBrandImageSrc = useSidebarBrandImageSrc(sidebarBrandImage);

  const handleProjectSortOrderChange = useCallback(
    (sortOrder: SidebarProjectSortOrder) => {
      updateSettings({ sidebarProjectSortOrder: sortOrder });
    },
    [updateSettings],
  );
  const handleThreadSortOrderChange = useCallback(
    (sortOrder: SidebarThreadSortOrder) => {
      updateSettings({ sidebarThreadSortOrder: sortOrder });
    },
    [updateSettings],
  );
  const handleProjectGroupingModeChange = useCallback(
    (groupingMode: SidebarProjectGroupingMode) => {
      updateSettings({ sidebarProjectGroupingMode: groupingMode });
    },
    [updateSettings],
  );
  const handleThreadPreviewCountChange = useCallback(
    (count: SidebarThreadPreviewCount) => {
      updateSettings({ sidebarThreadPreviewCount: count });
    },
    [updateSettings],
  );

  return (
    <SidebarContent className="min-h-full gap-0">
      <div className="mx-3 mt-2">
        {/* ToggleGroup keeps the existing group + pressed-button semantics. */}
        <SegmentedControl
          aria-label={uiText("Sidebar view", undefined, undefined, uiLocale)}
          size="sm"
          value={sidebarMode}
          onValueChange={onSidebarModeChange}
          options={uiPresentation.SIDEBAR_MODE_OPTIONS}
          className="w-full [&>[data-segment]]:flex-1"
        />
      </div>
      {showSidebarSearch ? (
        <SidebarGroup className="px-2 pt-2 pb-1">
          <SidebarMenu>
            <SidebarMenuItem>
              <CommandDialogTrigger
                render={
                  <SidebarMenuButton
                    size="sm"
                    className="gap-2 px-2 py-1.5 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-0"
                    data-testid="command-palette-trigger"
                  />
                }
              >
                <SearchIcon className="size-3.5" />
                <span className="flex-1 truncate text-left text-ui">
                  {uiText("Search", undefined, undefined, uiLocale)}
                </span>
                {commandPaletteShortcutLabel ? (
                  <Kbd className="h-4 min-w-0 rounded-sm px-1.5 text-2xs">
                    {commandPaletteShortcutLabel}
                  </Kbd>
                ) : null}
              </CommandDialogTrigger>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
      ) : null}
      {showArm64IntelBuildWarning && arm64IntelBuildWarningDescription ? (
        <SidebarGroup className="px-2 pt-2 pb-0">
          <Alert variant="warning" className="rounded-xl">
            <TriangleAlertIcon />
            <AlertTitle>
              {uiText("Intel build on Apple Silicon", undefined, undefined, uiLocale)}
            </AlertTitle>
            <AlertDescription>{arm64IntelBuildWarningDescription}</AlertDescription>
            {desktopUpdateButtonAction !== "none" ? (
              <AlertAction>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={desktopUpdateButtonDisabled}
                  onClick={handleDesktopUpdateButtonClick}
                >
                  {desktopUpdateButtonAction === "download"
                    ? uiText("Download ARM build", undefined, undefined, uiLocale)
                    : desktopUpdateButtonAction === "manual"
                      ? uiText("View ARM build", undefined, undefined, uiLocale)
                      : uiText("Install ARM build", undefined, undefined, uiLocale)}
                </Button>
              </AlertAction>
            ) : null}
          </Alert>
        </SidebarGroup>
      ) : null}
      {sidebarMode === "desk" ? (
        deskContent
      ) : (
        <>
          {standaloneContent}
          <SidebarGroup className="px-2 py-2">
            <div className="mb-1 flex items-center justify-between pl-2 pr-1.5">
              <span className="label-overline">
                {uiText("Projects", undefined, undefined, uiLocale)}
              </span>
              <div className="flex items-center gap-1">
                <ProjectSortMenu
                  projectSortOrder={projectSortOrder}
                  threadSortOrder={threadSortOrder}
                  projectGroupingMode={projectGroupingMode}
                  threadPreviewCount={threadPreviewCount}
                  onProjectSortOrderChange={handleProjectSortOrderChange}
                  onThreadSortOrderChange={handleThreadSortOrderChange}
                  onProjectGroupingModeChange={handleProjectGroupingModeChange}
                  onThreadPreviewCountChange={handleThreadPreviewCountChange}
                />
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        ref={addProjectHintAnchorRef}
                        type="button"
                        aria-label={uiText("Add project", undefined, undefined, uiLocale)}
                        data-testid="sidebar-add-project-trigger"
                        className="inline-flex size-5 cursor-pointer items-center justify-center rounded-sm text-subtle-foreground transition-colors duration-(--duration-fast) hover:bg-accent hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
                        onClick={openAddProject}
                      />
                    }
                  >
                    <FolderPlusIcon className="size-3.5" />
                  </TooltipTrigger>
                  <TooltipPopup side="right">
                    {uiText("Add project", undefined, undefined, uiLocale)}
                  </TooltipPopup>
                </Tooltip>
                <FirstRunHint
                  anchor={addProjectHintAnchorRef}
                  message={uiText(
                    "Start by adding your first project",
                    undefined,
                    undefined,
                    uiLocale,
                  )}
                  onDismiss={onDismissAddProjectHint}
                  open={showAddProjectHint}
                  testId="add-project-hint"
                />
              </div>
            </div>

            {isManualProjectSorting ? (
              <DndContext
                sensors={projectDnDSensors}
                collisionDetection={projectCollisionDetection}
                modifiers={[restrictToVerticalAxis, restrictToFirstScrollableAncestor]}
                onDragStart={handleProjectDragStart}
                onDragEnd={handleProjectDragEnd}
                onDragCancel={handleProjectDragCancel}
              >
                <SidebarMenu>
                  <SortableContext
                    items={sortedProjects.map((project) => project.projectKey)}
                    strategy={verticalListSortingStrategy}
                  >
                    {sortedProjects.map((project) => (
                      <SortableProjectItem key={project.projectKey} projectId={project.projectKey}>
                        {(dragHandleProps) => (
                          <SidebarProjectItem
                            project={project}
                            bootstrappedEnvironmentIds={bootstrappedEnvironmentIds}
                            desktopDebugEnabled={desktopDebugEnabled}
                            isThreadListExpanded={expandedThreadListsByProject.has(
                              project.projectKey,
                            )}
                            activeRouteThreadKey={
                              activeRouteProjectKey === project.projectKey ? routeThreadKey : null
                            }
                            newThreadShortcutLabel={newThreadShortcutLabel}
                            handleNewThread={handleNewThread}
                            archiveThread={archiveThread}
                            deleteThread={deleteThread}
                            duplicateThread={duplicateThread}
                            threadJumpLabelByKey={threadJumpLabelByKey}
                            attachThreadListAutoAnimateRef={attachThreadListAutoAnimateRef}
                            expandThreadListForProject={expandThreadListForProject}
                            collapseThreadListForProject={collapseThreadListForProject}
                            dragInProgressRef={dragInProgressRef}
                            suppressProjectClickAfterDragRef={suppressProjectClickAfterDragRef}
                            suppressProjectClickForContextMenuRef={
                              suppressProjectClickForContextMenuRef
                            }
                            isManualProjectSorting={isManualProjectSorting}
                            dragHandleProps={dragHandleProps}
                          />
                        )}
                      </SortableProjectItem>
                    ))}
                  </SortableContext>
                </SidebarMenu>
              </DndContext>
            ) : (
              <SidebarMenu ref={attachProjectListAutoAnimateRef}>
                {sortedProjects.map((project) => (
                  <SidebarProjectListRow
                    key={project.projectKey}
                    project={project}
                    bootstrappedEnvironmentIds={bootstrappedEnvironmentIds}
                    desktopDebugEnabled={desktopDebugEnabled}
                    isThreadListExpanded={expandedThreadListsByProject.has(project.projectKey)}
                    activeRouteThreadKey={
                      activeRouteProjectKey === project.projectKey ? routeThreadKey : null
                    }
                    newThreadShortcutLabel={newThreadShortcutLabel}
                    handleNewThread={handleNewThread}
                    archiveThread={archiveThread}
                    deleteThread={deleteThread}
                    duplicateThread={duplicateThread}
                    threadJumpLabelByKey={threadJumpLabelByKey}
                    attachThreadListAutoAnimateRef={attachThreadListAutoAnimateRef}
                    expandThreadListForProject={expandThreadListForProject}
                    collapseThreadListForProject={collapseThreadListForProject}
                    dragInProgressRef={dragInProgressRef}
                    suppressProjectClickAfterDragRef={suppressProjectClickAfterDragRef}
                    suppressProjectClickForContextMenuRef={suppressProjectClickForContextMenuRef}
                    isManualProjectSorting={isManualProjectSorting}
                    dragHandleProps={null}
                  />
                ))}
              </SidebarMenu>
            )}

            {primaryEnvironmentBootstrapped && projectsLength === 0 && (
              <p className="px-3 py-1 text-xs text-subtle-foreground">
                {uiText("No projects yet", undefined, undefined, uiLocale)}
              </p>
            )}
          </SidebarGroup>
        </>
      )}
      {/* Grow spacer pushes the mascot to the bottom of the sidebar on all sizes. */}
      <div aria-hidden="true" className="min-h-6 flex-1" />
      {showSidebarMascot ? (
        <div className="flex shrink-0 flex-col items-center justify-center gap-2 px-4 pt-3 pb-4">
          <img
            alt=""
            aria-hidden="true"
            className="h-32 w-[6.4rem] select-none rounded-2xl object-cover ring-1 ring-border"
            draggable={false}
            height={128}
            sizes={DEFAULT_SIDEBAR_BRAND_IMAGE_SIZES}
            src={sidebarBrandImageSrc}
            srcSet={sidebarBrandImage ? undefined : DEFAULT_SIDEBAR_BRAND_IMAGE_SRC_SET}
            width={102}
          />
          {showSidebarAttribution ? (
            <a
              aria-label={uiText("Cafe Code on GitHub", undefined, undefined, uiLocale)}
              className="text-2xs font-medium text-disabled-foreground underline-offset-2 transition-colors duration-(--duration-fast) hover:text-muted-foreground hover:underline focus-visible:rounded-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
              href="https://github.com/cafeai/cafe-code"
              rel="noreferrer"
              target="_blank"
            >
              {uiText("by cafeai ", undefined, undefined, uiLocale)}
              <span className="opacity-60">{uiText("♡", undefined, undefined, uiLocale)}</span>
            </a>
          ) : null}
        </div>
      ) : null}
    </SidebarContent>
  );
});

export default function Sidebar() {
  const uiLocale = useUiLocale();
  const uiPresentation = useUiPresentation(UI_PRESENTATION_SOURCES);

  const desk = useDeskStore((state) => state.desk);
  const deskDispatch = useDeskStore((state) => state.dispatch);
  const workspaceEnvironmentId = useWorkspaceEnvironmentId();
  const remoteWorkspace = useIsSavedRemoteEnvironment(workspaceEnvironmentId);
  const primaryEnvironmentBootstrapped = useStore((state) =>
    selectBootstrapCompleteForEnvironment(state, workspaceEnvironmentId),
  );
  const bootstrappedEnvironmentIds = useStore(
    useShallow((state) =>
      Object.entries(state.environmentStateById)
        .filter(([, environmentState]) => environmentState.bootstrapComplete)
        .map(([environmentId]) => environmentId),
    ),
  );
  const bootstrappedEnvironmentIdSet = useMemo(
    () => new Set(bootstrappedEnvironmentIds),
    [bootstrappedEnvironmentIds],
  );
  const projects = useWorkspaceProjects();
  const sidebarThreads = useWorkspaceSidebarThreads();
  const projectExpandedById = useUiStateStore((store) => store.projectExpandedById);
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const reorderProjects = useUiStateStore((store) => store.reorderProjects);
  const navigate = useNavigate();
  const pathname = useLocation({ select: (loc) => loc.pathname });
  const isOnSettings = pathname.startsWith("/settings");
  // Crossfade the sidebar body only when the user moves between chats and
  // settings, never on first mount (derived state, settled before commit).
  const [initialIsOnSettings] = useState(isOnSettings);
  const [hasSwappedSettingsNav, setHasSwappedSettingsNav] = useState(false);
  if (!hasSwappedSettingsNav && isOnSettings !== initialIsOnSettings) {
    setHasSwappedSettingsNav(true);
  }
  const navSwapClassName = hasSwappedSettingsNav ? "animate-enter-fade" : undefined;
  const sidebarThreadSortOrder = useSettings((s) => s.sidebarThreadSortOrder);
  const sidebarProjectSortOrder = useSettings((s) => s.sidebarProjectSortOrder);
  const sidebarProjectGroupingMode = useSettings((s) => s.sidebarProjectGroupingMode);
  const projectGroupingSettings = useSettings(selectProjectGroupingSettings);
  const sidebarThreadPreviewCount = useSettings((s) => s.sidebarThreadPreviewCount);
  const showSidebarSearch = useSettings((s) => s.showSidebarSearch);
  const showSidebarMascot = useSettings((s) => s.showSidebarMascot);
  const sidebarBrandImage = useSettings((s) => s.sidebarBrandImage);
  const showSidebarAttribution = useSettings((s) => s.showSidebarAttribution);
  const desktopDebugEnabled = useDesktopDebugEnabled();
  const { updateSettings } = useUpdateSettings();
  const { handleNewThread, handleNewStandaloneChat } = useNewThreadHandler();
  const { archiveThread, deleteThread, duplicateThread } = useThreadActions();
  const { isMobile, setOpenMobile } = useSidebar();
  const routeThreadRef = useParams({
    strict: false,
    select: (params) => resolveThreadRouteRef(params),
  });
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const routeThreadKey = routeThreadRef ? scopedThreadKey(routeThreadRef) : null;
  const keybindings = useServerKeybindings();
  const openAddProjectCommandPalette = useCommandPaletteStore((store) => store.openAddProject);

  const onboardingCompleted = useSettings((s) => s.onboardingCompleted);
  const dismissedFirstRunHints = useSettings((s) => s.dismissedFirstRunHints);
  const showAddProjectHint = shouldShowAddProjectHint({
    onboardingCompleted,
    dismissedHints: dismissedFirstRunHints,
    projectCount: projects.length,
  });
  const dismissAddProjectHint = useCallback(() => {
    updateSettings({
      dismissedFirstRunHints: withDismissedHint(
        dismissedFirstRunHints,
        FIRST_RUN_HINT_KEYS.addFirstProject,
      ),
    });
  }, [dismissedFirstRunHints, updateSettings]);
  const handleOpenAddProject = useCallback(() => {
    dismissAddProjectHint();
    openAddProjectCommandPalette();
  }, [dismissAddProjectHint, openAddProjectCommandPalette]);
  const [expandedThreadListsByProject, setExpandedThreadListsByProject] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const { showThreadJumpHints, updateThreadJumpHintsVisibility } = useThreadJumpHintVisibility();
  const dragInProgressRef = useRef(false);
  const suppressProjectClickAfterDragRef = useRef(false);
  const suppressProjectClickForContextMenuRef = useRef(false);
  const [desktopUpdateState, setDesktopUpdateState] = useState<DesktopUpdateState | null>(null);
  const clearSelection = useThreadSelectionStore((s) => s.clearSelection);
  const setSelectionAnchor = useThreadSelectionStore((s) => s.setAnchor);
  const platform = navigator.platform;
  const shortcutModifiers = useShortcutModifierState();
  const modelPickerOpen = useModelPickerOpen();
  const orderedProjects = useMemo(() => {
    return orderItemsByPreferredIds({
      items: projects,
      preferredIds: projectOrder,
      getId: getProjectOrderKey,
    });
  }, [projectOrder, projects]);

  // Build a mapping from physical project key → logical project key for
  // cross-environment grouping.  Projects that share a repositoryIdentity
  // canonicalKey are treated as one logical project in the sidebar.
  const physicalToLogicalKey = useMemo(() => {
    return buildPhysicalToLogicalProjectKeyMap({
      projects: orderedProjects,
      settings: projectGroupingSettings,
    });
  }, [orderedProjects, projectGroupingSettings]);
  const projectPhysicalKeyByScopedRef = useMemo(
    () =>
      new Map(
        orderedProjects.map((project) => [
          scopedProjectKey(scopeProjectRef(project.environmentId, project.id)),
          derivePhysicalProjectKey(project),
        ]),
      ),
    [orderedProjects],
  );

  const sidebarProjects = useMemo<SidebarProjectSnapshot[]>(() => {
    return buildSidebarProjectSnapshots({
      projects: orderedProjects,
      settings: projectGroupingSettings,
      primaryEnvironmentId: workspaceEnvironmentId,
      resolveEnvironmentLabel: () => null,
    });
  }, [orderedProjects, projectGroupingSettings, workspaceEnvironmentId]);

  const sidebarProjectByKey = useMemo(
    () => new Map(sidebarProjects.map((project) => [project.projectKey, project] as const)),
    [sidebarProjects],
  );
  const sidebarThreadByKey = useMemo(
    () =>
      new Map(
        sidebarThreads.map(
          (thread) =>
            [scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)), thread] as const,
        ),
      ),
    [sidebarThreads],
  );
  // Resolve the active route's project key to a logical key so it matches the
  // sidebar's grouped project entries.
  const activeRouteProjectKey = useMemo(() => {
    if (!routeThreadKey) {
      return null;
    }
    const activeThread = sidebarThreadByKey.get(routeThreadKey);
    if (!activeThread || activeThread.projectId === null) return null;
    const physicalKey =
      projectPhysicalKeyByScopedRef.get(
        scopedProjectKey(scopeProjectRef(activeThread.environmentId, activeThread.projectId)),
      ) ?? scopedProjectKey(scopeProjectRef(activeThread.environmentId, activeThread.projectId));
    return physicalToLogicalKey.get(physicalKey) ?? physicalKey;
  }, [routeThreadKey, sidebarThreadByKey, physicalToLogicalKey, projectPhysicalKeyByScopedRef]);

  // Group threads by logical project key so all threads from grouped projects
  // are displayed together.
  const threadsByProjectKey = useMemo(() => {
    const next = new Map<string, SidebarThreadSummary[]>();
    for (const thread of sidebarThreads) {
      if (thread.projectId === null) continue;
      const physicalKey =
        projectPhysicalKeyByScopedRef.get(
          scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)),
        ) ?? scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId));
      const logicalKey = physicalToLogicalKey.get(physicalKey) ?? physicalKey;
      const existing = next.get(logicalKey);
      if (existing) {
        existing.push(thread);
      } else {
        next.set(logicalKey, [thread]);
      }
    }
    return next;
  }, [sidebarThreads, physicalToLogicalKey, projectPhysicalKeyByScopedRef]);
  const getCurrentSidebarShortcutContext = useCallback(
    () => ({
      modelPickerOpen,
    }),
    [modelPickerOpen],
  );
  const newThreadShortcutLabelOptions = useMemo(
    () => ({
      platform,
      context: {},
    }),
    [platform],
  );
  const newThreadShortcutLabel =
    uiPresentation.shortcutLabelForCommand(
      keybindings,
      "chat.newLocal",
      newThreadShortcutLabelOptions,
    ) ??
    uiPresentation.shortcutLabelForCommand(keybindings, "chat.new", newThreadShortcutLabelOptions);

  const navigateToThread = useCallback(
    (threadRef: ScopedThreadRef) => {
      if (useThreadSelectionStore.getState().selectedThreadKeys.size > 0) {
        clearSelection();
      }
      setSelectionAnchor(scopedThreadKey(threadRef));
      if (isMobile) {
        setOpenMobile(false);
      }
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
      });
    },
    [clearSelection, isMobile, navigate, setOpenMobile, setSelectionAnchor],
  );

  const navigateToDeskTarget = useCallback(
    (target: ThreadRouteTarget) => {
      // Desk rows and shortcuts already select the target in the Desk store.
      // DeskWorkspace serializes the resulting route write, so issuing another
      // navigation here could let an older route echo steal a newer selection.
      // Keep only the Sidebar's selection/mobile presentation bookkeeping.
      clearSelection();
      if (target.kind === "server") {
        setSelectionAnchor(scopedThreadKey(target.threadRef));
      }
      if (isMobile) setOpenMobile(false);
    },
    [clearSelection, isMobile, setOpenMobile, setSelectionAnchor],
  );
  const changeSidebarMode = useCallback(
    (mode: "desk" | "projects") => {
      deskDispatch({ type: "sidebarMode", mode });
    },
    [deskDispatch],
  );
  const createStandaloneChat = useCallback(() => {
    // Capture and validate the local environment/group in the existing handler.
    // Never manufacture a project or start a provider during navigation.
    void handleNewStandaloneChat()
      .then(() => {
        clearSelection();
        if (isMobile) setOpenMobile(false);
      })
      .catch(() => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: uiText("Could not create chat", undefined, undefined, uiLocale),
            description: remoteWorkspace
              ? uiText(
                  "Reconnect to a compatible Cafe server before trying again.",
                  undefined,
                  undefined,
                  uiLocale,
                )
              : uiText(
                  "Reconnect to a compatible local Cafe environment before trying again.",
                  undefined,
                  undefined,
                  uiLocale,
                ),
          }),
        );
      });
  }, [clearSelection, handleNewStandaloneChat, isMobile, setOpenMobile, remoteWorkspace, uiLocale]);
  const openStandaloneTarget = useCallback(
    (target: ThreadRouteTarget, preview = true) => {
      deskDispatch({
        type: "open",
        target,
        preview: preview && getClientSettings().chatClickBehavior === "preview",
      });
      const currentDesk = useDeskStore.getState().desk;
      const openedGroup = currentDesk.groups[currentDesk.activeGroupId];
      if (openedGroup?.activeTabKey !== deskTabKey(target)) {
        // A capped/invalid open is view-only and must not falsely update selection
        // or bypass the Desk route owner by navigating to an unadmitted target.
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: uiText("Could not open chat", undefined, undefined, uiLocale),
            description: uiText("Close an open tab and try again.", undefined, undefined, uiLocale),
          }),
        );
        return;
      }
      navigateToDeskTarget(target);
    },
    [deskDispatch, navigateToDeskTarget, uiLocale],
  );

  const projectDnDSensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 6 },
    }),
  );
  const projectCollisionDetection = useCallback<CollisionDetection>((args) => {
    const pointerCollisions = pointerWithin(args);
    if (pointerCollisions.length > 0) {
      return pointerCollisions;
    }

    return closestCorners(args);
  }, []);

  const handleProjectDragEnd = useCallback(
    (event: DragEndEvent) => {
      if (sidebarProjectSortOrder !== "manual") {
        dragInProgressRef.current = false;
        return;
      }
      dragInProgressRef.current = false;
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const activeProject = sidebarProjects.find((project) => project.projectKey === active.id);
      const overProject = sidebarProjects.find((project) => project.projectKey === over.id);
      if (!activeProject || !overProject) return;
      const activeMemberKeys = activeProject.memberProjects.map(
        (member) => member.physicalProjectKey,
      );
      const overMemberKeys = overProject.memberProjects.map((member) => member.physicalProjectKey);
      reorderProjects(activeMemberKeys, overMemberKeys);
    },
    [sidebarProjectSortOrder, reorderProjects, sidebarProjects],
  );

  const handleProjectDragStart = useCallback(
    (_event: DragStartEvent) => {
      if (sidebarProjectSortOrder !== "manual") {
        return;
      }
      dragInProgressRef.current = true;
      suppressProjectClickAfterDragRef.current = true;
    },
    [sidebarProjectSortOrder],
  );

  const handleProjectDragCancel = useCallback((_event: DragCancelEvent) => {
    dragInProgressRef.current = false;
  }, []);

  const animatedProjectListsRef = useRef(new WeakSet<HTMLElement>());
  const attachProjectListAutoAnimateRef = useCallback((node: HTMLElement | null) => {
    if (!node || animatedProjectListsRef.current.has(node)) {
      return;
    }
    autoAnimate(node, SIDEBAR_LIST_ANIMATION_OPTIONS);
    animatedProjectListsRef.current.add(node);
  }, []);

  const animatedThreadListsRef = useRef(new WeakSet<HTMLElement>());
  const attachThreadListAutoAnimateRef = useCallback((node: HTMLElement | null) => {
    if (!node || animatedThreadListsRef.current.has(node)) {
      return;
    }
    autoAnimate(node, SIDEBAR_LIST_ANIMATION_OPTIONS);
    animatedThreadListsRef.current.add(node);
  }, []);

  const visibleThreads = useMemo(
    () => sidebarThreads.filter((thread) => thread.archivedAt === null),
    [sidebarThreads],
  );
  const standaloneCatalog = useMemo(
    () =>
      buildStandaloneCatalog({
        threads: sidebarThreads,
        sortOrder: sidebarThreadSortOrder,
      }),
    [sidebarThreads, sidebarThreadSortOrder],
  );
  const [standaloneCatalogExpanded, setStandaloneCatalogExpanded] = useState(false);
  const sortedProjects = useMemo(() => {
    const sortableProjects = sidebarProjects.map((project) => ({
      ...project,
      id: project.projectKey,
    }));
    const sortableThreads = visibleThreads.flatMap((thread) => {
      if (thread.projectId === null) return [];
      const physicalKey =
        projectPhysicalKeyByScopedRef.get(
          scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)),
        ) ?? scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId));
      return [
        {
          ...thread,
          projectId: (physicalToLogicalKey.get(physicalKey) ?? physicalKey) as ProjectId,
        },
      ];
    });
    return sortProjectsForSidebar(
      sortableProjects,
      sortableThreads,
      sidebarProjectSortOrder,
    ).flatMap((project) => {
      const resolvedProject = sidebarProjectByKey.get(project.id);
      return resolvedProject ? [resolvedProject] : [];
    });
  }, [
    sidebarProjectSortOrder,
    physicalToLogicalKey,
    projectPhysicalKeyByScopedRef,
    sidebarProjectByKey,
    sidebarProjects,
    visibleThreads,
  ]);
  const isManualProjectSorting = sidebarProjectSortOrder === "manual";
  const visibleSidebarThreadKeys = useMemo(
    () => [
      ...(standaloneCatalogExpanded
        ? standaloneCatalog
        : standaloneCatalog.slice(0, sidebarThreadPreviewCount)
      ).map((entry) => entry.key),
      ...sortedProjects.flatMap((project) => {
        const projectThreads = sortThreads(
          (threadsByProjectKey.get(project.projectKey) ?? []).filter(
            (thread) => thread.archivedAt === null,
          ),
          sidebarThreadSortOrder,
        );
        const projectExpanded = projectExpandedById[project.projectKey] ?? true;
        const activeThreadKey = routeThreadKey ?? undefined;
        const pinnedCollapsedThread =
          !projectExpanded && activeThreadKey
            ? (projectThreads.find(
                (thread) =>
                  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) ===
                  activeThreadKey,
              ) ?? null)
            : null;
        const shouldShowThreadPanel = projectExpanded || pinnedCollapsedThread !== null;
        if (!shouldShowThreadPanel) {
          return [];
        }
        const isThreadListExpanded = expandedThreadListsByProject.has(project.projectKey);
        const hasOverflowingThreads = projectThreads.length > sidebarThreadPreviewCount;
        const previewThreads =
          isThreadListExpanded || !hasOverflowingThreads
            ? projectThreads
            : projectThreads.slice(0, sidebarThreadPreviewCount);
        const renderedThreads = pinnedCollapsedThread ? [pinnedCollapsedThread] : previewThreads;
        return renderedThreads.map((thread) =>
          scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
        );
      }),
    ],
    [
      sidebarThreadSortOrder,
      sidebarThreadPreviewCount,
      expandedThreadListsByProject,
      projectExpandedById,
      routeThreadKey,
      sortedProjects,
      threadsByProjectKey,
      standaloneCatalog,
      standaloneCatalogExpanded,
    ],
  );
  const threadJumpCommandByKey = useMemo(() => {
    const mapping = new Map<string, NonNullable<ReturnType<typeof threadJumpCommandForIndex>>>();
    for (const [visibleThreadIndex, threadKey] of visibleSidebarThreadKeys.entries()) {
      const jumpCommand = threadJumpCommandForIndex(visibleThreadIndex);
      if (!jumpCommand) {
        return mapping;
      }
      mapping.set(threadKey, jumpCommand);
    }

    return mapping;
  }, [visibleSidebarThreadKeys]);
  const threadJumpThreadKeys = useMemo(
    () => [...threadJumpCommandByKey.keys()],
    [threadJumpCommandByKey],
  );
  const sidebarShortcutContext = useMemo(
    () => ({
      modelPickerOpen,
    }),
    [modelPickerOpen],
  );
  const threadJumpLabelByKey = useMemo(
    () =>
      uiPresentation.buildThreadJumpLabelMap({
        keybindings,
        platform,
        threadJumpCommandByKey,
      }),
    [keybindings, platform, threadJumpCommandByKey, uiPresentation],
  );
  const shouldShowThreadJumpHintsNow = shouldShowThreadJumpHintsForModifiers(
    shortcutModifiers,
    keybindings,
    {
      platform,
      context: sidebarShortcutContext,
    },
  );
  const visibleThreadJumpLabelByKey = showThreadJumpHints
    ? threadJumpLabelByKey
    : EMPTY_THREAD_JUMP_LABELS;
  const orderedSidebarThreadKeys = visibleSidebarThreadKeys;

  useEffect(() => {
    updateThreadJumpHintsVisibility(shouldShowThreadJumpHintsNow);
  }, [shouldShowThreadJumpHintsNow, updateThreadJumpHintsVisibility]);

  useEffect(() => {
    const onWindowKeyDown = (event: globalThis.KeyboardEvent) => {
      const shortcutContext = getCurrentSidebarShortcutContext();

      if (event.defaultPrevented || event.repeat) {
        return;
      }

      const command = resolveShortcutCommand(event, keybindings, {
        platform,
        context: shortcutContext,
      });
      const traversalDirection = threadTraversalDirectionFromCommand(command);
      if (desk.sidebarMode === "desk" && !isOnSettings) {
        // The visible Desk order, including unsent local drafts, is the
        // navigation authority here. Hidden project catalog ordering must
        // not unexpectedly replace the active pane when a shortcut is used.
        const group = desk.groups[desk.activeGroupId];
        const tabs = group?.tabs ?? [];
        const jumpIndex = threadJumpIndexFromCommand(command ?? "");
        const targetKey =
          traversalDirection !== null
            ? resolveAdjacentThreadId({
                threadIds: tabs,
                currentThreadId: routeTarget
                  ? deskTabKey(routeTarget)
                  : (group?.activeTabKey ?? null),
                direction: traversalDirection,
              })
            : jumpIndex !== null
              ? tabs[jumpIndex]
              : null;
        if (traversalDirection !== null || jumpIndex !== null) {
          const target = targetKey ? desk.targets[targetKey] : null;
          if (target && targetKey) {
            event.preventDefault();
            event.stopPropagation();
            deskDispatch({ type: "select", tabKey: targetKey });
            navigateToDeskTarget(target);
          }
          return;
        }
      }
      if (traversalDirection !== null) {
        const targetThreadKey = resolveAdjacentThreadId({
          threadIds: orderedSidebarThreadKeys,
          currentThreadId: routeThreadKey,
          direction: traversalDirection,
        });
        if (!targetThreadKey) {
          return;
        }
        const targetThread = sidebarThreadByKey.get(targetThreadKey);
        if (!targetThread) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();
        navigateToThread(scopeThreadRef(targetThread.environmentId, targetThread.id));
        return;
      }

      const jumpIndex = threadJumpIndexFromCommand(command ?? "");
      if (jumpIndex === null) {
        return;
      }

      const targetThreadKey = threadJumpThreadKeys[jumpIndex];
      if (!targetThreadKey) {
        return;
      }
      const targetThread = sidebarThreadByKey.get(targetThreadKey);
      if (!targetThread) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      navigateToThread(scopeThreadRef(targetThread.environmentId, targetThread.id));
    };

    window.addEventListener("keydown", onWindowKeyDown);

    return () => {
      window.removeEventListener("keydown", onWindowKeyDown);
    };
  }, [
    desk,
    deskDispatch,
    getCurrentSidebarShortcutContext,
    isOnSettings,
    keybindings,
    navigateToDeskTarget,
    navigateToThread,
    orderedSidebarThreadKeys,
    platform,
    routeThreadKey,
    routeTarget,
    sidebarThreadByKey,
    threadJumpThreadKeys,
  ]);

  useEffect(() => {
    const onMouseDown = (event: globalThis.MouseEvent) => {
      if (!useThreadSelectionStore.getState().hasSelection()) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (!shouldClearThreadSelectionOnMouseDown(target)) return;
      clearSelection();
    };

    window.addEventListener("mousedown", onMouseDown);
    return () => {
      window.removeEventListener("mousedown", onMouseDown);
    };
  }, [clearSelection]);

  useEffect(() => {
    if (!isElectron) return;
    const bridge = window.desktopBridge;
    if (
      !bridge ||
      typeof bridge.getUpdateState !== "function" ||
      typeof bridge.onUpdateState !== "function"
    ) {
      return;
    }

    let disposed = false;
    let receivedSubscriptionUpdate = false;
    const unsubscribe = bridge.onUpdateState((nextState) => {
      if (disposed) return;
      receivedSubscriptionUpdate = true;
      setDesktopUpdateState(nextState);
    });

    void bridge
      .getUpdateState()
      .then((nextState) => {
        if (disposed || receivedSubscriptionUpdate) return;
        setDesktopUpdateState(nextState);
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  const desktopUpdateButtonDisabled = isDesktopUpdateButtonDisabled(desktopUpdateState);
  const desktopUpdateButtonAction = desktopUpdateState
    ? resolveDesktopUpdateButtonAction(desktopUpdateState)
    : "none";
  const showArm64IntelBuildWarning =
    isElectron && shouldShowArm64IntelBuildWarning(desktopUpdateState);
  const arm64IntelBuildWarningDescription =
    desktopUpdateState && showArm64IntelBuildWarning
      ? uiPresentation.getArm64IntelBuildWarningDescription(desktopUpdateState)
      : null;
  const commandPaletteShortcutLabel = uiPresentation.shortcutLabelForCommand(
    keybindings,
    "commandPalette.toggle",
    newThreadShortcutLabelOptions,
  );
  const handleDesktopUpdateButtonClick = useCallback(() => {
    const bridge = window.desktopBridge;
    if (!bridge || !desktopUpdateState) return;
    if (desktopUpdateButtonDisabled || desktopUpdateButtonAction === "none") return;

    if (desktopUpdateButtonAction === "manual") {
      void bridge
        .openExternal(getDesktopUpdateReleaseUrl(desktopUpdateState.availableVersion))
        .then((opened) => {
          if (opened) return;
          toastManager.add({
            type: "error",
            title: uiText("Could not open release", undefined, undefined, uiLocale),
            description: uiText(
              "Open the Cafe Code releases page in your browser to install the DMG.",
              undefined,
              undefined,
              uiLocale,
            ),
          });
        })
        .catch(() => {
          toastManager.add({
            type: "error",
            title: uiText("Could not open release", undefined, undefined, uiLocale),
            description: uiText(
              "Open the Cafe Code releases page in your browser to install the DMG.",
              undefined,
              undefined,
              uiLocale,
            ),
          });
        });
      return;
    }

    if (desktopUpdateButtonAction === "download") {
      void bridge
        .downloadUpdate()
        .then((result) => {
          if (result.completed) {
            toastManager.add({
              type: "success",
              title: uiText("Update downloaded", undefined, undefined, uiLocale),
              description: uiText(
                "Restart the app from the update button to install it.",
                undefined,
                undefined,
                uiLocale,
              ),
            });
          }
          if (!shouldToastDesktopUpdateActionResult(result)) return;
          const actionError = getDesktopUpdateActionError(result);
          if (!actionError) return;
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: uiText("Could not download update", undefined, undefined, uiLocale),
              description: actionError,
            }),
          );
        })
        .catch((error) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: uiText("Could not start update download", undefined, undefined, uiLocale),
              description:
                error instanceof Error
                  ? error.message
                  : uiText("An unexpected error occurred.", undefined, undefined, uiLocale),
            }),
          );
        });
      return;
    }

    if (desktopUpdateButtonAction === "install") {
      const confirmed = window.confirm(
        uiPresentation.getDesktopUpdateInstallConfirmationMessage(desktopUpdateState),
      );
      if (!confirmed) return;
      void bridge
        .installUpdate()
        .then((result) => {
          if (!shouldToastDesktopUpdateActionResult(result)) return;
          const actionError = getDesktopUpdateActionError(result);
          if (!actionError) return;
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: uiText("Could not install update", undefined, undefined, uiLocale),
              description: actionError,
            }),
          );
        })
        .catch((error) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: uiText("Could not install update", undefined, undefined, uiLocale),
              description:
                error instanceof Error
                  ? error.message
                  : uiText("An unexpected error occurred.", undefined, undefined, uiLocale),
            }),
          );
        });
    }
  }, [
    desktopUpdateButtonAction,
    desktopUpdateButtonDisabled,
    desktopUpdateState,
    uiLocale,
    uiPresentation,
  ]);

  const expandThreadListForProject = useCallback((projectKey: string) => {
    setExpandedThreadListsByProject((current) => {
      if (current.has(projectKey)) return current;
      const next = new Set(current);
      next.add(projectKey);
      return next;
    });
  }, []);

  const collapseThreadListForProject = useCallback((projectKey: string) => {
    setExpandedThreadListsByProject((current) => {
      if (!current.has(projectKey)) return current;
      const next = new Set(current);
      next.delete(projectKey);
      return next;
    });
  }, []);

  return (
    <>
      <SidebarChromeHeader isElectron={isElectron} />
      <WorkspaceEnvironmentSelector />

      {isOnSettings ? (
        <div className={cn("flex min-h-0 flex-1 flex-col", navSwapClassName)}>
          <SettingsSidebarNav pathname={pathname} />
        </div>
      ) : (
        <>
          <div className={cn("flex min-h-0 flex-1 flex-col", navSwapClassName)}>
            <SidebarProjectsContent
              sidebarMode={desk.sidebarMode}
              onSidebarModeChange={changeSidebarMode}
              standaloneContent={
                <SidebarStandaloneChats
                  onNewChat={createStandaloneChat}
                  newChatDisabled={!primaryEnvironmentBootstrapped}
                  entries={standaloneCatalog}
                  previewCount={sidebarThreadPreviewCount}
                  expanded={standaloneCatalogExpanded}
                  activeTarget={routeTarget ?? null}
                  jumpLabelByKey={visibleThreadJumpLabelByKey}
                  onOpen={openStandaloneTarget}
                  onExpansionChange={setStandaloneCatalogExpanded}
                />
              }
              deskContent={
                <DeskSidebar
                  onNavigate={navigateToDeskTarget}
                  onNewChat={createStandaloneChat}
                  newChatDisabled={!primaryEnvironmentBootstrapped}
                />
              }
              primaryEnvironmentBootstrapped={primaryEnvironmentBootstrapped}
              bootstrappedEnvironmentIds={bootstrappedEnvironmentIdSet}
              showArm64IntelBuildWarning={showArm64IntelBuildWarning}
              arm64IntelBuildWarningDescription={arm64IntelBuildWarningDescription}
              desktopUpdateButtonAction={desktopUpdateButtonAction}
              desktopUpdateButtonDisabled={desktopUpdateButtonDisabled}
              handleDesktopUpdateButtonClick={handleDesktopUpdateButtonClick}
              desktopDebugEnabled={desktopDebugEnabled}
              projectSortOrder={sidebarProjectSortOrder}
              threadSortOrder={sidebarThreadSortOrder}
              projectGroupingMode={sidebarProjectGroupingMode}
              threadPreviewCount={sidebarThreadPreviewCount}
              updateSettings={updateSettings}
              openAddProject={handleOpenAddProject}
              showAddProjectHint={showAddProjectHint}
              onDismissAddProjectHint={dismissAddProjectHint}
              isManualProjectSorting={isManualProjectSorting}
              projectDnDSensors={projectDnDSensors}
              projectCollisionDetection={projectCollisionDetection}
              handleProjectDragStart={handleProjectDragStart}
              handleProjectDragEnd={handleProjectDragEnd}
              handleProjectDragCancel={handleProjectDragCancel}
              handleNewThread={handleNewThread}
              archiveThread={archiveThread}
              deleteThread={deleteThread}
              duplicateThread={duplicateThread}
              sortedProjects={sortedProjects}
              expandedThreadListsByProject={expandedThreadListsByProject}
              activeRouteProjectKey={activeRouteProjectKey}
              routeThreadKey={routeThreadKey}
              newThreadShortcutLabel={newThreadShortcutLabel}
              commandPaletteShortcutLabel={commandPaletteShortcutLabel}
              threadJumpLabelByKey={visibleThreadJumpLabelByKey}
              attachThreadListAutoAnimateRef={attachThreadListAutoAnimateRef}
              expandThreadListForProject={expandThreadListForProject}
              collapseThreadListForProject={collapseThreadListForProject}
              dragInProgressRef={dragInProgressRef}
              suppressProjectClickAfterDragRef={suppressProjectClickAfterDragRef}
              suppressProjectClickForContextMenuRef={suppressProjectClickForContextMenuRef}
              attachProjectListAutoAnimateRef={attachProjectListAutoAnimateRef}
              projectsLength={projects.length}
              showSidebarSearch={showSidebarSearch}
              showSidebarMascot={showSidebarMascot}
              sidebarBrandImage={sidebarBrandImage}
              showSidebarAttribution={showSidebarAttribution}
            />

            <SidebarSeparator />
          </div>
          <SidebarChromeFooter />
        </>
      )}
    </>
  );
}

// Finite source-owned labels/helpers only; no received or user data.
const UI_PRESENTATION_SOURCES = {
  PROJECT_GROUPING_MODE_LABELS,
  SIDEBAR_MODE_OPTIONS,
  SIDEBAR_SORT_LABELS,
  SIDEBAR_THREAD_SORT_LABELS,
  buildSidebarThreadContextMenuItems,
  buildThreadJumpLabelMap,
  formatProjectMemberActionLabel,
  formatRelativeTimeLabel,
  getArm64IntelBuildWarningDescription,
  getDesktopUpdateInstallConfirmationMessage,
  prStatusIndicator,
  projectGroupingModeDescription,
  shortcutLabelForCommand,
  summarizeHiddenThreadStatuses,
};
