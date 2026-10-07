import * as React from "react";
import type { SidebarProjectSortOrder, SidebarThreadSortOrder } from "@cafecode/contracts/settings";
import {
  getThreadSortTimestamp,
  sortThreads,
  toSortableTimestamp,
  type ThreadSortInput,
} from "../lib/threadSort";
import type { SidebarThreadSummary, Thread } from "../types";
import { cn, isMacPlatform } from "../lib/utils";
import { isLatestTurnSettled } from "../session-logic";

export const THREAD_SELECTION_SAFE_SELECTOR = "[data-thread-item], [data-thread-selection-safe]";
export const THREAD_JUMP_HINT_SHOW_DELAY_MS = 100;
const PROJECT_DELETE_REQUIRES_FORCE_MARKER = "cannot be deleted without force=true";

export function shouldInsetContentSidebarTrigger(input: {
  readonly isElectronHost: boolean;
  readonly isMobile: boolean;
  readonly platform: string;
}): boolean {
  return input.isElectronHost && !input.isMobile && isMacPlatform(input.platform);
}

export type SidebarNewThreadEnvMode = "local" | "worktree";
type SidebarProject = {
  id: string;
  name: string;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
};

export type ThreadTraversalDirection = "previous" | "next";

export type SidebarThreadContextMenuAction =
  | "rename"
  | "fork"
  | "move"
  | "copy-path"
  | "copy-thread-id"
  | "repair-thread"
  | "delete";

export interface SidebarThreadContextMenuItem {
  readonly id: SidebarThreadContextMenuAction;
  readonly label: string;
  readonly disabled?: boolean;
  readonly destructive?: boolean;
}

export function buildSidebarThreadContextMenuItems(input: {
  readonly debugEnabled: boolean;
  readonly repairRunning: boolean;
  readonly forkDisabled?: boolean;
}): ReadonlyArray<SidebarThreadContextMenuItem> {
  const items: SidebarThreadContextMenuItem[] = [
    { id: "rename", label: "Rename chat" },
    { id: "fork", label: "Fork chat", disabled: input.forkDisabled === true },
    { id: "move", label: "Move chat…" },
    { id: "copy-path", label: "Copy path" },
    { id: "copy-thread-id", label: "Copy chat ID" },
  ];

  if (input.debugEnabled) {
    items.push({
      id: "repair-thread",
      label: "Attempt repair from provider history",
      disabled: input.repairRunning,
    });
  }

  items.push({ id: "delete", label: "Move to Recycle Bin", destructive: true });
  return items;
}

/**
 * The single chat-status vocabulary (docs/style-guide.md §2). Sidebar rows,
 * project rows, Desk tabs, the Desk list and the command palette all render
 * this pill so "working", "needs you", "unread" and "idle" look identical
 * everywhere: running uses the accent colour, attention is amber, an unseen
 * completion is green, an unseen failure is red, and an idle chat has no dot.
 */
export interface ThreadStatusPill {
  label:
    | "Working"
    | "Connecting"
    | "Completed"
    | "Failed"
    | "Pending Approval"
    | "Awaiting Input"
    | "Plan Ready";
  colorClass: string;
  dotClass: string;
  pulse: boolean;
}

const THREAD_STATUS_PRIORITY: Record<ThreadStatusPill["label"], number> = {
  "Pending Approval": 6,
  "Awaiting Input": 5,
  Failed: 4,
  Working: 3,
  Connecting: 3,
  "Plan Ready": 2,
  Completed: 1,
};

const RUNNING_STATUS_CLASSES = {
  colorClass: "text-primary",
  dotClass: "bg-status-running",
} as const;
const ATTENTION_STATUS_CLASSES = {
  colorClass: "text-status-attention-foreground",
  dotClass: "bg-status-attention",
} as const;

/**
 * One presentation for each status. Read/unread navigation derives the label
 * below; the Atrium also retains terminal work after it has been read, but
 * uses these same colours and pulse rather than maintaining its own palette.
 */
const THREAD_STATUS_PILLS: Record<ThreadStatusPill["label"], ThreadStatusPill> = {
  Working: { label: "Working", ...RUNNING_STATUS_CLASSES, pulse: true },
  Connecting: { label: "Connecting", ...RUNNING_STATUS_CLASSES, pulse: true },
  "Pending Approval": { label: "Pending Approval", ...ATTENTION_STATUS_CLASSES, pulse: false },
  "Awaiting Input": { label: "Awaiting Input", ...ATTENTION_STATUS_CLASSES, pulse: false },
  "Plan Ready": { label: "Plan Ready", ...ATTENTION_STATUS_CLASSES, pulse: false },
  Completed: {
    label: "Completed",
    colorClass: "text-status-done-foreground",
    dotClass: "bg-status-done",
    pulse: false,
  },
  Failed: {
    label: "Failed",
    colorClass: "text-status-error-foreground",
    dotClass: "bg-status-error",
    pulse: false,
  },
};

