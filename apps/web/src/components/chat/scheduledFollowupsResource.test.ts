import {
  EnvironmentId,
  ProviderInstanceId,
  ScheduledFollowupId,
  ThreadId,
  type ScheduledFollowupListResult,
  type ScheduledFollowupRecord,
} from "@cafecode/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface FixtureConnection {
  readonly opened: Set<() => void>;
  readonly client: { readonly subscribeConnectionOpened: (listener: () => void) => () => void };
}

const mocks = vi.hoisted(() => ({
  list: vi.fn<(input: { threadId: ThreadId }) => Promise<ScheduledFollowupListResult>>(),
  ensureApi: vi.fn(),
  connections: new Map<EnvironmentId, FixtureConnection>(),
  connectionListeners: new Set<() => void>(),
}));

vi.mock("../../lib/scheduledFollowupsApi", () => ({
  ensureScheduledFollowupsApi: mocks.ensureApi,
}));
vi.mock("../../environments/runtime", () => ({
  readEnvironmentConnection: (environmentId: EnvironmentId) =>
    mocks.connections.get(environmentId) ?? null,
  subscribeEnvironmentConnections: (listener: () => void) => {
    mocks.connectionListeners.add(listener);
    return () => mocks.connectionListeners.delete(listener);
  },
}));

import {
  readScheduledFollowupsSnapshot,
  refreshScheduledFollowups,
  subscribeScheduledFollowups,
} from "./scheduledFollowupsResource";

const environmentId = EnvironmentId.make("schedule-resource-environment");
const threadId = ThreadId.make("schedule-resource-chat");
const now = "2026-10-05T09:00:00.000Z";

function record(overrides: Partial<ScheduledFollowupRecord> = {}): ScheduledFollowupRecord {
  return {
    id: ScheduledFollowupId.make("11111111-1111-4111-8111-111111111111"),
    threadId,
    revision: 1,
    state: "pending_confirmation",
    name: "Check synthetic build",
    prompt: "Report meaningful changes.",
    recurrence: { kind: "interval", anchorAt: now, everyMinutes: 5, timeZone: "Asia/Tokyo" },
    modelSelection: null,
    notificationPolicy: "changes-and-errors",
    endAt: null,
    maxRuns: null,
    allowAutoFinish: false,
    authorizedInstanceId: ProviderInstanceId.make("schedule-resource-account"),
    permissionCeiling: "approval-required",
    createdAt: now,
    updatedAt: now,
    nextRunAt: null,
    runCount: 0,
    lastRun: null,
    ...overrides,
  };
}

function response(...schedules: ScheduledFollowupRecord[]): ScheduledFollowupListResult {
  return { schedules, backendOnline: true };
}

