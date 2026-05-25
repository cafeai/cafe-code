import type { SessionPhase } from "../../types";

export type FollowUpDeliveryAction = "send" | "queue" | "steer" | "queue-unsupported";

export interface FollowUpDeliveryInput {
  phase: SessionPhase;
  requestedSteer: boolean;
  liveSteerSupported: boolean;
}

export function decideFollowUpDelivery(input: FollowUpDeliveryInput): FollowUpDeliveryAction {
  if (input.phase !== "running") {
    return "send";
  }
  if (!input.requestedSteer) {
    return "queue";
  }
  return input.liveSteerSupported ? "steer" : "queue-unsupported";
}

export interface QueuedFollowUpStartInput {
  queueLength: number;
  firstItemBlocked: boolean;
  isWorking: boolean;
  isConnecting: boolean;
  isEnvironmentUnavailable: boolean;
  isDispatchInFlight: boolean;
}

export function canStartQueuedFollowUpTurn(input: QueuedFollowUpStartInput): boolean {
  return (
    input.queueLength > 0 &&
    !input.firstItemBlocked &&
    !input.isWorking &&
    !input.isConnecting &&
    !input.isEnvironmentUnavailable &&
    !input.isDispatchInFlight
  );
}

export interface QueuedFollowUpDispatchCandidateInput<
  ThreadKey extends string,
  Item extends { readonly blockedReason: string | null },
> {
  queuesByThreadId: Record<string, readonly Item[]>;
  preferredThreadId: ThreadKey | null;
  canStart: (input: { threadId: ThreadKey; item: Item; queueLength: number }) => boolean;
}

export function selectQueuedFollowUpDispatchCandidate<
  ThreadKey extends string,
  Item extends { readonly blockedReason: string | null },
>(
  input: QueuedFollowUpDispatchCandidateInput<ThreadKey, Item>,
): {
  threadId: ThreadKey;
  item: Item;
  queueLength: number;
} | null {
  const orderedThreadIds: ThreadKey[] = [];
  const seen = new Set<string>();
  const pushThreadId = (threadId: string | null | undefined) => {
    if (!threadId || seen.has(threadId)) return;
    seen.add(threadId);
    orderedThreadIds.push(threadId as ThreadKey);
  };

  pushThreadId(input.preferredThreadId);
  for (const [threadId, items] of Object.entries(input.queuesByThreadId)) {
    if (items.length > 0) {
      pushThreadId(threadId);
    }
  }

  for (const threadId of orderedThreadIds) {
    const items = input.queuesByThreadId[threadId] ?? [];
    const item = items[0];
    if (!item) continue;
    if (input.canStart({ threadId, item, queueLength: items.length })) {
      return { threadId, item, queueLength: items.length };
    }
  }

  return null;
}

export interface QueuedFollowUpDispatchObservationInput {
  messageId: string;
  dispatchedAt: string;
  thread: {
    messages: readonly { readonly id: string }[];
    latestTurn: { readonly requestedAt: string } | null;
    session: {
      readonly activeTurnId?: string | null | undefined;
      readonly updatedAt: string;
    } | null;
  };
}

function isoAtOrAfter(value: string | null | undefined, minimum: string): boolean {
  if (!value) return false;
  const valueTime = Date.parse(value);
  const minimumTime = Date.parse(minimum);
  return Number.isFinite(valueTime) && Number.isFinite(minimumTime) && valueTime >= minimumTime;
}

export function hasQueuedFollowUpDispatchBeenObserved(
  input: QueuedFollowUpDispatchObservationInput,
): boolean {
  if (input.thread.messages.some((message) => message.id === input.messageId)) {
    return true;
  }
  if (isoAtOrAfter(input.thread.latestTurn?.requestedAt, input.dispatchedAt)) {
    return true;
  }
  return (
    input.thread.session?.activeTurnId != null &&
    isoAtOrAfter(input.thread.session.updatedAt, input.dispatchedAt)
  );
}

export function previewQueuedFollowUpText(text: string, fallback = "Image-only follow-up"): string {
  const normalized = text.trim().replace(/\s+/g, " ");
  return normalized.length > 0 ? normalized : fallback;
}

export function canExpandQueuedFollowUpText(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return false;
  }
  if (/\r?\n/.test(trimmed)) {
    return true;
  }
  return previewQueuedFollowUpText(trimmed).length > 88;
}