export function getThreadStatusPill(label: ThreadStatusPill["label"]): ThreadStatusPill {
  return THREAD_STATUS_PILLS[label];
}

type ThreadStatusInput = Pick<
  SidebarThreadSummary,
  | "hasActionableProposedPlan"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "interactionMode"
  | "latestTurn"
  | "session"
> & {
  lastVisitedAt?: string | undefined;
};

export interface ThreadJumpHintVisibilityController {
  sync: (shouldShow: boolean) => void;
  dispose: () => void;
}

export function createThreadJumpHintVisibilityController(input: {
  delayMs: number;
  onVisibilityChange: (visible: boolean) => void;
  setTimeoutFn?: typeof globalThis.setTimeout;
  clearTimeoutFn?: typeof globalThis.clearTimeout;
}): ThreadJumpHintVisibilityController {
  const setTimeoutFn = input.setTimeoutFn ?? globalThis.setTimeout;
  const clearTimeoutFn = input.clearTimeoutFn ?? globalThis.clearTimeout;
  let isVisible = false;
  let timeoutId: NodeJS.Timeout | null = null;

  const clearPendingShow = () => {
    if (timeoutId === null) {
      return;
    }
    clearTimeoutFn(timeoutId);
    timeoutId = null;
  };

  return {
    sync: (shouldShow) => {
      if (!shouldShow) {
        clearPendingShow();
        if (isVisible) {
          isVisible = false;
          input.onVisibilityChange(false);
        }
        return;
      }

      if (isVisible || timeoutId !== null) {
        return;
      }

      timeoutId = setTimeoutFn(() => {
        timeoutId = null;
        isVisible = true;
        input.onVisibilityChange(true);
      }, input.delayMs);
    },
    dispose: () => {
      clearPendingShow();
    },
  };
}

export function isProjectDeleteRequiresForceError(error: unknown): boolean {
  if (typeof error === "object" && error !== null) {
    const record = error as { readonly commandType?: unknown; readonly detail?: unknown };
    if (
      record.commandType === "project.delete" &&
      typeof record.detail === "string" &&
      record.detail.includes(PROJECT_DELETE_REQUIRES_FORCE_MARKER)
    ) {
      return true;
    }
  }

  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : String(error);
  return (
    message.includes("Orchestration command invariant failed (project.delete)") &&
    message.includes(PROJECT_DELETE_REQUIRES_FORCE_MARKER)
  );
}

export function useThreadJumpHintVisibility(): {
  showThreadJumpHints: boolean;
  updateThreadJumpHintsVisibility: (shouldShow: boolean) => void;
} {
  const [showThreadJumpHints, setShowThreadJumpHints] = React.useState(false);
  const controllerRef = React.useRef<ThreadJumpHintVisibilityController | null>(null);

  React.useEffect(() => {
    const controller = createThreadJumpHintVisibilityController({
      delayMs: THREAD_JUMP_HINT_SHOW_DELAY_MS,
      onVisibilityChange: (visible) => {
        setShowThreadJumpHints(visible);
      },
      setTimeoutFn: window.setTimeout.bind(window),
      clearTimeoutFn: window.clearTimeout.bind(window),
    });
    controllerRef.current = controller;

    return () => {
      controller.dispose();
      controllerRef.current = null;
    };
  }, []);

  const updateThreadJumpHintsVisibility = React.useCallback((shouldShow: boolean) => {
    controllerRef.current?.sync(shouldShow);
  }, []);

  return {
    showThreadJumpHints,
    updateThreadJumpHintsVisibility,
  };
}

export function hasUnseenCompletion(thread: ThreadStatusInput): boolean {
  if (!thread.latestTurn?.completedAt) return false;
  const completedAt = Date.parse(thread.latestTurn.completedAt);
  if (Number.isNaN(completedAt)) return false;
  if (!thread.lastVisitedAt) return true;

  const lastVisitedAt = Date.parse(thread.lastVisitedAt);
  if (Number.isNaN(lastVisitedAt)) return true;
  return completedAt > lastVisitedAt;
}

export function shouldClearThreadSelectionOnMouseDown(target: HTMLElement | null): boolean {
  if (target === null) return true;
  return !target.closest(THREAD_SELECTION_SAFE_SELECTOR);
}

