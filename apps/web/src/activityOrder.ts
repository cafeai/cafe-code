import type {
  OrchestrationThreadActivity,
  OrchestrationThreadActivityCursor,
} from "@cafecode/contracts";

/** Match SQLite BINARY order, not the viewer's locale, for opaque cursor ids. */
function compareText(left: string, right: string): number {
  const a = [...left];
  const b = [...right];
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    const difference = a[index]!.codePointAt(0)! - b[index]!.codePointAt(0)!;
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

export function activityCursor(
  activity: OrchestrationThreadActivity,
): OrchestrationThreadActivityCursor {
  return {
    sequence: activity.sequence ?? null,
    createdAt: activity.createdAt,
    activityId: activity.id,
  };
}

export function compareActivityCursors(
  left: OrchestrationThreadActivityCursor,
  right: OrchestrationThreadActivityCursor,
): number {
  if (left.sequence !== right.sequence) {
    if (left.sequence === null) return -1;
    if (right.sequence === null) return 1;
    return left.sequence - right.sequence;
  }
  return (
    compareText(left.createdAt, right.createdAt) || compareText(left.activityId, right.activityId)
  );
}

export function compareActivityWindowOrder(
  left: OrchestrationThreadActivity,
  right: OrchestrationThreadActivity,
): number {
  return compareActivityCursors(activityCursor(left), activityCursor(right));
}