export type QueuedFollowUpAction = "steer" | "interrupt" | "send" | "wait";

export interface QueuedFollowUpActionInput {
  phase: SessionPhase;
  liveSteerSupported: boolean;
  canDispatchNow: boolean;
}

export function decideQueuedFollowUpAction(input: QueuedFollowUpActionInput): QueuedFollowUpAction {
  if (input.phase === "running") {
    if (!input.canDispatchNow) {
      return "wait";
    }
    if (!input.liveSteerSupported) {
      return "interrupt";
    }
    return "steer";
  }

  return input.canDispatchNow ? "send" : "wait";
}

export function queuedFollowUpActionLabel(input: {
  readonly phase: SessionPhase;
  readonly liveSteerSupported: boolean;
}): "Steer" | "Interrupt" | "Send" {
  if (input.phase !== "running") {
    return "Send";
  }
  return input.liveSteerSupported ? "Steer" : "Interrupt";
}

export function queuedFollowUpActionTitle(input: {
  readonly phase: SessionPhase;
  readonly liveSteerSupported: boolean;
}): string {
  if (input.phase !== "running") {
    return "Send this queued follow-up now.";
  }
  return input.liveSteerSupported
    ? "Steer this into the active turn now."
    : "Interrupt the active turn and send this queued follow-up next.";
}

export interface RekeyQueuedFollowUpsInput<
  ThreadKey extends string,
  Item extends { readonly threadId: ThreadKey; readonly blockedReason: string | null },
> {
  queuesByThreadId: Record<string, readonly Item[]>;
  activeThreadId: ThreadKey | null;
  previousActiveThreadId: ThreadKey | null;
  knownThreadIds: ReadonlySet<string>;
}

/**
 * A queued follow-up can be created while a first-turn draft is still using a
 * temporary local thread id. Once the server-backed thread id becomes active,
 * the queue must follow that handoff; otherwise the watchdog sees an empty
 * queue for the visible chat and never dispatches.
 */
export function rekeyQueuedFollowUpsForActiveThread<
  ThreadKey extends string,
  Item extends { readonly threadId: ThreadKey; readonly blockedReason: string | null },
>(input: RekeyQueuedFollowUpsInput<ThreadKey, Item>): Record<string, Item[]> {
  const { activeThreadId, knownThreadIds, previousActiveThreadId, queuesByThreadId } = input;
  if (activeThreadId === null) {
    return queuesByThreadId as Record<string, Item[]>;
  }

  const activeItems = queuesByThreadId[activeThreadId] ?? [];
  if (activeItems.length > 0) {
    return queuesByThreadId as Record<string, Item[]>;
  }

  const isOrphanQueue = (threadId: string): boolean =>
    threadId !== activeThreadId && !knownThreadIds.has(threadId);

  const previousItems =
    previousActiveThreadId && isOrphanQueue(previousActiveThreadId)
      ? (queuesByThreadId[previousActiveThreadId] ?? [])
      : [];
  let orphanQueueCount = 0;
  let firstOrphanEntry: readonly [string, readonly Item[]] | undefined;
  for (const entry of Object.entries(queuesByThreadId)) {
    const [threadId, items] = entry;
    if (!isOrphanQueue(threadId) || items.length === 0) {
      continue;
    }
    orphanQueueCount += 1;
    firstOrphanEntry ??= entry;
  }

  const sourceEntry =
    previousActiveThreadId && previousItems.length > 0
      ? ([previousActiveThreadId, previousItems] as const)
      : firstOrphanEntry;

  if (!sourceEntry) {
    return queuesByThreadId as Record<string, Item[]>;
  }

  if (sourceEntry[0] !== previousActiveThreadId && orphanQueueCount !== 1) {
    return queuesByThreadId as Record<string, Item[]>;
  }

  const [sourceThreadId, sourceItems] = sourceEntry;
  const next: Record<string, Item[]> = { ...(queuesByThreadId as Record<string, Item[]>) };
  delete next[sourceThreadId];
  next[activeThreadId] = sourceItems.map(
    (item) =>
      Object.assign({}, item, {
        threadId: activeThreadId,
        blockedReason: null,
      }) as Item,
  );
  return next;
}