export function resolveSidebarNewThreadEnvMode(input: {
  requestedEnvMode?: SidebarNewThreadEnvMode;
  defaultEnvMode: SidebarNewThreadEnvMode;
}): SidebarNewThreadEnvMode {
  return input.requestedEnvMode ?? input.defaultEnvMode;
}

export function resolveSidebarNewThreadSeedContext(input: {
  projectId: string;
  defaultEnvMode: SidebarNewThreadEnvMode;
  activeThread?: {
    projectId: string | null;
    branch: string | null;
    worktreePath: string | null;
  } | null;
  activeDraftThread?: {
    projectId: string | null;
    branch: string | null;
    worktreePath: string | null;
    envMode: SidebarNewThreadEnvMode;
  } | null;
}): {
  branch?: string | null;
  worktreePath?: string | null;
  envMode: SidebarNewThreadEnvMode;
} {
  if (input.defaultEnvMode === "worktree") {
    return {
      envMode: "worktree",
    };
  }

  if (input.activeDraftThread?.projectId === input.projectId) {
    return {
      branch: input.activeDraftThread.branch,
      worktreePath: input.activeDraftThread.worktreePath,
      envMode: input.activeDraftThread.envMode,
    };
  }

  if (input.activeThread?.projectId === input.projectId) {
    return {
      branch: input.activeThread.branch,
      worktreePath: input.activeThread.worktreePath,
      envMode: input.activeThread.worktreePath ? "worktree" : "local",
    };
  }

  return {
    envMode: input.defaultEnvMode,
  };
}

export function orderItemsByPreferredIds<TItem, TId>(input: {
  items: readonly TItem[];
  preferredIds: readonly TId[];
  getId: (item: TItem) => TId;
}): TItem[] {
  const { getId, items, preferredIds } = input;
  if (preferredIds.length === 0) {
    return [...items];
  }

  const itemsById = new Map(items.map((item) => [getId(item), item] as const));
  const preferredIdSet = new Set(preferredIds);
  const emittedPreferredIds = new Set<TId>();
  const ordered = preferredIds.flatMap((id) => {
    if (emittedPreferredIds.has(id)) {
      return [];
    }
    const item = itemsById.get(id);
    if (!item) {
      return [];
    }
    emittedPreferredIds.add(id);
    return [item];
  });
  const remaining = items.filter((item) => !preferredIdSet.has(getId(item)));
  return [...ordered, ...remaining];
}

export function getVisibleSidebarThreadIds<TThreadId>(
  renderedProjects: readonly {
    shouldShowThreadPanel?: boolean;
    renderedThreadIds: readonly TThreadId[];
  }[],
): TThreadId[] {
  return renderedProjects.flatMap((renderedProject) =>
    renderedProject.shouldShowThreadPanel === false ? [] : renderedProject.renderedThreadIds,
  );
}

export function resolveAdjacentThreadId<T>(input: {
  threadIds: readonly T[];
  currentThreadId: T | null;
  direction: ThreadTraversalDirection;
}): T | null {
  const { currentThreadId, direction, threadIds } = input;

  if (threadIds.length === 0) {
    return null;
  }

  if (currentThreadId === null) {
    return direction === "previous" ? (threadIds.at(-1) ?? null) : (threadIds[0] ?? null);
  }

  const currentIndex = threadIds.indexOf(currentThreadId);
  if (currentIndex === -1) {
    return null;
  }

  if (direction === "previous") {
    return currentIndex > 0 ? (threadIds[currentIndex - 1] ?? null) : null;
  }

  return currentIndex < threadIds.length - 1 ? (threadIds[currentIndex + 1] ?? null) : null;
}

export function isContextMenuPointerDown(input: {
  button: number;
  ctrlKey: boolean;
  isMac: boolean;
}): boolean {
  if (input.button === 2) return true;
  return input.isMac && input.button === 0 && input.ctrlKey;
}

export function resolveThreadRowClassName(input: {
  isActive: boolean;
  isSelected: boolean;
}): string {
  const baseClassName =
    "h-7 w-full translate-x-0 cursor-pointer justify-start px-2 text-left select-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring";

  if (input.isSelected && input.isActive) {
    return cn(
      baseClassName,
      "bg-primary/22 text-foreground font-medium hover:bg-primary/26 hover:text-foreground dark:bg-primary/30 dark:hover:bg-primary/36",
    );
  }

  if (input.isSelected) {
    return cn(
      baseClassName,
      "bg-primary/15 text-foreground hover:bg-primary/19 hover:text-foreground dark:bg-primary/22 dark:hover:bg-primary/28",
    );
  }

  if (input.isActive) {
    // The sidebar stylesheet adds the shared accent wash for the open chat in
    // both themes (index.css, `.cafe-thread-sidebar ... [data-active]`).
    return cn(
      baseClassName,
      "bg-sidebar-accent text-foreground font-medium hover:bg-sidebar-accent hover:text-foreground",
    );
  }

  return cn(baseClassName, "text-muted-foreground hover:bg-accent hover:text-foreground");
}

