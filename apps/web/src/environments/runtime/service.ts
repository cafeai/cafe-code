import {
  type EnvironmentId,
  type OrchestrationEvent,
  type OrchestrationShellSnapshot,
  type OrchestrationShellStreamEvent,
  type OrchestrationThreadDetailSnapshot,
  ThreadId,
} from "@cafecode/contracts";
import { type QueryClient } from "@tanstack/react-query";
import { Throttler } from "@tanstack/react-pacer";
import {
  getKnownEnvironmentWsBaseUrl,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@cafecode/client-runtime";

import {
  markPromotedDraftThreadByRef,
  markPromotedDraftThreadsByRef,
  removeComposerDraftsForNonPrimaryEnvironment,
  useComposerDraftStore,
} from "~/composerDraftStore";
import { deriveOrchestrationBatchEffects } from "~/orchestrationEventEffects";
import { projectQueryKeys } from "~/lib/projectReactQuery";
import { providerQueryKeys } from "~/lib/providerReactQuery";
import { getPrimaryKnownEnvironment } from "../primary";
import { createEnvironmentConnection, type EnvironmentConnection } from "./connection";
import {
  useStore,
  selectProjectsAcrossEnvironments,
  selectSidebarThreadSummaryByRef,
  selectThreadByRef,
  selectThreadsAcrossEnvironments,
} from "~/store";
import { useUiStateStore } from "~/uiStateStore";
import { getServerConfig } from "../../rpc/serverState";
import { WsTransport } from "../../rpc/wsTransport";
import { createWsRpcClient } from "../../rpc/wsRpcClient";
import { resolveServerConfigVersionMismatch } from "../../versionSkew";
import {
  deriveLogicalProjectKeyFromSettings,
  derivePhysicalProjectKey,
} from "../../logicalProject";
import { getClientSettings } from "~/hooks/useSettings";

type EnvironmentServiceState = {
  readonly queryClient: QueryClient;
  readonly queryInvalidationThrottler: Throttler<() => void>;
  refCount: number;
  stop: () => void;
};

type ThreadDetailSubscriptionEntry = {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  unsubscribe: () => void;
  unsubscribeConnectionListener: (() => void) | null;
  refCount: number;
  lastAccessedAt: number;
  evictionTimeoutId: ReturnType<typeof setTimeout> | null;
};

const environmentConnections = new Map<EnvironmentId, EnvironmentConnection>();
const environmentConnectionListeners = new Set<() => void>();
const threadDetailSubscriptions = new Map<string, ThreadDetailSubscriptionEntry>();
const lastAppliedProjectionVersionByEnvironment = new Map<
  EnvironmentId,
  {
    readonly sequence: number;
    readonly updatedAt: string | null;
  }
>();
const lastAppliedThreadDetailSequenceByKey = new Map<string, number>();
const pendingThreadDetailEventsByEnvironment = new Map<EnvironmentId, OrchestrationEvent[]>();
const pendingThreadDetailSequenceByKey = new Map<string, number>();
let pendingThreadDetailFlushTimeoutId: ReturnType<typeof setTimeout> | null = null;

let activeService: EnvironmentServiceState | null = null;
let needsProviderInvalidation = false;
let lastBrowserHiddenAt: number | null = null;
let lastBrowserResumeReconnectAt = Number.NEGATIVE_INFINITY;

// Thread detail subscription cache policy:
// - Active consumers keep a subscription retained via refCount.
// - Released subscriptions stay warm for a longer idle TTL to avoid churn
//   while moving around the UI.
// - Threads with active work or pending user action are sticky and are never
//   evicted while they remain non-idle.
// - Capacity eviction only targets idle cached subscriptions.
const THREAD_DETAIL_SUBSCRIPTION_IDLE_EVICTION_MS = 15 * 60 * 1000;
const MAX_CACHED_THREAD_DETAIL_SUBSCRIPTIONS = 32;
const THREAD_DETAIL_UI_EVENT_BATCH_MS = 16;
const BROWSER_RESUME_RECONNECT_COOLDOWN_MS = 2_000;
const NOOP = () => undefined;
function compareAppliedProjectionVersion(
  left: { readonly sequence: number; readonly updatedAt: string | null },
  right: { readonly sequence: number; readonly updatedAt: string | null },
): number {
  if (left.sequence !== right.sequence) {
    return left.sequence - right.sequence;
  }

  const leftUpdatedAt = left.updatedAt ?? "";
  const rightUpdatedAt = right.updatedAt ?? "";
  if (leftUpdatedAt === rightUpdatedAt) {
    return 0;
  }

  return leftUpdatedAt < rightUpdatedAt ? -1 : 1;
}

function toAppliedProjectionVersion(
  snapshot: Pick<OrchestrationShellSnapshot, "snapshotSequence" | "updatedAt">,
): {
  readonly sequence: number;
  readonly updatedAt: string;
} {
  return {
    sequence: snapshot.snapshotSequence,
    updatedAt: snapshot.updatedAt,
  };
}

export function shouldApplyProjectionSnapshot(input: {
  readonly current: {
    readonly sequence: number;
    readonly updatedAt: string | null;
  } | null;
  readonly next: Pick<OrchestrationShellSnapshot, "snapshotSequence" | "updatedAt">;
}): boolean {
  if (input.current === null) {
    return true;
  }

  return compareAppliedProjectionVersion(input.current, toAppliedProjectionVersion(input.next)) < 0;
}

export function shouldApplyProjectionEvent(input: {
  readonly current: {
    readonly sequence: number;
    readonly updatedAt: string | null;
  } | null;
  readonly sequence: number;
}): boolean {
  if (input.current === null) {
    return true;
  }

  return input.sequence > input.current.sequence;
}

function readLastAppliedProjectionVersion(environmentId: EnvironmentId): {
  readonly sequence: number;
  readonly updatedAt: string | null;
} | null {
  return lastAppliedProjectionVersionByEnvironment.get(environmentId) ?? null;
}

function markAppliedProjectionSnapshot(
  environmentId: EnvironmentId,
  snapshot: Pick<OrchestrationShellSnapshot, "snapshotSequence" | "updatedAt">,
): void {
  const nextVersion = toAppliedProjectionVersion(snapshot);
  const currentVersion = readLastAppliedProjectionVersion(environmentId);
  if (
    currentVersion !== null &&
    compareAppliedProjectionVersion(currentVersion, nextVersion) >= 0
  ) {
    return;
  }

  lastAppliedProjectionVersionByEnvironment.set(environmentId, nextVersion);
}

function markAppliedProjectionEvent(environmentId: EnvironmentId, sequence: number): void {
  const currentVersion = readLastAppliedProjectionVersion(environmentId);
  if (currentVersion !== null && sequence <= currentVersion.sequence) {
    return;
  }

  lastAppliedProjectionVersionByEnvironment.set(environmentId, {
    sequence,
    updatedAt: currentVersion?.updatedAt ?? null,
  });
}

function readLastAppliedThreadDetailSequence(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): number | null {
  return (
    lastAppliedThreadDetailSequenceByKey.get(
      getThreadDetailSubscriptionKey(environmentId, threadId),
    ) ?? null
  );
}

function readPendingThreadDetailSequence(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): number | null {
  return (
    pendingThreadDetailSequenceByKey.get(getThreadDetailSubscriptionKey(environmentId, threadId)) ??
    null
  );
}

function readLastAppliedOrPendingThreadDetailSequence(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): number | null {
  const applied = readLastAppliedThreadDetailSequence(environmentId, threadId);
  const pending = readPendingThreadDetailSequence(environmentId, threadId);
  if (applied === null) {
    return pending;
  }
  if (pending === null) {
    return applied;
  }
  return Math.max(applied, pending);
}

function shouldApplyThreadDetailSnapshot(input: {
  readonly current: number | null;
  readonly snapshot: Pick<OrchestrationThreadDetailSnapshot, "snapshotSequence">;
}): boolean {
  return input.current === null || input.snapshot.snapshotSequence > input.current;
}

function shouldApplyThreadDetailEvent(input: {
  readonly current: number | null;
  readonly sequence: number;
}): boolean {
  return input.current === null || input.sequence > input.current;
}

function markAppliedThreadDetailSequence(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  sequence: number,
): void {
  const key = getThreadDetailSubscriptionKey(environmentId, threadId);
  const current = lastAppliedThreadDetailSequenceByKey.get(key);
  if (current !== undefined && sequence <= current) {
    return;
  }
  lastAppliedThreadDetailSequenceByKey.set(key, sequence);
}

function scheduleThreadDetailEventFlush(): void {
  if (pendingThreadDetailFlushTimeoutId !== null) {
    return;
  }

  pendingThreadDetailFlushTimeoutId = setTimeout(() => {
    pendingThreadDetailFlushTimeoutId = null;
    flushPendingThreadDetailEvents();
  }, THREAD_DETAIL_UI_EVENT_BATCH_MS);
}

function clearPendingThreadDetailEventsForEnvironment(environmentId: EnvironmentId): void {
  pendingThreadDetailEventsByEnvironment.delete(environmentId);
  const keyPrefix = `${environmentId}:`;
  for (const key of Array.from(pendingThreadDetailSequenceByKey.keys())) {
    if (key.startsWith(keyPrefix)) {
      pendingThreadDetailSequenceByKey.delete(key);
    }
  }
}

function clearPendingThreadDetailEvents(): void {
  if (pendingThreadDetailFlushTimeoutId !== null) {
    clearTimeout(pendingThreadDetailFlushTimeoutId);
    pendingThreadDetailFlushTimeoutId = null;
  }
  pendingThreadDetailEventsByEnvironment.clear();
  pendingThreadDetailSequenceByKey.clear();
}

function enqueueThreadDetailEvent(event: OrchestrationEvent, environmentId: EnvironmentId): void {
  if (event.aggregateKind !== "thread") {
    applyRecoveredEventBatch([event], environmentId);
    return;
  }

  const threadId = ThreadId.make(event.aggregateId);
  const current = readLastAppliedOrPendingThreadDetailSequence(environmentId, threadId);
  if (!shouldApplyThreadDetailEvent({ current, sequence: event.sequence })) {
    return;
  }

  pendingThreadDetailSequenceByKey.set(
    getThreadDetailSubscriptionKey(environmentId, threadId),
    event.sequence,
  );
  const pendingEvents = pendingThreadDetailEventsByEnvironment.get(environmentId) ?? [];
  pendingEvents.push(event);
  pendingThreadDetailEventsByEnvironment.set(environmentId, pendingEvents);
  scheduleThreadDetailEventFlush();
}

function flushPendingThreadDetailEvents(): void {
  if (pendingThreadDetailEventsByEnvironment.size === 0) {
    pendingThreadDetailSequenceByKey.clear();
    return;
  }

  const batches = Array.from(pendingThreadDetailEventsByEnvironment.entries());
  pendingThreadDetailEventsByEnvironment.clear();
  pendingThreadDetailSequenceByKey.clear();

  for (const [environmentId, events] of batches) {
    const applicableEvents: OrchestrationEvent[] = [];
    for (const event of events.toSorted((left, right) => left.sequence - right.sequence)) {
      if (event.aggregateKind !== "thread") {
        applicableEvents.push(event);
        continue;
      }

      const threadId = ThreadId.make(event.aggregateId);
      const current = readLastAppliedThreadDetailSequence(environmentId, threadId);
      if (shouldApplyThreadDetailEvent({ current, sequence: event.sequence })) {
        applicableEvents.push(event);
      }
    }

    if (applicableEvents.length === 0) {
      continue;
    }

    applyRecoveredEventBatch(applicableEvents, environmentId);
    for (const event of applicableEvents) {
      if (event.aggregateKind === "thread") {
        markAppliedThreadDetailSequence(
          environmentId,
          ThreadId.make(event.aggregateId),
          event.sequence,
        );
      }
    }
  }
}

function applyThreadDetailSnapshot(
  entry: ThreadDetailSubscriptionEntry,
  snapshot: OrchestrationThreadDetailSnapshot,
): void {
  const current = readLastAppliedThreadDetailSequence(entry.environmentId, entry.threadId);
  if (!shouldApplyThreadDetailSnapshot({ current, snapshot })) {
    return;
  }

  useStore.getState().syncServerThreadDetail(snapshot.thread, entry.environmentId);
  markAppliedThreadDetailSequence(entry.environmentId, entry.threadId, snapshot.snapshotSequence);
}
function getThreadDetailSubscriptionKey(environmentId: EnvironmentId, threadId: ThreadId): string {
  return scopedThreadKey(scopeThreadRef(environmentId, threadId));
}

function clearThreadDetailSubscriptionEviction(
  entry: ThreadDetailSubscriptionEntry,
): ThreadDetailSubscriptionEntry {
  if (entry.evictionTimeoutId !== null) {
    clearTimeout(entry.evictionTimeoutId);
    entry.evictionTimeoutId = null;
  }
  return entry;
}

function isNonIdleThreadDetailSubscription(entry: ThreadDetailSubscriptionEntry): boolean {
  const threadRef = scopeThreadRef(entry.environmentId, entry.threadId);
  const state = useStore.getState();
  const sidebarThread = selectSidebarThreadSummaryByRef(state, threadRef);

  // Prefer shell/sidebar state first because it carries the coarse thread
  // readiness flags used throughout the UI (pending approvals/input/plan).
  if (sidebarThread) {
    if (
      sidebarThread.hasPendingApprovals ||
      sidebarThread.hasPendingUserInput ||
      sidebarThread.hasActionableProposedPlan
    ) {
      return true;
    }

    const orchestrationStatus = sidebarThread.session?.orchestrationStatus;
    if (
      orchestrationStatus &&
      orchestrationStatus !== "idle" &&
      orchestrationStatus !== "stopped"
    ) {
      return true;
    }

    if (sidebarThread.latestTurn?.state === "running") {
      return true;
    }
  }

  const thread = selectThreadByRef(state, threadRef);
  if (!thread) {
    return false;
  }

  const orchestrationStatus = thread.session?.orchestrationStatus;
  return (
    Boolean(
      orchestrationStatus && orchestrationStatus !== "idle" && orchestrationStatus !== "stopped",
    ) ||
    thread.latestTurn?.state === "running" ||
    thread.pendingSourceProposedPlan !== undefined
  );
}

function shouldEvictThreadDetailSubscription(entry: ThreadDetailSubscriptionEntry): boolean {
  return entry.refCount === 0 && !isNonIdleThreadDetailSubscription(entry);
}

function attachThreadDetailSubscription(entry: ThreadDetailSubscriptionEntry): boolean {
  if (entry.unsubscribeConnectionListener !== null) {
    entry.unsubscribeConnectionListener();
    entry.unsubscribeConnectionListener = null;
  }
  if (entry.unsubscribe !== NOOP) {
    return true;
  }

  const connection = readEnvironmentConnection(entry.environmentId);
  if (!connection) {
    return false;
  }

  entry.unsubscribe = connection.client.orchestration.subscribeThread(
    { threadId: entry.threadId },
    (item) => {
      if (item.kind === "snapshot") {
        applyThreadDetailSnapshot(entry, item.snapshot);
        return;
      }
      applyEnvironmentThreadDetailEvent(item.event, entry.environmentId);
    },
    {
      // Detail streams carry assistant text, tool logs, and turn terminal
      // markers. A one-off stream failure must never leave the visible thread
      // pinned to an old snapshot while the backend projection keeps moving.
      retryNonTransportErrors: true,
    },
  );
  return true;
}

function watchThreadDetailSubscriptionConnection(entry: ThreadDetailSubscriptionEntry): void {
  if (entry.unsubscribeConnectionListener !== null) {
    return;
  }

  entry.unsubscribeConnectionListener = subscribeEnvironmentConnections(() => {
    if (attachThreadDetailSubscription(entry)) {
      entry.lastAccessedAt = Date.now();
    }
  });
  attachThreadDetailSubscription(entry);
}

function disposeThreadDetailSubscriptionByKey(key: string): boolean {
  const entry = threadDetailSubscriptions.get(key);
  if (!entry) {
    return false;
  }

  clearThreadDetailSubscriptionEviction(entry);
  entry.unsubscribeConnectionListener?.();
  entry.unsubscribeConnectionListener = null;
  threadDetailSubscriptions.delete(key);
  entry.unsubscribe();
  entry.unsubscribe = NOOP;
  return true;
}

function detachThreadDetailSubscriptionsForEnvironment(environmentId: EnvironmentId): void {
  for (const entry of threadDetailSubscriptions.values()) {
    if (entry.environmentId !== environmentId) {
      continue;
    }
    entry.unsubscribe();
    entry.unsubscribe = NOOP;
    watchThreadDetailSubscriptionConnection(entry);
  }
}

function attachThreadDetailSubscriptionsForEnvironment(environmentId: EnvironmentId): void {
  for (const entry of threadDetailSubscriptions.values()) {
    if (entry.environmentId === environmentId) {
      attachThreadDetailSubscription(entry);
    }
  }
}

function reconcileThreadDetailSubscriptionsForEnvironment(
  environmentId: EnvironmentId,
  threadIds: ReadonlyArray<ThreadId>,
): void {
  const activeThreadIds = new Set(threadIds);
  for (const [key, entry] of threadDetailSubscriptions) {
    if (entry.environmentId === environmentId && !activeThreadIds.has(entry.threadId)) {
      disposeThreadDetailSubscriptionByKey(key);
    }
  }
}

function scheduleThreadDetailSubscriptionEviction(entry: ThreadDetailSubscriptionEntry): void {
  clearThreadDetailSubscriptionEviction(entry);
  if (!shouldEvictThreadDetailSubscription(entry)) {
    return;
  }

  entry.evictionTimeoutId = setTimeout(() => {
    const currentEntry = threadDetailSubscriptions.get(
      getThreadDetailSubscriptionKey(entry.environmentId, entry.threadId),
    );
    if (!currentEntry) {
      return;
    }

    currentEntry.evictionTimeoutId = null;
    if (!shouldEvictThreadDetailSubscription(currentEntry)) {
      return;
    }
    disposeThreadDetailSubscriptionByKey(
      getThreadDetailSubscriptionKey(entry.environmentId, entry.threadId),
    );
  }, THREAD_DETAIL_SUBSCRIPTION_IDLE_EVICTION_MS);
}

function evictIdleThreadDetailSubscriptionsToCapacity(): void {
  if (threadDetailSubscriptions.size <= MAX_CACHED_THREAD_DETAIL_SUBSCRIPTIONS) {
    return;
  }

  const idleEntries = [...threadDetailSubscriptions.entries()]
    .filter(([, entry]) => shouldEvictThreadDetailSubscription(entry))
    .toSorted(([, left], [, right]) => left.lastAccessedAt - right.lastAccessedAt);

  for (const [key] of idleEntries) {
    if (threadDetailSubscriptions.size <= MAX_CACHED_THREAD_DETAIL_SUBSCRIPTIONS) {
      return;
    }
    disposeThreadDetailSubscriptionByKey(key);
  }
}

function reconcileThreadDetailSubscriptionEvictionState(
  entry: ThreadDetailSubscriptionEntry,
): void {
  clearThreadDetailSubscriptionEviction(entry);
  if (!shouldEvictThreadDetailSubscription(entry)) {
    return;
  }

  scheduleThreadDetailSubscriptionEviction(entry);
}

function reconcileThreadDetailSubscriptionEvictionForThread(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): void {
  const entry = threadDetailSubscriptions.get(
    getThreadDetailSubscriptionKey(environmentId, threadId),
  );
  if (!entry) {
    return;
  }

  reconcileThreadDetailSubscriptionEvictionState(entry);
}

function reconcileThreadDetailSubscriptionEvictionForEnvironment(
  environmentId: EnvironmentId,
): void {
  for (const entry of threadDetailSubscriptions.values()) {
    if (entry.environmentId === environmentId) {
      reconcileThreadDetailSubscriptionEvictionState(entry);
    }
  }
  evictIdleThreadDetailSubscriptionsToCapacity();
}

export function retainThreadDetailSubscription(
  environmentId: EnvironmentId,
  threadId: ThreadId,
): () => void {
  const key = getThreadDetailSubscriptionKey(environmentId, threadId);
  const existing = threadDetailSubscriptions.get(key);
  if (existing) {
    clearThreadDetailSubscriptionEviction(existing);
    existing.refCount += 1;
    existing.lastAccessedAt = Date.now();
    if (!attachThreadDetailSubscription(existing)) {
      watchThreadDetailSubscriptionConnection(existing);
    }
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      existing.refCount = Math.max(0, existing.refCount - 1);
      existing.lastAccessedAt = Date.now();
      if (existing.refCount === 0) {
        reconcileThreadDetailSubscriptionEvictionState(existing);
        evictIdleThreadDetailSubscriptionsToCapacity();
      }
    };
  }

  const entry: ThreadDetailSubscriptionEntry = {
    environmentId,
    threadId,
    unsubscribe: NOOP,
    unsubscribeConnectionListener: null,
    refCount: 1,
    lastAccessedAt: Date.now(),
    evictionTimeoutId: null,
  };
  threadDetailSubscriptions.set(key, entry);
  if (!attachThreadDetailSubscription(entry)) {
    watchThreadDetailSubscriptionConnection(entry);
  }
  evictIdleThreadDetailSubscriptionsToCapacity();

  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    entry.refCount = Math.max(0, entry.refCount - 1);
    entry.lastAccessedAt = Date.now();
    if (entry.refCount === 0) {
      reconcileThreadDetailSubscriptionEvictionState(entry);
      evictIdleThreadDetailSubscriptionsToCapacity();
    }
  };
}