function deferred() {
  let resolve!: (value: ScheduledFollowupListResult) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<ScheduledFollowupListResult>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function connection(): FixtureConnection {
  const opened = new Set<() => void>();
  return {
    opened,
    client: {
      subscribeConnectionOpened: (listener) => {
        opened.add(listener);
        return () => opened.delete(listener);
      },
    },
  };
}

function signalConnections() {
  for (const listener of mocks.connectionListeners) listener();
}

async function settle() {
  // Flush the completed RPC and its optional single trailing refresh, without
  // advancing the polling clock or relying on wall-clock sleeps.
  await Promise.resolve();
  await Promise.resolve();
}

class FixtureDocument extends EventTarget {
  visibilityState: DocumentVisibilityState = "visible";

  setVisibility(visibility: DocumentVisibilityState) {
    this.visibilityState = visibility;
    this.dispatchEvent(new Event("visibilitychange"));
  }
}

describe("shared scheduled follow-up reads", () => {
  let fixtureDocument: FixtureDocument;
  const cleanups: Array<() => void> = [];

  function subscribe(
    listener = vi.fn(),
    scope = { environmentId, threadId },
  ): { listener: ReturnType<typeof vi.fn>; stop: () => void } {
    const stop = subscribeScheduledFollowups(scope.environmentId, scope.threadId, listener);
    cleanups.push(stop);
    return { listener, stop };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    fixtureDocument = new FixtureDocument();
    vi.stubGlobal("document", fixtureDocument);
    vi.stubGlobal("window", {
      setInterval: globalThis.setInterval,
      clearInterval: globalThis.clearInterval,
    });
    mocks.connections.clear();
    mocks.connectionListeners.clear();
    mocks.list.mockReset().mockResolvedValue(response(record()));
    mocks.ensureApi.mockReset().mockReturnValue({ list: mocks.list });
  });

  afterEach(() => {
    for (const stop of cleanups.splice(0)) stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(mocks.connectionListeners.size).toBe(0);
    for (const current of mocks.connections.values()) expect(current.opened.size).toBe(0);
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("shares one initial read, polling timer, and snapshot across concurrent subscribers", async () => {
    const first = subscribe();
    const second = subscribe();
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    expect(mocks.connectionListeners.size).toBe(1);
    await settle();
    expect(first.listener).toHaveBeenCalledTimes(1);
    expect(second.listener).toHaveBeenCalledTimes(1);
    const snapshot = readScheduledFollowupsSnapshot(environmentId, threadId);
    expect(snapshot.schedules).toEqual([record()]);
    expect(readScheduledFollowupsSnapshot(environmentId, threadId)).toBe(snapshot);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(mocks.list).toHaveBeenCalledTimes(2);
    first.stop();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(mocks.list).toHaveBeenCalledTimes(3);
    expect(second.listener).toHaveBeenCalledTimes(3);
    expect(first.listener).toHaveBeenCalledTimes(2);
  });

  it("counts identical callbacks as independent subscriptions and makes cleanup idempotent", async () => {
    const listener = vi.fn();
    const first = subscribe(listener);
    subscribe(listener);
    await settle();
    first.stop();
    first.stop();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(mocks.list).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("coalesces many pending timer and manual refresh requests into one trailing read", async () => {
    const initial = deferred();
    mocks.list.mockReturnValueOnce(initial.promise);
    const consumer = subscribe();
    subscribe();
    await vi.advanceTimersByTimeAsync(60_000);
    for (let index = 0; index < 10; index += 1) refreshScheduledFollowups(environmentId, threadId);
    expect(mocks.list).toHaveBeenCalledTimes(1);
    initial.resolve(response(record({ name: "Unreviewed stale snapshot" })));
    await settle();
    expect(mocks.list).toHaveBeenCalledTimes(2);
    expect(consumer.listener).toHaveBeenCalledTimes(1);
    expect(readScheduledFollowupsSnapshot(environmentId, threadId).schedules).toEqual([record()]);
  });

  it("never publishes a pre-mutation response after a shared manual refresh", async () => {
    subscribe();
    const observer = subscribe();
    await settle();
    const oldRead = deferred();
    const freshRead = deferred();
    mocks.list.mockReturnValueOnce(oldRead.promise).mockReturnValueOnce(freshRead.promise);
    await vi.advanceTimersByTimeAsync(15_000);
    refreshScheduledFollowups(environmentId, threadId);
    expect(readScheduledFollowupsSnapshot(environmentId, threadId).loading).toBe(true);
    oldRead.resolve(response(record({ revision: 2, state: "active" })));
    await settle();
    expect(mocks.list).toHaveBeenCalledTimes(3);
    // Only the loading notification is new; obsolete active state never emits.
    expect(observer.listener).toHaveBeenCalledTimes(2);
    expect(readScheduledFollowupsSnapshot(environmentId, threadId).loading).toBe(true);
    expect(readScheduledFollowupsSnapshot(environmentId, threadId).schedules[0]?.revision).toBe(1);
    freshRead.resolve(response(record({ revision: 3, state: "paused" })));
    await settle();
    expect(observer.listener).toHaveBeenCalledTimes(3);
    expect(readScheduledFollowupsSnapshot(environmentId, threadId).loading).toBe(false);
    expect(readScheduledFollowupsSnapshot(environmentId, threadId).schedules[0]?.state).toBe(
      "paused",
    );
  });

  it("drops obsolete errors as well as results when refresh changes the generation", async () => {
    const oldRead = deferred();
    const freshRead = deferred();
    mocks.list.mockReturnValueOnce(oldRead.promise).mockReturnValueOnce(freshRead.promise);
    const observer = subscribe();
    refreshScheduledFollowups(environmentId, threadId);
    oldRead.reject(new Error("obsolete secret response body"));
    await settle();
    expect(observer.listener).not.toHaveBeenCalled();
    expect(readScheduledFollowupsSnapshot(environmentId, threadId)).toMatchObject({
      loading: true,
      error: null,
    });
    freshRead.resolve(response(record()));
    await settle();
    expect(readScheduledFollowupsSnapshot(environmentId, threadId).error).toBeNull();
  });

  it("refreshes on its exact transport reopening and ignores other environment changes", async () => {
    const currentConnection = connection();
    mocks.connections.set(environmentId, currentConnection);
    subscribe();
    subscribe();
    await settle();
    expect(currentConnection.opened.size).toBe(1);
    mocks.connections.set(EnvironmentId.make("other-environment"), connection());
    signalConnections();
    await settle();
    expect(mocks.list).toHaveBeenCalledTimes(1);
    for (const listener of currentConnection.opened) listener();
    await settle();
    expect(mocks.list).toHaveBeenCalledTimes(2);
  });

  it("fences an old transport response and rebinds only the replacement connection", async () => {
    const originalConnection = connection();
    const replacementConnection = connection();
    mocks.connections.set(environmentId, originalConnection);
    const oldRead = deferred();
    const freshRead = deferred();
    mocks.list.mockReturnValueOnce(oldRead.promise).mockReturnValueOnce(freshRead.promise);
    const observer = subscribe();
    mocks.connections.set(environmentId, replacementConnection);
    signalConnections();
    expect(originalConnection.opened.size).toBe(0);
    expect(replacementConnection.opened.size).toBe(1);
    expect(mocks.list).toHaveBeenCalledTimes(1);
    oldRead.resolve(response(record({ name: "Old transport data" })));
    await settle();
    expect(observer.listener).not.toHaveBeenCalled();
    expect(mocks.list).toHaveBeenCalledTimes(2);
    freshRead.resolve(response(record({ name: "Replacement transport data" })));
    await settle();
    expect(readScheduledFollowupsSnapshot(environmentId, threadId).schedules[0]?.name).toBe(
      "Replacement transport data",
    );
  });

  it("invalidates a read when its transport reopens without replacing the connection object", async () => {
    const currentConnection = connection();
    mocks.connections.set(environmentId, currentConnection);
    const oldRead = deferred();
    mocks.list.mockReturnValueOnce(oldRead.promise);
    const observer = subscribe();
    for (const listener of currentConnection.opened) listener();
    oldRead.resolve(response(record({ name: "Pre-reconnect data" })));
    await settle();
    expect(observer.listener).toHaveBeenCalledTimes(1);
    expect(readScheduledFollowupsSnapshot(environmentId, threadId).schedules).toEqual([record()]);
    expect(mocks.list).toHaveBeenCalledTimes(2);
  });

  it("tracks delayed connection arrival and ignores unrelated events while none exists", async () => {
    subscribe();
    await settle();
    signalConnections();
    expect(mocks.list).toHaveBeenCalledTimes(1);
    const currentConnection = connection();
    mocks.connections.set(environmentId, currentConnection);
    signalConnections();
    await settle();
    expect(currentConnection.opened.size).toBe(1);
    expect(mocks.list).toHaveBeenCalledTimes(2);
    mocks.connections.delete(environmentId);
    signalConnections();
    await settle();
    expect(currentConnection.opened.size).toBe(0);
    expect(mocks.list).toHaveBeenCalledTimes(3);
    signalConnections();
    expect(mocks.list).toHaveBeenCalledTimes(3);
  });

  it("stops hidden timers and catches up once when visibility returns", async () => {
    subscribe();
    subscribe();
    await settle();
    fixtureDocument.setVisibility("hidden");
    expect(vi.getTimerCount()).toBe(0);
    refreshScheduledFollowups(environmentId, threadId);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.list).toHaveBeenCalledTimes(1);
    fixtureDocument.setVisibility("visible");
    await settle();
    expect(mocks.list).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("does not read or poll when a resource first mounts in a hidden document", async () => {
    fixtureDocument.setVisibility("hidden");
    subscribe();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.list).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    fixtureDocument.setVisibility("visible");
    await settle();
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("retains known rows on refresh failure, sanitizes errors, and clears them on recovery", async () => {
    subscribe();
    await settle();
    mocks.list.mockRejectedValueOnce(new Error("private bearer credential and server body"));
    refreshScheduledFollowups(environmentId, threadId);
    await settle();
    expect(readScheduledFollowupsSnapshot(environmentId, threadId)).toEqual({
      schedules: [record()],
      loading: false,
      error: "Schedules could not be refreshed. Reconnect or try again.",
    });
    refreshScheduledFollowups(environmentId, threadId);
    await settle();
    expect(readScheduledFollowupsSnapshot(environmentId, threadId).error).toBeNull();
  });

  it("reports unavailable capability safely without leaving the reader permanently in flight", async () => {
    mocks.ensureApi.mockImplementationOnce(() => {
      throw new Error("unsupported backend internals");
    });
    subscribe();
    await settle();
    expect(readScheduledFollowupsSnapshot(environmentId, threadId)).toMatchObject({
      schedules: [],
      loading: false,
      error: "Schedules could not be refreshed. Reconnect or try again.",
    });
    refreshScheduledFollowups(environmentId, threadId);
    await settle();
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(readScheduledFollowupsSnapshot(environmentId, threadId).schedules).toEqual([record()]);
  });

  it("keeps exact environment/chat tuples distinct and rejects foreign chat rows", async () => {
    const otherEnvironment = EnvironmentId.make("other-environment");
    const otherThread = ThreadId.make("other-chat");
    const own = record();
    const foreign = record({ threadId: otherThread, name: "Other chat" });
    mocks.list.mockResolvedValueOnce(response(own, foreign));
    subscribe();
    await settle();
    expect(readScheduledFollowupsSnapshot(environmentId, threadId).schedules).toEqual([own]);
    expect(readScheduledFollowupsSnapshot(environmentId, otherThread).schedules).toEqual([]);
    expect(readScheduledFollowupsSnapshot(otherEnvironment, threadId).schedules).toEqual([]);
    mocks.list.mockResolvedValueOnce(response(foreign));
    subscribe(vi.fn(), { environmentId, threadId: otherThread });
    await settle();
    mocks.list.mockResolvedValueOnce(response(record({ name: "Other environment" })));
    subscribe(vi.fn(), { environmentId: otherEnvironment, threadId });
    await settle();
    expect(mocks.ensureApi.mock.calls.map(([id]) => id)).toEqual([
      environmentId,
      environmentId,
      otherEnvironment,
    ]);
    expect(readScheduledFollowupsSnapshot(environmentId, threadId).schedules).toEqual([own]);
    expect(readScheduledFollowupsSnapshot(environmentId, otherThread).schedules).toEqual([foreign]);
    expect(readScheduledFollowupsSnapshot(otherEnvironment, threadId).schedules[0]?.name).toBe(
      "Other environment",
    );
  });

  it("retires cached rows, timers and listeners immediately after the final unsubscribe", async () => {
    const currentConnection = connection();
    mocks.connections.set(environmentId, currentConnection);
    const observer = subscribe();
    await settle();
    observer.stop();
    expect(readScheduledFollowupsSnapshot(environmentId, threadId)).toMatchObject({
      schedules: [],
      loading: true,
      error: null,
    });
    expect(vi.getTimerCount()).toBe(0);
    expect(mocks.connectionListeners.size).toBe(0);
    expect(currentConnection.opened.size).toBe(0);
    fixtureDocument.setVisibility("hidden");
    fixtureDocument.setVisibility("visible");
    refreshScheduledFollowups(environmentId, threadId);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });

  it("ignores a retired resource's late result after the same scope is subscribed again", async () => {
    const retiredRead = deferred();
    const currentRead = deferred();
    mocks.list.mockReturnValueOnce(retiredRead.promise).mockReturnValueOnce(currentRead.promise);
    const retired = subscribe();
    retired.stop();
    const current = subscribe();
    currentRead.resolve(response(record({ name: "Current resource" })));
    await settle();
    retiredRead.resolve(response(record({ name: "Retired resource" })));
    await settle();
    expect(retired.listener).not.toHaveBeenCalled();
    expect(current.listener).toHaveBeenCalledTimes(1);
    expect(readScheduledFollowupsSnapshot(environmentId, threadId).schedules[0]?.name).toBe(
      "Current resource",
    );
  });

  it("cannot resurrect subscriptions through a captured retired connection callback", async () => {
    const observer = subscribe();
    const retiredCallback = [...mocks.connectionListeners][0]!;
    await settle();
    observer.stop();
    const replacement = connection();
    mocks.connections.set(environmentId, replacement);
    retiredCallback();
    await settle();
    expect(replacement.opened.size).toBe(0);
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("snapshot reads and refresh calls alone do not retain owners or start work", async () => {
    for (let index = 0; index < 1_000; index += 1) {
      const unusedThread = ThreadId.make(`uncommitted-chat-${index}`);
      expect(readScheduledFollowupsSnapshot(environmentId, unusedThread).schedules).toEqual([]);
      refreshScheduledFollowups(environmentId, unusedThread);
    }
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.connectionListeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