export function resolveThreadStatusPill(input: {
  thread: ThreadStatusInput;
}): ThreadStatusPill | null {
  const { thread } = input;

  if (thread.hasPendingApprovals) {
    return getThreadStatusPill("Pending Approval");
  }

  if (thread.hasPendingUserInput) {
    return getThreadStatusPill("Awaiting Input");
  }

  if (thread.session?.status === "running") {
    return getThreadStatusPill("Working");
  }

  if (thread.session?.status === "connecting") {
    return getThreadStatusPill("Connecting");
  }

  const hasPlanReadyPrompt =
    !thread.hasPendingUserInput &&
    thread.interactionMode === "plan" &&
    isLatestTurnSettled(thread.latestTurn, thread.session) &&
    thread.hasActionableProposedPlan;
  if (hasPlanReadyPrompt) {
    return getThreadStatusPill("Plan Ready");
  }

  if (hasUnseenCompletion(thread)) {
    // An unseen turn that ended in error is surfaced as a failure rather than
    // an ordinary unread completion; both clear once the chat is viewed.
    if (thread.latestTurn?.state === "error") {
      return getThreadStatusPill("Failed");
    }
    return getThreadStatusPill("Completed");
  }

  return null;
}

export function resolveProjectStatusIndicator(
  statuses: ReadonlyArray<ThreadStatusPill | null>,
): ThreadStatusPill | null {
  let highestPriorityStatus: ThreadStatusPill | null = null;

  for (const status of statuses) {
    if (status === null) continue;
    if (
      highestPriorityStatus === null ||
      THREAD_STATUS_PRIORITY[status.label] > THREAD_STATUS_PRIORITY[highestPriorityStatus.label]
    ) {
      highestPriorityStatus = status;
    }
  }

  return highestPriorityStatus;
}

/**
 * Short, count-aware phrases for the collapsed overflow toggle. The full
 * status label stays available through each row once the list is expanded.
 */
const HIDDEN_THREAD_STATUS_PHRASES: Record<
  ThreadStatusPill["label"],
  { readonly one: string; readonly other: string }
> = {
  "Pending Approval": { one: "needs approval", other: "need approval" },
  "Awaiting Input": { one: "needs input", other: "need input" },
  Working: { one: "working", other: "working" },
  Connecting: { one: "connecting", other: "connecting" },
  "Plan Ready": { one: "plan ready", other: "plans ready" },
  Failed: { one: "failed", other: "failed" },
  Completed: { one: "unread", other: "unread" },
};

export interface HiddenThreadStatusSummary {
  /** Pill whose dot/color represents the summarized group. */
  readonly status: ThreadStatusPill;
  readonly count: number;
  /** Visible summary text, e.g. "1 needs approval" or "2 working". */
  readonly text: string;
}

/**
 * Summarizes chats hidden behind a collapsed sidebar list by their most
 * urgent status, using the same priority as the collapsed-project dot.
 *
 * The "updated" sort follows each chat's latest user message rather than
 * provider activity, so a long-running turn, or a later approval/input
 * request, can sink below the preview count. Working and Connecting share a
 * priority and are counted together; the group is presented as working when
 * any member is actually running.
 */
export function summarizeHiddenThreadStatuses(
  statuses: ReadonlyArray<ThreadStatusPill | null>,
): HiddenThreadStatusSummary | null {
  const highestPriorityStatus = resolveProjectStatusIndicator(statuses);
  if (highestPriorityStatus === null) {
    return null;
  }
  const priority = THREAD_STATUS_PRIORITY[highestPriorityStatus.label];
  const group = statuses.filter(
    (status): status is ThreadStatusPill =>
      status !== null && THREAD_STATUS_PRIORITY[status.label] === priority,
  );
  const status = group.find((member) => member.label === "Working") ?? highestPriorityStatus;
  const phrases = HIDDEN_THREAD_STATUS_PHRASES[status.label];
  return {
    status,
    count: group.length,
    text: `${group.length} ${group.length === 1 ? phrases.one : phrases.other}`,
  };
}