function emitEnvironmentConnectionRegistryChange() {
  for (const listener of environmentConnectionListeners) {
    listener();
  }
}

export function coalesceOrchestrationUiEvents(
  events: ReadonlyArray<OrchestrationEvent>,
): OrchestrationEvent[] {
  if (events.length < 2) {
    return [...events];
  }

  const coalesced: OrchestrationEvent[] = [];
  for (const event of events) {
    const previous = coalesced.at(-1);
    if (
      previous?.type === "thread.message-sent" &&
      event.type === "thread.message-sent" &&
      previous.payload.threadId === event.payload.threadId &&
      previous.payload.messageId === event.payload.messageId &&
      previous.payload.streaming &&
      event.payload.streaming
    ) {
      coalesced[coalesced.length - 1] = {
        ...event,
        payload: {
          ...event.payload,
          attachments: event.payload.attachments ?? previous.payload.attachments,
          createdAt: previous.payload.createdAt,
          text:
            !event.payload.streaming && event.payload.text.length > 0
              ? event.payload.text
              : previous.payload.text + event.payload.text,
        },
      };
      continue;
    }

    coalesced.push(event);
  }

  return coalesced;
}

function syncProjectUiFromStore() {
  const projects = selectProjectsAcrossEnvironments(useStore.getState());
  const clientSettings = getClientSettings();
  useUiStateStore.getState().syncProjects(
    projects.map((project) => ({
      key: derivePhysicalProjectKey(project),
      logicalKey: deriveLogicalProjectKeyFromSettings(project, clientSettings),
      cwd: project.cwd,
    })),
  );
}

