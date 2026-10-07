import {
  MAX_TASK_ATRIUM_ERROR_DISMISSALS,
  type EnvironmentId,
  type OrchestrationLatestTurn,
  type OrchestrationSessionStatus,
  type OrchestrationThreadActivity,
  type ProviderTurnConfiguration,
  type TaskAtriumErrorDismissal,
  type ThreadId,
  type TurnId,
} from "@cafecode/contracts";

import type { AppState } from "../../store";
import type { ThreadSession } from "../../types";
import { readTurnConfiguration } from "../../turnConfiguration";
import {
  deriveSubagentActivities,
  type DerivedSubagentActivity,
  type SubagentRunStatus,
  type SubagentRuntimeContext,
} from "../../subagent-activity";

/**
 * Data derivation for the Task Atrium.
 *
 * Everything here is read from projections the ambiance layer already reads —
 * `sidebarThreadSummaryById`, `activityIdsByThreadId`, `activityByThreadId` and
 * `projectById`. Like the weather layer this is renderer-only: it never
 * synthesizes lifecycle truth and nothing here feeds back into orchestration.
 *
 * Codex and Claude now describe subagent work through the same structured
 * canonical `task.*` lifecycle. The shared derivation retains a bounded legacy
 * collab-item fallback so threads persisted by an older Cafe release remain
 * visible after upgrade without keeping prose parsing on the live path.
 */
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
  /** Exact latest lifecycle binding for the existing authorized detail reader. */
  activity: DerivedSubagentActivity;
  /** Stable lifecycle-row identity. Unlike `id`, this remains unique when one child is reused. */
  rowKey: string;
  /** Provider child identity, shared across turns and used only as the deterministic avatar seed. */
  id: string;
  label: string;
  detail: string;
  status: SubagentRunStatus;
  running: boolean;
  /** Per-agent lifecycle clock, independent of the parent turn. */
  startedAt: number | null;
  completedAt: number | null;
};

export type AtriumCardState = "holding" | "running" | "error" | "done";

export type AtriumCard = {
  key: string;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  title: string;
  provider: string;
  /** Frozen accepted-turn metadata, never today's composer/account defaults. */
  turnConfiguration: ProviderTurnConfiguration | null;
  projectName: string;
  state: AtriumCardState;
  /** Provider-vocabulary label for what the thread is doing right now. */
  activityLabel: string;
  activityDetail: string;
  /** Epoch ms the current turn started, for the elapsed readout. */
  startedAt: number | null;
  /** Recorded parent completion/failure edge, never a child update or UI clock. */
  completedAt: number | null;
  subagents: AtriumSubagent[];
  /** Exact terminal failure that the presentation-only clear action dismisses. */
  errorDismissal: TaskAtriumErrorDismissal | null;
};

