import {
  MAX_TASK_ATRIUM_ERROR_DISMISSALS,
  type EnvironmentId,
  type OrchestrationLatestTurn,
  type OrchestrationSessionStatus,
  type OrchestrationThreadActivity,
  type TaskAtriumErrorDismissal,
  type ThreadId,
  type TurnId,
} from "@cafecode/contracts";

import type { AppState } from "../../store";

/**
 * Data derivation for the Task Atrium.
 *
 * Everything here is read from projections the ambiance layer already reads —
 * `sidebarThreadSummaryById`, `activityIdsByThreadId`, `activityByThreadId` and
 * `projectById`. Like the weather layer this is renderer-only: it never
 * synthesizes lifecycle truth and nothing here feeds back into orchestration.
 *
 * Both first-party providers describe subagent work with the same canonical
 * item type. Claude's `Task` / `*agent*` tools and Codex's `subAgentActivity`
 * and `collab_agent_tool_call` items all arrive as
 * `payload.itemType === "collab_agent_tool_call"`, with the human-readable
 * detail in `payload.detail` — "explore: mapping call sites" from Claude,
 * "Started /root/tests" from Codex. That one field is what the subagent rows
 * render, so both providers are represented without special-casing either.
 */

/** How far back through a thread's activity to look for subagent items. */
const ACTIVITY_SCAN_LIMIT = 120;
/** Rows shown per card before the remainder is counted instead. */
export const MAX_SUBAGENT_ROWS = 3;
/**
 * Cards floated before the remainder collapses into the overflow strip. The cap
 * is applied by the view, not here, so it lands *after* the provider filter —
 * capping first would hide threads the filter was meant to reveal.
 */
export const MAX_ATRIUM_CARDS = 6;
/** A finished thread stays on the wall this long so completions are visible. */
const RECENTLY_DONE_MS = 3 * 60 * 1000;
/**
 * How long a failure stays on the wall.
 *
 * The Atrium answers "what is going on right now". A thread that failed days
 * ago is history, not current work, and leaving it pinned there forever made
 * the board read as permanently broken. Dismissal clears a failure early; this
 * makes sure one is never required just to stop seeing stale ones.
 */
const RECENTLY_ERRORED_MS = 12 * 60 * 60 * 1000;

export type AtriumSubagent = {
  id: string;
  /** Subagent type (Claude) or agent path (Codex), when one was reported. */
  label: string;
  detail: string;
  running: boolean;
};

export type AtriumCardState = "holding" | "running" | "error" | "done";

export type AtriumCard = {
  key: string;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  title: string;
  provider: string;
  projectName: string;
  state: AtriumCardState;
  /** Provider-vocabulary label for what the thread is doing right now. */
  activityLabel: string;
  activityDetail: string;
  /** Epoch ms the current turn started, for the elapsed readout. */
  startedAt: number | null;
  subagents: AtriumSubagent[];
  extraSubagents: number;
  /** Exact terminal failure that the presentation-only clear action dismisses. */
  errorDismissal: TaskAtriumErrorDismissal | null;
};

export type AtriumSnapshot = {
  /** Every card, sorted. The view filters and caps. */
  cards: AtriumCard[];
  runningCount: number;
  holdingCount: number;
  errorCount: number;
  subagentCount: number;
  /** Live thread count per provider, over all cards, for the filter pills. */
  providerCounts: Array<[provider: string, count: number]>;
};

export const EMPTY_ATRIUM: AtriumSnapshot = {
  cards: [],
  runningCount: 0,
  holdingCount: 0,
  errorCount: 0,
  subagentCount: 0,
  providerCounts: [],
};