function syncThreadUiFromStore() {
  const threads = selectThreadsAcrossEnvironments(useStore.getState());
  useUiStateStore.getState().syncThreads(
    threads.map((thread) => ({
      key: scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      seedVisitedAt: thread.updatedAt ?? thread.createdAt,
    })),
  );
  markPromotedDraftThreadsByRef(
    threads.map((thread) => scopeThreadRef(thread.environmentId, thread.id)),
  );
}

function reconcileSnapshotDerivedState() {
  syncProjectUiFromStore();
  syncThreadUiFromStore();
}

function applyRecoveredEventBatch(
  events: ReadonlyArray<OrchestrationEvent>,
  environmentId: EnvironmentId,
) {
  if (events.length === 0) {
    return;
  }

  const batchEffects = deriveOrchestrationBatchEffects(events);
  const uiEvents = coalesceOrchestrationUiEvents(events);
  const needsProjectUiSync = events.some(
    (event) =>
      event.type === "project.created" ||
      event.type === "project.meta-updated" ||
      event.type === "project.deleted",
  );

  if (batchEffects.needsProviderInvalidation) {
    needsProviderInvalidation = true;
    void activeService?.queryInvalidationThrottler.maybeExecute();
  }

  useStore.getState().applyOrchestrationEvents(uiEvents, environmentId);
  if (needsProjectUiSync) {
    const projects = selectProjectsAcrossEnvironments(useStore.getState());
    const clientSettings = getClientSettings();
    useUiStateStore.getState().syncProjects(
      projects.map((project) => ({
        key: derivePhysicalProjectKey(project),
        logicalKey: deriveLogicalProjectKeyFromSettings(project, clientSettings),
        cwd: project.cwd,
      })),
    );
  }

  const needsThreadUiSync = events.some(
    (event) =>
      event.type === "thread.created" ||
      event.type === "thread.deleted" ||
      event.type === "thread.restored",
  );
  if (needsThreadUiSync) {
    const threads = selectThreadsAcrossEnvironments(useStore.getState());
    useUiStateStore.getState().syncThreads(
      threads.map((thread) => ({
        key: scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
        seedVisitedAt: thread.updatedAt ?? thread.createdAt,
      })),
    );
  }

  const draftStore = useComposerDraftStore.getState();
  for (const threadId of batchEffects.promoteDraftThreadIds) {
    markPromotedDraftThreadByRef(scopeThreadRef(environmentId, threadId));
  }
  for (const threadId of batchEffects.clearDeletedThreadIds) {
    draftStore.clearDraftThread(scopeThreadRef(environmentId, threadId));
    useUiStateStore
      .getState()
      .clearThreadUi(scopedThreadKey(scopeThreadRef(environmentId, threadId)));
  }
  for (const event of events) {
    if (event.type === "project.deleted") {
      draftStore.clearProjectDraftThreadId(scopeProjectRef(environmentId, event.payload.projectId));
    }
  }
  reconcileThreadDetailSubscriptionEvictionForEnvironment(environmentId);
}

