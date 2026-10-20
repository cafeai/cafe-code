import {
  OrchestrationThreadActivityCursor,
  OrchestrationThreadTurnActivityPage,
  type OrchestrationThreadActivity,
  type ThreadId,
  type TurnId,
} from "@cafecode/contracts";
import {
  isExcludedWorkLogOperation,
  readWorkLogOperationId,
  readWorkLogOperationIdentity,
} from "@cafecode/shared/providerWorkLog";
import * as Schema from "effect/Schema";
import { deriveWorkLogEntries, type WorkLogEntry } from "../../session-logic";
import { activityCursor, compareActivityCursors } from "../../activityOrder";
export { activityCursor, compareActivityCursors } from "../../activityOrder";

/** The same finite retained-reader ceiling as the existing Show all action. */
export const EARLIER_WORK_LOG_RETAINED_LIMIT = 1_000;
const isActivityCursor = Schema.is(OrchestrationThreadActivityCursor);
const isActivityPage = Schema.is(OrchestrationThreadTurnActivityPage);

export function cursorKey(cursor: OrchestrationThreadActivityCursor): string {
  return JSON.stringify([cursor.sequence, cursor.createdAt, cursor.activityId]);
}

/** Fail visibly if a saved older server ignored the additive range contract. */
export function validateEarlierWorkLogPage(input: {
  readonly page: OrchestrationThreadTurnActivityPage;
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly before: OrchestrationThreadActivityCursor;
  readonly limit: number;
  readonly excludeActivityIds?: ReadonlyArray<OrchestrationThreadActivity["id"]>;
  readonly excludeOperations?: OrchestrationThreadTurnActivityPage["excludeOperations"];
  readonly excludeTurnStartAck?: boolean;
}): void {
  const { page, before, threadId, turnId, limit, excludeActivityIds } = input;
  if (
    !page ||
    !Array.isArray(page.activities) ||
    page.activities.length > limit ||
    !isActivityPage(page) ||
    page.threadId !== threadId ||
    page.turnId !== turnId ||
    page.offset !== 0 ||
    page.limit !== limit ||
    !isActivityCursor(page.before) ||
    cursorKey(page.before) !== cursorKey(before) ||
    JSON.stringify(page.excludeActivityIds ?? []) !== JSON.stringify(excludeActivityIds ?? []) ||
    JSON.stringify(page.excludeOperations ?? []) !==
      JSON.stringify(input.excludeOperations ?? []) ||
    page.excludeTurnStartAck !== input.excludeTurnStartAck ||
    !Number.isSafeInteger(page.totalCount) ||
    page.totalCount < page.activities.length ||
    (page.totalCount > 0 && page.activities.length === 0)
  )
    throw new Error("Invalid earlier work page");
  let previous: OrchestrationThreadActivityCursor | undefined;
  const ids = new Set<string>();
  for (const activity of page.activities) {
    const cursor = activityCursor(activity);
    if (
      !isActivityCursor(cursor) ||
      activity.turnId !== turnId ||
      excludeActivityIds?.includes(activity.id) ||
      isExcludedWorkLogOperation(activity, input.excludeOperations) ||
      (input.excludeTurnStartAck &&
        activity.kind === "task.progress" &&
        activity.payload?.taskId === `codex-turn-start:${turnId}`) ||
      ids.has(activity.id) ||
      compareActivityCursors(cursor, before) >= 0 ||
      (previous && compareActivityCursors(previous, cursor) >= 0)
    )
      throw new Error("Invalid earlier work order");
    ids.add(activity.id);
    previous = cursor;
  }
}

function operationKey(entry: WorkLogEntry): string {
  // Primary Claude snapshots preserve item identity while their raw activity
  // id changes. Including turn and operation type avoids conflating a summary
  // with a command or another turn's reused native id.
  const id = readWorkLogOperationId(entry.toolCallId);
  return id
    ? JSON.stringify([entry.turnId, entry.publicSummary ? "summary" : "tool", id])
    : JSON.stringify([entry.turnId, "activity", entry.id]);
}

export function deriveEarlierWorkLogEntries(input: {
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly liveActivities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly turnId: TurnId;
}): WorkLogEntry[] {
  const received = new Map(input.activities.map((activity) => [activity.id, activity]));
  for (const activity of input.liveActivities) received.set(activity.id, activity);
  const inlineKeys = new Set(
    deriveWorkLogEntries(input.liveActivities, input.turnId).map(operationKey),
  );
  const pageIds = new Set<string>(input.activities.map((activity) => activity.id));
  // Fold the authoritative current snapshots first, without pretending a live
  // turn is terminal. History is display data only; no child/liveness/control
  // observation is fed back into the application store.
  // A legacy operation without an admitted identity cannot prove that an
  // older row duplicates a live operation. Do not let label/detail-based
  // lifecycle collapse erase it across the history/live boundary. Identified
  // live snapshots still fold before presentation, as do same-id replacements.
  const foldable = [...received.values()].filter(
    (activity) =>
      pageIds.has(activity.id) ||
      !(activity.kind.startsWith("tool.") || activity.kind === "reasoning.summary") ||
      readWorkLogOperationIdentity(activity) !== undefined,
  );
  return deriveWorkLogEntries(foldable, input.turnId).filter(
    (entry) => pageIds.has(entry.id) && !inlineKeys.has(operationKey(entry)),
  );
}

export function mergeEarlierWorkLogPages(
  older: ReadonlyArray<OrchestrationThreadActivity>,
  current: ReadonlyArray<OrchestrationThreadActivity>,
): OrchestrationThreadActivity[] {
  const received = new Map(older.map((activity) => [activity.id, activity]));
  for (const activity of current) received.set(activity.id, activity);
  return [...received.values()]
    .toSorted((left, right) => compareActivityCursors(activityCursor(left), activityCursor(right)))
    .slice(0, EARLIER_WORK_LOG_RETAINED_LIMIT);
}
