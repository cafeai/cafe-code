import { EnvironmentId, type UsageStatsGetResult } from "@cafecode/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { deferred } from "../../../test/deferred";
import { createUsageStatsDetailResource } from "./usageStatsDetailResource";
const mock = vi.hoisted(() => ({
  read: vi.fn<() => Promise<UsageStatsGetResult>>(),
  reconnect: null as null | ((event: { reconnected: boolean }) => void),
  close: vi.fn(),
}));
vi.mock("~/environments/workspace", () => ({
  readWorkspaceEnvironmentId: () => null,
  useWorkspaceEnvironmentId: () => null,
}));
vi.mock("~/environments/runtime", () => ({
  requireEnvironmentConnection: () => ({
    client: {
      server: { getUsageStats: mock.read },
      subscribeConnectionOpened: (listener: typeof mock.reconnect) => {
        mock.reconnect = listener;
        return mock.close;
      },
    },
  }),
}));
const owned: Array<() => void> = [];
const usage = {
  days: [],
  tokenBreakdown: [],
  totals: { inputTokens: 100, outputTokens: 20 },
} as unknown as UsageStatsGetResult;
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mock.reconnect = null;
  vi.stubGlobal("window", {
    setInterval: (...args: Parameters<typeof setInterval>) => setInterval(...args),
    clearInterval: (id: ReturnType<typeof setInterval>) => clearInterval(id),
  });
  const document = new EventTarget();
  Object.assign(document, { visibilityState: "visible" });
  vi.stubGlobal("document", document);
});
afterEach(() => {
  for (const close of owned.splice(0)) close();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function fixture() {
  const resource = createUsageStatsDetailResource(EnvironmentId.make("usage-controller"));
  owned.push(resource.reset);
  return resource;
}
async function loaded(resource: ReturnType<typeof fixture>) {
  const ready = deferred<void>();
  const stop = resource.subscribe(() => {
    if (resource.getSnapshot().phase === "ready") ready.resolve();
  });
  owned.push(stop);
  await ready.promise;
}
it("single-flights readers and retires its clock and connection on reset", async () => {
  const response = deferred<UsageStatsGetResult>(),
    began = deferred<void>();
  mock.read.mockImplementation(() => {
    began.resolve();
    return response.promise;
  });
  const resource = fixture();
  const ready = loaded(resource);
  const close = resource.subscribe(() => {});
  owned.push(close);
  await began.promise;
  expect(mock.read).toHaveBeenCalledOnce();
  response.resolve(usage);
  await ready;
  expect(resource.getSnapshot().data).toBe(usage);
  expect(resource.getDiagnostics().consumerCount).toBe(2);
  resource.reset();
  expect(vi.getTimerCount()).toBe(0);
  expect(mock.close).toHaveBeenCalledOnce();
});
it("does not overlap interval reads and queues one reconnect refresh", async () => {
  mock.read.mockResolvedValue(usage);
  const resource = fixture();
  await loaded(resource);
  const held = deferred<UsageStatsGetResult>();
  mock.read.mockImplementation(() => held.promise);
  await vi.advanceTimersByTimeAsync(5000);
  expect(mock.read).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(10000);
  expect(mock.read).toHaveBeenCalledTimes(2);
  mock.reconnect?.({ reconnected: true });
  mock.reconnect?.({ reconnected: true });
  const next = deferred<void>();
  mock.read.mockImplementationOnce(() => {
    next.resolve();
    return Promise.resolve(usage);
  });
  held.resolve(usage);
  await next.promise;
  expect(mock.read).toHaveBeenCalledTimes(3);
});
it("publishes opaque failure state and recovers on a fresh observed reconnect", async () => {
  mock.read.mockRejectedValue(new Error("private error"));
  const resource = fixture(),
    failed = deferred<void>();
  const stop = resource.subscribe(() => {
    if (resource.getSnapshot().phase === "error") failed.resolve();
  });
  owned.push(stop);
  await failed.promise;
  expect(resource.getSnapshot()).toMatchObject({
    data: null,
    phase: "error",
    lastErrorCategory: "unknown",
  });
  expect(JSON.stringify(resource.getSnapshot())).not.toContain("private");
  mock.read.mockResolvedValue(usage);
  const ready = deferred<void>();
  const stopReady = resource.subscribe(() => {
    if (resource.getSnapshot().phase === "ready") ready.resolve();
  });
  owned.push(stopReady);
  mock.reconnect?.({ reconnected: true });
  await ready.promise;
  expect(resource.getSnapshot().data).toBe(usage);
});