export type AtriumSnapshot = {
  /** Every card, sorted. The view filters but never truncates this list. */
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

/** Strip the " started" suffix the ingestion layer appends to live items. */
function cleanActivityLabel(summary: string): string {
  return summary.replace(/\s+started$/i, "").trim();
}

type CachedSubagentRows = {
  /** Activity maps are replaced immutably whenever a projection edge arrives. */
  activityById: Record<string, OrchestrationThreadActivity>;
  latestTurnId: TurnId | null;
  cardTerminal: boolean;
  runtimeId: string | null | undefined;
  runtimeStatus: OrchestrationSessionStatus | null;
  rows: AtriumSubagent[];
};

/**
 * The Atrium's parent clock rebuilds card elapsed labels once per second. The
 * activity id arrays and maps are immutable projection values, so a WeakMap
 * lets those clock-only renders reuse subagent rows without retaining a stale
 * projection after the store releases it.
 */
const SUBAGENT_ROWS_BY_ACTIVITY_IDS = new WeakMap<readonly string[], CachedSubagentRows>();

/** Immutable activity objects let clock-only polls reuse schema-validated metadata. */
const TURN_CONFIGURATION_BY_ACTIVITY = new WeakMap<
  OrchestrationThreadActivity,
  ProviderTurnConfiguration | null
>();

function collectTurnConfiguration(
  activityIds: readonly string[] | undefined,
  activityById: Record<string, OrchestrationThreadActivity> | undefined,
  latestTurnId: TurnId | null,
  session: ThreadSession | null,
): ProviderTurnConfiguration | null {
  if (!activityIds || !activityById || latestTurnId === null) return null;
  // A starting replacement can have a newer session binding before the turn
  // projection catches up. Its predecessor's settings must not describe it.
  if (session?.activeTurnId !== undefined && session.activeTurnId !== latestTurnId) return null;

  // The store retains one exact-current-turn configuration beyond its bounded
  // activity tail. Never request old transcripts, inspect credentials, or use
  // a mutable composer selection just to fill in this read-only card.
  for (let index = activityIds.length - 1; index >= 0; index -= 1) {
    const activity = activityById[activityIds[index]!];
    if (activity?.kind !== "provider.turn.configuration" || activity.turnId !== latestTurnId) {
      continue;
    }
    let configuration = TURN_CONFIGURATION_BY_ACTIVITY.get(activity);
    if (configuration === undefined) {
      configuration = readTurnConfiguration(activity.payload) ?? null;
      TURN_CONFIGURATION_BY_ACTIVITY.set(activity, configuration);
    }
    if (
      configuration !== null &&
      (session === null || configuration.provider === session.provider) &&
      (session?.providerInstanceId === undefined ||
        configuration.providerInstanceId === session.providerInstanceId)
    ) {
      return configuration;
    }
  }
  return null;
}

function isSubagentActivity(activity: OrchestrationThreadActivity): boolean {
  const payload = activity.payload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return false;
  const fields = payload as Record<string, unknown>;
  const structuredLifecycle =
    (activity.kind === "task.started" ||
      activity.kind === "task.progress" ||
      activity.kind === "task.completed") &&
    ((typeof fields.subagent === "object" &&
      fields.subagent !== null &&
      !Array.isArray(fields.subagent)) ||
      (fields.visibility === "ambient" && typeof fields.taskId === "string"));
  return structuredLifecycle || fields.itemType === "collab_agent_tool_call";
}

function collectSubagents(
  activityIds: readonly string[] | undefined,
  activityById: Record<string, OrchestrationThreadActivity> | undefined,
  latestTurnId: TurnId | null,
  cardTerminal: boolean,
  runtimeSession: SubagentRuntimeContext | null,
): AtriumSubagent[] {
  if (!activityIds || !activityById) return [];
  const cached = SUBAGENT_ROWS_BY_ACTIVITY_IDS.get(activityIds);
  if (
    cached?.activityById === activityById &&
    cached.latestTurnId === latestTurnId &&
    cached.cardTerminal === cardTerminal &&
    cached.runtimeId === runtimeSession?.subagentRuntimeId &&
    cached.runtimeStatus === (runtimeSession?.orchestrationStatus ?? null)
  ) {
    return cached.rows;
  }

  const activities: OrchestrationThreadActivity[] = [];
  const terminalTurnIds = new Set<TurnId>();
  for (const id of activityIds) {
    const activity = activityById[id];
    if (!activity || !isSubagentActivity(activity)) continue;
    activities.push(activity);
    // Structured lifecycle has explicit terminal truth. This set exists for
    // persisted legacy `Started /root/...` rows, whose tool completion only
    // closes the control item. Once the owning turn is historical or the
    // whole card is terminal, that old row must not claim it is still working.
    if (
      activity.turnId !== null &&
      (cardTerminal || (latestTurnId !== null && activity.turnId !== latestTurnId))
    ) {
      terminalTurnIds.add(activity.turnId);
    }
  }

  const rows = deriveSubagentActivities(activities, { terminalTurnIds, runtimeSession }).map(
    (subagent) => ({
      activity: subagent,
      rowKey: subagent.rowId,
      id: subagent.id,
      label: subagent.label,
      detail:
        // Keep the live provider description visible in the card. The original
        // objective remains the fallback before Codex/Claude reports progress;
        // it must never be relegated to a hover-only affordance.
        subagent.description ??
        subagent.objective ??
        (subagent.status === "waiting"
          ? "Waiting"
          : subagent.status === "active"
            ? "Working"
            : subagent.status === "unknown"
              ? "Status unavailable"
              : "Done"),
      status: subagent.status,
      running: subagent.status === "active" || subagent.status === "waiting",
      startedAt: toEpoch(subagent.startedAt),
      completedAt: toEpoch(subagent.completedAt),
    }),
  );
  SUBAGENT_ROWS_BY_ACTIVITY_IDS.set(activityIds, {
    activityById,
    latestTurnId,
    cardTerminal,
    runtimeId: runtimeSession?.subagentRuntimeId,
    runtimeStatus: runtimeSession?.orchestrationStatus ?? null,
    rows,
  });
  return rows;
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

export function isSameErrorDismissal(
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

/** Only Cafe's fixed process-exit diagnostic is eligible for batch dismissal.
 * Arbitrary provider errors remain separate; their text is never persisted. */
export function isCodexAppServerExitError(error: string | null | undefined): boolean {
  return (
    typeof error === "string" &&
    /^Codex App Server exited unexpectedly(?: with code -?\d+)?\.$/.test(error)
  );
}

/** A restart can leave the same diagnostic on many independent native sessions.
 * Acknowledge only the exact copies already in this server's shell catalog at
 * the gesture, without loading histories or claiming those processes recovered.
 * Each copy retains its own occurrence identity, so future exits are visible. */
export function collectCodexAppServerExitDismissals(
  state: AppState,
  environmentId: EnvironmentId,
  error: string,
): TaskAtriumErrorDismissal[] {
  if (!isCodexAppServerExitError(error)) return [];
  const environment = state.environmentStateById[environmentId];
  if (!environment) return [];
  const dismissals: TaskAtriumErrorDismissal[] = [];
  for (const summary of Object.values(environment.sidebarThreadSummaryById)) {
    const threadId = summary.id;
    const session = environment.threadSessionById[threadId] ?? summary.session ?? null;
    const shell = environment.threadShellById[threadId];
    if (session?.provider !== "codex" || session.lastError !== error) continue;
    // A mounted composer can hold a different local failure than its persisted
    // session. Do not acknowledge that diagnostic on the user's behalf.
    if (shell && shell.error !== error) continue;
    dismissals.push(
      buildThreadErrorDismissal({
        environmentId,
        threadId,
        session,
        summary,
        latestTurn:
          environment.threadTurnStateById[threadId]?.latestTurn ?? summary.latestTurn ?? null,
      }),
    );
  }
  return dismissals;
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
  session: {
    activeTurnId?: TurnId | undefined;
    updatedAt?: string | undefined;
    provider?: ThreadSession["provider"];
    lastError?: string | undefined;
  } | null;
  latestTurn: OrchestrationLatestTurn | null;
  summary: { updatedAt?: string | undefined; createdAt: string };
}): TaskAtriumErrorDismissal {
  const { environmentId, threadId, session, latestTurn, summary } = input;
  if (session?.provider === "codex" && isCodexAppServerExitError(session.lastError)) {
    // An app-server exit belongs to the session, not an old failed turn. Using
    // the latter's id would hide a later process exit after another restart if
    // the chat has not started a new turn in between.
    return {
      environmentId,
      threadId,
      turnId: null,
      observedAt: session.updatedAt ?? summary.updatedAt ?? summary.createdAt,
    };
  }
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
  selectedEnvironmentId?: EnvironmentId | null,
): AtriumSnapshot {
  const cards: AtriumCard[] = [];
  let subagentCount = 0;
  const dismissedErrorByScope = new Map<string, TaskAtriumErrorDismissal>();
  for (const dismissal of dismissedErrors) {
    dismissedErrorByScope.set(errorDismissalScopeKey(dismissal), dismissal);
  }

  for (const [environmentIdRaw, environment] of Object.entries(state.environmentStateById)) {
    if (selectedEnvironmentId !== undefined && environmentIdRaw !== selectedEnvironmentId) continue;
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
      const turnConfiguration = collectTurnConfiguration(
        activityIds,
        activityById,
        latestTurn?.turnId ?? null,
        session,
      );

      const rows = collectSubagents(
        activityIds,
        activityById,
        latestTurn?.turnId ?? null,
        cardState === "done" || cardState === "error",
        session,
      );
      subagentCount += rows.filter((row) => row.running).length;

      // Projectless chats still have normal task/session state. Null is not a
      // lookup key or permission to attach the task to another project.
      const project =
        summary.projectId === null ? undefined : environment.projectById[summary.projectId];

      cards.push({
        // Environment/thread ids can be imported from another server. Tuple
        // encoding avoids delimiter collisions in React identity and in the
        // detail-subscription retention map.
        key: JSON.stringify([environmentId, threadId]),
        environmentId,
        threadId,
        title: summary.title.trim().length > 0 ? summary.title : "Untitled chat",
        provider: session?.provider ?? turnConfiguration?.provider ?? "",
        turnConfiguration,
        projectName: project?.name ?? "",
        state: cardState,
        activityLabel: lastActivity ? cleanActivityLabel(lastActivity.summary) : "",
        activityDetail: activityPayloadField(lastActivity, "detail") ?? "",
        startedAt: toEpoch(latestTurn?.startedAt ?? latestTurn?.requestedAt),
        // A session-level failure can belong to a different attempt from the
        // latest completed turn. Only a recorded completion or session-error
        // transition can end the clock: dismissal's start/request fallback is
        // an occurrence identity, not evidence of terminal timing. Completed
        // parents may still have live children; their own duration is frozen
        // independently of card state and late child progress/title updates.
        completedAt:
          cardState === "error"
            ? (toEpoch(latestTurn?.state === "error" ? latestTurn.completedAt : null) ??
              (status === "error" ? toEpoch(session?.updatedAt) : null))
            : latestTurn?.state !== "running"
              ? toEpoch(latestTurn?.completedAt)
              : null,
        subagents: rows,
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

/** Terminal parent clocks require recorded evidence; absence stays unknown. */
export function formatAtriumCardElapsed(
  card: Pick<AtriumCard, "startedAt" | "completedAt" | "state">,
  now: number,
): string {
  const end =
    card.completedAt ?? (card.state === "running" || card.state === "holding" ? now : null);
  return end === null ? "" : formatElapsed(card.startedAt, end);
}