export function applyEnvironmentThreadDetailEvent(
  event: OrchestrationEvent,
  environmentId: EnvironmentId,
) {
  enqueueThreadDetailEvent(event, environmentId);
}

function applyShellEvent(event: OrchestrationShellStreamEvent, environmentId: EnvironmentId) {
  if (
    !shouldApplyProjectionEvent({
      current: readLastAppliedProjectionVersion(environmentId),
      sequence: event.sequence,
    })
  ) {
    return;
  }

  const threadId =
    event.kind === "thread-upserted"
      ? event.thread.id
      : event.kind === "thread-removed"
        ? event.threadId
        : null;
  const threadRef = threadId ? scopeThreadRef(environmentId, threadId) : null;
  const previousThread = threadRef ? selectThreadByRef(useStore.getState(), threadRef) : undefined;

  useStore.getState().applyShellEvent(event, environmentId);
  markAppliedProjectionEvent(environmentId, event.sequence);

  switch (event.kind) {
    case "project-upserted":
    case "project-removed":
      syncProjectUiFromStore();
      return;
    case "thread-upserted":
      syncThreadUiFromStore();
      if (!previousThread && threadRef) {
        markPromotedDraftThreadByRef(threadRef);
      }
      reconcileThreadDetailSubscriptionEvictionForThread(environmentId, event.thread.id);
      evictIdleThreadDetailSubscriptionsToCapacity();
      return;
    case "thread-removed":
      if (threadRef) {
        disposeThreadDetailSubscriptionByKey(scopedThreadKey(threadRef));
        useComposerDraftStore.getState().clearDraftThread(threadRef);
        useUiStateStore.getState().clearThreadUi(scopedThreadKey(threadRef));
      }
      syncThreadUiFromStore();
      return;
  }
}

