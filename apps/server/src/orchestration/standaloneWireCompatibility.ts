import type {
  OrchestrationEvent,
  OrchestrationShellSnapshot,
  OrchestrationShellStreamEvent,
  ProjectId,
  ThreadId,
} from "@cafecode/contracts";

/**
 * Older renderers decode projectId as a required non-null ProjectId. Keep the
 * opt-in a read-side presentation boundary, never an authorization policy or a
 * rewrite of durable domain events. Current renderers opt in on every request;
 * an omitted or explicitly false flag retains the compatible linked catalog.
 */
export function compatibleStandaloneShellSnapshot(
  snapshot: OrchestrationShellSnapshot,
  includeStandaloneChats: boolean | undefined,
): OrchestrationShellSnapshot {
  return includeStandaloneChats === true
    ? snapshot
    : { ...snapshot, threads: snapshot.threads.filter((thread) => thread.projectId !== null) };
}

/**
 * A linked chat detached while a legacy subscription exists must disappear
 * from that subscription's view. Dropping the upsert alone leaves an obsolete
 * project entry visible. A shell removal is view-only; no deletion, archive,
 * turn interruption or durable event is manufactured by this compatibility map.
 */
export function compatibleStandaloneShellEvent(
  event: OrchestrationShellStreamEvent,
  includeStandaloneChats: boolean | undefined,
): OrchestrationShellStreamEvent {
  if (
    includeStandaloneChats !== true &&
    event.kind === "thread-upserted" &&
    event.thread.projectId === null
  ) {
    return { kind: "thread-removed", sequence: event.sequence, threadId: event.thread.id };
  }
  return event;
}

/**
 * Legacy replay cannot faithfully represent a conversation's standalone
 * segment. Suppress that conversation rather than replacing null with a fake
 * project or inventing a domain deletion. Seed from the caller's canonical
 * association summary when the requested replay begins after thread creation.
 * This performs one linear pass plus filtering over the already-admitted page,
 * and never reads SQL or provider state for each event.
 */
export function compatibleStandaloneReplayEvents(
  events: ReadonlyArray<OrchestrationEvent>,
  includeStandaloneChats: boolean | undefined,
  currentThreads: ReadonlyArray<{
    readonly id: ThreadId;
    readonly projectId: ProjectId | null;
  }> = [],
): Array<OrchestrationEvent> {
  if (includeStandaloneChats === true) return Array.from(events);
  const standaloneThreadIds = new Set<string>(
    currentThreads.filter((thread) => thread.projectId === null).map((thread) => thread.id),
  );
  for (const event of events) {
    if (
      (event.type === "thread.created" || event.type === "thread.meta-updated") &&
      event.payload.projectId === null
    ) {
      standaloneThreadIds.add(event.payload.threadId);
    }
  }
  return events.filter(
    (event) => event.aggregateKind !== "thread" || !standaloneThreadIds.has(event.aggregateId),
  );
}