function activityPayloadField(
  activity: OrchestrationThreadActivity | undefined,
  field: string,
): string | undefined {
  const payload = activity?.payload;
  if (typeof payload !== "object" || payload === null) return undefined;
  const value = (payload as Record<string, unknown>)[field];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isSubagentActivity(activity: OrchestrationThreadActivity | undefined): boolean {
  return activityPayloadField(activity, "itemType") === "collab_agent_tool_call";
}

/**
 * Split a provider detail line into a short label and the rest.
 * Claude reports "explore: mapping call sites"; Codex reports "Started /root".
 */
function splitSubagentDetail(detail: string): { label: string; detail: string } {
  const colon = detail.indexOf(":");
  if (colon > 0 && colon <= 40) {
    const label = detail.slice(0, colon).trim();
    const rest = detail.slice(colon + 1).trim();
    if (label.length > 0 && rest.length > 0) return { label, detail: rest };
  }
  const space = detail.indexOf(" ");
  if (space > 0 && space <= 14) {
    return { label: detail.slice(0, space).trim(), detail: detail.slice(space + 1).trim() };
  }
  return { label: "subagent", detail };
}

/** Strip the " started" suffix the ingestion layer appends to live items. */
function cleanActivityLabel(summary: string): string {
  return summary.replace(/\s+started$/i, "").trim();
}

function collectSubagents(
  activityIds: readonly string[] | undefined,
  activityById: Record<string, OrchestrationThreadActivity> | undefined,
): { rows: AtriumSubagent[]; total: number } {
  if (!activityIds || !activityById) return { rows: [], total: 0 };

  const scan = activityIds.slice(Math.max(0, activityIds.length - ACTIVITY_SCAN_LIMIT));
  // Keyed by itemId so a started/completed pair collapses into one row rather
  // than showing the same subagent twice.
  const byItem = new Map<string, AtriumSubagent>();

  for (const id of scan) {
    const activity = activityById[id];
    if (!isSubagentActivity(activity) || !activity) continue;
    const itemId = activityPayloadField(activity, "itemId") ?? activity.id;
    const detailRaw =
      activityPayloadField(activity, "detail") ?? cleanActivityLabel(activity.summary);
    const split = splitSubagentDetail(detailRaw);
    byItem.set(itemId, {
      id: itemId,
      label: split.label,
      detail: split.detail,
      running: activity.kind === "tool.started",
    });
  }

  const all = [...byItem.values()];
  // Live subagents first; a finished one is context, a running one is the point.
  all.sort((a, b) => Number(b.running) - Number(a.running));
  return { rows: all.slice(0, MAX_SUBAGENT_ROWS), total: all.length };
}

function toEpoch(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stateRank(state: AtriumCardState): number {
  // Anything waiting on a person sorts to the front, then live work.
  switch (state) {
    case "holding":
      return 0;
    case "error":
      return 1;
    case "running":
      return 2;
    default:
      return 3;
  }
}

const LIVE_STATUSES: ReadonlySet<OrchestrationSessionStatus> = new Set([
  "starting",
  "running",
] as const);

/**
 * Settings retain at most one dismissed occurrence per scoped thread. JSON
 * tuple encoding avoids delimiter collisions because ids are user-importable
 * strings rather than values whose character set should be guessed here.
 */
function errorDismissalScopeKey(
  dismissal: Pick<TaskAtriumErrorDismissal, "environmentId" | "threadId">,
): string {
  return JSON.stringify([dismissal.environmentId, dismissal.threadId]);
}

function isSameErrorDismissal(
  left: TaskAtriumErrorDismissal,
  right: TaskAtriumErrorDismissal,
): boolean {
  if (left.environmentId !== right.environmentId || left.threadId !== right.threadId) {
    return false;
  }
  // The session projection can enter `error` before the corresponding turn
  // projection settles. Treat the turn id as authoritative so that timestamp
  // drift between those two events cannot resurrect a failure the user just
  // cleared. A turnless provider/session failure has no durable occurrence id,
  // so its transition timestamp is the stable fallback.
  if (left.turnId !== null || right.turnId !== null) {
    return left.turnId === right.turnId;
  }
  return left.observedAt === right.observedAt;
}

/**
 * Merge current failure watermarks into persisted settings while keeping the
 * write bounded. Replacing by scoped thread means a later failure supersedes
 * the old dismissal instead of growing this list for the lifetime of a busy
 * thread. Insertion order keeps the most recently cleared records when the
 * defensive cap is reached.
 */
export function mergeTaskAtriumErrorDismissals(
  existing: ReadonlyArray<TaskAtriumErrorDismissal>,
  current: ReadonlyArray<TaskAtriumErrorDismissal>,
): TaskAtriumErrorDismissal[] {
  const byScope = new Map<string, TaskAtriumErrorDismissal>();
  for (const dismissal of [...existing, ...current]) {
    const key = errorDismissalScopeKey(dismissal);
    // Delete first so replacing an existing thread moves its new occurrence to
    // the end, where it survives bounded retention ahead of stale entries.
    byScope.delete(key);
    byScope.set(key, dismissal);
  }
  return [...byScope.values()].slice(-MAX_TASK_ATRIUM_ERROR_DISMISSALS);
}

/**
 * Build the Atrium snapshot from store state. `now` is injected so callers can
 * drive the elapsed readouts from one clock and tests stay deterministic.
 */
/**
 * Identity of one failure occurrence, shared by the Atrium and the in-thread
 * error banner so that acknowledging a failure in either place clears it in
 * both. Prefer the turn's immutable lifecycle timestamps when the turn itself
 * failed; otherwise use the session error transition. A later failure receives
 * a new identity and becomes visible again on its own.
 */
export function buildThreadErrorDismissal(input: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  session: { activeTurnId?: TurnId | undefined; updatedAt?: string | undefined } | null;
  latestTurn: OrchestrationLatestTurn | null;
  summary: { updatedAt?: string | undefined; createdAt: string };
}): TaskAtriumErrorDismissal {
  const { environmentId, threadId, session, latestTurn, summary } = input;
  if (latestTurn?.state === "error") {
    return {
      environmentId,
      threadId,
      turnId: latestTurn.turnId,
      observedAt: latestTurn.completedAt ?? latestTurn.startedAt ?? latestTurn.requestedAt,
    };
  }
  return {
    environmentId,
    threadId,
    // Do not attach a session-level failure to an unrelated last completed
    // turn. Only an actively owned turn is authoritative.
    turnId: session?.activeTurnId ?? null,
    observedAt:
      session?.updatedAt ??
      latestTurn?.completedAt ??
      latestTurn?.startedAt ??
      latestTurn?.requestedAt ??
      summary.updatedAt ??
      summary.createdAt,
  };
}

export function selectAtriumSnapshot(
  state: AppState,
  now: number,
  dismissedErrors: ReadonlyArray<TaskAtriumErrorDismissal> = [],
): AtriumSnapshot {
  const cards: AtriumCard[] = [];
  let subagentCount = 0;
  const dismissedErrorByScope = new Map<string, TaskAtriumErrorDismissal>();
  for (const dismissal of dismissedErrors) {
    dismissedErrorByScope.set(errorDismissalScopeKey(dismissal), dismissal);
  }

  for (const [environmentIdRaw, environment] of Object.entries(state.environmentStateById)) {
    if (!environment) continue;
    const environmentId = environmentIdRaw as EnvironmentId;

    for (const threadId of environment.threadIds) {
      const summary = environment.sidebarThreadSummaryById[threadId];
      if (!summary || summary.archivedAt) continue;

      const session = environment.threadSessionById[threadId] ?? summary.session ?? null;
      const status = session?.orchestrationStatus ?? null;
      const holding = summary.hasPendingApprovals || summary.hasPendingUserInput;
      const latestTurn =
        environment.threadTurnStateById[threadId]?.latestTurn ?? summary.latestTurn ?? null;
      const live = status !== null && LIVE_STATUSES.has(status);

      let cardState: AtriumCardState;
      if (holding) cardState = "holding";
      else if (status === "error" || latestTurn?.state === "error") cardState = "error";
      else if (live || latestTurn?.state === "running") cardState = "running";
      else {
        // Keep just-finished work on the wall briefly so completions register.
        const completedAt = toEpoch(latestTurn?.completedAt);
        if (
          latestTurn?.state === "completed" &&
          completedAt !== null &&
          now - completedAt < RECENTLY_DONE_MS
        ) {
          cardState = "done";
        } else {
          continue;
        }
      }

      const errorDismissal =
        cardState === "error"
          ? buildThreadErrorDismissal({ environmentId, threadId, session, latestTurn, summary })
          : null;

      // Age stale failures off the board entirely. Without this, one old
      // crashed thread sits on the wall forever and the only way to clear it is
      // to dismiss it by hand.
      if (errorDismissal !== null) {
        const failedAt = toEpoch(errorDismissal.observedAt);
        if (failedAt !== null && now - failedAt > RECENTLY_ERRORED_MS) continue;
      }

      if (errorDismissal !== null) {
        const dismissed = dismissedErrorByScope.get(errorDismissalScopeKey(errorDismissal));
        if (dismissed !== undefined && isSameErrorDismissal(dismissed, errorDismissal)) {
          continue;
        }
      }

      const activityIds = environment.activityIdsByThreadId[threadId];
      const activityById = environment.activityByThreadId[threadId];
      const lastActivity =
        activityIds && activityIds.length > 0
          ? activityById?.[activityIds[activityIds.length - 1]!]
          : undefined;

      const { rows, total } = collectSubagents(activityIds, activityById);
      subagentCount += rows.filter((row) => row.running).length;

      const project = environment.projectById[summary.projectId];

      cards.push({
        key: `${environmentId}:${threadId}`,
        environmentId,
        threadId,
        title: summary.title.trim().length > 0 ? summary.title : "Untitled thread",
        provider: session?.provider ?? "",
        projectName: project?.name ?? "",
        state: cardState,
        activityLabel: lastActivity ? cleanActivityLabel(lastActivity.summary) : "",
        activityDetail: activityPayloadField(lastActivity, "detail") ?? "",
        startedAt: toEpoch(latestTurn?.startedAt ?? latestTurn?.requestedAt),
        subagents: rows,
        extraSubagents: Math.max(0, total - rows.length),
        errorDismissal,
      });
    }
  }

  cards.sort((a, b) => {
    const byState = stateRank(a.state) - stateRank(b.state);
    if (byState !== 0) return byState;
    return (b.startedAt ?? 0) - (a.startedAt ?? 0);
  });

  const counts = new Map<string, number>();
  for (const card of cards) {
    if (card.provider.length === 0) continue;
    counts.set(card.provider, (counts.get(card.provider) ?? 0) + 1);
  }

  return {
    cards,
    runningCount: cards.filter((card) => card.state === "running").length,
    holdingCount: cards.filter((card) => card.state === "holding").length,
    errorCount: cards.filter((card) => card.state === "error").length,
    subagentCount,
    providerCounts: [...counts.entries()],
  };
}

/** "4m 12s" / "48s" — stable width, no re-render churn from ms precision. */
export function formatElapsed(startedAt: number | null, now: number): string {
  if (startedAt === null) return "";
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}