function createEnvironmentConnectionHandlers() {
  return {
    applyShellEvent,
    syncShellSnapshot: (snapshot: OrchestrationShellSnapshot, environmentId: EnvironmentId) => {
      if (
        !shouldApplyProjectionSnapshot({
          current: readLastAppliedProjectionVersion(environmentId),
          next: snapshot,
        })
      ) {
        return;
      }

      useStore.getState().syncServerShellSnapshot(snapshot, environmentId);
      markAppliedProjectionSnapshot(environmentId, snapshot);
      reconcileThreadDetailSubscriptionsForEnvironment(
        environmentId,
        snapshot.threads.map((thread) => thread.id),
      );
      reconcileThreadDetailSubscriptionEvictionForEnvironment(environmentId);
      reconcileSnapshotDerivedState();
    },
  };
}

function createPrimaryEnvironmentClient(
  knownEnvironment: ReturnType<typeof getPrimaryKnownEnvironment>,
) {
  const wsBaseUrl = getKnownEnvironmentWsBaseUrl(knownEnvironment);
  if (!wsBaseUrl) {
    throw new Error(
      `Unable to resolve websocket URL for ${knownEnvironment?.label ?? "primary environment"}.`,
    );
  }
  const connectionLabel = knownEnvironment?.label ?? null;

  return createWsRpcClient(
    new WsTransport(wsBaseUrl, {
      getConnectionLabel: () => connectionLabel,
      getVersionMismatchHint: () =>
        resolveServerConfigVersionMismatch(getServerConfig())?.hint ?? null,
    }),
  );
}