export function getVisibleThreadsForProject<T extends Pick<Thread, "id">>(input: {
  threads: readonly T[];
  activeThreadId: T["id"] | undefined;
  isThreadListExpanded: boolean;
  previewLimit: number;
}): {
  hasHiddenThreads: boolean;
  visibleThreads: T[];
  hiddenThreads: T[];
} {
  const { activeThreadId, isThreadListExpanded, previewLimit, threads } = input;
  const hasHiddenThreads = threads.length > previewLimit;

  if (!hasHiddenThreads || isThreadListExpanded) {
    return {
      hasHiddenThreads,
      hiddenThreads: [],
      visibleThreads: [...threads],
    };
  }

  const previewThreads = threads.slice(0, previewLimit);
  if (!activeThreadId || previewThreads.some((thread) => thread.id === activeThreadId)) {
    return {
      hasHiddenThreads: true,
      hiddenThreads: threads.slice(previewLimit),
      visibleThreads: previewThreads,
    };
  }

  const activeThread = threads.find((thread) => thread.id === activeThreadId);
  if (!activeThread) {
    return {
      hasHiddenThreads: true,
      hiddenThreads: threads.slice(previewLimit),
      visibleThreads: previewThreads,
    };
  }

  const visibleThreadIds = new Set([...previewThreads, activeThread].map((thread) => thread.id));

  return {
    hasHiddenThreads: true,
    hiddenThreads: threads.filter((thread) => !visibleThreadIds.has(thread.id)),
    visibleThreads: threads.filter((thread) => visibleThreadIds.has(thread.id)),
  };
}

export function getFallbackThreadIdAfterDelete<
  T extends Pick<Thread, "id" | "projectId" | "createdAt" | "updatedAt"> & ThreadSortInput,
>(input: {
  threads: readonly T[];
  deletedThreadId: T["id"];
  sortOrder: SidebarThreadSortOrder;
  deletedThreadIds?: ReadonlySet<T["id"]>;
}): T["id"] | null {
  const { deletedThreadId, deletedThreadIds, sortOrder, threads } = input;
  const deletedThread = threads.find((thread) => thread.id === deletedThreadId);
  if (!deletedThread) {
    return null;
  }

  return (
    sortThreads(
      threads.filter(
        (thread) =>
          thread.projectId === deletedThread.projectId &&
          thread.id !== deletedThreadId &&
          !deletedThreadIds?.has(thread.id),
      ),
      sortOrder,
    )[0]?.id ?? null
  );
}
export function getProjectSortTimestamp(
  project: SidebarProject,
  projectThreads: readonly ThreadSortInput[],
  sortOrder: Exclude<SidebarProjectSortOrder, "manual">,
): number {
  if (projectThreads.length > 0) {
    return projectThreads.reduce(
      (latest, thread) => Math.max(latest, getThreadSortTimestamp(thread, sortOrder)),
      Number.NEGATIVE_INFINITY,
    );
  }

  if (sortOrder === "created_at") {
    return toSortableTimestamp(project.createdAt) ?? Number.NEGATIVE_INFINITY;
  }
  return toSortableTimestamp(project.updatedAt ?? project.createdAt) ?? Number.NEGATIVE_INFINITY;
}

export function sortProjectsForSidebar<
  TProject extends SidebarProject,
  TThread extends Pick<Thread, "projectId" | "createdAt" | "updatedAt"> & ThreadSortInput,
>(
  projects: readonly TProject[],
  threads: readonly TThread[],
  sortOrder: SidebarProjectSortOrder,
): TProject[] {
  if (sortOrder === "manual") {
    return [...projects];
  }

  const threadsByProjectId = new Map<string, TThread[]>();
  for (const thread of threads) {
    // Standalone chats are catalog entries, never synthetic project members.
    if (thread.projectId === null) continue;
    const existing = threadsByProjectId.get(thread.projectId) ?? [];
    existing.push(thread);
    threadsByProjectId.set(thread.projectId, existing);
  }

  return [...projects].toSorted((left, right) => {
    const rightTimestamp = getProjectSortTimestamp(
      right,
      threadsByProjectId.get(right.id) ?? [],
      sortOrder,
    );
    const leftTimestamp = getProjectSortTimestamp(
      left,
      threadsByProjectId.get(left.id) ?? [],
      sortOrder,
    );
    const byTimestamp =
      rightTimestamp === leftTimestamp ? 0 : rightTimestamp > leftTimestamp ? 1 : -1;
    if (byTimestamp !== 0) return byTimestamp;
    return left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
  });
}
