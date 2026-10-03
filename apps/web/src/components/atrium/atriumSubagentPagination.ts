import type { AtriumSubagent } from "./taskAtriumData";

/** A hard presentation ceiling, never a truncation of retained provider history. */
export const ATRIUM_SUBAGENT_PAGE_SIZE = 5;
export type AtriumSubagentView = "active" | "history";

function historyTime(subagent: AtriumSubagent): number {
  // This is display ordering only. An unavailable worker has no inferred end
  // time; its latest recorded observation orders it without inventing one.
  const observedAt = Date.parse(subagent.activity.updatedAt);
  for (const candidate of [subagent.completedAt, observedAt, subagent.startedAt]) {
    if (candidate !== null && Number.isFinite(candidate)) return candidate;
  }
  return 0;
}

/**
 * Consume the shared liveness result rather than re-deriving provider truth.
 * Preserve row objects and the complete roster so paging cannot change counts,
 * lifecycle evidence, or the exact identity used by an already-open detail.
 */
export function partitionAtriumSubagents(subagents: readonly AtriumSubagent[]): {
  active: readonly AtriumSubagent[];
  history: readonly AtriumSubagent[];
} {
  const active: AtriumSubagent[] = [];
  const history: AtriumSubagent[] = [];
  for (const subagent of subagents) {
    (subagent.running ? active : history).push(subagent);
  }
  history.sort((left, right) => {
    const byTime = historyTime(right) - historyTime(left);
    // Opaque keys are comparison-only, not user-facing text. Code-point order
    // avoids locale-dependent pagination for equal-time imported observations.
    return byTime || (left.rowKey < right.rowKey ? -1 : left.rowKey > right.rowKey ? 1 : 0);
  });
  return { active, history };
}

/** Clamp before slicing so shrinking live rosters never render an empty stale page. */
export function paginateAtriumSubagents<T>(rows: readonly T[], requestedPageIndex: number) {
  const pageCount = Math.max(1, Math.ceil(rows.length / ATRIUM_SUBAGENT_PAGE_SIZE));
  const normalizedPageIndex = Number.isFinite(requestedPageIndex)
    ? Math.max(0, Math.floor(requestedPageIndex))
    : 0;
  const pageIndex = Math.min(normalizedPageIndex, pageCount - 1);
  const offset = pageIndex * ATRIUM_SUBAGENT_PAGE_SIZE;
  return {
    rows: rows.slice(offset, offset + ATRIUM_SUBAGENT_PAGE_SIZE),
    total: rows.length,
    pageIndex,
    pageCount,
    start: rows.length === 0 ? 0 : offset + 1,
    end: Math.min(offset + ATRIUM_SUBAGENT_PAGE_SIZE, rows.length),
  };
}