function registerConnection(connection: EnvironmentConnection): EnvironmentConnection {
  const existing = environmentConnections.get(connection.environmentId);
  if (existing && existing !== connection) {
    throw new Error(`Environment ${connection.environmentId} already has an active connection.`);
  }
  environmentConnections.set(connection.environmentId, connection);
  attachThreadDetailSubscriptionsForEnvironment(connection.environmentId);
  emitEnvironmentConnectionRegistryChange();
  return connection;
}

async function removeConnection(environmentId: EnvironmentId): Promise<boolean> {
  const connection = environmentConnections.get(environmentId);
  if (!connection) {
    return false;
  }

  lastAppliedProjectionVersionByEnvironment.delete(environmentId);
  clearPendingThreadDetailEventsForEnvironment(environmentId);
  environmentConnections.delete(environmentId);
  emitEnvironmentConnectionRegistryChange();
  detachThreadDetailSubscriptionsForEnvironment(environmentId);
  await connection.dispose();
  return true;
}

function createPrimaryEnvironmentConnection(): EnvironmentConnection {
  const knownEnvironment = getPrimaryKnownEnvironment();
  if (!knownEnvironment?.environmentId) {
    throw new Error("Unable to resolve the primary environment.");
  }
  removeComposerDraftsForNonPrimaryEnvironment(knownEnvironment.environmentId);
  useUiStateStore.getState().removeThreadUiForNonPrimaryEnvironment(knownEnvironment.environmentId);

  const existing = environmentConnections.get(knownEnvironment.environmentId);
  if (existing) {
    return existing;
  }

  return registerConnection(
    createEnvironmentConnection({
      kind: "primary",
      knownEnvironment,
      client: createPrimaryEnvironmentClient(knownEnvironment),
      ...createEnvironmentConnectionHandlers(),
    }),
  );
}

