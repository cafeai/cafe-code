import type { OrchestrationThreadActivity } from "@cafecode/contracts";

/** Combined approval/question presentation budget, independent of the tool tail. */
export const MAX_PENDING_REQUEST_RETENTION_IDENTITIES = 64;

type RequestLifecycle = {
  readonly identity: string;
  readonly requested: boolean;
};

/**
 * Read lifecycle identity only. Retained activities remain byte-for-byte domain
 * evidence: no shell flag, age, terminal turn, or another runtime's request can
 * manufacture a native callback or a permission decision.
 */
function readRequestLifecycle(activity: OrchestrationThreadActivity): RequestLifecycle | null {
  const approval =
    activity.kind === "approval.requested" ||
    activity.kind === "approval.resolved" ||
    activity.kind === "provider.approval.respond.failed";
  const question =
    activity.kind === "user-input.requested" ||
    activity.kind === "user-input.resolved" ||
    activity.kind === "provider.user-input.respond.failed";
  if (!approval && !question) return null;
  const payload = activity.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.requestId !== "string" || record.requestId.length === 0) return null;

  if (activity.kind.endsWith(".failed")) {
    // Ordinary failed submissions leave the callback pending. Match the narrow
    // channel-specific canonical accounting; arbitrary errors and another
    // channel's stale-request prose never prove that this callback retired.
    const detail = typeof record.detail === "string" ? record.detail.toLowerCase() : "";
    const reasons = approval
      ? [
          "stale pending approval request",
          "unknown pending approval request",
          "unknown pending permission request",
        ]
      : ["stale pending user-input request", "unknown pending user-input request"];
    if (!reasons.some((reason) => detail.includes(reason))) return null;
  }

  return {
    // These channels have independent lifecycles even when a legacy provider
    // reuses one opaque id for an approval and a clarifying question.
    identity: JSON.stringify([approval ? "approval" : "question", record.requestId]),
    requested: activity.kind.endsWith(".requested"),
  };
}

/** SQLite BINARY text order, including non-BMP opaque ids, without locale rules. */
function compareText(left: string, right: string): number {
  const a = [...left];
  const b = [...right];
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    const difference = a[index]!.codePointAt(0)! - b[index]!.codePointAt(0)!;
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

function compareActivities(
  left: OrchestrationThreadActivity,
  right: OrchestrationThreadActivity,
): number {
  if (left.sequence !== right.sequence) {
    if (left.sequence === undefined) return -1;
    if (right.sequence === undefined) return 1;
    return left.sequence - right.sequence;
  }
  return (
    compareText(left.createdAt, right.createdAt) ||
    Number(left.kind.endsWith(".resolved")) - Number(right.kind.endsWith(".resolved")) ||
    compareText(left.id, right.id)
  );
}

/**
 * Select at most 64 pending request identities plus their latest exact terminal
 * context. The caller retains its ordinary activity tail separately. Ordering
 * is canonical sequence first; a clock-skewed resolution must not leave an old
 * requested row pinned indefinitely. This is presentation accounting only.
 */
export function derivePendingRequestRetention(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  ordinaryActivityIds: ReadonlySet<string> = new Set(),
): {
  readonly activityIds: ReadonlySet<string>;
  readonly pendingCount: number;
  readonly truncated: boolean;
} {
  const pending = new Map<string, OrchestrationThreadActivity>();
  const latestResolution = new Map<string, OrchestrationThreadActivity>();
  const lifecycle = activities
    .flatMap((activity) => {
      const request = readRequestLifecycle(activity);
      return request ? [{ activity, request }] : [];
    })
    .toSorted((left, right) => compareActivities(left.activity, right.activity));

  for (const { activity, request } of lifecycle) {
    if (request.requested) {
      // Reinsert so an exact-id replacement takes its actual newest position.
      pending.delete(request.identity);
      pending.set(request.identity, activity);
    } else {
      pending.delete(request.identity);
      latestResolution.set(request.identity, activity);
    }
  }

  const activityIds = new Set<string>();
  let admitted = 0;
  for (const [identity, requested] of [...pending].reverse()) {
    if (admitted >= MAX_PENDING_REQUEST_RETENTION_IDENTITIES) break;
    admitted += 1;
    activityIds.add(requested.id);
    const resolved = latestResolution.get(identity);
    if (resolved) activityIds.add(resolved.id);
  }
  // The ordinary history cursor intentionally has no lifecycle-rank tie. A
  // same-clock legacy resolved row may sort before its requested row by id.
  // Keep the latest exact terminal context whenever that requested row stays
  // in the ordinary tail; otherwise retaining history could recreate a card.
  // This adds at most one context per ordinary retained request, plus one per
  // admitted pending identity. It never expands the caller's ordinary tail.
  for (const { activity, request } of lifecycle) {
    if (!request.requested || !ordinaryActivityIds.has(activity.id)) continue;
    const resolved = latestResolution.get(request.identity);
    if (resolved) activityIds.add(resolved.id);
  }
  return {
    activityIds,
    pendingCount: pending.size,
    // Count-only overflow is not omission when the ordinary tail already
    // carries every original pending payload. Report only evidence actually
    // absent from the union that the caller will present.
    truncated: [...pending.values()].some(
      (requested) => !ordinaryActivityIds.has(requested.id) && !activityIds.has(requested.id),
    ),
  };
}