function maybeCreatePrimaryEnvironmentConnection(): EnvironmentConnection | null {
  return getPrimaryKnownEnvironment()?.environmentId ? createPrimaryEnvironmentConnection() : null;
}

function stopActiveService() {
  activeService?.stop();
  activeService = null;
}

function reconnectEnvironmentConnectionsAfterBrowserResume(reason: string): void {
  const now = Date.now();
  if (now - lastBrowserResumeReconnectAt < BROWSER_RESUME_RECONNECT_COOLDOWN_MS) {
    return;
  }

  for (const connection of environmentConnections.values()) {
    if (connection.client.isHeartbeatFresh()) {
      continue;
    }
    lastBrowserResumeReconnectAt = now;
    void connection.reconnect().catch((error) => {
      console.warn("Environment reconnect after browser resume failed", {
        environmentId: connection.environmentId,
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}

function subscribeBrowserResumeReconnects(): () => void {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return NOOP;
  }

  const handleVisibilityChange = () => {
    if (document.visibilityState === "hidden") {
      lastBrowserHiddenAt = Date.now();
      return;
    }
    if (document.visibilityState === "visible" && lastBrowserHiddenAt !== null) {
      lastBrowserHiddenAt = null;
      reconnectEnvironmentConnectionsAfterBrowserResume("visibilitychange");
    }
  };

  const handlePageShow = (event: PageTransitionEvent) => {
    if (event.persisted || lastBrowserHiddenAt !== null) {
      lastBrowserHiddenAt = null;
      reconnectEnvironmentConnectionsAfterBrowserResume("pageshow");
    }
  };

  document.addEventListener("visibilitychange", handleVisibilityChange);
  window.addEventListener("pageshow", handlePageShow);
  return () => {
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    window.removeEventListener("pageshow", handlePageShow);
  };
}

export function subscribeEnvironmentConnections(listener: () => void): () => void {
  environmentConnectionListeners.add(listener);
  return () => {
    environmentConnectionListeners.delete(listener);
  };
}

export function listEnvironmentConnections(): ReadonlyArray<EnvironmentConnection> {
  return [...environmentConnections.values()];
}

export function readEnvironmentConnection(
  environmentId: EnvironmentId,
): EnvironmentConnection | null {
  return environmentConnections.get(environmentId) ?? null;
}

export function requireEnvironmentConnection(environmentId: EnvironmentId): EnvironmentConnection {
  const connection = readEnvironmentConnection(environmentId);
  if (!connection) {
    throw new Error(`No websocket client registered for environment ${environmentId}.`);
  }
  return connection;
}

export function getPrimaryEnvironmentConnection(): EnvironmentConnection {
  return createPrimaryEnvironmentConnection();
}

export async function ensureEnvironmentConnectionBootstrapped(
  environmentId: EnvironmentId,
): Promise<void> {
  await environmentConnections.get(environmentId)?.ensureBootstrapped();
}

export function startEnvironmentConnectionService(queryClient: QueryClient): () => void {
  if (activeService?.queryClient === queryClient) {
    activeService.refCount += 1;
    return () => {
      if (!activeService || activeService.queryClient !== queryClient) {
        return;
      }
      activeService.refCount -= 1;
      if (activeService.refCount === 0) {
        stopActiveService();
      }
    };
  }

  stopActiveService();
  needsProviderInvalidation = false;
  const queryInvalidationThrottler = new Throttler(
    () => {
      if (!needsProviderInvalidation) {
        return;
      }
      needsProviderInvalidation = false;
      void queryClient.invalidateQueries({ queryKey: providerQueryKeys.all });
      void queryClient.invalidateQueries({ queryKey: projectQueryKeys.all });
    },
    {
      wait: 100,
      leading: false,
      trailing: true,
    },
  );
  maybeCreatePrimaryEnvironmentConnection();

  const unsubscribeBrowserResumeReconnects = subscribeBrowserResumeReconnects();

  activeService = {
    queryClient,
    queryInvalidationThrottler,
    refCount: 1,
    stop: () => {
      unsubscribeBrowserResumeReconnects();
      queryInvalidationThrottler.cancel();
    },
  };

  return () => {
    if (!activeService || activeService.queryClient !== queryClient) {
      return;
    }
    activeService.refCount -= 1;
    if (activeService.refCount === 0) {
      stopActiveService();
    }
  };
}

export async function resetEnvironmentServiceForTests(): Promise<void> {
  stopActiveService();
  lastBrowserHiddenAt = null;
  lastBrowserResumeReconnectAt = Number.NEGATIVE_INFINITY;
  lastAppliedProjectionVersionByEnvironment.clear();
  lastAppliedThreadDetailSequenceByKey.clear();
  clearPendingThreadDetailEvents();
  for (const key of Array.from(threadDetailSubscriptions.keys())) {
    disposeThreadDetailSubscriptionByKey(key);
  }
  await Promise.all(
    [...environmentConnections.keys()].map((environmentId) => removeConnection(environmentId)),
  );
}
